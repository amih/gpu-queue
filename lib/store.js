// What happened, kept on disk so the status page can show days and weeks, not just
// what is in memory since the last restart.
//   jobs.jsonl     one line per finished job
//   metrics.jsonl  one line per minute: averages of the machine's numbers
// Both are trimmed to `keepDays` when the service starts and once a day after.
import { readFileSync, writeFileSync, appendFile, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86_400_000;

function load(path, since, timeKey) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o[timeKey] >= since) out.push(o); } catch { /* torn line */ }
  }
  return out;
}

function rewrite(path, rows) {
  writeFileSync(`${path}.tmp`, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(`${path}.tmp`, path);
}

export function makeStore(dir, { keepDays = 30, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const jobsPath = join(dir, 'jobs.jsonl');
  const metricsPath = join(dir, 'metrics.jsonl');
  const cutoff = () => Date.now() - keepDays * DAY;

  // Oldest first in memory.
  let jobs = load(jobsPath, cutoff(), 'endedAt');
  let minutes = load(metricsPath, cutoff(), 't');
  const trim = () => {
    const c = cutoff();
    jobs = jobs.filter((j) => j.endedAt >= c);
    minutes = minutes.filter((m) => m.t >= c);
    try { rewrite(jobsPath, jobs); rewrite(metricsPath, minutes); } catch (e) { log(`store trim failed: ${e.message}`); }
  };
  trim();
  setInterval(trim, DAY).unref();
  log(`store: ${jobs.length} jobs, ${minutes.length} minutes of metrics loaded`);

  const append = (path, row) => appendFile(path, JSON.stringify(row) + '\n', (e) => e && log(`store write failed: ${e.message}`));

  return {
    addJob(j) { jobs.push(j); append(jobsPath, j); },
    addMinute(m) { minutes.push(m); append(metricsPath, m); },
    jobsSince: (t) => { let i = jobs.length; while (i > 0 && jobs[i - 1].endedAt >= t) i--; return jobs.slice(i); },
    minutesSince: (t) => { let i = minutes.length; while (i > 0 && minutes[i - 1].t >= t) i--; return minutes.slice(i); },
    recentJobs: (n) => jobs.slice(-n).reverse(),
  };
}
