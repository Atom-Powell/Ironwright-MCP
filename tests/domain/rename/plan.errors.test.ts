import { describe, expect, it } from "vitest";
import { MisnamedArtifactShapeError, pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import type { ArtifactFinding } from "../../../src/domain/reconcile/index.js";
import { misnamed, report } from "./plan.test.js";

describe("collisions", () => {
  it("excludes both files when two in one folder would take the same canonical name", () => {
    const first = misnamed("CLIENTA", "one.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const second = misnamed("CLIENTA", "two.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(report([first, second]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions.map((collision) => collision.currentName).sort()).toEqual(["one.xlsx", "two.xlsx"]);
    for (const collision of pairing.collisions) {
      expect(collision.reason).toBe("two_files_share_one_target_name");
    }
  });

  it("excludes a file whose canonical name is already taken by a compliant file", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const occupant: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 2 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "compliant",
      matched: {
        path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        etag: "e2",
      },
    };

    const pairing = pairMisnamedArtifacts(report([candidate, occupant]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions[0]?.reason).toBe("target_path_already_occupied");
  });

  it("excludes a file whose canonical name is already taken by an orphan", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        orphans: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            kind: "unexpected",
          },
        ],
      }),
    );

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions[0]?.reason).toBe("target_path_already_occupied");
  });

  it("excludes a file whose canonical name is already taken by a duplicate in this library", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        duplicates: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            slot: { client: "CLIENTA", deliverable: "MonthlyTraining", period: { year: 2026, month: 1 } },
            state: "compliant",
          },
        ],
      }),
    );

    expect(pairing.collisions[0]?.reason).toBe("target_path_already_occupied");
  });

  it("does not treat a file in ANOTHER library as occupying the target path", () => {
    // A qualified path is relative to a library this plan does not write to,
    // so it cannot collide with anything here. Treating it as an occupant
    // would refuse a rename that is perfectly safe.
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        duplicates: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            slot: { client: "CLIENTA", deliverable: "MonthlyTraining", period: { year: 2026, month: 1 } },
            state: "compliant",
            library: "Archive",
          },
        ],
      }),
    );

    expect(pairing.collisions).toEqual([]);
    expect(pairing.candidates).toHaveLength(1);
  });
});

describe("shapes this function refuses rather than guesses at", () => {
  it("skips a misnamed artifact found in another library, since moving it is not a rename", () => {
    const foreign = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const matched = foreign.matched;
    if (matched === undefined) throw new Error("fixture lost its match");
    const withLibrary: ArtifactFinding = { ...foreign, matched: { ...matched, library: "Archive" } };

    const pairing = pairMisnamedArtifacts(report([withLibrary]));

    expect(pairing.candidates).toEqual([]);
    expect(pairing.collisions).toEqual([]);
  });

  it("skips a misnamed artifact carrying no matched file at all", () => {
    const unmatched: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "misnamed",
    };

    expect(pairMisnamedArtifacts(report([unmatched])).candidates).toEqual([]);
  });

  it("refuses a misnamed artifact whose match is in a different folder from its expected path", () => {
    const wrongFolder: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "misnamed",
      matched: { path: "2026/CLIENTA/02-February/wrong.xlsx", name: "wrong.xlsx", etag: "e1" },
    };

    expect(() => pairMisnamedArtifacts(report([wrongFolder]))).toThrow(MisnamedArtifactShapeError);
  });

  it("refuses a misnamed artifact whose current name already equals its expected name", () => {
    const sameName: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 1 },
      expectedPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
      expectedName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
      state: "misnamed",
      matched: {
        path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        etag: "e1",
      },
    };

    expect(() => pairMisnamedArtifacts(report([sameName]))).toThrow(MisnamedArtifactShapeError);
  });
});
