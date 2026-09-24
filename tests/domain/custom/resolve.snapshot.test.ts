import { describe, expect, it } from "vitest";
import { resolveCustomPlan } from "../../../src/domain/custom/resolve.js";
import type { DeltaItem } from "../../../src/graph/delta.js";
import { changesFromDeltaItems } from "../../../src/scan/changes.js";
import { assembleSnapshot } from "../../../src/scan/snapshot.js";
import type { InventoryRecord } from "../../../src/store/types.js";

/**
 * The resolver consumes the repository snapshot, so this suite obtains that
 * snapshot from the real producers, the delta item mapper and the snapshot
 * assembler, rather than building one by hand. A hand-built snapshot proves
 * only what its author believed the assembler returns, which is the failure
 * CLAUDE.md records twice. The delta page below is fake; everything after it
 * is the code a live scan runs.
 */
const DRIVE_ROOT = "/drives/d1/root:";

function folder(id: string, name: string, parent: string): DeltaItem {
  return { id, name, parentReference: { path: parent }, folder: {} };
}

function pdf(id: string, name: string, parent: string, modified: string): DeltaItem {
  return {
    id,
    name,
    size: 2048,
    lastModifiedDateTime: modified,
    eTag: `"{GUID},${id}"`,
    parentReference: { path: parent },
    file: {},
  };
}

const DELTA_PAGE: DeltaItem[] = [
  // Every delta response carries the drive root; the mapper drops it, and the
  // resolver must still accept the library root as a folder.
  { id: "root", name: "root", root: {}, folder: {} },
  folder("f1", "Client A", DRIVE_ROOT),
  folder("f2", "2025", `${DRIVE_ROOT}/Client A`),
  folder("f3", "Archive", DRIVE_ROOT),
  pdf("1", "Jan report.pdf", `${DRIVE_ROOT}/Client A/2025`, "2025-01-31T00:00:00Z"),
  pdf("2", "notes.docx", `${DRIVE_ROOT}/Client A/2025`, "2025-03-01T00:00:00Z"),
  pdf("3", "top.pdf", DRIVE_ROOT, "2025-04-01T00:00:00Z"),
];

function snapshotFromDelta() {
  const records: InventoryRecord[] = changesFromDeltaItems(DELTA_PAGE).flatMap((change) =>
    change.kind === "upsert" ? [change.record] : [],
  );
  return assembleSnapshot(records, "2026-09-24T12:00:00Z");
}

describe("resolveCustomPlan over a snapshot from the real assembler", () => {
  it("resolves a move into an existing folder, with the index's own paths", () => {
    const resolution = resolveCustomPlan(
      [{ selector: { folder: "/client a/2025", extensions: [".pdf"] }, moveTo: "/archive" }],
      snapshotFromDelta(),
    );

    expect(resolution).toEqual({
      ok: true,
      items: [
        {
          path: "Client A/2025/Jan report.pdf",
          currentName: "Jan report.pdf",
          targetName: "Jan report.pdf",
          targetPath: "Archive/Jan report.pdf",
          step: 1,
        },
      ],
      exclusions: [],
      perStep: [1],
    });
  });

  it("selects from the library root, which the assembler never lists as a folder", () => {
    const resolution = resolveCustomPlan(
      [{ selector: { folder: "/" }, moveTo: "/Archive" }],
      snapshotFromDelta(),
    );

    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.items.map((item) => item.path)).toEqual(["top.pdf"]);
  });

  it("refuses a folder the scan did not find, naming the nearest folder it did", () => {
    const resolution = resolveCustomPlan(
      [{ selector: { folder: "/Client A/2025" }, moveTo: "/Client A/2027" }],
      snapshotFromDelta(),
    );

    expect(resolution).toEqual({
      ok: false,
      refusal: {
        kind: "unknown_folder",
        step: 1,
        field: "moveTo",
        requested: "/Client A/2027",
        nearestExisting: "Client A",
        children: ["Client A/2025"],
      },
    });
  });
});
