import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { reconcile, type Period, type WorkbookSnapshot } from "../../domain/reconcile/index.js";
import type { Profile } from "../../domain/profile/schema.js";
import type { GraphClient } from "../../graph/client.js";
import { readWorkbookSnapshot } from "../../scan/workbook.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { scanProvenance, shapeReport } from "./shape.js";
import { reconcileText } from "./text.js";

export const RECONCILE_INPUT_SCHEMA = {
  profileId: z.string().min(1).describe("Configured profile to reconcile, for example \"example\"."),
  clients: z
    .array(z.string().min(1))
    .optional()
    .describe("Limit the report to these clients, for example [\"CLIENTA\"]. Omit to cover every client in the workbook."),
} satisfies z.ZodRawShape;

const InputObject = z.object(RECONCILE_INPUT_SCHEMA);

/**
 * The reference month the rolling window ends at, read in UTC.
 *
 * The engine takes this as an argument and never reads a clock, which is what
 * lets a report be reproduced from its own inputs. UTC rather than local time
 * because the host's timezone is not part of the answer and a report must not
 * depend on which region the container runs in. For a few hours around a month
 * boundary the window therefore advances before a negative-offset operator's
 * own calendar does, which the resolved window in the report makes visible.
 */
export function periodFromDate(date: Date): Period {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

type ReadWorkbook = (client: GraphClient, profile: Profile) => Promise<WorkbookSnapshot>;

/**
 * The tool's composition root: resolve the profile, read the workbook, scan the
 * repository, run the finished engine, and shape what comes back.
 *
 * The workbook is read before the scan deliberately. The two are independent
 * and could run concurrently, but a stale mapping is both the likeliest failure
 * of the pair and the cheapest to detect, and reading it first means an
 * operator whose mapping points at a renamed column learns that immediately
 * rather than after paying for a full library enumeration.
 */
export async function runReconcile(
  input: unknown,
  context: ToolContext,
  // Injected only by tests. Production always uses `readWorkbookSnapshot`.
  readWorkbook: ReadWorkbook = readWorkbookSnapshot,
): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  const subject: FailureSubject = { tool: "reconcile_workbook_vs_repository", profileId: args.profileId };

  try {
    const profile = context.profiles.get(args.profileId);
    subject.siteUrl = profile.identity.siteUrl;
    subject.library = profile.identity.library;

    // Bracketed the way `src/scan/run.ts` and `describe_workbook` bracket
    // the same counter. It lives on the per-process client, so reading it
    // raw would answer what the process has spent since it started; the
    // delta across this one call is what the report promises. Measured
    // rather than asserted as a constant, so an injected reader that issues
    // no request reports none and a future reader that pays more reports
    // that instead.
    const requestsBeforeWorkbook = context.graph.requests();
    const workbook = await readWorkbook(context.graph, profile);
    const workbookReadGraphRequestsByThisCall = context.graph.requests() - requestsBeforeWorkbook;

    const scan = await context.scans.run(profile);

    const report = reconcile(profile, workbook, scan.result.snapshot, periodFromDate(context.now()));
    const output = shapeReport(
      report,
      { ...scanProvenance(scan.result, scan.joined), workbookReadGraphRequestsByThisCall },
      { ...(args.clients === undefined ? {} : { clients: args.clients }) },
    );

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: reconcileText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, because `describeToolFailure` tells the
    // operator the full Graph response is in the server log and a message may
    // not promise what this function did not do.
    console.error(`reconcile_workbook_vs_repository failed for profile "${args.profileId}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
