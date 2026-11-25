// A --yield lease steps aside for more urgent work and gets the card back afterwards, with the three rules:
// minimum run, return slowly, and a cap on paused time (lib/scheduler.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A training run that obeys the lease's orders: on "yield" it frees the card, acks, waits for "run".
const TRAINER = `
const fs = require('fs'), path = require('path'); const d = process.env.GPU_LEASE_CTL, log = process.argv[1];
const st = () => { try { return fs.readFileSync(path.join(d, 'state'), 'utf8').trim(); } catch { return 'run'; } };
let paused = false; const end = Date.now() + Number(process.argv[2]);
const t = setInterval(() => {
  const s = st();
  if (s === 'yield' && !paused) { paused = true; fs.appendFileSync(log, 'yielded ' + Date.now() + '\\n'); fs.writeFileSync(path.join(d, 'ack'), 'yielded'); }
  if (s === 'run' && paused) { paused = false; fs.appendFileSync(log, 'resumed ' + Date.now() + '\\n'); fs.writeFileSync(path.join(d, 'ack'), 'running'); }
  if (Date.now() > end && !paused) { clearInterval(t); }
}, 50);`;

async function setup(extra) {
  const ollama = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      setTimeout(() => res.end(JSON.stringify({ response: 'ok' })), 200);
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'gpuq-yield-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    ollama: { url: `http://127.0.0.1:${ollama.address().port}`, concurrency: 2 }, comfy: { url: 'http://127.0.0.1:9' },
    graceSeconds: 0, yieldMinRunSeconds: 1, yieldReturnIdleSeconds: 1, yieldTimeoutSeconds: 5,
    clients: { reader: { priority: 'normal' }, trainer: { priority: 'background' }, other: { priority: 'normal' } }, ...extra,
  }));
  const PROXY = 39100 + Math.floor(Math.random() * 400);
  const STATUS = PROXY + 1;
  const server = spawn(process.execPath, [join(root, 'server.js')], {
    env: { ...process.env, PATH: '/nonexistent', GPUQ_CONFIG: join(dir, 'config.json'), GPUQ_STATE_DIR: dir,
      GPUQ_PROXY_PORT: String(PROXY), PORT: String(STATUS) }, stdio: 'ignore',
  });
  const status = async () => { for (;;) { try { return await fetch(`http://127.0.0.1:${STATUS}/api/status`).then((r) => r.json()); } catch { await sleep(100); } } };
  await status();
  const log = join(dir, 'trainer.log');
  writeFileSync(log, '');
  const lease = spawn(process.execPath, [join(root, 'bin/gpu-lease'), '-c', 'trainer', '-l', 'train', '--yield', '--',
    process.execPath, '-e', TRAINER, log, '12000'], { env: { ...process.env, GPU_QUEUE_URL: `http://127.0.0.1:${PROXY}` } });
  let err = ''; lease.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 100; i++) { if ((await status()).running.length) break; await sleep(50); }
  const ask = (client) => fetch(`http://127.0.0.1:${PROXY}/ollama/${client}/api/generate`, {
    method: 'POST', body: JSON.stringify({ model: 'vision', prompt: 'hi' }) }).then((r) => r.json());
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
  const stop = () => { lease.kill(); server.kill(); ollama.close(); };
  return { ask, status, events, stop, err: () => err };
}

test('a yieldable lease steps aside after its minimum run, then gets the card back after the idle wait', async () => {
  const t = await setup({});
  try {
    const t0 = Date.now();
    const r = await t.ask('reader');                       // arrives at once: waits for the 1 s minimum run
    const took = Date.now() - t0;
    assert.equal(r.response, 'ok');
    assert.ok(took >= 700 && took < 4000, `answered after the minimum run (${took} ms)`);
    let ev = t.events();
    assert.equal(ev[0][0], 'yielded');
    let s = await t.status();
    assert.equal(s.waiting[0]?.state, 'paused', 'the lease waits to come back');
    await sleep(1600);                                      // return-idle wait is 1 s
    ev = t.events();
    assert.deepEqual(ev.map((e) => e[0]), ['yielded', 'resumed'], t.err());
    s = await t.status();
    assert.equal(s.running[0]?.client, 'trainer');
    assert.equal(s.running[0]?.pauses, 1);
  } finally { t.stop(); }
});

test('a burst of requests costs one pause', async () => {
  const t = await setup({});
  try {
    await sleep(1100);
    await t.ask('reader');
    await sleep(300); await t.ask('reader');              // within the return-idle wait: no switch back in between
    await sleep(300); await t.ask('reader');
    await sleep(1600);
    assert.deepEqual(t.events().map((e) => e[0]), ['yielded', 'resumed']);
  } finally { t.stop(); }
});

test('the cap: after enough paused time only yieldAlways clients interrupt', async () => {
  const t = await setup({ yieldCapFraction: 0.0001, yieldAlways: ['reader'] });
  try {
    await sleep(1100);
    await t.ask('reader');                                   // first pause: allowed (reader is in yieldAlways anyway)
    await sleep(1600);                                       // back on the card
    await sleep(1100);                                       // past the minimum run again
    const other = t.ask('other');                           // capped: must wait for the lease to end
    const first = await Promise.race([other.then(() => 'answered'), sleep(1500).then(() => 'waiting')]);
    assert.equal(first, 'waiting');
    assert.deepEqual(t.events().map((e) => e[0]), ['yielded', 'resumed']);
    await t.ask('reader');                                   // a reader still gets it
    assert.equal(t.events().filter((e) => e[0] === 'yielded').length, 2);
    other.catch(() => {});
  } finally { t.stop(); }
});
