import { describe, expect, it } from "vitest";
import { decodeCell, unescapeXmlText, UNEVALUABLE } from "../../src/workbook/cells.js";

describe("cells that cannot be read", () => {
  it("refuses a formula with no cached value", () => {
    // Excel never wrote a result, so there is nothing to read. Returning an
    // empty string here is the silent wrong answer the whole phase exists to
    // prevent.
    expect(decodeCell('<c r="A1"><f>VLOOKUP(A2,Z:Z,1,0)</f></c>', [])).toBe(UNEVALUABLE);
  });

  it("refuses an error cell", () => {
    expect(decodeCell('<c r="A1" t="e"><v>#N/A</v></c>', [])).toBe(UNEVALUABLE);
    expect(decodeCell('<c r="A1" t="e"><v>#REF!</v></c>', [])).toBe(UNEVALUABLE);
  });

  it("refuses a shared string index that names no entry", () => {
    expect(decodeCell('<c r="A1" t="s"><v>9</v></c>', ["only"])).toBe(UNEVALUABLE);
  });

  it("refuses an empty cached value on an untyped cell with no formula", () => {
    // <v></v> is present but carries no digits. Number("") coerces to 0 in
    // JavaScript, so a parser that does not guard this would report a zero
    // nothing in the file actually wrote.
    expect(decodeCell("<c r=\"A1\"><v></v></c>", [])).toBe(UNEVALUABLE);
  });

  it("refuses an empty cached value on a formula, rather than reporting zero", () => {
    // The same coercion is more dangerous here: a formula that recalculated to
    // a blank result must not be read as a compliance-bearing zero.
    expect(decodeCell("<c r=\"A1\"><f>SUM(B1:B2)</f><v></v></c>", [])).toBe(UNEVALUABLE);
  });

  it("refuses an empty cached value on a shared string index", () => {
    // Number("") is 0, and index 0 is a real entry, so an unguarded parse
    // would return sharedStrings[0] for a cell that named no index at all.
    expect(decodeCell("<c r=\"A1\" t=\"s\"><v></v></c>", ["Client", "CLIENTA"])).toBe(UNEVALUABLE);
  });

  it("refuses an unknown entity reference rather than expanding it", () => {
    // Resolving a declared entity is how OOXML parsing becomes an XXE vector.
    // This server holds SharePoint credentials, so an entity outside the five
    // XML predefines is refused, not resolved.
    expect(() => unescapeXmlText("&notareal;")).toThrow(/not one of the five XML predefines/);
  });
});
