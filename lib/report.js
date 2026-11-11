// Finished jobs, read two ways for the status page:
//   timeline(): newest first, with runs of alike jobs folded into one line
//   stats():    totals per program over a chosen time range, and who held the card when

// Jobs are alike when the same program did the same kind of work. Numbers in the label
// (sizes, seeds, ids) don't make work different, and an odd failure inside a long run
// doesn't split it: the folded line counts the outcomes instead.
const kindOf = (j) => `${j.client}\u0000${String(j.label ?? '').replace(/\d+/g, '#')}`;

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * @param {object[]} jobs newest first
 * @param {number} limit lines to return
 * @param {number} minRun shortest run that is folded
 */
export function timeline(jobs, limit = 60, minRun = 3) {
  const lines = [];
  let i = 0;
  while (i < jobs.length && lines.length < limit) {
    const k = kindOf(jobs[i]);
    let n = 1;
    while (i + n < jobs.length && kindOf(jobs[i + n]) === k) n++;
    if (n < minRun) {
      for (let x = 0; x < n && lines.length < limit; x++) lines.push(jobs[i + x]);
    } else {
      const run = jobs.slice(i, i + n);
      const waits = run.filter((j) => j.startedAt).map((j) => j.startedAt - j.queuedAt).sort((a, b) => a - b);
      const rans = run.filter((j) => j.startedAt && j.endedAt).map((j) => j.endedAt - j.startedAt);
      const last = run[0];
      const first = run[n - 1];
      lines.push({
        folded: true, count: n, id: `${first.id}..${last.id}`,
        client: last.client, label: last.label,
        state: run.some((j) => j.state === 'done') ? 'done' : last.state,
        failed: run.filter((j) => j.state === 'failed').length,
        cancelled: run.filter((j) => j.state === 'cancelled').length,
        priority: last.priority,
        firstQueuedAt: first.queuedAt, firstEndedAt: first.endedAt, endedAt: last.endedAt,
        medianWait: quantile(waits, 0.5), maxWait: waits.length ? waits[waits.length - 1] : null,
        totalRan: sum(rans), medianRan: quantile([...rans].sort((a, b) => a - b), 0.5),
      });
    }
    i += n;
  }
  return { lines, more: i < jobs.length };
}

// Total length of a set of time intervals, overlaps counted once.
function merge(intervals, gap = 0) {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const covered = (iv) => sum(merge(iv).map(([a, b]) => b - a));

/**
 * @param {object[]} jobs finished jobs, any order, ending at or after `from`
 * @param {object[]} running jobs still running
 */
export function stats(jobs, running, from, to) {
  const span = to - from;
  const interval = (j) => [Math.max(j.startedAt, from), Math.min(j.endedAt ?? to, to)];
  const ran = [...jobs, ...running].filter((j) => j.startedAt && (j.endedAt ?? to) > from);
  const clients = [...new Set([...jobs, ...running].map((j) => j.client))].sort();

  const byStart = [...ran].sort((a, b) => a.startedAt - b.startedAt);
  let switches = 0;
  for (let i = 1; i < byStart.length; i++) if (byStart[i].group !== byStart[i - 1].group) switches++;

  const waitsOf = (list) => list.filter((j) => j.startedAt && j.startedAt >= from).map((j) => (j.startedAt - j.queuedAt) / 1000).sort((a, b) => a - b);
  const heldAll = covered(ran.map(interval));
  const allWaits = waitsOf(ran);

  const perClient = clients.map((name) => {
    const mine = jobs.filter((j) => j.client === name);
    const mineRan = ran.filter((j) => j.client === name);
    const runs = mineRan.filter((j) => j.endedAt).map((j) => (j.endedAt - j.startedAt) / 1000).sort((a, b) => a - b);
    const waits = waitsOf(mineRan);
    const held = covered(mineRan.map(interval));
    return {
      name,
      jobs: mine.length,
      failed: mine.filter((j) => j.state === 'failed').length,
      cancelled: mine.filter((j) => j.state === 'cancelled').length,
      heldSeconds: held / 1000,
      heldShare: span ? held / span : 0,
      medianWait: quantile(waits, 0.5), p95Wait: quantile(waits, 0.95),
      medianRan: quantile(runs, 0.5), maxRan: runs.length ? runs[runs.length - 1] : null,
      // Who held the card when, close gaps shorter than a pixel of a 1000-px strip.
      lanes: merge(mineRan.map(interval), span / 1000),
    };
  }).filter((c) => c.jobs || c.lanes.length);

  return {
    from, to,
    totals: {
      jobs: jobs.length,
      failed: jobs.filter((j) => j.state === 'failed').length,
      cancelled: jobs.filter((j) => j.state === 'cancelled').length,
      heldSeconds: heldAll / 1000, heldShare: span ? heldAll / span : 0,
      switches, medianWait: quantile(allWaits, 0.5), p95Wait: quantile(allWaits, 0.95),
    },
    clients: perClient,
  };
}
