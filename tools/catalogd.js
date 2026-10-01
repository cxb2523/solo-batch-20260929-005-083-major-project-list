'use strict';

// catalogd: local HTTP service that builds projects.json from a zip archive's
// central directory, cross-checked against the managed block in README.md.
//
// Endpoints:
//   GET  /         HTML status page (entries, conflicts, last duration)
//   GET  /status   same data as JSON
//   GET  /diff     differences between zip central directory and README
//   POST /rebuild  run one rebuild; concurrent calls share one build
//
// CLI:
//   node tools/catalogd.js                 start server (port CATALOG_PORT/3000)
//   node tools/catalogd.js --once          one rebuild in the foreground
//   node tools/catalogd.js --selftest      run the built-in acceptance suite
//   node tools/catalogd.js --strict        non-zero exit when warnings exist

const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const {
  readCentral,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_NAME,
} = require('./lib/readCentral');
const { mergeReadme, parseReadmeEntries } = require('./lib/mergeReadme');
const {
  atomicWriteSync,
  cleanupStale,
  cleanupActive,
} = require('./lib/atomicWrite');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ZIP = path.join(REPO_ROOT, 'Projects-master.zip');
const DEFAULT_README = path.join(REPO_ROOT, 'README.md');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'projects.json');

const EMPTY_STATUS = {
  state: 'idle',
  running: false,
  generation: 0,
  entryCount: 0,
  conflictCount: 0,
  warningCount: 0,
  warnings: [],
  notices: [],
  degraded: false,
  lastDurationMs: null,
  lastBuiltAt: null,
  lastError: null,
};

function createConfig(argv = process.argv.slice(2), env = process.env) {
  const flags = new Set(argv);
  const option = (name) => {
    const index = argv.indexOf(name);
    if (index === -1 || index + 1 >= argv.length) return undefined;
    return argv[index + 1];
  };
  const integer = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const portOrZero = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
      ? parsed
      : fallback;
  };

  return {
    port: portOrZero(option('--port'), portOrZero(env.CATALOG_PORT, 3000)),
    host: env.CATALOG_HOST || '127.0.0.1',
    zipPath: option('--zip') || env.CATALOG_ZIP || DEFAULT_ZIP,
    readmePath: option('--readme') || env.CATALOG_README || DEFAULT_README,
    outputPath: option('--output') || env.CATALOG_OUTPUT || DEFAULT_OUTPUT,
    maxEntries: integer(
      option('--max-entries'),
      integer(env.CATALOG_MAX_ENTRIES, DEFAULT_MAX_ENTRIES)
    ),
    maxName: integer(
      option('--max-name'),
      integer(env.CATALOG_MAX_NAME, DEFAULT_MAX_NAME)
    ),
    strict: flags.has('--strict'),
    once: flags.has('--once'),
    selftest: flags.has('--selftest'),
    // Test-only knob: hold the build for this many ms so two HTTP requests can
    // deterministically overlap and exercise single-flight coalescing.
    buildDelayMs: integer(env.CATALOG_BUILD_DELAY_MS, 0),
  };
}

function stableStringify(value) {
  const seen = new WeakSet();
  const render = (node) => {
    if (node === null || typeof node !== 'object') {
      return JSON.stringify(node);
    }
    if (seen.has(node)) {
      throw new TypeError('Converting circular structure to JSON');
    }
    seen.add(node);
    if (Array.isArray(node)) {
      return `[${node.map(render).join(',')}]`;
    }
    const keys = Object.keys(node).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${render(node[key])}`);
    return `{${parts.join(',')}}`;
  };
  return render(value);
}

function createBuilder(config) {
  const status = { ...EMPTY_STATUS };
  let active = null;

  const snapshot = () => ({
    ...status,
    warnings: status.warnings.slice(),
    notices: status.notices.slice(),
  });

  async function runBuild() {
    const started = performance.now();
    const generation = status.generation + 1;
    status.state = 'building';
    status.running = true;
    status.generation = generation;
    status.lastError = null;

    let zipResult = null;
    try {
      zipResult = readCentral(config.zipPath, {
        maxEntries: config.maxEntries,
        maxName: config.maxName,
      });
    } catch (err) {
      // Damaged central directory: degrade to the README block below.
      zipResult = null;
      status.degraded = true;
    }

    if (config.buildDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.buildDelayMs));
    }

    let merged;
    try {
      merged = mergeReadme(config.readmePath, zipResult, {
        maxEntries: config.maxEntries,
        maxName: config.maxName,
      });

      // Distinct warning list keeps repeated rebuilds honest and readable.
      const warnings = [...new Set(merged.warnings)];
      const catalog = {
        generatedBy: 'tools/catalogd.js',
        source: path.basename(config.zipPath),
        degraded: merged.degraded,
        entryCount: merged.entries.length,
        conflictCount: merged.conflicts.length,
        warningCount: warnings.length,
        warnings,
        entries: merged.entries.map((name, index) => ({
          id: index + 1,
          name,
        })),
      };
      const serialized = `${stableStringify(catalog)}\n`;

      // Skip the write entirely when bytes are unchanged: repeated rebuilds are
      // idempotent and never touch an identical artifact.
      cleanupStale(config.outputPath);
      let previous = null;
      try {
        previous = fs.readFileSync(config.outputPath, 'utf8');
      } catch {}
      if (previous !== serialized) {
        atomicWriteSync(config.outputPath, serialized);
      }

      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      Object.assign(status, {
        state: 'idle',
        running: false,
        entryCount: catalog.entryCount,
        conflictCount: catalog.conflictCount,
        warningCount: warnings.length,
        warnings,
        notices: [...new Set(merged.notices)],
        degraded: merged.degraded,
        lastDurationMs: durationMs,
        lastBuiltAt: new Date().toISOString(),
      });
      return {
        ok: true,
        generation,
        durationMs,
        entryCount: catalog.entryCount,
        conflictCount: catalog.conflictCount,
        warningCount: warnings.length,
        warnings,
        notices: [...new Set(merged.notices)],
        degraded: merged.degraded,
        onlyInZip: merged.onlyInZip,
        onlyInReadme: merged.onlyInReadme,
        readmeChanged: merged.readmeChanged,
      };
    } catch (err) {
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      Object.assign(status, {
        state: 'error',
        running: false,
        lastError: err.message,
        lastDurationMs: durationMs,
        lastBuiltAt: new Date().toISOString(),
      });
      return {
        ok: false,
        generation,
        durationMs,
        error: err.message,
      };
    }
  }

  // Single-flight: at most one build at a time and no two writers ever touch
  // the same artifact. Concurrent callers await the same promise.
  function rebuild() {
    if (active) {
      return active.then((result) => ({
        ...result,
        coalesced: true,
        message:
          'A rebuild was already running; this request was merged into that single build.',
      }));
    }
    active = runBuild().finally(() => {
      active = null;
    });
    return active.then((result) => ({
      ...result,
      coalesced: false,
      message: 'Rebuild completed.',
    }));
  }

  return { rebuild, snapshot };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusPage(status, port) {
  const rows = [
    ['State', status.running ? 'building' : status.state],
    ['Entries', status.entryCount],
    ['Conflicts', status.conflictCount],
    ['Warnings', status.warningCount],
    ['Degraded', status.degraded ? 'yes (README source of truth)' : 'no'],
    ['Last duration (ms)', status.lastDurationMs == null ? '-' : status.lastDurationMs],
    ['Last built', status.lastBuiltAt || '-'],
    ['Port', port],
  ];
  const list = (items) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p>none</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>catalogd status</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 48rem; color: #1f2933; }
h1 { font-size: 1.4rem; }
table { border-collapse: collapse; margin: 1rem 0; }
td, th { border: 1px solid #cbd2d9; padding: 0.4rem 0.8rem; text-align: left; }
th { background: #f5f7fa; }
button { padding: 0.5rem 1rem; cursor: pointer; }
.muted { color: #52606d; }
code { background: #f5f7fa; padding: 0 0.25rem; }
</style>
</head>
<body>
<h1>catalogd &mdash; project catalog service</h1>
<p class="muted">Status updates automatically every 3 seconds, or trigger a rebuild manually.</p>
<table>
<tbody>
${rows
  .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
  .join('\n')}
</tbody>
</table>
<p>
  <button id="rebuild" type="button">Rebuild now</button>
  <span id="result" class="muted"></span>
</p>
<h2>Warnings</h2>
${list(status.warnings)}
<h2>Notices</h2>
${list(status.notices)}
<p class="muted">JSON: <code>/status</code> &middot; diff: <code>/diff</code></p>
<script>
async function triggerRebuild() {
  const result = document.getElementById('result');
  result.textContent = 'rebuilding...';
  try {
    const res = await fetch('/rebuild', { method: 'POST' });
    const data = await res.json();
    result.textContent = data.message + ' (' + (data.durationMs || '?') + ' ms)';
  } catch (err) {
    result.textContent = 'rebuild failed: ' + err;
  }
  setTimeout(() => window.location.reload(), 500);
}
document.getElementById('rebuild').addEventListener('click', triggerRebuild);
setTimeout(() => window.location.reload(), 3000);
</script>
</body>
</html>`;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function createServer(config) {
  const builder = createBuilder(config);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const body = renderStatusPage(builder.snapshot(), server.address().port);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      sendJson(res, 200, builder.snapshot());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/diff') {
      let catalog;
      try {
        catalog = JSON.parse(fs.readFileSync(config.outputPath, 'utf8'));
      } catch {
        sendJson(res, 503, {
          ok: false,
          error: 'projects.json not built yet; POST /rebuild first',
        });
        return;
      }
      let readmeText;
      try {
        readmeText = fs.readFileSync(config.readmePath, 'utf8');
      } catch {
        readmeText = '';
      }
      let readmeEntries;
      try {
        readmeEntries = parseReadmeEntries(readmeText);
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: err.message,
          zipEntries: catalog.entryCount,
          readmeEntries: 0,
        });
        return;
      }
      const readmeNames = readmeEntries.entries;
      const catalogNames = catalog.entries.map((entry) => entry.name);
      const catalogSet = new Set(catalogNames);
      const readmeSet = new Set(readmeNames);
      sendJson(res, 200, {
        ok: true,
        degraded: Boolean(catalog.degraded),
        zipEntryCount: catalog.entryCount,
        readmeEntryCount: readmeNames.length,
        conflictCount: catalog.conflictCount,
        onlyInZip: catalogNames.filter((name) => !readmeSet.has(name)),
        onlyInReadme: readmeNames.filter((name) => !catalogSet.has(name)),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rebuild') {
      // Drain any request body; the endpoint takes no parameters.
      req.on('data', () => {});
      req.on('end', () => {
        builder.rebuild().then(
          (result) => sendJson(res, result.ok ? 200 : 500, result),
          (err) => sendJson(res, 500, { ok: false, error: err.message })
        );
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  });

  server.builder = builder;
  return server;
}

function installSignalHandlers(server) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupActive();
    if (!server || !server.listening) {
      process.exit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    const timer = setTimeout(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }, 2000);
    timer.unref();
    server.close(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main() {
  const config = createConfig();

  if (config.selftest) {
    const { runSelftest } = require('./selftest');
    const ok = await runSelftest();
    process.exit(ok ? 0 : 1);
  }

  // Remove half-written temps from a crashed previous run before anything
  // reads or writes an artifact.
  cleanupStale(config.outputPath);
  cleanupStale(config.readmePath);

  if (config.once) {
    const builder = createBuilder(config);
    const result = await builder.rebuild();
    if (!result.ok) {
      console.error(`rebuild failed: ${result.error}`);
      process.exit(1);
    }
    console.log(
      `rebuild ok: ${result.entryCount} entries, ${result.conflictCount} conflicts, ` +
        `${result.warningCount} warnings, ${result.durationMs} ms` +
        (result.degraded ? ' [degraded]' : '')
    );
    if (result.notices.length) {
      for (const notice of result.notices) console.log(`notice: ${notice}`);
    }
    if (result.warnings.length) {
      for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      if (config.strict) process.exit(2);
    }
    process.exit(0);
  }

  const server = createServer(config);
  installSignalHandlers(server);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  console.log(
    `catalogd listening on http://${config.host}:${address.port}  ` +
      `(zip=${path.basename(config.zipPath)}, strict=${config.strict ? 'on' : 'off'})`
  );

  // Build once at startup so the status page has data immediately.
  const result = await server.builder.rebuild();
  if (!result.ok) {
    console.error(`initial rebuild failed: ${result.error}`);
  } else {
    console.log(
      `initial rebuild: ${result.entryCount} entries, ${result.conflictCount} conflicts, ` +
        `${result.warningCount} warnings, ${result.durationMs} ms`
    );
  }

  if (config.strict && result.ok && result.warningCount > 0) {
    // --strict on a long-running server governs the foreground startup build.
    console.error('strict mode: warnings present, exiting non-zero');
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  REPO_ROOT,
  DEFAULT_ZIP,
  DEFAULT_README,
  DEFAULT_OUTPUT,
  EMPTY_STATUS,
  createConfig,
  stableStringify,
  createBuilder,
  createServer,
  renderStatusPage,
  installSignalHandlers,
};
