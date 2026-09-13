import type { ScanResult } from "./run.js";

const USAGE = "Usage: npm run scan -- --profile <path to profile json> [--sub-path <library-relative path>]";

export interface ScanArguments {
  profilePath: string;
  subPath?: string;
}

export function parseScanArguments(argv: readonly string[]): ScanArguments {
  let profilePath: string | undefined;
  let subPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    // A flag's value is read as a value only when it is not itself a flag.
    // Otherwise `--profile --sub-path 2026` silently scans a profile named
    // "--sub-path".
    const value = argv[index + 1];
    const hasValue = value !== undefined && !value.startsWith("--");

    if (flag === "--profile") {
      if (!hasValue) throw new Error(`--profile needs a value. ${USAGE}`);
      profilePath = value;
      index += 1;
    } else if (flag === "--sub-path") {
      if (!hasValue) throw new Error(`--sub-path needs a value. ${USAGE}`);
      subPath = value;
      index += 1;
    } else {
      throw new Error(`Unrecognized argument "${flag}". ${USAGE}`);
    }
  }

  if (profilePath === undefined) throw new Error(`--profile is required. ${USAGE}`);
  return subPath === undefined ? { profilePath } : { profilePath, subPath };
}

/**
 * Every line here is checked against what the scan actually did. `mode` and
 * `resynced` come from the run rather than from what was intended, the counts
 * are the run's own tallies, and the in-memory warning is printed from the store
 * that was actually constructed rather than from the environment that was read.
 */
export function formatScanResult(result: ScanResult, storeKind: "azure-table" | "in-memory"): string[] {
  const lines = [
    `Scan complete: ${result.mode === "full" ? "full enumeration" : "incremental scan"} of drive ${result.driveId}.`,
    `Files: ${result.snapshot.files.length}. Folders: ${result.snapshot.folderPaths.length}.`,
  ];

  const withoutEtag = result.snapshot.files.filter((file) => file.etag === "").length;
  if (withoutEtag > 0) {
    lines.push(
      `${withoutEtag} of those files carry no ETag. Graph did not report one, and this snapshot ` +
        "stores an empty string rather than marking the value absent, so a later plan that uses " +
        "an ETag as a precondition cannot tell those files apart from ones with a real ETag.",
    );
  }

  lines.push(
    `Graph requests: ${result.graphRequests}. Delta pages: ${result.pages}.`,
    `Store: ${storeKind}. Changes applied: ${result.changesApplied}. Write operations: ${result.storeBatches}.`,
    `Scanned at: ${result.snapshot.scannedAt}.`,
  );

  if (result.resynced) {
    lines.push(
      "This run resynced: the stored deltaLink was no longer valid, so the stored inventory was " +
        "discarded and the drive enumerated from scratch. That is why this run cost a full " +
        "enumeration rather than an incremental one.",
    );
  }

  if (storeKind === "in-memory") {
    lines.push(
      "No storage account was configured, so this run used the in-memory store and nothing was " +
        "persisted. The next run will enumerate in full. Set IW_TABLE_CONNECTION_STRING to keep " +
        "the inventory between runs.",
    );
  }

  lines.push(
    "The Microsoft Search cross-check did not run, which phase 2a never does. A correctly named " +
      "file stored outside the expected taxonomy is invisible to this snapshot, so any " +
      "reconciliation run against it is a degraded scan.",
  );

  return lines;
}
