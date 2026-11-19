import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestDay, startOf, nextDate, dateOf, makeDaily, digestFinishedDays } from '../lib/daily.js';

const day = '2026-11-18';
const t0 = startOf(day);
const H = 3600e3;

test('dates step over a day in the server time zone', () => {
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
  assert.equal(dateOf(startOf(day)), day);
  assert.equal(dateOf(startOf(nextDate(day)) - 1), day);
});

test('a day: card hours, busy hours, energy, idle and working power', () => {
  // 2 hours recorded: 1 hour idle at 10 W, 1 hour at 100% and 150 W. One minute from the next day is ignored.
  const minutes = [];
  for (let i = 0; i < 60; i++) minutes.push({ t: t0 + i * 60e3, gpu: 0, power: 10 });
  for (let i = 60; i < 120; i++) minutes.push({ t: t0 + i * 60e3, gpu: 100, power: 150 });
  minutes.push({ t: startOf(nextDate(day)), gpu: 100, power: 999 });
  const jobs = [
    { client: 'books', startedAt: t0 + H, endedAt: t0 + 1.5 * H, state: 'done', group: 'a' },
    { client: 'books', startedAt: t0 + 1.25 * H, endedAt: t0 + 2 * H, state: 'failed', group: 'a' },
    // Started the day before: only its part inside the day counts.
    { client: 'lab', startedAt: t0 - 5 * H, endedAt: t0 + 0.5 * H, state: 'done', group: 'b' },
  ];
  const d = digestDay(day, minutes, jobs, [{ client: 'night', startedAt: startOf(nextDate(day)) - 0.25 * H, group: 'c' }]);
  assert.equal(d.recordedMinutes, 120);
  assert.equal(d.gpuHours, 1.75);
  assert.equal(d.busyHours, 1);
  assert.equal(d.energyKWh, 0.16);
  assert.equal(d.avgW, 80);
  assert.equal(d.idleW, 10);
  assert.equal(d.loadW, 150);
  assert.equal(d.peakW, 150);
  assert.equal(d.jobs, 3);
  assert.equal(d.failed, 1);
  assert.deepEqual(d.clients.books, { jobs: 2, gpuHours: 1 });
  assert.deepEqual(d.clients.lab, { jobs: 1, gpuHours: 0.5 });
  assert.deepEqual(d.clients.night, { jobs: 0, gpuHours: 0.25 });
});

test('finished days are written once and kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpuq-daily-'));
  const minutes = [{ t: t0 + 60e3, gpu: 50, power: 60 }, { t: startOf(nextDate(day)) + 60e3, gpu: 50, power: 60 }];
  const store = { minutesSince: (t) => minutes.filter((m) => m.t >= t), jobsSince: () => [] };
  const daily = makeDaily(dir);
  const now = startOf(nextDate(nextDate(day))) + H;
  assert.equal(digestFinishedDays({ store, daily, now }), 2);
  assert.equal(digestFinishedDays({ store, daily, now }), 0);
  assert.deepEqual(daily.all().map((d) => d.date), [day, nextDate(day)]);
  return new Promise((r) => setTimeout(r, 50)).then(() => {
    assert.equal(makeDaily(dir).all().length, 2, 'read back from disk');
  });
});
