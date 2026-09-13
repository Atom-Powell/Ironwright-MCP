import { describe, expect, it } from "vitest";
import { changesFromDeltaItems } from "../../src/scan/changes.js";

const PARENT = { path: "/drives/d1/root:/2026/CLIENTA" };

describe("changesFromDeltaItems", () => {
  it("turns a file into an upsert carrying its library-relative path and ETag", () => {
    expect(
      changesFromDeltaItems([
        {
          id: "i1",
          name: "report.xlsx",
          size: 2048,
          lastModifiedDateTime: "2026-09-01T10:00:00Z",
          eTag: "\"{GUID},3\"",
          parentReference: PARENT,
          file: {},
        },
      ]),
    ).toEqual([
      {
        kind: "upsert",
        record: {
          itemId: "i1",
          path: "2026/CLIENTA/report.xlsx",
          name: "report.xlsx",
          isFolder: false,
          size: 2048,
          modified: "2026-09-01T10:00:00Z",
          etag: "\"{GUID},3\"",
        },
      },
    ]);
  });

  it("marks a folder and gives it size zero", () => {
    const [change] = changesFromDeltaItems([
      {
        id: "i2",
        name: "CLIENTB",
        parentReference: { path: "/drives/d1/root:/2026" },
        folder: {},
        // Graph reports a folder's size as the recursive total of its contents.
        // A nonzero value here is what makes this test fail if the folder branch
        // is ever removed.
        size: 4096,
      },
    ]);
    expect(change).toMatchObject({ kind: "upsert", record: { isFolder: true, size: 0, path: "2026/CLIENTB" } });
  });

  it("turns a deleted item into a delete carrying only its id", () => {
    expect(changesFromDeltaItems([{ id: "i3", deleted: { state: "deleted" } }])).toEqual([
      { kind: "delete", itemId: "i3" },
    ]);
  });

  it("skips the drive root, which every delta response repeats", () => {
    expect(changesFromDeltaItems([{ id: "root-1", name: "root", root: {}, folder: {} }])).toEqual([]);
  });

  it("preserves order, because a later page entry supersedes an earlier one", () => {
    const changes = changesFromDeltaItems([
      { id: "i1", name: "a.xlsx", parentReference: PARENT, file: {} },
      { id: "i1", deleted: { state: "deleted" } },
    ]);
    expect(changes.map((change) => change.kind)).toEqual(["upsert", "delete"]);
  });
});
