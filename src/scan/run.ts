import type { GraphClient } from "../graph/client.js";
import { DeltaResyncRequiredError, deltaPages } from "../graph/delta.js";
import { resolveDrive } from "../graph/drive.js";
import type { Profile } from "../domain/profile/schema.js";
import type { RepositorySnapshot } from "../domain/reconcile/index.js";
import type { StateStore } from "../store/types.js";
import { changesFromDeltaItems } from "./changes.js";
import { assembleSnapshot } from "./snapshot.js";
import { crossCheckOtherLibraries, type CrossCheckSkipReason } from "./cross-check.js";

export interface ScanDependencies {
  client: GraphClient;
  store: StateStore;
  profile: Profile;
  now: () => Date;
  subPath?: string;
}

export interface ScanResult {
  snapshot: RepositorySnapshot;
  driveId: string;
  mode: "full" | "incremental";
  resynced: boolean;
  pages: number;
  changesApplied: number;
  graphRequests: number;
  storeBatches: number;
  /**
   * The sub-path filter that was applied, if one was. Carried through so the
   * formatter can name it: the enumeration itself is always full, so a line
   * reporting only the filtered file and folder counts reads as the size of
   * the whole drive rather than of the slice a filter narrowed it to.
   */
  subPath?: string;
  /**
   * The drive's file and folder counts before any sub-path filter, so the
   * formatter can report both numbers together without recomputing anything
   * from the already-filtered snapshot.
   */
  unfilteredFileCount: number;
  unfilteredFolderCount: number;
  /**
   * Present only when the Search cross-check did not complete, naming why.
   * `crossCheckOtherLibraries` always names one of the four reasons whenever
   * it does not complete, "no-region" included, so absent means the
   * cross-check completed rather than "completed or never ran": every
   * reachable way for it to have never run at all, such as the profile
   * carrying no searchRegion, is itself one of the four named reasons.
   */
  searchCrossCheckSkipReason?: CrossCheckSkipReason;
  /**
   * What the cross-check itself spent, kept apart from `graphRequests`
   * rather than folded into it. `graphRequests` is the figure
   * `docs/OPEN-ITEMS.md` records a live baseline for and the one this
   * project treats as evidence of what the delta enumeration costs; a
   * profile with `searchRegion` configured must not make that figure grow
   * for a reason that has nothing to do with the enumeration. Present only
   * when the cross-check issued at least one Graph request, which is
   * exactly when it was attempted at all: a profile with no `searchRegion`
   * spends nothing on it, and reporting a zero there would invite a reader
   * to think something ran and cost nothing rather than that nothing ran.
   */
  searchCrossCheckGraphRequests?: number;
}

export async function runScan(dependencies: ScanDependencies): Promise<ScanResult> {
  const { client, store, profile, now } = dependencies;
  // The client's own counter is cumulative since it was constructed, not since
  // this call started. main.ts builds a fresh client per run, so that happens
  // to read right today, but runScan is the library entry a later phase wires
  // a tool to, and a tool that reuses a client must not have this call's
  // report include requests a previous call already paid for.
  const requestsAtStart = client.requests();
  const { driveId } = await resolveDrive(client, profile.identity.siteUrl, profile.identity.library);

  const storedLink = await store.getDeltaLink(profile.profileId, driveId);

  // Counted across the whole run rather than per attempt. A resync discards the
  // work of its first attempt but the run still paid for it, and an operator
  // reading what a scan cost wants what it actually cost. graphRequests already
  // behaves this way because the client's counter is cumulative, and two numbers
  // on one result describing different spans cannot be read correctly.
  let pages = 0;
  let changesApplied = 0;
  let storeBatches = 0;

  async function enumerate(fromLink: string | undefined): Promise<string> {
    let deltaLink: string | undefined;

    for await (const page of deltaPages(client, driveId, fromLink)) {
      pages += 1;
      const changes = changesFromDeltaItems(page.items);
      const applied = await store.applyInventoryChanges(profile.profileId, driveId, changes);
      changesApplied += applied.changesApplied;
      storeBatches += applied.batches;
      if (page.deltaLink !== undefined) deltaLink = page.deltaLink;
    }

    if (deltaLink === undefined) {
      // deltaPages only returns after yielding a page carrying the final link,
      // so reaching here means the generator's own contract was broken and
      // continuing would persist an inventory with no way to resume from it.
      throw new Error(`The delta enumeration of drive ${driveId} finished without a deltaLink.`);
    }

    return deltaLink;
  }

  let mode: "full" | "incremental" = storedLink === undefined ? "full" : "incremental";
  let resynced = false;
  let deltaLink: string;

  try {
    deltaLink = await enumerate(storedLink);
  } catch (error) {
    if (!(error instanceof DeltaResyncRequiredError)) throw error;
    // The stored inventory is now unreliable in a way no incremental pass can
    // repair: the changes that would have removed its stale rows are exactly the
    // ones that aged out of the change log.
    await store.clearInventory(profile.profileId, driveId);
    resynced = true;
    mode = "full";
    deltaLink = await enumerate(undefined);
  }

  // Persisted last. An interrupted scan then resumes by re-reading pages it has
  // already applied, which is wasteful and correct, rather than by skipping
  // changes it never applied, which is cheap and silently wrong.
  const scannedAt = now().toISOString();
  await store.setDeltaLink(profile.profileId, driveId, deltaLink, scannedAt);

  const records = await store.listInventory(profile.profileId, driveId);

  // The enumeration's own cost is measured here, before the cross-check runs,
  // so `graphRequests` below stays exactly what it always meant: the delta
  // enumeration's cost alone, comparable to the baseline recorded in
  // docs/OPEN-ITEMS.md whether or not this profile ever runs a cross-check.
  const graphRequests = client.requests() - requestsAtStart;

  const requestsBeforeCrossCheck = client.requests();
  const crossCheck = await crossCheckOtherLibraries(client, profile);
  const searchCrossCheckGraphRequests = client.requests() - requestsBeforeCrossCheck;

  return {
    snapshot: assembleSnapshot(records, scannedAt, dependencies.subPath, crossCheck),
    driveId,
    mode,
    resynced,
    pages,
    changesApplied,
    graphRequests,
    storeBatches,
    subPath: dependencies.subPath,
    unfilteredFileCount: records.filter((record) => !record.isFolder).length,
    unfilteredFolderCount: records.filter((record) => record.isFolder).length,
    ...(crossCheck.reason === undefined ? {} : { searchCrossCheckSkipReason: crossCheck.reason }),
    ...(searchCrossCheckGraphRequests > 0 ? { searchCrossCheckGraphRequests } : {}),
  };
}
