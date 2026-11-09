/**
 * Runs calls that share a key one at a time, in arrival order; calls under
 * different keys overlap freely.
 *
 * It exists for one race the 9c-era campaign measured live: four simultaneous
 * `open_assessment` calls for one vendor each read "no assessment in progress"
 * before any of them created one, and made four. The read and the create are
 * separate Graph requests, so no check inside either call can close that
 * window; only ordering the calls can.
 *
 * The lock lives in this process. The product runs one server process per
 * tenant (one replica, by design), so that is the whole population of callers.
 * A second process against the same site would not be ordered by this, which
 * is why the hosting decision names one replica rather than leaving it
 * implicit.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  // A caller's failure must not block the next in line, so the chain continues from the settled outcome.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    // The map entry is dropped only when nothing queued behind this call, so an idle key holds no memory.
    if (tails.get(key) === tail) tails.delete(key);
  }
}
