// One line per day, kept for good: how many hours the card worked and how much power it
// drew. The minute averages and the job history are trimmed after `keepDays`; this file
// is not, so months and years can be compared.
//   daily.jsonl  one line per finished local day (the server's time zone)
import { readFileSync, appendFile, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stats } from './report.js';

const MIN = 60_000;
const pad = (n) => String(n).padStart(2, '0');

/** The local date of a time, as YYYY-MM-DD. */
export const dateOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Local midnight at the start of a date. */
export const startOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
/** The next date (safe across clock changes). */
export const nextDate = (date) => { const [y, m, d] = date.split('-').map(Number); return dateOf(new Date(y, m - 1, d + 1, 12).getTime()); };

const r = (x, d) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

// Below this the card counts as idle, at or above this as working hard (percent busy).
const IDLE_BELOW = 5;
const LOAD_FROM = 80;

/**
 * @param {string} date YYYY-MM-DD
 * @param {object[]} minutes one-minute averages ({ t, gpu, power, ... }) covering the day
 * @param {object[]} jobs finished jobs that may overlap the day
 * @param {object[]} running jobs still running (no endedAt)
 */
export function digestDay(date, minutes, jobs, running = []) {
  const from = startOf(date);
  const to = startOf(nextDate(date));
  const ms = minutes.filter((m) => m.t >= from && m.t < to);
  const watts = ms.map((m) => m.power).filter((v) => v != null);
  const busy = ms.map((m) => m.gpu).filter((v) => v != null);

  const overlapping = jobs.filter((j) => j.startedAt && j.startedAt < to && j.endedAt >= from);
  const s = stats(overlapping, running.filter((j) => j.startedAt && j.startedAt < to).map((j) => ({ ...j, endedAt: null })), from, to);
  const ended = jobs.filter((j) => j.endedAt >= from && j.endedAt < to);
  const clients = {};
  for (const c of s.clients) {
    const n = ended.filter((j) => j.client === c.name).length;
    if (n || c.heldSeconds) clients[c.name] = { jobs: n, gpuHours: r(c.heldSeconds / 3600, 2) };
  }

  return {
    date,
    recordedMinutes: ms.length,
    dayMinutes: Math.round((to - from) / MIN),
    // Hours some program held the card through the queue (overlaps counted once).
    gpuHours: r(s.totals.heldSeconds / 3600, 2),
    // Hours of full work: each minute counts by how busy the card was.
    busyHours: r(busy.reduce((a, b) => a + b, 0) / 100 / 60, 2),
    // Energy drawn by the card alone, over the recorded minutes.
    energyKWh: r(watts.reduce((a, b) => a + b, 0) / 60 / 1000, 3),
    avgW: r(mean(watts), 1),
    idleW: r(median(ms.filter((m) => m.gpu != null && m.gpu < IDLE_BELOW && m.power != null).map((m) => m.power)), 1),
    loadW: r(mean(ms.filter((m) => m.gpu != null && m.gpu >= LOAD_FROM && m.power != null).map((m) => m.power)), 1),
    peakW: watts.length ? r(Math.max(...watts), 1) : null,
    avgBusy: r(mean(busy), 1),
    jobs: ended.length,
    failed: ended.filter((j) => j.state === 'failed').length,
    clients,
  };
}

export function makeDaily(dir, { log = () => {} } = {}) {
  const path = join(dir, 'daily.jsonl');
  const days = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try { days.push(JSON.parse(line)); } catch { /* torn line */ }
    }
  }
  const have = new Set(days.map((d) => d.date));
  return {
    has: (date) => have.has(date),
    add(row) {
      if (have.has(row.date)) return;
      have.add(row.date);
      days.push(row);
      days.sort((a, b) => a.date.localeCompare(b.date));
      appendFile(path, JSON.stringify(row) + '\n', (e) => e && log(`daily write failed: ${e.message}`));
    },
    all: () => days,
  };
}

/**
 * Writes a line for every finished day that has data and no line yet. A day is written
 * once it has ended, from the minute averages and jobs still on disk.
 */
export function digestFinishedDays({ store, daily, sched, now = Date.now(), log = () => {} }) {
  const first = store.minutesSince(0)[0];
  if (!first) return 0;
  const today = dateOf(now);
  let n = 0;
  for (let date = dateOf(first.t); date < today; date = nextDate(date)) {
    if (daily.has(date)) continue;
    const from = startOf(date);
    const row = digestDay(date, store.minutesSince(from), store.jobsSince(from), [...(sched?.running?.values?.() ?? [])]);
    daily.add(row);
    n++;
    log(`daily: ${date} gpu ${row.gpuHours} h, busy ${row.busyHours} h, ${row.energyKWh} kWh, ${row.recordedMinutes} min recorded`);
  }
  return n;
}
