// Phase02 workbench server (W3; W4 adds round decisions, English UI, isolated project root for checks) — one process:
//   workbench UI + API + SSE   http://127.0.0.1:5480   (Vite middleware for the React workbench)
//   target sample page         http://127.0.0.1:5481   (Vite dev server of target-app, with chain-bridge)
//   evidence Chrome (CDP)      127.0.0.1:9481           (short-lived headless Chrome, own profile, started per capture)
// Usage: npm start            (real model calls; needs ANTHROPIC_API_KEY in the environment)
//        npm run start:stub   (stub model, for exception-path checks only; sessions labelled "Stub model")
// Stop: Ctrl+C in the terminal (or kill this process's PID). It never stops other processes.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { createExecutor } from '../chain/executor.mjs';
import { RUNNING } from '../runtime/code-version.mjs';
import { typeChecker, baselineSnapshotter } from '../runtime/project-checks.mjs';
import { createSessionManager } from './session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '../../..');
const HOST = '127.0.0.1';
const WB_PORT = Number(process.env.WORKBENCH_PORT || 5480);
const TARGET_PORT = Number(process.env.TARGET_PORT || 5481);
const CDP_PORT = Number(process.env.EVIDENCE_CDP_PORT || 9481);
const STUB = process.argv.includes('--stub') || process.env.STUDIO_MODEL === 'stub';
const TARGET_URL = `http://${HOST}:${TARGET_PORT}`;
const WB_ORIGIN = `http://${HOST}:${WB_PORT}`;

async function assertFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const inUse = await new Promise((resolve) => {
      const probe = net.createServer().once('error', (e) => resolve(e.code === 'EADDRINUSE')).once('listening', () => probe.close(() => resolve(false)));
      probe.listen(port, host);
    });
    if (inUse) { console.error(`Port ${port} is already in use on ${host}. Not starting (set WORKBENCH_PORT / TARGET_PORT / EVIDENCE_CDP_PORT).`); process.exit(1); }
  }
}
for (const p of [WB_PORT, TARGET_PORT, CDP_PORT]) await assertFree(p);
if (!STUB && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set. Use `npm run start:stub` for the stub model, or set the key in the environment.'); process.exit(1); }

// STUDIO_REGISTRY lets another project (W5: the AI Earth copy) bring its own regions; the sample stays the default.
const registryFile = process.env.STUDIO_REGISTRY ? path.resolve(process.env.STUDIO_REGISTRY) : path.join(pkg, 'chain/registry.json');
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
// STUDIO_PROJECT_ROOT lets checks run on an isolated copy of the sample (the working copy may hold a user's result).
const projectRoot = process.env.STUDIO_PROJECT_ROOT ? path.resolve(process.env.STUDIO_PROJECT_ROOT) : path.resolve(path.dirname(registryFile), registry.projectRoot);
// Stub sessions keep their own state so they can never be mixed with live sessions/evidence.
const stateRoot = process.env.STUDIO_STATE_DIR || (STUB ? path.join(pkg, '.stub-state') : pkg);
const exec = createExecutor({ projectRoot, registry, patchesDir: path.join(pkg, 'chain'), stateDir: path.join(stateRoot, '.chain-state') });

const targetConfig = () => ({
  configFile: false,
  root: projectRoot,
  // Two studios may share one linked node_modules (a copy links it instead of duplicating 139 MB). Vite's
  // dependency cache lives there by default and the two rebuild over each other, which fails on Windows.
  ...(process.env.STUDIO_VITE_CACHE ? { cacheDir: process.env.STUDIO_VITE_CACHE } : {}),
  plugins: [react()],
  define: { __WORKBENCH_ORIGIN__: JSON.stringify(WB_ORIGIN) },
  // Own HMR port per instance, so a second studio (a check) never attaches to another instance's HMR socket.
  server: { port: TARGET_PORT, strictPort: true, host: HOST, hmr: { port: TARGET_PORT + 1000, host: HOST } },
  logLevel: 'warn',
});
let target = await createVite(targetConfig());
await target.listen();

const workbench = await createVite({
  configFile: false,
  root: path.join(pkg, 'workbench'),
  plugins: [react()],
  define: { __TARGET_URL__: JSON.stringify(TARGET_URL) },
  server: { middlewareMode: true, hmr: false },
  appType: 'spa',
  logLevel: 'warn',
});

// ---------- sessions ----------
const clients = new Set();
let pending = null;
const broadcast = () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const data = `data: ${JSON.stringify(snap())}\n\n`;
    for (const res of clients) res.write(data);
  }, 60);
};
// A region whose component may be edited gets two extra guards (see runtime/project-checks.mjs).
const typeCheck = typeChecker({ projectRoot });
const baseline = await baselineSnapshotter(process.env.STUDIO_BASELINE || '');

const sessions = createSessionManager({
  typeCheck, baseline,
  sessionsDir: path.join(stateRoot, '.sessions'),
  ledgerFile: process.env.STUDIO_LEDGER || path.join(repo, 'outputs/phase-02/w4/ledger.jsonl'),
  stubLedgerFile: path.join(stateRoot, '.sessions', 'stub-ledger.jsonl'),
  exec, registry, projectRoot, targetUrl: TARGET_URL, cdpPort: CDP_PORT,
  modelMode: STUB ? 'stub' : 'live',
  onChange: broadcast,
});
let connection = { reachable: false, url: TARGET_URL };
const snap = () => ({ ...sessions.snapshot(), connection, registry: { project: registry.project, page: registry.page, regions: Object.keys(registry.regions) }, now: new Date().toISOString() });
async function poll() {
  let reachable = false;
  try { reachable = (await fetch(TARGET_URL, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
  if (reachable !== connection.reachable) { connection = { reachable, url: TARGET_URL, since: new Date().toISOString() }; broadcast(); }
}
setInterval(poll, 3000);
await poll();
sessions.loadLatest();

// ---------- http ----------
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 8 * 1024 * 1024) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, WB_ORIGIN);
  const p = url.pathname;
  if (!p.startsWith('/api/')) return workbench.middlewares(req, res);
  try {
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, snap());
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snap())}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && p === '/api/commands') {
      const r = sessions.command(await readJson(req));
      broadcast();
      return send(res, r.ok === false ? (r.status || 409) : 200, r);
    }
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/files\/([\w-]+)\/([\w.-]+)$/))) {
      const f = sessions.binaryPath(m[1], m[2]);
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'image/jpeg', 'cache-control': 'max-age=3600' });
      return res.end(fs.readFileSync(f));
    }
    if (STUB && req.method === 'POST' && p === '/api/test/fault') {
      const { role, mode, ms, once } = await readJson(req);
      if (mode) sessions.stubControl.faults[role] = { mode, ms, once }; else delete sessions.stubControl.faults[role];
      return send(res, 200, { ok: true, faults: sessions.stubControl.faults });
    }
    if (STUB && req.method === 'POST' && p === '/api/test/control') {
      Object.assign(sessions.stubControl, await readJson(req));
      return send(res, 200, { ok: true });
    }
    // Stub mode only: really stop / start the target page server to check disconnect handling.
    if (STUB && req.method === 'POST' && p === '/api/test/target') {
      const { action } = await readJson(req);
      if (action === 'stop' && target) { await target.close(); target = null; }
      if (action === 'start' && !target) { target = await createVite(targetConfig()); await target.listen(); }
      await poll();
      return send(res, 200, { ok: true, running: !!target });
    }
    send(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${p}` } });
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, code: 'INTERNAL', message: String(e.message) });
  }
});
server.listen(WB_PORT, HOST, () => {
  console.log(`Workbench   ${WB_ORIGIN}   (${STUB ? 'STUB MODEL — exception checks only' : 'live model claude-sonnet-5-5'}; project ${projectRoot}; registry ${path.basename(registryFile)})`);
console.log(`Code        ${RUNNING.short}  (${RUNNING.files} server-side files, loaded ${RUNNING.startedAt}) — after editing them, restart; node checks/code-version.mjs compares this with the disk`);
  console.log(`Target page ${TARGET_URL}  (project root ${exec.root})`);
  console.log(`PID ${process.pid} · stop with Ctrl+C`);
});

const shutdown = async () => {
  for (const r of clients) r.end();
  server.close();
  await Promise.allSettled([target?.close(), workbench.close()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
