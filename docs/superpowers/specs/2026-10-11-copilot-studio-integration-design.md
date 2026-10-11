# Copilot Studio integration, track 1 of phase 7

Status: Draft, pre-probe. Written 2026-10-11. No implementation plan may be written until every row
of the Assumptions table has evidence (see the Working Agreement in `CLAUDE.md`). Three decisions
are open and listed under Decisions required; one of them touches the Decision Record.

## Purpose

Make Ironwright MCP a server that Copilot Studio agents use well, and prove it with measurements,
without spending on Azure. Phase 7 in the build sequence is Copilot Studio integration and
governance; phase 8 is the evaluation suite. This track covers both, sliced so the first live
contact with Copilot Studio is cheap and answers the unknowns before the design hardens.

The differentiation claim in the competitive refresh (2026-09-24) is that composite,
server-orchestrated tools beat thin per-endpoint wrappers. This track tests the part of that claim
nobody has measured: how the Copilot Studio orchestrator selects among our tools, and what a
reconciliation costs in Copilot Credits compared with the same job done through thin tools.

## Constraints

No Azure spend of any kind. That removes phase 5b from this track, and it removes Copilot Studio
pay-as-you-go billing, which Microsoft documents as requiring a linked Azure subscription. Only
capacity the trial or an existing license provides may be used. A prepaid pool stops when it is
exhausted, so every live run carries a credit ceiling and halts at it.

All Copilot Studio work happens in the `helloironwright` developer tenant. The employer tenant is
out of scope for development. A pilot there is a later, separately permissioned step, tested by the
operator by hand, and this spec does not design it.

Testing in Copilot Studio is manual. The operator runs steps and pastes back a sanitized record,
so the design favors server-side evidence over anything that needs an observer on the Copilot side.

The MCP surface is fixed by Copilot Studio: Streamable HTTP only, tools only (resources count only
as tool output, prompts are unsupported), a reachable HTTPS URL. The existing stateless server
already fits.

## Design

**Probe server.** A throwaway MCP server in this repo under a clearly separate path, exposing two
dummy tools and reading no tenant data. Its only job is to be the thing a dev tunnel fronts while
we learn what Copilot Studio accepts. The Ironwright server is never put behind a tunnel before it
has inbound authentication, because it has none today.

**Call trace.** The server writes one structured record per tool call: tool name, the shape of the
arguments (keys and types, never values), duration, Graph request count, outcome kind, and a
correlation id. The trace is the evidence base for credit analysis, because the server can see
everything on its side of the call but not Copilot's credit counts. It must not log argument
values, tokens, or anything marked sensitive in the project's existing redaction rules.

**Studio simulator.** A local client that drives the server over Streamable HTTP the way Copilot
Studio does, as observed by the probes. It exists to tune descriptions and schemas offline. It
cannot stand in for the orchestrator, and nothing it reports counts as evidence about tool
selection; only a live run does. This limit is stated in its output.

**Description and schema tuning.** Driven by probe B2 and B3 results: how descriptions and
parameter names arrive, and which questions route to which tool. Changes go through the existing
contract test over the whole registry.

**Evaluation suite.** Built from `docs/EVALUATION-QUESTIONS.md`, run by the operator against a
published or test-pane agent in `helloironwright`, each question with a credit budget and a global
ceiling. The suite records, per question, the tool chosen, whether it was the expected one, calls
made, Graph requests, and credits spent. A comparison arm runs the same questions through a thin
SharePoint tool set to give the credits-per-job contrast; which thin set is a decision below.

**Certification read.** A read-only study of what Microsoft's MCP server certification requires,
written up as a gap list. Nothing is submitted.

## Decisions required

1. **Inbound authentication for the tunnel period.** The Decision Record settles authentication as
   Container Apps built-in Entra authentication, which is Azure and unavailable here. The server
   needs its own inbound credential check before it is ever tunneled. Which mechanism depends on
   what Copilot Studio offers (probe A3). This amends the Decision Record and so waits for the
   operator.
2. **Thin comparison arm.** Whether the comparison uses Microsoft's Work IQ SharePoint server
   (requires licensing the trial may not include), or a minimal thin wrapper we write. A wrapper we
   write is weaker evidence because we chose its shape.
3. **Where the probe server lives.** In this repo behind a path the production build excludes, as
   `src/setup` is excluded, or in a separate repository. The first keeps one lint and test setup;
   the second keeps throwaway code out of a repo with a security boundary around its build.

## Assumptions

Every row is unverified as of this draft. The Probe column names the check in
`docs/COPILOT-STUDIO-PROBE.md`.

| Assumption | Why the design needs it | Probe |
|---|---|---|
| A trial or developer environment can be created in `helloironwright` without Azure billing | The whole track runs there | A1, A2 |
| Copilot Studio shows a credit or capacity figure we can read before and after a run | Credits per job is a headline measurement | A2, B4 |
| The add-tool dialog offers an authentication mode the server can satisfy | Decision 1 | A3 |
| Copilot Studio accepts a dev tunnel URL | The no-Azure testing path | B1 |
| Tool names, descriptions and parameter names arrive intact | Description tuning | B2 |
| The orchestrator calls a tool when a question clearly matches it and declines when none matches | The routing premise of the suite | B3 |
| An agent can be exercised in the test pane, and publishing is or is not available on the trial | Shapes how the suite is run | B5 |
| Streamable HTTP is the only transport and tools-only is the surface | Server already conforms; recorded so a change is noticed | A4 |
| Microsoft's certification requirements are readable without submitting anything | The certification read | Not probed; read from Microsoft documentation, dated when done |

## Out of scope

Phase 5b hosting and every Azure resource. Employer-tenant testing. Cross-library moves, folder
creation and `$batch`, which are depth tracks that proceed independently. Breadth beyond the fixed
recurring-deliverable domain, which needs its own design against the Decision Record before any
spec.
