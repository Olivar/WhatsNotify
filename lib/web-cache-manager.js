'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    const content = fs.readFileSync(file);
    return { present: true, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: crypto.createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    return { present: false, sizeBytes: null, modifiedAt: null, sha256: null, error: String(error.message || error) };
  }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o640 });
  fs.renameSync(temp, file);
}
function createWebCacheManager({ cacheDir, preferredVersion, state }) {
  const stateFile = path.join(cacheDir, 'active-version.json');
  function cacheFile(version) { return version ? path.join(cacheDir, `${version}.html`) : null; }
  function chooseBootstrap() {
    const saved = readJson(stateFile);
    const candidates = [preferredVersion, saved?.activeVersion].filter(Boolean);
    for (const version of candidates) {
      const info = fileInfo(cacheFile(version));
      if (info.present) {
        Object.assign(state.webCache, info, { requestedVersion: preferredVersion || null, activeVersion: version, bootstrapMode: 'local-strict', stateFile, path: cacheFile(version) });
        return { webVersion: version, strict: true };
      }
    }
    Object.assign(state.webCache, { requestedVersion: preferredVersion || null, activeVersion: null, bootstrapMode: 'latest-fallback-once', present: false, stateFile, path: null });
    return { webVersion: preferredVersion || undefined, strict: false };
  }
  function activate(actualVersion) {
    const info = fileInfo(cacheFile(actualVersion));
    state.webCache.activeVersion = actualVersion || null;
    state.webCache.path = cacheFile(actualVersion);
    state.webCache.bootstrapMode = info.present ? 'local-strict-next-boot' : 'latest-fallback-once';
    Object.assign(state.webCache, info);
    if (!info.present) return { activated: false, ...info };
    atomicJson(stateFile, { activeVersion: actualVersion, activatedAt: new Date().toISOString(), sha256: info.sha256 });
    return { activated: true, ...info };
  }
  function inspect() {
    if (!state.webCache.activeVersion) return state.webCache;
    Object.assign(state.webCache, fileInfo(cacheFile(state.webCache.activeVersion)));
    return state.webCache;
  }
  return { chooseBootstrap, activate, inspect, stateFile, cacheDir };
}
module.exports = { createWebCacheManager, fileInfo };
