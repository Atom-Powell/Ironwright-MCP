import { describe, expect, it } from "vitest";
import { renderPath, renderTemplate } from "../../../src/domain/reconcile/render.js";

const context = { period: { year: 2026, month: 5 }, client: "CLIENTA", deliverable: "MonthlyTraining" };

// The profile validator already rejects a template with an unknown placeholder
// against this same token set, so a renderer that reached one anyway means a
// bug upstream, not a bad profile. It must throw and name the token, rather
// than rendering the brace literally: a silently-produced path like
// "2026-{quarter}-CLIENTA.xlsx" can never match a real file, and a report
// built on it would present every artifact using that template as missing.
describe("renderTemplate rejections", () => {
  it("throws naming an unknown placeholder instead of rendering it literally", () => {
    expect(() => renderTemplate("{year}_{quarter}.xlsx", context)).toThrow("unknown placeholder {quarter}");
  });

  it("rejects an unknown placeholder inside a path segment", () => {
    expect(() => renderPath(["{year}", "{quarter}"], context)).toThrow("unknown placeholder {quarter}");
  });
});

// An out-of-range month must fail the same way regardless of which of the
// three month-reading tokens a template uses. Before this test, "month" and
// "month:02" silently rendered "13" while "monthName" alone threw: the same
// bad period would read as a clear bug from one token and a confidently
// wrong filename from the other two.
describe("renderTemplate rejections for an out-of-range month", () => {
  const invalidMonth = { period: { year: 2026, month: 13 }, client: "CLIENTA", deliverable: "MonthlyTraining" };

  it("rejects an out-of-range month through the month token", () => {
    expect(() => renderTemplate("{month}", invalidMonth)).toThrow("month must be between 1 and 12, got 13");
  });

  it("rejects an out-of-range month through the zero-padded month token", () => {
    expect(() => renderTemplate("{month:02}", invalidMonth)).toThrow("month must be between 1 and 12, got 13");
  });

  it("rejects an out-of-range month through the month name token", () => {
    expect(() => renderTemplate("{monthName}", invalidMonth)).toThrow("month must be between 1 and 12, got 13");
  });
});
