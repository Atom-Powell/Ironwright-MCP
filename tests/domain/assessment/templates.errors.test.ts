import { describe, expect, it } from "vitest";
import { renderAssessmentId, renderWorkspaceTemplate, unknownWorkspacePlaceholders } from "../../../src/domain/assessment/templates.js";

const NOW = new Date("2026-11-07T20:39:24Z");
const VALUES = { vendor: "A", vendorFolder: "A", assessmentId: "X" };

describe("rendering refuses what validation would have refused", () => {
  it("throws on an unknown workspace placeholder, naming it", () => {
    expect(() => renderWorkspaceTemplate("{client}/x", VALUES)).toThrow(/client/);
  });
  it.each(["yyyy", "mm"])("refuses {%s} in a workspace template, since a path rendered from the clock would move under an open assessment", (token) => {
    expect(unknownWorkspacePlaceholders(`Assessments/{${token}}/{assessmentId}`)).toEqual([token]);
    expect(() => renderWorkspaceTemplate(`Assessments/{${token}}/{assessmentId}`, VALUES)).toThrow(new RegExp(token));
  });
  it("throws on an unknown id placeholder, naming it", () => {
    expect(() => renderAssessmentId("{vendor}-{item}", { prefix: "P", itemId: 1, now: NOW })).toThrow(/vendor/);
  });
  it("throws when a rendered segment is empty, so a path never gains a double slash", () => {
    expect(() => renderWorkspaceTemplate("Assessments/{vendorFolder}/{assessmentId}", { ...VALUES, vendorFolder: "" })).toThrow(/vendorFolder/);
  });
});
