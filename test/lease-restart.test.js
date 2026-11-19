// gpu-lease survives a restart of the queue: the command keeps running and gets its
// lease back, with its first start time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a running lease reconnects after the queue restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpuq-restart-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ollama: { url: 'http://127.0.0.1:9' }, comfy: { url: 'http://127.0.0.1:9' } }));
  const PROXY = 39600 + Math.floor(Math.random() * 300);
  const STATUS = PROXY + 1;
  const start = () => spawn(process.execPath, [join(root, 'server.js')], {
    env: { ...process.env, PATH: '/nonexistent', GPUQ_CONFIG: join(dir, 'config.json'), GPUQ_STATE_DIR: dir,
      GPUQ_PROXY_PORT: String(PROXY), PORT: String(STATUS) }, stdio: 'ignore',
  });
  const status = async () => { for (;;) { try { return await fetch(`http://127.0.0.1:${STATUS}/api/status`).then((r) => r.json()); } catch { await sleep(100); } } };

  let server = start();
  await status();
  const lease = spawn(process.execPath, [join(root, 'bin/gpu-lease'), '-c', 'trainer', '-l', 'train', '--',
    process.execPath, '-e', 'setTimeout(() => {}, 6000)'], { env: { ...process.env, GPU_QUEUE_URL: `http://127.0.0.1:${PROXY}` } });
  let err = '';
  lease.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => lease.on('exit', r));
  let s;
  for (let i = 0; i < 100; i++) { s = await status(); if (s.running.length) break; await sleep(50); }
  const first = s.running[0];
  assert.equal(first.label, 'train');

  server.kill();
  await new Promise((r) => server.on('exit', r));
  await sleep(300);
  server = start();
  try {
    let back;
    for (let i = 0; i < 100; i++) { s = await status(); back = s.running[0]; if (back) break; await sleep(100); }
    assert.ok(back, `lease is back (${err})`);
    assert.equal(back.client, 'trainer');
    assert.equal(back.label, 'train');
    assert.ok(Math.abs(back.startedAt - first.startedAt) < 1000, 'keeps its first start time');
    assert.match(err, /lease restored/);
    assert.equal(await exited, 0, 'the command was never stopped');
    await sleep(200);
    assert.equal((await status()).running.length, 0, 'released when the command ends');
  } finally { server.kill(); lease.kill(); }
});
