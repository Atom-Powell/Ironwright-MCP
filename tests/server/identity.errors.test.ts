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

  it("warns and continues when the token endpoint never answers, rather than holding startup open", async () => {
    const lines: string[] = [];
    const never = new Promise<string>(() => undefined);

    await expect(checkStartupIdentity({ getToken: () => never }, (line) => lines.push(line), 20)).resolves.toBe("skipped");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("did not answer within 20 ms");
    expect(lines[0]).toContain("will run on first use");
  });

  it("does not let a token request that fails after the deadline surface as an unhandled rejection", async () => {
    const lines: string[] = [];
    let fail: (error: Error) => void = () => undefined;
    const late = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });

    await expect(checkStartupIdentity({ getToken: () => late }, (line) => lines.push(line), 20)).resolves.toBe("skipped");
    fail(new TypeError("fetch failed"));
    // A turn of the event loop, in which an unhandled rejection would be raised and fail this test file.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lines).toHaveLength(1);
  });

  it("warns once and continues when the network fails", async () => {
    const lines: string[] = [];

    await expect(
      checkStartupIdentity({ getToken: () => Promise.reject(new TypeError("fetch failed")) }, (line) => lines.push(line)),
    ).resolves.toBe("skipped");
    expect(lines).toHaveLength(1);
  });
});
