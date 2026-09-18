import { describe, expect, it } from "vitest";
import { validateStructureText } from "../../../src/tools/validate/text.js";
import type { ClientValidation, ValidateStructureOutput } from "../../../src/tools/validate/output.js";

function client(overrides: Partial<ClientValidation> & { client: string }): ClientValidation {
  return {
    verdict: "compliant",
    nonConformingFolders: [],
    nonConformingFoldersOmitted: 0,
    nonConformingFiles: [],
    nonConformingFilesOmitted: 0,
    ...overrides,
  };
}

// Every figure in `totals` is distinct from every other: clients=6,
// compliant=1, nonCompliant=2, missing=3, matching queryText's and
// inventoryText's own fixture discipline. If the counts-by-verdict sentence
// ever transposed which total fills which slot, a fixture where three of the
// four figures were the same number (an earlier version of this file used
// 3/1/1/1) would let that swap through unnoticed, because the rendered
// sentence would read the same either way. The four are also kept internally
// honest rather than merely distinct: compliant + nonCompliant + missing
// equals clients, and `clients` below lists exactly one compliant, two
// non-compliant and three missing entries, matching those counts, because
// `listing.truncated` is false here and a non-truncated listing must show
// every evaluated client.
const base: ValidateStructureOutput = {
  profileId: "example",
  library: "Compliance Reports",
  scannedAt: "2026-09-17T00:00:00.000Z",
  totals: { clients: 6, compliant: 1, nonCompliant: 2, missing: 3 },
  clients: [
    client({ client: "CLIENTA", verdict: "compliant" }),
    client({ client: "CLIENTB", verdict: "non_compliant", nonConformingFolders: ["2026/CLIENTB/Sept"] }),
    client({ client: "CLIENTC", verdict: "missing" }),
    client({ client: "CLIENTD", verdict: "non_compliant", nonConformingFolders: ["2026/CLIENTD/Sept"] }),
    client({ client: "CLIENTE", verdict: "missing" }),
    client({ client: "CLIENTF", verdict: "missing" }),
  ],
  listing: { returned: 6, omitted: 0, cap: 50, truncated: false },
  graphRequests: 4,
};

describe("validateStructureText", () => {
  it("states the profile, the library, the scan time and the counts by verdict as one sentence", () => {
    const lines = validateStructureText(base);

    expect(lines[0]).toBe(
      'Profile "example", library "Compliance Reports", as of scan 2026-09-17T00:00:00.000Z: ' +
        "6 clients evaluated, 1 compliant, 2 non-compliant, 3 missing.",
    );
  });

  it("uses the singular for a single client evaluated", () => {
    const single: ValidateStructureOutput = {
      ...base,
      totals: { clients: 1, compliant: 1, nonCompliant: 0, missing: 0 },
      clients: [client({ client: "CLIENTA" })],
      listing: { returned: 1, omitted: 0, cap: 50, truncated: false },
    };

    expect(validateStructureText(single)[0]).toContain("1 client evaluated,");
  });

  it("names every listed client that is not compliant, with its own verdict", () => {
    const lines = validateStructureText(base);

    expect(lines[1]).toBe(
      "Not compliant: CLIENTB (non_compliant), CLIENTC (missing), CLIENTD (non_compliant), CLIENTE (missing), " +
        "CLIENTF (missing).",
    );
  });

  it("states plainly that no listed client is non-compliant or missing when every one is compliant", () => {
    const allCompliant: ValidateStructureOutput = {
      ...base,
      totals: { clients: 2, compliant: 2, nonCompliant: 0, missing: 0 },
      clients: [client({ client: "CLIENTA" }), client({ client: "CLIENTD" })],
      listing: { returned: 2, omitted: 0, cap: 50, truncated: false },
    };

    expect(validateStructureText(allCompliant)[1]).toBe("No listed client is non-compliant or missing.");
  });

  it("says nothing about the client listing being truncated when it was not", () => {
    const lines = validateStructureText(base);

    expect(lines).toHaveLength(2);
  });

  it("states the client-listing truncation sentence with the returned count, the omitted count, the total evaluated and the cap each in their own place", () => {
    const truncated: ValidateStructureOutput = {
      ...base,
      totals: { clients: 23, compliant: 23, nonCompliant: 0, missing: 0 },
      clients: [client({ client: "CLIENTA" })],
      listing: { returned: 7, omitted: 4, cap: 11, truncated: true },
    };

    const lines = validateStructureText(truncated);

    expect(lines[2]).toBe("Listing 7 clients of 23 evaluated; 4 more were left out to keep this response bounded at 11.");
  });

  it("states a truncated non-conforming folder list with the listed count, the omitted count and the true total each in their own place", () => {
    const output: ValidateStructureOutput = {
      ...base,
      totals: { clients: 1, compliant: 0, nonCompliant: 1, missing: 0 },
      clients: [
        client({
          client: "CLIENTA",
          verdict: "non_compliant",
          nonConformingFolders: ["a", "b", "c", "d", "e", "f"],
          nonConformingFoldersOmitted: 3,
        }),
      ],
      listing: { returned: 1, omitted: 0, cap: 50, truncated: false },
    };

    const lines = validateStructureText(output);

    expect(lines[2]).toBe('Client "CLIENTA": 6 non-conforming folders listed, 3 omitted (9 total).');
  });

  it("never says a number is listed that is not the count of what is actually in the response, for a client with 60 non-conforming files", () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ path: `f${index}`, reason: "does not parse" }));
    const output: ValidateStructureOutput = {
      ...base,
      totals: { clients: 1, compliant: 0, nonCompliant: 1, missing: 0 },
      clients: [
        client({
          client: "CLIENTA",
          verdict: "non_compliant",
          nonConformingFiles: files,
          nonConformingFilesOmitted: 10,
        }),
      ],
      listing: { returned: 1, omitted: 0, cap: 50, truncated: false },
    };

    const lines = validateStructureText(output);

    expect(lines[2]).toBe('Client "CLIENTA": 50 non-conforming files listed, 10 omitted (60 total).');
    expect(lines.join("\n")).not.toContain("60 listed");
  });

  it("reports both a truncated folder list and a truncated file list for the same client as two separate sentences", () => {
    const output: ValidateStructureOutput = {
      ...base,
      totals: { clients: 1, compliant: 0, nonCompliant: 1, missing: 0 },
      clients: [
        client({
          client: "CLIENTA",
          verdict: "non_compliant",
          nonConformingFolders: ["a"],
          nonConformingFoldersOmitted: 2,
          nonConformingFiles: [{ path: "f", reason: "does not parse" }],
          nonConformingFilesOmitted: 5,
        }),
      ],
      listing: { returned: 1, omitted: 0, cap: 50, truncated: false },
    };

    const lines = validateStructureText(output);

    expect(lines[2]).toBe('Client "CLIENTA": 1 non-conforming folders listed, 2 omitted (3 total).');
    expect(lines[3]).toBe('Client "CLIENTA": 1 non-conforming files listed, 5 omitted (6 total).');
  });
});
