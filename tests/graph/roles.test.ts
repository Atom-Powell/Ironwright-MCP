import { describe, expect, it } from "vitest";
import { appRolesFromAccessToken } from "../../src/graph/roles.js";

function token(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

describe("appRolesFromAccessToken", () => {
  it("reads the roles claim", () => {
    expect(appRolesFromAccessToken(token({ roles: ["Sites.Selected"] }))).toEqual(["Sites.Selected"]);
  });

  it("reports an empty array for a readable token with no roles claim", () => {
    expect(appRolesFromAccessToken(token({ aud: "https://graph.microsoft.com" }))).toEqual([]);
  });

  it("reports undefined for a token it cannot read", () => {
    expect(appRolesFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(appRolesFromAccessToken("header.bm90LWpzb24.signature")).toBeUndefined();
  });
});
