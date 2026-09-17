import { z } from "zod";
import type {
  ArtifactFinding,
  ClientSummary,
  DuplicateFinding,
  OrphanFinding,
  Period,
  RejectedWorkbookRow,
} from "../../domain/reconcile/index.js";
import type { CrossCheckSkipReason } from "../../scan/cross-check.js";

/**
 * The most non-compliant artifact findings one call returns.
 *
 * Findings serialize to roughly 200 bytes each, so 200 of them is on the order
 * of 40 KB, which leaves room for the per-client rollup and the orphan lists
 * alongside it. A report that trips this cap describes a repository in such
 * wholesale disrepair that the per-client counts, which are never truncated,
 * are the useful answer and an enumeration of the first several hundred
 * failures is not.
 *
 * No tool input overrides it. A caller who raises the cap to avoid truncation
 * has removed the only bound on a payload nobody measured.
 */
export const MAX_ARTIFACT_FINDINGS = 200;

/** What this call, specifically, paid for the repository snapshot behind the report. */
export interface ScanProvenance {
  scanMode: "full" | "incremental";
  resynced: boolean;
  /**
   * Named for the call rather than for the scan because those differ. A call
   * that joined a scan another call started reads the same inventory and paid
   * nothing for it, and a field called `graphRequests` on both reports would
   * have two calls claiming one scan's cost.
   */
  graphRequestsByThisCall: number;
  scanSharedWithConcurrentCall: boolean;
  /**
   * Present only when the Search cross-check did not complete, naming why.
   * `crossCheckOtherLibraries` always names one of the four reasons whenever
   * it does not complete, "no-region" included, so absent means the
   * cross-check completed rather than "completed or never ran": every
   * reachable way for it to have never run at all, such as the profile
   * carrying no searchRegion, is itself one of the four named reasons.
   */
  searchCrossCheckSkipReason?: CrossCheckSkipReason;
  /**
   * What this call's own cross-check spent, kept apart from
   * `graphRequestsByThisCall` rather than summed into it. That field is the
   * figure `docs/OPEN-ITEMS.md` records a live baseline for, and folding the
   * cross-check's traffic into it would make an incremental scan against a
   * profile with `searchRegion` configured report a materially larger number
   * for a reason that has nothing to do with the delta enumeration.
   *
   * Absent, like `graphRequestsByThisCall` being zeroed, when this call
   * joined a scan another call ran: a joiner paid nothing of its own for the
   * cross-check either. Also absent when no cross-check was attempted at
   * all, for the same reason it is never reported as zero on `ScanResult`.
   */
  searchCrossCheckGraphRequestsByThisCall?: number;
}

export interface ReconcileToolOutput {
  profileId: string;
  window: { from: Period; to: Period };
  provenance: {
    scannedAt: string;
    workbookSource: string;
    searchCrossCheckIncluded: boolean;
  } & ScanProvenance;
  scope: {
    /** The clients the caller narrowed to, or null when the report covers every client. */
    clients: string[] | null;
    /** Clients the caller named that the workbook does not track. */
    unknownClients: string[];
    /**
     * True whenever a filter is applied. Unrecognized orphans and empty folders
     * are attributable to no client, so they are still repository-wide and a
     * reader must not take them as scoped to the filter.
     */
    unattributableFindingsRepositoryWide: boolean;
  };
  clients: ClientSummary[];
  /** Non-compliant findings only, capped. The counts in `clients` are never abridged. */
  artifacts: ArtifactFinding[];
  compliantArtifactsOmitted: number;
  artifactsOmittedByCap: number;
  duplicates: DuplicateFinding[];
  orphans: OrphanFinding[];
  emptyFolders: string[];
  rejectedWorkbookRows: RejectedWorkbookRow[];
}

const PeriodSchema = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) });

const SlotSchema = z.object({
  client: z.string(),
  deliverable: z.string(),
  period: PeriodSchema,
});

const ArtifactStateSchema = z.enum(["compliant", "misnamed", "misplaced", "misnamed_and_misplaced", "missing"]);

const ArtifactSchema = SlotSchema.extend({
  expectedPath: z.string(),
  expectedName: z.string(),
  state: ArtifactStateSchema,
  matched: z
    .object({
      path: z.string(),
      name: z.string(),
      etag: z.string(),
      recognizerId: z.string().optional(),
      library: z
        .string()
        .optional()
        .describe(
          "The document library this file was actually found in, present only when it is not the profile's own library. A misplaced or misnamed_and_misplaced finding with this set was found by the Microsoft Search cross-check in another library on the same site, not inside the profile's own library.",
        ),
    })
    .optional(),
});

/**
 * Declared as a raw shape rather than a `z.object`, because that is what
 * `ToolDefinition.outputSchema` and the SDK's `registerTool` both take.
 */
export const RECONCILE_OUTPUT_SCHEMA = {
  profileId: z.string().describe("The profile this report was computed for."),
  window: z
    .object({ from: PeriodSchema, to: PeriodSchema })
    .describe("The rolling window the report covers, resolved from the profile and the month it ran in."),
  provenance: z
    .object({
      scannedAt: z.string(),
      workbookSource: z.string(),
      searchCrossCheckIncluded: z
        .boolean()
        .describe(
          "False when the Microsoft Search cross-check did not run to completion. A misplaced finding within the profile's own library is reliable either way, since the whole-drive scan already finds it. What stays invisible while this is false is a correctly named file filed into a different document library of the same site, so a finding reported missing may in fact exist there.",
        ),
      scanMode: z.enum(["full", "incremental"]),
      resynced: z.boolean(),
      graphRequestsByThisCall: z.number().int(),
      scanSharedWithConcurrentCall: z.boolean(),
      searchCrossCheckSkipReason: z
        .enum(["no-region", "search-failed", "library-not-addressable", "page-cap-reached"])
        .optional()
        .describe(
          "Present only when the Search cross-check did not complete, naming why. Every way it can fail to run at all, including the profile carrying no searchRegion, is itself one of these named reasons, so absent means it completed.",
        ),
      searchCrossCheckGraphRequestsByThisCall: z
        .number()
        .int()
        .optional()
        .describe(
          "What this call's own Search cross-check spent, kept separate from graphRequestsByThisCall so that figure keeps meaning the delta enumeration's cost alone. Absent when this call joined another call's scan or when no cross-check was attempted.",
        ),
    })
    .describe("Where the two inputs came from, and what this call paid for them."),
  scope: z
    .object({
      clients: z.array(z.string()).nullable(),
      unknownClients: z.array(z.string()),
      unattributableFindingsRepositoryWide: z.boolean(),
    })
    .describe("What the report was narrowed to, and what stayed repository-wide despite the filter."),
  clients: z
    .array(
      z.object({
        client: z.string(),
        counts: z.record(ArtifactStateSchema, z.number().int()),
        compliant: z.boolean(),
      }),
    )
    .describe(
      "Every client in scope with complete counts. Never abridged, and the authoritative answer to whether a client is compliant.",
    ),
  artifacts: z
    .array(ArtifactSchema)
    .describe("Non-compliant findings only. Compliant rows are omitted because the counts above already carry them."),
  compliantArtifactsOmitted: z.number().int().describe("How many compliant findings in scope were left out of `artifacts`."),
  artifactsOmittedByCap: z.number().int().describe("How many non-compliant findings in scope exceeded the cap and were left out."),
  duplicates: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        slot: SlotSchema,
        state: z.enum(["compliant", "misnamed", "misplaced", "misnamed_and_misplaced"]),
        library: z
          .string()
          .optional()
          .describe("Same meaning as an artifact's matched.library: present when this copy was found in another document library."),
      }),
    )
    .describe("Extra files that also satisfy a slot already claimed by a better candidate."),
  orphans: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.enum(["unrecognized", "unexpected"]),
        parsed: SlotSchema.optional(),
      }),
    )
    .describe("Files with no slot in this report. Unrecognized ones are repository-wide even when a client filter is applied."),
  emptyFolders: z
    .array(z.string())
    .describe("Folders holding no files anywhere beneath them. Repository-wide even when a client filter is applied."),
  rejectedWorkbookRows: z
    .array(z.object({ row: z.number().int(), client: z.string().optional(), reason: z.string() }))
    .describe("Workbook rows the reader could not turn into records. A client missing from this report may be here instead."),
} satisfies z.ZodRawShape;
