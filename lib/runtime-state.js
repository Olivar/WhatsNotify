'use strict';

const os = require('os');

function isoNow() {
  return new Date().toISOString();
}

function maskId(value) {
  if (!value) return null;
  const s = String(value);
  const at = s.lastIndexOf('@');
  const domain = at >= 0 ? s.slice(at) : '';
  const head = at >= 0 ? s.slice(0, at) : s;
  if (head.length <= 6) return `${head.slice(0, 2)}***${domain}`;
  return `${head.slice(0, 4)}…${head.slice(-3)}${domain}`;
}

function createCounterState(overrides = {}) {
  return {
    executions: 0,
    failures: 0,
    lastExecution: null,
    lastFailure: null,
    lastError: null,
    ...overrides,
  };
}

function createRuntimeState({ version, sourceChatId, targetGroupId, sessionId, webVersion, webCachePath }) {
  const bootAt = isoNow();

  const state = {
    bootAt,
    service: {
      version,
      hostname: os.hostname(),
      lastError: null,
    },
    webCache: {
      requestedVersion: webVersion || null,
      activeVersion: null,
      path: webCachePath || null,
      stateFile: null,
      bootstrapMode: 'unknown',
      present: false,
      sizeBytes: null,
      modifiedAt: null,
      sha256: null,
      lastRefreshAttempt: null,
      lastRefreshSuccess: null,
      lastRefreshError: null,
    },
    time: {
      timezone: process.env.TZ || 'America/Sao_Paulo',
      status: 'unknown',
      server: null,
      lastAttempt: null,
      lastSuccess: null,
      offsetMs: null,
      roundTripMs: null,
      lastError: null,
      systemSyncMode: 'host-managed',
    },
    whatsapp: {
      configured: Boolean(sourceChatId && targetGroupId),
      status: 'starting',
      sessionId: sessionId || null,
      lastConnection: null,
      lastDisconnect: null,
      lastError: null,
      qrRequestedAt: null,
    },
    senders: {
      whatsapp: {
        id: 'whatsapp-primary',
        name: 'WhatsApp',
        type: 'whatsapp-web.js',
        active: true,
        status: 'starting',
        connectionState: 'starting',
        lastUsedAt: null,
        lastHeartbeat: null,
        target: maskId(targetGroupId),
      },
    },
    automations: {
      forwarder: {
        id: 'forward-self-alerts',
        name: 'Encaminhamento de alertas',
        active: true,
        type: 'event',
        status: 'idle',
        schedule: null,
        nextExecution: null,
        ...createCounterState(),
      },
      soapDaily: {
        id: 'senha-master-diaria',
        name: 'Senha Master TDES diária',
        active: true,
        type: 'cron',
        status: 'idle',
        schedule: null,
        timezone: null,
        nextExecution: null,
        ...createCounterState(),
      },
    },
  };

  function setWhatsapp(status, fields = {}) {
    state.whatsapp.status = status;
    Object.assign(state.whatsapp, fields);
    state.senders.whatsapp.status = status === 'connected' ? 'online' : status;
    state.senders.whatsapp.connectionState = status;
    state.senders.whatsapp.lastHeartbeat = isoNow();
  }

  function markSenderUsed() {
    state.senders.whatsapp.lastUsedAt = isoNow();
  }

  function automationStart(key) {
    const item = state.automations[key];
    if (!item) return;
    item.status = 'running';
    item.lastExecution = isoNow();
    item.executions += 1;
  }

  function automationSuccess(key) {
    const item = state.automations[key];
    if (!item) return;
    item.status = 'ok';
    item.lastError = null;
  }

  function automationFailure(key, error) {
    const item = state.automations[key];
    if (!item) return;
    item.status = 'error';
    item.failures += 1;
    item.lastFailure = isoNow();
    item.lastError = error ? String(error.message || error) : 'unknown error';
  }

  function getServiceStatus() {
    if (state.whatsapp.status !== 'connected') return 'degraded';
    if (state.time.status === 'error' || state.time.status === 'degraded') return 'degraded';
    if (!state.webCache.present) return 'degraded';
    if (Object.values(state.automations).some((a) => a.active && a.status === 'error')) return 'degraded';
    return 'online';
  }

  function snapshot({ nextDailyRun } = {}) {
    if (typeof nextDailyRun === 'function') {
      const a = state.automations.soapDaily;
      if (a.active && a.schedule && a.timezone) {
        a.nextExecution = nextDailyRun(a.schedule, a.timezone);
      }
    }

    const current = new Date();
    return {
      service: {
        status: getServiceStatus(),
        uptime: Math.floor((Date.now() - Date.parse(state.bootAt)) / 1000),
        version: state.service.version,
        bootAt: state.bootAt,
        hostname: state.service.hostname,
        lastError: state.service.lastError,
      },
      webVersionCache: { ...state.webCache, path: undefined, stateFile: undefined },
      time: {
        current: current.toISOString(),
        timezone: state.time.timezone,
        ntpStatus: state.time.status,
        server: state.time.server,
        lastAttempt: state.time.lastAttempt,
        lastSync: state.time.lastSuccess,
        offsetMs: state.time.offsetMs,
        roundTripMs: state.time.roundTripMs,
        lastError: state.time.lastError,
        systemSyncMode: state.time.systemSyncMode,
      },
      whatsapp: {
        configured: state.whatsapp.configured,
        status: state.whatsapp.status,
        sessionId: state.whatsapp.sessionId,
        lastConnection: state.whatsapp.lastConnection,
        lastDisconnect: state.whatsapp.lastDisconnect,
        lastError: state.whatsapp.lastError,
        qrRequestedAt: state.whatsapp.qrRequestedAt,
      },
      senders: Object.values(state.senders).map((s) => ({ ...s })),
      automations: Object.values(state.automations).map((a) => ({ ...a })),
    };
  }

  return {
    state,
    setWhatsapp,
    markSenderUsed,
    automationStart,
    automationSuccess,
    automationFailure,
    snapshot,
  };
}

module.exports = { createRuntimeState, maskId, isoNow };
