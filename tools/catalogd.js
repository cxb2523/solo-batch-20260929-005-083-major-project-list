'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const { readCentral, CentralDirectoryError, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_NAME_LENGTH } = require('./readCentral');
const { mergeReadme, diffState, BEGIN_MARKER, END_MARKER } = require('./mergeReadme');
const { atomicWrite, sweepStale, installCrashHandlers, TEMP_PREFIX, TEMP_SUFFIX } = require('./atomicWrite');

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    port: Number(process.env.CATALOGD_PORT) || 7747,
    host: process.env.CATALOGD_HOST || '127.0.0.1',
    zip: process.env.CATALOGD_ZIP || 'Projects-master.zip',
    readme: process.env.CATALOGD_README || 'README.md',
    output: process.env.CATALOGD_OUTPUT || 'projects.json',
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxNameLength: DEFAULT_MAX_NAME_LENGTH,
    strict: false,
    selftest: false,
    once: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--selftest') opts.selftest = true;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--host') opts.host = argv[++i];
    else if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--zip') opts.zip = argv[++i];
    else if (arg === '--readme') opts.readme = argv[++i];
    else if (arg === '--output') opts.output = argv[++i];
    else if (arg === '--max-entries') opts.maxEntries = Number(argv[++i]);
    else if (arg === '--max-name-length') opts.maxNameLength = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('invalid port: ' + opts.port);
  }
  return opts;
}

function resolvePaths(opts, root) {
  const base = root || opts.root;
  const resolve = (value) => (path.isAbsolute(value) ? value : path.resolve(base, value));
  return {
    root: path.resolve(base),
    zip: resolve(opts.zip),
    readme: resolve(opts.readme),
    output: resolve(opts.output),
  };
}

function createState() {
  return {
    building: false,
    inflight: null,
    waiters: 0,
    lastBuild: null,
    serverStartedAt: new Date().toISOString(),
  };
}

async function runRebuild(opts, state) {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const files = resolvePaths(opts);
  const warnings = [];
  let degraded = false;
  let centralEntries = [];
  let totalCentralEntries = 0;
  let readmeText = '';

  sweepStale(files.output);

  try {
    const result = readCentral(files.zip, { maxEntries: opts.maxEntries, maxNameLength: opts.maxNameLength });
    centralEntries = result.entries;
    totalCentralEntries = result.totalCentralEntries;
    warnings.push.apply(warnings, result.warnings);
  } catch (err) {
    if (err instanceof CentralDirectoryError) {
      degraded = true;
      warnings.push({ code: 'central_directory_unreadable', message: 'central directory unreadable, falling back to README: ' + err.message });
    } else {
      throw err;
    }
  }

  try {
    readmeText = fs.readFileSync(files.readme, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    readmeText = '';
  }

  const merged = mergeReadme(readmeText, degraded ? [] : centralEntries, { degraded });
  warnings.push.apply(warnings, merged.warnings);
  if (degraded) {
    warnings.push({ code: 'degraded_mode', message: 'build completed in degraded mode using README entries only' });
  }

  const payload = {
    version: 1,
    generatedAt: startedAtIso,
    sourceZip: path.relative(files.root, files.zip).split(path.sep).join('/'),
    mode: degraded ? 'readme-fallback' : 'central-directory',
    entryCount: merged.entries.length,
    conflictCount: merged.conflicts.count,
    conflicts: merged.conflicts,
    warnings,
    entries: merged.entries,
  };

  await atomicWrite(files.output, JSON.stringify(payload, null, 2) + '\n', { mode: 0o644 });

  let readmeChanged = false;
  if (merged.readmeText !== null && merged.readmeText !== readmeText) {
    await atomicWrite(files.readme, merged.readmeText, { mode: 0o644 });
    readmeChanged = true;
  }

  const durationMs = Date.now() - startedAt;
  const buildInfo = {
    ok: true,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    durationMs,
    entryCount: payload.entryCount,
    conflictCount: payload.conflictCount,
    warningCount: warnings.length,
    warnings,
    degraded,
    readmeChanged,
    totalCentralEntries,
    mode: payload.mode,
  };
  state.lastBuild = buildInfo;
  return buildInfo;
}

function rebuildCoalesced(opts, state) {
  if (state.building && state.inflight) {
    state.waiters += 1;
    const myWait = state.waiters;
    return state.inflight.then((build) => ({
      build,
      coalesced: true,
      waiter: myWait,
    }));
  }
  state.building = true;
  const promise = runRebuild(opts, state).then(
    (build) => {
      state.building = false;
      state.inflight = null;
      return build;
    },
    (err) => {
      state.building = false;
      state.inflight = null;
      state.lastBuild = {
        ok: false,
        finishedAt: new Date().toISOString(),
        error: err && err.message ? err.message : String(err),
      };
      throw err;
    }
  );
  state.inflight = promise;
  return promise.then((build) => ({ build, coalesced: false, waiter: 0 }));
}
function readProjects(outputPath) {
  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function computeDiff(files) {
  let readmeText = '';
  try {
    readmeText = fs.readFileSync(files.readme, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const projects = readProjects(files.output);
  const diff = diffState(readmeText, projects ? projects.entries.map((entry) => entry.name) : []);
  diff.hasProjects = projects !== null;
  diff.degraded = projects ? projects.mode === 'readme-fallback' : false;
  diff.generatedAt = projects ? projects.generatedAt : null;
  return diff;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function statusPage(state, diff, opts, files) {
  const build = state.lastBuild;
  const entryCount = build ? build.entryCount : (diff.hasProjects ? diff.projectCount : 0);
  const conflictCount = build ? build.conflictCount : diff.conflicts;
  const durationText = build && build.ok ? build.durationMs + ' ms' : 'never';
  const statusBadge = state.building ? '<span class="badge running">building</span>'
    : build && build.ok ? '<span class="badge ok">idle</span>'
    : build ? '<span class="badge error">error</span>'
    : '<span class="badge">never built</span>';
  const warnings = build && build.ok ? build.warnings : [];
  const rows = warnings.length ? warnings.map((w) => '<li><code>' + esc(w.code) + '</code> ' + esc(w.message) + '</li>').join('')
    : '<li class="muted">no warnings</li>';
  const onlyInProjects = diff.onlyInProjects.map((name) => '<li>' + esc(name) + '</li>').join('') || '<li class="muted">none</li>';
  const onlyInReadme = diff.onlyInReadme.map((name) => '<li>' + esc(name) + '</li>').join('') || '<li class="muted">none</li>';
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>catalogd status</title>\n'
    + '<style>'
    + 'body{font-family:system-ui,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#1f2933}'
    + 'main{max-width:840px;margin:2rem auto;padding:0 1rem}'
    + 'h1{font-size:1.4rem}.muted{color:#7b8794}'
    + '.cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}'
    + '.card{background:#fff;border:1px solid #e4e7eb;border-radius:10px;padding:1rem 1.25rem;min-width:150px;box-shadow:0 1px 2px rgba(0,0,0,.04)}'
    + '.card .num{font-size:1.9rem;font-weight:600}.card .label{color:#616e7c;font-size:.85rem}'
    + '.badge{display:inline-block;padding:.2rem .6rem;border-radius:999px;background:#e4e7eb;font-size:.8rem}'
    + '.badge.ok{background:#def7ec;color:#03543f}.badge.running{background:#fef3c7;color:#92400e}'
    + '.badge.error{background:#fde2e1;color:#9b1c1c}'
    + 'section{background:#fff;border:1px solid #e4e7eb;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0}'
    + 'code{background:#f0f2f5;padding:.05rem .3rem;border-radius:4px}'
    + 'button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:.55rem 1.1rem;font-size:1rem;cursor:pointer}'
    + 'button[disabled]{opacity:.6;cursor:default}'
    + 'ul{padding-left:1.2rem}'
    + '</style>\n</head>\n<body>\n<main>\n'
    + '<h1>catalogd ' + statusBadge + '</h1>\n'
    + '<div class="cards">'
    + '<div class="card"><div class="num" id="entries">' + entryCount + '</div><div class="label">entries</div></div>'
    + '<div class="card"><div class="num" id="conflicts">' + conflictCount + '</div><div class="label">conflicts vs README</div></div>'
    + '<div class="card"><div class="num" id="duration">' + esc(durationText) + '</div><div class="label">last rebuild duration</div></div>'
    + '</div>\n'
    + '<p class="muted">output: <code>' + esc(path.relative(files.root, files.output).split(path.sep).join('/')) + '</code>'
    + (build && build.degraded ? ' &middot; <strong>degraded mode</strong> (README fallback)' : '')
    + (build && build.ok ? ' &middot; built ' + esc(build.finishedAt) : '') + '</p>\n'
    + '<p><button id="rebuild">Rebuild now</button> <span id="msg" class="muted"></span></p>\n'
    + '<section><h2>Warnings</h2><ul id="warnings">' + rows + '</ul></section>\n'
    + '<section><h2>Diff vs README (' + diff.conflicts + ')</h2>'
    + '<h3>Only in projects.json</h3><ul>' + onlyInProjects + '</ul>'
    + '<h3>Only in README block</h3><ul>' + onlyInReadme + '</ul></section>\n'
    + '<script>'
    + 'var btn=document.getElementById("rebuild"),msg=document.getElementById("msg");'
    + 'btn.addEventListener("click",function(){btn.disabled=true;msg.textContent="rebuilding...";'
    + 'fetch("/rebuild",{method:"POST"}).then(function(r){return r.json();}).then(function(body){'
    + 'msg.textContent=(body.coalesced?"merged into in-flight rebuild (#"+body.waiter+")":"rebuild finished")+": "+body.durationMs+" ms, "+body.entryCount+" entries";'
    + 'btn.disabled=false;setTimeout(function(){location.reload();},600);'
    + '}).catch(function(err){msg.textContent="failed: "+err;btn.disabled=false;});});'
    + '</script>\n</main>\n</body>\n</html>\n';
}

function createServer(opts, state) {
  const files = resolvePaths(opts);
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      return sendJson(res, 400, { error: 'bad request url' });
    }
    const route = url.pathname;
    if (req.method === 'POST' && route === '/rebuild') {
      rebuildCoalesced(opts, state).then(
        (result) => sendJson(res, 200, {
          ok: true,
          coalesced: result.coalesced,
          mergedWithInFlight: result.coalesced,
          waiter: result.waiter,
          note: result.coalesced
            ? 'a rebuild was already running; this request was merged into the single in-flight build'
            : 'rebuild completed',
          durationMs: result.build.durationMs,
          entryCount: result.build.entryCount,
          conflictCount: result.build.conflictCount,
          warningCount: result.build.warningCount,
          warnings: result.build.warnings,
          degraded: result.build.degraded,
        }),
        (err) => sendJson(res, 500, { ok: false, error: err.message || String(err) })
      );
      return;
    }
    if (req.method === 'GET' && route === '/diff') {
      try {
        return sendJson(res, 200, computeDiff(files));
      } catch (err) {
        return sendJson(res, 500, { error: err.message || String(err) });
      }
    }
    if (req.method === 'GET' && route === '/status') {
      const diff = computeDiff(files);
      return sendJson(res, 200, {
        building: state.building,
        queuedWaiters: state.waiters,
        lastBuild: state.lastBuild,
        diff: {
          entryCount: diff.projectCount,
          conflictCount: diff.conflicts,
          readmeBlockPresent: diff.blockPresent,
          degraded: diff.degraded,
        },
      });
    }
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      let diff;
      try {
        diff = computeDiff(files);
      } catch (err) {
        return sendJson(res, 500, { error: err.message || String(err) });
      }
      const html = statusPage(state, diff, opts, files);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
      return res.end(html);
    }
    sendJson(res, 404, { error: 'not found', routes: ['GET /', 'GET /diff', 'GET /status', 'POST /rebuild'] });
  });
}

async function runOnce(opts) {
  const state = createState();
  const result = await rebuildCoalesced(opts, state);
  const build = result.build;
  process.stdout.write(JSON.stringify({
    ok: true,
    entryCount: build.entryCount,
    conflictCount: build.conflictCount,
    warningCount: build.warningCount,
    durationMs: build.durationMs,
    degraded: build.degraded,
  }, null, 2) + '\n');
  return opts.strict && build.warningCount > 0 ? 2 : 0;
}

function startServer(opts) {
  installCrashHandlers();
  const state = createState();
  const server = createServer(opts, state);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : opts.port;
      process.stdout.write('catalogd listening on http://' + opts.host + ':' + actualPort + '\n');
      if (process.env.CATALOGD_PORT_FILE) {
        try { fs.writeFileSync(process.env.CATALOGD_PORT_FILE, String(actualPort)); } catch (err) { void err; }
      }
      resolve({ server, state, port: actualPort });
    });
  });
}

const HELP_TEXT = [
  'usage: node tools/catalogd.js [options]',
  '',
  '  --serve (default)          run the local http service',
  '  --once                     run a single rebuild and exit',
  '  --selftest                 run integration self-test and exit',
  '  --strict                   non-zero exit code when warnings exist (--once / --selftest)',
  '  --port <port>              listen port (default 7747, env CATALOGD_PORT)',
  '  --host <host>              bind host (default 127.0.0.1, env CATALOGD_HOST)',
  '  --root <dir>               workspace root (default cwd)',
  '  --zip <file>               zip archive path relative to root (default Projects-master.zip)',
  '  --readme <file>            README path relative to root (default README.md)',
  '  --output <file>            catalog output path relative to root (default projects.json)',
  '  --max-entries <n>          per-scan entry cap (default ' + DEFAULT_MAX_ENTRIES + ')',
  '  --max-name-length <n>      entry name truncation limit (default ' + DEFAULT_MAX_NAME_LENGTH + ')',
].join('\n');

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(String(err.message || err) + '\n\n' + HELP_TEXT + '\n');
    return 1;
  }
  if (opts.help) {
    process.stdout.write(HELP_TEXT + '\n');
    return 0;
  }
  if (opts.selftest) {
    const { runSelftest } = require('./selftest');
    const code = await runSelftest(opts);
    return code;
  }
  if (opts.once) {
    return runOnce(opts).then((code) => code, (err) => {
      process.stderr.write('rebuild failed: ' + (err.message || String(err)) + '\n');
      return 1;
    });
  }
  await startServer(opts);
  return null;
}

if (require.main === module) {
  main().then((code) => {
    if (typeof code === 'number') process.exit(code);
  }).catch((err) => {
    process.stderr.write('fatal: ' + (err.stack || err.message || String(err)) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolvePaths,
  createState,
  runRebuild,
  rebuildCoalesced,
  createServer,
  startServer,
  runOnce,
  computeDiff,
};