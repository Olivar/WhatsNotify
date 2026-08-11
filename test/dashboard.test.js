'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorized } = require('../lib/dashboard-server');
function req(value) { return { headers:{ authorization:value } }; }
test('usuário sem permissão é rejeitado', () => {
  assert.equal(isAuthorized(req(''), 'admin', 'secret'), false);
  assert.equal(isAuthorized(req('Basic '+Buffer.from('admin:wrong').toString('base64')), 'admin', 'secret'), false);
});
test('usuário válido é aceito', () => {
  assert.equal(isAuthorized(req('Basic '+Buffer.from('admin:secret').toString('base64')), 'admin', 'secret'), true);
});
