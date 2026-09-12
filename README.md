# Ironwright MCP

A path-native Microsoft Graph and SharePoint reconciliation MCP server. It answers what files
should exist in a document library and whether they do, by reading an operational tracking
workbook as the expected state and comparing it against the repository's actual contents.

Built by Ironwright (Adam Powell). Licensed under the Elastic License 2.0; see `LICENSE`.

## Status

Phase 1. The server is connectable and every tool is registered with its real schema and
annotations, returning a placeholder response until the Graph layer lands.

## Documentation

- `docs/SETUP.md`: per-tenant Entra and SharePoint setup
- `docs/superpowers/specs/`: design specifications
- `docs/superpowers/plans/`: implementation plans

## Development

```bash
npm install
npm run dev        # start with hot reload
npm test           # full test suite
npm run test:errors # error-path suite, a separate CI gate
npm run lint
npm run typecheck
```

Writes are disabled unless `IW_ALLOW_WRITES=true`. Profiles are deployment configuration and
are not committed; see `examples/profiles/example.json` for the shape.
