import { readFileSync } from "node:fs";
import type { RepositoryFile, RepositorySnapshot } from "../../../src/domain/reconcile/index.js";
import type { GraphClient } from "../../../src/graph/client.js";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { StoredPlan } from "../../../src/store/types.js";
import type { ToolContext } from "../../../src/tools/context.js";
import { createFakeToolContext, scanCoordinatorStub } from "../fake-context.js";
import { etagGraphClient, file, scanResultFor, snapshot } from "../rename/fixtures.js";

export const SITE = "https://contoso.sharepoint.com/sites/Example";
export const PLAN_ID = "cus-2026-09-24-a1b2c3d4";

/** The same library Task 3's resolver tests use, so the two suites describe one tree. */
export const FOLDERS = ["Client A", "Client A/2025", "Client A/2026", "Archive", "Archive/2025"];

function dated(path: string, modified = "2026-03-01T00:00:00Z"): RepositoryFile {
  return { ...file(path), modified };
}

export const JAN_2025 = "Client A/2025/Jan report.pdf";
export const FEB_2025 = "Client A/2025/Feb report.pdf";

export const FILES: RepositoryFile[] = [
  dated(JAN_2025, "2025-01-31T00:00:00Z"),
  dated(FEB_2025, "2025-02-28T00:00:00Z"),
  dated("Client A/2025/notes.docx", "2025-03-01T00:00:00Z"),
  dated("Client A/2026/Jan report.pdf"),
  dated("Archive/2025/old.pdf"),
];

export function customSnapshot(files: RepositoryFile[] = FILES, folders: string[] = FOLDERS): RepositorySnapshot {
  return snapshot(files, folders);
}

/** One etag per file, keyed by path, so any lookup the handler issues is answered and recorded. */
export function etagsFor(files: readonly RepositoryFile[] = FILES): Record<string, string> {
  return Object.fromEntries(files.map((entry, index) => [entry.path, `"{GUID},${String(index + 1)}"`]));
}

export function customGraph(files: readonly RepositoryFile[] = FILES) {
  return etagGraphClient(etagsFor(files));
}

/**
 * A registry carrying the compliance example profile, the library-only
 * "shared-docs" profile and the assessment "vendor-assessments" profile, since
 * generate_custom_plan works over any of them.
 */
export function customContext(graph: GraphClient, snapshotValue: RepositorySnapshot = customSnapshot()): ToolContext {
  const result = scanResultFor(snapshotValue);
  return createFakeToolContext({
    profiles: createProfileRegistry(
      [
        {
          source: "example.json",
          contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
        },
        {
          source: "library-example.json",
          contents: JSON.parse(readFileSync("examples/profiles/library-example.json", "utf8")) as unknown,
        },
        {
          source: "assessment-example.json",
          contents: JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as unknown,
        },
      ],
      SITE,
    ),
    graph,
    scans: scanCoordinatorStub(() => Promise.resolve({ result, joined: false })),
    now: () => new Date("2026-09-24T12:00:00Z"),
  });
}

/** The request the happy-path tests share: every PDF in /Client A/2025 into /Archive/2025. */
export const MOVE_PDFS_STEPS = [
  { selector: { folder: "/Client A/2025", extensions: [".pdf"] }, moveTo: "/Archive/2025" },
];

/**
 * A stored custom plan for execute_custom_plan's own tests, built by hand
 * rather than through runGenerateCustomPlan: those tests exercise the shared
 * executor over a plan already on disk, the same way movePlanWith in
 * tests/tools/move/fixtures.ts does for execute_move_plan.
 */
export function customPlanWith(items: StoredPlan["items"], excluded: StoredPlan["excluded"] = []): StoredPlan {
  return {
    planId: PLAN_ID,
    profileId: "example",
    kind: "custom",
    driveId: "drive-1",
    createdAt: "2026-09-24T12:00:00Z",
    items,
    excluded,
  };
}

/** Both a move and a rename in one item, so the executor test proves it does both writes at once. */
export const JAN_TARGET = "Archive/2025/Jan report renamed.pdf";
export const FEB_TARGET = "Archive/2025/Feb report renamed.pdf";

export const JAN_ITEM = {
  path: JAN_2025,
  currentName: "Jan report.pdf",
  targetName: "Jan report renamed.pdf",
  targetPath: JAN_TARGET,
  etag: "etag-0",
  client: "",
  step: 1,
};

export const FEB_ITEM = {
  path: FEB_2025,
  currentName: "Feb report.pdf",
  targetName: "Feb report renamed.pdf",
  targetPath: FEB_TARGET,
  etag: "etag-0",
  client: "",
  step: 1,
};
