import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { shapeInventory } from "./shape.js";
import { inventoryText } from "./text.js";

export const INVENTORY_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to inventory, for example \"example\"."),
  subPath: z
    .string()
    .optional()
    .describe("Library-relative path to limit the scan, for example \"2026/CLIENTA\". Omit to scan the whole library."),
} satisfies z.ZodRawShape;

const InputObject = z.object(INVENTORY_INPUT_SCHEMA);

/**
 * The tool's composition root: resolve the profile, run (or join) the shared
 * scan, and shape what comes back. Mirrors `runReconcile`'s shape exactly,
 * including logging the error before describing it.
 *
 * There is no workbook to read here, unlike reconciliation, so this call has
 * only the one dependency to sequence: `context.scans.run`, which itself
 * either starts a scan or joins one already in flight.
 */
export async function runInventoryTree(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "inventory_tree", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    const scan = await context.scans.run(profile);
    // A joiner reads the same inventory another call already paid to build,
    // so it issued no Graph request of its own; reporting the shared result's
    // own count here would bill this call for work it did not do.
    const graphRequests = scan.joined ? 0 : scan.result.graphRequests;

    const output = shapeInventory(
      args.profileId,
      profile.identity.library,
      scan.result.snapshot,
      args.subPath,
      graphRequests,
      scan.joined,
      {},
    );

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: inventoryText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log and a message may
    // not promise what this function did not do.
    console.error(`inventory_tree failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
