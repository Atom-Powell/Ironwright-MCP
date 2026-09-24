# The token role guard

Design spec. Written 2026-09-24, from a finding of the competitive refresh
(`competitive-landscape-refresh-2026-09-24.md`) and a design dialogue with the operator the same
day. A small slice, ahead of phase 6d, needing no Azure resources.

## Why

The Decision Record's Identity entry says the server's application holds `Sites.Selected` and
nothing broader, and that this is the least-privilege boundary the whole project rests on. Today
that is a fact about setup, not a property of the running server. A Microsoft Q&A moderator
answered, as by design, that an application holding `Sites.Selected` alongside `Files.Read.All` or
`User.Read.All` could read sites it was never granted
([thread](https://learn.microsoft.com/en-us/answers/questions/5621045/sites-selected-not-working-as-expected-with-files)).
So anyone who adds a permission to the server application in Entra, with admin consent, silently
widens it to the whole tenant, and nothing in the server would say so.

Setup already reads a token's roles claim to check the grant issuer. The running server never
reads its own. The live token was checked on 2026-09-24 and carried `["Sites.Selected"]` only;
this slice is about the day it does not.

## What it does

The server never uses a Graph token whose roles claim is anything other than exactly
`["Sites.Selected"]`, and a deployment misconfigured that way fails loudly at startup when it can
tell.

### The shared roles reader

`appRolesFromAccessToken` moves from `src/setup/steps.ts` to a new `src/graph/roles.ts`, unchanged,
with its doc comment. `src/setup/steps.ts` re-exports it, so setup code and setup tests keep their
imports. It moves because `tsconfig.build.json` excludes `src/setup` from the production compile,
so the server cannot import from there.

### The per-token guard

`requireExactRoles(provider: TokenProvider, expected: readonly string[]): TokenProvider` in
`src/graph/token.ts` wraps a provider. Its `getToken` obtains a token from the inner provider and
checks the roles claim before returning it:

- The same token string is checked once and remembered, so a cached token costs nothing on reuse.
  A new token, which the inner provider mints roughly hourly, is checked again, so a permission
  added while the server runs is caught within one token lifetime.
- The token is refused, by throwing `UnexpectedTokenRolesError`, when the roles claim:
  - differs from `expected` as a set: the error names the roles that are extra and those missing;
  - is empty: the error says the application's `Sites.Selected` permission is probably not
    admin-consented;
  - cannot be read at all: the error says the token could not be read, so its permissions could
    not be checked. Unreadable fails closed, never open.
- Errors from the inner provider, such as `TokenRequestError`, pass through unchanged.

The error message states only what was observed in the token and what the server did about it:
it refused to use the token, and no Graph request was made with it. It carries no token and no
secret.

`src/server/main.ts` wraps its `clientCredentialsTokenProvider` with
`requireExactRoles(..., ["Sites.Selected"])` before building the Graph client, so every Graph
request, whether from a tool, a scan or the startup check, passes through the guard.

### The startup check

`checkStartupIdentity(provider: TokenProvider, log: (line: string) => void): Promise<"verified" | "skipped">`
in a new `src/server/identity.ts`, so it can be tested; `main.ts` runs on import and is not.

- It calls `provider.getToken()` once through the guard.
- On success it returns `"verified"` and logs nothing extra; the existing listening line is
  enough.
- On `UnexpectedTokenRolesError` it rethrows. `main.ts` calls it before binding the port, so the
  existing top-level handler prints the message and sets exit code 1, the same path every other
  startup configuration failure takes.
- On any other failure to obtain a token (sign-in service unreachable, network error, rejected
  secret) it logs one warning line saying the token could not be obtained, so the role check was
  skipped at startup and will run on first use, and returns `"skipped"`. Startup behavior in that
  case is exactly today's. This keeps the principle behind `GET /health`: an outage of a third
  party must not become a restart loop.

### The tool-level message

`describeToolFailure` in `src/tools/errors.ts` gains a case for `UnexpectedTokenRolesError`. The
message says the server refused to call Microsoft Graph because its own token carries permissions
other than `Sites.Selected` and names them. It does not fall through to the generic Graph-failure
text, which would send the operator to the server log for a problem already fully described.

Amended 2026-09-24, whole-branch review. This section first said the message "says nothing was
read or changed" and that the server recovers on its next token without a restart. Both were
wrong. A token can rotate mid-call, after a scan has read delta pages or a plan tool has fetched
ETags with the token before it, so `describeToolFailure` cannot observe that nothing was read, and
a message may not assert what its function cannot observe. And the inner provider keeps the
refused token cached until it expires, so removing the permission does not take effect on the next
call. The message now says `<tool> stopped when its Graph token was refused`, followed by the
error's own text, and then that the change takes effect when the server's current token expires,
up to about an hour, or immediately if the server is restarted. The error's own message no longer
carries any sentence about recovery, because it has no context: at startup the process exits on it.

## Testing

- `tests/graph/roles.test.ts` and `roles.errors.test.ts`: the reader's existing cases, moved with
  it. The setup tests that import it through `src/setup/steps.ts` keep passing unedited.
- `tests/graph/token.test.ts` and `token.errors.test.ts`: the guard passes an exact match; refuses
  an extra role, a missing role, an empty claim and an unreadable token, each with the message
  naming what it found; checks a given token once; checks a new token again; passes inner-provider
  errors through unchanged. Tokens are built as unsigned JWTs carrying a chosen `roles` claim.
- `tests/server/identity.test.ts` and `identity.errors.test.ts`: `"verified"` on a good token;
  rethrow on a role mismatch; warn once and `"skipped"` on a `TokenRequestError` and on a network
  rejection.
- `tests/tools/errors.test.ts`: the new message for `UnexpectedTokenRolesError`, including that it
  names the extra roles.
- The existing server, transport and tool suites keep passing. Fakes that build a Graph client
  from a fake token provider are unaffected, since they do not pass through `main.ts`.

## Verification before merge

Start the server from source against the sandbox tenant, whose server token carries only
`Sites.Selected`: it starts, logs no warning, and a read tool answers.

The refusal path is not exercised live. Doing so would mean granting the server application a
broad permission with admin consent in the tenant, which is the exact state this slice exists to
prevent. It is covered by tests and recorded in `docs/OPEN-ITEMS.md` as not established live.

## Documents this branch updates

- `CLAUDE.md`: the Decision Record's Identity entry records that `Sites.Selected` is now enforced
  at runtime, on every token and at startup.
- `docs/SETUP.md`: one paragraph on the startup refusal, what it means, and how to recover.
- `docs/OPEN-ITEMS.md`: closes the item "The server should refuse to start if its own token
  carries any role other than `Sites.Selected`", recording what was and was not verified live.

## Out of scope

- Checking the grant level (read or write) on the site. That lives on the site's permission
  entry, not in the token. Whether the server's own `Sites.Selected` grant can read that entry has
  not been probed, and the write gate (`IW_ALLOW_WRITES`) already governs whether write tools are
  offered at all.
- Checking the grant issuer's token from the server. The server never holds it.
