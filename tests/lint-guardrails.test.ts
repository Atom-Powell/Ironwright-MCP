import { ESLint } from "eslint";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Two of this project's global constraints were, until this file existed,
 * enforced by prose alone.
 *
 * The first is the reconciliation engine's single entry point. Every stage is
 * a plain named export so its own unit tests can call it, so all ten were
 * importable from anywhere, and the design's reason for the rule -- that a
 * caller reaching a stage can compute a second, disagreeing answer to the same
 * compliance question -- had nothing behind it but a comment in index.ts.
 *
 * The second is "no clock in the domain layer". The purity rule there is an
 * import allowlist, and `Date`, `performance` and `Math` are globals, so no
 * import rule could ever see them. Defaulting asOf to the current month is a
 * one-line convenience edit that would have passed lint and typecheck.
 *
 * A lint rule nothing exercises is the same kind of decoration, so this file
 * runs ESLint over synthetic sources at real paths and asserts which rule
 * fires and which does not. It lints text rather than files on disk so the
 * violations it describes never have to exist in the tree.
 */
// Loading and resolving the flat config costs a second or two the first time,
// and this file runs alongside forty other workers, so the default per-test
// timeout is not a safe budget for whichever assertion happens to go first.
// The cost is paid once, in the hook, and every case after it is fast.
vi.setConfig({ testTimeout: 60_000 });

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint();
  await eslint.lintText("export const warm = 1;\n", { filePath: "src/server/probe.ts", warnIgnored: false });
}, 120_000);

async function ruleIdsFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).map((message) => message.ruleId ?? "unknown");
}

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).map((message) => message.message);
}

describe("the reconciliation engine's single entry point", () => {
  it("refuses a stage import from a tool module", async () => {
    const ruleIds = await ruleIdsFor(
      "src/tools/probe.ts",
      'import { deriveExpected } from "../domain/reconcile/expected.js";\nexport const use = deriveExpected;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("says where to import from instead", async () => {
    const messages = await messagesFor(
      "src/tools/probe.ts",
      'import { matchArtifacts } from "../domain/reconcile/match.js";\nexport const use = matchArtifacts;\n',
    );

    expect(messages.join("\n")).toContain("domain/reconcile/index.js");
  });

  it("refuses a type-only import of an internal module", async () => {
    // index.ts re-exports every report type, so a type import has no reason
    // to reach past the front door either, and exempting type imports would
    // leave the widest hole: types.ts is the module an outside caller is most
    // likely to reach for.
    const ruleIds = await ruleIdsFor(
      "src/tools/probe.ts",
      'import type { Slot } from "../domain/reconcile/types.js";\nexport type Use = Slot;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("refuses a stage import from a test outside the engine's own suite", async () => {
    const ruleIds = await ruleIdsFor(
      "tests/tools/probe.test.ts",
      'import { parseFile } from "../../src/domain/reconcile/parse.js";\nexport const use = parseFile;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("refuses a stage import from elsewhere in the domain layer", async () => {
    const ruleIds = await ruleIdsFor(
      "src/domain/profile/probe.ts",
      'import { windowBounds } from "../reconcile/period.js";\nexport const use = windowBounds;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("refuses a stage import written as a child path", async () => {
    // The rule matches the import string as written, not the module it
    // resolves to, so every spelling of the same reach has to be covered:
    // "../reconcile/x.js" from a sibling and "./reconcile/x.js" from the
    // layer above are the two that omit the "domain/" segment entirely.
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import { renderPath } from "./reconcile/render.js";\nexport const use = renderPath;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("allows the entry point through a child path", async () => {
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import { reconcile } from "./reconcile/index.js";\nexport const use = reconcile;\n',
    );

    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("allows the entry point itself", async () => {
    // Guards the guard. A rule that refused every path into the package would
    // satisfy every assertion above while making the engine unusable.
    const ruleIds = await ruleIdsFor(
      "src/tools/probe.ts",
      'import { reconcile } from "../domain/reconcile/index.js";\nexport const use = reconcile;\n',
    );

    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("allows the engine's own modules to import each other", async () => {
    const ruleIds = await ruleIdsFor(
      "src/domain/reconcile/probe.ts",
      'import { renderPath } from "./render.js";\nexport const use = renderPath;\n',
    );

    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("allows the engine's own unit tests to reach a stage", async () => {
    const ruleIds = await ruleIdsFor(
      "tests/domain/reconcile/probe.test.ts",
      'import { deriveExpected } from "../../../src/domain/reconcile/expected.js";\nexport const use = deriveExpected;\n',
    );

    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("still refuses an impure import inside the engine", async () => {
    // The entry-point rule and the purity allowlist are configured in
    // separate blocks over overlapping files, and ESLint gives one rule one
    // set of options per file, so a careless merge of the two would silently
    // drop whichever was configured first.
    const messages = await messagesFor(
      "src/domain/reconcile/probe.ts",
      'import { readFileSync } from "node:fs";\nexport const use = readFileSync;\n',
    );

    expect(messages.join("\n")).toContain("The domain layer is pure");
  });

  it("refuses a Graph access layer import", async () => {
    // Phase 2a added src/graph/, src/store/ and src/scan/ alongside the
    // transport, tool and setup layers the group already denied. The group's
    // own glob admits every relative path unless the layer it names is listed,
    // so this and the next case are what would have caught that gap.
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import { createGraphClient } from "../../graph/client.js";\nexport const use = createGraphClient;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("refuses a state store import", async () => {
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import type { StateStore } from "../../store/types.js";\nexport type Use = StateStore;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("refuses a workbook layer import", async () => {
    // src/workbook/ is the mapping layer that turns a grid of cell values into
    // ClientRecords. It is pure, so the fence is about layering rather than
    // purity: it imports the domain layer's entry point, and a domain module
    // importing back would make the dependency circular and put the engine
    // downstream of its own caller.
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import { readWorkbookGrid } from "../../workbook/read.js";\nexport const use = readWorkbookGrid;\n',
    );

    expect(ruleIds).toContain("no-restricted-imports");
  });

  it("names the workbook layer in the purity message", async () => {
    const messages = await messagesFor(
      "src/domain/probe.ts",
      'import { readWorkbookGrid } from "../../workbook/read.js";\nexport const use = readWorkbookGrid;\n',
    );

    expect(messages.join("\n")).toContain("workbook");
  });
});

describe("the domain layer's freedom from the clock", () => {
  it("refuses new Date() in the engine", async () => {
    const ruleIds = await ruleIdsFor("src/domain/reconcile/probe.ts", "export const now = new Date();\n");

    expect(ruleIds).toContain("no-restricted-globals");
  });

  it("refuses Date.now()", async () => {
    const ruleIds = await ruleIdsFor("src/domain/reconcile/probe.ts", "export const now = Date.now();\n");

    expect(ruleIds).toContain("no-restricted-globals");
  });

  it("refuses performance.now()", async () => {
    const ruleIds = await ruleIdsFor("src/domain/reconcile/probe.ts", "export const now = performance.now();\n");

    expect(ruleIds).toContain("no-restricted-globals");
  });

  it("refuses Math.random()", async () => {
    const ruleIds = await ruleIdsFor("src/domain/reconcile/probe.ts", "export const pick = Math.random();\n");

    expect(ruleIds).toContain("no-restricted-properties");
  });

  it("refuses the convenience edit the rule exists to stop", async () => {
    // The concrete one: defaulting the reference month to the current month.
    // It is a single line, it looks helpful, and it would make the engine
    // answer a different question every month while passing typecheck.
    const ruleIds = await ruleIdsFor(
      "src/domain/reconcile/probe.ts",
      "export function defaultAsOf() {\n  const today = new Date();\n  return { year: today.getFullYear(), month: today.getMonth() + 1 };\n}\n",
    );

    expect(ruleIds).toContain("no-restricted-globals");
  });

  it("refuses the clock elsewhere in the domain layer too", async () => {
    const ruleIds = await ruleIdsFor("src/domain/profile/probe.ts", "export const now = Date.now();\n");

    expect(ruleIds).toContain("no-restricted-globals");
  });

  it("leaves Math alone apart from random", async () => {
    // Guards the guard. The engine's period arithmetic is built on
    // Math.floor, so a rule that banned the Math object outright would break
    // the code it is meant to protect.
    const ruleIds = await ruleIdsFor("src/domain/reconcile/probe.ts", "export const index = Math.floor(25 / 12);\n");

    expect(ruleIds).not.toContain("no-restricted-properties");
  });

  it("leaves the clock alone outside the domain layer", async () => {
    // The transport and setup layers legitimately read the clock. Scoping is
    // the point: an engine-wide ban would be unenforceable and get switched
    // off rather than obeyed.
    const ruleIds = await ruleIdsFor("src/server/probe.ts", "export const now = new Date();\n");

    expect(ruleIds).not.toContain("no-restricted-globals");
  });
});
