import { describe, expect, it } from "vitest";
import { MisnamedArtifactShapeError, pairMisnamedArtifacts } from "../../../src/domain/rename/plan.js";
import type { ArtifactFinding } from "../../../src/domain/reconcile/index.js";
import { misnamed, misnamedDuplicate, report } from "./fixtures.js";

describe("collisions", () => {
  // A report with two ArtifactFinding entries sharing one target path used to
  // be tested here directly, but the engine cannot produce that shape: the
  // canonical name is a pure function of a slot, so two files that would both
  // claim it necessarily parse to the same slot, and matchArtifacts resolves
  // that competition into one winning artifact plus a DuplicateFinding before
  // pairMisnamedArtifacts ever sees the report. A test pinning the shape the
  // engine cannot produce is worse than no test, so this now matches what a
  // real report actually looks like: one misnamed winner and one misnamed
  // duplicate sharing its slot.
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

  it("excludes a file whose canonical name is already taken by a compliant file", () => {
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");
    const occupant: ArtifactFinding = {
      client: "CLIENTA",
      deliverable: "MonthlyTraining",
      period: { year: 2026, month: 2 },
      expectedPath: "2026/CLIENTA/01-January",
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
    // The duplicate names a DIFFERENT slot (month 2, not month 1) from the
    // candidate's. Two duplicates cannot share a slot with a misnamed
    // candidate unless they rank no better than "misnamed" -- see the winning
    // duplicate test above -- so the only shape that reaches
    // target_path_already_occupied through a same-library duplicate at all is
    // one unrelated slot's leftover file that happens to physically sit at
    // this candidate's target path.
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        duplicates: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            slot: { client: "CLIENTA", deliverable: "MonthlyTraining", period: { year: 2026, month: 2 } },
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
    //
    // The duplicate shares the candidate's own slot, so its state has to rank
    // no better than "misnamed" for the candidate to legitimately be that
    // slot's winner: "misnamed_and_misplaced" rather than "compliant", which
    // a library-qualified match can never carry anyway, since
    // computeState in match.ts forces locationCorrect false whenever library
    // is set.
    const candidate = misnamed("CLIENTA", "wrong.xlsx", "2026-01_CLIENTA_MonthlyTraining.xlsx");

    const pairing = pairMisnamedArtifacts(
      report([candidate], {
        duplicates: [
          {
            path: "2026/CLIENTA/01-January/2026-01_CLIENTA_MonthlyTraining.xlsx",
            name: "2026-01_CLIENTA_MonthlyTraining.xlsx",
            slot: { client: "CLIENTA", deliverable: "MonthlyTraining", period: { year: 2026, month: 1 } },
            state: "misnamed_and_misplaced",
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
