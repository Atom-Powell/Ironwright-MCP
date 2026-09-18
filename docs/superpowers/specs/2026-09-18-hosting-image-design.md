# Phase 5a: the production image

Design spec. Written 2026-09-18, after phase 4c merged and `main` reached `2bba197`.

## What this phase delivers

Everything that turns this repository into a shippable artifact and can be proven without a cloud
account:

- A production container image, and the build defect that currently prevents one.
- A bounded shutdown.
- Health endpoints shaped for the platform that will run it.
- An explicit configuration contract, including where profiles come from when the image ships none.

The merge gate is that the CONTAINER, not a local process, answers all five read tools correctly
against the live tenant.

## Why phase 5 is sliced here

Phase 5 as the parent spec describes it is the image, the credential, Container Apps, the Entra
auth front door, CI/CD and telemetry. That cannot be executed to completion in one plan, because
everything past the image needs an Azure subscription, real spending, and an operator at a
keyboard for at least the first sign-in.

The boundary is therefore drawn at the Azure line. 5a is what can be built and verified locally.
5b is what needs the cloud.

**Out of scope, explicitly:** Azure resources of any kind, the Entra authentication front door,
CI/CD, telemetry, and the entire federated credential.

## The credential is deliberately absent from this phase

Phase 5b will replace the client secret with a managed identity holding a federated credential, so
the server proves who it is without ever holding a secret. That decision is made. The work is not
in this phase, and the reason is this project's most expensive lesson.

Phase 2b-1 was designed, built, reviewed across six separate tasks and merged against a Microsoft
Excel API that nobody had ever called. The first live run was refused at every permission level
available, because the API requires a signed in user and an unattended service has none. The rule
that came out of it is recorded in `CLAUDE.md`: when a phase depends on an API surface this project
has never actually called, the cheapest possible live probe against that surface comes first,
before the design that assumes it.

A federated managed-identity token exchange is exactly such a surface. So 5a introduces no code for
it, not even an abstraction to hold it later. An interface shaped around an unobserved API is the
same mistake wearing a tidier coat. 5b begins with the probe and designs around what it sees.

5a therefore keeps the existing client-credentials path untouched, and the verification run uses
the same secret-bearing environment every live sitting so far has used.

## The image

Multi-stage. The build stage installs everything and compiles; the runtime stage takes only
production dependencies and `dist`.

`node:22-slim` rather than Alpine. This is not a size-critical workload, and musl has produced
enough Node surprises that the smaller base is not worth the class of failure it can introduce in a
server nobody will be sitting next to.

The runtime stage runs as a non-root user and starts through `npm start`, which already points at
the compiled entry point.

A `.dockerignore` excludes `profiles/` explicitly. Profiles are deployment configuration this
project never commits, and baking a customer's site, library and client list into an image would
undo that at the first build.

## The build defect that blocks all of it

`npm ci --omit=dev && npm run build` fails today. The build compiles `src/setup/main.ts`, which
imports `@azure/identity`, a dev dependency. `docs/OPEN-ITEMS.md` has carried this for the hosting
phase since it was found.

Two fixes exist and they are not equivalent:

- Build before pruning, which leaves the setup command's dependencies in the image.
- Exclude `src/setup` from the production tsconfig, which keeps them out.

**This phase excludes `src/setup`.** The setup command is an operator tool run from a workstation.
It issues per-site permission grants using a separate application that holds
`Sites.FullControl.All`, and it has no business inside a server image. Shipping that code path into
the runtime container widens the blast radius of a container compromise from "can read one granted
site" to "contains the machinery for granting access to others". The size saving is incidental; the
boundary is the point.

A test asserts the production build succeeds, so this cannot regress silently the next time
something under `src/setup` grows an import.

## Shutdown

The SIGTERM handler has no fallback deadline today. One request that never completes means `close`
never calls back and the platform eventually sends SIGKILL.

It gains a deadline: stop accepting new work, drain what is in flight, and exit anyway after a
bounded wait, logging how many requests were still outstanding when the deadline expired. A server
that cannot say why it was killed teaches nobody anything.

## One carried item this phase deliberately does not fix

`docs/OPEN-ITEMS.md` records that the MCP SDK deletes a pending stream-mapping entry on close
without resolving it, so an aborted request can leave its handler permanently pending and retain
the closure. It also records that this matches the SDK's own stateless example and is not a local
defect.

This phase does not fork SDK behavior on a hunch. What makes the item tractable is detection rather
than repair, and detection is telemetry, which belongs to 5b. So 5a bounds the shutdown it can
bound, 5b learns to observe the leak, and neither is written up as having fixed the other.

## Health

The server already serves `GET /health`. This phase settles what it means, because a platform will
now act on it.

A failure to load configuration or profiles already exits the process at startup rather than
serving in a broken state, which is the correct behavior and is preserved. `/health` therefore
answers for a process that got that far: it reports that this instance can serve, not that the
tenant is reachable. It must not call Microsoft Graph. A health check that depends on a third party
turns that party's outage into an instance restart loop, which is strictly worse than serving an
error to one caller.

## The configuration contract

The image ships no configuration. This phase writes down exactly what the container requires, in
one place, because 5b has to supply it and a deployment that discovers a required variable at
startup has already failed.

Required: the tenant, client and secret for the server's own application, the granted site, and the
profile directory. The granted site became required in phase 4c; a server without it does not start,
and it is the value the profile registry checks every profile against.

Optional: the Azure Table connection string, whose absence selects the in-memory store, and the
write-enable flag, whose absence keeps every write tool unpublished rather than merely refused.

**Profiles arrive as a mounted directory, not as an image layer and not as an environment value.**
`IW_PROFILE_DIR` names a path the container reads at startup. 5a's contract is that the path exists
and holds valid profiles; how that path is populated in Azure is 5b's problem and is deliberately
not decided here.

## Verification before merge

The container answers all five read tools correctly against the live tenant: same workbook, same
library, same expected counts, through the image rather than through a local process.

This is the first time this project runs as a shipped artifact rather than as source, and it is
achievable before any Azure resource exists. A run that passes locally and fails in a container has
found a packaging defect, which is exactly what this phase exists to surface.

The run must use a profile directory mounted into the container, not copied into it, because that
is the contract 5b will implement and an untested contract is not a contract.

## What 5b inherits

Named here so that phase does not discover them:

- The federated credential, beginning with a probe.
- Container Apps at one replica, with the rollout configured so a new revision does not run
  alongside the old. Phase 4c made the single-process assumption load bearing for correctness
  rather than only for the delta link, and a rolling update is the one window that silently
  violates it.
- The Entra authentication front door, already decided in `docs/OPEN-ITEMS.md`.
- CI/CD.
- Telemetry, which carries two jobs rather than one: the Graph call volume evidence this project
  was started to produce, and detection for the pending-handler leak above.
- Populating the profile directory.
