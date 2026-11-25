"""Step aside on the GPU when the queue asks, and continue afterwards (gpu-queue, `gpu-lease --yield`).

    import sys; sys.path.insert(0, '/var/www/gpu/python')
    from gpu_yield import GpuYield, optimizer_to

    def pause():  model.cpu(); optimizer_to(opt, 'cpu')       # everything the run keeps on the card
    def resume(): model.cuda(); optimizer_to(opt, 'cuda')
    gy = GpuYield(pause, resume)
    for batch in loader:
        gy.check()          # between steps, before the batch goes to the card; cheap (one file read every 0.5 s)
        ...

Run the script as `gpu-lease -c lab -p background --yield -- python train.py` (python directly, or through `nice`).
Without gpu-lease --yield (no GPU_LEASE_CTL), check() does nothing. Time spent paused is returned by check() and
summed in gy.paused_seconds, so a run can report it and leave it out of its own speed numbers.
"""
import os
import sys
import time


class GpuYield:
    def __init__(self, pause, resume, log=None, every=0.5):
        self.dir = os.environ.get('GPU_LEASE_CTL')
        self.pause, self.resume = pause, resume
        self.log = log or (lambda m: print(f'gpu_yield: {m}', file=sys.stderr, flush=True))
        self.every = every
        self._next = 0.0
        self.pauses = 0
        self.paused_seconds = 0.0

    def _state(self):
        try:
            with open(os.path.join(self.dir, 'state')) as f:
                return f.read().strip()
        except OSError:
            return 'run'

    def _ack(self, v):
        tmp = os.path.join(self.dir, 'ack.tmp')
        with open(tmp, 'w') as f:
            f.write(v)
        os.replace(tmp, os.path.join(self.dir, 'ack'))

    def check(self):
        """Between steps: if the queue wants the card, free it, wait for it, take it back. Returns seconds paused."""
        if not self.dir:
            return 0.0
        now = time.monotonic()
        if now < self._next:
            return 0.0
        self._next = now + self.every
        if self._state() != 'yield':
            return 0.0
        t0 = time.monotonic()
        self.log('the queue needs the card: stepping aside')
        self.pause()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
        except ImportError:
            pass
        self._ack('yielded')
        freed = time.monotonic() - t0
        while self._state() == 'yield':
            time.sleep(1)
        t1 = time.monotonic()
        self.resume()
        self._ack('running')
        took = time.monotonic() - t0
        self.pauses += 1
        self.paused_seconds += took
        self.log(f'continuing: freed the card in {freed:.0f} s, waited {t1 - t0 - freed:.0f} s, '
                 f'back on the card in {time.monotonic() - t1:.0f} s')
        return took


def optimizer_to(opt, device):
    """Moves an optimizer's state (Adam's moments etc.) to `device`."""
    import torch
    for state in opt.state.values():
        for k, v in state.items():
            if torch.is_tensor(v):
                state[k] = v.to(device)
