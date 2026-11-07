# Copilot Studio probe checklist

Operator checklist for the first track of phase 7 (see
`docs/superpowers/specs/2026-10-11-copilot-studio-integration-design.md`). Its purpose is to turn the
spec's unverified assumptions into dated observations before any plan is written.

## Ground rules

Run every probe in the `helloironwright` developer tenant, with a Copilot Studio trial or developer
environment created there. Do not use the employer tenant for any of this. Do not enable Azure
pay-as-you-go billing or link an Azure subscription; if a screen asks for either, stop and record
that it asked.

Never paste a token, secret, API key, client secret, tunnel access token, or full tunnel URL into a
session. A tunnel hostname is a credential while the tunnel is up. Describe what you saw, and where
a value matters, give its shape (for example "40 character string, begins with a letter").

Copilot Studio's labels move often. Where this list names a menu, treat it as a hint and write down
what the screen actually says.

## Part A: no server needed

These only need the trial and a look at the screens. Stop before saving anything that would
require a working endpoint.

**A1. Trial.** Can you start a Copilot Studio trial or developer environment inside
`helloironwright`? Record how it was offered, the stated length, and anything that says what the
trial cannot do. Specifically note whether the screens mention publishing, and whether any credit
or capacity figure is shown.

**A2. Billing.** Find where capacity or Copilot Credits are shown for the environment. Record the
number available, whether a pay-as-you-go option is offered, and whether using the trial needs an
Azure subscription at any point.

**A3. Adding an MCP tool.** In an agent, find the place that adds a tool and choose the Model
Context Protocol option. Before entering a URL, record every field the dialog asks for and every
authentication choice it offers, using the exact wording. Do not complete the dialog.

**A4. Limits on the connector.** Record any text on those screens about transport, tool or resource
support, tool count limits, or data loss prevention.

## Running the probe server

The probe server is `scripts/copilot-probe/`. It exposes two dummy tools (`get_fruit_stock` and
`celsius_to_fahrenheit`), reads no tenant data, holds no Graph credentials, and binds to loopback
only. Do not point a tunnel at the Ironwright server for these probes, because that server has no
inbound authentication today.

```
node --import tsx scripts/copilot-probe/main.ts > probe-trace.jsonl
```

With no `PROBE_API_KEY` set it generates a key, prints it once to the terminal, and requires it on
every `/mcp` request in the `x-api-key` header. Copy it straight into the Copilot Studio field; do
not paste it into a session. `PROBE_AUTH=bearer` switches to an `Authorization: Bearer` header so
you can try whichever mode Copilot Studio offers (what A3 showed). The server refuses to start
without authentication unless `PROBE_ALLOW_ANONYMOUS=1` is set. The trace file is yours to keep or
share: it holds tool names, argument keys and types, durations and status codes, and never argument
values or the key.

For the tunnel, use Microsoft dev tunnels. The commands below are from memory and unverified, so
check `devtunnel --help` first. Install the CLI (`winget install Microsoft.devtunnel`), sign in
(`devtunnel user login`), then host the port (`devtunnel host -p 8787`). A tunnel that requires a
Microsoft sign-in cannot be reached by Copilot Studio, so it likely needs the anonymous-access
option on the tunnel, which is why the server's own key check matters. The tunnel hostname is a
credential while it is up: keep the tunnel running only during a probe, and stop it afterward.

## Part B: needs the probe server running behind a tunnel

**B1. Tunnel acceptance.** With the probe server behind a dev tunnel, does Copilot Studio accept
the tunnel URL? Record which authentication choices worked and which were refused, with the error
text if short.

**B2. Tool discovery.** After connecting, does Copilot Studio list both dummy tools with their
descriptions and parameter names as the server sent them? Record any difference, including
truncation or renamed fields.

**B3. Orchestration.** Ask the agent three plain-language questions, one that clearly matches the
first dummy tool, one that clearly matches the second, and one that matches neither. Record which
tool it called, whether it asked a clarifying question first, and whether it called any tool at all
for the third.

**B4. Credits.** Note the credit figure before and after the three questions. Record the
difference and how many tool calls the server logged for them.

**B5. Publishing.** Can the agent be tested in the test pane only, or can it be published to a
channel on the trial? Record which.

## Paste-back template

Copy this, fill it in, and paste it into the session.

```
Date:
Environment type shown on screen:
A1 trial:
A2 billing and credits:
A3 fields and auth choices (exact wording):
A4 limits text:
B1 tunnel accepted (yes/no), auth choice used, error text if any:
B2 discovery differences:
B3 questions asked and tools called:
B4 credits before, after, server tool call count:
B5 publish possible (yes/no):
Anything that asked for Azure billing or a subscription:
```
