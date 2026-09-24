import type { GraphClient } from "../graph/client.js";
import type { StateStore } from "../store/types.js";
import type { AnyProfile } from "../domain/profile/library.js";
import { runScan, type ScanDependencies, type ScanResult } from "./run.js";

export interface CoordinatedScan {
  result: ScanResult;
  /**
   * True when this call awaited a scan another call had already started. The
   * caller needs it: the two share one `ScanResult`, so a report that took its
   * Graph request count straight from that shared object would claim a cost
   * this call did not pay.
   */
  joined: boolean;
}

export interface SettledScan {
  /** True when a scan was in flight for this profile and this call awaited it. */
  awaited: boolean;
  /**
   * True when the scan this call awaited ended in failure. A failed scan may
   * have called `clearInventory` to resync and then stopped before rebuilding,
   * and nothing a reader can see afterwards distinguishes what survives from a
   * library that genuinely holds only those items. A caller that reads the
   * inventory rather than scanning it therefore has to treat this as a refusal
   * to answer, not as a warning it can attach to an answer.
   */
  failed: boolean;
}

export interface ScanCoordinator {
  run(profile: AnyProfile): Promise<CoordinatedScan>;
  /**
   * Awaits a scan already in flight for this profile, so a caller that reads
   * the store directly rather than scanning does not read an inventory a
   * concurrent resync has cleared and not yet rebuilt. Returns immediately
   * when nothing is in flight, and never rejects: a scan another call started
   * failing is that call's failure to report, and this one needs to know only
   * whether the inventory it is about to read can still be trusted.
   */
  settle(profile: AnyProfile): Promise<SettledScan>;
  /**
   * How many scans this coordinator has started for this profile since the
   * process began, joins excluded. It exists so a reader can bracket its own
   * store reads: a count that changed across them means a scan began while the
   * read was in progress, which is the one window `settle` cannot close by
   * waiting, because there was nothing to wait for when it was called.
   */
  scansStarted(profile: AnyProfile): number;
}

export interface ScanCoordinatorOptions {
  client: GraphClient;
  store: StateStore;
  now: () => Date;
  /** Injected only by tests. Production always uses `runScan`. */
  scan?: (dependencies: ScanDependencies) => Promise<ScanResult>;
}

/**
 * Single-flight, not a cache. A second call arriving while a scan is running
 * awaits that scan; a second call arriving after it finished starts its own,
 * because the whole reason the tool scans per call is that an agent must not be
 * handed a stale answer.
 *
 * What this prevents is narrow and severe. `runScan` answers a
 * `DeltaResyncRequiredError` by calling `store.clearInventory` and
 * re-enumerating from nothing, and a second call reading `listInventory` inside
 * that window sees an empty or half-built inventory and reports every file in
 * the library as missing. Concurrent scans that do not resync collide
 * harmlessly, applying the same changes idempotently, so this exists for the
 * resync case alone.
 *
 * Keyed on `profileId` rather than on the drive id, because a profile names
 * exactly one site and one library and the profile id is known before the call
 * starts. The drive id is not: it comes back from `resolveDrive` inside
 * `runScan`, by which point the race has already begun.
 *
 * `settle` and `scansStarted` extend the same protection to a caller that
 * reads the inventory without scanning it, which `query_repository` does. That
 * tool cannot use `run`, since running a scan would cost it the zero-request
 * property it exists to demonstrate, so it waits on whatever is in flight and
 * then brackets its own store reads with the counter.
 *
 * This coordinates within a replica and not across them. `docs/OPEN-ITEMS.md`
 * carries that gap and the one-replica constraint that follows from it.
 */
export function createScanCoordinator(options: ScanCoordinatorOptions): ScanCoordinator {
  const scan = options.scan ?? runScan;
  const inFlight = new Map<string, Promise<ScanResult>>();
  // Never decremented and never reset. Its only use is comparing two readings
  // of the same profile's count, so it has to be monotonic; a gauge of scans
  // currently running would read the same before and after a scan that both
  // started and finished inside the window being bracketed.
  const startedCounts = new Map<string, number>();

  return {
    async run(profile: AnyProfile): Promise<CoordinatedScan> {
      const held = inFlight.get(profile.profileId);
      if (held !== undefined) return { result: await held, joined: true };

      const started = scan({ client: options.client, store: options.store, profile, now: options.now });
      inFlight.set(profile.profileId, started);
      startedCounts.set(profile.profileId, (startedCounts.get(profile.profileId) ?? 0) + 1);
      try {
        // Awaited inside the same synchronous block that stored it, so a
        // rejection always has a handler attached and can never surface as an
        // unhandled rejection, which Node 22 answers by ending the process.
        return { result: await started, joined: false };
      } finally {
        // In a `finally` so a failed scan does not leave a rejected promise in
        // the map for every later call to join and fail against.
        inFlight.delete(profile.profileId);
      }
    },

    async settle(profile: AnyProfile): Promise<SettledScan> {
      const held = inFlight.get(profile.profileId);
      if (held === undefined) return { awaited: false, failed: false };

      try {
        await held;
        return { awaited: true, failed: false };
      } catch {
        // Swallowed rather than rethrown, and the promise already carries the
        // owning `run` call's own handler, so this attaches a second one to a
        // rejection that is already accounted for rather than leaving one
        // unhandled.
        return { awaited: true, failed: true };
      }
    },

    scansStarted(profile: AnyProfile): number {
      return startedCounts.get(profile.profileId) ?? 0;
    },
  };
}
