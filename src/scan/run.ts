import type { GraphClient } from "../graph/client.js";
import { DeltaResyncRequiredError, deltaPages } from "../graph/delta.js";
import { resolveDrive } from "../graph/drive.js";
import type { Profile } from "../domain/profile/schema.js";
import type { RepositorySnapshot } from "../domain/reconcile/index.js";
import type { StateStore } from "../store/types.js";
import { changesFromDeltaItems } from "./changes.js";
import { assembleSnapshot } from "./snapshot.js";

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
}

export async function runScan(dependencies: ScanDependencies): Promise<ScanResult> {
  const { client, store, profile, now } = dependencies;
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

  return {
    snapshot: assembleSnapshot(records, scannedAt, dependencies.subPath),
    driveId,
    mode,
    resynced,
    pages,
    changesApplied,
    graphRequests: client.requests(),
    storeBatches,
  };
}
