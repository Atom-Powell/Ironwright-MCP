# The assessment journal, kept in a SharePoint list

Written 2026-11-18, after the operator chose to keep the journal in a SharePoint list on each
workflow's own site (option A of three). Where this stands is in the status table at the top of
`docs/OPEN-ITEMS.md`.

## Purpose

Every lifecycle write is journaled: the stage, the operation, the target, the ETags before and
after, the content hash, the time and the correlation id. `get_assessment` reads the journal back,
and it is what an auditor is shown. Today it lives in the state store, which is in memory unless an
Azure table is configured. The night of 2026-11-18 showed what that costs: a Service Desk incident
was opened and its timeline saved, the server was restarted, and the incident's journal then held
only the writes made after the restart. The record of who opened the case was gone.

The hosting decision rules out the obvious remedy. An Azure table needs an Azure subscription, and
the operator's rule is no Azure spend. A file on the server's machine survives a restart but not a
replaced container, and no one at the customer can read it. A SharePoint list on the workflow's
own site needs nothing new hosted or paid for, survives anything short of deleting the site, and
sits beside the records it describes, where the customer's administrators can open it.

## The choices made, and the one that waits

These were decided under the operator's standing instruction to act on recommendations and ask
only where an answer is truly needed. Each can be overruled.

- **A fourth list per workflow, named in the profile.** An assessment profile gains
  `lists.journal`, with a name and a column map like the other three. When a profile names it, the
  journal is kept there. When it does not, the journal is kept in the state store as today, so
  every existing profile, the simulator and the sittings keep working unchanged.
- **One list item per journal entry.** Columns: the assessment id, the time, the correlation id,
  the stage, the operation, the target, ETag before, ETag after, the content hash, the prior content
  hash and the version id. The item's title is a one line summary, for example
  "INC-2026-00002 CONTAINMENT file_created", so the list reads sensibly in the browser.
- **The target is a multi line text column.** A library path can pass the 255 characters a single
  line text column holds. The target is never filtered on, so it does not need an index.
- **The assessment id column is indexed and filtered on.** `get_assessment` reads one assessment's
  journal by filtering on it. The order stays the store's contract, by time then correlation id,
  sorted after reading rather than asked of Graph.
- **Append semantics do not change.** An entry is created after Graph confirms the write it
  records, never before. A journal create that fails after a confirmed write raises the same
  `JournalAppendError`, naming the write that stands. A retry of an ambiguous create can leave a
  duplicate entry, as the table store can today; a duplicate is visible and harmless, a missing
  entry is neither.
- **Journal entries are not themselves journaled.** The journal list is written only by the
  journal.
- **The cost is one Graph request per journaled write.** `open_assessment` journals about seven
  writes, so it costs about seven more requests. Every tool already reports its Graph request count,
  so the cost is measured, not guessed.
- **`npm run department:setup` creates the journal list** with the others, from the profile, and
  checks its columns the same way.

**The one that waits, for the operator: who may edit the journal.** A list inherits the site's
permissions, so anyone who can edit the site can edit or delete a journal entry. SharePoint keeps
a version history of every list item and the Microsoft 365 audit log records the edit, so an
alteration is visible, but it is not prevented. Three ways to go:

1. **Leave it inheriting, and say so.** Version history and the audit log are the control. Nothing
   to build.
2. **An operator step at setup:** stop inheriting on the journal list and give site members read
   only. The server keeps write through its own grant. Documented in the runbook, done by hand once
   per site. **Recommended**, because it costs one setup step and needs no new permission.
3. **A hash chain:** each entry carries the hash of the entry before it, so any edit breaks the
   chain and `get_assessment` can say so. Costs a read before every append and real complexity.
   Worth it if an auditor asks for tamper evidence inside the record itself.

The design below works under all three; only the runbook and the setup step differ.

## Design

- **Profile schema.** `lists.journal` is optional: `{ name, columns: { assessmentId, at,
  correlationId, stage, operation, target, etagBefore, etagAfter, contentHash, priorContentHash,
  versionId } }`. The same rules the other lists follow apply: no list name used twice, column names
  from the same pattern. The example profiles gain it.
- **A journal sink chosen per profile.** `appendJournal` and `get_assessment`'s read go through one
  function that picks the list when the profile names one and the store otherwise. The store's
  journal methods stay, unchanged, for profiles without a list.
- **Writing an entry.** `createListItem` on the journal list with the mapped columns. The entry's
  shape is the store's `JournalEntry`, unchanged.
- **Reading entries.** `queryListItems` filtered on the assessment id column, each item checked
  against `JournalEntrySchema` as the table store checks its rows, so an entry that cannot be read is
  refused rather than skipped. A journal missing an entry reads as a complete record, which is the
  failure this project rates highest.
- **Entries before an id exists** keep the keys they have today, `(vendor)` and `(unassigned)`, in
  the assessment id column.
- **Setup.** `listDefinitionsFor` adds the journal list, with the assessment id column created
  indexed. `ensureLists` checks its columns like the others.

## Assumptions

| Assumption | Why the design needs it | Evidence |
|---|---|---|
| The server application can create items in a fourth list on a site it holds write on | Every journal entry is a list item create | The same operation the findings list takes, live since 2026-11-08 and again on 2026-11-18. Not yet run against a list holding eleven text columns, one of them multi line: the probe below covers it |
| A column created through Graph with `indexed: true` is indexed, so a filter on it needs no non-indexed header | The journal read filters on the assessment id | **Not measured.** The column definition carries an `indexed` property; this project has never set it. Probe J2 |
| A multi line text column takes a value longer than 255 characters and returns it whole | The target is a library path | **Not measured** for a list item field. Probe J3 |
| A filter on one assessment's id returns only its entries, across pages | The read is per assessment | The filter and paging are the ones the findings read already uses, live. Probe J4 runs it on the journal list with more than one page |
| The grant issuer can create the journal list with these columns | `department:setup` creates it | List creation with column definitions is the one the third sitting ran on 2026-11-18, implied and not recorded. Probe J1 creates and reads back this exact list |

No plan task is written until the probe has run and this table is amended with what it returned.

## The probe

A script under `scripts/assessment-probe/`, run in a write session against one department site,
recorded to `docs/superpowers/specs/evidence/` like the earlier probes:

- **J1.** Create the journal list from the profile's definition under the grant issuer; read its
  columns back.
- **J2.** Read the assessment id column's definition back and record whether `indexed` is true;
  then filter on it without the non-indexed header and record the status.
- **J3.** Create one entry whose target is 400 characters; read it back and compare.
- **J4.** Create 60 entries for one id and 3 for another; filter on the first id and count, across
  pages.
- **J5.** As the server application, not the grant issuer: create one entry, and record the status.

The probe leaves its list behind for the operator to inspect, named so it cannot be mistaken for a
real journal, and says so at the end.

## Not established

Everything above is a design. Nothing is built and nothing has been probed.
