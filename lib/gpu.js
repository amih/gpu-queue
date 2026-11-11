// What the card is doing, from nvidia-smi. Cached for a second so a busy status page
// does not run it in a loop.
import { execFile } from 'node:child_process';

const run = (args) => new Promise((resolve) => {
  execFile('nvidia-smi', args, { timeout: 10_000 }, (err, out) => resolve(err ? '' : String(out)));
});

let cache = { at: 0, value: null };

export async function gpuState() {
  if (Date.now() - cache.at < 1000 && cache.value) return cache.value;
  const head = (await run(['--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits'])).trim().split('\n')[0];
  if (!head) return (cache = { at: Date.now(), value: null }).value;
  const [name, used, total, util, temp, power] = head.split(',').map((s) => s.trim());
  const procs = (await run(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']))
    .trim().split('\n').filter(Boolean).map((line) => {
      const [pid, proc, mem] = line.split(',').map((s) => s.trim());
      return { pid: Number(pid), name: proc.split('/').slice(-4).join('/'), memMiB: Number(mem) };
    });
  const value = { name, usedMiB: Number(used), totalMiB: Number(total), util: Number(util), tempC: Number(temp), powerW: Number(power) || null, procs };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Resolves when used memory falls to `targetMiB`, or after `ms`. Memory held by the
 * backend about to run (its processes match procMatch[backend]) is not counted.
 */
export function memoryWaiter(targetMiB, procMatch = {}) {
  return async (ms, backend) => {
    const end = Date.now() + ms;
    const own = procMatch[backend] ? new RegExp(procMatch[backend], 'i') : null;
    while (Date.now() < end) {
      cache.at = 0;
      const g = await gpuState();
      const mine = own ? g?.procs.filter((p) => own.test(p.name)).reduce((n, p) => n + p.memMiB, 0) : 0;
      if (!g || g.usedMiB - mine <= targetMiB) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
}
