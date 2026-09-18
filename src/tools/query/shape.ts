import { MAX_QUERY_FINDINGS, type Finding, type QueryToolOutput, type Question } from "./output.js";

export { MAX_QUERY_FINDINGS };

export interface QueryShapeOptions {
  /** Overridden only by tests, so the truncation rule runs on a small fixture. */
  maxFindings?: number;
}

/**
 * Totals come from the complete set an answerer produced and the listing is
 * cut afterward, in that order. Counting what survived the cut and presenting
 * it as a count of what exists is the substitution this project treats as its
 * worst failure, and it is one line away at every truncation site.
 *
 * No re-sort happens here. `empty_folders` and `naming_violations` arrive
 * already in path order because they are built from `snapshot.files` and
 * `snapshot.folderPaths`, which `assembleSnapshot` sorts; `recent_reports`
 * arrives sorted by modified date, most recent first, because that ordering
 * is the entire point of the question. Re-sorting by path here would silently
 * turn "recently modified" into "alphabetical," which is a wrong answer to
 * the question asked, not a formatting choice.
 */
export function shapeQuery(
  profileId: string,
  library: string,
  question: Question,
  driveId: string,
  scannedAt: string,
  findings: readonly Finding[],
  options: QueryShapeOptions,
): QueryToolOutput {
  const cap = options.maxFindings ?? MAX_QUERY_FINDINGS;
  const listed = findings.slice(0, cap);

  return {
    profileId,
    library,
    question,
    driveId,
    scannedAt,
    totals: { findings: findings.length },
    findings: listed,
    listing: {
      returned: listed.length,
      omitted: findings.length - listed.length,
      cap,
      truncated: listed.length < findings.length,
    },
    graphRequests: 0,
  };
}
