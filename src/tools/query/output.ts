import { z } from "zod";

/**
 * The three stored questions this tool answers, shared between the input
 * schema and the output schema so the closed set is written down once. A
 * caller enumerates these two questions, `naming_violations` and
 * `recent_reports`, over what the index already holds; adding a fourth
 * question is a separate design decision, not a value dropped into this list.
 */
export const QUESTIONS = ["empty_folders", "naming_violations", "recent_reports"] as const;

export type Question = (typeof QUESTIONS)[number];

/**
 * The most findings one call returns. Findings serialize to a small, roughly
 * fixed number of bytes each, so this keeps a pathologically disorganized
 * library from producing an unbounded response. `totals.findings` is never
 * abridged: it is computed over the complete result set before this cap is
 * applied, and the listing is cut only afterward.
 */
export const MAX_QUERY_FINDINGS = 200;

export interface Finding {
  path: string;
  name: string;
  /** Absent for a folder, which carries no modified date of its own. */
  modified?: string;
  detail: string;
}

/**
 * Declared as a raw shape rather than a `z.object`, because that is what
 * `ToolDefinition.outputSchema` and the SDK's `registerTool` both take.
 */
export const QUERY_OUTPUT_SCHEMA = {
  profileId: z.string().describe("The profile this answer was computed for."),
  library: z.string().describe("The document library named by the profile's identity."),
  question: z.enum(QUESTIONS).describe("Which stored question this answer is for, for example \"empty_folders\"."),
  driveId: z
    .string()
    .describe("The drive the answer was read from: the profile's most recently scanned drive, chosen without calling Graph."),
  scannedAt: z
    .string()
    .describe("When the underlying inventory snapshot was taken. This answer is current only as of that scan."),
  totals: z
    .object({ findings: z.number().int() })
    .describe("Computed over the complete result set before the listing below is cut. Never abridged."),
  findings: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        modified: z.string().optional().describe("Absent for a folder, which has no modified date of its own."),
        detail: z.string(),
      }),
    )
    .describe("May be a prefix of the full set totals.findings describes; see listing."),
  listing: z
    .object({
      returned: z.number().int(),
      omitted: z.number().int(),
      cap: z.number().int(),
      truncated: z.boolean(),
    })
    .describe("What survived the cap, and how much did not. `omitted` and `truncated` describe the listing, not the totals."),
  graphRequests: z
    .number()
    .int()
    .describe("Always zero. This tool answers from the stored index and never calls Microsoft Graph, on any input."),
} satisfies z.ZodRawShape;

/**
 * Hand-declared rather than inferred from `QUERY_OUTPUT_SCHEMA` with
 * `z.infer`, matching `InventoryToolOutput` and `ReconcileToolOutput`: a
 * value built only to be read through `typeof` in a type position has no
 * runtime use, and this repo's lint configuration treats that as the unused
 * variable it is.
 */
export interface QueryToolOutput {
  profileId: string;
  library: string;
  question: Question;
  driveId: string;
  scannedAt: string;
  totals: { findings: number };
  findings: Finding[];
  listing: { returned: number; omitted: number; cap: number; truncated: boolean };
  graphRequests: number;
}
