import { describe, expect, it } from "vitest";
import { renderPath, renderTemplate } from "../../../src/domain/reconcile/render.js";

const context = { period: { year: 2026, month: 5 }, client: "CLIENTA", deliverable: "MonthlyTraining" };

describe("renderTemplate", () => {
  it("renders every supported placeholder", () => {
    expect(renderTemplate("{year}-{month:02}_{client}_{deliverable}.xlsx", context)).toBe(
      "2026-05_CLIENTA_MonthlyTraining.xlsx",
    );
  });

  it("renders an unpadded month and a month name", () => {
    expect(renderTemplate("{month}-{monthName}", context)).toBe("5-May");
  });

  it("leaves literal text alone", () => {
    expect(renderTemplate("Reports {year} final", context)).toBe("Reports 2026 final");
  });
});

describe("renderPath", () => {
  it("joins rendered segments with forward slashes", () => {
    expect(renderPath(["{year}", "{client}", "{month:02}-{monthName}"], context)).toBe("2026/CLIENTA/05-May");
  });
});
