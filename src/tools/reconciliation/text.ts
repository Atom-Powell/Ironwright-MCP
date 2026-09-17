import type { ArtifactState, Period } from "../../domain/reconcile/index.js";
import type { ReconcileToolOutput } from "./output.js";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function period(value: Period): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

const STATE_LABELS: ReadonlyArray<{ state: Exclude<ArtifactState, "compliant">; label: string }> = [
  { state: "missing", label: "missing" },
  { state: "misnamed", label: "misnamed" },
  { state: "misplaced", label: "misplaced" },
  { state: "misnamed_and_misplaced", label: "both misnamed and misplaced" },
];

/**
 * Every sentence here is derived from the shaped output and from nothing else.
 * That is the message-audit practice made structural rather than remembered: a
 * formatter that cannot see the report cannot describe a report it did not
 * produce, and this project has repeatedly shipped prose that was correct
 * clause by clause and false against what the program had actually done.
 *
 * Two facts are stated in words rather than left as booleans in
 * `structuredContent`, because a field is not a sentence the model will pass
 * on to the person reading its summary: that the Search cross-check did not
 * run, and that findings were truncated.
 */
export function reconcileText(output: ReconcileToolOutput): string[] {
  const lines: string[] = [];

  const scope =
    output.scope.clients === null
      ? "every client in the workbook"
      : output.scope.clients.length === 0
        ? "no clients, because an empty client list was given"
        : `narrowed to ${quoteList(output.scope.clients)}`;

  lines.push(
    `Profile "${output.profileId}", ${period(output.window.from)} through ${period(output.window.to)}, ${scope}.`,
  );

  const compliantClients = output.clients.filter((client) => client.compliant).length;
  // The noun tracks the denominator (how many clients are in scope) and the
  // verb tracks the numerator (how many of them are compliant); those are two
  // different counts, and a single `plural()` call over one of them made the
  // verb agree with the wrong number, assembling "1 of 2 clients are
  // compliant" for a single compliant client.
  const totalClientsNoun = output.clients.length === 1 ? "client" : "clients";
  const compliantVerb = compliantClients === 1 ? "is" : "are";
  lines.push(
    output.clients.length === 0
      ? "No clients are in scope, so there is no compliance result to report."
      : `${compliantClients} of ${output.clients.length} ${totalClientsNoun} ${compliantVerb} compliant.`,
  );

  // Tallied over the returned findings rather than over the per-client counts,
  // so this line cannot claim a state the list beneath it does not show. When
  // the cap truncated the list the next line says so, which is what keeps the
  // two readable together.
  const byState = new Map<ArtifactState, number>();
  for (const artifact of output.artifacts) {
    byState.set(artifact.state, (byState.get(artifact.state) ?? 0) + 1);
  }
  const stateParts = STATE_LABELS.flatMap(({ state, label }) => {
    const count = byState.get(state) ?? 0;
    return count === 0 ? [] : [`${count} ${label}`];
  });

  lines.push(
    stateParts.length === 0
      ? "No non-compliant deliverables are listed."
      : `Listed non-compliant deliverables: ${stateParts.join(", ")}.`,
  );

  if (output.artifactsOmittedByCap > 0) {
    // "further" presupposes a list the reader has already seen some of. When
    // the cap is small enough that nothing survived it, `artifacts` is empty
    // and "further" would describe omissions from a list this response never
    // showed, so the qualifier is dropped exactly when there is nothing for
    // it to follow.
    const qualifier = output.artifacts.length > 0 ? "further " : "";
    const findingWord = output.artifactsOmittedByCap === 1 ? "finding was" : "findings were";
    lines.push(
      `${output.artifactsOmittedByCap} ${qualifier}non-compliant ${findingWord} ` +
        "omitted to keep this response bounded. The per-client counts above are complete and were not truncated; " +
        "narrow the call with the clients argument to see the rest.",
    );
  }

  if (output.compliantArtifactsOmitted > 0) {
    lines.push(
      `${plural(output.compliantArtifactsOmitted, "compliant finding is", "compliant findings are")} not listed, ` +
        "by design. The per-client counts above carry them.",
    );
  }

  const extras: string[] = [];
  if (output.duplicates.length > 0) extras.push(plural(output.duplicates.length, "duplicate", "duplicates"));
  if (output.orphans.length > 0) extras.push(plural(output.orphans.length, "orphan", "orphans"));
  if (output.emptyFolders.length > 0) {
    extras.push(plural(output.emptyFolders.length, "empty folder", "empty folders"));
  }
  if (extras.length > 0) {
    // The caveat below is specifically about unrecognized orphans and empty
    // folders, so it must not fire on a filtered report whose "Also found"
    // line lists only duplicates or client-attributed orphans, neither of
    // which the caveat's own sentence is about.
    const hasUnattributableExtras =
      output.orphans.some((orphan) => orphan.kind === "unrecognized") || output.emptyFolders.length > 0;
    // scope.clients is `[]` when the caller passed an empty client list, which
    // still sets `unattributableFindingsRepositoryWide` (the filter exists)
    // without a single client having been named, so "scoped to the named
    // clients" would name clients that were never named.
    const clientsWereNamed = (output.scope.clients?.length ?? 0) > 0;
    const caveat =
      output.scope.unattributableFindingsRepositoryWide && hasUnattributableExtras
        ? clientsWereNamed
          ? " Unrecognized orphans and empty folders are repository-wide rather than scoped to the named clients, because neither is attributable to a client."
          : " Unrecognized orphans and empty folders are repository-wide, because neither is attributable to a client."
        : "";
    lines.push(`Also found: ${extras.join(", ")}.${caveat}`);
  }

  if (output.rejectedWorkbookRows.length > 0) {
    lines.push(
      `${plural(output.rejectedWorkbookRows.length, "workbook row was", "workbook rows were")} rejected and could ` +
        "not be reconciled. A client absent from this report may be one of them rather than compliant.",
    );
  }

  if (output.scope.unknownClients.length > 0) {
    // The verb and the trailing pronoun both describe the same named clients,
    // so they must track the same count; picking `is` for the verb while
    // leaving "it" fixed regardless of count read as one client's worth of
    // grammar wrapped around a list of several.
    const severalUnknown = output.scope.unknownClients.length !== 1;
    lines.push(
      `${quoteList(output.scope.unknownClients)} ${severalUnknown ? "are" : "is"} ` +
        `not in the workbook, so nothing was reconciled for ${severalUnknown ? "them" : "it"}. ` +
        "That is not the same as having nothing outstanding.",
    );
  }

  if (!output.provenance.searchCrossCheckIncluded) {
    // Four causes, four remedies, and never more than the one the cross-check
    // itself established. `searchCrossCheckSkipReason` absent means the code
    // never learned why, which is the only case allowed to name no cause: a
    // sentence that invented one here would be exactly the defect the
    // message-audit practice exists to prevent, an assertion this function
    // cannot observe to be true.
    const reason = output.provenance.searchCrossCheckSkipReason;
    const cause =
      reason === "no-region"
        ? "The Microsoft Search cross-check did not run because the profile has no searchRegion configured. " +
          "Configure searchRegion on the profile to enable it."
        : reason === "search-failed"
          ? "The Microsoft Search cross-check failed. Investigate Microsoft Graph access, credentials, or the " +
            "network."
          : reason === "library-not-addressable"
            ? "The Microsoft Search cross-check could not search every document library, because one was " +
              "listed without a URL to search it by. That is not a failure and not a misconfiguration."
            : reason === "page-cap-reached"
              ? "The Microsoft Search cross-check did not search a library exhaustively, because it returned " +
                "more matching files than the page cap allows. The scope is too large for one pass."
              : "The Microsoft Search cross-check did not run.";

    lines.push(
      `${cause} Without it a correctly named file stored outside the expected taxonomy is invisible to this ` +
        "scan, so every misplaced finding is unreliable and every missing finding is suspect.",
    );
  }

  // `cost` carries the whole predicate on both branches so the sentence below
  // reads as one clause regardless of which branch fired. A version that
  // suffixed only the non-shared branch with ", this call" and then wrapped
  // that string in its own "This call cost" template produced "This call cost
  // 1 Graph request, this call.", which is exactly the defect this module
  // exists to prevent: correct clause by clause, false once assembled.
  const cost = output.provenance.scanSharedWithConcurrentCall
    ? "issued no Graph request of its own because it shared a scan already running"
    : `cost ${plural(output.provenance.graphRequestsByThisCall, "Graph request", "Graph requests")}`;

  lines.push(
    `Repository read by ${output.provenance.scanMode} scan at ${output.provenance.scannedAt}` +
      `${output.provenance.resynced ? ", after a delta resync forced a full re-enumeration" : ""}. ` +
      `This call ${cost}. ` +
      `Workbook read from ${output.provenance.workbookSource}.`,
  );

  return lines;
}
