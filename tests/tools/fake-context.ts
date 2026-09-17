import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../src/profiles/registry.js";
import { createMemoryStateStore } from "../../src/store/memory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { ScanCoordinator } from "../../src/scan/coordinator.js";

/**
 * A context whose dependencies do nothing useful, for suites that exercise the
 * wiring rather than the work. The Graph client and the scan coordinator reject
 * rather than returning plausible empty data, so a test that accidentally
 * depends on one fails loudly instead of asserting against a fabricated result.
 * An empty file list is the single most dangerous fake this project could hold,
 * because it is also what a correct scan of an empty library returns, and a
 * report built on it would name every expected file as missing while looking
 * entirely well formed.
 */
export function createFakeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const graph: GraphClient = {
    get: () => Promise.reject(new Error("the fake Graph client was called")),
    post: () => Promise.reject(new Error("the fake Graph client was called")),
    getBytes: () => Promise.reject(new Error("the fake Graph client was called")),
    requests: () => 0,
  };

  const scans: ScanCoordinator = {
    run: () => Promise.reject(new Error("the fake scan coordinator was called")),
  };

  return {
    profiles: createProfileRegistry([
      {
        source: "example.json",
        contents: JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      },
    ]),
    graph,
    store: createMemoryStateStore(),
    scans,
    now: () => new Date("2026-09-14T12:00:00Z"),
    ...overrides,
  };
}
