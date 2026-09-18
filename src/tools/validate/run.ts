import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { clientSegmentIndex, shapeValidateStructure } from "./shape.js";
import { validateStructureText } from "./text.js";

export const VALIDATE_STRUCTURE_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to validate against, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Clients to validate, for example [\"CLIENTA\"]. Omit to validate every client folder present in the library."),
} satisfies z.ZodRawShape;

const InputObject = z.object(VALIDATE_STRUCTURE_INPUT_SCHEMA);

/**
 * Raised before any scan runs. A taxonomy with no `{client}` segment has no
 * per-client structure for this tool to check, and running the scan anyway
 * would produce an empty client list that reads as a clean bill of health
 * rather than as this tool being unable to answer the question at all.
 */
export class NoClientSegmentError extends Error {
  constructor(profileId: string, segments: readonly string[]) {
    super(
      `Profile "${profileId}"'s taxonomy has no {client} segment: its segments are ` +
        `${segments.map((segment) => `"${segment}"`).join(", ")}. validate_structure has no per-client structure to ` +
        "check against a taxonomy that never names a client.",
    );
    this.name = "NoClientSegmentError";
  }
}

/**
 * The tool's composition root: resolve the profile, refuse a taxonomy this
 * tool cannot evaluate per client, run (or join) the shared scan, and shape
 * what comes back. Mirrors `runInventoryTree`'s shape, with one extra refusal
 * ahead of the scan.
 *
 * This tool checks conformance only: whether what exists is shaped correctly.
 * It never reads the workbook and so never asks whether everything a client
 * owes is present; that completeness question belongs to
 * `reconcile_workbook_vs_repository`, which holds the workbook.
 */
export async function runValidateStructure(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "validate_structure", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    if (clientSegmentIndex(profile) < 0) {
      throw new NoClientSegmentError(profile.profileId, profile.taxonomy.segments);
    }

    const scan = await context.scans.run(profile);
    // A joiner reads the same inventory another call already paid to build,
    // so it issued no Graph request of its own; reporting the shared result's
    // own count here would bill this call for work it did not do.
    const graphRequests = scan.joined ? 0 : scan.result.graphRequests;

    const output = shapeValidateStructure(
      args.profileId,
      profile.identity.library,
      profile,
      scan.result.snapshot,
      args.clients,
      graphRequests,
      {},
    );

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: validateStructureText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, matching runInventoryTree and
    // runQueryRepository: an operator reading the message is told the full
    // detail is in the server log rather than promised something this
    // function did not do.
    console.error(`validate_structure failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
