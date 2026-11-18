import { describe, expect, it } from "vitest";
import { runVerifyPublication } from "../../../src/tools/assessment/verify-publication.js";
import { readFileSync } from "node:fs";
import { createProfileRegistry } from "../../../src/profiles/registry.js";
import type { GraphClient } from "../../../src/graph/client.js";
import type { ToolContext } from "../../../src/tools/context.js";
import { createFakeToolContext } from "../fake-context.js";
import { RESOLVE_DRIVE_SCRIPT, SITE_URL, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, resultText } from "./fake-graph.js";
import { ID, PROFILE, PUBLICATION_PATH, SUMMARY_PATH, assessmentByIdQuery, itemRead, stateFields } from "./state-script.js";

const INPUT = { profileId: PROFILE, assessmentId: ID };
const EXPECTED_NAME = "Acme Corp_ASM-2026-00002_Risk_Assessment.docx";
const FOUND = [...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([listItem("2", stateFields())])];

// The kind verified is one the profile lists as produced outside the server. With one such kind
// the caller names nothing, which is the vendor risk workflow and every call made before this.
describe("verify_publication and the profile's external kinds", () => {
  function contextWith(graph: GraphClient, external: string[]): ToolContext {
    const profile = JSON.parse(readFileSync("examples/profiles/assessment-example.json", "utf8")) as { lifecycle: Record<string, unknown> };
    profile.lifecycle.external = external;
    const profiles = createProfileRegistry([{ source: "assessment-example.json", contents: profile }], SITE_URL);
    return createFakeToolContext({ profiles, graph });
  }

  it("checks the kind named when the profile lists several", async () => {
    const name = `${ID}_Executive_Summary.md`;
    const { graph } = createScriptedGraph([...FOUND, itemRead(SUMMARY_PATH, fileItem(name, '"s1"', 12))]);

    const result = await runVerifyPublication({ ...INPUT, kind: "executive_summary" }, contextWith(graph, ["publication", "executive_summary"]));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ kind: "executive_summary", present: true, path: SUMMARY_PATH, expectedName: name });
    expect(resultText(result)).toContain(`The executive_summary for ${ID} is at ${SUMMARY_PATH}`);
  });

  it("asks which kind when the profile lists several and none is named, before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runVerifyPublication(INPUT, contextWith(graph, ["publication", "executive_summary"]));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`Profile "${PROFILE}" lists more than one external artifact kind (publication, executive_summary); name the one to check as kind. Nothing was read.`);
    expect(graph.requests()).toBe(0);
  });

  it("refuses a kind the profile does not list as external, naming the ones it does", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runVerifyPublication({ ...INPUT, kind: "dossier" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`Profile "${PROFILE}" does not list "dossier" as an external artifact kind. Its external kinds are publication. Nothing was read.`);
    expect(graph.requests()).toBe(0);
  });

  it("says there is nothing to check when the profile lists no external kind", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runVerifyPublication(INPUT, contextWith(graph, []));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`Profile "${PROFILE}" lists no external artifact kind, so there is nothing for verify_publication to check. Nothing was read.`);
    expect(graph.requests()).toBe(0);
  });
});

describe("verify_publication", () => {
  it("reports the publication present with the facts read from its item", async () => {
    const item = fileItem(EXPECTED_NAME, '"p1"', 48213);
    const { graph, calls } = createScriptedGraph([...FOUND, itemRead(PUBLICATION_PATH, item)]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      kind: "publication",
      present: true,
      path: PUBLICATION_PATH,
      expectedName: EXPECTED_NAME,
      name: EXPECTED_NAME,
      size: 48213,
      eTag: '"p1"',
      lastModifiedDateTime: item.lastModifiedDateTime,
      webUrl: item.webUrl,
      graphRequests: graph.requests(),
    });
    expect(calls.filter((call) => call.method !== "get")).toEqual([]);
  });

  it("reports the publication absent without an error", async () => {
    const { graph } = createScriptedGraph([...FOUND, itemRead(PUBLICATION_PATH, undefined)]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ present: false, path: PUBLICATION_PATH, expectedName: EXPECTED_NAME });
    expect(resultText(result)).toContain(`The publication is not at ${PUBLICATION_PATH}`);
  });

  it("reports a folder at the path as not present", async () => {
    const { graph } = createScriptedGraph([...FOUND, itemRead(PUBLICATION_PATH, folderItem(EXPECTED_NAME))]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ present: false });
    expect(resultText(result)).toContain("a folder, not a file");
  });

  it("reports a file whose name differs from the expected one only by case as not present, naming both", async () => {
    const actual = "acme corp_ASM-2026-00002_risk_assessment.docx";
    const { graph } = createScriptedGraph([...FOUND, itemRead(PUBLICATION_PATH, fileItem(actual, '"p1"', 48213))]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ kind: "publication", present: false, path: PUBLICATION_PATH, expectedName: EXPECTED_NAME, name: actual, graphRequests: graph.requests() });
    expect(resultText(result)).toBe(
      `The publication for ${ID} is not present under its expected name: a file named "${actual}" is at ${PUBLICATION_PATH}, and the expected name is "${EXPECTED_NAME}".`,
    );
  });

  it("reports an assessment id no item carries as an error", async () => {
    const { graph } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([])]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`No item in list "Assessments" carries the assessment id "${ID}"`);
  });

  it("names the stored assessment id in its prose when the caller's spelling differs by case", async () => {
    const typed = ID.toLowerCase();
    const { graph } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([listItem("2", stateFields())], typed), itemRead(PUBLICATION_PATH, folderItem("x"))]);

    const result = await runVerifyPublication({ ...INPUT, assessmentId: typed }, assessmentToolContext(graph));

    expect(resultText(result)).toBe(`The publication for ${ID} is not present: a folder, not a file, is at ${PUBLICATION_PATH}.`);
  });
});
