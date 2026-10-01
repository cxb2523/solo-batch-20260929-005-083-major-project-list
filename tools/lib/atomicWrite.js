'use strict';

// Atomic file writes: write to a unique temp file in the same directory,
// flush it to disk, then rename over the target. A reader therefore only ever
// observes the previous complete file or the new complete file, never a
// half-written one - even if the process is killed mid-write.

const fs = require('fs');
const path = require('path');

// Temp files currently live on disk. Registered as soon as the file is opened
// and cleared after a successful rename, so shutdown can distinguish a stale
// temp (from a previous crashed run) from an active one.
const activeTemps = new Set();

function tempNameFor(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const suffix = `.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  return path.join(dir, `.${base}${suffix}`);
}

// Best-effort cleanup of temp files left behind by an earlier interrupted run.
// Only files matching the target's temp pattern are touched; an active temp
// belonging to this process is never removed.
function cleanupStale(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const prefix = `.${base}.`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const full = path.join(dir, name);
    if (activeTemps.has(full)) continue;
    try {
      fs.unlinkSync(full);
    } catch {}
  }
}

// Remove temp files still registered for this process. Called on Ctrl-C so a
// restarted process never has to recover a half-written temp file.
function cleanupActive() {
  for (const temp of [...activeTemps]) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    activeTemps.delete(temp);
  }
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// rename() is atomic on the same filesystem. On Windows replacing an existing
// file occasionally returns EPERM/EACCES/EBUSY because indexing or antivirus
// briefly opens the new file, so retry a few times.
function renameOverSync(temp, target, maxRetries) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, target);
      return;
    } catch (err) {
      const transient =
        err &&
        (err.code === 'EPERM' ||
          err.code === 'EACCES' ||
          err.code === 'EBUSY');
      if (!transient || attempt >= maxRetries) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
}

function atomicWriteSync(target, data, options = {}) {
  const resolved = path.resolve(target);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  cleanupStale(resolved);

  const temp = tempNameFor(resolved);
  activeTemps.add(temp);
  let fd;
  try {
    fd = fs.openSync(temp, 'w', 0o644);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    renameOverSync(temp, resolved, options.maxRetries ?? 5);
    activeTemps.delete(temp);
    return { temp, renamed: true };
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(temp);
    } catch {}
    activeTemps.delete(temp);
    throw err;
  }
}

module.exports = {
  atomicWriteSync,
  cleanupStale,
  cleanupActive,
  tempNameFor,
};
