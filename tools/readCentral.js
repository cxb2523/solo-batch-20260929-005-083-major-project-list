'use strict';

const fs = require('fs');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MAX_SCAN = 65557;
const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_NAME_LENGTH = 120;

class CentralDirectoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CentralDirectoryError';
  }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - EOCD_MAX_SCAN);
  for (let p = buf.length - 22; p >= min; p--) {
    if (p < 0) break;
    if (buf.readUInt32LE(p) === EOCD_SIGNATURE) {
      const commentLength = buf.readUInt16LE(p + 20);
      if (p + 22 + commentLength === buf.length) return p;
    }
  }
  return -1;
}

function sanitizeName(raw) {
  let name = raw.replace(/\\/g, '/');
  name = name.replace(/\/+/g, '/').replace(/^\/+/, '');
  name = name.split('/').filter((seg) => seg !== '.' && seg !== '..').join('/');
  name = name.replace(/\/+$/, '');
  return name;
}

function stripCommonRoot(names) {
  if (names.length === 0) return names;
  const parts = names.map((n) => n.split('/'));
  const minDepth = Math.min.apply(null, parts.map((p) => p.length));
  let rootDepth = 0;
  for (; rootDepth < minDepth - 1; rootDepth++) {
    const seg = parts[0][rootDepth];
    if (!parts.every((p) => p[rootDepth] === seg)) break;
  }
  if (rootDepth === 0) return names.slice();
  return names.map((n) => n.split('/').slice(rootDepth).join('/'));
}

function truncateName(name, maxNameLength, warnings) {
  if (name.length <= maxNameLength) return name;
  const suffix = '...';
  const cut = Math.max(1, maxNameLength - suffix.length);
  const truncated = name.slice(0, cut) + suffix;
  warnings.push({
    code: 'name_truncated',
    message: 'entry name exceeded ' + maxNameLength + ' characters and was truncated: ' + name,
    entry: name,
  });
  return truncated;
}

function parseCentralDirectory(buffer, options) {
  const opts = options || {};
  const maxEntries = typeof opts.maxEntries === 'number' ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  const maxNameLength = typeof opts.maxNameLength === 'number' ? opts.maxNameLength : DEFAULT_MAX_NAME_LENGTH;
  const warnings = [];

  if (buffer.length < 22) {
    throw new CentralDirectoryError('file too small to contain a zip central directory');
  }
  const eocd = findEocd(buffer);
  if (eocd < 0) {
    throw new CentralDirectoryError('end of central directory record not found (not a zip archive)');
  }

  const diskEntries = buffer.readUInt16LE(eocd + 10);
  const totalEntries = buffer.readUInt16LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (diskEntries !== totalEntries) {
    throw new CentralDirectoryError('multi-disk archives are not supported (central directory spans disks)');
  }
  if (totalEntries === 0) {
    return { entries: [], warnings, totalCentralEntries: 0, limitHit: false };
  }
  if (cdOffset + 46 > buffer.length) {
    throw new CentralDirectoryError('central directory offset points outside the file');
  }
  if (buffer.readUInt32LE(cdOffset) !== CENTRAL_SIGNATURE) {
    throw new CentralDirectoryError('central directory signature missing at declared offset');
  }

  const records = [];
  let p = cdOffset;
  let limitHit = false;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buffer.length) {
      throw new CentralDirectoryError('central directory truncated before entry ' + i);
    }
    if (buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new CentralDirectoryError('bad central file header signature at entry ' + i);
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localHeaderOffset = buffer.readUInt32LE(p + 42);
    if (p + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw new CentralDirectoryError('central directory entry ' + i + ' exceeds file bounds');
    }
    const rawName = buffer.slice(p + 46, p + 46 + nameLength).toString((flags & 0x800) ? 'utf8' : 'latin1');
    p += 46 + nameLength + extraLength + commentLength;

    if (records.length >= maxEntries) {
      limitHit = true;
      continue;
    }
    if (method > 99 || compressedSize > buffer.length || localHeaderOffset >= eocd) {
      throw new CentralDirectoryError('implausible metadata in central directory entry ' + i);
    }

    const isDirectory = /\/$/.test(rawName);
    const clean = sanitizeName(rawName);
    if (clean === '') {
      warnings.push({ code: 'empty_entry_name', message: 'skipped entry with an empty name at index ' + i });
      continue;
    }
    records.push({ name: clean, isDirectory, size: uncompressedSize });
  }

  if (!limitHit && p !== eocd) {
    throw new CentralDirectoryError('central directory length mismatch (records end at ' + p + ', eocd at ' + eocd + ')');
  }
  if (limitHit) {
    warnings.push({
      code: 'entry_limit_exceeded',
      message: 'central directory holds more than ' + maxEntries + ' entries; scan stopped at the configured limit',
    });
  }

  const files = records.filter((r) => !r.isDirectory);
  const strippedNames = stripCommonRoot(files.map((r) => r.name));
  const entries = [];
  const seen = new Set();
  files.forEach((record, idx) => {
    const name = truncateName(strippedNames[idx], maxNameLength, warnings);
    if (seen.has(name)) {
      warnings.push({
        code: 'duplicate_entry',
        message: 'duplicate central-directory entry ignored (first occurrence kept): ' + name,
        entry: name,
      });
      return;
    }
    seen.add(name);
    entries.push({ name, size: record.size });
  });

  return { entries, warnings, totalCentralEntries: totalEntries, limitHit };
}

function readCentral(zipPath, options) {
  let buffer;
  try {
    buffer = fs.readFileSync(zipPath);
  } catch (err) {
    throw new CentralDirectoryError('cannot read zip archive: ' + err.message);
  }
  return parseCentralDirectory(buffer, options);
}

module.exports = {
  readCentral,
  parseCentralDirectory,
  CentralDirectoryError,
  sanitizeName,
  stripCommonRoot,
  truncateName,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_NAME_LENGTH,
};