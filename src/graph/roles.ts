/**
 * Reads the roles claim out of an application access token. The signature is
 * deliberately not validated: this token was just minted for this command by
 * Entra, and the claim is used only to tell two failure causes apart, never to
 * make an access decision.
 *
 * An empty array and `undefined` mean different things. An empty array is a
 * readable token that carries no roles, which is direct evidence that admin
 * consent is missing. `undefined` means the token could not be read at all, so
 * nothing can be concluded from it.
 *
 * It lives under src/graph rather than src/setup because the running server
 * now reads its own token's roles too, and the production compile excludes
 * src/setup. The claim is still never an access decision on its own: the
 * server uses it only to refuse a token, never to grant anything.
 */
export function appRolesFromAccessToken(token: string): string[] | undefined {
  const segments = token.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined || payload === "") return undefined;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const roles = (decoded as { roles?: unknown }).roles;
    if (roles === undefined) return [];
    if (!Array.isArray(roles)) return undefined;
    return roles.filter((role): role is string => typeof role === "string");
  } catch {
    return undefined;
  }
}
