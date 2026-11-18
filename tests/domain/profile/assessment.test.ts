import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AssessmentProfileSchema, type AssessmentProfile } from "../../../src/domain/profile/assessment.js";
import { isAssessmentProfile, isLibraryProfile } from "../../../src/domain/profile/library.js";
import { loadAnyProfile } from "../../../src/profiles/registry.js";

const example = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as unknown;

describe("the lifecycle a profile defines", () => {
  const example = (): Record<string, any> => JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any

  it("defaults the gates, the external kinds and the corrected kinds to the vendor risk workflow", () => {
    const profile = loadAnyProfile(example()) as AssessmentProfile;

    expect(profile.lifecycle.gates).toEqual({ findings: ["dossier"], provisional: ["dossier"], completed: ["dossier", "publication"] });
    expect(profile.lifecycle.external).toEqual(["publication"]);
    expect(profile.lifecycle.corrected).toEqual(["dossier"]);
  });

  it("loads a profile whose workflow names neither a dossier nor a publication", () => {
    const input = example();
    input.workspace.artifacts = { intake: "Intake/{vendor}_Intake.md", handover: "Handover/{assessmentId}_Handover.pdf" };
    input.workspace.subfolders = ["Intake", "Handover"];
    input.lifecycle.gates = { findings: ["intake"], provisional: ["intake"], completed: ["intake", "handover"] };
    input.lifecycle.external = ["handover"];
    input.lifecycle.corrected = [];

    const profile = loadAnyProfile(input) as AssessmentProfile;

    expect(Object.keys(profile.workspace.artifacts)).toEqual(["intake", "handover"]);
    expect(profile.lifecycle.gates.completed).toEqual(["intake", "handover"]);
  });

  it.each(["msp-client-onboarding.json", "msp-security-incident.json"])("loads the shipped example %s as an assessment profile", (file) => {
    const profile = loadAnyProfile(JSON.parse(readFileSync(`examples/profiles/${file}`, "utf8"))) as AssessmentProfile;

    expect(profile.kind).toBe("assessment");
    // Every kind a gate names is one the server can find, and an external kind is one a gate waits on.
    const kinds = Object.keys(profile.workspace.artifacts);
    for (const kind of [...profile.lifecycle.gates.findings, ...profile.lifecycle.gates.provisional, ...profile.lifecycle.gates.completed]) expect(kinds).toContain(kind);
    for (const kind of profile.lifecycle.external) expect(profile.lifecycle.gates.completed).toContain(kind);
  });
});

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
