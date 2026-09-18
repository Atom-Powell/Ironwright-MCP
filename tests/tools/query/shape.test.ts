import { describe, expect, it } from "vitest";
import { MAX_QUERY_FINDINGS, shapeQuery } from "../../../src/tools/query/shape.js";
import type { Finding } from "../../../src/tools/query/output.js";

const findings: Finding[] = [
  { path: "2026/CLIENTA", name: "CLIENTA", detail: "No file or deeper folder sits under this folder." },
  { path: "2026/CLIENTB", name: "CLIENTB", detail: "No file or deeper folder sits under this folder." },
];

describe("shapeQuery", () => {
  it("counts the whole result set and lists all of it when under the cap", () => {
    const output = shapeQuery("example", "Compliance Reports", "empty_folders", "drive-1", "2026-09-17T00:00:00.000Z", findings, {});

    expect(output.profileId).toBe("example");
    expect(output.library).toBe("Compliance Reports");
    expect(output.question).toBe("empty_folders");
    expect(output.driveId).toBe("drive-1");
    expect(output.scannedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(output.totals).toEqual({ findings: 2 });
    expect(output.listing).toEqual({ returned: 2, omitted: 0, cap: MAX_QUERY_FINDINGS, truncated: false });
    expect(output.findings).toEqual(findings);
  });

  it("keeps the totals exact when the listing truncates", () => {
    const output = shapeQuery("example", "Compliance Reports", "empty_folders", "drive-1", "2026-09-17T00:00:00.000Z", findings, {
      maxFindings: 1,
    });

    expect(output.totals).toEqual({ findings: 2 });
    expect(output.listing).toEqual({ returned: 1, omitted: 1, cap: 1, truncated: true });
    expect(output.findings).toHaveLength(1);
  });

  it("preserves the answerer's own order rather than re-sorting by path", () => {
    const outOfPathOrder: Finding[] = [
      { path: "2026/CLIENTB/report.docx", name: "report.docx", modified: "2026-09-10T00:00:00.000Z", detail: "Parsed as the MonthlyTraining deliverable." },
      { path: "2026/CLIENTA/report.docx", name: "report.docx", modified: "2026-09-05T00:00:00.000Z", detail: "Parsed as the MonthlyTraining deliverable." },
    ];

    const output = shapeQuery(
      "example",
      "Compliance Reports",
      "recent_reports",
      "drive-1",
      "2026-09-17T00:00:00.000Z",
      outOfPathOrder,
      {},
    );

    expect(output.findings.map((finding) => finding.path)).toEqual([
      "2026/CLIENTB/report.docx",
      "2026/CLIENTA/report.docx",
    ]);
  });

  it("reports graphRequests as always zero", () => {
    const output = shapeQuery("example", "Compliance Reports", "empty_folders", "drive-1", "2026-09-17T00:00:00.000Z", findings, {});

    expect(output.graphRequests).toBe(0);
  });

  it("returns zeroed totals for no findings, not an error", () => {
    const output = shapeQuery("example", "Compliance Reports", "empty_folders", "drive-1", "2026-09-17T00:00:00.000Z", [], {});

    expect(output.totals).toEqual({ findings: 0 });
    expect(output.listing).toEqual({ returned: 0, omitted: 0, cap: MAX_QUERY_FINDINGS, truncated: false });
  });
});
