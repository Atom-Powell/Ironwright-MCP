import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unknownPlaceholders } from "../../src/domain/profile/placeholders.js";
import { ProfileSchema } from "../../src/domain/profile/schema.js";
import { loadProfile } from "../../src/domain/profile/load.js";
import { validProfile } from "./fixtures.js";

describe("unknownPlaceholders", () => {
  it("accepts every supported placeholder", () => {
    expect(unknownPlaceholders("{year}-{month:02}_{client}_{deliverable}{monthName}{month}")).toEqual([]);
  });

  it("reports placeholders that are not supported", () => {
    expect(unknownPlaceholders("{year}/{quarter}/{clientName}")).toEqual(["quarter", "clientName"]);
  });

  it("ignores text outside braces", () => {
    expect(unknownPlaceholders("Reports {year}")).toEqual([]);
  });
});

describe("ProfileSchema", () => {
  it("accepts a valid profile", () => {
    expect(() => ProfileSchema.parse(validProfile)).not.toThrow();
  });

  it("defaults periodAnchor to the last month of the period", () => {
    const parsed = ProfileSchema.parse(validProfile);
    expect(parsed.deliverables[0]?.periodAnchor).toBe("last");
  });

  // The required-capture check asks for a month OR a month name, never both,
  // and each half of that has to be exercised on its own. A rule that
  // demanded a numeric (?<month>) would reject legacy-spaced, which is the
  // recognizer shape the golden fixture and the example profile both ship.
  it("accepts a recognizer that captures a month name and no numeric month", () => {
    const parsed = ProfileSchema.parse(validProfile);

    expect(parsed.naming.recognizers[0]?.id).toBe("legacy-spaced");
    expect(parsed.naming.recognizers[0]?.pattern).toContain("(?<monthName>");
    expect(parsed.naming.recognizers[0]?.pattern).not.toContain("(?<month>");
  });

  it("accepts a recognizer that captures a numeric month and no month name", () => {
    const numericMonth = {
      ...validProfile,
      naming: {
        ...validProfile.naming,
        recognizers: [
          {
            id: "alias-compact",
            pattern: "^(?<client>[A-Z0-9]+)-(?<year>\\d{4})(?<month>\\d{2})-Training\\.xlsx$",
            deliverable: "MonthlyTraining",
            verdict: "compliant",
          },
        ],
      },
    };

    expect(() => ProfileSchema.parse(numericMonth)).not.toThrow();
  });

  it("defaults recognizers to an empty list", () => {
    const withoutRecognizers = {
      ...validProfile,
      naming: { template: validProfile.naming.template },
    };
    expect(ProfileSchema.parse(withoutRecognizers).naming.recognizers).toEqual([]);
  });
});

describe("examples/profiles/example.json", () => {
  it("is a valid profile", () => {
    const raw: unknown = JSON.parse(readFileSync("examples/profiles/example.json", "utf8"));
    expect(() => loadProfile(raw)).not.toThrow();
  });

  it("accepts a compliant verdict alongside misnamed", () => {
    const raw: unknown = JSON.parse(readFileSync("examples/profiles/example.json", "utf8"));
    const parsed = loadProfile(raw);
    expect(parsed.naming.recognizers.some((recognizer) => recognizer.verdict === "compliant")).toBe(true);
  });
});
