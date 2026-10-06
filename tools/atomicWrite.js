'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP_PREFIX = '.projects.';
const TEMP_SUFFIX = '.tmp';
const RENAME_RETRIES = 5;
const RENAME_DELAY_MS = 25;

const trackedTempFiles = new Set();
let handlersInstalled = false;

function randomSuffix() {
  return crypto.randomBytes(8).toString('hex');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempPathFor(targetPath) {
  const dir = path.dirname(path.resolve(targetPath));
  const base = path.basename(targetPath);
  return path.join(dir, TEMP_PREFIX + base + '.' + process.pid + '.' + randomSuffix() + TEMP_SUFFIX);
}

function track(tempPath) {
  trackedTempFiles.add(tempPath);
}

function untrack(tempPath) {
  trackedTempFiles.delete(tempPath);
}

function cleanupTracked() {
  for (const tempPath of trackedTempFiles) {
    try {
      fs.unlinkSync(tempPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.appendFileSync(path.join(os.tmpdir(), 'catalogd-atomic-write.log'), 'cleanup failed for ' + tempPath + ': ' + err.message + '\n'); } catch (e) { void e; }
      }
    }
    trackedTempFiles.delete(tempPath);
  }
}

function sweepStale(targetPath) {
  const dir = path.dirname(path.resolve(targetPath));
  const base = path.basename(targetPath);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return;
  }
  const stalePrefix = TEMP_PREFIX + base + '.';
  for (const name of names) {
    if (!name.startsWith(stalePrefix) || !name.endsWith(TEMP_SUFFIX)) continue;
    const stalePath = path.join(dir, name);
    try {
      fs.unlinkSync(stalePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.appendFileSync(path.join(os.tmpdir(), 'catalogd-atomic-write.log'), 'stale sweep failed for ' + stalePath + ': ' + err.message + '\n'); } catch (e) { void e; }
      }
    }
  }
}

function installCrashHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const onSignal = (signal) => {
    cleanupTracked();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('exit', cleanupTracked);
}

async function renameOver(tempPath, targetPath) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= RENAME_RETRIES) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code === 'ENOENT' && attempt === 0) {
        throw err;
      }
      if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') {
        throw err;
      }
      attempt += 1;
      await wait(RENAME_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

async function atomicWrite(targetPath, data, options) {
  const opts = options || {};
  if (opts.installCrashHandlers !== false) installCrashHandlers();
  const target = path.resolve(targetPath);
  const targetDir = path.dirname(target);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const tempPath = tempPathFor(target);
  track(tempPath);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', opts.mode || 0o644);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let written = 0;
    while (written < buffer.length) {
      const chunk = buffer.slice(written);
      const n = fs.writeSync(fd, chunk, 0, chunk.length, written);
      if (!n) throw new Error('zero-length write while creating ' + target);
      written += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    await renameOver(tempPath, target);
    untrack(tempPath);
    return { targetPath: target, tempPath };
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeErr) { void closeErr; }
    }
    try { fs.unlinkSync(tempPath); } catch (unlinkErr) { if (unlinkErr.code !== 'ENOENT') void unlinkErr; }
    untrack(tempPath);
    throw err;
  }
}

module.exports = {
  atomicWrite,
  sweepStale,
  cleanupTracked,
  installCrashHandlers,
  tempPathFor,
  TEMP_PREFIX,
  TEMP_SUFFIX,
};