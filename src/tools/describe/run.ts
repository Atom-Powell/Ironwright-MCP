import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../context.js";
import { describeToolFailure, type FailureSubject } from "../errors.js";
import { resolveDrive } from "../../graph/drive.js";
import { downloadDriveItem } from "../../graph/content.js";
import { readWorkbookInventory, type WorkbookInventory } from "../../workbook/introspect.js";
import { detectHeaderRow, describeColumns, MAX_COLUMN_SAMPLES, type HeaderDetection } from "../../workbook/describe.js";
import { resolveWorkbookGrid, type WorkbookGridResolution, type WorkbookSource } from "../../workbook/xlsx.js";
import { WorkbookMappingError } from "../../workbook/errors.js";
import { shapeDescribeInventory, shapeDescribeSource } from "./shape.js";
import { describeWorkbookText } from "./text.js";
import type { DescribeToolOutput } from "./output.js";

export const DESCRIBE_WORKBOOK_INPUT_SCHEMA = {
  library: z.string().min(1).describe("Document library holding the workbook, for example \"Documents\"."),
  workbookPath: z
    .string()
    .min(1)
    .describe("Library-relative path to the workbook, for example \"Trackers/Operational Tracking Workbook.xlsx\"."),
  source: z
    .object({
      kind: z.enum(["table", "worksheet"]),
      name: z.string().min(1),
    })
    .optional()
    .describe(
      "Describe this one table or worksheet in full, for example {\"kind\":\"table\",\"name\":\"ClientTable\"}. " +
        "Omit to list what the workbook contains instead.",
    ),
} satisfies z.ZodRawShape;

const InputObject = z.object(DESCRIBE_WORKBOOK_INPUT_SCHEMA);

/** The plain "no such name" sentence, with nothing about a profile: describe_workbook has none. */
function notFoundMessage(source: WorkbookSource): string {
  return `No ${source.kind} named "${source.name}" was found in the workbook.`;
}

/**
 * The names this workbook actually has, for the message a caller reads when
 * the source they asked for is not among them. Built from the same
 * `readWorkbookInventory` inventory mode itself calls, on bytes this call
 * already holds, so the correction costs no extra Graph request.
 */
function availableNamesSentence(inventory: WorkbookInventory): string {
  const sheets = inventory.sheets.map((sheet) => `"${sheet.name}"`);
  const tables = inventory.tables.map((table) => `"${table.name}"`);

  if (sheets.length === 0 && tables.length === 0) {
    return "The workbook contains no worksheets or tables this tool could resolve.";
  }

  const parts: string[] = [];
  if (sheets.length > 0) parts.push(`worksheets ${sheets.join(", ")}`);
  if (tables.length > 0) parts.push(`tables ${tables.join(", ")}`);

  return `The workbook contains ${parts.join(" and ")}.`;
}

/**
 * Resolves the named source's grid, and on the one failure a caller can
 * self-correct from, an unknown table or worksheet name, replaces the
 * message with a self-contained one naming this call's own arguments rather
 * than prefixing what `resolveWorkbookGrid` threw. `resolveTable` and
 * `resolveWorksheet`'s own "no such name" messages are written for
 * `parseWorkbookGrid`'s profile-driven callers ("Either the profile's
 * workbookMapping names..."); this tool has no profile, and appending
 * `describeToolFailure`'s no-profile attribution after that unedited
 * sentence produced a message that argued with itself, telling the reader in
 * one breath that a profile named this and in the next that no profile was
 * involved. Replacing it here is what `parseWorkbookGrid`'s own byte-for-byte
 * contract permits: that entry point, and its message, are untouched.
 *
 * Narrowing on `WorkbookMappingError` alone is safe because
 * `resolveWorkbookGrid` has exactly two throw sites of that class, in
 * `resolveTable` and `resolveWorksheet`, and both mean only "no such name".
 * A malformed ref throws `WorkbookFileError` (`parseRangeRef`), a different
 * class this catch lets through unchanged, and the `fullCalcOnLoad`
 * staleness refusal lives solely in `parseWorkbookGrid`, which this tool
 * never calls.
 */
export function resolveSourceOrExplain(bytes: Uint8Array, source: WorkbookSource): WorkbookGridResolution {
  try {
    return resolveWorkbookGrid(bytes, source);
  } catch (error) {
    if (!(error instanceof WorkbookMappingError)) throw error;

    let detail = "";
    try {
      detail = ` ${availableNamesSentence(readWorkbookInventory(bytes))}`;
    } catch {
      // The workbook has some other, unrelated problem readWorkbookInventory
      // could not read past, such as a malformed ref on a different table.
      // Degrading to the plain "no such name" message is better than losing
      // it under a second failure that never mentions the name the caller
      // actually typed.
    }

    throw new WorkbookMappingError(`${notFoundMessage(source)}${detail}`);
  }
}

/**
 * A table's own headerRowCount attribute settles its header row outright:
 * OOXML defaults it to 1, a header row present and always the table's first
 * row, and a table declaring "0" has none. Neither case benefits from
 * detectHeaderRow's scan, which exists only because a worksheet's used range
 * carries no such declaration of its own; running the heuristic against a
 * table would let a guess override a fact the file already states.
 */
function resolveHeaderRow(source: WorkbookSource, resolved: WorkbookGridResolution): HeaderDetection {
  if (source.kind === "worksheet") return detectHeaderRow(resolved.grid);

  if (resolved.tableHasHeaderRow === false) {
    return {
      candidates: [],
      declinedReason:
        `The table "${source.name}" declares headerRowCount="0", so its own definition states it has no ` +
        "header row; this tool reports that rather than treating the first row as one.",
    };
  }

  return { proposed: 1, candidates: [] };
}

function buildSourceOutput(
  bytes: Uint8Array,
  source: WorkbookSource,
  library: string,
  workbookPath: string,
  graphRequests: number,
): DescribeToolOutput {
  const resolved = resolveSourceOrExplain(bytes, source);
  // The workbook's own admission that this range's cached values are stale,
  // not a per-cell judgment: sheetToGrid reports whether the range held any
  // formula at all, not which cells did, so the conservative response is to
  // withhold every sample for the range rather than approximate a per-cell
  // rule the reader was never built to support.
  const samplesWithheld = resolved.fullCalcOnLoad && resolved.hadFormula;
  const headerRow = resolveHeaderRow(source, resolved);
  // No maxSamples override is passed, so describeColumns applies its own
  // default, MAX_COLUMN_SAMPLES. That same constant is handed to
  // shapeDescribeSource below as sampleCap rather than each side defaulting
  // independently, so the reported cap can never drift from the cap that was
  // actually applied.
  const columns = describeColumns(resolved.grid, headerRow.proposed, resolved.firstColumn, { samplesWithheld });

  return shapeDescribeSource(
    library,
    workbookPath,
    source,
    { columns, headerRow, samplesWithheld, sampleCap: MAX_COLUMN_SAMPLES },
    graphRequests,
    {},
  );
}

/**
 * The tool's composition root. Resolves the drive from the granted site,
 * downloads the workbook once, and branches on whether a source was named.
 * Inventory mode reads no cell grid at all, which is what keeps it cheap on
 * a workbook with many large sheets; source mode reads exactly the one range
 * asked for.
 *
 * `graphRequests` is a delta against `requestsAtStart`, not the client's raw
 * `requests()`. That counter lives on `context.graph`, which `main.ts` builds
 * once per process and shares across every per-request server, so it
 * accumulates for the process's whole life; reporting it raw would answer
 * "what has this process spent since it started" where the schema and prose
 * both promise "what this call itself paid". `src/scan/run.ts` already
 * brackets the same counter the same way.
 */
export async function runDescribeWorkbook(input: unknown, context: ToolContext): Promise<CallToolResult> {
  const args = InputObject.parse(input);
  // No profileId: this is the one tool a human runs before a profile exists,
  // so it names a library and a workbookPath directly. describeToolFailure
  // carries an optional-profile branch for exactly this call.
  const subject: FailureSubject = { tool: "describe_workbook", siteUrl: context.grantedSiteUrl, library: args.library };
  const requestsAtStart = context.graph.requests();

  try {
    const { driveId } = await resolveDrive(context.graph, context.grantedSiteUrl, args.library);
    const bytes = await downloadDriveItem(context.graph, { driveId, workbookPath: args.workbookPath });
    const graphRequests = context.graph.requests() - requestsAtStart;

    const output: DescribeToolOutput =
      args.source === undefined
        ? shapeDescribeInventory(args.library, args.workbookPath, readWorkbookInventory(bytes), graphRequests, {})
        : buildSourceOutput(bytes, args.source, args.library, args.workbookPath, graphRequests);

    return {
      structuredContent: output as unknown as Record<string, unknown>,
      content: [{ type: "text" as const, text: describeWorkbookText(output).join("\n") }],
    };
  } catch (error) {
    // Logged before it is described, matching every other tool's run: an
    // operator reading the message is told the full detail is in the server
    // log rather than promised something this function did not do.
    console.error(`describe_workbook failed for library "${args.library}", workbookPath "${args.workbookPath}"`, error);

    return {
      isError: true,
      content: [{ type: "text" as const, text: describeToolFailure(error, subject) }],
    };
  }
}
