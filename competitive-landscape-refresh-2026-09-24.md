# Competitive Landscape Refresh, 2026-09-24

Nobody else reconciles an expected-deliverables tracker against an existing document library
the tool does not own, in an MCP marketplace, an adjacent product category, or a user discussion
found in this pass. The nearest newcomer, AuditDashboard's MCP connector, chases missing documents
only inside its own portal. The field
moved in two other directions instead: MCP servers got bigger while staying thin (one tool per
Graph call, now at 300 tools), and governance vendors moved up to governing agents and sites,
not the files inside them.

This refreshes `competitive-landscape.md` (2026-09-11) and adds two things it covered only in
passing: products that solve the same problem without being MCP servers, and what users actually
say. It keeps the earlier document's three evidence tiers and adds a fourth, Third-party, plus a
vendor-claim label: **Verified** (the project's or vendor's own docs, or
an official Microsoft page, opened directly), **Directory signal** (a directory's own estimate),
**Third-party** (an independent write-up), **Single source** (one uncorroborated page). A vendor's
description of its own product is labeled a **vendor claim**.

## What changed since 2026-09-11

- **Work IQ's SharePoint server has 35 per-operation tools, not "about 10 generic verbs."** The
  earlier census took the 10-verb figure from Microsoft's launch blog, which describes the
  cross-domain Work IQ API layer. The SharePoint server Copilot Studio actually connects to
  documents 35 named tools, from `findSite` to `deleteColumn`. Its folder listing returns at most
  20 items and takes no paging parameter, so a folder holding more than 20 items cannot be listed
  in full, and it has no delta query. Even where every folder is small, a full-tree read of a
  library like the sandbox (144 files, 122 folders) costs at least one call per folder. It is still marked preview (page
  updated 2026-08-04). **Verified**
  ([Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-sharepoint-tools)),
  corroborated by [PuntoBello](https://www.puntobello.ch/en/nello/mcp365_explorer_sharepoint_lists/).
- **Work IQ's SharePoint writes are more careful than the earlier census recorded.** ETag
  concurrency on rename, delete and list-item writes; asynchronous move and copy polled through
  `checkOperationStatus`; a required justification when a sensitivity label is lowered. There is
  still no plan a person reviews before the write and no reversal log. **Verified** (same page).
- **XMV Solutions' `sharepoint-mcp` shipped v0.2 and v0.3 on 2026-05-07**, adding bulk checkout
  and checkin and service-principal auth (v0.2) and Graph delta query (v0.3); its latest release
  is v0.7.0, from 2026-05-20. It is the first community server seen using delta to avoid
  re-walking a library. It still has no expected-versus-actual comparison.
  **Verified** ([README](https://github.com/XMV-Solutions-GmbH/sharepoint-mcp)). Glama now grades
  its maintenance A, up from C (**Directory signal**,
  [Glama](https://glama.ai/mcp/servers/XMV-Solutions-GmbH/sharepoint-mcp)); its GitHub page showed
  zero stars when read, which does not square with that grade and was not resolved.
- **Softeria's `ms-365-mcp-server` is the largest thin wrapper found:** 994 stars and 300+ tools,
  each mapped one to one onto a Graph endpoint. It supports `Sites.Selected`, delta paging and a
  `graph-batch` tool, and has a read-only mode, but no plan step and no reconciliation.
  **Verified** ([GitHub](https://github.com/softeria/ms-365-mcp-server)).
- **Lokka grew** from 262 to 301 stars and 69 to 80 forks. **Verified**
  ([GitHub](https://github.com/merill/lokka)).
- **New registry and directory entries,** none checked against their own code in this pass:
  `mindstone/mcp-server-microsoft-sharepoint` and `0xka13b/ms-sharepoint-mcp` (from the
  `microsoft-mcps` repository) in the
  [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=sharepoint),
  and seven new SharePoint servers on [Glama](https://glama.ai/mcp/servers?query=sharepoint),
  including one aimed at Excel files in SharePoint (`dhanushkacc/sharepoint-excel-mcp`).
  **Directory signal / Single source.**

## Who else is in the space

| Product | Kind | Best at | Worst at, or missing |
|---|---|---|---|
| Work IQ SharePoint (Microsoft) | First-party MCP, preview | ETag-guarded writes and async moves on the platform default | 35 thin tools; 20-item folder pages, no delta; no plan review, no rollback |
| Softeria `ms-365-mcp-server` | Community MCP | Breadth and adoption: 300+ tools, 994 stars | Pure one-tool-per-endpoint shape; no plan step, no reconciliation |
| XMV `sharepoint-mcp` | Community MCP | Delta change tracking; checkout/checkin that refuses to clobber | Solves safe editing, not gap analysis |
| Markifact | Hosted commercial MCP | A confirmation gate that shows each write and waits for approval (**vendor claim**) | No dry run, no preconditions, no rollback beyond the recycle bin |
| ShareGate | Migration and governance | Faithful bulk copy and reorganization for one-off migrations | "You can only rename your files when copying them" ([docs](https://help.sharegate.com/en/articles/10236143-export-metadata-and-import-and-copy-with-excel-or-csv)); no dry run or reversal found in its docs; not built for recurring checks |
| AvePoint, Syskit Point, Rencore, Orchestry | Governance suites | Inventory and policy at the site, permission and agent level | Nothing at the level of an expected file in an expected folder under an expected name |
| SharePoint Advanced Management | Microsoft governance | Oversharing, lifecycle and permission reports; the SharePoint Admin Agent for chat-driven administration | Works on sites and permissions, never on whether a required file exists ([Learn](https://learn.microsoft.com/en-us/sharepoint/advanced-management)) |
| Agents in SharePoint, Copilot | Microsoft Q&A over content | Answering questions about what is already findable | Cannot see what is missing; no inventory, no remediation ([Support](https://support.microsoft.com/en-us/sharepoint/copilot-in-sharepoint/get-started-with-agents-in-sharepoint)) |
| Purview file plan | Microsoft records management | Retention and disposition of files already filed correctly | No concept of a document that should exist but does not ([Learn](https://learn.microsoft.com/en-us/purview/file-plan-manager)) |
| Power Automate, PnP PowerShell | DIY | Flexible; `Move-PnPFile` refuses to overwrite without `-Overwrite` ([docs](https://pnp.github.io/powershell/cmdlets/Move-PnPFile.html)) | No persisted plan, so a script that dies halfway leaves no record of what changed; Power Automate's SharePoint connector allows 600 calls per connection per 60 seconds (**Third-party**, [blog](https://manueltgomes.com/microsoft/power-platform/powerautomate/batch-operations-and-throttling-mitigation-in-power-automate/)) |
| Audit, accounting, construction and MSP compliance tools | Document-completeness | Tracking what is outstanding and chasing it | Only check documents uploaded into their own portal, never an existing library against an existing tracker |

The closest analogs are outside SharePoint document libraries. Audit request-list tools
(for example [AuditDashboard](https://www.auditdashboard.com/)) track exactly the question
Ironwright answers, but inverted: they collect documents into their own portal and check that.
AuditDashboard now ships an MCP connector that lets an agent "chase what's missing" and review
what came back across its engagements, and it "tells you what it's about to do and waits for you
to confirm" (**vendor claim**, [connector page](https://www.auditdashboard.com/mcp-ai-connector)).
Its homepage lists Microsoft 365 and SharePoint among its integrations, but neither page says the
connector checks documents stored in SharePoint against a request list.
A search result described a Google Drive MCP server with a `dry_run` parameter and a restore
token, which would be the nearest thing to a reversal log outside this project; the pass did not
record its name or open its repository, so it is unverified and worth finding again. `mcp-reconcile`
arrived at the same dry-run-then-confirm shape for MCP client configuration, a different
domain.

## What users say

Real feedback came almost entirely from GitHub issues and Microsoft Q&A. Searches of Reddit and
Hacker News did not surface on-topic threads, which is a limit of this pass, not proof none exist.

| Theme | Sources | What it says about Ironwright |
|---|---|---|
| Graph IDs and endpoints break in practice | 3 ([Lokka #42](https://github.com/merill/lokka/issues/42), [DEmodoriGatsuO #18](https://github.com/DEmodoriGatsuO/sharepoint-mcp/issues/18) and [#19](https://github.com/DEmodoriGatsuO/sharepoint-mcp/issues/19)) | Supports probing each Graph surface live before building on it, and keeping opaque IDs out of URLs. DEmodoriGatsuO #19 hit the same "Region is required" error this project probed before building phase 2c |
| Interactive sign-in is a fragile part of peer servers | 1 repo, two issues ([Lokka #44](https://github.com/merill/lokka/issues/44), [#54](https://github.com/merill/lokka/issues/54)) | Avoided by design: the server runs on an app-only token |
| `Sites.Selected` stops restricting once a broader permission shares the token | 1, answered as by design by a Microsoft Q&A moderator ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5621045/sites-selected-not-working-as-expected-with-files)) | A real gap, below |
| Delta tokens expire with no published limit, and some permission changes surface only as the drive root | 2 ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5856205/microsoft-graph-delta-api-clarification-on-delta-t), [Q&A](https://learn.microsoft.com/en-us/answers/questions/5937149/how-to-identify-sharepoint-permission-changes-usin)) | Supports the resync-on-410 handling: the answer recommends discarding the delta link and running a full sync |
| A server rewrote spaces to underscores and silently created a parallel folder | 1 ([ftaricano #12](https://github.com/ftaricano/mcp-onedrive-sharepoint/issues/12)) | The exact failure plan-then-execute prevents, and a cousin of this project's own raw-path probe finding |
| Copilot Studio's SharePoint connector has no dedicated rename action; the accepted answer is a raw REST call through "Send an HTTP request to SharePoint" in a flow | 1 ([Power Platform community](https://community.powerplatform.com/forums/thread/details/?threadid=282e315e-36f2-f011-8407-7c1e5268c02a)) | Direct value for the first consumer: renaming takes a hand-built REST call today |
| Work IQ's servers need less hand-holding than earlier MCP servers | 1 forum reply ([Power Platform community](https://community.powerplatform.com/forums/thread/details/?threadid=9a8cd483-3b22-f111-8341-0022482aa60e)) | Tool design visibly affects how well an agent acts; the reply does not say what about the design helped |
| A published package's license and repository metadata contradicted each other | 1 ([Lokka #55](https://github.com/merill/lokka/issues/55)) | Enterprise buyers check provenance; keep license metadata exact |

**Nobody asked for reconciliation, and nobody complained about its absence.** That is consistent
with no one offering it, but it is not demand evidence either. This project has no user feedback
on its own architecture; every confirming signal above is by analogy from other servers'
failures. The first real signal will come from a pilot.

## Head to head: Softeria's `ms-365-mcp-server`

Softeria is the most adopted Microsoft 365 MCP server found, so it is the one an operator is most
likely to try first. The two share a stack and little else: Softeria is a broad toolbox acting
as a signed-in user, and Ironwright MCP is a narrow, unattended compliance engine for one library.
Facts about Softeria are from its [README](https://github.com/softeria/ms-365-mcp-server),
repository metadata and [`endpoints.json`](https://github.com/softeria/ms-365-mcp-server/blob/main/src/endpoints.json),
read 2026-09-24. **Verified.**

| | Softeria `ms-365-mcp-server` | Ironwright MCP |
|---|---|---|
| Scope | Most of Microsoft 365: mail, calendar, OneDrive, Excel, Teams, SharePoint, Planner, users | One SharePoint library against one tracking workbook |
| Tools | 334, each one Graph endpoint: 156 GET, 109 POST, 36 PATCH, 31 DELETE, 2 PUT | 7 live, 10 planned, each a server-side job |
| Identity | The signed-in user: device code, OAuth authorization code, on-behalf-of, or a supplied token; application permissions are left to a separate companion server | Its own application, app-only, never a user |
| Least privilege | `Sites.Selected` available through an allowlist; default org mode requests broad SharePoint scopes, and tenant-wide search needs them | `Sites.Selected` on one granted site is the only mode |
| Writes | Immediate per call; safety is a read-only flag and tool allowlists; no dry run, plan or rollback documented | Reviewable stored plan, dry run by default, ETag precondition per file, reversal log |
| Inventory | Exposes the raw delta endpoint; the agent pages and assembles | Delta run on the server with the link persisted; questions served from a stored index |
| Workbook | Excel API tools work, since a user token can reach them | Downloads the `.xlsx` and parses it, since the Excel API refuses app-only tokens |
| Context economy | Tool presets, dynamic tool discovery, compact TOON output | Few tools and typed outputs with exact counts |
| Maturity | 994 stars, 375 forks, MIT, v0.155.0 released 2026-09-22 | Pre-release, one sandbox tenant, Elastic License 2.0 |

**Softeria is stronger at** breadth, adoption, release pace, setup (one `npx` command, multiple
accounts, sovereign clouds), and keeping an agent's context small. Its user-delegated model also
reaches the Excel API that app-only access cannot.

**Ironwright MCP is stronger at** the job itself. Softeria has no reconciliation; an agent could
approximate one only by paging raw delta results into its context, reading the workbook, and
comparing in the conversation, which is the cost this project exists to remove. Its moves and
renames apply immediately with nothing to review or undo. And its identity model centers on a
signed-in person, where a hosted steward agent needs an unattended, site-scoped identity.

They are complements more than rivals. The risk is an operator deciding that Softeria plus a
careful prompt is good enough; the answer is the measured contrast between a 4-request scan and
a single reconciliation call on one side, and one call per folder plus an in-context diff on the
other.

## What this means for Ironwright MCP

**The differentiation claim holds, under a wider check than before.** No MCP server, governance
suite, Microsoft feature, DIY pattern or document-completeness tool found reconciles a tracker
against an existing library and then offers reviewable, reversible remediation. The Decision
Record's premise needs no amendment.

**Act on:**

1. **Check the server's own token at startup.** A Microsoft Q&A moderator answered, as by
   design, that adding `Files.Read.All` or `User.Read.All` to an application holding
   `Sites.Selected` let it read sites it was never granted. Setup already checks the grant issuer's roles claim
   (`appRolesFromAccessToken` in `src/setup/steps.ts`), but the running server never checks its
   own. A startup refusal when the server's token carries any role other than `Sites.Selected`
   would turn the least-privilege claim from a setup-time fact into a runtime guarantee, cheaply.
2. **Use the Work IQ comparison in evaluations and the pilot proposal.** Microsoft's own
   SharePoint server pages folders 20 items at a time without delta; this project scanned 144
   files and 122 folders in 4 requests. That contrast is now citable from an official page, not
   inferred.
3. **Lead with rename and safe moves for Copilot Studio users.** The SharePoint connector has no
   rename action, and the accepted workaround is a raw REST call in a flow. Plan-then-execute rename and
   move answer a gap users have already hit.

**Watch:**

- XMV adding delta is the first sign the "do not re-walk the tree" lesson is spreading. A
  reconciliation layer on top of it would be the first real competitor.
- AuditDashboard's MCP connector already puts an agent on "chase what's missing" with a
  confirmation gate, inside its own portal. If it starts reading the SharePoint libraries it lists
  as an integration, it becomes the first real overlap from the adjacent markets.
- Microsoft's SharePoint Admin Agent is live and "returns analysis and guided remediation" from
  chat, per a [third-party roadmap summary](https://vladtalkstech.com/microsoft-365/sharepoint/sharepoint-advanced-management-roadmap/).
  It works on sites and permissions today; if it
  reaches document-level filing, it becomes the platform default to beat.
- The Google Drive server with a `dry_run` and a restore token, once found again, is worth reading
  as prior art for operator-authored plans (phase 6d).

## Limits of this pass

Three research passes on 2026-09-24, each opening its sources directly. Several adjacent-market
pages (Knowledge Agent, SmartVault, Procore, IT Glue, Hudu, ControlMap) were read through search
summaries only and are the weakest links; pricing for ShareGate and Syskit comes from third-party
aggregators. New registry entries were not checked against their own code. Reddit and Hacker
News produced nothing usable. Raw research notes, with every source, were kept outside the
repository.

## Sources

Microsoft: [Work IQ SharePoint reference](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-sharepoint-tools),
[Work IQ APIs announcement](https://www.microsoft.com/en-us/microsoft-365/blog/2026/06/02/announcing-the-new-work-iq-apis/),
[SharePoint Advanced Management](https://learn.microsoft.com/en-us/sharepoint/advanced-management),
[Agents in SharePoint](https://support.microsoft.com/en-us/sharepoint/copilot-in-sharepoint/get-started-with-agents-in-sharepoint),
[Purview file plan](https://learn.microsoft.com/en-us/purview/file-plan-manager),
[Q&A: Sites.Selected with Files.Read.All](https://learn.microsoft.com/en-us/answers/questions/5621045/sites-selected-not-working-as-expected-with-files),
[Q&A: delta token expiry](https://learn.microsoft.com/en-us/answers/questions/5856205/microsoft-graph-delta-api-clarification-on-delta-t),
[Q&A: delta returning only the root](https://learn.microsoft.com/en-us/answers/questions/5937149/how-to-identify-sharepoint-permission-changes-usin),
[Q&A: renaming 10,000 files](https://learn.microsoft.com/en-us/answers/questions/1540995/which-tool-method-is-best-to-rename-10000-files-in).

MCP servers and directories: [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=sharepoint),
[Glama SharePoint search](https://glama.ai/mcp/servers?query=sharepoint),
[XMV sharepoint-mcp](https://github.com/XMV-Solutions-GmbH/sharepoint-mcp),
[Softeria ms-365-mcp-server](https://github.com/softeria/ms-365-mcp-server),
[Softeria endpoints.json](https://github.com/softeria/ms-365-mcp-server/blob/main/src/endpoints.json),
[Lokka](https://github.com/merill/lokka),
[Markifact](https://www.markifact.com/sharepoint-onedrive-mcp),
[PuntoBello on Work IQ's 35 tools](https://www.puntobello.ch/en/nello/mcp365_explorer_sharepoint_lists/),
[mcp-reconcile](https://github.com/yunaremaia/mcp-reconcile).

Adjacent products: [ShareGate: rename only when copying](https://help.sharegate.com/en/articles/10236143-export-metadata-and-import-and-copy-with-excel-or-csv),
[ShareGate migration](https://sharegate.com/sharepoint-migration),
[AvePoint August 2026 updates](https://www.avepoint.com/blog/solutions-blog/avepoint-updates-august-2026),
[Syskit Point governance](https://www.syskit.com/solutions/sharepoint-governance),
[Rencore pricing](https://rencore.com/en/pricing),
[Orchestry on the agent governance gap](https://www.orchestry.com/insight/sharepoint-ai-agent-governance-gap),
[PnP Move-PnPFile](https://pnp.github.io/powershell/cmdlets/Move-PnPFile.html),
[Power Automate throttling](https://manueltgomes.com/microsoft/power-platform/powerautomate/batch-operations-and-throttling-mitigation-in-power-automate/),
[AuditDashboard](https://www.auditdashboard.com/),
[AuditDashboard AI Connector (MCP)](https://www.auditdashboard.com/mcp-ai-connector),
[SharePoint Advanced Management roadmap](https://vladtalkstech.com/microsoft-365/sharepoint/sharepoint-advanced-management-roadmap/).

User feedback: [Lokka #42](https://github.com/merill/lokka/issues/42),
[#44](https://github.com/merill/lokka/issues/44), [#54](https://github.com/merill/lokka/issues/54),
[#55](https://github.com/merill/lokka/issues/55),
[DEmodoriGatsuO #18](https://github.com/DEmodoriGatsuO/sharepoint-mcp/issues/18),
[#19](https://github.com/DEmodoriGatsuO/sharepoint-mcp/issues/19),
[ftaricano #12](https://github.com/ftaricano/mcp-onedrive-sharepoint/issues/12),
[Power Platform: rename in Copilot Studio](https://community.powerplatform.com/forums/thread/details/?threadid=282e315e-36f2-f011-8407-7c1e5268c02a),
[Power Platform: Work IQ comparison](https://community.powerplatform.com/forums/thread/details/?threadid=9a8cd483-3b22-f111-8341-0022482aa60e).
