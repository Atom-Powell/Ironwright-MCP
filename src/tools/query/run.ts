import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Profile } from "../../domain/profile/schema.js";
import {
  createFileParser,
  findEmptyFolders,
  type ParsedFile,
  type ParsedFileRecognized,
  type RepositoryFile,
  type RepositorySnapshot,
} from "../../domain/reconcile/index.js";
import { assembleSnapshot } from "../../scan/snapshot.js";
import type { ScannedDrive } from "../../store/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { QUESTIONS, type Finding, type Question } from "./output.js";
import { shapeQuery } from "./shape.js";
import { queryText } from "./text.js";

export const RECENT_REPORTS_LIMIT = 50;

export const QUERY_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to query, for example \"example\"."),
  question: z.enum(QUESTIONS).describe("Which stored question to answer, for example \"empty_folders\"."),
} satisfies z.ZodRawShape;

const InputObject = z.object(QUERY_INPUT_SCHEMA);

/**
 * Raised instead of answering with zero findings when a profile's index has
 * never been populated. An empty result and no evidence are different
 * answers, and this tool must never report the second as the first: the two
 * tools named here are the only ways to populate the store this tool reads.
 */
export class NeverScannedError extends Error {
  constructor(profileId: string) {
    super(
      `Profile "${profileId}" has no stored inventory to query yet. Run inventory_tree or ` +
        "reconcile_workbook_vs_repository first, either of which populates the index this tool reads from.",
    );
    this.name = "NeverScannedError";
  }
}

/**
 * Raised instead of answering when a scan this call waited on failed. A scan
 * that fails partway through a resync has already called `clearInventory` and
 * may have stopped before rebuilding, and what is left in the store then looks
 * exactly like a smaller library rather than like a broken one. Answering from
 * it would under-report every question this tool asks while stamping the reply
 * with the previous scan's `lastScanAt`, which is the same substitution of a
 * confident answer for absent evidence that `NeverScannedError` refuses.
 */
export class ConcurrentScanFailedError extends Error {
  constructor(profileId: string) {
    super(
      `A scan of profile "${profileId}" was already running when this call started, and it failed. That scan may ` +
        "have cleared the stored inventory to re-enumerate and stopped before rebuilding it, so what remains " +
        "cannot be told apart from a library that holds only those items. Run inventory_tree or " +
        "reconcile_workbook_vs_repository to rebuild the index, then query it again.",
    );
    this.name = "ConcurrentScanFailedError";
  }
}

/**
 * Raised instead of answering when a scan began while this call was reading the
 * store. `ScanCoordinator.settle` closes the window that was open when this
 * call started; it cannot close the one that opens afterwards, because there
 * was nothing in flight to wait for. The counter reading either side of the
 * two store reads is what makes that window observable rather than silent.
 */
export class ConcurrentScanStartedError extends Error {
  constructor(profileId: string) {
    super(
      `A scan of profile "${profileId}" started while this call was reading the stored inventory, so the records ` +
        "it read may be a partially rebuilt index rather than the whole library. This call refuses to answer from " +
        "them rather than under-report. Call query_repository again once the scan has finished.",
    );
    this.name = "ConcurrentScanStartedError";
  }
}

/**
 * Newest scan first, with the drive id breaking a tie, so the order is total.
 * Returning a fixed non-zero value for two equal `lastScanAt` values leaves
 * the winner to whatever order the store happened to enumerate rows in, and
 * two drives scanned inside the same millisecond are reachable: `runScan`
 * stamps `scannedAt` from one `now()` call per scan, and two scans of a
 * repointed profile can land on the same ISO timestamp. The response names the
 * drive it used, so an unspecified winner would let two calls with identical
 * inputs name different drives. This is the same reason `supersedes` in
 * `src/domain/reconcile/index.ts` carries tiebreak keys past the one key that
 * expresses a preference.
 */
function compareDrivesNewestFirst(a: ScannedDrive, b: ScannedDrive): number {
  if (a.lastScanAt !== b.lastScanAt) return a.lastScanAt < b.lastScanAt ? 1 : -1;
  if (a.driveId !== b.driveId) return a.driveId < b.driveId ? 1 : -1;
  return 0;
}

/**
 * No Graph client is touched on any path through this function. The drive id
 * comes from the store rather than from `resolveDrive`, which is the whole
 * reason `getScannedDrives` exists.
 *
 * It does go through `ScanCoordinator` before reading, which is the one thing
 * this tool's zero-request promise does not excuse it from. `runScan` answers
 * a delta resync by clearing the inventory and re-enumerating, persisting the
 * new `lastScanAt` only at the end, so a read taken inside that window returns
 * a cleared or half-rebuilt inventory carrying the previous scan's timestamp:
 * an under-report stamped with a freshness the evidence no longer has. Waiting
 * on an in-flight scan costs this call no Graph request of its own, so the
 * property the tool advertises survives intact.
 */
async function loadSnapshot(context: ToolContext, profile: Profile): Promise<{ snapshot: RepositorySnapshot; driveId: string }> {
  // Taken before `settle` is awaited, not after. `settle`'s own `await` is a
  // microtask checkpoint: a scan can start inside it, either while this call
  // is waiting on one already in flight or in the gap after that scan clears
  // `inFlight` but before `settle`'s continuation resumes. A baseline read
  // after the await would already count that scan, so the guard below would
  // compare the counter to itself and pass while the scan is still live
  // across both store reads. Reading first means any scan already in flight
  // on entry is already included here, so `settle` waiting for it does not
  // move the count, while anything that starts during or after `settle` is
  // still caught by the second reading.
  const startedBeforeRead = context.scans.scansStarted(profile);

  const settled = await context.scans.settle(profile);
  if (settled.failed) throw new ConcurrentScanFailedError(profile.profileId);

  const drives = await context.store.getScannedDrives(profile.profileId);
  if (drives.length === 0) throw new NeverScannedError(profile.profileId);

  // A profile names one library, so more than one row means the profile was
  // repointed after a scan. The newest wins and the response names the drive
  // it used, because mixing two libraries' inventories would be worse than
  // either choice.
  const chosen = [...drives].sort(compareDrivesNewestFirst)[0]!;
  const records = await context.store.listInventory(profile.profileId, chosen.driveId);

  if (context.scans.scansStarted(profile) !== startedBeforeRead) {
    throw new ConcurrentScanStartedError(profile.profileId);
  }

  return { snapshot: assembleSnapshot(records, chosen.lastScanAt), driveId: chosen.driveId };
}

function emptyFolders(snapshot: RepositorySnapshot): Finding[] {
  return findEmptyFolders(snapshot).map((path) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    detail: "No file or deeper folder sits under this folder.",
  }));
}

function namingViolations(profile: Profile, snapshot: RepositorySnapshot): Finding[] {
  const parse = createFileParser(profile);
  return snapshot.files
    .filter((file) => file.library === undefined)
    .filter((file) => !parse(file).recognized)
    .map((file) => ({
      path: file.path,
      name: file.name,
      modified: file.modified,
      detail: `This name does not match the profile's filename template "${profile.naming.template}" or any of its ${profile.naming.recognizers.length} recognizers.`,
    }));
}

/**
 * A recognized file paired with its own parse result, narrowed by a type
 * predicate rather than a cast: the predicate is the same length as a cast
 * through `ParsedFileRecognized` would be, and it lets the compiler, not the
 * author, confirm the narrowing actually holds.
 */
interface RecognizedEntry {
  file: RepositoryFile;
  parsed: ParsedFileRecognized;
}

function isRecognizedEntry(entry: { file: RepositoryFile; parsed: ParsedFile }): entry is RecognizedEntry {
  return entry.parsed.recognized;
}

function recentReports(profile: Profile, snapshot: RepositorySnapshot): Finding[] {
  const parse = createFileParser(profile);
  return snapshot.files
    .filter((file) => file.library === undefined)
    .map((file) => ({ file, parsed: parse(file) }))
    .filter(isRecognizedEntry)
    .sort((a, b) => (a.file.modified < b.file.modified ? 1 : -1))
    .slice(0, RECENT_REPORTS_LIMIT)
    .map((entry) => ({
      path: entry.file.path,
      name: entry.file.name,
      modified: entry.file.modified,
      detail: `Parsed as the ${entry.parsed.deliverable} deliverable.`,
    }));
}

function answer(question: Question, profile: Profile, snapshot: RepositorySnapshot): Finding[] {
  switch (question) {
    case "empty_folders":
      return emptyFolders(snapshot);
    case "naming_violations":
      return namingViolations(profile, snapshot);
    case "recent_reports":
      return recentReports(profile, snapshot);
  }
}

/**
 * The tool's composition root. Every path through this function reads the
 * store and nothing else: it never calls `context.scans.run` and never calls
 * `resolveDrive`, both of which are Graph-facing, because this tool's whole
 * reason for existing is to answer from what a prior scan already stored
 * without spending a new request against SharePoint. `ScanCoordinator.settle`
 * and `scansStarted`, which `loadSnapshot` does use, start no scan and issue
 * no request; they only wait and count.
 */
export async function runQueryRepository(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "query_repository", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const { snapshot, driveId } = await loadSnapshot(context, profile);
    const findings = answer(args.question, profile, snapshot);

    const output = shapeQuery(
      args.profileId,
      profile.identity.library,
      args.question,
      driveId,
      snapshot.scannedAt,
      findings,
      {},
    );

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: queryText(output, context.now()).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, matching runInventoryTree and
    // runReconcile: an operator reading the message is told the full detail
    // is in the server log rather than promised something this function did
    // not do.
    console.error(`query_repository failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
