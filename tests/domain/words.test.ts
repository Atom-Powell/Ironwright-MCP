// tests/domain/words.test.ts
import { describe, expect, it } from "vitest";
import { inWords } from "../../src/domain/words.js";

describe("a list written as a person would say it", () => {
  it("is empty for nothing and the name itself for one", () => {
    expect(inWords([])).toBe("");
    expect(inWords(["dossier"])).toBe("dossier");
  });

  it("joins two with and", () => {
    expect(inWords(["dossier", "publication"])).toBe("dossier and publication");
  });

  // Three sites joined "A and B and C" is what the server's startup line said before this existed.
  it("joins three or more with commas and one and", () => {
    expect(inWords(["a", "b", "c"])).toBe("a, b and c");
    expect(inWords(["a", "b", "c", "d"])).toBe("a, b, c and d");
  });
});
