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

  it("rejects duplicate deliverable tokens", () => {
    expectIssue(
      {
        ...validProfile,
        deliverables: [
          validProfile.deliverables[0],
          { ...validProfile.deliverables[0], id: "OtherDeliverable" },
        ],
      },
      'duplicate deliverable token "MonthlyTraining"',
    );
  });

  // A recognizer that captures no client, or no year, is accepted by every
  // other check in this schema and then matches nothing at all: the parser
  // drops a match it cannot read a client or a period out of and falls through
  // to the next recognizer. The author gets silence, and the file the
  // recognizer was written for comes back as unrecognized, which reads as the
  // repository being wrong when the profile is.
  it("rejects a recognizer whose pattern captures no client", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [
            { id: "no-client", pattern: "^Report (?<year>\\d{4})\\.xlsx$", deliverable: "MonthlyTraining", verdict: "misnamed" },
          ],
        },
      },
      'recognizer "no-client" declares no (?<client>...) capture',
    );
  });

  it("rejects a recognizer whose pattern captures no year", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [
            { id: "no-year", pattern: "^(?<client>[A-Z0-9]+) Safety\\.xlsx$", deliverable: "MonthlyTraining", verdict: "misnamed" },
          ],
        },
      },
      'recognizer "no-year" declares no (?<year>...) capture',
    );
  });

  it("rejects a recognizer whose pattern captures neither a month nor a month name", () => {
    // The third member of the same never-matches class. Half-covering it
    // would be worse than not covering it at all: an author who has watched
    // the client and year checks fire reads silence here as approval and
    // ships a recognizer that can never match a filename.
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [
            {
              id: "no-month",
              pattern: "^(?<client>[A-Z0-9]+) Annual (?<year>\\d{4})\\.xlsx$",
              deliverable: "MonthlyTraining",
              verdict: "misnamed",
            },
          ],
        },
      },
      'recognizer "no-month" declares no (?<month>...) or (?<monthName>...) capture',
    );
  });

  it("names the recognizer and says what to add", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [
            { id: "no-year", pattern: "^(?<client>[A-Z0-9]+) Safety\\.xlsx$", deliverable: "MonthlyTraining", verdict: "misnamed" },
          ],
        },
      },
      "add a (?<year>...) group to its pattern",
    );
  });

  it("does not add a capture complaint to a recognizer whose pattern will not compile", () => {
    // The pattern's own check already reports that, and a second complaint
    // about groups a regex engine could not even read would be noise the
    // author has to work out how to ignore.
    try {
      loadProfile({
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [{ id: "bad-regex", pattern: "([unclosed", deliverable: "MonthlyTraining", verdict: "misnamed" }],
        },
      });
      throw new Error("expected loadProfile to reject this profile");
    } catch (error) {
      const issues = (error as ProfileValidationError).issues.join("\n");

      expect(issues).toContain("must be a valid regular expression");
      expect(issues).not.toContain("declares no");
    }
  });

  it("rejects duplicate recognizer ids", () => {
    expectIssue(
      {
        ...validProfile,
        naming: {
          ...validProfile.naming,
          recognizers: [validProfile.naming.recognizers[0], validProfile.naming.recognizers[0]],
        },
      },
      'duplicate recognizer id "legacy-spaced"',
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
