import { describe, expect, it } from "vitest";
import { MisnamedArtifactShapeError, pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import type { ArtifactFinding } from "../../../src/domain/reconcile/index.js";
import { misnamed, misnamedDuplicate, report } from "./fixtures.js";

describe("collisions", () => {
  // This describe block used to hold four more tests: one pinning two
  // ArtifactFinding entries sharing a target path, and three pinning a
  // candidate's target path occupied by a compliant artifact, a duplicate,
  // or an orphan. All four were reports the engine cannot produce. The
  // canonical name is a pure function of a slot, so any same-library file
  // that would occupy a candidate's target necessarily carries that slot's
  // own canonical name, which means it parses back to that exact slot and
  // wins or loses it as an artifact or a duplicate rather than sitting beside
  // it as an unrelated occupant, and an orphan requires a slot nobody owes,
  // which a candidate's own target slot is not. A test pinning a shape the
  // engine cannot produce is worse than no test, so all four were deleted
  // with no replacement rather than patched into a different impossible
  // shape. The surviving coverage for these paths is
  // tests/domain/rename/plan.reconcile.test.ts, which cannot encode an
  // impossible report at all, since it asserts only on what a real
  // `reconcile()` call actually returned.
  it("keeps the slot's winner as the candidate and excludes the losing duplicate", () => {
    const winner = misnamed("CLIENTA", "one.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const loser = misnamedDuplicate("CLIENTA", "two.xlsx");

    const pairing = pairMisnamedArtifacts(report([winner], { duplicates: [loser] }));

    expect(pairing.candidates).toEqual([
      {
        path: "2026/CLIENTA/01-January/one.xlsx",
        currentName: "one.xlsx",
        targetName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        targetPath: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
        client: "CLIENTA",
      },
    ]);
    expect(pairing.collisions).toEqual([
      {
        path: "2026/CLIENTA/01-January/two.xlsx",
        currentName: "two.xlsx",
        targetName: "2026-01_CLIENTA_MonthlyTraining.xlsx",
        client: "CLIENTA",
        reason: "two_files_share_one_target_name",
      },
    ]);
  });
});

describe("shapes this function refuses rather than guesses at", () => {
  // Not a live cross-library case, and the shape below is one the engine
  // cannot produce: `computeState` makes `locationCorrect` false for any file
  // carrying a library, and only a `locationCorrect` file is reported as
  // `misnamed`, so a library-qualified match is always `misplaced` or
  // `misnamed_and_misplaced`. What this pins is the guard's behavior if that
  // contract is ever broken: a rename plan must not form for a file in another
  // library, because renaming it in place would leave it where it does not
  // belong while reporting the slot as put right.
  it("forms no rename for a misnamed artifact carrying a library, a contract the engine does not break today", () => {
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
      expectedPath: "2026/CLIENTA/01-January",
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
      expectedPath: "2026/CLIENTA/01-January",
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
      expectedPath: "2026/CLIENTA/01-January",
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
