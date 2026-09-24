import { describe, expect, it } from "vitest";
import { resolveCustomPlan } from "../../../src/domain/custom/resolve.js";
import type { CustomRename, CustomStep } from "../../../src/domain/custom/resolve.js";

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

const JAN_2025 = { folder: "/Client A/2025", nameEquals: "Jan report.pdf" };

describe("resolveCustomPlan refusals", () => {
  it("refuses an unknown selector folder, naming the root as the nearest folder and its children", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client B" },
          rename: { addPrefix: "x " },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: false,
      refusal: {
        kind: "unknown_folder",
        step: 1,
        field: "folder",
        requested: "/Client B",
        nearestExisting: "",
        children: ["Archive", "Client A"],
      },
    });
  });

  it("refuses an unknown moveTo folder, naming its deepest existing ancestor and that ancestor's children", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025" },
          moveTo: "/Client A/2027",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: false,
      refusal: {
        kind: "unknown_folder",
        step: 1,
        field: "moveTo",
        requested: "/Client A/2027",
        nearestExisting: "Client A",
        children: ["Client A/2025", "Client A/2026"],
      },
    });
  });

  it("refuses setName on a selector that matches more than one file", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", extensions: ["pdf"] },
          rename: { setName: "report.pdf" },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: false,
      refusal: { kind: "ambiguous_set_name", step: 1, matched: 2 },
    });
  });

  it("refuses more distinct files than the plan limit", () => {
    const many = Array.from({ length: 101 }, (_v, i) => f(`Archive/2025/file ${String(i).padStart(3, "0")}.pdf`));
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Archive/2025" },
          rename: { addPrefix: "x " },
        }),
      ],
      { files: many, folderPaths: FOLDERS },
    );

    expect(result).toEqual({
      ok: false,
      refusal: {
        kind: "too_many_files",
        perStep: [101],
        total: 101,
        limit: 100,
      },
    });
  });

  it("refuses a plan in which every step matches nothing", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "missing.pdf" },
          rename: { addPrefix: "x " },
        }),
        step({
          selector: { folder: "/Archive", nameContains: "zzz" },
          moveTo: "/Archive/2025",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: false,
      refusal: { kind: "nothing_matched", perStep: [0, 0] },
    });
  });

  describe("invalid_step", () => {
    it("refuses a step with neither moveTo nor rename, numbering steps from 1", () => {
      const result = resolveCustomPlan(
        [step({ selector: JAN_2025, rename: { addPrefix: "x " } }), step({ selector: JAN_2025 })],
        snapshot,
      );

      expect(result).toEqual({
        ok: false,
        refusal: {
          kind: "invalid_step",
          step: 2,
          detail: expect.stringMatching(/neither moveTo nor rename/) as unknown,
        },
      });
    });

    it("refuses a rename object carrying two forms", () => {
      const twoForms = {
        addPrefix: "a ",
        addSuffix: " b",
      } as unknown as CustomRename;
      const result = resolveCustomPlan([step({ selector: JAN_2025, rename: twoForms })], snapshot);

      expect(result).toEqual({
        ok: false,
        refusal: {
          kind: "invalid_step",
          step: 1,
          detail: expect.stringMatching(/exactly one/) as unknown,
        },
      });
    });

    it("refuses an empty replace.find", () => {
      const result = resolveCustomPlan(
        [
          step({
            selector: JAN_2025,
            rename: { replace: { find: "", with: "x" } },
          }),
        ],
        snapshot,
      );

      expect(result).toEqual({
        ok: false,
        refusal: {
          kind: "invalid_step",
          step: 1,
          detail: expect.stringMatching(/replace\.find is empty/) as unknown,
        },
      });
    });

    it("refuses more than 20 steps as step 0", () => {
      const steps = Array.from({ length: 21 }, () => step({ selector: JAN_2025, rename: { addPrefix: "x " } }));
      const result = resolveCustomPlan(steps, snapshot);

      expect(result).toEqual({
        ok: false,
        refusal: {
          kind: "invalid_step",
          step: 0,
          detail: expect.stringMatching(/21 steps.*20/) as unknown,
        },
      });
    });
  });
});

describe("resolveCustomPlan exclusions", () => {
  it("excludes a file two steps select from both, producing no item", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "notes.docx" },
          rename: { addPrefix: "x " },
        }),
        step({
          selector: { folder: "/Client A/2025", extensions: ["docx"] },
          moveTo: "/Archive/2025",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/notes.docx",
          currentName: "notes.docx",
          targetName: "notes.docx",
          reason: "matched_by_multiple_steps",
          steps: [1, 2],
        },
      ],
      perStep: [1, 1],
    });
  });

  it("excludes a replace whose find is absent from the name as no_change", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: JAN_2025,
          rename: { replace: { find: "xyz", with: "abc" } },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report.pdf",
          reason: "no_change",
          steps: [1],
        },
      ],
      perStep: [1],
    });
  });

  it("excludes a setName that would change the extension", () => {
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", nameEquals: "notes.docx" },
          rename: { setName: "notes.pdf" },
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/notes.docx",
          currentName: "notes.docx",
          targetName: "notes.pdf",
          reason: "extension_would_change",
          steps: [1],
        },
      ],
      perStep: [1],
    });
  });

  it("excludes a target name SharePoint would refuse", () => {
    const result = resolveCustomPlan([step({ selector: JAN_2025, rename: { addSuffix: "?" } })], snapshot);

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report?.pdf",
          reason: "invalid_target_name",
          steps: [1],
        },
      ],
      perStep: [1],
    });
  });

  it("excludes a rename onto a path another file already occupies", () => {
    const result = resolveCustomPlan([step({ selector: JAN_2025, rename: { setName: "Feb report.pdf" } })], snapshot);

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Feb report.pdf",
          reason: "target_path_already_occupied",
          steps: [1],
        },
      ],
      perStep: [1],
    });
  });

  it("compares occupancy ignoring case", () => {
    const result = resolveCustomPlan([step({ selector: JAN_2025, rename: { setName: "FEB REPORT.pdf" } })], snapshot);

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "FEB REPORT.pdf",
          reason: "target_path_already_occupied",
          steps: [1],
        },
      ],
      perStep: [1],
    });
  });

  it("excludes every item of a group sharing one target, each carrying the union of the group's steps", () => {
    const result = resolveCustomPlan(
      [
        step({ selector: JAN_2025, moveTo: "/Archive/2025" }),
        step({
          selector: { folder: "/Client A/2026", nameEquals: "Jan report.pdf" },
          moveTo: "/Archive/2025",
        }),
      ],
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      items: [],
      exclusions: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report.pdf",
          reason: "two_items_share_one_target",
          steps: [1, 2],
        },
        {
          path: "Client A/2026/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report.pdf",
          reason: "two_items_share_one_target",
          steps: [1, 2],
        },
      ],
      perStep: [1, 1],
    });
  });

  it("never selects a file in another library", () => {
    const withOther = {
      files: [...FILES, { ...f("Client A/2025/other.pdf"), library: "Other" }],
      folderPaths: FOLDERS,
    };
    const result = resolveCustomPlan(
      [
        step({
          selector: { folder: "/Client A/2025", extensions: [".PDF"] },
          moveTo: "/Archive/2025",
        }),
      ],
      withOther,
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
});
