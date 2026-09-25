import { describe, expect, it } from "vitest";
import { invalidNameReason } from "../../../src/domain/custom/names.js";

describe("invalidNameReason refusals", () => {
  it.each(['a"b', "a*b", "a:b", "a<b", "a>b", "a?b", "a/b", "a\\b", "a|b"])(
    "refuses a forbidden character in %s",
    (name) => {
      expect(invalidNameReason(name, false)).toMatch(/character/);
    },
  );
  it("refuses a leading or trailing space", () => {
    expect(invalidNameReason(" a.pdf", false)).toMatch(/space/);
    expect(invalidNameReason("a.pdf ", false)).toMatch(/space/);
  });
  it.each(["CON", "con.pdf", "NUL", "COM1", "LPT9.txt", ".lock", "desktop.ini"])(
    "refuses the reserved name %s",
    (name) => {
      expect(invalidNameReason(name, false)).toMatch(/reserved/);
    },
  );
  it("refuses the ~$ prefix and _vti_ anywhere", () => {
    expect(invalidNameReason("~$draft.docx", false)).toMatch(/~\$/);
    expect(invalidNameReason("a_vti_b.pdf", false)).toMatch(/_vti_/);
  });
  it("refuses forms only at the library root", () => {
    expect(invalidNameReason("forms", true)).toMatch(/root/);
    expect(invalidNameReason("forms", false)).toBeUndefined();
  });
  it("refuses an empty name", () => {
    expect(invalidNameReason("", false)).toMatch(/empty/);
  });
});
