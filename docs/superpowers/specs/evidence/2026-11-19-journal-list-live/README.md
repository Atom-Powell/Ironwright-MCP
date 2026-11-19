# The journal in a SharePoint list, run live on 2026-11-19

The first run of the journal list as a feature, on the Service Desk site of the developer tenant,
through Copilot Studio over the Cloudflare Tunnel.

## Setup

`write-session.ps1` against `profiles/dept-service-desk.json`, whose `lists.journal` names
"Incident Journal". `department:setup` found the list already present with every mapped column
("Lists created: none. Already there: Clients, Incidents, Incident Findings, Incident Journal").
The server started with writes enabled and the in-memory store.

The list was then set read only for members, as ruled on 2026-11-18: inheritance broken (by the
operator, since the confirmation is a browser dialog), then Service Desk Members changed from Edit
to Read. The list's permissions page afterward read: unique permissions; Members Read, Owners Full
Control, Visitors Read.

## The run

The agent opened INC-2026-00003 for Contoso Dental, scope "Printer outage at front desk", at
17:41 UTC under correlation id `203f9ac0-68fb-4fc1-b72e-e53d2648f402`. The list held eight items
for that call:

| AssessmentId | Operation | Target |
|---|---|---|
| (vendor) | list_item_created | Clients/3 |
| (unassigned) | list_item_created | Incidents/3 |
| INC-2026-00003 | list_item_updated | Incidents/3 |
| INC-2026-00003 | folder_created | Incidents/Contoso Dental |
| INC-2026-00003 | folder_created | Incidents/Contoso Dental/INC-2026-00003 |
| INC-2026-00003 | folder_created | .../INC-2026-00003/Record |
| INC-2026-00003 | folder_created | .../INC-2026-00003/Evidence |
| INC-2026-00003 | folder_created | .../INC-2026-00003/Review |

Asked for the incident's journal, the agent returned six entries: the update and the five
folders, from 17:41:21.879 to 17:41:24.961.

The server was stopped (the site grant went back to read) and started again read only with
`start-real-server.ps1`, so with an empty in-memory store. In a new test session the agent
returned the same six entries with the same times to the millisecond and the same correlation id.

## What it shows

The journal survives a restart: the entries came from the list, since the restarted store held
nothing. The read only ruling did not affect the server, whose writes come from its own site grant.

Found: the two creates `open_assessment` makes before the id exists are journaled under the
placeholders "(vendor)" and "(unassigned)", so a read by id never returns them. That predates the
list; the store keyed them the same way. It is an open item in `docs/OPEN-ITEMS.md`.
