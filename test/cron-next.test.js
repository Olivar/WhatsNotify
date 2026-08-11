'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextDailyRun } = require('../lib/cron-next');

test('calcula próxima execução diária 07:00 São Paulo', () => {
  const next = nextDailyRun('0 7 * * *', 'America/Sao_Paulo', new Date('2026-08-11T12:00:00Z'));
  assert.equal(next, '2026-08-12T10:00:00.000Z');
});

test('cron não suportado retorna null sem derrubar status', () => {
  assert.equal(nextDailyRun('*/5 * * * *', 'America/Sao_Paulo'), null);
});
