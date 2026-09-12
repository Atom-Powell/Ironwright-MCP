# Ironwright MCP

A path-native Microsoft Graph and SharePoint reconciliation MCP server. It answers what files
should exist in a document library and whether they do, by reading an operational tracking
workbook as the expected state and comparing it against the repository's actual contents.

Built by Ironwright (Adam Powell). Licensed under the Elastic License 2.0; see `LICENSE`.

## Status

Phase 1. The server is connectable and every tool is registered with its real schema and
annotations, returning a placeholder response until the Graph layer lands.

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

The server listens on port 3000 unless `PORT` says otherwise. MCP clients connect to `POST /mcp`,
which speaks Streamable HTTP in stateless mode, so there is no session to establish and no SSE
stream to open. `GET /health` is a separate route for container probes and answers
`{"status":"ok"}`. A client running on the same machine connects to `http://localhost:3000/mcp`.

Running from a build takes two commands rather than one, because `npm start` runs the compiled
output and does not compile it. Run `npm run build` first, then `npm start`.

## Development

```bash
npm test            # full test suite
npm run test:errors # error-path suite, a separate CI gate
npm run lint
npm run typecheck
```

Writes are disabled unless `IW_ALLOW_WRITES=true`. Profiles are deployment configuration and
are not committed; see `examples/profiles/example.json` for the shape.
