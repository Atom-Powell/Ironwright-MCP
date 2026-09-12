# SharePoint/Graph MCP Server Landscape — Competitive Review & Lessons Learned

*Compiled September 11, 2026, via targeted web research (no dedicated deep-research tool was available for this pass — see Caveats). Companion to `CLAUDE.md` and `Pain-Points.txt`.*

## Method and evidence tiers

Findings below are tagged by how solid the evidence is:
- **Verified** — pulled directly from the project's own repo, docs, or an official Microsoft source.
- **Directory signal** — from an MCP directory's own grading/estimation (Glama.ai's per-tool quality scores and license/quality/maintenance letter grades, PulseMCP's visitor/popularity estimates). These directories are explicit that their estimates are approximate.
- **Single source** — one blog post, comment, or forum thread. Flagged as such; not corroborated elsewhere.

## Census: what's currently active

**Microsoft first-party (all confirmed via the official `microsoft/mcp` catalog, verified):**
- **OneDrive and SharePoint** (`mcp_ODSPRemoteServer`) — remote server via Agent 365, all ODSP file tools auto-discovered.
- **SharePoint Lists** (`mcp_SharePointListsTools`) — remote server via Agent 365, site/library/list management.
- **SharePoint Embedded MCP Server** (`microsoft/SharePoint-Embedded-MCP-Server`) — open-source, npm alpha (`@microsoft/spe-mcp`), local stdio server for SPE containers specifically (not classic document libraries).
- **Microsoft MCP Server for Enterprise** (`microsoft/EnterpriseMCP`) — read-only Entra/security-posture data, not file operations.
- **Work IQ MCP** — see the dedicated correction section below; this is not what prior research described.

**Community (verified from each repo unless noted):**
| Project | Stack | Notable signal |
|---|---|---|
| Lokka (`merill/lokka`) | Node/TS | 262 GitHub stars, 69 forks; PulseMCP: ~18.5k est. visitors, popularity #1,058 *(directory signal)*; only 3 open issues but issue creation is restricted on the repo |
| **XMV Solutions GmbH `sharepoint-mcp`** (`mcp-server-sharepoint` on PyPI) | Python | Most mature community option found — see dedicated section below |
| `sekops-ch/sharepoint-mcp-server` | TypeScript, MPL-2.0 | OAuth2 client-credentials, resource-based URIs |
| `DEmodoriGatsuO/sharepoint-mcp` | Python | stdio/SSE/streamable-HTTP, Docker support |
| `ncdcdev/sharepoint-docs-mcp` | Python | Certificate-only auth, has an Excel cell-range reader with frozen-row handling |
| `ezemriv/sharepoint-mcp` | Python | OS-keychain token storage, device-code auth flow |
| `ravikant1918/sharepoint-mcp` | — | Docker-first, subfolder scoping via env var |
| `ftaricano/mcp-onedrive-sharepoint` | — | `MCP_TOOL_PROFILE=full` gates destructive tools behind explicit opt-in |
| `icemage001/local_sharepoint_mcp` | — | Has a `preview_delete_item` dry-run tool (see "doing it right, badly labeled" below) |

## Correction to prior research: Work IQ's real architecture

Prior research (used in the SOW package's Recommendation 6 / SOW 7) described Work IQ SharePoint as a ~30-tool, 5MB-capped, Copilot-license-gated preview surface. **That's outdated.** Per Microsoft's own June 2026 GA announcement and Learn docs *(verified)*:

- Work IQ **collapses the entire M365 surface (mail, calendar, files, people, chat, sites) into roughly 10 generic verb tools** (fetch, create, update, etc.) operating over resource paths, with a `getSchema` capability for runtime discovery instead of hardcoded per-endpoint schemas.
- APIs (A2A, MCP, REST) went **GA June 16, 2026**, and are **consumption-based, independent of Microsoft 365 Copilot licensing** — not gated behind it.
- **Read-only by default**; an admin must explicitly enable write operations in the M365 admin center.

This is a materially more sophisticated design than a thin wrapper — it's the most aggressive tool-consolidation example found in this whole review, built by a team with a scale advantage we won't have. It still does **not** do reconciliation, batch tree inventory as a concept, or bulk remediation — so it doesn't change the core build-vs-augment decision. But it does mean **SOW 7's licensing-contingency framing is now wrong** and should be revisited once Phase 6 is reached: Work IQ may be viable as a complementary layer sooner, and more cheaply, than assumed.

## The standout: XMV Solutions GmbH's `mcp-server-sharepoint`

This is the most professionally engineered community server found, and worth studying closely even though it solves a different problem than reconciliation. *(Verified from repo/PyPI/Glama.)*

**What it does:** wraps Microsoft Graph's native checkout/edit/checkin model instead of doing direct overwrites, explicitly to preserve SharePoint's audit trail for documents "under retention or audit constraints (ISMS records, controlled procedures, contract templates)" — nearly identical framing to our own compliance-report use case, just solving safe editing rather than gap analysis.

**Concrete practices worth borrowing:**
- **ETag-based stale-write detection** on `sp_save`/checkin — catches the same class of stale-state problem our stale-ID pain point describes, using a mechanism we hadn't planned for. Worth adding ETags alongside path addressing in our Graph layer.
- **Tiered cost model on read operations**: `sp_drive_checkout_list(verify=False)` is registry-only and sub-second; `verify=True` costs one Graph call per entry. The tool description states this cost tradeoff explicitly. Mirrors our own "state index avoids new Graph calls" plan — good validation, and a good description-writing pattern to copy.
- **Explicit write consent gating** via environment variables (their sibling project, `microsoft-tasks-mcp`, has `TASKS_ALLOW_EXTERNAL_WRITES` / `TASKS_ALLOW_WRITES` as a strict opt-in with an OAuth scope split) — a config-level safety layer *in addition to* per-call confirmation.
- **Decision Records discipline** — their engineering principles doc has a numbered "§16 Decision Records" section. Same instinct as the Decision Record section already in our `CLAUDE.md`; their public repo is a useful reference for what a mature version looks like over time.
- **PR-only branch protection with a required CI "harness" check**, including an explicit "error-path harness requirement" (not just happy-path tests).
- **Iterated tool naming/grouping based on real usage**: v0.7.0 renamed 16 tools to include "file" in the name, added `SP_TOOL_GROUPS`, and removed base64 encoding in favor of local-temp-file + filesystem-read (cutting token overhead) — a real example of the tool-naming/context-management guidance in the `mcp-builder` skill being learned the hard way rather than designed in up front.

**Where it still shows real limits:** Glama.ai grades it **A** on license and quality but **C on maintenance** *(directory signal)* — even the best community option here carries meaningful bus-factor/continuity risk. This reinforces, rather than just repeats, the original decision not to depend on any community server.

**What it doesn't do:** no reconciliation against an external expected-state source, no batch tree inventory, no bulk rename/move, no structure validation, no template replication. The differentiation claim holds.

## What else is being done right (scattered across other projects)

- **SharePoint Embedded MCP Server (Microsoft, verified):** every state-changing tool requires an explicit `confirm: true` parameter — a named "destructive-operation confirmation gate (SAFE-002)." Also ships `--read-only` and `--tools` launch flags to restrict the exposed tool set at process start, and privacy-conscious telemetry (a single opt-out-able User-Agent attribution token, explicitly "no usage-analytics channel"). Clear, honest alpha/liability disclaimers up front.
- **`ftaricano/mcp-onedrive-sharepoint`:** gates destructive/advanced tools behind `MCP_TOOL_PROFILE=full` — a safe-by-default install where you have to opt into the risky tool set, not opt out of it.
- **Direct Line MCP server (`bradcstevens`, Glama-listed):** 11 specialized error types, OAuth-specific retry strategies, and explicit MCP error transformation — a good bar for error-handling granularity, even though its own stated philosophy ("intentionally avoid complex tools that try to do too much... thin abstraction layer") is exactly the anti-pattern our project is trying not to be.
- **General ecosystem convergence on tool annotations:** `readOnlyHint`/`destructiveHint`/`idempotentHint` (as recommended in the `mcp-builder` skill) show up as a real, graded quality bar on Glama, not just a nice-to-have.

## What's being done wrong (with evidence)

- **The thin-wrapper anti-pattern is the single most repeated criticism in 2026 MCP discourse**, from multiple independent, non-competing sources: a WorkOS engineering blog post (Apr 2026) explains it structurally — REST is designed for a human developer who reads the docs once and is happy to chain `GET /users → GET /orders → GET /shipments`; an LLM agent doing the same thing burns context and loses track. A dev.to post cites Anthropic's own official MCP guidance directly: *"Group tools around intent, not endpoints,"* using the same `list_x/get_x/update_x/delete_x/export_x` CRUD-wrapper shape as its canonical anti-example. A third source (0mcp.io) frames it as a checklist failure: a wrapper alone doesn't give agents "clear tool names, descriptions, input schemas, bounded operations... predictable results."
- **This is now measured, not just argued.** An academic study (Hasan et al. 2026, cited in an empirical MCP-construction paper on arXiv) analyzed 856 tools across real MCP servers and found **97.1% had at least one tool-description "smell," and 56% failed to state their purpose clearly.** Separate cited work catalogs recurring security threats (Hou et al. 2025) and fault taxonomies (Taraghi et al. 2026) across the server lifecycle. Tool-description and design quality is a documented, ecosystem-wide problem, not a hypothetical one.
- **Lokka's own open issues are live examples of exactly our target pain points.** *(Verified, current as of this research.)* Issue #42: a `RequestBroker--ParseUri` error when a Graph ID contains an `=` character in the URL path — precisely the kind of ID-based-navigation fragility our path-addressing decision is meant to avoid. Issue #44: the device-code auth fallback returns `undefined` for `verification_uri`/`user_code` and fails with `invalid_grant`. Also notable: **issue creation is restricted** on the repo, which means visible complaint volume likely understates real friction.
- **A good design pattern with a bad description is invisible to the agent.** `icemage001/local_sharepoint_mcp`'s `preview_delete_item` tool does the right thing architecturally (a dry-run preview before a destructive delete — validates our own plan-then-execute instinct has precedent) but Glama's automated grading still scored its description **2/5** because the description never explicitly states it's non-destructive. The same server's `delete_group` and `get_health` tools scored 2/5 for similar reasons (not stating permanence/undo status, not stating read-only status). The lesson: a tool's *name* implying safety isn't the same as its *description* stating it.
- **Everyone repeats the same Azure AD app-registration walkthrough independently.** At least five of the surveyed community servers ship a near-identical "register an app, grant Graph permissions, set redirect URI" doc with no real improvement over the last one — a documented, ecosystem-wide missed opportunity to solve onboarding friction once.

## Competitive check: does reconciliation prior art exist?

No — first-party or community. Nothing found implements a workbook-vs-repository reconciliation engine, a single-operation batch tree inventory, structure validation against a taxonomy standard, or template replication across clients. XMV's checkout/checkin server is the closest adjacent "compliance-conscious" SharePoint MCP server, and it solves a genuinely different problem (safe collaborative editing with an intact audit trail, not gap analysis against an external expected-state source). **The differentiation claim from the original build-vs-augment research still holds.** If something surfaces later that changes this, that's a reason to stop and re-evaluate — not a reason to second-guess the current plan preemptively.

## Adjacent pattern worth pulling into the Claude Code environment

There is a published skill, `mcp-workflow-design` (from `atomicpages/mcp-skills`), explicitly described as: *"Transform a raw API-wrapper MCP server into an AI-native tool surface by analyzing the upstream API, identifying user intent patterns, and composing multi-step operations into single outcome-oriented tools."* It's positioned as a complement to `mcp-builder` for servers that already have atomic tools and need workflow-level composition on top. Worth running `search_skills` for it in the Claude Code environment — it's aimed at exactly the transformation this project is trying to do from day one rather than retrofit later, and studying how it frames the retrofit process is useful even if we don't literally need to retrofit anything.

Confirmation-gate mechanics also vary in maturity worth knowing about before inventing one from scratch: Supabase's MCP server uses a `confirmation_id` that expires after 5 minutes and must be replayed with `user_confirmation: true`; `openapi-mcp` returns a structured "confirmation required" response and expects a retry with `__confirmed: true`; SharePoint Embedded MCP Server uses a plain `confirm: true` parameter. Any of these is a reasonable reference for our own `execute_*_plan` confirm-flag design — no need to invent the shape from nothing.

## Lessons for our build

**Copy:**
1. ETag-based stale-write detection alongside path addressing — upgrades the `conflictBehavior` handling already planned in SOW 2.
2. A config-level write-consent gate (env var or launch flag), in addition to the per-call plan-then-execute confirm flag already locked in — two independent layers, not one.
3. An explicit error-path test harness as a required CI gate from Phase 1 onward, not something deferred to "testing later."
4. State every tool's read-only/destructive/idempotent status *in the description text itself*, not just in the structured annotation fields — Glama's grading shows descriptions are where good designs quietly lose points.
5. Keep the Decision Record habit going as a living document, the way XMV does publicly.

**Avoid:**
1. Building tools around individual Graph endpoints — the most repeated, now-measured criticism in the ecosystem, and the exact shape of every community SharePoint MCP server surveyed.
2. Assuming a tool name communicates safety — say it explicitly, every time, in the description.
3. Writing a sixth near-identical Azure AD app-registration walkthrough with no improvement over the last five.
4. Treating any community server as a dependency — even the best one found here (XMV) carries a directory-graded "C" maintenance signal.

**One correction to carry back into the SOW package:** Work IQ's real architecture (10 generic tools, GA, licensing-independent, read-only by default) is more capable and more accessible than SOW 7 assumed — revisit that SOW's premise when Phase 6 is reached rather than treating it as settled.

## Caveats

- No dedicated deep-research tool was available for this pass; this reflects roughly a dozen targeted web searches, not an exhaustive multi-hour sweep. Treat the census as a strong snapshot, not a guaranteed-complete list.
- GitHub issue visibility is uneven — some repos (Lokka) restrict who can open issues, which suppresses visible complaint volume without necessarily meaning fewer real problems exist.
- Star counts, Glama letter grades, and PulseMCP visitor/popularity estimates are directional adoption/quality signals from third-party directories, not verified, audited benchmarks — the directories themselves describe their own methodology as approximate.
- Work IQ's licensing/GA details should be reconfirmed against current Microsoft Learn docs immediately before Phase 6, since this surface has already changed materially once since the original architecture research.
