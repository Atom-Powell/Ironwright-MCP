import type { DescribeToolOutput } from "./output.js";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

interface ListingLike {
  returned: number;
  omitted: number;
  cap: number;
  truncated: boolean;
}

function total(listing: ListingLike | undefined): number {
  return (listing?.returned ?? 0) + (listing?.omitted ?? 0);
}

function inventoryLines(output: DescribeToolOutput): string[] {
  const lines: string[] = [];
  const unresolved = output.unresolved ?? [];
  const sheetsTotal = total(output.sheetsListing);
  const tablesTotal = total(output.tablesListing);

  lines.push(
    `Workbook "${output.workbookPath}" in library "${output.library}": ` +
      `${plural(sheetsTotal, "worksheet", "worksheets")} and ${plural(tablesTotal, "table", "tables")} declared.`,
  );

  // Read from the listing's own `returned` rather than recomputed from
  // `sheets.length`: the two agree whenever shape.ts is correct, but this
  // module's job is to describe the shaped output, not to re-derive it, and
  // a formatter that recomputes a count it was already handed is a second
  // place that count can go wrong.
  if (output.sheetsListing?.truncated) {
    lines.push(
      `Listing ${plural(output.sheetsListing.returned, "worksheet", "worksheets")} of ${sheetsTotal} declared; ` +
        `${output.sheetsListing.omitted} more were left out to keep this response bounded at ${output.sheetsListing.cap}.`,
    );
  }

  if (output.tablesListing?.truncated) {
    lines.push(
      `Listing ${plural(output.tablesListing.returned, "table", "tables")} of ${tablesTotal} declared; ` +
        `${output.tablesListing.omitted} more were left out to keep this response bounded at ${output.tablesListing.cap}.`,
    );
  }

  // Stated even in the zero case, and as its own sentence rather than folded
  // into the count above, because "sheets and tables declared" already read
  // as a complete answer before this tool tracked unresolved wiring at all.
  // A reader must be able to tell "nothing was unresolved" apart from "this
  // response never checked", and only an explicit sentence in either
  // direction does that.
  lines.push(
    unresolved.length === 0
      ? "Every worksheet and table this workbook declares resolved cleanly; none is reported as unresolved."
      : `${plural(unresolved.length, "sheet or table", "sheets or tables")} could not be resolved and would ` +
          `otherwise have been silently dropped from the counts above; each is reported rather than dropped: ` +
          `${unresolved.map((entry) => `${entry.kind} "${entry.name}" (${entry.reason})`).join("; ")}.`,
  );

  lines.push(
    "No source was named, so this call proposes no header row and describes no columns. Call again naming one " +
      "of the tables or worksheets above as source to describe it in full.",
  );

  lines.push(`This call cost ${plural(output.graphRequests, "Graph request", "Graph requests")}.`);

  return lines;
}

function sourceLines(output: DescribeToolOutput): string[] {
  const lines: string[] = [];
  const source = output.source;
  const columnsTotal = total(output.columnsListing);
  const headerRow = output.headerRow;

  lines.push(
    `Workbook "${output.workbookPath}" in library "${output.library}", describing the ${source?.kind ?? "source"} ` +
      `"${source?.name ?? ""}".`,
  );

  lines.push(
    headerRow?.proposed !== undefined
      ? `Proposed header row ${headerRow.proposed}.`
      : `Proposed no header row: ${headerRow?.declinedReason ?? "no candidate row was found in the range."}`,
  );

  if (output.columnsListing?.truncated) {
    lines.push(
      `Describing ${plural(output.columnsListing.returned, "column", "columns")} of ${columnsTotal} this range holds; ` +
        `${output.columnsListing.omitted} more were left out to keep this response bounded at ${output.columnsListing.cap}.`,
    );
  } else {
    lines.push(`Describing ${plural(columnsTotal, "column", "columns")}, the complete set this range holds.`);
  }

  // Stated as its own sentence regardless of how many columns were described,
  // because the header text, type and samples above are evidence for a human
  // to read, not a proposal this tool is making: it never guesses which
  // column is the client, or any other deliverable field, since those names
  // are the profile author's own vocabulary tied to deliverables this tool
  // has not seen.
  lines.push(
    "This tool proposes no columns map. Header text, inferred type, distinct count and sample values above are " +
      "the evidence; deciding which field each column is and writing that into the profile remains yours to do.",
  );

  lines.push(
    output.samplesWithheld
      ? "Sample values are withheld because the workbook is marked fullCalcOnLoad and this range holds at " +
          "least one formula, so its saved cached values are not authoritative. Column structure above is " +
          "unaffected; only the sample values are withheld."
      : "Sample values are included with each column above.",
  );

  lines.push(`This call cost ${plural(output.graphRequests, "Graph request", "Graph requests")}.`);

  return lines;
}

/**
 * Every sentence here is derived from the shaped output and from nothing
 * else, the same message-audit discipline `inventoryText`, `queryText` and
 * `validateStructureText` already follow: a formatter that cannot see the
 * report cannot describe a report it did not produce. `unresolved` is stated
 * on every inventory-mode call, in both directions, because a fix made
 * earlier on this branch was for readWorkbookInventory to stop dropping a
 * sheet or table it could not resolve; a text module that then failed to say
 * so would undo that fix at the one layer an operator actually reads.
 */
export function describeWorkbookText(output: DescribeToolOutput): string[] {
  return output.mode === "inventory" ? inventoryLines(output) : sourceLines(output);
}
