// What the card is doing, from nvidia-smi. Cached for a second so a busy status page
// does not run it in a loop.
import { execFile } from 'node:child_process';

const run = (args) => new Promise((resolve) => {
  execFile('nvidia-smi', args, { timeout: 10_000 }, (err, out) => resolve(err ? '' : String(out)));
});

let cache = { at: 0, value: null };

export async function gpuState() {
  if (Date.now() - cache.at < 1000 && cache.value) return cache.value;
  const head = (await run(['--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits'])).trim().split('\n')[0];
  if (!head) return (cache = { at: Date.now(), value: null }).value;
  const [name, used, total, util, temp] = head.split(',').map((s) => s.trim());
  const procs = (await run(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']))
    .trim().split('\n').filter(Boolean).map((line) => {
      const [pid, proc, mem] = line.split(',').map((s) => s.trim());
      return { pid: Number(pid), name: proc.split('/').slice(-3).join('/'), memMiB: Number(mem) };
    });
  const value = { name, usedMiB: Number(used), totalMiB: Number(total), util: Number(util), tempC: Number(temp), procs };
  cache = { at: Date.now(), value };
  return value;
}

/** Resolves when used memory falls to `targetMiB`, or after `ms`. */
export function memoryWaiter(targetMiB) {
  return async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      cache.at = 0;
      const g = await gpuState();
      if (!g || g.usedMiB <= targetMiB) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
}
