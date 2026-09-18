import type { ArtifactState, Period } from "../../domain/reconcile/index.js";
import { crossCheckNeverAttempted, describeCrossCheckSkipReason } from "../../scan/cross-check.js";
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

/**
 * Ordinary code-unit comparison rather than `localeCompare`, matching the
 * reconciliation engine's own sort: this list of library names is part of a
 * response a golden-style test can pin, and `localeCompare` varies with the
 * host's ICU data and default locale.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

  // A qualified `matched.library` means the Microsoft Search cross-check
  // found this artifact in another document library, not the profile's own
  // one. Its path alone renders identically to an ordinary misfiling inside
  // the profile's own library, so an operator who opens that library, does
  // not find the file there, and has no reason to look anywhere else would
  // conclude the report is wrong rather than that the file is elsewhere.
  const foundElsewhere = output.artifacts.filter((artifact) => artifact.matched?.library !== undefined);
  if (foundElsewhere.length > 0) {
    const libraries = [...new Set(foundElsewhere.map((artifact) => artifact.matched?.library).filter((library) => library !== undefined))].sort(
      compareStrings,
    );
    lines.push(
      `${plural(foundElsewhere.length, "listed finding", "listed findings")} ` +
        `${foundElsewhere.length === 1 ? "was" : "were"} found in another document library rather than the ` +
        `profile's own: ${quoteList(libraries)}.`,
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
    // cannot observe to be true. Whichever reason applies, this function
    // knows only that the cross-check did not complete, never that it "did
    // not run": search-failed, library-not-addressable and page-cap-reached
    // all mean an attempt was made, and even a whole-run search-failed can
    // still carry files from a library that succeeded before a different
    // one's request threw.
    const reason = output.provenance.searchCrossCheckSkipReason;
    const cause = describeCrossCheckSkipReason(reason);

    // A whole-drive delta scan already finds a correctly named file at an
    // unexpected path within the profile's own library, so a misplaced
    // finding is reliable with or without this cross-check; that claim is not
    // repeated here. What a cross-check adds is visibility into the site's
    // other libraries, so the only finding this consequence bears on is a
    // missing one. "no-region" is the sole reason meaning the cross-check
    // spent no request at all; every other reason, this unrecorded one
    // included, means an attempt reached at least one library, so those
    // findings already reflect whatever that attempt found and only the part
    // it did not reach stays uncertain.
    const consequence = crossCheckNeverAttempted(reason)
      ? "Without it, a correctly named file filed into a different document library of the same site is " +
        "invisible to this scan, so a finding reported missing may in fact exist there."
      : "Because it did not complete, a finding reported missing may still exist in a document library, or " +
        "a part of one, this cross-check did not reach.";

    lines.push(`${cause} ${consequence}`);
  }

  // `cost` carries the whole predicate on both branches so the sentence below
  // reads as one clause regardless of which branch fired. A version that
  // suffixed only the non-shared branch with ", this call" and then wrapped
  // that string in its own "This call cost" template produced "This call cost
  // 1 Graph request, this call.", which is exactly the defect this module
  // exists to prevent: correct clause by clause, false once assembled.
  //
  // The cross-check's own cost is named as its own clause rather than folded
  // into the scan's count. Summing them would make an incremental scan
  // against a profile with searchRegion configured report a materially
  // larger number than the same scan without one, for a reason that has
  // nothing to do with the delta enumeration, which is exactly the number
  // docs/OPEN-ITEMS.md records a live baseline for.
  const crossCheckCost =
    output.provenance.searchCrossCheckGraphRequestsByThisCall === undefined
      ? ""
      : `, plus ${plural(output.provenance.searchCrossCheckGraphRequestsByThisCall, "Graph request", "Graph requests")} for the Search cross-check`;
  // The workbook read is its own clause on both branches, never summed into
  // the scan's count and never omitted from the shared-scan one. The joined
  // branch used to read "issued no Graph request of its own because it
  // shared a scan already running", which was false on every call that took
  // it: the coordinator shares the repository snapshot, and this call still
  // resolved the drive and downloaded the workbook by itself.
  const workbookCost = `${plural(output.provenance.workbookReadGraphRequestsByThisCall, "Graph request", "Graph requests")} reading the workbook`;
  const cost = output.provenance.scanSharedWithConcurrentCall
    ? `cost ${workbookCost}, and issued no Graph request of its own for the repository scan because it shared a scan already running`
    : `cost ${plural(output.provenance.graphRequestsByThisCall, "Graph request", "Graph requests")} scanning the repository${crossCheckCost}, plus ${workbookCost}`;

  lines.push(
    `Repository read by ${output.provenance.scanMode} scan at ${output.provenance.scannedAt}` +
      `${output.provenance.resynced ? ", after a delta resync forced a full re-enumeration" : ""}. ` +
      `This call ${cost}. ` +
      `Workbook read from ${output.provenance.workbookSource}.`,
  );

  return lines;
}
