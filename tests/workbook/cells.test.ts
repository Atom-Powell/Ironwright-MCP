import { describe, expect, it } from "vitest";
import { decodeCell, parseSharedStrings } from "../../src/workbook/cells.js";

const shared = ["Client", "CLIENTA"];

describe("decodeCell", () => {
  it("reads a shared string by index", () => {
    expect(decodeCell('<c r="A1" t="s"><v>1</v></c>', shared)).toBe("CLIENTA");
  });

  it("reads a shared string at index 0, which is falsy but not absent", () => {
    // Number("0") is a falsy number, and the index itself must not be mistaken
    // for a missing one: the lookup is on the array position, not on whether
    // the index happens to be truthy.
    expect(decodeCell('<c r="A1" t="s"><v>0</v></c>', shared)).toBe("Client");
  });

  it("reads an inline string", () => {
    expect(decodeCell('<c r="A1" t="inlineStr"><is><t>CLIENTB</t></is></c>', shared)).toBe("CLIENTB");
  });

  it("reads a boolean", () => {
    expect(decodeCell('<c r="A1" t="b"><v>1</v></c>', shared)).toBe(true);
    expect(decodeCell('<c r="A1" t="b"><v>0</v></c>', shared)).toBe(false);
  });

  it("reads a number, including a date serial, without interpreting it", () => {
    // The reader decides dates by column role, so this layer must not guess.
    expect(decodeCell('<c r="A1"><v>45292</v></c>', shared)).toBe(45292);
  });

  it("trusts a formula that carries a cached value", () => {
    expect(decodeCell('<c r="A1"><f>SUM(B1:B2)</f><v>7</v></c>', shared)).toBe(7);
  });

  it("keeps a cached zero, because zero is falsy but not absent", () => {
    // A naive parse that treats a falsy cached value as "nothing to report"
    // would turn a real zero into null or UNEVALUABLE, which is as wrong as
    // inventing a value: it drops a real reading the workbook wrote.
    expect(decodeCell('<c r="A1"><f>SUM(B1:B2)</f><v>0</v></c>', shared)).toBe(0);
  });

  it("reads an empty cell as null", () => {
    expect(decodeCell('<c r="A1"/>', shared)).toBeNull();
  });

  it("reads an explicit empty string result from a text formula", () => {
    // t="str" with an empty cached value is how Excel writes a text formula
    // that evaluated to "". That empty string is a real, confidently read
    // value, unlike an empty <v> on an untyped or numeric cell.
    expect(decodeCell('<c r="A1" t="str"><f>CONCATENATE(A2,A3)</f><v></v></c>', shared)).toBe("");
  });

  it("reads a str-typed formula result as text", () => {
    expect(decodeCell('<c r="A1" t="str"><f>CONCATENATE(A2,A3)</f><v>Hello</v></c>', shared)).toBe("Hello");
  });
});

describe("parseSharedStrings", () => {
  it("reads each si in order, joining rich text runs", () => {
    const xml = "<sst><si><t>One</t></si><si><r><t>Two</t></r><r><t>Part</t></r></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["One", "TwoPart"]);
  });

  it("unescapes an entity inside a shared string", () => {
    const xml = "<sst><si><t>AT&amp;T</t></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["AT&T"]);
  });
});
