import { describe, expect, it } from "vitest";
import { checkStartupIdentity } from "../../src/server/identity.js";
import { TokenRequestError, UnexpectedTokenRolesError } from "../../src/graph/token.js";

describe("checkStartupIdentity failures", () => {
  it("rethrows a role mismatch so startup fails", async () => {
    const mismatch = new UnexpectedTokenRolesError({ found: ["Files.Read.All"], extra: ["Files.Read.All"], missing: ["Sites.Selected"] });
    const lines: string[] = [];

    await expect(checkStartupIdentity({ getToken: () => Promise.reject(mismatch) }, (line) => lines.push(line))).rejects.toBe(
      mismatch,
    );
    expect(lines).toEqual([]);
  });

  it("warns once and continues when the token endpoint refuses", async () => {
    const lines: string[] = [];
    const failure = new TokenRequestError({ status: 401, body: "{}" });

    await expect(checkStartupIdentity({ getToken: () => Promise.reject(failure) }, (line) => lines.push(line))).resolves.toBe(
      "skipped",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("will run on first use");
  });

  it("warns once and continues when the network fails", async () => {
    const lines: string[] = [];

    await expect(
      checkStartupIdentity({ getToken: () => Promise.reject(new TypeError("fetch failed")) }, (line) => lines.push(line)),
    ).resolves.toBe("skipped");
    expect(lines).toHaveLength(1);
  });
});
