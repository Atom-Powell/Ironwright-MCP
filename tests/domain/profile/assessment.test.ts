import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AssessmentProfileSchema } from "../../../src/domain/profile/assessment.js";
import { isAssessmentProfile, isLibraryProfile, loadAnyProfile } from "../../../src/domain/profile/library.js";

const example = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as unknown;

describe("the assessment profile kind", () => {
  it("loads the committed example as an assessment profile", () => {
    const profile = loadAnyProfile(example);

    expect(isAssessmentProfile(profile)).toBe(true);
    expect(isLibraryProfile(profile)).toBe(false);
    if (!isAssessmentProfile(profile)) throw new Error("unreachable");
    expect(profile.kind).toBe("assessment");
    expect(profile.workspace.artifacts.dossier).toBeDefined();
    expect(profile.workspace.artifacts.publication).toBeDefined();
    expect(profile.lists.assessments.columns.assessmentId).toBe("AssessmentId");
    expect(profile.lifecycle.status.inProgress).toBe("In Progress");
    expect(profile.identity).toEqual(profile.sites[0]);
  });

  it("accepts a profile written with sites only and no identity", () => {
    const { identity: _identity, ...withoutIdentity } = example as Record<string, unknown>;
    const profile = loadAnyProfile(withoutIdentity);

    expect(isAssessmentProfile(profile)).toBe(true);
  });

  it("is what the schema itself accepts once the sites are normalized", () => {
    const profile = loadAnyProfile(example);

    expect(AssessmentProfileSchema.safeParse(profile).success).toBe(true);
  });
});
