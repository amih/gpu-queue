// The machine's numbers every 10 seconds: graphics card (busy, memory, heat, power),
// processor, memory, load, and the queue itself. The last hour is kept as is; older
// data is kept as one-minute averages in the store.
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { gpuState } from './gpu.js';

export const FIELDS = ['gpu', 'vram', 'temp', 'power', 'cpu', 'ram', 'load', 'wait', 'run'];
const SAMPLE_MS = 10_000;
const MIN = 60_000;

let lastCpu = null;
function cpuPercent() {
  try {
    const [, ...v] = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    const prev = lastCpu;
    lastCpu = { idle, total };
    if (!prev || total === prev.total) return null;
    return 100 * (1 - (idle - prev.idle) / (total - prev.total));
  } catch { return null; }
}

function memory() {
  try {
    const m = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map((l) => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((x) => [x[1], Number(x[2])]));
    return { usedGB: (m.MemTotal - m.MemAvailable) / 1048576, totalGB: m.MemTotal / 1048576 };
  } catch { return null; }
}

function loadAvg() {
  try { return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return null; }
}

const round = (x, d = 1) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function average(rows, t) {
  const out = { t };
  for (const f of FIELDS) {
    const v = rows.map((r) => r[f]).filter((x) => x != null);
    out[f] = v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  }
  return out;
}

// One point per step from `from` to now; an empty step is null, so the line breaks there.
function bucket(rows, from, step, now) {
  const out = [];
  let i = 0;
  for (let t = from; t < now; t += step) {
    const inside = [];
    while (i < rows.length && rows[i].t < t + step) { if (rows[i].t >= t) inside.push(rows[i]); i++; }
    out.push(inside.length ? average(inside, t) : { t });
  }
  return out;
}

export const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const STEPS = { '1h': SAMPLE_MS, '6h': MIN, '24h': 5 * MIN, '7d': 30 * MIN, '30d': 120 * MIN };

export function startMetrics({ store, sched }) {
  const recent = [];          // raw samples, last hour and a bit
  let minute = [];
  const info = { cpus: cpus().length, ramGB: null, vramGB: null, gpuName: null };

  async function sample() {
    const g = await gpuState();
    const mem = memory();
    if (mem) info.ramGB = round(mem.totalGB);
    if (g) { info.vramGB = round(g.totalMiB / 1024); info.gpuName = g.name; }
    const s = {
      t: Date.now(),
      gpu: g?.util ?? null, vram: g ? round(g.usedMiB / 1024, 2) : null, temp: g?.tempC ?? null, power: g?.powerW ?? null,
      cpu: round(cpuPercent()), ram: round(mem?.usedGB), load: round(loadAvg(), 2),
      wait: sched.waiting.length, run: sched.running.size,
    };
    recent.push(s);
    while (recent.length && recent[0].t < s.t - 3700e3) recent.shift();
    if (minute.length && Math.floor(minute[0].t / MIN) !== Math.floor(s.t / MIN)) {
      store.addMinute(average(minute, Math.floor(minute[0].t / MIN) * MIN));
      minute = [];
    }
    minute.push(s);
  }
  cpuPercent();
  sample();
  setInterval(sample, SAMPLE_MS).unref();

  return {
    info,
    series(range) {
      const span = RANGES[range] ?? RANGES['24h'];
      const step = STEPS[range] ?? STEPS['24h'];
      const now = Date.now();
      const from = Math.floor((now - span) / step) * step;
      const rows = range === '1h' ? recent : [...store.minutesSince(from), ...(minute.length ? [average(minute, now)] : [])];
      return { from, to: now, step, info, points: bucket(rows, from, step, now) };
    },
  };
}
