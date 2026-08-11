'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function git(args, cwd) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function createUpdateStatus({ appDir, stateFile, branch = 'main', remote = 'origin', enabled = true }) {
  return function snapshot() {
    const persisted = readJson(stateFile);
    const installed = git(['rev-parse', 'HEAD'], appDir);
    const latest = persisted.latestCommit || git(['rev-parse', `${remote}/${branch}`], appDir);
    return {
      repository: 'Olivar/WhatsNotify',
      branch,
      installedCommit: installed,
      latestCommit: latest || null,
      updateAvailable: Boolean(installed && latest && installed !== latest),
      autoUpdateEnabled: Boolean(enabled),
      lastCheck: persisted.lastCheck || null,
      lastUpdate: persisted.lastUpdate || null,
      lastStatus: persisted.lastStatus || 'unknown',
      lastError: persisted.lastError || null,
      previousCommit: persisted.previousCommit || null,
      rollbackCommit: persisted.rollbackCommit || null,
    };
  };
}

module.exports = { createUpdateStatus };
