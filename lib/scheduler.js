// The queue. Every piece of GPU work is a job; a job belongs to a group (one model on
// one backend, e.g. "ollama:qwen3-vl:8b" or "comfy"). Jobs of the same group may run
// side by side; jobs of different groups never do. Before the card passes to another
// group, the backend that held it is told to free its memory.
//
// Order: priority first (interactive, normal, background), then the group already on
// the card (a model reload costs 10-30 s), then arrival. A job that waits long enough
// moves up one priority level, and a group that has held the card for a long stretch
// stops being preferred, so nothing waits forever.
//
// Stepping aside (since 25 Nov 2026): a lease started with `gpu-lease --yield` (a long training run) can be asked to
// free the card for more urgent work and continues afterwards. Three rules keep the switches cheap:
//   1. minimum run: once it has the card, it keeps it at least yieldMinRunSeconds before it is asked again;
//   2. return slowly: it gets the card back only after the card has been free of other work for
//      yieldReturnIdleSeconds (work arrives in bursts; one pause per burst, not one per request);
//   3. a cap: once it has been paused for yieldCapFraction of the last yieldCapWindowSeconds, only clients in
//      yieldAlways (readers waiting for their photos) can still ask it to step aside.
import { EventEmitter } from 'node:events';

export const PRIORITIES = ['interactive', 'normal', 'background'];
export const prioIndex = (p) => {
  const i = PRIORITIES.indexOf(String(p ?? '').toLowerCase());
  return i < 0 ? null : i;
};

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(++seq).toString(36)}`;

export class Scheduler extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.backends  name -> { concurrency, evict(): Promise }
   * @param {(ms:number)=>Promise} o.waitForMemory  resolves when the card is (nearly) empty
   * @param {object} o.settings  { ageStepSeconds:[...], batchSeconds, graceSeconds, historySize }
   */
  constructor({ backends, waitForMemory, settings, log = () => {} }) {
    super();
    this.backends = backends;
    this.waitForMemory = waitForMemory;
    this.settings = settings;
    this.log = log;
    this.waiting = [];
    this.running = new Map();
    this.history = [];
    this.resident = null;        // { backend, group, since } — what is on the card now
    this.switching = false;
    this.paused = false;
  }

  /** Adds a job. Resolves with the job when it may start; rejects if it is cancelled. */
  /**
   * `resume`: a lease whose command kept running while the queue restarted. It is
   * already on the card, so it goes before everything else and does not wait for the
   * memory to empty. `since` is when it first got the card.
   */
  enqueue({ client, priority, backend, group, label, resume = false, since = null, yieldable = false }) {
    const job = {
      id: newId(), client, backend, group, label: label || group,
      priority: prioIndex(priority) ?? 1, bumped: 0,
      queuedAt: Date.now(), startedAt: null, endedAt: null, state: 'queued',
    };
    if (yieldable && backend === 'lease') { job.yieldable = true; job.pauses = []; }
    if (resume) { job.resume = true; if (since > 0 && since <= Date.now()) job.since = since; }
    const started = new Promise((resolve, reject) => { job._resolve = resolve; job._reject = reject; });
    started.catch(() => {});
    job.started = started;
    this.waiting.push(job);
    this.emit('change');
    queueMicrotask(() => this.pump());
    return job;
  }

  /** Marks a running job finished. */
  finish(job, outcome = 'done') {
    if (!this.running.has(job.id)) return;
    clearTimeout(job.yieldTimer);
    this.running.delete(job.id);
    if (this.resident?.group === job.group) {
      this.resident.lastEnd = Date.now();
      this.resident.lastPriority = job.effectiveAtStart ?? job.priority;
    }
    job.state = outcome;
    job.endedAt = Date.now();
    this.remember(job);
    this.emit('change');
    this.pump();
  }

  /** Removes a queued job; its caller gets an error. */
  cancel(id, why = 'cancelled') {
    const i = this.waiting.findIndex((j) => j.id === id);
    if (i < 0) return false;
    const [job] = this.waiting.splice(i, 1);
    if (job.parked) {           // a paused lease whose program ended: it ran, so it is done, not cancelled
      job.parked = false;
      this.closePause(job);
      job.state = 'done';
      job.endedAt = Date.now();
      this.remember(job);
      this.emit('change');
      this.pump();
      return true;
    }
    job.state = 'cancelled';
    job.endedAt = Date.now();
    job.note = why;
    this.remember(job);
    job._reject(new Error(why));
    this.emit('change');
    this.pump();
    return true;
  }

  setJobPriority(id, priority) {
    const job = this.waiting.find((j) => j.id === id);
    const p = prioIndex(priority);
    if (!job || p == null) return false;
    job.priority = p;
    job.bumped = 0;
    this.emit('change');
    this.pump();
    return true;
  }

  setPaused(on) {
    this.paused = !!on;
    this.emit('change');
    this.pump();
  }

  remember(job) {
    const { _resolve, _reject, started, effectiveAtStart, since, yieldTimer, ...plain } = job;
    if (job.pauses) { plain.pauses = job.pauses.length; plain.pausedSeconds = Math.round(this.pausedMs(job, 0, Date.now()) / 1000); }
    this.history.unshift(plain);
    this.emit('finished', plain);
    if (this.history.length > this.settings.historySize) this.history.length = this.settings.historySize;
  }

  /** Priority after waiting: one level up per ageStepSeconds[level] waited. */
  effective(job, now = Date.now()) {
    let p = job.priority;
    let waited = (now - job.queuedAt) / 1000;
    while (p > 0) {
      const step = this.settings.ageStepSeconds[p];
      if (!step || waited < step) break;
      waited -= step;
      p -= 1;
    }
    return p;
  }

  ranked(now = Date.now()) {
    const group = this.runningGroup() ?? this.resident?.group;
    const batchMs = this.settings.batchSeconds * 1000;
    // Within one priority level the model already on the card goes first, but only
    // ahead of jobs that have waited less than batchSeconds. A job that has waited
    // longer competes by arrival, so a steady stream for the loaded model (even one
    // with no gap between requests) cannot hold it back for ever.
    const later = (j) => (group && j.group !== group && now - j.queuedAt < batchMs ? 1 : 0);
    return [...this.waiting].sort((a, b) =>
      (b.resume ? 1 : 0) - (a.resume ? 1 : 0)
      || this.effective(a, now) - this.effective(b, now)
      || later(a) - later(b)
      || a.queuedAt - b.queuedAt);
  }

  runningGroup() {
    for (const j of this.running.values()) return j.group;
    return null;
  }

  async pump() {
    if (this.switching || this.paused) return;
    for (;;) {
      const top = this.ranked()[0];
      if (!top) return;
      const group = this.runningGroup();
      if (group) {
        // Only the top job may start, and only if it can share the card with what runs.
        const cap = this.backends[top.backend]?.concurrency ?? 1;
        if (top.group !== group || this.running.size >= cap) { this.considerYield(top); return; }
        this.start(top);
        continue;
      }
      // The card is idle. A program that works in steps (read a photo, think, read the
      // next) keeps first claim for a short grace period; lower-priority work waits.
      const r = this.resident;
      // A paused lease returns only after the card has been free of other work for a while (rule 2).
      if (top.parked && r && r.group !== top.group && r.lastEnd) {
        const left = r.lastEnd + this.settings.yieldReturnIdleSeconds * 1000 - Date.now();
        if (left > 0) {
          clearTimeout(this.graceTimer);
          this.graceTimer = setTimeout(() => this.pump(), left + 10);
          return;
        }
      }
      if (r && r.group !== top.group && r.lastEnd && !top.resume && this.effective(top) > r.lastPriority) {
        const left = r.lastEnd + this.settings.graceSeconds * 1000 - Date.now();
        if (left > 0) {
          clearTimeout(this.graceTimer);
          this.graceTimer = setTimeout(() => this.pump(), left + 10);
          return;
        }
      }
      // Hand the card to the top job, freeing it first if needed.
      if (this.resident?.group !== top.group) {
        this.switching = true;
        this.emit('change');
        try { await this.handOver(top); } finally { this.switching = false; }
        if (this.paused || !this.waiting.includes(top)) { this.emit('change'); continue; }
      }
      if (this.resident?.group !== top.group) {
        this.resident = { backend: top.backend, group: top.group, since: Date.now() };
      }
      this.start(top);
    }
  }

  async handOver(job) {
    const from = this.resident;
    const t0 = Date.now();
    // Ollama swaps its own models; anything else means emptying the card.
    const ollamaToOllama = from?.backend === 'ollama' && job.backend === 'ollama';
    if (!ollamaToOllama) {
      const names = from ? [from.backend] : Object.keys(this.backends);
      for (const name of names) {
        if (name === job.backend && job.backend !== 'lease') continue;
        try { await this.backends[name]?.evict?.(); } catch (e) { this.log(`free ${name}: ${e.message}`); }
      }
      // The program taking over may already hold memory of its own; that does not count.
      // A resumed lease holds its memory already: there is nothing to wait for.
      if (!job.resume && (!from || from.backend !== job.backend || job.backend === 'lease')) await this.waitForMemory(30_000, job.backend);
    }
    this.resident = { backend: job.backend, group: job.group, since: Date.now() };
    this.lastSwitch = { from: from?.group ?? null, to: job.group, at: Date.now(), ms: Date.now() - t0 };
    this.log(`card: ${from?.group ?? '(unknown)'} -> ${job.group} in ${Date.now() - t0} ms`);
  }

  start(job) {
    const i = this.waiting.indexOf(job);
    if (i >= 0) this.waiting.splice(i, 1);
    job.state = 'running';
    job.runSince = Date.now();
    this.running.set(job.id, job);
    if (job.parked) {             // a paused lease gets the card back: its program continues
      job.parked = false;
      this.closePause(job);
      this.log(`lease ${job.group} resumes after ${Math.round((Date.now() - job.pauses.at(-1).from) / 1000)} s`);
      this.emit('resume', job);
      this.emit('change');
      return;
    }
    job.effectiveAtStart = this.effective(job);
    job.startedAt = job.since ?? Date.now();
    this.emit('change');
    job._resolve(job);
  }

  // --- Stepping aside ---------------------------------------------------------------

  /** Milliseconds a lease spent paused between `from` and `to`. */
  pausedMs(job, from, to) {
    let ms = 0;
    for (const p of job.pauses ?? []) ms += Math.max(0, Math.min(to, p.to ?? to) - Math.max(from, p.from));
    return ms;
  }

  closePause(job) {
    const p = job.pauses?.at(-1);
    if (p && p.to == null) p.to = Date.now();
  }

  /** `top` waits for the card while something else holds it: ask a yieldable lease to step aside, if the rules allow. */
  considerYield(top) {
    const s = this.settings;
    const lease = [...this.running.values()].find((j) => j.yieldable);
    if (!lease || this.running.size !== 1 || lease.state !== 'running' || top.group === lease.group) return;
    const now = Date.now();
    // The first waiting job that is more urgent than the lease and, past the cap, a yieldAlways client.
    const win = s.yieldCapWindowSeconds * 1000;
    const capped = this.pausedMs(lease, now - win, now) >= s.yieldCapFraction * win;   // rule 3
    const urgent = this.ranked(now).find((j) => j.group !== lease.group && this.effective(j, now) < lease.priority
      && (!capped || (s.yieldAlways ?? []).includes(j.client)));
    if (!urgent) return;
    top = urgent;
    if (lease.noYieldUntil > now) return;
    const left = lease.runSince + s.yieldMinRunSeconds * 1000 - now;   // rule 1
    if (left > 0) {
      clearTimeout(this.yieldWait);
      this.yieldWait = setTimeout(() => this.pump(), left + 10);
      return;
    }
    lease.state = 'yielding';
    lease.yieldAskedAt = now;
    lease.yieldFor = top.client;
    this.log(`lease ${lease.group}: asked to step aside for ${top.client} (${top.label})`);
    this.emit('yield', lease);
    this.emit('change');
    // A program that does not answer keeps the card; it is not asked again for a while.
    lease.yieldTimer = setTimeout(() => {
      if (lease.state !== 'yielding') return;
      lease.state = 'running';
      lease.noYieldUntil = Date.now() + 10 * 60_000;
      this.log(`lease ${lease.group}: did not step aside within ${s.yieldTimeoutSeconds} s; not asked again for 10 minutes`);
      this.emit('resume', lease);
      this.emit('change');
    }, s.yieldTimeoutSeconds * 1000);
    lease.yieldTimer.unref?.();
  }

  /** The lease's program has freed the card (gpu-lease reports it). */
  yielded(id) {
    const job = this.running.get(id);
    if (!job || job.state !== 'yielding') return false;
    clearTimeout(job.yieldTimer);
    this.running.delete(id);
    const now = Date.now();
    job.pauses.push({ from: now, to: null, for: job.yieldFor });
    job.state = 'paused';
    job.parked = true;
    job.queuedAt = now;
    job.bumped = 0;
    if (this.resident?.group === job.group) { this.resident.lastEnd = now; this.resident.lastPriority = job.priority; }
    this.waiting.push(job);
    this.log(`lease ${job.group}: stepped aside in ${Math.round((now - job.yieldAskedAt) / 1000)} s`);
    this.emit('change');
    this.pump();
    return true;
  }

  snapshot() {
    const now = Date.now();
    const plain = (j) => ({
      id: j.id, client: j.client, backend: j.backend, group: j.group, label: j.label,
      priority: PRIORITIES[j.priority], effective: PRIORITIES[this.effective(j, now)],
      queuedAt: j.queuedAt, startedAt: j.startedAt, endedAt: j.endedAt, state: j.state, note: j.note,
      ...(j.yieldable ? { yieldable: true, pauses: j.pauses.length, pausedSeconds: Math.round(this.pausedMs(j, 0, now) / 1000) } : {}),
    });
    return {
      paused: this.paused,
      switching: this.switching,
      resident: this.resident,
      lastSwitch: this.lastSwitch ?? null,
      running: [...this.running.values()].map(plain),
      waiting: this.ranked(now).map(plain),
      history: this.history.slice(0, 100).map((j) => ({ ...j, priority: PRIORITIES[j.priority] })),
    };
  }
}
