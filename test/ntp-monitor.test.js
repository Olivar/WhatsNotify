'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeState } = require('../lib/runtime-state');
const { createNtpMonitor } = require('../lib/ntp-monitor');
const noop = () => {};
test('NTP disponível registra sucesso e offset', async () => {
  const r = createRuntimeState({version:'1'});
  const monitor = createNtpMonitor({state:r.state,log:noop,servers:['a.ntp.br'],intervalMs:999999,timeoutMs:10,degradedOffsetMs:1000,queryFn:async()=>({offsetMs:12.4,roundTripMs:20,stratum:2})});
  await monitor.check(); assert.equal(r.state.time.status,'synced'); assert.equal(r.state.time.offsetMs,12.4); assert.ok(r.state.time.lastSuccess);
});
test('NTP indisponível degrada sem lançar para o chamador', async () => {
  const r = createRuntimeState({version:'1'});
  const monitor = createNtpMonitor({state:r.state,log:noop,servers:['a.ntp.br','b.ntp.br'],intervalMs:999999,timeoutMs:10,degradedOffsetMs:1000,queryFn:async()=>{throw new Error('offline')}});
  const result=await monitor.check(); assert.equal(result,null); assert.equal(r.state.time.status,'error'); assert.match(r.state.time.lastError,/offline/);
});
test('offset alto marca NTP degradado', async () => {
  const r=createRuntimeState({version:'1'}); const monitor=createNtpMonitor({state:r.state,log:noop,servers:['a.ntp.br'],intervalMs:999999,timeoutMs:10,degradedOffsetMs:1000,queryFn:async()=>({offsetMs:1500,roundTripMs:20,stratum:2})}); await monitor.check(); assert.equal(r.state.time.status,'degraded');
});
