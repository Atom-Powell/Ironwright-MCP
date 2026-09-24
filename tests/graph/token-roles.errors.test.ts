import { describe, expect, it } from "vitest";
import {
  requireExactRoles,
  SERVER_TOKEN_ROLES,
  TokenRequestError,
  UnexpectedTokenRolesError,
  type TokenProvider,
} from "../../src/graph/token.js";

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

const fixed = (token: string): TokenProvider => ({ getToken: async () => token });

describe("requireExactRoles refusals", () => {
  it("refuses an extra role and names it", async () => {
    const guarded = requireExactRoles(fixed(jwt({ roles: ["Sites.Selected", "Files.Read.All"] })), SERVER_TOKEN_ROLES);

    const error = await guarded.getToken().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(UnexpectedTokenRolesError);
    expect((error as UnexpectedTokenRolesError).extra).toEqual(["Files.Read.All"]);
    expect((error as UnexpectedTokenRolesError).missing).toEqual([]);
    expect((error as Error).message).toContain("Files.Read.All");
    expect((error as Error).message).not.toContain("header.");
    // The error has no context: at startup the process then exits, and while
    // running the inner provider keeps the refused token cached until it
    // expires, so no claim about when the fix takes effect is true everywhere.
    expect((error as Error).message).toMatch(/Remove every permission except Sites\.Selected from the server application in Entra\.$/);
    expect((error as Error).message).not.toMatch(/restart/i);
  });

  it("refuses a token missing the expected role", async () => {
    const guarded = requireExactRoles(fixed(jwt({ roles: ["Sites.Read.All"] })), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toMatchObject({
      extra: ["Sites.Read.All"],
      missing: ["Sites.Selected"],
    });
  });

  it("refuses a token with no roles claim and says consent is probably missing", async () => {
    const guarded = requireExactRoles(fixed(jwt({ aud: "https://graph.microsoft.com" })), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toThrow(/admin-consented/);
  });

  it("refuses a token it cannot read rather than trusting it", async () => {
    const guarded = requireExactRoles(fixed("not-a-jwt"), SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toMatchObject({ found: undefined });
  });

  it("passes an inner provider's error through unchanged", async () => {
    const failure = new TokenRequestError({ status: 401, body: '{"error":"invalid_client"}' });
    const guarded = requireExactRoles({ getToken: () => Promise.reject(failure) }, SERVER_TOKEN_ROLES);

    await expect(guarded.getToken()).rejects.toBe(failure);
  });
});
