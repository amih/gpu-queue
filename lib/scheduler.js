// The queue. Every piece of GPU work is a job; a job belongs to a group (one model on
// one backend, e.g. "ollama:qwen3-vl:8b" or "comfy"). Jobs of the same group may run
// side by side; jobs of different groups never do. Before the card passes to another
// group, the backend that held it is told to free its memory.
//
// Order: priority first (interactive, normal, background), then the group already on
// the card (a model reload costs 10-30 s), then arrival. A job that waits long enough
// moves up one priority level, and a group that has held the card for a long stretch
// stops being preferred, so nothing waits forever.
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
   * @param {object} o.settings  { ageStepSeconds:[...], batchSeconds, historySize }
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
    this.groupStart = 0;         // when the running group got the card
    this.switching = false;
    this.paused = false;
  }

  /** Adds a job. Resolves with the job when it may start; rejects if it is cancelled. */
  enqueue({ client, priority, backend, group, label }) {
    const job = {
      id: newId(), client, backend, group, label: label || group,
      priority: prioIndex(priority) ?? 1, bumped: 0,
      queuedAt: Date.now(), startedAt: null, endedAt: null, state: 'queued',
    };
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
    this.running.delete(job.id);
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
    const { _resolve, _reject, started, ...plain } = job;
    this.history.unshift(plain);
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
    const preferResident = group && (now - this.groupStart) / 1000 < this.settings.batchSeconds;
    return [...this.waiting].sort((a, b) =>
      this.effective(a, now) - this.effective(b, now)
      || (preferResident ? (b.group === group) - (a.group === group) : 0)
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
        if (top.group !== group || this.running.size >= cap) return;
        this.start(top);
        continue;
      }
      // The card is idle: hand it to the top job, freeing it first if needed.
      if (this.resident?.group !== top.group) {
        this.switching = true;
        this.emit('change');
        try { await this.handOver(top); } finally { this.switching = false; }
        if (this.paused || !this.waiting.includes(top)) { this.emit('change'); continue; }
      }
      if (this.resident?.group !== top.group) {
        this.resident = { backend: top.backend, group: top.group, since: Date.now() };
      }
      this.groupStart = Date.now();
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
      if (!from || from.backend !== job.backend || job.backend === 'lease') await this.waitForMemory(30_000);
    }
    this.resident = { backend: job.backend, group: job.group, since: Date.now() };
    this.lastSwitch = { from: from?.group ?? null, to: job.group, at: Date.now(), ms: Date.now() - t0 };
    this.log(`card: ${from?.group ?? '(unknown)'} -> ${job.group} in ${Date.now() - t0} ms`);
  }

  start(job) {
    const i = this.waiting.indexOf(job);
    if (i >= 0) this.waiting.splice(i, 1);
    job.state = 'running';
    job.startedAt = Date.now();
    this.running.set(job.id, job);
    this.emit('change');
    job._resolve(job);
  }

  snapshot() {
    const now = Date.now();
    const plain = (j) => ({
      id: j.id, client: j.client, backend: j.backend, group: j.group, label: j.label,
      priority: PRIORITIES[j.priority], effective: PRIORITIES[this.effective(j, now)],
      queuedAt: j.queuedAt, startedAt: j.startedAt, endedAt: j.endedAt, state: j.state, note: j.note,
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
