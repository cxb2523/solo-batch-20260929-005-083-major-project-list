'use strict';

// Read a zip archive using ONLY the End Of Central Directory record and the
// Central Directory headers. File contents are never decompressed: this is a
// cheap metadata scan safe to run on large archives.

const fs = require('fs');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_NAME = 200;

// Normalize an entry name the way it appears in a catalog: forward slashes, no
// stray whitespace. Directory names keep their trailing slash.
function normalizeName(rawName) {
  return rawName.replace(/\\/g, '/').replace(/[ \t]+$/g, '');
}

function truncateName(name, maxName, warnings, preview) {
  if (name.length <= maxName) return name;
  const cut = name.slice(0, Math.max(1, maxName - 1));
  warnings.push(
    `entry name too long (${name.length} > ${maxName}) truncated: "${preview}"`
  );
  return `${cut}~`;
}

function findEocd(buf) {
  // The EOCD sits at the end with up to 65535 bytes of comment.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let offset = buf.length - 22; offset >= min; offset -= 1) {
    if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = buf.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buf.length) return offset;
    }
  }
  return -1;
}

// Returns { entries, warnings, stats }. Throws when the central directory is
// missing or structurally damaged; callers treat that as corruption and fall
// back to the README.
function readCentral(zipPath, options = {}) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxName = options.maxName ?? DEFAULT_MAX_NAME;
  const warnings = [];

  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22) {
    throw new Error(`central directory unreadable: file too small (${buf.length} bytes)`);
  }

  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw new Error('central directory damaged: end-of-central-directory record not found');
  }

  let totalEntries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdSize = buf.readUInt32LE(eocd + 12);

  // Zip64: 0xffffffff markers mean the real values live in the zip64 EOCD.
  if (
    totalEntries === 0xffff ||
    cdOffset === 0xffffffff ||
    cdSize === 0xffffffff
  ) {
    const locator = eocd - 20;
    if (
      locator >= 0 &&
      buf.readUInt32LE(locator) === 0x07064b50 &&
      locator + 20 <= eocd
    ) {
      const zip64Eocd = Number(buf.readBigUInt64LE(locator + 8));
      if (
        zip64Eocd >= 0 &&
        zip64Eocd + 56 <= buf.length &&
        buf.readUInt32LE(zip64Eocd) === ZIP64_EOCD_SIGNATURE
      ) {
        totalEntries = Number(buf.readBigUInt64LE(zip64Eocd + 32));
        cdSize = Number(buf.readBigUInt64LE(zip64Eocd + 40));
        cdOffset = Number(buf.readBigUInt64LE(zip64Eocd + 48));
      } else {
        throw new Error('central directory damaged: zip64 record not found');
      }
    } else {
      throw new Error('central directory damaged: zip64 locator not found');
    }
  }

  if (cdOffset >= buf.length || cdSize > buf.length - cdOffset) {
    throw new Error(
      `central directory damaged: offset/size out of bounds (offset=${cdOffset}, size=${cdSize}, file=${buf.length})`
    );
  }

  const entries = [];
  const seen = new Set();
  let duplicateCount = 0;
  let ignoredOverCap = 0;
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buf.length || cursor + 46 > cdEnd) {
      throw new Error(`central directory damaged: header ${index} truncated`);
    }
    if (buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`central directory damaged: bad signature at header ${index}`);
    }

    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const diskStart = buf.readUInt16LE(cursor + 34);
    const localOffset = buf.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > buf.length) {
      throw new Error(`central directory damaged: header ${index} runs past EOF`);
    }
    const rawName = buf.slice(nameStart, nameEnd).toString('utf8');
    const name = normalizeName(rawName);

    // Cheap structural check: the referenced local header must exist and have
    // the right signature. Catches offsets clobbered by corruption.
    if (
      localOffset + 30 > buf.length ||
      buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
    ) {
      throw new Error(
        `central directory damaged: local header for "${name}" unreachable`
      );
    }
    if (diskStart !== 0) {
      throw new Error(`central directory damaged: split archives are not supported`);
    }

    const isDirectory = name.endsWith('/');
    const key = name;

    if (seen.has(key)) {
      duplicateCount += 1;
      warnings.push(`duplicate entry kept first occurrence: "${name}"`);
    } else if (entries.length >= maxEntries) {
      ignoredOverCap += 1;
    } else {
      seen.add(key);
      const entryName = truncateName(
        name,
        maxName,
        warnings,
        rawName.slice(0, 40)
      );
      entries.push({
        // The catalog (and README mirror) use the possibly truncated name as
        // the stable identity across rebuilds.
        name: entryName,
        isDirectory,
        method,
        compressedSize,
        uncompressedSize,
        source: 'zip',
      });
    }

    cursor = nameEnd + extraLength + commentLength;
  }

  if (cursor !== cdEnd) {
    throw new Error(
      `central directory damaged: parsed length ${cursor} does not match declared size ${cdEnd}`
    );
  }

  if (ignoredOverCap > 0) {
    warnings.push(
      `entry limit reached (${maxEntries}); ${ignoredOverCap} further entry/entries ignored, not crashed`
    );
  }

  return {
    entries,
    warnings,
    stats: {
      scanned: totalEntries,
      kept: entries.length,
      duplicates: duplicateCount,
      ignoredOverCap,
    },
  };
}

module.exports = {
  readCentral,
  normalizeName,
  findEocd,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_NAME,
};
