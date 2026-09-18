import { z } from "zod";

/**
 * The most clients one call lists in `clients`, and also the most entries one
 * client's own `nonConformingFolders` or `nonConformingFiles` carries. The two
 * caps share one constant deliberately: both bound the same kind of thing, a
 * list of paths in a response nobody has measured, and giving each its own
 * number would invite them to drift apart for no reason either was chosen.
 * `totals` is never abridged: it is computed over every client evaluated
 * before either cap is applied.
 */
export const MAX_CLIENT_DETAIL = 50;

export const VALIDATE_STRUCTURE_VERDICTS = ["compliant", "non_compliant", "missing"] as const;

export type ValidateStructureVerdict = (typeof VALIDATE_STRUCTURE_VERDICTS)[number];

export interface NonConformingFile {
  path: string;
  /** Names the filename template or the recognizer count, exactly as query_repository's namingViolations does. */
  reason: string;
}

export interface ClientValidation {
  client: string;
  verdict: ValidateStructureVerdict;
  /** May be a prefix of the client's full set; see nonConformingFoldersOmitted. */
  nonConformingFolders: string[];
  nonConformingFoldersOmitted: number;
  /** May be a prefix of the client's full set; see nonConformingFilesOmitted. */
  nonConformingFiles: NonConformingFile[];
  nonConformingFilesOmitted: number;
}

/**
 * Declared as a raw shape rather than a `z.object`, because that is what
 * `ToolDefinition.outputSchema` and the SDK's `registerTool` both take.
 */
export const VALIDATE_STRUCTURE_OUTPUT_SCHEMA = {
  profileId: z.string().describe("The profile this validation was computed against."),
  library: z.string().describe("The document library named by the profile's identity."),
  scannedAt: z
    .string()
    .describe("When the underlying repository scan was taken. This answer is current only as of that scan."),
  totals: z
    .object({
      clients: z.number().int(),
      compliant: z.number().int(),
      nonCompliant: z.number().int(),
      missing: z.number().int(),
    })
    .describe("Computed over every client evaluated, before the client listing below is cut. Never abridged."),
  clients: z
    .array(
      z.object({
        client: z.string(),
        verdict: z.enum(VALIDATE_STRUCTURE_VERDICTS),
        nonConformingFolders: z
          .array(z.string())
          .describe("Folders under this client matching no renderable taxonomy path. May be a prefix; see nonConformingFoldersOmitted."),
        nonConformingFoldersOmitted: z.number().int(),
        nonConformingFiles: z
          .array(z.object({ path: z.string(), reason: z.string() }))
          .describe("Files under this client that do not parse against the filename standard. May be a prefix; see nonConformingFilesOmitted."),
        nonConformingFilesOmitted: z.number().int(),
      }),
    )
    .describe(
      "Sorted by client name. May be a prefix of the full set totals describes; see listing. missing is reachable " +
        "only for a client named explicitly in the request with no folder present at all. A compliant verdict here " +
        "means conformance of what exists, that every folder and file found under the client is shaped correctly; " +
        "it is not completeness of what the client owes, which needs the workbook and belongs to " +
        "reconcile_workbook_vs_repository, whose per-client counts hold that other half.",
    ),
  listing: z
    .object({
      returned: z.number().int(),
      omitted: z.number().int(),
      cap: z.number().int(),
      truncated: z.boolean(),
    })
    .describe("What survived the cap on the client list itself, and how much did not. Describes the listing, not the totals."),
  graphRequests: z
    .number()
    .int()
    .describe("What this call itself paid. Zero when this call joined a scan another call had already started."),
  scanSharedWithConcurrentCall: z
    .boolean()
    .describe(
      "True when this call awaited a scan another call had already started, which is the only reason graphRequests can be zero here. Without it a zero is ambiguous: query_repository reports zero because it never calls Graph at all, and this tool always does unless it shared someone else's call.",
    ),
} satisfies z.ZodRawShape;

/**
 * Hand-declared rather than inferred from `VALIDATE_STRUCTURE_OUTPUT_SCHEMA`
 * with `z.infer`, matching `QueryToolOutput` and `InventoryToolOutput`: a
 * value built only to be read through `typeof` in a type position has no
 * runtime use, and this repo's lint configuration treats that as the unused
 * variable it is.
 */
export interface ValidateStructureOutput {
  profileId: string;
  library: string;
  scannedAt: string;
  totals: { clients: number; compliant: number; nonCompliant: number; missing: number };
  clients: ClientValidation[];
  listing: { returned: number; omitted: number; cap: number; truncated: boolean };
  graphRequests: number;
  scanSharedWithConcurrentCall: boolean;
}
