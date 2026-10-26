"""Small helpers shared by the tools."""

import multiprocessing
import signal
import time

# ---------------------------------------------------------------- stopping
# SIGTERM (Cancel on the tools page, docker stop) only sets a flag. Raising
# from the signal handler is not safe: if it fires inside a GDAL progress
# callback, GDAL's Python binding turns SystemExit into an immediate process
# exit and no cleanup code runs. Long loops and GDAL callbacks poll the flag.
_TERM = {"flag": False}


def terminating():
    return _TERM["flag"]


def install_sigterm():
    def handler(_signum, _frame):
        _TERM["flag"] = True
    signal.signal(signal.SIGTERM, handler)


class Cancelled(SystemExit):
    def __init__(self):
        super().__init__(143)


def check_cancel():
    if _TERM["flag"]:
        raise Cancelled()


def batched(iterable, n):
    batch = []
    for item in iterable:
        batch.append(item)
        if len(batch) == n:
            yield batch
            batch = []
    if batch:
        yield batch


def run_batch(args):
    fn, items = args
    return [fn(i) for i in items]


def pool_map(pool, fn, items, batch=8, poll=1.0):
    """Unordered parallel map that stays responsive to SIGTERM.

    Items are sent in batches (fewer round trips); results are yielded one by
    one. pool.imap_unordered(chunksize>1) can't be waited on with a timeout,
    so batching is done here and the pool sees chunksize=1.
    """
    it = pool.imap_unordered(run_batch, ((fn, b) for b in batched(items, batch)))
    while True:
        check_cancel()
        try:
            results = it.next(timeout=poll)
        except StopIteration:
            return
        except multiprocessing.TimeoutError:
            continue
        yield from results


def gdal_progress(label, step=10):
    """GDAL progress callback printing every `step` percent."""
    state = {"last": -step}

    def cb(complete, _msg=None, _data=None):
        if _TERM["flag"]:
            return 0  # makes GDAL stop; the caller then sees a RuntimeError
        pct = int(complete * 100)
        if pct >= state["last"] + step or (pct == 100 and state["last"] != 100):
            print(f"  {label}: {pct}%", flush=True)
            state["last"] = pct
        return 1
    return cb


def fmt_time(sec):
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    if sec >= 60:
        return f"{sec // 60}m{sec % 60:02d}s"
    return f"{sec}s"


def fmt_size(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return f"{nbytes:.1f} {unit}" if unit != "B" else f"{nbytes} B"
        nbytes /= 1024.0
    return f"{nbytes:.1f} GB"


class Ticker:
    """Rate-limited progress printer."""

    def __init__(self, every=5.0):
        self.every = every
        self.t0 = self.last = time.time()

    def due(self):
        now = time.time()
        if now - self.last >= self.every:
            self.last = now
            return True
        return False

    def elapsed(self):
        return time.time() - self.t0
