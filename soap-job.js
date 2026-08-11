'use strict';

const axios = require('axios');
const cron = require('node-cron');

function requiredEnv(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`Variável obrigatória ausente: ${name}`); return value; }
function intEnv(name, fallback) { const v = Number.parseInt(process.env[name] || '', 10); return Number.isInteger(v) && v > 0 ? v : fallback; }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function decodeXmlEntities(value) {
  return String(value).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function cleanXmlValue(value) { return decodeXmlEntities(String(value).replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1').replace(/<[^>]+>/g, '').trim()); }
function extractSoapTag(xml, tagName) { const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${tagName}>`, 'i'); const match = String(xml).match(re); return match ? cleanXmlValue(match[1]) : null; }
function extractSoapResult(xml) {
  const fault = extractSoapTag(xml, 'faultstring') || extractSoapTag(xml, 'Reason');
  if (fault) throw new Error(`SOAP Fault: ${fault}`);
  const result = extractSoapTag(xml, 'return') || extractSoapTag(xml, 'SenhaMasterTDESResult');
  if (!result) throw new Error('Retorno SOAP não localizado');
  return result;
}
function createSoapScheduler({ client, targetGroupId, log, runtime }) {
  const endpoint = requiredEnv('SOAP_ENDPOINT');
  const cronExpression = String(process.env.SOAP_CRON || '0 7 * * *').trim();
  const timezone = String(process.env.SOAP_TIMEZONE || 'America/Sao_Paulo').trim();
  const timeoutMs = intEnv('SOAP_TIMEOUT_MS', 10000);
  const retries = intEnv('SOAP_RETRIES', 3);
  const retryDelayMs = intEnv('SOAP_RETRY_DELAY_MS', 3000);
  const enabled = String(process.env.SOAP_ENABLED || 'true').toLowerCase() === 'true';
  const runOnStart = String(process.env.SOAP_RUN_ON_START || 'false').toLowerCase() === 'true';
  let running = false;
  const automation = runtime.state.automations.soapDaily;
  automation.active = enabled; automation.schedule = cronExpression; automation.timezone = timezone; automation.status = enabled ? 'idle' : 'inactive';
  const soapRequest = `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:tns="urn:ServerSGPSIntf-IServerSGPS">\n  <soap:Body><tns:SenhaMasterTDES /></soap:Body>\n</soap:Envelope>`;
  async function obtain() {
    const response = await axios.post(endpoint, soapRequest, { headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:ServerSGPSIntf-IServerSGPS#SenhaMasterTDES' }, timeout: timeoutMs, responseType: 'text', transformResponse: [(data) => data], validateStatus: (status) => status >= 200 && status < 300 });
    return extractSoapResult(response.data);
  }
  async function execute(trigger = 'manual') {
    if (!enabled) return;
    if (running) { log('WARN', 'SOAP_JOB_SKIPPED', { trigger, reason: 'Execução anterior ativa' }); return; }
    running = true; runtime.automationStart('soapDaily'); let lastError;
    try {
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          log('INFO', 'SOAP_REQUEST_ATTEMPT', { trigger, attempt, endpoint });
          const senhaMaster = await obtain();
          const generatedAt = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date());
          const message = ['*Senha Master TDES*', '', senhaMaster, '', `_Gerada em ${generatedAt}_`].join('\n');
          const sent = await client.sendMessage(targetGroupId, message, { linkPreview: false, waitUntilMsgSent: true });
          runtime.markSenderUsed(); runtime.automationSuccess('soapDaily');
          log('INFO', 'SOAP_MESSAGE_SENT', { trigger, attempt, destination: targetGroupId, sentMessageId: sent?.id?._serialized || '-' });
          return;
        } catch (error) { lastError = error; log('ERROR', 'SOAP_JOB_ATTEMPT_FAILED', { trigger, attempt, error: String(error.message || error) }); if (attempt < retries) await delay(retryDelayMs * attempt); }
      }
      throw lastError;
    } catch (error) { runtime.automationFailure('soapDaily', error); log('ERROR', 'SOAP_JOB_FAILED', { trigger, error: String(error.message || error) }); }
    finally { running = false; }
  }
  let task = null;
  if (enabled) {
    task = cron.schedule(cronExpression, () => void execute('cron'), { name: 'senha-master-diaria', timezone, noOverlap: true });
    log('INFO', 'SOAP_SCHEDULE_REGISTERED', { cronExpression, timezone, endpoint, targetGroupId });
    if (runOnStart) { const t = setTimeout(() => void execute('startup-test'), 5000); t.unref(); }
  }
  return { execute, stop: () => task?.stop(), destroy: () => task?.destroy() };
}
module.exports = { createSoapScheduler, extractSoapResult };
