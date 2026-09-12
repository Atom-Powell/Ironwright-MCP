# CLAUDE.md — [Project Name TBD]

> This is the kickoff pointer file for a new git repo. Read this first, then read the two companion documents Adam will place alongside it (see **Companion Documents** below) before writing any code. Following your own established pattern from Axis: this file is the persistent session anchor. As the project grows, split live status out into `docs/CLAUDE_CODE_RUNBOOK.md` and `SESSION_STATUS.md` rather than letting this file balloon — this file should stay a stable reference, not a changelog.

## Mission

Build a purpose-built, path-native Microsoft Graph/SharePoint reconciliation MCP server. The explicit goal is to be a genuinely better piece of engineering than what currently exists in this space — every community and first-party SharePoint MCP server surveyed during research is architected as a thin per-call Graph wrapper (one tool, one Graph call). That's the mold. This project's reason to exist is to not do that: composite, server-side-orchestrated tools; a real reconciliation engine; deterministic plan-then-execute writes. If an implementation choice pulls back toward "just wrap the Graph endpoint," treat that as a signal to stop and reconsider, not a shortcut to take.

The immediate consumer is **PhishMaster**, a Copilot Studio agent at EON Consulting that stewards a SharePoint repository of cybersecurity training and phishing-simulation compliance reports. But see **Open Decisions** below on how hard to couple the architecture to that one use case.

## Companion Documents

Adam is providing two files alongside this one. Read both in full before starting Phase 1:

1. **`Pain-Points.txt`** — the original problem statement. Seven concrete pain points (expensive recursive inventory, folder existence ≠ report existence, inconsistent naming, misplaced files, ID-based navigation overhead, stale-ID lookup failures, and the workbook-as-database insight) plus the list of desired capabilities. This is the ground truth for *why* each tool exists — if a design choice doesn't trace back to one of these pain points, question it.
2. **`PhishMaster_MCP_SOW_Package.docx`** — seven Statements of Work (SOW 1–7) mapping to the phases below, each with scope, deliverables, dependencies, time estimates, and a risk/mitigation register. Treat the risk registers as a pre-loaded bug list — several of them (session expiry, async move polling, no built-in undo) are easy to discover the hard way if skipped.

If Adam also wants the full citation-backed architecture research (Graph API technique details, Copilot Studio MCP publishing mechanics, first-party server survey, Microsoft's 2026 announcement timeline) exported as a third reference doc, ask him — it exists but wasn't bundled by default here.

## Decision Record — Already Locked

These came out of an explicit augment-vs-build research pass. Treat them as settled; if you think one is wrong, that's a STOP-AND-ASK, not a silent override.

- **Build new, do not fork.** No existing SharePoint/Graph MCP server (first-party or community) implements batch tree inventory, a reconciliation engine, or bulk plan/execute tooling — forking one buys nothing and couples the project to someone else's transport/auth assumptions.
- **Language/SDK:** TypeScript + Node.js, official `@modelcontextprotocol/sdk`, Microsoft Graph JavaScript SDK.
- **Transport:** `StreamableHTTPServerTransport` in **stateless mode** (`sessionIdGenerator: undefined`), a new `McpServer` instance per request. This is required for Copilot Studio (SSE is no longer supported there) and is also the SDK's own guidance to avoid cross-request state leakage.
- **Graph access pattern, in this priority order:** path-based `driveItem` addressing (`drive/root:/Year/Client/Month/file`) over ID-based addressing; `$batch` for combining requests (20-request / 4MB caps, `dependsOn` for ordering); delta query (`/drives/{id}/root/delta`) with a persisted `deltaLink` so repeat scans only fetch changes; Microsoft Search API as the cross-check for files sitting outside the expected folder taxonomy.
- **Excel-as-database:** persistent workbook sessions (`createSession`, `persistChanges: true`), `workbook-session-id` header on every call, explicit detection and recreation of expired sessions (404), and a sequential single-flight queue per workbook — Excel throttling is real and worse under concurrency.
- **State/index store:** Azure Table Storage for per-drive `deltaLink`s and the last-known inventory snapshot. Don't reach for Dataverse unless the agent's own state already lives there for other reasons — it's heavier and licensed.
- **Hosting:** Azure Container Apps (Node-native, stateless, min replicas = 1). Cloudflare Workers was considered and explicitly not chosen for this workload — the legacy `McpAgent`/Durable Objects path is deprecated, the current stateless `createMcpHandler` path would require externalizing Excel session state and Graph fan-out yourself, and Azure's Node-native model fits the Graph/Excel-session-heavy access pattern better. Don't relitigate this without a real cost or latency reason.
- **Auth:** Entra ID confidential client app registration, scoped via **`Sites.Selected`** to the specific site(s) in use — not `Sites.ReadWrite.All` / `Files.ReadWrite.All`. This is the real least-privilege boundary for this project, because Copilot Studio's DLP/Advanced Connector Policy governance is per-server, not per-tool, and cannot substitute for it.
- **Write-tool design:** every mutating tool is plan-then-execute — a `generate_*_plan` tool returns a reviewable, persisted plan; a separate `execute_*_plan` tool applies it. Dry-run is the hard default; live execution requires an explicit confirm flag. Every execute path writes a reversal log (old state → new state) *before* applying changes, so a bad batch can be rolled back without manual reconstruction. This is not optional polish — there is no Graph-native undo for bulk rename/move.

## Tool Set

| Tool | Type | Notes |
|---|---|---|
| `inventory_tree` | read | Full repository tree via delta + batch, not recursive per-folder walks |
| `reconcile_workbook_vs_repository` | read | The centerpiece. Workbook (expected) vs. repository (actual) diff → gap report |
| `query_repository` | read | Ad hoc operational questions (empty folders, orphaned files, non-compliant clients) served from the state index, no new Graph calls |
| `generate_rename_plan` / `execute_rename_plan` | plan / write | Two-phase, dry-run default |
| `generate_move_plan` / `execute_move_plan` | plan / write | Two-phase; cross-library moves are async in Graph (202 + monitor URL) — poll correctly |
| `validate_structure` | read | Compliant / non-compliant / missing against the approved Year → Client → Month taxonomy |
| `replicate_template` | write | Applies a validated client's structure to others — gate this behind running `validate_structure` on the source client first |

Per the `mcp-builder` skill's guidance (`/mnt/skills/examples/mcp-builder/SKILL.md` if available in your environment — load it before Phase 1): give every tool explicit annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), use Zod schemas with real constraints and examples in the field descriptions (not just types), and define `outputSchema`/`structuredContent` so callers get structured data back, not just prose. This matters more here than in a typical integration — a tool an LLM might call destructively against production compliance data needs its `destructiveHint`/`idempotentHint` to be honest, not decorative.

## Non-Negotiable Engineering Principles

- **Deterministic and auditable over agentic.** The LLM calls tools; it does not improvise Graph operations. Every plan is inspectable data, not a narrative description.
- **Security-first at launch**, not a follow-up pass — `Sites.Selected` scoping, dry-run defaults, and reversal logs ship in the same PR as the capability they protect, not after.
- **No production writes until read-only is validated.** Nothing in Phase 4 (rename/move/replicate) touches real client compliance data until Phase 3's reconciliation output has been manually confirmed correct against known ground truth, and a sandbox/staging copy of the library and workbook exists for write-path testing. Provisioning that sandbox is a Phase 1/2 prerequisite, not something to discover you need mid-Phase-4.
- **Comments explain why, not what** — especially around the Graph quirks (session expiry windows, the folder-vs-file `conflictBehavior` replace inconsistency, async move polling) where the reason for a workaround won't be obvious from the code alone six months from now.
- **Modular over monolithic.** The Graph-access layer (path addressing, batch, delta, Excel sessions, retry/backoff) is a standalone library the tool layer consumes — it should be usable and testable independent of any specific tool.
- **No emojis or icons anywhere** — not in code, comments, CLI output, logs, or docs.
- **US English throughout** all documentation and copy.

## Working Agreement (Claude Code Sessions)

Mirrors the pattern already working on Axis:

- **Design before implementation.** Significant features get a short design dialogue with explicit architectural decisions confirmed before code is written. The Decision Record above covers the big ones already; new forks that come up mid-build get the same treatment.
- **Work orders as staged markdown**, with explicit `WAIT` and `STOP-AND-ASK` checkpoints and a stated out-of-scope boundary, pasted in interactive mode rather than passed as CLI args (Windows character-limit issue).
- **STOP-AND-ASK is load-bearing.** Architectural forks — anything touching the Decision Record above, the single-tenant-vs-generalized question below, or licensing/naming — surface for Adam's decision. Don't auto-resolve and move on.
- **Gate-based approval.** No destructive or cross-module operation runs without a clean git status, a green test suite, and explicit sign-off. Recovery tags before anything destructive.
- **Conventional commits.** Direct to main for routine work; feature branches with PRs (no auto-merge) for anything risky or architectural.
- **Project knowledge wins.** Where this file, the companion docs, or `docs/` conflict with your background knowledge of Graph/MCP/Copilot Studio, the project docs win — but flag drift if you spot it, since this surface (Copilot Studio MCP support especially) moves fast and some of the "locked" decisions above were current as of September 2026, not evergreen.
- **Direct prose over bullet-point walls** in explanations and documentation — this file uses structure because it's a reference document, not because that's the house style for prose explanations during a session.

## Build Sequence

Maps directly to the SOW package so both documents stay in sync. Recommended order (not the SOW's numeric order — see the SOW package's own sequencing note for the reasoning):

1. **Phase 1 — Foundation** (SOW 1): server scaffold, stateless transport, Entra app registration + `Sites.Selected` grant, all tools stubbed end-to-end.
2. **Phase 2 — Graph Performance Layer** (SOW 2): path addressing, `$batch`, delta query, Excel session wrapper, Table Storage state index. *Provision the sandbox library/workbook here if it doesn't already exist — don't let this slip to Phase 4.*
3. **Phase 3 — Reconciliation Engine** (SOW 3): `inventory_tree`, `reconcile_workbook_vs_repository`, `query_repository`. **MVP checkpoint** — the highest-value capability should be usable here, before any write tool exists.
4. **Phase 4 — Bulk Remediation** (SOW 4): rename/move plan-execute pairs, structure validation, template replication, reversal logging. Only after Phase 3's output is validated against real data.
5. **Phase 5 — Hosting** (SOW 5): Azure Container Apps deployment, CI/CD, monitoring. Can run in parallel with Phase 2 once Phase 1 is done.
6. **Phase 6 — Copilot Studio Integration & Governance** (SOW 6): MCP wizard registration, DLP/ACP classification, Agent 365 BYO MCP graduation when governance bandwidth allows.
7. **Phase 7 — Work IQ Complementary Integration** (SOW 7, optional): only if Copilot licensing is confirmed; adds first-party primitives without duplicating this project's core logic.
8. **Phase 8 — Evaluation Suite** (not in the original SOW package, added per `mcp-builder` guidance): once the tool set is stable, write ~10 realistic, read-only, independently verifiable evaluation questions that require multi-tool-call reasoning against the real repository and workbook. This is the actual test of whether the "break the mold" goal was met — a server that passes unit tests but that an LLM still can't use well to answer real questions hasn't succeeded.

## Open Decisions — Surface, Don't Assume

- **Project name.** Not yet chosen. Candidates worth considering given the reconciliation/stewardship framing: something evoking mapping (the tool builds a tree/map of the repository), ledger-keeping (reconciliation), or stewardship (the original "AI repository steward" framing from the pain points doc). Don't lock this in without asking.
- **Single-tenant (EON-only) vs. generalized MSP tool — decide before Phase 1, not after.** The SOW package's estimates assume a single hardcoded site/library/workbook (EON's Technology Success site). But this project's ambition ("break a mold") and Adam's pattern with other tools (Axis, Atlas365, CyberPulse) suggest real potential to generalize into a multi-client MSP product. This materially changes the Phase 1 config layer: hardcoded site/library IDs vs. a configuration schema that treats site/library/workbook identity, naming standard, and folder taxonomy as inputs rather than constants. Retrofitting this later is much more expensive than deciding it now. Recommend raising this explicitly with Adam as the first STOP-AND-ASK of the project, before any Phase 1 code is written.
- **License.** Axis uses Elastic License v2 for a commercial single-developer MSP tool; that's a reasonable default if this has similar commercial potential, but it's Adam's call, not an assumption to bake in.
- **Public or private repo**, and whether this is developed under the Ironwright Labs brand (Adam's stated developer identity for all apps/tools) or kept EON-internal given the specific PhishMaster origin. These aren't mutually exclusive — Axis is an Ironwright Labs product actively deployed at EON — but worth stating explicitly in the repo's README and `package.json` once decided.
- **Sandbox provisioning mechanism.** Manual one-time setup, or a scripted mirror-and-anonymize job against the real library/workbook? Affects how repeatable Phase 2/4 testing is for future contributors.

## Reference

- MCP TypeScript SDK: `https://github.com/modelcontextprotocol/typescript-sdk`
- Microsoft Graph JS SDK: `https://github.com/microsoftgraph/msgraph-sdk-javascript`
- MCP server build guidance: `/mnt/skills/examples/mcp-builder/SKILL.md` (if present in your environment) — covers tool annotation conventions, evaluation methodology, and the API-coverage-vs-workflow-tools tradeoff in more depth than this file does.
