# Profile defined lifecycles, and what a managed service provider can ask of this server

Written 2026-11-17, after the operator said the pilot should cover as many needs of a managed
service provider as the server can, and asked that the recommendations be acted on without
further questions except where one truly needed an answer. This document records what was
decided on that authority, what was built on it, and what still waits. Where each part stands is
in the status table at the top of `docs/OPEN-ITEMS.md`.

## Purpose

The pilot's first consumer is a vendor risk agent at a managed service provider. Vendor risk is one
of many kinds of record such a business keeps. The others it keeps in SharePoint have the same
shape: a client onboarding, an offboarding, a security incident, an audit or insurance evidence
pack, a quarterly review. Each is a case in a list, a folder for it, documents saved into the
folder, issues found, a status that should move only when the evidence is there, and a record of
who wrote what.

The assessment module already runs that shape. It ran it for one workflow because the code held
that workflow's vocabulary. This design moves the vocabulary into the profile, so the seven tools
run any workflow of that shape with no tool added per workflow.

## The line that does not move

The server's application holds `Sites.Selected` and nothing else, and refuses any token that
carries more. It reads and writes files and list items in the sites it is granted. It does not
administer users, licenses, devices or mailboxes, and it does not integrate with a ticketing or
remote management product, because each needs a permission the Decision Record refuses. "As many
needs as possible" is read inside that line: the record keeping side of a service provider, not
tenant administration. Nothing here weakens the line.

## Three moves, and their order

1. **A profile defines the workflow.** Built with this document. It needs no new behavior from
   Graph, so nothing blocks it.
2. **One server, one site per client.** A profile already carries a list of sites and the
   assessment profile is held to one. Lifting that touches the startup check against the granted
   site, the grant issuer, and the paths, and it rests on an assumption no probe has made: one
   application holding grants on two sites. It is the multi-site work already scheduled as the
   phase after 9, and a service provider is now its second consumer beside the accounting
   practice it was scheduled for. Not built here.
3. **Recurring deliverables per client.** The compliance module already answers what should
   exist for each client in a period and whether it does, for one site, from a tracking workbook.
   Across clients that each have a site, it waits on move 2. Nothing to build until then.

Move 1 comes first because it is the only one that can be built and proven with no tenant, and
because a pilot on one operations site, with a folder per client, gets every workflow below from
it alone.

## Amendment, 2026-11-17: the sites are departments

The operator settled what move 2 has to be for the pilot: the consumer keeps a SharePoint site per
department, not per client. That makes it smaller than the move described above. A profile
already addresses one site, and a department's workflow is one profile, so a site per department
is a profile per site. No tool takes a new argument and no case has to say which site it belongs
to: the profile id already does.

What stood in the way was only the server's startup rule, which took one granted site and refused
a profile on any other. `IW_SITE_URL` now lists every site the application is granted, and a
profile's site must be among them. Nothing else in the server changed.

A site per client, where one workflow spans many sites, is a different problem and is not
solved by this: there a case would have to name its site. It is left where it was, for the
consumer that needs it.

The sitting runner stands each department up and runs it: for every other assessment profile in
the profiles folder it grants the server application on that profile's site, creates the three
lists the profile names where they are absent, checks each list has the columns the profile maps,
and takes one case from open to completed through the running server by the profile's own gates.

## What a profile now says

Three settings under `lifecycle`, each optional:

- `gates`: which artifact kinds must be present before each stage. `findings` gates
  `record_findings`, `provisional` gates a transition to the provisional status, and `completed`
  gates completion. `findings` and `provisional` may be empty. `completed` names at least one
  kind, because a completion verified against nothing is what this module exists to prevent.
- `external`: the kinds produced outside the server, by a person or a publisher.
  `save_assessment_artifact` refuses them and `verify_publication` reads them. May be empty.
- `corrected`: the kinds whose overwrite is recorded as the stage `CORRECTION`. May be empty.

A profile that sets none of them gets the vendor risk workflow, exactly as before: findings and
provisional wait on `dossier`, completion on `dossier` and `publication`, `publication` is
external, and an overwritten `dossier` is a correction. The defaults are stated once, in the
schema, and nowhere in the tools.

The schema refuses a kind named in any of the three that `workspace.artifacts` does not define,
and a kind listed as both corrected and external. `dossier` and `publication` are no longer
required of every profile; they are required of one that leaves the gates at their defaults,
and the message says so.

`verify_publication` takes an optional `kind`. With one external kind, which is the default,
nothing is named and every existing call is unchanged. With several, the caller names one. With
none, the tool says there is nothing to check.

## What was decided without asking, and can be overruled

- **No tool is renamed and no input field is renamed.** An assessment is this product's word for
  one governed case, and `vendor` is its word for the party the case is about, which for a
  service provider is usually a client. Renaming either would break the pilot agent's
  instructions for the sake of a word. If the operator wants neutral names, that is a naming
  decision and theirs.
- **The findings list keeps its four fields.** Key, observation, risk and recommendation serve an
  onboarding issue and an incident finding as well as a risk finding. The column names are
  already the profile's.
- **Stage names stay derived.** A kind's stage is its name in upper case.
- **Two example profiles ship**, a client onboarding and a security incident record, beside the
  vendor risk example. They are examples of the shape, not a claim about how any provider works.
- **The provisional status is still entered only from in progress, and a save and a findings call
  still refuse a provisional assessment.** That was the edge of an earlier ruling and this change
  does not move it. It matters more now: in the onboarding example, "Awaiting Handover" is a
  provisional status in which nothing more can be saved.

## Assumptions

| Assumption | Why the design needs it | Evidence |
|---|---|---|
| A profile that sets no gates behaves as it did | The pilot's vendor risk profile must not change under it | The module's existing tests run unchanged against the example profile, which sets none, and a test pins the defaults |
| The seven tools need nothing from Graph they did not need before | Otherwise a probe would come first | Every Graph request in the change is one the 2026-11-07 probe, the sittings and the campaign have sent; the change adds none and only chooses which artifact paths a precondition reads |
| A workflow with other lists, kinds and gates runs end to end | The claim of this design | A client onboarding run through the real tool handlers over the simulated tenant, from open to completed, under the shipped example profile |
| A list created through Graph carries the column names asked for | A department's lists are created from its profile, and the tools write to those names | Not measured for the names the two service provider examples use. The runner reads each list's columns back and refuses in words when one is missing, so a renamed column is a clear failure and not a wrong write |
| One application can hold grants on several sites and the server can address each | Move 2 | Confirmed live in the second sitting of 2026-11-17 for two sites: 403 `accessDenied` on the second site before its grant; a grant created with the setup command's request; then a folder and a file written and the file read back under the same server token; the first site still resolving. Recorded in `evidence/2026-11-17-second-sitting/`. What it does not cover is a list on the second site, or any tool addressing it |

## Not established

Nothing in this change has run against a tenant. The simulated tenant shows the server's steps
compose under another profile; what Graph does was measured only for the paths the vendor risk
profile takes, which are the same requests. A live run under a second profile needs three more
lists in the developer site, which is an operator step.
