'use strict';

const dgram = require('dgram');
const dns = require('dns').promises;

const NTP_EPOCH_MS = Date.UTC(1900, 0, 1);

function ntpTimestampToUnixMs(seconds, fraction) {
  return NTP_EPOCH_MS + (seconds * 1000) + Math.round((fraction / 0x100000000) * 1000);
}

function writeNtpTimestamp(buffer, offset, unixMs) {
  const ntpMs = unixMs - NTP_EPOCH_MS;
  const seconds = Math.floor(ntpMs / 1000);
  const fractionMs = ntpMs - (seconds * 1000);
  const fraction = Math.floor((fractionMs / 1000) * 0x100000000);
  buffer.writeUInt32BE(seconds >>> 0, offset);
  buffer.writeUInt32BE(fraction >>> 0, offset + 4);
}

function readNtpTimestamp(buffer, offset) {
  const seconds = buffer.readUInt32BE(offset);
  const fraction = buffer.readUInt32BE(offset + 4);
  return ntpTimestampToUnixMs(seconds, fraction);
}

function parseNtpResponse(buffer, t1, t4) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 48) throw new Error('Resposta NTP inválida ou incompleta');
  const mode = buffer[0] & 0x7;
  const stratum = buffer[1];
  if (mode !== 4 && mode !== 5) throw new Error(`Modo NTP inesperado: ${mode}`);
  if (stratum === 0) throw new Error('Servidor NTP retornou Kiss-o-Death/stratum 0');
  const t2 = readNtpTimestamp(buffer, 32);
  const t3 = readNtpTimestamp(buffer, 40);
  const offsetMs = ((t2 - t1) + (t3 - t4)) / 2;
  const roundTripMs = (t4 - t1) - (t3 - t2);
  return { offsetMs, roundTripMs, stratum, serverTimeMs: t3 };
}

async function queryNtp(server, timeoutMs = 3000) {
  const resolved = await dns.lookup(server, { family: 4 });
  const socket = dgram.createSocket('udp4');
  const packet = Buffer.alloc(48);
  packet[0] = 0x23;
  const t1 = Date.now();
  writeNtpTimestamp(packet, 40, t1);
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timeout NTP ${server}`)), timeoutMs);
    socket.once('error', (err) => finish(reject, err));
    socket.once('message', (msg) => {
      const t4 = Date.now();
      try { finish(resolve, { server, address: resolved.address, ...parseNtpResponse(msg, t1, t4) }); }
      catch (error) { finish(reject, error); }
    });
    socket.send(packet, 123, resolved.address, (err) => { if (err) finish(reject, err); });
  });
}

function createNtpMonitor({ state, log, servers, intervalMs, timeoutMs, degradedOffsetMs, queryFn = queryNtp }) {
  const ntpServers = servers.length ? servers : ['a.ntp.br', 'b.ntp.br', 'c.ntp.br'];
  let timer = null;
  let running = false;
  async function check() {
    if (running) return;
    running = true;
    state.time.lastAttempt = new Date().toISOString();
    log('INFO', 'NTP_SYNC_ATTEMPT', { servers: ntpServers });
    let lastError = null;
    try {
      for (const server of ntpServers) {
        try {
          const result = await queryFn(server, timeoutMs);
          state.time.server = server;
          state.time.lastSuccess = new Date().toISOString();
          state.time.offsetMs = Math.round(result.offsetMs * 1000) / 1000;
          state.time.roundTripMs = Math.round(result.roundTripMs * 1000) / 1000;
          state.time.lastError = null;
          state.time.status = Math.abs(result.offsetMs) > degradedOffsetMs ? 'degraded' : 'synced';
          log('INFO', 'NTP_SYNC_OK', { server, offsetMs: state.time.offsetMs, roundTripMs: state.time.roundTripMs, stratum: result.stratum, status: state.time.status });
          return result;
        } catch (error) {
          lastError = error;
          log('WARN', 'NTP_SERVER_FAILED', { server, error: String(error.message || error) });
        }
      }
      state.time.status = 'error';
      state.time.lastError = String(lastError?.message || lastError || 'Todos os servidores NTP falharam');
      log('ERROR', 'NTP_SYNC_FAILED', { error: state.time.lastError });
      return null;
    } finally { running = false; }
  }
  function start() { void check(); timer = setInterval(() => void check(), intervalMs); timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, check };
}

module.exports = { queryNtp, parseNtpResponse, createNtpMonitor, writeNtpTimestamp };
