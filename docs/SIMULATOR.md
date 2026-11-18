# The simulated tenant

A way to run the assessment tools end to end with no tenant, no grant and no secret. The real
server application, the real registry and the seven real assessment tools run as they do in a
deployment. One thing is substituted: the Graph client is `scripts/sim/tenant.ts`, an in-memory
site with one document library and the profile's three lists.

## What it proves and what it does not

It holds state between requests, so it shows whether the server's own steps compose: that a save
finds what an open created, that a retry writes nothing, that two calls arriving together are
ordered. With the open lock removed, four simultaneous opens against it create four assessments,
which is what the 2026-11-09 campaign measured on the developer tenant.

It proves nothing about Microsoft Graph. A fake answers the way its author believes the API
answers, and this project has paid for that mistake twice. Each behavior in the simulated tenant
is either copied from a dated measurement or marked as modeled in the source, and the table at the
end of this page lists which is which. A change that passes here is ready for a live sitting. It
has not had one.

## Running it

```
npm run sim:walkthrough
```

Takes one assessment from open to completed over MCP and prints what each tool answered,
including a transition that is refused because the publication does not exist yet. It exits
non-zero if any step answers other than expected.

```
npm run sim
```

Starts the server on `http://127.0.0.1:3939` and leaves it running. `SIM_PORT` changes the port and
`SIM_PROFILE` names another assessment profile file; the default is
`examples/profiles/assessment-example.json`, whose profile id is `vendor-assessments`. It binds to
loopback only and asks for no key. Everything is in memory and is gone when the process stops.

Point any MCP client at `http://127.0.0.1:3939/mcp` over Streamable HTTP. Two that need no setup:

```
npx @modelcontextprotocol/inspector
claude mcp add --transport http ironwright-sim http://127.0.0.1:3939/mcp
```

## Standing in for what happens outside the server

The publisher that writes the publication, an operator who edits a list item, and a person who
looks at the site are not this server. Routes under `/sim` stand in for them. They are not part of
the product.

| Request | What it stands for |
|---|---|
| `GET /sim/state` | Looking at the site: every list item, every file and folder, and the journal |
| `PUT /sim/files/<library path>` with a body | The publisher, or a person, uploading a file; missing parent folders are created |
| `DELETE /sim/files/<library path>` | Someone deleting a file, or a folder and everything in it |
| `PATCH /sim/lists/<list>/<item id>` with a JSON object of fields | An operator editing a list item in the browser |

To complete an assessment, ask `verify_publication` for the path, put a file there, and call
`transition_assessment`:

```
curl -X PUT --data-binary @report.docx "http://127.0.0.1:3939/sim/files/Assessments/Acme%20Corp/ASM-2026-00001/Published/Acme%20Corp_ASM-2026-00001_Risk_Assessment.docx"
```

## In tests

`createSimDeployment()` in `scripts/sim/deployment.ts` returns the simulated tenant and the tool
context built over it. `tests/scripts/sim/lifecycle.test.ts` runs the tool handlers against it, and
`tests/tools/assessment/refusal-wire.errors.test.ts` runs them through a real MCP client. The
tenant also records every request it received, fails the next matching request on demand, and can
add latency to each request.

The scripted fake in `tests/tools/assessment/fake-graph.ts` stays the tool for pinning the exact
requests a handler sends, in order. The simulated tenant is for what the scripted fake cannot
show: two calls overlapping, or a later call depending on what an earlier one left behind.

## Measured and modeled

| Behavior | Source |
|---|---|
| A list item id is an integer rendered as a string, counted up and never reused | Probe L2a, 2026-11-07 |
| A fields update answers the whole fields object | Probe L2b, 2026-11-07 |
| A filtered query without the non-indexed header answers 400 `invalidRequest` | Probes L3a and L3b, 2026-11-07 |
| A multi-line column value is kept exactly | The 9c sitting, 2026-11-08 |
| A folder create over a present name answers 409 `nameAlreadyExists` | Probes F0 and F1b, 2026-11-07 |
| A file create under `conflictBehavior=fail` over a present name answers 409 | Probes F2a and F2b, 2026-11-07 |
| A content PUT under a stale `If-Match` answers 412 `notAllowed` | Probes F3a and F3b, 2026-11-07 |
| A content PUT under `If-Match` to a path holding nothing creates the file | Probe F3c, 2026-11-07 |
| A path is looked up without regard to case and answers the stored name | The campaign, 2026-11-09 |
| A content PUT creates a missing parent folder | The campaign, 2026-11-09, one level; deeper levels modeled |
| A list filter matches text without regard to case | Not measured. Switchable with `listFilterIgnoresCase`; the default is true |
| A name with a character SharePoint refuses answers 400 | Modeled on the published name rules; the status and code were not measured |
| A column the list does not have answers 400, on a write and in a filter | Modeled |
| Every simulated column is treated as not indexed | Modeled; the header is required on every filtered query |
| A fields update under a stale `If-Match` answers 412 `resourceModified` and writes nothing; one under the current eTag answers with the new eTag | Probes L4a, L4b and L4c, 2026-11-17 |
