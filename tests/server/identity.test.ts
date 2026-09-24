import { describe, expect, it } from "vitest";
import { checkStartupIdentity } from "../../src/server/identity.js";

describe("checkStartupIdentity", () => {
  it("reports verified and logs nothing when the token passes", async () => {
    const lines: string[] = [];
    await expect(checkStartupIdentity({ getToken: async () => "ok" }, (line) => lines.push(line))).resolves.toBe(
      "verified",
    );
    expect(lines).toEqual([]);
  });
});
