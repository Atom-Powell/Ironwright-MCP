# Ironwright MCP

A path-native Microsoft Graph and SharePoint reconciliation MCP server. It answers what files
should exist in a document library and whether they do, by reading an operational tracking
workbook as the expected state and comparing it against the repository's actual contents.

Built by Ironwright (Adam Powell). Licensed under the Elastic License 2.0; see `LICENSE`.

## Status

Where each phase stands, and what has been verified against a live tenant, is kept in one place:
the "Where the build stands" table at the top of `docs/OPEN-ITEMS.md`. This file does not restate
it, because a second copy is the one that goes stale.

What holds regardless of phase: every write tool is plan-then-execute, a write tool is published
only when `IW_ALLOW_WRITES=true`, and even then a call without `confirm: true` is a dry run that
writes nothing.

## Documentation

- `docs/SETUP.md`: per-tenant Entra and SharePoint setup. The first run against a new tenant
  is `npm run setup -- --tenant=<id> --create-bootstrap`, a one-time step described there in
  full before the normal setup run.
- `docs/superpowers/specs/`: design specifications
- `docs/superpowers/plans/`: implementation plans

## Connecting to it

```bash
npm install
npm run dev        # start with hot reload
```

The server will not start without its configuration. `IW_PROFILE_DIR`, `IW_SITE_URL`,
`IW_TENANT_ID`, `IW_CLIENT_ID` and `IW_CLIENT_SECRET` are all required, and it refuses at startup
naming the one it is missing. `docs/SETUP.md` carries the full deployment configuration contract,
including the optional variables and where the identity values come from.

The server listens on port 3000 unless `PORT` says otherwise. MCP clients connect to `POST /mcp`,
which speaks Streamable HTTP in stateless mode, so there is no session to establish and no SSE
stream to open. `GET /health` is a separate route for container probes and answers
`{"status":"ok"}`. A client running on the same machine connects to `http://localhost:3000/mcp`.

Running from a build takes two commands rather than one, because `npm start` runs the compiled
output and does not compile it. Run `npm run build:prod` first, then `npm start`. Use `build:prod`
rather than `build` for anything you keep or deploy: `npm run build` also emits `dist/setup/`, the
grant-issuing command that acts through a separate application holding `Sites.FullControl.All`,
which has no business in a deployed image. `docs/SETUP.md` explains that boundary.

## Development

```bash
npm test            # full test suite
npm run test:errors # error-path suite, a separate CI gate
npm run lint
npm run typecheck
```

Writes are disabled unless `IW_ALLOW_WRITES=true`. Profiles are deployment configuration and
are not committed; see `examples/profiles/example.json` for the shape.
