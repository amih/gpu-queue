// How to empty the card for each backend, and how to tell its jobs apart.
const json = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? 15_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
};

export function makeBackends(cfg) {
  const ollama = cfg.ollama.url.replace(/\/$/, '');
  const comfy = cfg.comfy.url.replace(/\/$/, '');
  return {
    ollama: {
      url: ollama,
      concurrency: cfg.ollama.concurrency,
      // Unloads every model Ollama holds.
      async evict() {
        const { models = [] } = await json(`${ollama}/api/ps`);
        for (const m of models) {
          await json(`${ollama}/api/generate`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }), timeout: 60_000,
          });
        }
      },
    },
    comfy: {
      url: comfy,
      concurrency: cfg.comfy.concurrency,
      async evict() {
        await json(`${comfy}/free`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        }).catch((e) => { if (!/ECONNREFUSED|fetch failed/.test(String(e.cause ?? e))) throw e; });
      },
      /** True while ComfyUI still has this prompt queued or running. */
      async busy(promptId) {
        const q = await json(`${comfy}/queue`);
        const ids = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].map((item) => item[1]);
        return ids.includes(promptId);
      },
    },
    // A command started with bin/gpu-lease. It frees its own memory when it exits.
    lease: { concurrency: 1 },
  };
}

// Ollama paths that load a model onto the card.
const OLLAMA_GPU_PATHS = new Set(['/api/generate', '/api/chat', '/api/embed', '/api/embeddings',
  '/v1/chat/completions', '/v1/completions', '/v1/embeddings']);

/**
 * Null when the request does not need the card (listing models, unloading one, a model
 * forced onto the CPU); otherwise the model name.
 */
export function ollamaModel(path, body) {
  if (!OLLAMA_GPU_PATHS.has(path) || !body?.model) return null;
  const noWork = body.prompt == null && body.messages == null && body.input == null;
  if (path === '/api/generate' && noWork && (body.keep_alive === 0 || body.keep_alive === '0')) return null;
  if (body.options?.num_gpu === 0) return null;
  return String(body.model);
}
