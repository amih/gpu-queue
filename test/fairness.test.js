// A background job must not wait forever behind a steady stream of higher-priority work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../lib/scheduler.js';

test('aged background job beats a stream of interactive work from the model on the card', async () => {
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const sched = new Scheduler({
      backends: { ollama: { concurrency: 1, evict: async () => {} } },
      waitForMemory: async () => true,
      settings: { ageStepSeconds: [0, 600, 600], batchSeconds: 300, graceSeconds: 30, historySize: 50 },
    });
    const flush = () => new Promise((r) => setImmediate(r));
    // A chat program keeps its model busy without a gap: each request arrives before the last one ends.
    let chat = sched.enqueue({ client: 'chat', priority: 'interactive', backend: 'ollama', group: 'ollama:chat' });
    await flush();
    const bg = sched.enqueue({ client: 'embed', priority: 'background', backend: 'ollama', group: 'ollama:embed' });
    for (let s = 0; s < 3600 && bg.state === 'queued'; s += 6) {
      now += 5000;
      // The next request is already waiting when the current one ends.
      const next = sched.enqueue({ client: 'chat', priority: 'interactive', backend: 'ollama', group: 'ollama:chat' });
      await flush();
      now += 1000;
      if (chat.state === 'running') sched.finish(chat, 'done');
      for (let i = 0; i < 5; i++) await flush();
      if (bg.state === 'running') break;
      chat = next.state === 'running' ? next : chat;
      if (next.state === 'queued') sched.cancel(next.id);
    }
    assert.equal(bg.state, 'running', `background job still waiting after ${now / 1000} s`);
    console.log(`background job started after ${now / 1000} s`);
    // Two aging steps (20 min) plus at most one batch window (5 min) and a job.
    assert.ok(now <= (1200 + 300 + 10) * 1000, `waited ${now / 1000} s`);
  } finally { Date.now = realNow; }
});
