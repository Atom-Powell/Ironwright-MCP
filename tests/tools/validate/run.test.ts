import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runValidateStructure } from "../../../src/tools/validate/run.js";
import { createFakeToolContext, scanCoordinatorStub } from "../../tools/fake-context.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { ToolContext } from "../../../src/tools/context.js";
import type { ScanResult } from "../../../src/scan/run.js";

function contextWith(scan?: Partial<ScanResult>, joined = false, overrides: Partial<ToolContext> = {}): ToolContext {
  const result: ScanResult = {
    snapshot: {
      files: [
        { path: "2026/CLIENTA/09/2026-09_CLIENTA_MonthlyTraining.xlsx", name: "2026-09_CLIENTA_MonthlyTraining.xlsx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
      ],
      folderPaths: ["2026", "2026/CLIENTA", "2026/CLIENTA/09-September"],
      scannedAt: "2026-09-17T00:00:00.000Z",
      searchCrossCheckIncluded: false,
    },
    driveId: "drive-1",
    mode: "incremental",
    resynced: false,
    pages: 1,
    changesApplied: 0,
    graphRequests: 6,
    storeBatches: 0,
    unfilteredFileCount: 1,
    unfilteredFolderCount: 2,
    ...scan,
  };

  return createFakeToolContext({
    scans: scanCoordinatorStub(async () => ({ result, joined })),
    ...overrides,
  });
}

/**
 * The example profile with its taxonomy's only {client} segment renamed away,
 * so `clientSegmentIndex` returns -1 while the profile otherwise still loads.
 * Nothing in ProfileSchema ties taxonomy.segments to naming.template, so this
 * is a valid profile with no per-client folder structure to validate.
 */
function profileWithNoClientSegment(): ToolContext {
  const contents = JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as {
    taxonomy: { segments: string[] };
  };
  contents.taxonomy.segments = ["{year}", "{month:02}"];

  return createFakeToolContext({
    profiles: createProfileRegistry([{ source: "example.json", contents }]),
  });
}

describe("runValidateStructure", () => {
  it("returns a structured validation and a text block", async () => {
    const result = await runValidateStructure({ profileId: "example" }, contextWith());

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { profileId: string; library: string };
    expect(structured.profileId).toBe("example");
    expect(structured.library.length).toBeGreaterThan(0);
  });

  it("returns isError with the registry's own message for an unknown profile", async () => {
    const result = await runValidateStructure({ profileId: "no-such-profile" }, contextWith());

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no-such-profile");
  });

  it("refuses a profile whose taxonomy has no {client} segment, naming the taxonomy, without scanning", async () => {
    const context: ToolContext = {
      ...profileWithNoClientSegment(),
      scans: scanCoordinatorStub(() => Promise.reject(new Error("must not be called"))),
    };

    const result = await runValidateStructure({ profileId: "example" }, context);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("{year}");
    expect(JSON.stringify(result.content)).toContain("{month:02}");
  });

  it("reports missing for a client named explicitly that has no folder in the library", async () => {
    const result = await runValidateStructure({ profileId: "example", clients: ["CLIENTZ"] }, contextWith());

    const structured = result.structuredContent as { clients: Array<{ client: string; verdict: string }> };
    expect(structured.clients).toEqual([{ client: "CLIENTZ", verdict: "missing", nonConformingFolders: [], nonConformingFoldersOmitted: 0, nonConformingFiles: [], nonConformingFilesOmitted: 0 }]);
  });

  it("evaluates every client folder present and never reports missing when clients is omitted", async () => {
    const result = await runValidateStructure({ profileId: "example" }, contextWith());

    const structured = result.structuredContent as { clients: Array<{ client: string; verdict: string }> };
    expect(structured.clients.map((client) => client.client)).toEqual(["CLIENTA"]);
    expect(structured.clients.every((client) => client.verdict !== "missing")).toBe(true);
  });

  it("reports zero Graph requests for a call that joined a scan it did not start", async () => {
    const context = contextWith({ graphRequests: 42 }, true);

    const result = await runValidateStructure({ profileId: "example" }, context);
    const structured = result.structuredContent as { graphRequests: number };

    expect(structured.graphRequests).toBe(0);
  });

  it("reports the Graph cost this call actually paid when it started the scan", async () => {
    const result = await runValidateStructure({ profileId: "example" }, contextWith({ graphRequests: 6 }, false));
    const structured = result.structuredContent as { graphRequests: number };

    expect(structured.graphRequests).toBe(6);
  });
});
