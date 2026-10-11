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

## Part B: needs the probe server

Part B waits on a throwaway probe server that exposes two dummy tools and reads no tenant data, so
that the tunnel never fronts anything real. It does not exist yet; the spec lists it as the first
build item. Do not point a tunnel at the Ironwright server for these probes, because that server has
no inbound authentication today.

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
