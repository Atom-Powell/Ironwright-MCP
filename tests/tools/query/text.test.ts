import { describe, expect, it } from "vitest";
import { queryText } from "../../../src/tools/query/text.js";
import type { QueryToolOutput } from "../../../src/tools/query/output.js";

// Every figure below is distinct from every other, matching inventoryText's
// own fixture discipline. If a sentence's formatter ever swapped which value
// fills which slot, for example handing `cap` where `returned` belongs, two
// equal fixture values would let that swap through unnoticed because the
// rendered sentence would read the same either way.
const truncated: QueryToolOutput = {
  profileId: "example",
  library: "Compliance Reports",
  question: "naming_violations",
  driveId: "drive-7",
  scannedAt: "2026-09-17T00:00:00.000Z",
  totals: { findings: 913 },
  findings: [],
  listing: { returned: 481, omitted: 432, cap: 520, truncated: true },
  graphRequests: 0,
};

const NOW = new Date("2026-09-17T00:47:00.000Z");

describe("queryText", () => {
  it("names the profile, the library, the drive and the question, in one sentence", () => {
    const lines = queryText(truncated, NOW);

    expect(lines[0]).toBe(
      'Profile "example", library "Compliance Reports", drive "drive-7", ' +
        'answering "naming_violations" from the stored repository index.',
    );
  });

  it("states the exact total finding count as its own sentence", () => {
    const lines = queryText(truncated, NOW);

    expect(lines[1]).toBe("Found 913 findings for this question.");
  });

  it("uses the singular for a single finding", () => {
    const single: QueryToolOutput = { ...truncated, totals: { findings: 1 } };
    expect(queryText(single, NOW)[1]).toBe("Found 1 finding for this question.");
  });

  it("states the truncation sentence with the returned count, the omitted count, and the cap each in their own place", () => {
    const lines = queryText(truncated, NOW);

    expect(lines[2]).toBe("Listing 481 findings of that total; 432 more were left out to keep this response bounded at 520.");
  });

  it("states the non-truncated listing sentence on its own wording, not merely without the truncated one's word", () => {
    const whole: QueryToolOutput = { ...truncated, listing: { returned: 42, omitted: 0, cap: 520, truncated: false } };
    const lines = queryText(whole, NOW);

    expect(lines[2]).toBe("Listing every finding counted above, 42 in all.");
    expect(lines[2]).not.toContain("omitted");
    expect(lines[2]).not.toContain("left out");
  });

  it("states the Graph cost, the scan time and its age in whole minutes, as one sentence", () => {
    const lines = queryText(truncated, NOW);

    expect(lines[3]).toBe(
      "This call cost 0 Graph requests: the answer came from the inventory snapshot taken at " +
        "2026-09-17T00:00:00.000Z, 47 minutes ago, and is current only as of that scan.",
    );
  });

  it("floors a partial minute rather than rounding it up", () => {
    const almostAMinute: QueryToolOutput = { ...truncated, scannedAt: "2026-09-17T00:46:01.000Z" };
    const lines = queryText(almostAMinute, NOW);

    expect(lines[3]).toContain("0 minutes ago");
  });

  it("uses the singular for a Graph request count of one, hypothetically", () => {
    const single: QueryToolOutput = { ...truncated, graphRequests: 1 };
    expect(queryText(single, NOW)[3]).toContain("This call cost 1 Graph request:");
  });

  it("never says current without naming the scan time in the same sentence", () => {
    const lines = queryText(truncated, NOW);

    for (const line of lines) {
      if (line.toLowerCase().includes("current")) {
        expect(line).toContain(truncated.scannedAt);
      }
    }
  });
});
