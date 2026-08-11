'use strict';

const path = require('path');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const pkg = require('./package.json');
const { createSoapScheduler } = require('./soap-job');
const { createRuntimeState } = require('./lib/runtime-state');
const { createNtpMonitor } = require('./lib/ntp-monitor');
const { createWebCacheManager } = require('./lib/web-cache-manager');
const { createDashboardServer } = require('./lib/dashboard-server');
const { createUpdateStatus } = require('./lib/update-status');

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}
function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(level, event, data = {}) {
  const record = { ...data, timestamp: new Date().toISOString(), level, event };
  const line = JSON.stringify(record);
  if (level === 'ERROR') console.error(line); else console.log(line);
}

const APP_DIR = String(process.env.APP_DIR || __dirname).trim();
const DATA_DIR = String(process.env.DATA_DIR || '/var/lib/whatsnotify').trim();
const AUTH_DIR = String(process.env.WHATSAPP_AUTH_DIR || `${DATA_DIR}/sessions`).trim();
const UPDATE_STATE_FILE = String(process.env.UPDATE_STATE_FILE || `${DATA_DIR}/update-state.json`).trim();
const AUTO_UPDATE_BRANCH = String(process.env.AUTO_UPDATE_BRANCH || 'main').trim();
const AUTO_UPDATE_REMOTE = String(process.env.AUTO_UPDATE_REMOTE || 'origin').trim();
const AUTO_UPDATE_ENABLED = String(process.env.AUTO_UPDATE_ENABLED || 'true').toLowerCase() === 'true';
const DASHBOARD_ALLOW_UPDATE = String(process.env.DASHBOARD_ALLOW_UPDATE || 'false').toLowerCase() === 'true';

const SOURCE_CHAT_ID = requiredEnv('SOURCE_CHAT_ID');
const TARGET_GROUP_ID = requiredEnv('TARGET_GROUP_ID');
const WWEB_VERSION = String(process.env.WWEB_VERSION || '').trim();
const WWEB_CACHE_DIR = String(process.env.WWEB_CACHE_DIR || `${DATA_DIR}/web-cache`).trim();
const SESSION_ID = String(process.env.WHATSAPP_SESSION_ID || 'proditec-forwarder').trim();
const FORWARD_RETRIES = intEnv('FORWARD_RETRIES', 3);
const RETRY_DELAY_MS = intEnv('RETRY_DELAY_MS', 3000);
const DEDUP_TTL_MS = intEnv('DEDUP_TTL_MS', 86400000);
const READY_TIMEOUT_MS = intEnv('READY_TIMEOUT_MS', 120000);
const NTP_SERVERS = String(process.env.NTP_SERVERS || 'a.ntp.br,b.ntp.br,c.ntp.br').split(',').map((x) => x.trim()).filter(Boolean);
const NTP_INTERVAL_MS = intEnv('NTP_INTERVAL_MS', 1800000);
const NTP_TIMEOUT_MS = intEnv('NTP_TIMEOUT_MS', 3000);
const NTP_DEGRADED_OFFSET_MS = intEnv('NTP_DEGRADED_OFFSET_MS', 1000);
const DASHBOARD_ENABLED = String(process.env.DASHBOARD_ENABLED || 'true').toLowerCase() === 'true';
const DASHBOARD_BIND = String(process.env.DASHBOARD_BIND || '127.0.0.1');
const DASHBOARD_PORT = intEnv('DASHBOARD_PORT', 8080);

if (SOURCE_CHAT_ID === TARGET_GROUP_ID) throw new Error('SOURCE_CHAT_ID e TARGET_GROUP_ID não podem ser iguais');

const chromePath = puppeteer.executablePath();
const runtime = createRuntimeState({ version: pkg.version, sourceChatId: SOURCE_CHAT_ID, targetGroupId: TARGET_GROUP_ID, sessionId: SESSION_ID, webVersion: WWEB_VERSION, webCachePath: WWEB_CACHE_DIR });
const webCacheManager = createWebCacheManager({ cacheDir: WWEB_CACHE_DIR, preferredVersion: WWEB_VERSION, state: runtime.state });
const webCacheBootstrap = webCacheManager.chooseBootstrap();

log('INFO', 'BOOT', { nodeVersion: process.version, chromePath, sourceChatId: SOURCE_CHAT_ID, targetGroupId: TARGET_GROUP_ID, requestedWebVersion: WWEB_VERSION || null, selectedWebVersion: webCacheBootstrap.webVersion || null, webCacheMode: runtime.state.webCache.bootstrapMode });

const client = new Client({
  ...(webCacheBootstrap.webVersion ? { webVersion: webCacheBootstrap.webVersion } : {}),
  webVersionCache: { type: 'local', path: WWEB_CACHE_DIR, strict: webCacheBootstrap.strict },
  authStrategy: new LocalAuth({ clientId: SESSION_ID, dataPath: AUTH_DIR }),
  puppeteer: {
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking','--disable-default-apps','--disable-extensions','--disable-sync','--metrics-recording-only','--no-first-run'],
  },
});

const processedMessages = new Map();
let forwardQueue = Promise.resolve();
let shuttingDown = false;
let soapScheduler = null;
let readyWatchdog = null;

const ntpMonitor = createNtpMonitor({ state: runtime.state, log, servers: NTP_SERVERS, intervalMs: NTP_INTERVAL_MS, timeoutMs: NTP_TIMEOUT_MS, degradedOffsetMs: NTP_DEGRADED_OFFSET_MS });
ntpMonitor.start();

const updateStatus = createUpdateStatus({ appDir: APP_DIR, stateFile: UPDATE_STATE_FILE, branch: AUTO_UPDATE_BRANCH, remote: AUTO_UPDATE_REMOTE, enabled: AUTO_UPDATE_ENABLED });
const dashboard = createDashboardServer({ runtime, log, host: DASHBOARD_BIND, port: DASHBOARD_PORT, user: process.env.DASHBOARD_USER, password: process.env.DASHBOARD_PASSWORD, publicDir: path.join(__dirname, 'public'), updateStatus, allowUpdate: DASHBOARD_ALLOW_UPDATE });
if (DASHBOARD_ENABLED) dashboard.start();

function getMessageId(message) {
  const native = message.id?._serialized || message.id?.id || message.rawData?.id?.id || message.rawData?.id?._serialized;
  if (native) return `native:${native}`;
  return ['fallback', message.from || '', message.to || '', message.type || '', message.timestamp || '', message.body || ''].join('|');
}
function isDuplicate(id) {
  if (!id) return false;
  const at = processedMessages.get(id);
  if (!at || Date.now() - at > DEDUP_TTL_MS) { processedMessages.set(id, Date.now()); return false; }
  return true;
}
const cleanupTimer = setInterval(() => {
  const limit = Date.now() - DEDUP_TTL_MS;
  for (const [id, at] of processedMessages.entries()) if (at < limit) processedMessages.delete(id);
}, 3600000);
cleanupTimer.unref();

async function forwardMessage(message, messageId) {
  runtime.automationStart('forwarder');
  const content = String(message.body || '').trim();
  if (!content) {
    runtime.automationSuccess('forwarder');
    log('WARN', 'MESSAGE_SKIPPED', { messageId, type: message.type || '-', reason: 'Mensagem sem conteúdo textual' });
    return;
  }
  let lastError;
  for (let attempt = 1; attempt <= FORWARD_RETRIES; attempt += 1) {
    try {
      log('INFO', 'FORWARD_ATTEMPT', { messageId, attempt, destination: TARGET_GROUP_ID });
      const sent = await client.sendMessage(TARGET_GROUP_ID, content, { linkPreview: false });
      runtime.markSenderUsed();
      runtime.automationSuccess('forwarder');
      log('INFO', 'MESSAGE_FORWARDED', { sourceMessageId: messageId, destination: TARGET_GROUP_ID, forwardedMessageId: sent?.id?._serialized || '-', attempt });
      return;
    } catch (error) {
      lastError = error;
      log('ERROR', 'FORWARD_ATTEMPT_FAILED', { messageId, attempt, error: String(error.message || error) });
      if (attempt < FORWARD_RETRIES) await delay(RETRY_DELAY_MS * attempt);
    }
  }
  runtime.automationFailure('forwarder', lastError);
  throw lastError;
}

client.on('qr', (qr) => { runtime.setWhatsapp('awaiting_qr', { qrRequestedAt: new Date().toISOString() }); log('WARN', 'QR_REQUIRED'); qrcode.generate(qr, { small: true }); });
client.on('loading_screen', (percent, message) => log('INFO', 'LOADING', { percent, message }));
client.on('authenticated', () => { runtime.setWhatsapp('authenticated'); log('INFO', 'AUTHENTICATED'); });
client.on('auth_failure', (error) => { runtime.setWhatsapp('error', { lastError: String(error) }); log('ERROR', 'AUTH_FAILURE', { error: String(error) }); });
client.on('ready', async () => {
  if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
  runtime.setWhatsapp('connected', { lastConnection: new Date().toISOString(), lastError: null });
  try {
    const actualWebVersion = await client.getWWebVersion();
    const cacheResult = webCacheManager.activate(actualWebVersion);
    log(cacheResult.activated ? 'INFO' : 'WARN', 'WWEB_CACHE_ACTIVATED', { actualWebVersion, cached: cacheResult.activated, sizeBytes: cacheResult.sizeBytes || null, error: cacheResult.error || null });
  } catch (error) { log('WARN', 'WWEB_CACHE_ACTIVATION_FAILED', { error: String(error.message || error) }); }
  log('INFO', 'READY', { sourceChatId: SOURCE_CHAT_ID, targetGroupId: TARGET_GROUP_ID, webVersion: runtime.state.webCache.activeVersion });
  if (!soapScheduler) soapScheduler = createSoapScheduler({ client, targetGroupId: TARGET_GROUP_ID, log, runtime });
});
client.on('message_create', (message) => {
  const fromMe = Boolean(message.fromMe || message.id?.fromMe);
  if (!fromMe || message.to !== SOURCE_CHAT_ID) return;
  const messageId = getMessageId(message);
  if (isDuplicate(messageId)) return log('WARN', 'DUPLICATE_SKIPPED', { messageId });
  log('INFO', 'MESSAGE_MATCHED', { messageId, from: message.from || '-', to: message.to || '-', type: message.type || '-', messageTimestamp: message.timestamp || '-' });
  forwardQueue = forwardQueue.then(() => forwardMessage(message, messageId)).catch((error) => log('ERROR', 'FORWARD_FAILED', { messageId, error: String(error.message || error) }));
});
client.on('disconnected', (reason) => { runtime.setWhatsapp('disconnected', { lastDisconnect: new Date().toISOString(), lastError: String(reason) }); log('ERROR', 'DISCONNECTED', { reason: String(reason) }); });

process.on('unhandledRejection', (error) => { runtime.state.service.lastError = String(error?.message || error); log('ERROR', 'UNHANDLED_REJECTION', { error: runtime.state.service.lastError }); });
process.on('uncaughtException', (error) => { runtime.state.service.lastError = String(error?.message || error); log('ERROR', 'UNCAUGHT_EXCEPTION', { error: runtime.state.service.lastError }); process.exit(1); });

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', 'SHUTDOWN_STARTED', { signal });
  clearInterval(cleanupTimer);
  ntpMonitor.stop();
  if (readyWatchdog) clearTimeout(readyWatchdog);
  try {
    await Promise.race([forwardQueue, delay(15000)]);
    soapScheduler?.destroy();
    await dashboard.stop();
    await client.destroy();
    log('INFO', 'SHUTDOWN_COMPLETED');
  } catch (error) { log('ERROR', 'SHUTDOWN_ERROR', { error: String(error.message || error) }); }
  finally { process.exit(0); }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

readyWatchdog = setTimeout(() => {
  runtime.setWhatsapp('error', { lastError: `READY timeout ${READY_TIMEOUT_MS}ms` });
  log('ERROR', 'READY_TIMEOUT', { timeoutMs: READY_TIMEOUT_MS, action: 'Processo será reiniciado pelo systemd' });
  process.exit(1);
}, READY_TIMEOUT_MS);
readyWatchdog.unref();

client.initialize().catch((error) => {
  runtime.setWhatsapp('error', { lastError: String(error.message || error) });
  log('ERROR', 'INITIALIZE_ERROR', { error: String(error.message || error) });
  process.exit(1);
});
