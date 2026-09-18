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
 * No Graph client is touched on any path through this function. The drive id
 * comes from the store rather than from `resolveDrive`, which is the whole
 * reason `getScannedDrives` exists.
 */
async function loadSnapshot(context: ToolContext, profile: Profile): Promise<{ snapshot: RepositorySnapshot; driveId: string }> {
  const drives = await context.store.getScannedDrives(profile.profileId);
  if (drives.length === 0) throw new NeverScannedError(profile.profileId);

  // A profile names one library, so more than one row means the profile was
  // repointed after a scan. The newest wins and the response names the drive
  // it used, because mixing two libraries' inventories would be worse than
  // either choice.
  const chosen = [...drives].sort((a, b) => (a.lastScanAt < b.lastScanAt ? 1 : -1))[0]!;
  const records = await context.store.listInventory(profile.profileId, chosen.driveId);
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
 * without spending a new request against SharePoint.
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
