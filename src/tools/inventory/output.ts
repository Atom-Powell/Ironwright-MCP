import { z } from "zod";

/**
 * The most items one call lists in `items`. `totals` is never abridged: it is
 * computed over the complete filtered set before this cap is applied, and the
 * listing is cut only afterwards. Exported because `shape.ts` enforces the cap
 * and both modules must agree on the same number rather than each carrying
 * their own copy of it.
 */
export const MAX_INVENTORY_ITEMS = 500;

/**
 * Declared as a raw shape rather than a `z.object`, because that is what
 * `ToolDefinition.outputSchema` and the SDK's `registerTool` both take.
 */
export const INVENTORY_OUTPUT_SCHEMA = {
  profileId: z.string().describe("The profile this inventory was taken from."),
  library: z.string().describe("The document library named by the profile's identity."),
  subPath: z.string().optional().describe("The library-relative path the request was narrowed to, when one was given."),
  scannedAt: z.string(),
  totals: z
    .object({ files: z.number().int(), folders: z.number().int(), bytes: z.number().int() })
    .describe("Computed over the whole filtered set before the listing below is cut. Never abridged."),
  items: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.enum(["file", "folder"]),
        size: z.number().int().optional().describe("Absent for a folder, which has no size of its own."),
        modified: z
          .string()
          .optional()
          .describe(
            "Absent for a folder. The snapshot carries no modified date for a folder, only for a file, so this is left off rather than filled with the scan time, which is not the folder's own date.",
          ),
      }),
    )
    .describe("Sorted by path. May be a prefix of the full set the totals above describe; see listing."),
  listing: z
    .object({
      returned: z.number().int(),
      omitted: z.number().int(),
      cap: z.number().int(),
      truncated: z.boolean(),
    })
    .describe("What survived the cap, and how much did not. `omitted` and `truncated` describe the listing, not the totals."),
  graphRequests: z.number().int().describe("What this call itself paid. Zero when this call joined a scan another call had already started."),
  scanSharedWithConcurrentCall: z
    .boolean()
    .describe(
      "True when this call awaited a scan another call had already started, which is the only reason graphRequests can be zero here. Without it a zero is ambiguous: query_repository reports zero because it never calls Graph at all, and this tool always does unless it shared someone else's call.",
    ),
} satisfies z.ZodRawShape;

/**
 * Hand-declared rather than inferred from `INVENTORY_OUTPUT_SCHEMA` with
 * `z.infer`, matching `ReconcileToolOutput`: a value built only to be read
 * through `typeof` in a type position has no runtime use, and this repo's
 * lint configuration treats that as the unused variable it is.
 */
export interface InventoryToolOutput {
  profileId: string;
  library: string;
  subPath?: string;
  scannedAt: string;
  totals: { files: number; folders: number; bytes: number };
  items: Array<{
    path: string;
    name: string;
    kind: "file" | "folder";
    size?: number;
    modified?: string;
  }>;
  listing: { returned: number; omitted: number; cap: number; truncated: boolean };
  graphRequests: number;
  scanSharedWithConcurrentCall: boolean;
}
