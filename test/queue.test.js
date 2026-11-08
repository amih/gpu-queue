// End-to-end: a fake Ollama and a fake ComfyUI behind a real gpu-queue.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];       // what the fake backends saw, in order
let comfyQueue = [];     // prompt ids ComfyUI is "working on"

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s ? JSON.parse(s) : {})); });

let ollama, comfy, proc, PROXY, STATUS;

before(async () => {
  ollama = await listen(async (req, res) => {
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'vision' }] }));
    const b = await body(req);
    if (b.keep_alive === 0 && b.prompt == null) { events.push(`ollama unload ${b.model}`); return res.end('{}'); }
    events.push(`ollama start ${b.model} ${b.prompt}`);
    await sleep(b.ms ?? 200);
    events.push(`ollama end ${b.model} ${b.prompt}`);
    res.end(JSON.stringify({ response: 'ok' }));
  });
  comfy = await listen(async (req, res) => {
    if (req.url === '/free') { await body(req); events.push('comfy free'); return res.end('{}'); }
    if (req.url === '/queue' && req.method === 'GET') {
      return res.end(JSON.stringify({ queue_running: comfyQueue.map((id) => [0, id]), queue_pending: [] }));
    }
    if (req.url === '/prompt') {
      const b = await body(req);
      events.push(`comfy start ${b.prompt.tag}`);
      comfyQueue.push(b.prompt_id);
      setTimeout(() => { comfyQueue = comfyQueue.filter((x) => x !== b.prompt_id); events.push(`comfy end ${b.prompt.tag}`); }, 600);
      return res.end(JSON.stringify({ prompt_id: b.prompt_id, number: 1 }));
    }
    if (req.url.startsWith('/history/')) return res.end('{}');
    res.end('{}');
  });
  const dir = mkdtempSync(join(tmpdir(), 'gpuq-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    ollama: { url: `http://127.0.0.1:${ollama.address().port}`, concurrency: 2 },
    comfy: { url: `http://127.0.0.1:${comfy.address().port}`, concurrency: 1 },
    clients: { web: { priority: 'interactive' }, batch: { priority: 'normal' }, bulk: { priority: 'background' } },
  }));
  PROXY = 39000 + Math.floor(Math.random() * 500);
  STATUS = PROXY + 1;
  proc = spawn(process.execPath, [join(root, 'server.js')], {
    env: { ...process.env, PATH: '/nonexistent', GPUQ_CONFIG: join(dir, 'config.json'), GPUQ_STATE_DIR: dir,
      GPUQ_PROXY_PORT: String(PROXY), PORT: String(STATUS) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.on('data', (d) => { if (/status page/.test(d)) resolve(); }));
});

after(() => { proc?.kill(); ollama?.close(); comfy?.close(); });

const gen = (client, model, prompt, ms) => fetch(`http://127.0.0.1:${PROXY}/ollama/${client}/api/generate`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, ms }),
}).then((r) => r.json());

test('Ollama requests of one model share the card; ComfyUI waits and the card is freed between', async () => {
  events.length = 0;
  const a = gen('batch', 'vision', 'a', 400);
  const b = gen('batch', 'vision', 'b', 400);
  await sleep(50);
  const p = await fetch(`http://127.0.0.1:${PROXY}/comfy/bulk/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: { tag: 'img' } }),
  }).then((r) => r.json());
  assert.match(p.prompt_id, /^[0-9a-f-]{36}$/);
  // Held by the queue: ComfyUI has not seen it, history is empty like a pending prompt.
  assert.deepEqual(await fetch(`http://127.0.0.1:${PROXY}/comfy/bulk/history/${p.prompt_id}`).then((r) => r.json()), {});
  await Promise.all([a, b]);
  await sleep(1800);
  const i = (e) => events.indexOf(e);
  assert.ok(i('ollama start vision a') < i('ollama end vision a'));
  assert.ok(i('ollama start vision b') < i('ollama end vision a'), 'same model ran side by side');
  assert.ok(i('ollama unload vision') > i('ollama end vision b'), 'unloaded after both finished');
  assert.ok(i('comfy start img') > i('ollama unload vision'), 'ComfyUI started after the unload');
  assert.ok(i('comfy end img') > 0);
});

test('higher priority goes first; background is not started while others wait', async () => {
  events.length = 0;
  const lock = gen('batch', 'vision', 'hold', 500);    // card busy with "vision"
  await sleep(50);
  const bulk = gen('bulk', 'embed', 'bg', 50);
  await sleep(20);
  const web = gen('web', 'chat', 'fg', 50);
  await Promise.all([lock, bulk, web]);
  const i = (e) => events.indexOf(e);
  assert.ok(i('ollama start chat fg') < i('ollama start embed bg'), events.join('\n'));
});

test('a lease waits for running work and holds the card until released', async () => {
  events.length = 0;
  const lock = gen('batch', 'vision', 'x', 400);
  await sleep(50);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PROXY}/lease?client=upscaler`, { method: 'POST', signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!/granted/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(Date.now() - t0 >= 300, 'waited for the running request');
  assert.ok(events.includes('ollama end vision x'));
  const later = gen('web', 'chat', 'after', 10);
  await sleep(300);
  assert.ok(!events.includes('ollama start chat after'), 'nothing runs during a lease');
  ctrl.abort();
  await later;
  assert.ok(events.includes('ollama end chat after'));
});

test('gpu-lease runs the command once granted and passes its exit code', async () => {
  const run = (cmd) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, 'bin/gpu-lease'), '-c', 'cli', '--', ...cmd],
      { env: { ...process.env, GPU_QUEUE_URL: `http://127.0.0.1:${PROXY}` } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  const ok = await run(['/bin/echo', 'hello']);
  assert.equal(ok.code, 0);
  assert.equal(ok.out.trim(), 'hello');
  assert.equal((await run(['/bin/sh', '-c', 'exit 3'])).code, 3);
  await sleep(100);
  const s = await fetch(`http://127.0.0.1:${STATUS}/api/status`).then((r) => r.json());
  assert.equal(s.running.length, 0, 'lease released');
});

test('status page reports and changes priorities', async () => {
  const s = await fetch(`http://127.0.0.1:${STATUS}/api/status`).then((r) => r.json());
  assert.ok(s.history.length >= 5);
  assert.ok(s.clients.find((c) => c.name === 'web').priority === 'interactive');
  const bad = await fetch(`http://127.0.0.1:${STATUS}/api/clients/web/priority`, { method: 'POST', body: '{"priority":"background"}' });
  assert.equal(bad.status, 415);
  await fetch(`http://127.0.0.1:${STATUS}/api/clients/web/priority`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"priority":"background"}' });
  const s2 = await fetch(`http://127.0.0.1:${STATUS}/api/status`).then((r) => r.json());
  assert.equal(s2.clients.find((c) => c.name === 'web').priority, 'background');
});
