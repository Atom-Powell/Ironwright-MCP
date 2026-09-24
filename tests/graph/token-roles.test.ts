import { describe, expect, it } from "vitest";
import { requireExactRoles, SERVER_TOKEN_ROLES, type TokenProvider } from "../../src/graph/token.js";

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

/** Hands out the given tokens in order, repeating the last, and counts calls. */
function sequence(tokens: string[]): TokenProvider & { calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    getToken: async () => tokens[Math.min(index++, tokens.length - 1)] ?? "",
  };
}

describe("requireExactRoles", () => {
  it("returns a token whose roles are exactly the expected set", async () => {
    const good = jwt({ roles: ["Sites.Selected"] });
    const guarded = requireExactRoles(sequence([good]), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).resolves.toBe(good);
  });

  it("checks a newly minted token again rather than trusting the first", async () => {
    const first = jwt({ roles: ["Sites.Selected"], n: 1 });
    const second = jwt({ roles: ["Sites.Selected", "Files.Read.All"], n: 2 });
    const guarded = requireExactRoles(sequence([first, second]), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).resolves.toBe(first);
    await expect(guarded.getToken()).rejects.toThrow(/Files\.Read\.All/);
  });
});
