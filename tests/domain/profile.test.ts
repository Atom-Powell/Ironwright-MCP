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
});
