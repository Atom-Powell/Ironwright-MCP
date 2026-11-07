import { describe, expect, it } from "vitest";
import { runVerifyPublication } from "../../../src/tools/assessment/verify-publication.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, folderItem, listItem, resultText } from "./fake-graph.js";
import { ID, PROFILE, PUBLICATION_PATH, assessmentByIdQuery, itemRead, stateFields } from "./state-script.js";

const INPUT = { profileId: PROFILE, assessmentId: ID };
const EXPECTED_NAME = "Acme Corp_ASM-2026-00002_Risk_Assessment.docx";
const FOUND = [...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([listItem("2", stateFields())])];

describe("verify_publication", () => {
  it("reports the publication present with the facts read from its item", async () => {
    const item = fileItem(EXPECTED_NAME, '"p1"', 48213);
    const { graph, calls } = createScriptedGraph([...FOUND, itemRead(PUBLICATION_PATH, item)]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
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

  it("reports an assessment id no item carries as an error", async () => {
    const { graph } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([])]);

    const result = await runVerifyPublication(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`No item in list "Assessments" carries the assessment id "${ID}"`);
  });
});
