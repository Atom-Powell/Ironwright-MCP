import type { InventoryToolOutput } from "./output.js";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Every sentence here is derived from the shaped output and from nothing
 * else, the same message-audit discipline `reconcileText` follows: a
 * formatter that cannot see the report cannot describe a report it did not
 * produce, and this project has repeatedly shipped prose that was correct
 * clause by clause and false about what the program had actually done.
 *
 * Truncation is stated in words rather than left for the model to infer from
 * `listing` in `structuredContent`, because a field is not a sentence the
 * model will pass on to whoever reads its summary.
 */
export function inventoryText(output: InventoryToolOutput): string[] {
  const lines: string[] = [];

  const where =
    output.subPath === undefined
      ? `library "${output.library}"`
      : `library "${output.library}", narrowed to subPath "${output.subPath}"`;

  lines.push(`Profile "${output.profileId}", ${where}, scanned at ${output.scannedAt}.`);

  lines.push(
    `Contains ${plural(output.totals.files, "file", "files")} and ` +
      `${plural(output.totals.folders, "folder", "folders")}, totaling ${output.totals.bytes} bytes. ` +
      "These totals cover everything in scope, whether or not the listing below was cut.",
  );

  if (output.listing.truncated) {
    lines.push(
      `Listing ${plural(output.listing.returned, "item", "items")} of that total; ` +
        `${output.listing.omitted} more were left out to keep this response bounded at ${output.listing.cap}. ` +
        "Narrow the call with subPath to see the rest.",
    );
  } else {
    lines.push(`Listing every item counted above, ${output.listing.returned} in all.`);
  }

  lines.push(`This call cost ${plural(output.graphRequests, "Graph request", "Graph requests")}.`);

  return lines;
}
