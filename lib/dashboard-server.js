'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { nextDailyRun } = require('./cron-next');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function isAuthorized(req, user, password) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch (_) { return false; }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password);
}

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }));
  res.end(body);
}

function createDashboardServer({
  runtime, log, host, port, user, password, publicDir,
  updateStatus = () => null, allowUpdate = false,
}) {
  let server = null;

  function triggerUpdate(callback) {
    execFile('/usr/bin/sudo', ['/usr/bin/systemctl', 'start', 'whatsnotify-update-manual.service'],
      { timeout: 10000 }, callback);
  }

  function start() {
    if (!user || !password) {
      log('ERROR', 'DASHBOARD_DISABLED', { reason: 'DASHBOARD_USER/PASSWORD ausentes' });
      return null;
    }

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'));
    server = http.createServer((req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/api/health') {
          const snapshot = runtime.snapshot({ nextDailyRun });
          const healthy = snapshot.whatsapp.status === 'connected';
          sendJson(res, healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded',
            service: 'whatsnotify',
            version: snapshot.service.version,
            whatsapp: snapshot.whatsapp.status,
          });
          return;
        }

        if (!isAuthorized(req, user, password)) {
          res.writeHead(401, securityHeaders({
            'WWW-Authenticate': 'Basic realm="WhatsNotify Admin", charset="UTF-8"',
          }));
          res.end('Authentication required');
          return;
        }

        if (req.method === 'GET' && req.url === '/api/status') {
          const payload = runtime.snapshot({ nextDailyRun });
          payload.update = updateStatus();
          if (payload.update) payload.update.allowManualUpdate = allowUpdate;
          sendJson(res, 200, payload);
          return;
        }

        if (req.method === 'POST' && req.url === '/api/update') {
          if (!allowUpdate) {
            sendJson(res, 403, { error: 'update_disabled' });
            return;
          }
          if (req.headers['x-requested-with'] !== 'WhatsNotifyDashboard') {
            sendJson(res, 403, { error: 'invalid_request_origin' });
            return;
          }
          triggerUpdate((error) => {
            if (error) {
              log('ERROR', 'DASHBOARD_UPDATE_TRIGGER_FAILED', { error: String(error.message || error) });
              if (!res.headersSent) sendJson(res, 503, { error: 'update_trigger_failed' });
              return;
            }
            if (!res.headersSent) sendJson(res, 202, { status: 'started' });
          });
          return;
        }

        if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
          res.writeHead(200, securityHeaders({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': indexHtml.length,
            'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          }));
          res.end(indexHtml);
          return;
        }

        sendJson(res, 404, { error: 'not_found' });
      } catch (error) {
        log('ERROR', 'DASHBOARD_REQUEST_ERROR', { error: String(error.message || error) });
        sendJson(res, 503, { error: 'status_unavailable' });
      }
    });

    server.on('clientError', (error, socket) => {
      log('WARN', 'DASHBOARD_CLIENT_ERROR', { error: String(error.message || error) });
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.listen(port, host, () => log('INFO', 'DASHBOARD_READY', { host, port, allowUpdate }));
    server.on('error', (error) => log('ERROR', 'DASHBOARD_ERROR', { error: String(error.message || error) }));
    return server;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }

  return { start, stop };
}

module.exports = { createDashboardServer, isAuthorized };
