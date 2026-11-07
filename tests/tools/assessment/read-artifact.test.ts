import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReadAssessmentArtifact } from "../../../src/tools/assessment/read-artifact.js";
import { sha256Hex } from "../../../src/tools/assessment/hash.js";
import { RESOLVE_DRIVE_SCRIPT, assessmentToolContext, createScriptedGraph, fileItem, listItem, resultText } from "./fake-graph.js";
import { DOSSIER_PATH, ID, PROFILE, PUBLICATION_PATH, assessmentByIdQuery, contentRead, dossierItem, itemRead, stateFields } from "./state-script.js";

const INPUT = { profileId: PROFILE, assessmentId: ID, kind: "dossier" };
const FOUND = [...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([listItem("2", stateFields())])];

describe("read_assessment_artifact", () => {
  it("returns the artifact's text with its size, hash and ETag", async () => {
    const bytes = new TextEncoder().encode("# probe v2\n");
    const { graph, calls } = createScriptedGraph([...FOUND, itemRead(DOSSIER_PATH, dossierItem('"e1"', 16)), contentRead(DOSSIER_PATH, bytes)]);

    const result = await runReadAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      assessmentId: ID,
      kind: "dossier",
      path: DOSSIER_PATH,
      content: "# probe v2\n",
      bytes: 11,
      sha256: sha256Hex(bytes),
      eTag: '"e1"',
      graphRequests: graph.requests(),
    });
    expect(calls.filter((call) => call.method !== "get" && call.method !== "getBytes")).toEqual([]);
  });
});

describe("read_assessment_artifact failures", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an assessment id no item carries", async () => {
    const { graph } = createScriptedGraph([...RESOLVE_DRIVE_SCRIPT, assessmentByIdQuery([])]);

    const result = await runReadAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(resultText(result)).toContain(`No item in list "Assessments" carries the assessment id "${ID}"`);
  });

  it("reports an artifact absent from its path, naming the path", async () => {
    const { graph } = createScriptedGraph([...FOUND, itemRead(DOSSIER_PATH, undefined)]);

    const result = await runReadAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(DOSSIER_PATH);
    expect(resultText(result)).toContain("No file is at");
  });

  it("reports bytes that are not UTF-8 text with their size and hash", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
    const { graph } = createScriptedGraph([...FOUND, itemRead(DOSSIER_PATH, dossierItem('"e1"', 3)), contentRead(DOSSIER_PATH, bytes)]);

    const result = await runReadAssessmentArtifact(INPUT, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("not UTF-8 text");
    expect(resultText(result)).toContain("3 bytes");
    expect(resultText(result)).toContain(sha256Hex(bytes));
  });

  it("reads kind publication, and answers a binary .docx with its size and hash", async () => {
    // A zip local file header followed by a byte no UTF-8 sequence starts with, as a .docx carries.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0xff, 0x9c]);
    const { graph } = createScriptedGraph([
      ...FOUND,
      itemRead(PUBLICATION_PATH, fileItem(`Acme Corp_${ID}_Risk_Assessment.docx`, '"p1"', bytes.byteLength)),
      contentRead(PUBLICATION_PATH, bytes),
    ]);

    const result = await runReadAssessmentArtifact({ ...INPUT, kind: "publication" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(PUBLICATION_PATH);
    expect(resultText(result)).toContain(`${bytes.byteLength} bytes`);
    expect(resultText(result)).toContain(sha256Hex(bytes));
  });

  it("refuses a kind the profile does not name before any Graph request", async () => {
    const { graph } = createScriptedGraph([]);

    const result = await runReadAssessmentArtifact({ ...INPUT, kind: "appendix" }, assessmentToolContext(graph));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("dossier, executive_summary, publication");
    expect(graph.requests()).toBe(0);
  });
});
