'use strict';

// Acceptance suite for catalogd. Builds fixture zips/READMEs in a temp
// directory, starts the real HTTP server, fires two rebuilds and checks:
// idempotence, single-flight coalescing, atomic writes, and the degraded
// README-fallback path when the central directory is damaged.
// Run with: node tools/catalogd.js --selftest

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const http = require('http');

const {
  reconcile,
  BEGIN,
  END,
} = require('./lib/mergeReadme');
const {
  atomicWriteSync,
  cleanupStale,
  tempNameFor,
} = require('./lib/atomicWrite');
const { readCentral } = require('./lib/readCentral');

const DAEMON = path.join(__dirname, 'catalogd.js');

// ---------------------------------------------------------------------------
// Minimal zip writer (stored or deflated, single disk, no zip64)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const content = Buffer.from(file.content ?? '', 'utf8');
    const method = file.store ? 0 : 8;
    const data = file.store ? content : zlib.deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push({ header: central, name: nameBuf });

    offset += local.length + nameBuf.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(
    centrals.flatMap((entry) => [entry.header, entry.name])
  );
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

// Flip bytes inside the first central directory header so the EOCD still points
// at a central directory whose signature is garbage.
function damageCentralDirectory(zipBuffer) {
  const eocdOffset = zipBuffer.length - 22;
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const damaged = Buffer.from(zipBuffer);
  damaged.writeUInt32LE(0xdeadbeef, cdOffset);
  return damaged;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function check(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function checkIncludes(haystack, needle, label) {
  check(
    String(haystack).includes(needle),
    `${label || 'output'} should include ${JSON.stringify(needle)}`
  );
}

function zipResult(names) {
  return {
    entries: names.map((name) => ({
      name,
      rawName: name,
      isDirectory: name.endsWith('/'),
    })),
    warnings: [],
    stats: { scanned: names.length, kept: names.length, duplicates: 0 },
  };
}

module.exports = {
  runSelftest,
  makeZip,
  damageCentralDirectory,
  makeTempDir,
};

// ---------------------------------------------------------------------------
// Unit-level checks for the three modules
// ---------------------------------------------------------------------------

function testReconcile() {
  // Missing markers: block appended once; second call is a no-op (idempotent).
  const readme = '# Hand edited header\r\n\r\nKeep me outside markers.\r\n';
  const first = reconcile(readme, zipResult(['a.txt', 'b.txt']));
  check(first.readmeChanged, 'first reconcile appends the catalog block');
  checkIncludes(first.readmeText, BEGIN);
  checkIncludes(first.readmeText, END);
  checkIncludes(first.readmeText, '- [a.txt]');
  checkIncludes(first.readmeText, '# Hand edited header');
  checkIncludes(first.readmeText, 'Keep me outside markers.');
  const beginAt = first.readmeText.indexOf(BEGIN);
  check(
    first.readmeText.slice(0, beginAt) === readme,
    'every byte before the markers is preserved unchanged'
  );

  const second = reconcile(first.readmeText, zipResult(['a.txt', 'b.txt']));
  check(
    !second.readmeChanged && second.readmeText === first.readmeText,
    'second reconcile is byte-identical (idempotent)'
  );

  // Duplicate entries: first wins with a warning.
  const dup = reconcile(
    '',
    zipResult(['x.txt', 'x.txt', 'y.txt'])
  );
  check(
    dup.entries.join(',') === 'x.txt,y.txt',
    'duplicate entry keeps first occurrence'
  );
  check(
    dup.warnings.some((w) => w.includes('duplicate')),
    'duplicate entry records a warning'
  );

  // Cross-check: README-only and zip-only names are conflicts.
  const conflict = reconcile(
    `${BEGIN}\n- [a.txt]\n- [old.txt]\n${END}\n`,
    zipResult(['a.txt', 'new.txt'])
  );
  check(conflict.conflicts.length === 2, 'two cross-check conflicts detected');
  check(conflict.onlyInZip.includes('new.txt'), 'new.txt only in zip');
  check(conflict.onlyInReadme.includes('old.txt'), 'old.txt only in readme');
  check(
    conflict.entries.join(',') === 'a.txt,new.txt,old.txt',
    'merge keeps zip order then README-only names'
  );

  // Long names are truncated with a warning instead of crashing.
  const longName = 'z'.repeat(250);
  const truncated = reconcile('', zipResult([longName]), {
    maxEntries: 10000,
    maxName: 200,
  });
  check(
    truncated.entries[0].length === 200 && truncated.entries[0].endsWith('~'),
    'over-long entry name is truncated'
  );
  check(
    truncated.warnings.some((w) => w.includes('too long')),
    'truncation records a warning'
  );

  // Entry cap: over-limit entries are skipped with a warning.
  const capped = reconcile(
    '',
    zipResult(['1', '2', '3', '4']),
    { maxEntries: 2, maxName: 200 }
  );
  check(capped.entries.join(',') === '1,2', 'entry cap limits the catalog');
  check(
    capped.warnings.some((w) => w.includes('entry limit')),
    'over-cap scan records a warning, no crash'
  );

  // Damaged central directory: README becomes the source of truth.
  const degraded = reconcile(
    `${BEGIN}\r\n- [snapshot.txt]\r\n${END}\r\n`,
    null
  );
  check(degraded.degraded, 'degraded flag set');
  check(
    degraded.entries.join(',') === 'snapshot.txt',
    'degraded build uses README entries'
  );
  check(
    degraded.warnings.some((w) => w.includes('degraded')),
    'degradation records a warning'
  );

  // A lone marker is malformed and must surface an error, not be duplicated.
  let threw = false;
  try {
    reconcile(`${BEGIN}\n- [x]\n`, zipResult(['x']));
  } catch {
    threw = true;
  }
  check(threw, 'unbalanced markers are rejected');
}

function testReadCentral() {
  const dir = makeTempDir('catalogd-cd');
  const zipPath = path.join(dir, 'a.zip');
  fs.writeFileSync(
    zipPath,
    makeZip([
      { name: 'root/', content: '' },
      { name: 'root/a.txt', content: 'hello' },
      { name: 'root/a.txt', content: 'again' },
      { name: 'root/b.txt', content: 'world', store: true },
    ])
  );
  const result = readCentral(zipPath);
  check(result.entries.length === 3, 'duplicate central entry counted once');
  check(result.stats.duplicates === 1, 'duplicate stat recorded');
  check(
    result.warnings.some((w) => w.includes('duplicate')),
    'central duplicate warns'
  );
  check(
    result.entries[0].isDirectory && !result.entries[1].isDirectory,
    'directory flag parsed'
  );

  fs.writeFileSync(zipPath, damageCentralDirectory(fs.readFileSync(zipPath)));
  let threw = false;
  try {
    readCentral(zipPath);
  } catch {
    threw = true;
  }
  check(threw, 'damaged central directory throws so caller can degrade');
}

function testAtomicWrite() {
  const dir = makeTempDir('catalogd-aw');
  const target = path.join(dir, 'projects.json');
  atomicWriteSync(target, 'first\n');
  check(fs.readFileSync(target, 'utf8') === 'first\n', 'atomic write content');

  // A stale temp from a crashed earlier run is swept before the next write.
  const stale = tempNameFor(target);
  fs.writeFileSync(stale, 'half');
  atomicWriteSync(target, 'second\n');
  check(fs.readFileSync(target, 'utf8') === 'second\n', 'atomic replace works');
  check(!fs.existsSync(stale), 'stale temp removed');

  const temps = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.tmp'));
  check(temps.length === 0, 'no temp files survive a successful write');

  // A failed write removes its own temp and leaves the previous artifact.
  const blocker = path.join(dir, 'afile');
  fs.writeFileSync(blocker, 'x');
  let threw = false;
  try {
    atomicWriteSync(path.join(blocker, 'x.json'), 'data');
  } catch {
    threw = true;
  }
  check(threw, 'write into an invalid path throws');
  check(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length === 0,
    'failed write leaves no temp behind'
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: body
          ? { 'content-length': Buffer.byteLength(body) }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            text,
            json: () => JSON.parse(text),
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer(fixture, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [DAEMON, '--port', '0', '--zip', fixture.zipPath,
        '--readme', fixture.readmePath, '--output', fixture.outputPath],
      {
        env: { ...process.env, ...env },
        cwd: path.resolve(__dirname, '..'),
      }
    );
    let settled = false;
    const onLine = (chunk) => {
      const line = chunk.toString();
      process.stdout.write(`  [server] ${line}`);
      const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('exit', (code, signal) => {
      if (!settled) reject(new Error(`server exited early code=${code} signal=${signal}`));
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill('SIGKILL');
    }, 3000);
    timer.unref();
    server.child.on('exit', () => resolve());
    server.child.kill('SIGTERM');
  });
}

function makeFixture(prefix, zipBuffer, readmeText = '') {
  const dir = makeTempDir(prefix);
  const fixture = {
    dir,
    zipPath: path.join(dir, 'Projects-master.zip'),
    readmePath: path.join(dir, 'README.md'),
    outputPath: path.join(dir, 'projects.json'),
  };
  fs.writeFileSync(fixture.zipPath, zipBuffer);
  fs.writeFileSync(fixture.readmePath, readmeText);
  return fixture;
}

// ---------------------------------------------------------------------------
// End-to-end server scenarios
// ---------------------------------------------------------------------------

async function testServerHappyPath() {
  const names = [
    'demo/',
    'demo/a.txt',
    'demo/b.txt',
    'demo/nested/c.txt',
  ];
  const fixture = makeFixture(
    'catalogd-e2e',
    makeZip(names.map((name) => ({ name, content: name }))),
    '# My projects\r\n\r\nOutside content stays.\r\n'
  );

  const server = await startServer(fixture, { CATALOG_BUILD_DELAY_MS: '150' });
  try {
    // Wait for the startup build to settle.
    let status;
    for (let i = 0; i < 30; i += 1) {
      status = (await request(server.port, 'GET', '/status')).json();
      if (!status.running && status.generation > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(status.generation === 1, 'startup build ran once');
    check(status.entryCount === 4, `4 entries on status page, got ${status.entryCount}`);
    check(status.conflictCount === 0, 'no conflicts after first append');

    // Status page opens and shows the required numbers.
    const page = await request(server.port, 'GET', '/');
    check(page.statusCode === 200, 'status page returns 200');
    checkIncludes(page.text, '<!doctype html>', 'status page is HTML');
    checkIncludes(page.text, 'Entries', 'status page shows entries');
    checkIncludes(page.text, 'Conflicts', 'status page shows conflicts');
    checkIncludes(page.text, 'Last duration', 'status page shows last duration');
    checkIncludes(page.text, '>4<', 'status page shows entry count value');

    // Two rebuilds fired together must merge into one single build.
    const [first, second] = await Promise.all([
      request(server.port, 'POST', '/rebuild'),
      request(server.port, 'POST', '/rebuild'),
    ]);
    const bodyFirst = first.json();
    const bodySecond = second.json();
    const coalesced = [bodyFirst, bodySecond].filter((b) => b.coalesced);
    check(coalesced.length === 1, 'exactly one of two concurrent rebuilds is coalesced');
    checkIncludes(
      coalesced[0].message,
      'merged into that single build',
      'coalesced response explains the merge'
    );

    status = (await request(server.port, 'GET', '/status')).json();
    check(status.generation === 2, `generation advanced once (got ${status.generation})`);

    // Idempotence: rebuild again, bytes of projects.json must not change and
    // README must not gain a second marker block.
    const projectsBytes1 = fs.readFileSync(fixture.outputPath);
    const readmeBytes1 = fs.readFileSync(fixture.readmePath);
    const rebuild2 = (await request(server.port, 'POST', '/rebuild')).json();
    check(rebuild2.ok, 'third rebuild succeeds');
    const projectsBytes2 = fs.readFileSync(fixture.outputPath);
    const readmeBytes2 = fs.readFileSync(fixture.readmePath);
    check(projectsBytes1.equals(projectsBytes2), 'projects.json byte-identical across rebuilds');
    check(readmeBytes1.equals(readmeBytes2), 'README byte-identical across rebuilds');

    const readmeText = readmeBytes2.toString('utf8');
    check(
      readmeText.split(BEGIN).length - 1 === 1,
      'exactly one BEGIN marker after repeated rebuilds'
    );
    check(
      readmeText.split(END).length - 1 === 1,
      'exactly one END marker after repeated rebuilds'
    );
    checkIncludes(readmeText, 'Outside content stays.', 'content outside markers preserved');

    const catalog = readJson(fixture.outputPath);
    check(catalog.entryCount === 4, 'projects.json entry count');
    check(Array.isArray(catalog.entries), 'projects.json has an entries array');

    // No half files are ever present.
    const temps = fs
      .readdirSync(fixture.dir)
      .filter((name) => name.includes('.tmp'));
    check(temps.length === 0, 'no temp/half files left after rebuilds');

    // /diff cross-check shape.
    const diff = (await request(server.port, 'GET', '/diff')).json();
    check(diff.ok && diff.conflictCount === 0, 'diff reports no drift');

    // Simulate an interrupted run leaving a stale temp: next rebuild cleans it.
    const stale = path.join(
      fixture.dir,
      `.projects.json.${process.pid}.stale.tmp`
    );
    fs.writeFileSync(stale, 'half-written');
    await request(server.port, 'POST', '/rebuild');
    check(!fs.existsSync(stale), 'stale temp cleaned on rebuild (restart safety)');
  } finally {
    await stopServer(server);
  }
}

async function testDegradedPath() {
  const goodZip = makeZip([
    { name: 'p/', content: '' },
    { name: 'p/a.txt', content: 'a' },
    { name: 'p/b.txt', content: 'b' },
  ]);
  const fixture = makeFixture(
    'catalogd-deg',
    goodZip,
    '# readme\r\n'
  );

  // First server run with a healthy zip creates the README snapshot.
  let server = await startServer(fixture);
  try {
    let status;
    for (let i = 0; i < 30; i += 1) {
      status = (await request(server.port, 'GET', '/status')).json();
      if (!status.running && status.generation > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(status.entryCount === 3, 'healthy build has 3 entries');
  } finally {
    await stopServer(server);
  }

  // Corrupt the central directory, then restart: README snapshot must win.
  fs.writeFileSync(fixture.zipPath, damageCentralDirectory(fs.readFileSync(fixture.zipPath)));
  server = await startServer(fixture);
  try {
    let status;
    for (let i = 0; i < 30; i += 1) {
      status = (await request(server.port, 'GET', '/status')).json();
      if (!status.running && status.generation > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(status.degraded === true, 'status flags degraded mode');
    check(status.entryCount === 3, 'degraded build keeps README snapshot entries');
    check(
      status.warnings.some((w) => w.includes('degraded')),
      'degraded mode warns on status'
    );
    const catalog = readJson(fixture.outputPath);
    check(catalog.degraded === true, 'projects.json records degraded mode');

    const diff = (await request(server.port, 'GET', '/diff')).json();
    check(diff.degraded === true, 'diff reports degraded mode');
  } finally {
    await stopServer(server);
  }

  // Degraded mode also works when README never had markers and zip is dead:
  // build must not crash; catalog is empty.
  const emptyFixture = makeFixture(
    'catalogd-deg2',
    damageCentralDirectory(
      makeZip([{ name: 'x.txt', content: 'x' }])
    ),
    ''
  );
  const { code } = await runOnce(emptyFixture, []);
  check(code === 0, 'degraded build with no markers exits 0');
  const catalog = readJson(emptyFixture.outputPath);
  check(catalog.entryCount === 0, 'degraded build with no markers yields empty catalog');
  check(catalog.degraded === true, 'empty degraded catalog flagged');
  fs.rmSync(emptyFixture.dir, { recursive: true, force: true });
}

function runOnce(fixture, extraArgs = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        DAEMON,
        '--once',
        '--zip', fixture.zipPath,
        '--readme', fixture.readmePath,
        '--output', fixture.outputPath,
        ...extraArgs,
      ],
      { env: { ...process.env, ...env } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function testOnceLimitsAndStrict() {
  // Duplicate entries plus over-long names produce warnings.
  const longName = `L${'n'.repeat(230)}.txt`;
  const fixture = makeFixture(
    'catalogd-strict',
    makeZip([
      { name: 'a.txt', content: 'a' },
      { name: 'a.txt', content: 'dup' },
      { name: longName, content: 'long' },
    ]),
    ''
  );

  const plain = await runOnce(fixture, []);
  check(plain.code === 0, 'without --strict warnings still exit 0');
  const catalog = readJson(fixture.outputPath);
  check(catalog.warningCount >= 2, 'duplicate and truncation warnings stored');

  // Idempotent second run still exits 0 and bytes don't move.
  const before = fs.readFileSync(fixture.outputPath);
  const again = await runOnce(fixture, []);
  check(again.code === 0, 'repeat --once exits 0');
  check(
    before.equals(fs.readFileSync(fixture.outputPath)),
    'repeat --once is byte-idempotent'
  );

  const strict = await runOnce(fixture, ['--strict']);
  check(strict.code !== 0, '--strict exits non-zero when warnings exist');
  checkIncludes(strict.stderr || strict.stdout, 'warning', 'strict run lists warnings');

  // Entry cap enforced with a warning, not a crash.
  const capFixture = makeFixture(
    'catalogd-cap',
    makeZip(
      Array.from({ length: 6 }, (_, i) => ({
        name: `f${i}.txt`,
        content: String(i),
      }))
    ),
    ''
  );
  const capped = await runOnce(capFixture, ['--max-entries', '3']);
  check(capped.code === 0, 'over-cap scan does not crash');
  const cappedCatalog = readJson(capFixture.outputPath);
  check(cappedCatalog.entryCount === 3, 'cap limits entries to 3');
  check(
    cappedCatalog.warnings.some((w) => w.includes('entry limit')),
    'cap records a warning'
  );
  const cappedStrict = await runOnce(capFixture, ['--max-entries', '3', '--strict']);
  check(cappedStrict.code !== 0, '--strict non-zero with cap warning');
}

// ---------------------------------------------------------------------------
// Ctrl-C interrupt atomicity
// ---------------------------------------------------------------------------

const CRASH_HELPER = `
const fs = require('fs');
const { atomicWriteSync } = require(${JSON.stringify(
  path.join(__dirname, 'lib', 'atomicWrite.js')
)});
const target = process.argv[2];
fs.writeFileSync(target, 'old-complete-content');
// Create the temp, partially write it, then die like a Ctrl-C kill before the
// rename. The completed target must remain intact and the temp must remain for
// the restart to sweep.
const { tempNameFor } = require(${JSON.stringify(
  path.join(__dirname, 'lib', 'atomicWrite.js')
)});
const temp = tempNameFor(target);
const fd = fs.openSync(temp, 'w');
fs.writeSync(fd, 'half');
fs.fsyncSync(fd);
process.kill(process.pid, 'SIGKILL');
setTimeout(() => {}, 10000);
`;

async function testInterruptAtomicity() {
  const dir = makeTempDir('catalogd-kill');
  const target = path.join(dir, 'projects.json');
  const helper = path.join(dir, 'crash-helper.js');
  fs.writeFileSync(helper, CRASH_HELPER);

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, target]);
    child.on('exit', () => resolve());
  });

  // Simulating Ctrl-C/kill mid-write: target is still the old complete file.
  check(
    fs.readFileSync(target, 'utf8') === 'old-complete-content',
    'interrupted write never replaces the completed artifact'
  );

  // A half-written temp exists. Restart (next write) sweeps it and completes.
  const tempsBefore = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.tmp'));
  check(tempsBefore.length === 1, 'interrupted run left exactly one temp');

  const fixture = makeFixture(
    'catalogd-restart',
    makeZip([{ name: 'r/', content: '' }, { name: 'r/a.txt', content: 'a' }]),
    ''
  );
  // Copy the half temp into a fresh fixture under projects.json's temp pattern.
  const staleTemp = path.join(
    fixture.dir,
    `.projects.json.${process.pid}.${Date.now()}.stale.tmp`
  );
  fs.writeFileSync(staleTemp, 'half');
  const restarted = await runOnce(fixture, []);
  check(restarted.code === 0, 'restart after interrupt rebuilds ok');
  check(!fs.existsSync(staleTemp), 'restart removes the half-written temp');
  const catalog = readJson(fixture.outputPath);
  check(catalog.entryCount === 2, 'restarted catalog is complete');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runSelftest() {
  const tests = [
    ['reconcile: markers, duplicates, conflicts, truncation, cap, degrade', testReconcile],
    ['readCentral: zip64-free parse, duplicates, corruption detection', testReadCentral],
    ['atomicWrite: temp+rename, stale sweep, failed write cleanup', testAtomicWrite],
    ['server: two rebuilds coalesce, idempotent bytes, status page, diff', testServerHappyPath],
    ['degraded: corrupt central directory falls back to README', testDegradedPath],
    ['--once/--strict: warnings govern exit code, cap enforced', testOnceLimitsAndStrict],
    ['Ctrl-C: interrupted write leaves no half file after restart', testInterruptAtomicity],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write(`selftest: ${name}\n`);
    try {
      await fn();
      passed += 1;
      process.stdout.write(`  ok (${passed}/${tests.length})\n`);
    } catch (err) {
      process.stdout.write(`  FAIL: ${err.stack || err.message}\n`);
      return false;
    }
  }
  process.stdout.write(`selftest: all ${tests.length} checks passed\n`);
  return true;
}

module.exports = {
  runSelftest,
  makeZip,
  damageCentralDirectory,
  makeTempDir,
};
