import type {
  ArtifactFinding,
  ClientSummary,
  DuplicateFinding,
  OrphanFinding,
  ReconciliationReport,
  RejectedWorkbookRow,
} from "../../domain/reconcile/index.js";
import type { ScanResult } from "../../scan/run.js";
import { MAX_ARTIFACT_FINDINGS, type ReconcileToolOutput, type ScanProvenance } from "./output.js";

export interface ShapeOptions {
  /** Absent means every client. */
  clients?: readonly string[];
  /** Overridden only by tests, so the truncation rule can be exercised on a small fixture. */
  maxArtifacts?: number;
}

/**
 * What this call paid, as distinct from what the scan cost.
 *
 * A joiner reads the same inventory and issued no Graph request of its own, so
 * its count is zero. The scan's own mode and resync flag are carried through
 * unchanged for both, because they describe the inventory the report is built
 * on rather than the caller: a joiner whose scan resynced is reading a
 * rebuilt inventory, and saying otherwise would be false about the data.
 */
export function scanProvenance(result: ScanResult, joined: boolean): ScanProvenance {
  return {
    scanMode: result.mode,
    resynced: result.resynced,
    graphRequestsByThisCall: joined ? 0 : result.graphRequests,
    scanSharedWithConcurrentCall: joined,
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Narrows a report to what one caller asked for and drops what the counts
 * already carry.
 *
 * Applied after the engine has run over everything, never before. Filtering the
 * workbook first would leave every other client's files with no slot to match,
 * so the engine would classify them as `unexpected` orphans and a report
 * narrowed to one client would invent orphans for the rest of the library.
 *
 * The filter reaches what is attributable to a client and nothing else.
 * Unrecognized orphans, empty folders and workbook rows too broken to name a
 * client are attributable to none, so they are returned whole, and
 * `scope.unattributableFindingsRepositoryWide` says so rather than leaving a
 * reader to assume the whole payload was scoped.
 */
export function shapeReport(
  report: ReconciliationReport,
  provenance: ScanProvenance,
  options: ShapeOptions,
): ReconcileToolOutput {
  const filter = options.clients === undefined ? undefined : new Set(options.clients);
  const max = options.maxArtifacts ?? MAX_ARTIFACT_FINDINGS;

  const tracked = new Set(report.clients.map((client) => client.client));
  const unknownClients =
    filter === undefined ? [] : [...filter].filter((client) => !tracked.has(client)).sort(compareStrings);

  const inScope = <T>(items: readonly T[], client: (item: T) => string | undefined): T[] =>
    filter === undefined
      ? [...items]
      : items.filter((item) => {
          const owner = client(item);
          // Attributable to no client: kept, because filtering it out would
          // hide a repository-wide problem behind a question about one client.
          return owner === undefined || filter.has(owner);
        });

  const clients: ClientSummary[] = inScope(report.clients, (summary) => summary.client);
  const artifactsInScope: ArtifactFinding[] = inScope(report.artifacts, (artifact) => artifact.client);
  const nonCompliant = artifactsInScope.filter((artifact) => artifact.state !== "compliant");
  const artifacts = nonCompliant.slice(0, max);

  const duplicates: DuplicateFinding[] = inScope(report.duplicates, (duplicate) => duplicate.slot.client);
  const orphans: OrphanFinding[] = inScope(report.orphans, (orphan) => orphan.parsed?.client);
  const rejectedWorkbookRows: RejectedWorkbookRow[] = inScope(report.rejectedWorkbookRows, (row) => row.client);

  return {
    profileId: report.profileId,
    window: report.window,
    provenance: {
      scannedAt: report.provenance.scannedAt,
      workbookSource: report.provenance.workbookSource,
      searchCrossCheckIncluded: report.provenance.searchCrossCheckIncluded,
      ...provenance,
    },
    scope: {
      clients: options.clients === undefined ? null : [...options.clients],
      unknownClients,
      unattributableFindingsRepositoryWide: filter !== undefined,
    },
    clients,
    artifacts,
    compliantArtifactsOmitted: artifactsInScope.length - nonCompliant.length,
    artifactsOmittedByCap: nonCompliant.length - artifacts.length,
    duplicates,
    orphans,
    emptyFolders: [...report.emptyFolders],
    rejectedWorkbookRows,
  };
}
