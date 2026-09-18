import type { ValidateStructureOutput } from "./output.js";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Every sentence here is derived from the shaped output and from nothing
 * else, the same message-audit discipline `reconcileText`, `inventoryText` and
 * `queryText` follow: a formatter that cannot see the report cannot describe a
 * report it did not produce.
 *
 * The per-client truncation lines below name the listed and omitted counts
 * separately and never combine them into one number attached to the word
 * "listed". A client with 60 non-conforming files and a cap of 50 lists 50 and
 * omits 10; a sentence that said "60 listed" would claim this response shows
 * ten files it does not, which is exactly the kind of message correct on its
 * own and wrong about what the program actually did that this project's
 * message-audit practice exists to catch.
 */
export function validateStructureText(output: ValidateStructureOutput): string[] {
  const lines: string[] = [];

  lines.push(
    `Profile "${output.profileId}", library "${output.library}", as of scan ${output.scannedAt}: ` +
      `${plural(output.totals.clients, "client", "clients")} evaluated, ${output.totals.compliant} compliant, ` +
      `${output.totals.nonCompliant} non-compliant, ${output.totals.missing} missing.`,
  );

  // Computed over `output.clients`, which is the listing and not the whole
  // evaluated set, so the sentence says "listed" on both branches. The
  // compliant branch already did; the other one did not, and when the client
  // list was cut it read as the complete set of clients in trouble while
  // naming only those that survived the cap. The totals sentence above is
  // where the complete count lives.
  const notCompliant = output.clients.filter((client) => client.verdict !== "compliant");
  lines.push(
    notCompliant.length === 0
      ? "No listed client is non-compliant or missing."
      : `Not compliant, among the clients listed here: ${notCompliant
          .map((client) => `${client.client} (${client.verdict})`)
          .join(", ")}.`,
  );

  if (output.listing.truncated) {
    lines.push(
      `Listing ${plural(output.listing.returned, "client", "clients")} of ${output.totals.clients} evaluated; ` +
        `${output.listing.omitted} more were left out to keep this response bounded at ${output.listing.cap}. ` +
        "Name the clients you need in the clients argument to see the rest.",
    );
  }

  for (const client of output.clients) {
    if (client.nonConformingFoldersOmitted > 0) {
      const total = client.nonConformingFolders.length + client.nonConformingFoldersOmitted;
      lines.push(
        `Client "${client.client}": ${client.nonConformingFolders.length} non-conforming folders listed, ` +
          `${client.nonConformingFoldersOmitted} omitted (${total} total).`,
      );
    }
    if (client.nonConformingFilesOmitted > 0) {
      const total = client.nonConformingFiles.length + client.nonConformingFilesOmitted;
      lines.push(
        `Client "${client.client}": ${client.nonConformingFiles.length} non-conforming files listed, ` +
          `${client.nonConformingFilesOmitted} omitted (${total} total).`,
      );
    }
  }

  // This tool runs a real delta scan, and it was the only one of the four text
  // modules that never said what that cost. A reader comparing it against
  // query_repository, which answers from the stored index for nothing, could
  // not see the difference the two tools exist to make visible.
  lines.push(
    output.scanSharedWithConcurrentCall
      ? "This call issued no Graph request of its own because it shared a scan already running."
      : `This call cost ${plural(output.graphRequests, "Graph request", "Graph requests")}.`,
  );

  return lines;
}
