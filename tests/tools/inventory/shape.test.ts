import { describe, expect, it } from "vitest";
import { MAX_INVENTORY_ITEMS, shapeInventory } from "../../../src/tools/inventory/shape.js";
import type { RepositorySnapshot } from "../../../src/domain/reconcile/index.js";

const snapshot: RepositorySnapshot = {
  files: [
    { path: "2026/CLIENTA/report.docx", name: "report.docx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
    { path: "2026/CLIENTB/report.docx", name: "report.docx", size: 30, modified: "2026-09-02T00:00:00.000Z", etag: "b" },
  ],
  folderPaths: ["2026", "2026/CLIENTA", "2026/CLIENTB"],
  scannedAt: "2026-09-17T00:00:00.000Z",
  searchCrossCheckIncluded: false,
};

describe("shapeInventory", () => {
  it("counts the whole library and lists all of it when under the cap", () => {
    const output = shapeInventory("example", "Documents", snapshot, undefined, 4, false, {});

    expect(output.library).toBe("Documents");
    expect(output.totals).toEqual({ files: 2, folders: 3, bytes: 42 });
    expect(output.listing).toEqual({ returned: 5, omitted: 0, cap: MAX_INVENTORY_ITEMS, truncated: false });
  });

  it("narrows to a sub-path on segment boundaries, not string prefixes", () => {
    const withSibling: RepositorySnapshot = {
      ...snapshot,
      files: [
        ...snapshot.files,
        { path: "2026/CLIENTAB/report.docx", name: "report.docx", size: 5, modified: "2026-09-03T00:00:00.000Z", etag: "c" },
      ],
      folderPaths: [...snapshot.folderPaths, "2026/CLIENTAB"],
    };

    const output = shapeInventory("example", "Documents", withSibling, "2026/CLIENTA", 4, false, {});

    expect(output.totals).toEqual({ files: 1, folders: 1, bytes: 12 });
    expect(output.items.map((item) => item.path)).not.toContain("2026/CLIENTAB/report.docx");
  });

  it("excludes a file the Search cross-check found in a different library", () => {
    const withCrossLibrary: RepositorySnapshot = {
      ...snapshot,
      files: [
        ...snapshot.files,
        {
          path: "2026/CLIENTC/report.docx",
          name: "report.docx",
          size: 99,
          modified: "2026-09-04T00:00:00.000Z",
          etag: "d",
          library: "Other Library",
        },
      ],
    };

    const output = shapeInventory("example", "Documents", withCrossLibrary, undefined, 4, false, {});

    expect(output.totals).toEqual({ files: 2, folders: 3, bytes: 42 });
    expect(output.items.map((item) => item.path)).not.toContain("2026/CLIENTC/report.docx");
  });

  it("keeps the totals exact when the listing truncates", () => {
    const output = shapeInventory("example", "Documents", snapshot, undefined, 4, false, { maxItems: 2 });

    expect(output.totals).toEqual({ files: 2, folders: 3, bytes: 42 });
    expect(output.listing).toEqual({ returned: 2, omitted: 3, cap: 2, truncated: true });
    expect(output.items).toHaveLength(2);
  });

  it("omits size and modified for a folder rather than reporting a false value", () => {
    const output = shapeInventory("example", "Documents", snapshot, undefined, 4, false, {});
    const folder = output.items.find((item) => item.kind === "folder");

    expect(folder).toBeDefined();
    expect(folder).not.toHaveProperty("size");
    expect(folder).not.toHaveProperty("modified");
  });

  it("carries a file's own size and modified date through unchanged", () => {
    const output = shapeInventory("example", "Documents", snapshot, undefined, 4, false, {});
    const file = output.items.find((item) => item.path === "2026/CLIENTA/report.docx");

    expect(file).toMatchObject({ size: 12, modified: "2026-09-01T00:00:00.000Z" });
  });

  it("omits subPath from the output when none was given", () => {
    const output = shapeInventory("example", "Documents", snapshot, undefined, 4, false, {});

    expect(output).not.toHaveProperty("subPath");
  });

  it("carries subPath through when one was given", () => {
    const output = shapeInventory("example", "Documents", snapshot, "2026/CLIENTA", 4, false, {});

    expect(output.subPath).toBe("2026/CLIENTA");
  });

  it("reports the graphRequests it was given", () => {
    const output = shapeInventory("example", "Documents", snapshot, undefined, 7, false, {});

    expect(output.graphRequests).toBe(7);
  });
});
