import { describe, expect, it } from "vitest";
import {
  joinWorkspacePath, renderAssessmentId, renderWorkspaceTemplate, sanitizeFolderName,
  unknownIdPlaceholders, unknownWorkspacePlaceholders,
} from "../../../src/domain/assessment/templates.js";

const NOW = new Date("2026-11-07T20:39:24Z");

describe("renderWorkspaceTemplate", () => {
  it("fills vendor, vendorFolder and assessmentId", () => {
    expect(
      renderWorkspaceTemplate("Assessments/{vendorFolder}/{assessmentId}/{vendor}", {
        vendor: "Acme Corp", vendorFolder: "Acme Corp", assessmentId: "ASM-2026-00002",
      }),
    ).toBe("Assessments/Acme Corp/ASM-2026-00002/Acme Corp");
  });
});

describe("renderAssessmentId", () => {
  it("pads the item id to the requested width", () => {
    expect(renderAssessmentId("{prefix}-{yyyy}-{item:5}", { prefix: "ASM", itemId: 2, now: NOW })).toBe("ASM-2026-00002");
  });
  it("renders the bare item id unpadded", () => {
    expect(renderAssessmentId("{prefix}{item}", { prefix: "V", itemId: 42, now: NOW })).toBe("V42");
  });
  it("does not truncate an id wider than the padding", () => {
    expect(renderAssessmentId("{item:2}", { prefix: "x", itemId: 12345, now: NOW })).toBe("12345");
  });
});

describe("sanitizeFolderName", () => {
  it("removes the characters SharePoint forbids and collapses whitespace", () => {
    expect(sanitizeFolderName('  Acme: "Global" <Ltd>  / Inc  ')).toBe("Acme Global Ltd Inc");
  });
  it("strips trailing dots, which SharePoint refuses on a folder", () => {
    expect(sanitizeFolderName("Acme Inc.")).toBe("Acme Inc");
  });
  it("returns an empty string when nothing survives", () => {
    expect(sanitizeFolderName('"*:<>?/\\|')).toBe("");
  });
});

describe("placeholder validation", () => {
  it("accepts every workspace placeholder and names an unknown one", () => {
    expect(unknownWorkspacePlaceholders("{vendor}/{vendorFolder}/{assessmentId}")).toEqual([]);
    expect(unknownWorkspacePlaceholders("{client}/{assessmentId}")).toEqual(["client"]);
  });
  it("accepts item with and without a width and names anything else", () => {
    expect(unknownIdPlaceholders("{prefix}-{yyyy}{mm}-{item:4}-{item}")).toEqual([]);
    expect(unknownIdPlaceholders("{prefix}-{vendor}-{item:x}")).toEqual(["vendor", "item:x"]);
  });
});

describe("joinWorkspacePath", () => {
  it("joins segments with single slashes and no leading or trailing slash", () => {
    expect(joinWorkspacePath("/Assessments/", "Acme/", "/ASM-1", "Research/dossier.md")).toBe("Assessments/Acme/ASM-1/Research/dossier.md");
  });
});
