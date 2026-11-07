import { describe, expect, it } from "vitest";
import { renderAssessmentId, renderWorkspaceTemplate } from "../../../src/domain/assessment/templates.js";

const NOW = new Date("2026-11-07T20:39:24Z");
const VALUES = { vendor: "A", vendorFolder: "A", assessmentId: "X", now: NOW };

describe("rendering refuses what validation would have refused", () => {
  it("throws on an unknown workspace placeholder, naming it", () => {
    expect(() => renderWorkspaceTemplate("{client}/x", VALUES)).toThrow(/client/);
  });
  it("throws on an unknown id placeholder, naming it", () => {
    expect(() => renderAssessmentId("{vendor}-{item}", { prefix: "P", itemId: 1, now: NOW })).toThrow(/vendor/);
  });
  it("throws when a rendered segment is empty, so a path never gains a double slash", () => {
    expect(() => renderWorkspaceTemplate("Assessments/{vendorFolder}/{assessmentId}", { ...VALUES, vendorFolder: "" })).toThrow(/vendorFolder/);
  });
});
