import { describe, expect, it } from "vitest";
import { resolveCustomPlan } from "../../../src/domain/custom/resolve.js";
import type { CustomStep } from "../../../src/domain/custom/resolve.js";

const FOLDERS = ["Client A", "Client A/2025", "Client A/2026", "Archive", "Archive/2025"];
function f(path: string, modified = "2026-03-01T00:00:00Z") {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), modified };
}
const FILES = [
  f("Client A/2025/Jan report.pdf", "2025-01-31T00:00:00Z"),
  f("Client A/2025/Feb report.pdf", "2025-02-28T00:00:00Z"),
  f("Client A/2025/notes.docx", "2025-03-01T00:00:00Z"),
  f("Client A/2026/Jan report.pdf"),
  f("Archive/2025/old.pdf"),
];
const snapshot = { files: FILES, folderPaths: FOLDERS };
const step = (s: Partial<CustomStep> & { selector: CustomStep["selector"] }): CustomStep => s;

describe("resolveCustomPlan", () => {
  it("moves every PDF in a folder to another folder", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", extensions: ["pdf"] },
          moveTo: "/Archive/2025",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Feb report.pdf",
          currentName: "Feb report.pdf",
          targetName: "Feb report.pdf",
          targetPath: "Archive/2025/Feb report.pdf",
          step: 1,
        },
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report.pdf",
          targetPath: "Archive/2025/Jan report.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [2],
    });
  });

  it("matches folders ignoring case and builds the target in the index's casing", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/client a/2025", nameEquals: "jan report.pdf" },
          moveTo: "/archive/2025",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report.pdf",
          targetPath: "Archive/2025/Jan report.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [1],
    });
    if (!result.ok) throw new Error("expected a resolution");
    expect(result.items[0]?.targetPath.startsWith("Archive/2025/")).toBe(true);
  });

  it("selects descendants when recursive, with nameContains ignoring case", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: {
            folder: "/Client A",
            recursive: true,
            nameContains: "jan",
          },
          rename: { addPrefix: "Q1 " },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Q1 Jan report.pdf",
          targetPath: "Client A/2025/Q1 Jan report.pdf",
          step: 1,
        },
        {
          path: "Client A/2026/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Q1 Jan report.pdf",
          targetPath: "Client A/2026/Q1 Jan report.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [2],
    });
  });

  it("selects only files modified strictly between modifiedAfter and modifiedBefore", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: {
            folder: "/Client A/2025",
            modifiedAfter: "2025-02-01",
            modifiedBefore: "2025-03-15",
          },
          moveTo: "/Archive/2025",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Feb report.pdf",
          currentName: "Feb report.pdf",
          targetName: "Feb report.pdf",
          targetPath: "Archive/2025/Feb report.pdf",
          step: 1,
        },
        {
          path: "Client A/2025/notes.docx",
          currentName: "notes.docx",
          targetName: "notes.docx",
          targetPath: "Archive/2025/notes.docx",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [2],
    });
  });

  it("renames in place with addPrefix", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "Jan report.pdf" },
          rename: { addPrefix: "2025 " },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "2025 Jan report.pdf",
          targetPath: "Client A/2025/2025 Jan report.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [1],
    });
  });

  it("inserts addSuffix before the extension", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "Jan report.pdf" },
          rename: { addSuffix: " v2" },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report v2.pdf",
          targetPath: "Client A/2025/Jan report v2.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [1],
    });
  });

  it("replaces every occurrence of find in the stem and never in the extension", () => {
    const withRepeat = {
      files: [...FILES, f("Client A/2025/report and report.report")],
      folderPaths: FOLDERS,
    };
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameContains: "report" },
          rename: { replace: { find: "report", with: "summary" } },
        }),
      ],
      withRepeat,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Feb report.pdf",
          currentName: "Feb report.pdf",
          targetName: "Feb summary.pdf",
          targetPath: "Client A/2025/Feb summary.pdf",
          step: 1,
        },
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan summary.pdf",
          targetPath: "Client A/2025/Jan summary.pdf",
          step: 1,
        },
        {
          path: "Client A/2025/report and report.report",
          currentName: "report and report.report",
          targetName: "summary and summary.report",
          targetPath: "Client A/2025/summary and summary.report",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [3],
    });
  });

  it("renames the single file a setName selector matches", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "notes.docx" },
          rename: { setName: "meeting notes.docx" },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/notes.docx",
          currentName: "notes.docx",
          targetName: "meeting notes.docx",
          targetPath: "Client A/2025/meeting notes.docx",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [1],
    });
  });

  it("combines moveTo and rename into one item carrying both the new folder and the new name", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "Jan report.pdf" },
          moveTo: "/Archive/2025",
          rename: { addPrefix: "2025 " },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "2025 Jan report.pdf",
          targetPath: "Archive/2025/2025 Jan report.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [1],
    });
  });

  it("accepts the library root as either / or the empty string, selecting nothing when no file sits there", () => {
    const result = resolveCustomPlan(
      [
        step({ selector: { folder: "/" }, rename: { addPrefix: "x " } }),
        step({ selector: { folder: "" }, rename: { addPrefix: "x " } }),
        step({
          selector: { folder: "/Archive/2025" },
          rename: { addPrefix: "2025 " },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          path: "Archive/2025/old.pdf",
          currentName: "old.pdf",
          targetName: "2025 old.pdf",
          targetPath: "Archive/2025/2025 old.pdf",
          step: 3,
        },
      ],
      exclusions: [],
      perStep: [0, 0, 1],
    });
  });
});
