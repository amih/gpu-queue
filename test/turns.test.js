// Two programs at the same priority, each sending one request at a time to a different model, take turns
// in batches (holdSeconds / turnSeconds) instead of swapping the card, and reloading a model, after every request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(extra) {
  const ollama = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      setTimeout(() => res.end(JSON.stringify({ response: 'ok' })), 100);
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'gpuq-turns-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    ollama: { url: `http://127.0.0.1:${ollama.address().port}`, concurrency: 4 }, comfy: { url: 'http://127.0.0.1:9' },
    graceSeconds: 0, clients: { a: { priority: 'normal' }, b: { priority: 'normal' } }, ...extra,
  }));
  const PROXY = 39600 + Math.floor(Math.random() * 300);
  const STATUS = PROXY + 1;
  const server = spawn(process.execPath, [join(root, 'server.js')], {
    env: { ...process.env, PATH: '/nonexistent', GPUQ_CONFIG: join(dir, 'config.json'), GPUQ_STATE_DIR: dir,
      GPUQ_PROXY_PORT: String(PROXY), PORT: String(STATUS) }, stdio: 'ignore',
  });
  const status = async () => { for (;;) { try { return await fetch(`http://127.0.0.1:${STATUS}/api/status?lines=100`).then((r) => r.json()); } catch { await sleep(100); } } };
  await status();
  const ask = (client, model) => fetch(`http://127.0.0.1:${PROXY}/ollama/${client}/api/generate`, {
    method: 'POST', body: JSON.stringify({ model, prompt: 'hi' }) }).then((r) => r.json());
  const loop = async (client, model, n) => { for (let i = 0; i < n; i++) await ask(client, model); };
  await Promise.all([loop('a', 'model-a', 8), loop('b', 'model-b', 8)]);
  await sleep(300);
  const lines = (await status()).history.filter((j) => j.startedAt).sort((x, y) => x.startedAt - y.startedAt);
  server.kill(); ollama.close();
  let swaps = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].group !== lines[i - 1].group) swaps++;
  return { swaps, n: lines.length };
}

test('without a hold, two one-at-a-time programs swap the card after almost every request', async () => {
  const { swaps, n } = await run({ holdSeconds: 0 });
  assert.equal(n, 16);
  assert.ok(swaps >= 10, `swaps ${swaps}`);
});

test('with a hold, they take turns in batches', async () => {
  const { swaps, n } = await run({ holdSeconds: 0.5, turnSeconds: 60 });
  assert.equal(n, 16);
  assert.ok(swaps <= 2, `swaps ${swaps}`);
});

test('a turn ends after turnSeconds even while the program on the card keeps sending', async () => {
  const { swaps } = await run({ holdSeconds: 0.5, turnSeconds: 0.5 });
  assert.ok(swaps >= 3, `swaps ${swaps}`);
});
