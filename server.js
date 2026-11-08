// gpu-queue: one queue for every program that wants the one GPU.
// Two listeners, both on 127.0.0.1:
//   proxy  (GPUQ_PROXY_PORT, default 3890): what apps call instead of Ollama/ComfyUI
//   status (PORT, default 3891): the status page and its JSON; put it behind a login
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scheduler, PRIORITIES, prioIndex } from './lib/scheduler.js';
import { makeBackends } from './lib/backends.js';
import { makeProxy } from './lib/proxy.js';
import { gpuState, memoryWaiter } from './lib/gpu.js';

const here = dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const DEFAULTS = {
  ollama: { url: 'http://127.0.0.1:11434', concurrency: 4 },
  comfy: { url: 'http://127.0.0.1:8188', concurrency: 1 },
  // Seconds a job waits before moving up one level: [interactive, normal, background].
  ageStepSeconds: [0, 600, 600],
  // How long the model already on the card is preferred while others wait.
  batchSeconds: 300,
  // The card counts as empty below this much used memory (MiB).
  emptyMiB: 1200,
  historySize: 500,
  clients: {},
};

const configPath = process.env.GPUQ_CONFIG || join(here, 'config.json');
const fileCfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const cfg = {
  ...DEFAULTS, ...fileCfg,
  ollama: { ...DEFAULTS.ollama, ...fileCfg.ollama },
  comfy: { ...DEFAULTS.comfy, ...fileCfg.comfy },
};

// Changes made on the status page survive restarts.
const stateDir = process.env.GPUQ_STATE_DIR || join(here, 'data');
const statePath = join(stateDir, 'state.json');
let state = { clients: {}, paused: false };
try { state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* first run */ }
const saveState = () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${statePath}.tmp`, statePath);
};

const priorityOf = (client) => state.clients[client]?.priority || cfg.clients[client]?.priority || 'normal';

const backends = makeBackends(cfg);
const sched = new Scheduler({
  backends,
  waitForMemory: memoryWaiter(cfg.emptyMiB),
  settings: { ageStepSeconds: cfg.ageStepSeconds, batchSeconds: cfg.batchSeconds, historySize: cfg.historySize },
  log,
});
sched.paused = !!state.paused;
sched.on('change', () => {});
// Aging can change the order with no new event.
setInterval(() => sched.pump(), 5000).unref();

const { server: proxy } = makeProxy({ sched, backends, priorityOf, log });

// ---- status page ----
function clientStats() {
  const names = new Set([...Object.keys(cfg.clients), ...Object.keys(state.clients)]);
  const all = [...sched.history, ...sched.running.values(), ...sched.waiting];
  for (const j of all) names.add(j.client);
  return [...names].sort().map((name) => {
    const done = sched.history.filter((j) => j.client === name && j.startedAt);
    const waits = done.map((j) => (j.startedAt - j.queuedAt) / 1000).sort((a, b) => a - b);
    const pick = (q) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(q * waits.length))] : null);
    return {
      name, priority: priorityOf(name), note: cfg.clients[name]?.note ?? '',
      waiting: sched.waiting.filter((j) => j.client === name).length,
      running: [...sched.running.values()].filter((j) => j.client === name).length,
      recent: done.length, medianWait: pick(0.5), p95Wait: pick(0.95),
    };
  });
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 10_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve(null); } });
});

const page = readFileSync(join(here, 'public', 'index.html'));

const status = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      now: Date.now(), gpu: await gpuState(), ...sched.snapshot(), clients: clientStats(),
      priorities: PRIORITIES, settings: { ageStepSeconds: cfg.ageStepSeconds, batchSeconds: cfg.batchSeconds },
    });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    // JSON only: a plain cross-site form cannot send this content type.
    if (!String(req.headers['content-type']).startsWith('application/json')) return sendJson(res, 415, { error: 'JSON only' });
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: 'bad JSON' });
    let m;
    if (url.pathname === '/api/pause') {
      sched.setPaused(!!body.on);
      state.paused = !!body.on;
      saveState();
      log(`queue ${body.on ? 'paused' : 'resumed'} from the status page`);
      return sendJson(res, 200, { ok: true });
    }
    if ((m = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(cancel|priority)$/))) {
      const ok = m[2] === 'cancel' ? sched.cancel(m[1], 'cancelled on the status page') : sched.setJobPriority(m[1], body.priority);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if ((m = url.pathname.match(/^\/api\/clients\/([\w.-]+)\/priority$/))) {
      if (prioIndex(body.priority) == null) return sendJson(res, 400, { error: 'unknown priority' });
      state.clients[m[1]] = { ...state.clients[m[1]], priority: body.priority };
      saveState();
      log(`client ${m[1]} -> ${body.priority}`);
      return sendJson(res, 200, { ok: true });
    }
  }
  sendJson(res, 404, { error: 'not found' });
});

const proxyPort = Number(process.env.GPUQ_PROXY_PORT || 3890);
const statusPort = Number(process.env.PORT || 3891);
const host = process.env.GPUQ_HOST || '127.0.0.1';
proxy.listen(proxyPort, host, () => log(`proxy on ${host}:${proxyPort}`));
status.listen(statusPort, host, () => log(`status page on ${host}:${statusPort}`));
