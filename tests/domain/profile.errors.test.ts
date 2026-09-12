import { describe, expect, it } from "vitest";
import { ProfileValidationError, loadProfile } from "../../src/domain/profile/load.js";
import { validProfile } from "./fixtures.js";

function expectIssue(input: unknown, fragment: string): void {
  try {
    loadProfile(input);
    throw new Error("expected loadProfile to reject this profile");
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError);
    const issues = (error as ProfileValidationError).issues.join("\n");
    expect(issues).toContain(fragment);
  }
}

describe("loadProfile rejections", () => {
  it("rejects an unknown placeholder in the filename template", () => {
    expectIssue(
      { ...validProfile, naming: { ...validProfile.naming, template: "{year}_{clientName}.xlsx" } },
      "unknown placeholder {clientName}",
    );
  });

  it("rejects an unknown placeholder in a taxonomy segment", () => {
    expectIssue({ ...validProfile, taxonomy: { segments: ["{year}", "{quarter}"] } }, "unknown placeholder {quarter}");
  });

  it("rejects a recognizer pointing at an undeclared deliverable", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [{ id: "orphan", pattern: "^x$", deliverable: "NoSuchDeliverable", verdict: "misnamed" }],
        },
      },
      'no deliverable is declared with id "NoSuchDeliverable"',
    );
  });

  it("rejects a deliverable whose workbookField is not a mapped column", () => {
    expectIssue(
      {
        ...validProfile,
        deliverables: [
          { ...validProfile.deliverables[0], appliesTo: { workbookField: "notMapped", truthy: true } },
        ],
      },
      '"notMapped" is not a key in workbookMapping.columns',
    );
  });

  it("rejects respectEffectiveFrom without an effectiveFrom column", () => {
    expectIssue(
      { ...validProfile, window: { mode: "rolling", months: 12, respectEffectiveFrom: true } },
      "requires workbookMapping.columns.effectiveFrom",
    );
  });

  it("rejects an invalid regular expression in a recognizer", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [{ id: "bad-regex", pattern: "([unclosed", deliverable: "MonthlyTraining", verdict: "misnamed" }],
        },
      },
      "must be a valid regular expression",
    );
  });

  it("rejects duplicate deliverable ids", () => {
    expectIssue(
      { ...validProfile, deliverables: [validProfile.deliverables[0], validProfile.deliverables[0]] },
      'duplicate deliverable id "MonthlyTraining"',
    );
  });

  it("reports the failing path alongside the message", () => {
    try {
      loadProfile({ ...validProfile, profileId: "Not Valid" });
      throw new Error("expected loadProfile to reject this profile");
    } catch (error) {
      expect((error as ProfileValidationError).issues[0]).toMatch(/^profileId: /);
    }
  });
});
