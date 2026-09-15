import type { GraphClient } from "../graph/client.js";
import type { StateStore } from "../store/types.js";
import type { Profile } from "../domain/profile/schema.js";
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

export interface ScanCoordinator {
  run(profile: Profile): Promise<CoordinatedScan>;
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
 * This coordinates within a replica and not across them. `docs/OPEN-ITEMS.md`
 * carries that gap and the one-replica constraint that follows from it.
 */
export function createScanCoordinator(options: ScanCoordinatorOptions): ScanCoordinator {
  const scan = options.scan ?? runScan;
  const inFlight = new Map<string, Promise<ScanResult>>();

  return {
    async run(profile: Profile): Promise<CoordinatedScan> {
      const held = inFlight.get(profile.profileId);
      if (held !== undefined) return { result: await held, joined: true };

      const started = scan({ client: options.client, store: options.store, profile, now: options.now });
      inFlight.set(profile.profileId, started);
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
  };
}
