import { describe, expect, it } from "vitest";
import { createSimDeployment } from "../../../scripts/sim/deployment.js";
import type { GraphClient } from "../../../src/graph/client.js";
import { resolveAssessmentContext } from "../../../src/tools/assessment/context.js";
import { runOpenAssessment } from "../../../src/tools/assessment/open.js";
import { findAssessmentById, readAssessmentState } from "../../../src/tools/assessment/read-state.js";

const PROFILE = "vendor-assessments";

describe("readAssessmentState", () => {
  it("reads the root and every artifact path at once, and still answers the artifacts in the profile's order", async () => {
    const d = createSimDeployment();
    const opened = await runOpenAssessment({ profileId: PROFILE, vendor: "Acme Corp", scope: "Security" }, d.context);
    const assessmentId = (opened.structuredContent as { assessmentId: string }).assessmentId;
    const ac = await resolveAssessmentContext(d.context, PROFILE);
    const record = await findAssessmentById(d.context.graph, ac, assessmentId);

    // Counts the reads in flight together. One at a time, the peak is 1.
    let inFlight = 0;
    let peak = 0;
    const counting: Pick<GraphClient, "get"> = {
      get: async <T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await d.context.graph.get<T>(pathOrUrl, headers);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const state = await readAssessmentState(counting, ac, record);

    expect(peak).toBe(4);
    expect(state.rootPresent).toBe(true);
    expect(state.artifacts.map((artifact) => artifact.kind)).toEqual(["dossier", "executive_summary", "publication"]);
    expect(state.artifacts.every((artifact) => !artifact.present)).toBe(true);
  });
});
