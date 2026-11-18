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

Also record whether the dialog can send more than one custom header with a fixed value. Cloudflare Access service tokens need two (`CF-Access-Client-Id` and `CF-Access-Client-Secret`), and whether that is possible decides whether Access is documented as optional hardening or left out.

**A4. Limits on the connector.** Record any text on those screens about transport, tool or resource
support, tool count limits, or data loss prevention.

## Findings so far, 2026-11-09 (blocked on a license; most of this is documentation, not observation)

The live probe stopped early. On the Ironwright Dev environment, with Dataverse present, creating
a standard agent was refused: "Creating a standard agent requires a Copilot Studio license."
Environment creation had first failed for lack of Dataverse, which the new environment fixed. The
only trial offered in the Microsoft 365 admin flow was Microsoft 365 Business Premium with
Copilot, which needs a credit card, converts to a paid plan on 12/9/2026 and names no Copilot
Studio capability, so it was declined. The Copilot Studio product page offered only a free Azure
account, which the no-Azure rule excludes. Parts A1 and A2 are therefore answered as "no
license without a card or Azure", and Parts A3, A4 and B stay open for a live run.

What Microsoft's page "Connect your agent to an existing MCP server" (updated 2026-11-02) says,
labeled as documentation and not observed on a screen:

- **A3, the add-tool dialog.** Tools, Add a tool, New tool, Model Context Protocol. Fields are
  Server name, Server description and Server URL. Authentication choices are None, API key and
  OAuth 2.0. API key takes a Type of Header or Query and the name of that header or parameter.
  OAuth 2.0 takes a type of Dynamic discovery, Dynamic or Manual; Manual asks for client ID,
  client secret, authorization URL, token URL template, refresh URL and optional scopes.
- **Headers.** No plain bearer choice is listed. Sending two fixed custom headers is not
  described, so a Cloudflare Access service token (two headers) probably cannot be used through
  the wizard. A Power Apps custom connector might allow it; unconfirmed.
- **A4, limits.** Only the Streamable transport is supported; SSE has not been since August 2025.
  MCP access rides on Power Platform connectors, so a data policy that governs connectors also
  governs the MCP server and its tools. No tool count limit or credit figure appears on the page.
  A secondary source says generative orchestration must be on.
- **Other path.** A server can also be registered through Agents 365 and the Microsoft 365 admin
  center, then approved for use in Copilot Studio. Worth reading before an approval request.

Planning consequence for plan 9d: assume an API key in a single header, assume no Cloudflare
Access layer, and treat the data policy question as a likely approval item.

## Observed on screen, 2026-11-18: the license is there, and A1 and A3 are answered

Everything in this section was seen on a screen in the developer tenant on 2026-11-18, signed in as
its Global Administrator. Labels are copied as the screen showed them. Where a label was read off a
small screenshot and could be slightly off, it says so. Copilot Studio's interface changes often,
so a later reader should treat paths as hints and the dates as what matters.

### A1: getting in

- **No trial was taken.** The sign-up link on Microsoft Learn's "Get access to Copilot Studio" page
  (`learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-licensing-subscriptions`,
  section "Sign up for a Copilot Studio trial", the link "sign-up page") opened
  `signup.microsoft.com` already signed in, and answered: "You already have a license for Microsoft
  Copilot Studio." No card, no Azure subscription and no terms screen were asked for. Its one
  button, "Get Started", opened Copilot Studio. Where the license came from was not checked; the
  9 November refusal said a license was missing, so something changed in between.
- **Use the Learn page's link, not the product page.** The product page offers a free Azure
  account, which the no-Azure rule excludes. That was the dead end of 9 November.

### Environments

- Copilot Studio opened in an environment named **Admin**, type **Developer**: a personal developer
  environment it made for the account. Do not build there.
- The switcher is the **environment button at the bottom of the left rail** (its tooltip reads
  "Switch environment (current: ...)"). It has a search box, a filter by environment type, and
  groups: **Current environment**, **Pinned**, **Recently used**, and **All environments**.
- Environments seen: **Admin** (Developer), **Default Directory (default)** (Default, pinned), and
  **Ironwright Dev** (Developer). **Ironwright Dev** is the one to use: it is the environment made
  on 9 November, with Dataverse.

### Home

- Greeting "Hey Admin, ready to ...", a banner "Welcome to the new Copilot Studio. Build smarter
  processes with credit-powered capabilities."
- Three tiles: **Agent** ("Create an agent to take actions and answer questions"), **Workflow**
  ("Automate multi-step processes with triggers, actions ..."), **App (preview)** ("Build a custom
  app with screens, data, and logic").
- Below them, **Explore what else is possible with agents** ("Build a standard agent, create an
  agent flow, or create a Customer Conversation agent"). It opens a page with:
  - **Customer conversation agent**, marked **Uses Copilot Credits**.
  - Under "Build with standard orchestration": **Agent** (Standard), "Create a rule-based
    conversational agent with predefined tools and flows", and **Agent flows** (Standard),
    "Automate a multi-step process with steps you define". Their hidden help text reads "This agent
    uses standard orchestration. Included with your ..." (cut off).
- **A transient refusal.** The first time, both standard options were disabled with "Can't check
  the license for this build option. Select Try again to check it." **Try again** cleared it at
  once. Someone meeting this for the first time should not read it as a missing license.
- The left rail on Home: Home, Agents, Workflows, Apps (Preview), and at the bottom the environment
  switcher and the account menu.

### Creating an agent

- Choosing **Agent** (Standard) opens **Name your agent**: one required field, "Name is required to
  create a new agent", a collapsed **Agent settings (Optional)**, and **Create** / **Cancel**.
- The agent made: **Ironwright probe**, in Ironwright Dev, on 2026-11-18. It took about ten seconds
  to provision. While it did, a banner read "This feature isn't available until your agent has
  finished setting up."

### The agent's page

- **Top tabs:** Overview, Knowledge, Tools, Agents, Topics, Activity, Evaluation, Monitor, Channels.
  Top right: a search icon, **Publish** (disabled on this license), **Settings**, a "more" menu,
  and a **Test** button.
- **Overview, top to bottom:** "Select your agent's model" (a dropdown; the model's label was read as
  a GPT "Chat Latest" option dated November 2025, small text, unconfirmed), **Instructions** with
  **Edit**, **Knowledge** with **Add knowledge**, **Web Search** ("Enable your agent to search all
  public websites"), **Tools** with **Add tool**, **Triggers** with **Add trigger**, **Agents**
  ("Connect your agent with another agent, dedicated to handling steps of your workflow") with
  **Add agent**, **Topics** with **Add topic**, and **Suggested prompts**.
- **Test your agent** is a pane on the right. It opened with "Hello, I'm Ironwright probe. How can I
  help?" and has a chat mode toggle. Its footer: "You're testing your agent's real responses and
  capabilities." This pane is where tool calls can be tried without publishing.

### A3: the Add tool dialog

- **Path:** the agent's Overview, **Tools**, **Add tool**. (The Tools tab at the top has its own.)
- The dialog is titled **Add tool**, "Let your agent do more", with a search box.
- **Create new:** **Agent flow**, **Prompt**, **Model Context Protocol**, **Computer use**, and
  **See all**.
- Filter chips: **All**, **Connector**, **Prompt**, **Flow**, and a **REST API** chip (read off a
  small screenshot).
- Connectors on the first page included Office 365 Outlook, Microsoft Teams, Excel Online
  (Business), SharePoint, Microsoft Dataverse, Office 365 Users, OneDrive for Business and Planner,
  with a few more below (ServiceNow and Azure DevOps among them, read off a small screenshot). The
  first-party **SharePoint** connector sits right beside where this server would be added, which is
  the comparison a reviewer will make.
- **Model Context Protocol** opens **Add a Model Context Protocol server**:
  - **Server name** (required)
  - **Server description** (required), "Describes the purpose of the server"
  - **Server URL** (required), placeholder "Streamable endpoint", with the note "Enter the complete
    server path to continue"
  - **Authentication**: **None**, **API key**, **OAuth 2.0**
  - With **API key**: **Type**, either **Header** or **Query**, then **Header name** (required)
  - **Create** stays disabled until the required fields are filled. **Back** returns to Add tool.
- **What this settles.** Copilot Studio can send a key in one header whose name we choose. The
  server's inbound key mode reads a key from a configured header, so it fits with no server change.
  There is still no "bearer" choice, and no way seen to send a second fixed header.
- Nothing was saved. The agent has no tools yet.

### Still open from Part A

- **A2.** Where credits are shown was not looked for. The Customer conversation agent is labeled as
  using Copilot Credits; the standard agent made here is not.
- **A4.** No text about transport, tool limits or data policy was seen on these screens beyond
  "Streamable endpoint".
- **B5 is answered in part:** **Publish** is disabled for this agent, which matches Microsoft's
  statement that a trial license allows testing in the test pane but not publishing.

## Observed on screen, 2026-11-18: Part B, and the real server's first call

The same afternoon, the same agent (**Ironwright probe**, environment Ironwright Dev). Observed in
the browser and in the probe server's trace, which records method names, argument shapes, status
codes and user agents, never values or keys.

### The ingress

- **Cloudflare Tunnel on the operator's own domain.** `cloudflared` 2026.11.1, installed with
  `winget install Cloudflare.cloudflared`. `cloudflared tunnel login` opens a page titled
  "Authorize Cloudflare Tunnel", "Cloudflare Tunnel wishes to serve as an origin on one of your
  zones"; choosing the zone opens "Authorize Tunnel for <zone>" with **Authorize** / **Cancel**, and
  the origin certificate lands in `%USERPROFILE%\.cloudflared\cert.pem`. Then
  `cloudflared tunnel create ironwright-mcp-dev`, `cloudflared tunnel route dns ironwright-mcp-dev
  mcp-dev.ironwright.dev` (it adds the CNAME itself), and
  `cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8787 ironwright-mcp-dev`. Four
  "Registered tunnel connection" lines mean it is up.
- With nothing listening on the port, the hostname answers **502**; with no tunnel running, **530**.
  Both were seen, and the second is what Copilot Studio met first (below).
- **Run the tunnel in its own terminal window.** A tunnel started from an agent session's
  background shell was stopped by that host under memory pressure, which took the endpoint down
  with no sign in Copilot Studio beyond a failed request.

### B1: the URL is accepted

- **Add tool, Model Context Protocol**, with Server URL `https://mcp-dev.ironwright.dev/mcp`,
  authentication **API key**, type **Header**, header name `x-api-key`. **Create** turned the server
  into a tool card named after the server, with its description, a **Connection** field reading
  "Not connected", and **Add and configure** disabled until a connection exists.
- The connection is where the key goes: the arrow beside **Not connected**, **Create new
  connection**, paste the key, **Create**. A connection holds one key, so a new server with a new key
  needs a **new** connection, not the old one.
- A Cloudflare hostname on an owned domain is accepted as given. B1 is answered.

### B2: discovery

- Adding the tool made no request at all. The tool's page (the tool's name under **Tools** on the
  Overview) showed "Connector request failed. Couldn't retrieve the requested items" under both
  **Tools** and **Resources** while the tunnel was down. The **refresh** icon beside the Tools table's
  "Description" heading asks again.
- Once the tunnel was up, both probe tools were listed with their descriptions as sent, each with
  its own toggle, and the table's master toggle on. **Resources** stayed in error: the probe server
  offers none, and Copilot Studio shows an error rather than an empty list. The real server offers
  none either, so the same error will show there and means nothing.
- The tool's page also has **Details** (name, server, connection, "Available to"), **Inputs**
  ("Optional inputs are available to add"), **Tools** and **Resources**, an **Enabled** switch and
  **Save** at the top, and a tool selector next to the tool's name for moving between tools.
- **What Copilot Studio sends.** Every request after the key was set carried user agent
  `CopilotStudio` and the key. Two requests before it had a browser user agent and no key, and the
  server answered both 401. Each use opens a fresh exchange (`initialize`,
  `notifications/initialized`, `tools/list`, then `tools/call`) with no session carried between
  calls, which matches this server's stateless design.

### B3: orchestration

| Asked in the test pane | Answer | Tool called |
|---|---|---|
| How many apples do we have in stock? | "We currently have 42 apples in stock at the main warehouse." | `get_fruit_stock`, sent `fruit` only; the server's schema supplied the default `warehouse` |
| What is 30 degrees Celsius in Fahrenheit? | "30°C (Celsius) is equal to 86°F (Fahrenheit)." | `celsius_to_fahrenheit`, sent `celsius` as a number |
| Who won the 1998 World Cup? | France, with the score and scorers | none; Web Search was on for the agent |

- The test pane's activity view shows each step ("Executing tool action", "Processing tool result",
  "Generated result") with the tool's **content** and **structuredContent** both visible, and an
  **Execution summary** quoting the tool's description in full and the time taken. The probe tool's
  description ends with a sentence that says it arrived untruncated, and it did.
- Copilot Studio prefixes the tool's text content with a citation marker of the form
  `[CIT:<guid>]`. It is harmless and worth knowing when reading the activity view.

### The real server

- The probe server was stopped and the real server started on the same port, behind the same
  hostname, with all four local profiles, the inbound key in `x-api-key`, and writes off. It was
  added as a second tool, **Ironwright MCP**, with a new connection; the probe tool was switched off
  (its page, **Enabled** off, **Save**; the page then says "This tool has been turned off, and you
  won't be able to test it").
- Copilot Studio listed the server's tools with their descriptions, `describe_assessment_workflow`
  among them.
- **A connection must also be confirmed for the test session.** The first question was answered with
  "Let's get you connected first, and then I can find that info for you. Open connection manager to
  verify your credentials. Once the connection is ready, retry your request." with **Retry** and
  **Cancel**. **Open connection manager** opens a user connections page in a new tab; after connecting
  there, **Retry** ran the call. An administrator setting this up for a department will meet the same
  step.
- **"What assessment workflows does this server offer?"** called `describe_assessment_workflow`,
  completed in 0.53 s, and the agent described all four workflows correctly: each site, what the
  server saves, the external document, the statuses, the dispositions, the risk levels and what
  completion waits on. Its closing overview of "available operations" was its own reading of the tool
  descriptions, not a call.
- **A refusal reached the agent intact.** "List the vendor risk assessments that are in progress for
  Technology Success" called `get_assessment` with `status` "In Progress". The server answered with
  `isError: true` and its own words, "Acquiring a Microsoft Graph token failed with 401. This is about
  the server application's own client id and secret rather than about the site, the profile, or
  whoever asked the question." The agent relayed exactly that: a credential problem with the server
  application, not the user's permissions, and said it could not confirm how many assessments there
  were rather than guessing. That answers the carried question of what Copilot Studio does with an
  error result: it shows the prose to the agent, and the agent used it. The cause was the client
  secret entered when the server was started, not the site or the grant; the sitting of the same
  morning had used the same application successfully.

### The first read that reached SharePoint, and what it cost to get there

- **The read.** "Use the Ironwright MCP tool to list the assessments with status In Progress for
  profile technology-success-vendor-risk" called `get_assessment`; the server read the Technology
  Success site's Assessments list in 3 Graph requests and answered "No item in list Assessments has
  Status In Progress", which was true. The follow-up "Now show me the completed ones for that
  profile, with their vendor, disposition and risk" carried the profile from the turn before and
  returned the one case the sitting of the same morning had completed: ASM-2026-00001, vendor
  "Pilot Check 1118T1714", disposition Approved, risk Low, scope Pilot. Real list data, read through
  Copilot Studio, matching what the sitting wrote.
- **A connection with the wrong key fails at `initialize`, and the agent can hide it.** Before the
  connection held the right key, every call failed with `"HttpStatusCode":"unauthorized"`,
  `"mcpMethod":"initialize"`, visible only in the activity view as an Execution summary ending
  "The tool action completed with status Failed". With **Web Search** on and no instructions, the
  agent then searched the public web and answered "I couldn't locate any matching assessment
  records", which reads as an empty result and is not one. Asked to use the tool by name, it said
  instead "The Ironwright MCP tool is not available in this session". For a governed deployment:
  turn Web Search off on an agent whose answers must come from the server, and give it instructions
  that say to report a tool failure as a failure.
- **The inbound key is the thing to manage, and it cost most of an hour.** The start script made a
  new key at every start, the operator copied keys between windows, a probe key was pasted as a
  client secret, and a connection ended up holding a key the running server did not use. What
  settled it: one key, kept in a password manager and pasted at every start; the script printing
  the key's last four characters at every start; and a local check that takes a pasted key and
  reports whether the running server accepts it, printing only its length and last four characters.
  A customer deployment needs the same three things written into its runbook.
- **The test pane has its own session.** **New test session** (top of the test pane) starts a fresh
  one; the connection a session uses is set in the connection manager (**Manage your connections**,
  one row per tool with **Manage**, which opens **Create or pick a connection**).

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

**B1. Tunnel acceptance.** Does Copilot Studio accept the server URL as given, for a dev tunnel hostname and for a hostname on an owned domain fronted by Cloudflare Tunnel? Record any validation message either produces. Also record which authentication choices worked and which were refused, with the error text if short.

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
