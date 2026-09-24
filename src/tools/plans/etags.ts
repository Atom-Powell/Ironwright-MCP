import type { GraphClient } from "../../graph/client.js";
import { readDriveItemEtag } from "../../graph/rename.js";
import type { ExcludedPlanItem, RenamePlanItem } from "../../store/types.js";

export interface PlanCandidate {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  client: string;
}

export type EtagExclusionReason = "no_etag_available" | "file_not_found_at_plan_time";

/**
 * Fetches each candidate's precondition now rather than reading it from the
 * inventory. The inventory's etag comes from a delta snapshot that may be
 * hours old and is recorded as `item.eTag ?? ""`, so it can be empty; this
 * fetch measures the window that matters, generate to execute, and has no
 * empty-string hole. The same call confirms the file is still at that path
 * under that name, because path addressing puts the filename in the URL.
 *
 * Sequential, one lookup per candidate, which phase 6a measured as the whole
 * plan-time cost. The caller reports `candidates.length` as the lookup count.
 */
export async function fetchPlanEtags(
  graph: Pick<GraphClient, "get">,
  driveId: string,
  candidates: readonly PlanCandidate[],
): Promise<{ items: RenamePlanItem[]; excluded: ExcludedPlanItem<EtagExclusionReason>[] }> {
  const items: RenamePlanItem[] = [];
  const excluded: ExcludedPlanItem<EtagExclusionReason>[] = [];

  for (const candidate of candidates) {
    const lookup = await readDriveItemEtag(graph, { driveId, path: candidate.path });
    if (lookup.kind === "not_found") {
      excluded.push(excludedFrom(candidate, "file_not_found_at_plan_time"));
      continue;
    }
    if (lookup.etag === undefined) {
      excluded.push(excludedFrom(candidate, "no_etag_available"));
      continue;
    }
    items.push({ ...candidate, etag: lookup.etag });
  }

  return { items, excluded };
}

function excludedFrom(candidate: PlanCandidate, reason: EtagExclusionReason): ExcludedPlanItem<EtagExclusionReason> {
  return {
    path: candidate.path,
    currentName: candidate.currentName,
    targetName: candidate.targetName,
    client: candidate.client,
    reason,
  };
}
