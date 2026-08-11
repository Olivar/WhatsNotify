'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dir = process.env.WWEB_CACHE_DIR || '/var/lib/whatsnotify/web-cache';
const stateFile = path.join(dir, 'active-version.json');
let state;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { console.error(`Sem estado ativo: ${e.message}`); process.exit(1); }
const file = path.join(dir, `${state.activeVersion}.html`);
const content = fs.readFileSync(file);
console.log(JSON.stringify({ activeVersion: state.activeVersion, activatedAt: state.activatedAt, file, bytes:content.length, sha256:crypto.createHash('sha256').update(content).digest('hex') }, null, 2));
