import { readFile } from "node:fs/promises";
import { crossCheckNeverAttempted, describeCrossCheckSkipReason } from "./cross-check.js";
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
      // Stripped so "/2026/CLIENTA" and "2026/CLIENTA/" behave the same as
      // "2026/CLIENTA". Inventory paths are library-relative with no leading
      // slash and no trailing one, so an unstripped filter would silently
      // match nothing rather than the client the operator named.
      //
      // A value that strips to nothing, "/" being the one an operator would
      // actually type, names the whole library, which is what omitting the flag
      // already means. It is left unset rather than stored as an empty string so
      // the two spellings are the same thing everywhere downstream, including in
      // the output, which would otherwise announce a filter that never applied.
      const stripped = value.replace(/^\/+/, "").replace(/\/+$/, "");
      subPath = stripped.length === 0 ? undefined : stripped;
      index += 1;
    } else {
      throw new Error(`Unrecognized argument "${flag}". ${USAGE}`);
    }
  }

  if (profilePath === undefined) throw new Error(`--profile is required. ${USAGE}`);
  return subPath === undefined ? { profilePath } : { profilePath, subPath };
}

/**
 * The one exception to this module's no-I/O rule. It exists here, rather than
 * inline in main.ts, so its own failure mode -- a profile file that is not
 * valid JSON -- has a test seam; main.ts has none by design, being the
 * untestable-without-a-tenant part of this command.
 *
 * Node's own ENOENT message already carries the path when the file is
 * missing, so a missing file identifies itself. A JSON syntax error does not:
 * `JSON.parse` reports a character offset and nothing else, which leaves an
 * operator holding a parser message with no way to tell which of several
 * profile files it came from.
 */
export async function readProfile(profilePath: string): Promise<unknown> {
  const text = await readFile(profilePath, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `The profile at ${profilePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

  if (result.subPath !== undefined) {
    // The enumeration above is always full; only the counts are of a filtered
    // subset. Printed alone, the Files/Folders line reads as the size of the
    // whole drive, so the unfiltered totals are given right alongside it.
    lines.push(
      `Sub-path filter applied: ${result.subPath}. The counts above are within it; the drive as a ` +
        `whole holds ${result.unfilteredFileCount} files and ${result.unfilteredFolderCount} folders.`,
    );
  }

  // changesFromDeltaItems records `item.eTag ?? ""` and `item.lastModifiedDateTime ?? ""` the
  // same way, so a missing modified date is the same gap as a missing ETag and is reported the
  // same way: named only when there is something to report.
  const withoutEtag = result.snapshot.files.filter((file) => file.etag === "").length;
  const withoutModified = result.snapshot.files.filter((file) => file.modified === "").length;
  if (withoutEtag > 0 || withoutModified > 0) {
    // A count of one is the common case for both gaps, so the verb agrees with
    // the count rather than assuming the plural.
    const carry = (count: number): string => (count === 1 ? "carries" : "carry");
    const gaps = [
      withoutEtag > 0 ? `${withoutEtag} ${carry(withoutEtag)} no ETag` : undefined,
      withoutModified > 0 ? `${withoutModified} ${carry(withoutModified)} no modified date` : undefined,
    ].filter((gap): gap is string => gap !== undefined);

    lines.push(
      `Of those files, ${gaps.join(", and ")}. Graph did not report ${gaps.length > 1 ? "those values" : "one"}, ` +
        "and this snapshot stores an empty string rather than marking the value absent, so a " +
        "later plan that uses an ETag as a precondition, or a report that reads the modified " +
        "date, cannot tell those files apart from ones with a real value.",
    );
  }

  lines.push(
    `Graph requests: ${result.graphRequests}. Delta pages: ${result.pages}.`,
    `Store: ${storeKind}. Changes applied: ${result.changesApplied}. ` +
      `Write operations from applying those changes: ${result.storeBatches}.`,
    `Scanned at: ${result.snapshot.scannedAt}.`,
  );

  if (result.resynced) {
    lines.push(
      "This run resynced: the stored deltaLink was no longer valid, so the stored inventory was " +
        "discarded and the drive enumerated from scratch. That is why this run cost a full " +
        "enumeration rather than an incremental one. The writes that cleared the stale inventory " +
        "before this enumeration began are not included in the write-operations count above, and " +
        "on a large library they are its single largest write cost.",
    );
  }

  if (storeKind === "in-memory") {
    lines.push(
      "No storage account was configured, so this run used the in-memory store and nothing was " +
        "persisted. The next run will enumerate in full. Set IW_TABLE_CONNECTION_STRING to keep " +
        "the inventory between runs.",
    );
  }

  // `searchCrossCheckSkipReason` absent means `crossCheckOtherLibraries` completed, per its own
  // contract (see ScanResult's own comment on the field): every reachable way for it to have
  // never run at all is itself one of the five named reasons, so there is no third state here
  // to guess at, unlike the reconciliation tool's own provenance.
  if (result.searchCrossCheckSkipReason === undefined) {
    lines.push("The Microsoft Search cross-check completed.");
  } else {
    const cause = describeCrossCheckSkipReason(result.searchCrossCheckSkipReason);
    // A cross-check that never sent a request leaves every other library
    // completely unseen; one that ran but did not finish still leaves this
    // snapshot with whatever it found before it stopped. Those are different
    // situations for an operator deciding whether to trust a "missing" file,
    // so they get different consequence sentences rather than one written to
    // cover both.
    const consequence = crossCheckNeverAttempted(result.searchCrossCheckSkipReason)
      ? "Without it, a correctly named file filed into a different document library of the same " +
        "site is invisible to this snapshot."
      : "Because it did not complete, this snapshot may be missing a correctly named file filed " +
        "into a document library, or a part of one, this cross-check did not reach.";

    lines.push(`${cause} ${consequence}`);
  }

  return lines;
}
