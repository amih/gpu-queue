// The local port that apps call instead of Ollama and ComfyUI.
//
//   /ollama/<client>/...   -> Ollama     (e.g. OLLAMA_URL=http://127.0.0.1:3890/ollama/myapp)
//   /comfy/<client>/...    -> ComfyUI    (e.g. COMFY_URL=http://127.0.0.1:3890/comfy/myapp)
//   POST /lease?client=..  -> holds the card for any other program (bin/gpu-lease)
//
// The client name picks the priority (config, or the status page); an
// X-GPU-Priority header on a request overrides it.
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ollamaModel } from './backends.js';

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const parseJson = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };

const send = (res, status, body) => {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Sends the request on to `base` and streams the answer back. Resolves when done. */
function forward(base, path, req, res, body) {
  return new Promise((resolve) => {
    const url = new URL(path, base);
    const headers = { ...req.headers, host: url.host };
    delete headers['x-gpu-priority'];
    if (body) headers['content-length'] = String(body.length);
    const up = http.request(url, { method: req.method, headers }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      upRes.on('end', () => resolve(upRes.statusCode));
      upRes.on('error', () => resolve(502));
    });
    up.on('error', (e) => { send(res, 502, { error: `gpu-queue: ${e.message}` }); resolve(502); });
    // The caller gave up: stop the work upstream too.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); resolve(499); });
    if (body) up.end(body); else req.pipe(up);
  });
}

export function makeProxy({ sched, backends, priorityOf, log }) {
  // Prompts accepted from callers but not yet handed to ComfyUI, and those that failed
  // before ComfyUI saw them (shown to callers as ComfyUI history entries).
  const comfyHeld = new Map();
  const comfyFailed = new Map();

  const priorityFor = (req, client) => req.headers['x-gpu-priority'] || priorityOf(client);

  async function viaQueue(req, res, { client, backend, group, label }, run) {
    const job = sched.enqueue({ client, backend, group, label, priority: priorityFor(req, client) });
    const gaveUp = () => { if (job.state === 'queued') sched.cancel(job.id, 'caller gave up'); };
    res.on('close', gaveUp);
    try { await job.started; } catch (e) { return send(res, 503, { error: `gpu-queue: ${e.message}` }); }
    res.off('close', gaveUp);
    let outcome = 'done';
    try { const status = await run(); if (status >= 400) outcome = status === 499 ? 'gave up' : 'failed'; }
    catch { outcome = 'failed'; }
    sched.finish(job, outcome);
  }

  async function ollama(req, res, client, rest) {
    const path = rest.split('?')[0];
    if (req.method !== 'POST') return forward(backends.ollama.url, rest, req, res);
    const body = await readBody(req);
    const model = ollamaModel(path, parseJson(body));
    if (!model) return forward(backends.ollama.url, rest, req, res, body);
    return viaQueue(req, res, { client, backend: 'ollama', group: `ollama:${model}`, label: `${model} ${path}` },
      () => forward(backends.ollama.url, rest, req, res, body));
  }

  async function comfyPrompt(req, res, client) {
    const body = await readBody(req);
    const data = parseJson(body);
    if (!data?.prompt) return send(res, 400, { error: 'gpu-queue: no prompt' });
    const promptId = data.prompt_id || randomUUID();
    data.prompt_id = promptId;
    const job = sched.enqueue({ client, backend: 'comfy', group: 'comfy', label: 'ComfyUI prompt',
      priority: priorityFor(req, client) });
    comfyHeld.set(promptId, job);
    // Answer at once, as ComfyUI does; the caller then polls /history.
    send(res, 200, { prompt_id: promptId, number: 0, node_errors: {} });

    const fail = (message) => {
      comfyFailed.set(promptId, { status: { status_str: 'error', completed: false,
        messages: [['execution_error', { exception_message: message }]] }, outputs: {} });
      setTimeout(() => comfyFailed.delete(promptId), 3600_000).unref();
    };
    try { await job.started; } catch (e) { comfyHeld.delete(promptId); return fail(`gpu-queue: ${e.message}`); }
    comfyHeld.delete(promptId);
    let outcome = 'done';
    try {
      const r = await fetch(`${backends.comfy.url}/prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) { outcome = 'failed'; fail(`ComfyUI refused the prompt: ${(await r.text()).slice(0, 300)}`); }
      else {
        // Hold the card until ComfyUI is done with it.
        await new Promise((r2) => setTimeout(r2, 500));
        let misses = 0;
        for (;;) {
          let busy;
          try { busy = await backends.comfy.busy(promptId); misses = 0; }
          catch { if (++misses > 30) break; busy = true; }
          if (!busy) break;
          await new Promise((r2) => setTimeout(r2, 1000));
        }
      }
    } catch (e) { outcome = 'failed'; fail(`gpu-queue: ${e.message}`); }
    sched.finish(job, outcome);
  }

  async function comfy(req, res, client, rest) {
    const path = rest.split('?')[0];
    if (req.method === 'POST' && path === '/prompt') return comfyPrompt(req, res, client);
    const m = path.match(/^\/history\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      if (comfyHeld.has(m[1])) return send(res, 200, {});
      if (comfyFailed.has(m[1])) return send(res, 200, { [m[1]]: comfyFailed.get(m[1]) });
    }
    if (req.method === 'POST' && path === '/queue') {
      const body = await readBody(req);
      for (const id of parseJson(body)?.delete ?? []) {
        const job = comfyHeld.get(id);
        if (job) sched.cancel(job.id, 'caller cancelled');
      }
      return forward(backends.comfy.url, rest, req, res, body);
    }
    return forward(backends.comfy.url, rest, req, res);
  }

  // The connection is the lease: the card is held until the caller hangs up.
  async function lease(req, res, url) {
    const name = url.searchParams.get('client') || '';
    const client = /^[\w.-]{1,40}$/.test(name) ? name : 'lease';
    const label = (url.searchParams.get('label') || client).slice(0, 120);
    const priority = url.searchParams.get('priority') || priorityOf(client);
    const job = sched.enqueue({ client, backend: 'lease', group: `lease:${client}`, label, priority });
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.write(`queued ${job.id}\n`);
    const beat = setInterval(() => res.write('.\n'), 15_000);
    let done = false;
    res.on('close', () => {
      clearInterval(beat);
      done = true;
      if (job.state === 'queued') sched.cancel(job.id, 'caller gave up');
      else if (job.state === 'running') sched.finish(job, 'done');
    });
    try { await job.started; } catch (e) { if (!done) res.end(`refused ${e.message}\n`); return; }
    if (!done) res.write(`granted ${job.id}\n`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const m = url.pathname.match(/^\/(ollama|comfy)\/([\w.-]+)(\/.*)?$/);
      if (m) {
        const rest = (m[3] || '/') + url.search;
        return await (m[1] === 'ollama' ? ollama : comfy)(req, res, m[2], rest);
      }
      if (req.method === 'POST' && url.pathname === '/lease') return await lease(req, res, url);
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      send(res, 404, { error: 'gpu-queue: use /ollama/<client>/..., /comfy/<client>/... or POST /lease' });
    } catch (e) {
      log(`proxy: ${e.stack || e}`);
      send(res, 500, { error: `gpu-queue: ${e.message}` });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  // ComfyUI's live progress socket goes straight through.
  server.on('upgrade', (req, socket, head) => {
    const m = req.url.match(/^\/comfy\/[\w.-]+(\/.*)$/);
    if (!m) return socket.destroy();
    const target = new URL(backends.comfy.url);
    const up = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${m[1]} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  return { server, comfyHeld };
}
