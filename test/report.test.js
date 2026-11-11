import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeline, stats } from '../lib/report.js';

const job = (i, o = {}) => ({ id: `j${i}`, client: 'books', label: 'qwen /api/generate', state: 'done', priority: 'normal',
  queuedAt: i * 1000, startedAt: i * 1000 + 100, endedAt: i * 1000 + 600, group: 'ollama:qwen', ...o });

test('runs of alike jobs fold into one line', () => {
  const jobs = [job(9), job(8), job(7), job(6, { client: 'web' }), job(5), job(4), job(3, { label: 'img 512x512' }), job(2, { label: 'img 768x768' }), job(1, { label: 'img 1024x1024' })];
  const { lines, more } = timeline(jobs, 10);
  assert.equal(lines.length, 5);
  assert.equal(lines[0].folded, true);
  assert.equal(lines[0].count, 3);
  assert.equal(lines[0].firstEndedAt, 7600);
  assert.equal(lines[1].client, 'web');
  assert.ok(!lines[2].folded, 'a run of two stays two lines');
  assert.equal(lines[4].count, 3, 'numbers in the label do not split a run');
  assert.equal(more, false);
  assert.equal(timeline(jobs, 2).more, true);
  const mixed = timeline([job(3), job(2, { state: 'failed' }), job(1)], 10).lines;
  assert.equal(mixed.length, 1, 'a failure inside a run does not split it');
  assert.equal(mixed[0].failed, 1);
});

test('stats count the card once when jobs overlap', () => {
  const jobs = [job(1, { startedAt: 1000, endedAt: 3000 }), job(2, { startedAt: 2000, endedAt: 4000 }),
    job(3, { client: 'web', group: 'comfy', startedAt: 5000, endedAt: 6000, state: 'failed' })];
  const s = stats(jobs, [], 0, 10_000);
  assert.equal(s.totals.heldSeconds, 4);
  assert.equal(s.totals.switches, 1);
  assert.equal(s.totals.failed, 1);
  assert.equal(s.clients.find((c) => c.name === 'books').heldSeconds, 3);
});
