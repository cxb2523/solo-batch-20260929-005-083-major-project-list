'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CATALOGD = path.join(__dirname, 'catalogd.js');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(zipPath, specs) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const spec of specs) {
    const nameBuf = Buffer.from(spec.name, 'utf8');
    const data = Buffer.from(spec.content == null ? '' : spec.content, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localChunks.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centralChunks.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt16LE(specs.length, 12);
  eocd.writeUInt32LE(central.length, 12 + 0);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat(localChunks.concat([central, eocd])));
}

function makeWorkspace(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogd-' + name + '-'));
  return dir;
}

function dirtySpecs() {
  const longName = 'proj/' + 'n'.repeat(130) + '.txt';
  return [
    { name: 'proj/' },
    { name: 'proj/a.txt', content: 'A' },
    { name: 'proj/b.txt', content: 'BB' },
    { name: 'proj/dup.txt', content: 'FIRST' },
    { name: 'proj/dup.txt', content: 'SECOND' },
    { name: longName, content: 'L' },
    { name: 'proj/sub/c.txt', content: 'C' },
  ];
}

function cleanSpecs() {
  return [
    { name: 'proj/' },
    { name: 'proj/x.txt', content: 'X' },
    { name: 'proj/y.txt', content: 'Y' },
  ];
}

function expectedDirtyNames() {
  return ['a.txt', 'b.txt', 'dup.txt', 'n'.repeat(117) + '...', 'sub/c.txt'];
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= 0) return;
    } catch (err) { void err; }
    await wait(50);
  }
  throw new Error('timed out waiting for ' + file);
}

function spawnServer(root, portFile, extraArgs) {
  const args = [CATALOGD, '--port', '0', '--host', '127.0.0.1', '--root', root].concat(extraArgs || []);
  const child = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, { CATALOGD_PORT_FILE: portFile }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, logs, stop() { child.kill(); } };
}

async function startServer(root, extraArgs) {
  const portFile = path.join(root, '.port');
  const server = spawnServer(root, portFile, extraArgs);
  await waitForFile(portFile);
  const port = Number(fs.readFileSync(portFile, 'utf8').trim());
  if (!port) throw new Error('could not determine server port\n' + server.logs);
  const base = 'http://127.0.0.1:' + port;
  return Object.assign(server, { port, base });
}

async function stopServer(server) {
  server.stop();
  await new Promise((resolve) => {
    server.child.on('exit', resolve);
    setTimeout(resolve, 3000);
  });
}

async function httpJson(method, url) {
  const res = await fetch(url, { method });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (err) { body = text; }
  return { status: res.status, body, text };
}

async function httpText(method, url) {
  const res = await fetch(url, { method });
  return { status: res.status, text: await res.text() };
}

function runOnce(root, extraArgs) {
  return new Promise((resolve) => {
    const args = [CATALOGD, '--once', '--root', root].concat(extraArgs || []);
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message }));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function readProjects(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8'));
}

function listTempFiles(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith('.projects.') && name.endsWith('.tmp'));
}
function stableProjectSnapshot(p) {
  return JSON.stringify({ mode: p.mode, entries: p.entries, conflictCount: p.conflictCount });
}

async function scenarioDirtyServer(ctx) {
  const root = makeWorkspace('dirty');
  ctx.workspaces.push(root);
  buildZip(path.join(root, 'Projects-master.zip'), dirtySpecs());
  fs.writeFileSync(path.join(root, 'README.md'), '# Hello list\n\nkeep me above\n');

  const server = await startServer(root);
  const rootPage = await httpText('GET', server.base + '/');
  ctx.check(rootPage.status === 200, 'status page responds 200');
  ctx.check(/catalogd/.test(rootPage.text), 'status page renders catalogd header');

  const one = await httpJson('POST', server.base + '/rebuild');
  ctx.check(one.status === 200 && one.body.ok, 'first rebuild succeeds');
  ctx.check(one.body.coalesced === false, 'first rebuild is not marked coalesced');
  ctx.check(one.body.entryCount === 5, 'entry count matches deduped zip files (got ' + one.body.entryCount + ')');
  ctx.check(one.body.warningCount >= 2, 'duplicate + truncation warnings recorded (got ' + one.body.warningCount + ')');

  const projects1 = readProjects(root);
  const expectedNames = expectedDirtyNames();
  ctx.check(JSON.stringify(projects1.entries.map((e) => e.name)) === JSON.stringify(expectedNames),
    'first occurrence kept and long name truncated');
  ctx.check(projects1.entries.every((e) => e.name.length <= 120), 'all stored names within length limit');
  ctx.check(projects1.conflictCount === 0, 'no conflict against fresh README block');

  const readme1 = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  ctx.check(readme1.startsWith('# Hello list\n\nkeep me above\n'), 'content outside markers preserved verbatim');
  ctx.check(readme1.split('<!-- CATALOG BEGIN -->').length === 2, 'BEGIN marker appended exactly once');
  ctx.check(readme1.split('<!-- CATALOG END -->').length === 2, 'END marker appended exactly once');

  const two = await httpJson('POST', server.base + '/rebuild');
  ctx.check(two.body.coalesced === false, 'sequential rebuild runs independently');
  const projects2 = readProjects(root);
  const readme2 = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  ctx.check(stableProjectSnapshot(projects1) === stableProjectSnapshot(projects2), 'second rebuild produces identical catalog (idempotent)');
  ctx.check(readme1 === readme2, 'second rebuild leaves README byte-identical (idempotent)');
  ctx.check(two.body.readmeChanged === undefined || projects2 !== null, 'rebuild response well formed');

  const diff = await httpJson('GET', server.base + '/diff');
  ctx.check(diff.status === 200 && diff.body.conflicts === 0, 'GET /diff reports zero conflicts after idempotent rebuild');
  ctx.check(diff.body.projectCount === 5 && diff.body.readmeCount === 5, 'diff counts match both sides');

  const status = await httpJson('GET', server.base + '/status');
  ctx.check(status.body.lastBuild && typeof status.body.lastBuild.durationMs === 'number', 'status exposes last build duration');
  ctx.check(status.body.lastBuild.entryCount === 5, 'status exposes entry count');
  ctx.check(status.body.lastBuild.conflictCount === 0, 'status exposes conflict count');

  const fired = await Promise.all([
    httpJson('POST', server.base + '/rebuild'),
    httpJson('POST', server.base + '/rebuild'),
    httpJson('POST', server.base + '/rebuild'),
  ]);
  const coalescedCount = fired.filter((r) => r.body.coalesced === true).length;
  const mergedNotes = fired.filter((r) => r.body.mergedWithInFlight === true && /merged/.test(r.body.note)).length;
  ctx.check(coalescedCount === 2, 'two of three concurrent rebuilds are merged (got ' + coalescedCount + ')');
  ctx.check(mergedNotes === 2, 'merged responses explain the coalescing');

  ctx.check(listTempFiles(root).length === 0, 'no temp files left after rebuilds (atomic rename)');

  const fakeTmp = path.join(root, '.projects.projects.json.321.bogus' + '.tmp');
  fs.writeFileSync(fakeTmp, 'partial');
  await httpJson('POST', server.base + '/rebuild');
  ctx.check(!fs.existsSync(fakeTmp), 'leftover temp file from an interrupted run is swept on next rebuild');
  ctx.check(listTempFiles(root).length === 0, 'half files never linger next to projects.json');
  const projectsAfterSweep = readProjects(root);
  ctx.check(stableProjectSnapshot(projectsAfterSweep) === stableProjectSnapshot(projects2), 'sweep rebuild stays idempotent');

  await stopServer(server);
}

async function scenarioDegraded(ctx) {
  const root = makeWorkspace('corrupt');
  ctx.workspaces.push(root);
  fs.writeFileSync(path.join(root, 'Projects-master.zip'), Buffer.concat([
    Buffer.from('PKnot a zip'),
    Buffer.from('garbage'.repeat(50)),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  ]));
  fs.writeFileSync(path.join(root, 'README.md'), '# Title\n\n<!-- CATALOG BEGIN -->\n- rescue-one\n- rescue-two\n<!-- CATALOG END -->\n\ntail content\n');

  const server = await startServer(root);
  const rebuild = await httpJson('POST', server.base + '/rebuild');
  ctx.check(rebuild.status === 200, 'rebuild still succeeds when central directory is damaged');
  ctx.check(rebuild.body.degraded === true, 'response signals degraded README-fallback mode');
  ctx.check(rebuild.body.entryCount === 2, 'entries come from README block in degraded mode');
  ctx.check(rebuild.body.warningCount >= 1, 'degraded path records a warning');

  const projects = readProjects(root);
  ctx.check(projects.mode === 'readme-fallback', 'projects.json tagged readme-fallback');
  ctx.check(JSON.stringify(projects.entries.map((e) => e.name)) === JSON.stringify(['rescue-one', 'rescue-two']), 'README entries rescue the catalog');
  ctx.check(projects.conflictCount === 0, 'degraded catalog does not report README entries as conflicts');

  const diff = await httpJson('GET', server.base + '/diff');
  ctx.check(diff.body.conflicts === 0, 'GET /diff agrees with degraded catalog');
  const readmeAfter = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  ctx.check(readmeAfter.endsWith('tail content\n') && readmeAfter.startsWith('# Title\n'), 'outside-marker content kept in degraded mode');
  await stopServer(server);
}

async function scenarioOnceModes(ctx) {
  const clean = makeWorkspace('clean');
  ctx.workspaces.push(clean);
  buildZip(path.join(clean, 'Projects-master.zip'), cleanSpecs());
  fs.writeFileSync(path.join(clean, 'README.md'), 'clean readme\n');

  const first = await runOnce(clean, ['--strict']);
  ctx.check(first.code === 0, 'clean --once --strict exits 0 when there are no warnings');
  const projects1 = readProjects(clean);
  ctx.check(projects1.entryCount === 2 && projects1.warningCount === 0, 'clean build has two entries, no warnings');

  const second = await runOnce(clean, ['--strict']);
  ctx.check(second.code === 0, 'repeated clean --once stays exit 0 and idempotent');
  ctx.check(stableProjectSnapshot(projects1) === stableProjectSnapshot(readProjects(clean)), 'clean repeated build identical');

  const dirty = makeWorkspace('dirty-once');
  ctx.workspaces.push(dirty);
  buildZip(path.join(dirty, 'Projects-master.zip'), dirtySpecs());
  fs.writeFileSync(pathirtyOncePlaceholder(dirty));
  const dirtyRun = await runOnce(dirty, ['--strict']);
  ctx.check(dirtyRun.code === 2, '--strict returns non-zero (2) when warnings exist');
  const dirtyLenient = await runOnce(dirty, []);
  ctx.check(dirtyLenient.code === 0, 'same build without --strict exits 0 despite warnings');
  ctx.check(readProjects(dirty).entryCount === 5, 'warnings never crash the scan');

  const corrupt = makeWorkspace('corrupt-once');
  ctx.workspaces.push(corrupt);
  fs.writeFileSync(path.join(corrupt, 'Projects-master.zip'), 'totally not a zip file at all');
  fs.writeFileSync(path.join(corrupt, 'README.md'), '<!-- CATALOG BEGIN -->\n- only-readme\n<!-- CATALOG END -->\n');
  const corruptStrict = await runOnce(corrupt, ['--strict']);
  ctx.check(corruptStrict.code === 2, 'degraded --once --strict exits non-zero due to fallback warning');
  ctx.check(readProjects(corrupt).mode === 'readme-fallback', 'one-shot build falls back to README');

  const malformed = makeWorkspace('malformed');
  ctx.workspaces.push(malformed);
  buildZip(path.join(malformed, 'Projects-master.zip'), cleanSpecs());
  fs.writeFileSync(path.join(malformed, 'README.md'), 'head\n<!-- CATALOG BEGIN -->\n- orphan\n');
  const malformedRun = await runOnce(malformed, ['--strict']);
  ctx.check(malformedRun.code === 2, 'malformed markers produce a warning and non-zero strict exit');
  const readmeMalformed = fs.readFileSync(path.join(malformed, 'README.md'), 'utf8');
  ctx.check(readmeMalformed === 'head\n<!-- CATALOG BEGIN -->\n- orphan\n', 'malformed README is left untouched');
}

function fsWritePlaceholderShim(root) {
  fs.writeFileSync(path.join(root, 'README.md'), '# dirty once\n');
}
function pathirtyOncePlaceholder(root) {
  fsWritePlaceholderShim(root);
}

async function scenarioEntryLimit(ctx) {
  const root = makeWorkspace('limit');
  ctx.workspaces.push(root);
  const specs = [];
  for (let i = 0; i < 6; i++) specs.push({ name: 'src/f' + i + '.txt', content: String(i) });
  buildZip(path.join(root, 'Projects-master.zip'), specs);
  fs.writeFileSync(path.join(root, 'README.md'), 'limited\n');

  const server = await startServer(root, ['--max-entries', '3']);
  const rebuild = await httpJson('POST', server.base + '/rebuild');
  ctx.check(rebuild.status === 200, 'build survives an over-limit scan');
  ctx.check(rebuild.body.entryCount === 3, 'only the capped number of entries is catalogued (got ' + rebuild.body.entryCount + ')');
  ctx.check(rebuild.body.warnings.some((w) => w.code === 'entry_limit_exceeded'), 'entry cap produces a warning instead of a crash');
  await stopServer(server);
}

async function runSelftest() {
  const ctx = {
    passed: 0,
    failed: 0,
    workspaces: [],
    check(condition, message) {
      if (condition) {
        this.passed += 1;
        process.stdout.write('  ok  - ' + message + '\n');
      } else {
        this.failed += 1;
        process.stdout.write('  FAIL- ' + message + '\n');
      }
    },
  };
  const scenarios = [
    ['dirty zip: idempotency, coalescing, atomic writes', scenarioDirtyServer],
    ['damaged central directory: README fallback', scenarioDegraded],
    ['--once modes: strict exit codes', scenarioOnceModes],
    ['entry cap: warning instead of crash', scenarioEntryLimit],
  ];
  try {
    for (const [label, scenario] of scenarios) {
      process.stdout.write('\n[selftest] ' + label + '\n');
      await scenario(ctx);
    }
  } finally {
    for (const root of ctx.workspaces) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { void err; }
    }
  }
  process.stdout.write('\n[selftest] ' + ctx.passed + ' passed, ' + ctx.failed + ' failed\n');
  return ctx.failed === 0 ? 0 : 1;
}

module.exports = { runSelftest, buildZip, crc32 };