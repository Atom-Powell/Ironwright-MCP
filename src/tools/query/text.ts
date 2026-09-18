import type { QueryToolOutput } from "./output.js";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Whole minutes elapsed between the scan and `now`, floored rather than
 * rounded so the sentence never claims an age this call has not yet reached.
 * Clamped at zero because a clock this server does not control, or a `now`
 * supplied by a test, can land before `scannedAt`, and a negative age reads
 * as a bug rather than as the freshest possible answer it actually is.
 */
function ageInWholeMinutes(scannedAt: string, now: Date): number {
  const elapsedMs = now.getTime() - new Date(scannedAt).getTime();
  return Math.max(0, Math.floor(elapsedMs / 60000));
}

/**
 * Every sentence here is derived from the shaped output and the `now` passed
 * in, and from nothing else, the same message-audit discipline `reconcileText`
 * and `inventoryText` follow: a formatter that cannot see the report cannot
 * describe a report it did not produce.
 *
 * The word "current" never appears without the scan time beside it in the
 * same sentence, because "current" alone asserts freshness this tool cannot
 * back up on its own; naming the scan time lets the reader judge freshness
 * themselves instead of taking this tool's word for it.
 */
export function queryText(output: QueryToolOutput, now: Date): string[] {
  const lines: string[] = [];

  lines.push(
    `Profile "${output.profileId}", library "${output.library}", drive "${output.driveId}", ` +
      `answering "${output.question}" from the stored repository index.`,
  );

  lines.push(`Found ${plural(output.totals.findings, "finding", "findings")} for this question.`);

  if (output.listing.truncated) {
    lines.push(
      `Listing ${plural(output.listing.returned, "finding", "findings")} of that total; ` +
        `${output.listing.omitted} more were left out to keep this response bounded at ${output.listing.cap}.`,
    );
  } else {
    lines.push(`Listing every finding counted above, ${output.listing.returned} in all.`);
  }

  const ageMinutes = ageInWholeMinutes(output.scannedAt, now);
  lines.push(
    `This call cost ${plural(output.graphRequests, "Graph request", "Graph requests")}: the answer came from the ` +
      `inventory snapshot taken at ${output.scannedAt}, ${plural(ageMinutes, "minute", "minutes")} ago, and is ` +
      "current only as of that scan.",
  );

  return lines;
}
