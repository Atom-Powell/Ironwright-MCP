# Phase 6a: the rename write path

Design spec. Written 2026-09-18, after phase 5a merged and `main` reached `68b4318`.

## What this phase delivers

The first write this server has ever made, end to end, on the simplest mutation there is.

- `generate_rename_plan`, which produces a reviewable persisted plan.
- `execute_rename_plan`, which applies it, with a dry run as the hard default.
- Only the substrate those two need: a Graph write verb with ETag preconditions, and persistence
  for plans and reversal logs.

Deliberately out: moves, `replicate_template`, the `$batch` builder, and `conflictBehavior`. Each
arrives with the caller that exercises it, which is the rule that moved `$batch` out of phase 2 in
the first place.

## Why the slice is vertical

Phase 6 as the parent spec describes it is five tools plus a write substrate. Sliced horizontally,
6a would build a write layer with no caller, which is precisely the shape this project already
rejected once.

Sliced vertically, the first slice proves the whole pattern, plan then review then execute then roll
back, against a real tenant, on the operation with the least that can go wrong. A rename changes one
attribute of one item. A move crosses libraries and goes asynchronous. Doing the harder one first
would put the first mutation this server ever makes in the same review as its most complex failure
surface.

## The substrate

**`GraphClient` gains a PATCH verb carrying `If-Match`.** It is the first mutating call in the
codebase. It uses path addressing, consistent with the Decision Record's ordering, and it takes the
ETag the caller supplies rather than reading one itself, because a verb that fetches its own
precondition has a race inside it.

Three responses matter and must be distinguishable to the caller rather than collapsed: success, a
412 meaning the item changed since the ETag was taken, and a 404 meaning it is no longer there. The
executor reports those differently because an operator acts on them differently.

**`StateStore` gains plan persistence.** The Decision Record has always said Azure Table holds
"plans and reversal logs" and the interface never had them.

One entity type, not two. A reversal log IS a plan, by the Decision Record's own words, so it is
stored as one with a field naming the plan it reverses. Two entity types would let the reversal path
drift from the forward path, which is exactly what storing one prevents.

## What a rename plan is

`generate_rename_plan` runs the reconciliation engine itself. It does not read a stored report,
because phase 4b deliberately declined to persist reports and `reconcile` is the single public entry
for a compliance verdict. Two tools deciding independently what "misnamed" means is the thing that
rule exists to prevent.

It takes the artifacts the engine classifies as `misnamed`, which are files in the correct folder
under an incorrect name, and pairs each with the canonical name the profile's filename template
renders for that slot. A `misplaced` file is a move and is not in this slice.

**The plan stores concrete pairs, not a rule.** Each item carries the library-relative path, the
current name, the target name, and an ETag. This matters more than it looks: because the plan holds
literal names, a profile edited between generating and executing cannot silently retarget it. What a
human reviewed is what gets applied.

**The ETag is fetched at plan time, not read out of the inventory**, and this is the one place this
phase deliberately spends Graph requests. The reasons are concrete rather than stylistic.

The inventory's etag comes from a delta snapshot that may be hours old, so a precondition built on
it refuses any change since the last scan rather than any change since the plan a human just read.
The window this design cares about is generate to execute, and only a plan-time fetch measures it.

The inventory's etag is also recorded as `item.eTag ?? ""`, so it can legitimately be empty, and the
scan command already counts how many files lack one. An empty string is not a usable precondition,
and silently sending no `If-Match` for those items would turn the safest items into the only
unguarded ones. A fresh fetch has no such hole, and a file that returns no etag even then is
excluded from the plan with that as its reason.

The cost is one metadata request per misnamed item, reported in the plan alongside everything else,
and the same request confirms the file is still at that path under that name before a rename is
proposed for it.

Files discovered by the Microsoft Search cross-check always carry an empty etag, because Search does
not return one. They never reach this path: a file in another library is `misplaced`, which is a
move, and moves are not in this slice.

**Two collisions are detected at plan time and excluded with a reason**, because neither can be
resolved without `conflictBehavior`, which this slice does not have. Two misnamed files in one
folder whose canonical names are identical, and a misnamed file whose canonical name is already
taken by a file that is already compliant. Both are reported in the plan as items that will not be
attempted, rather than being discovered as failures during a write.

## Execute

**The dry run is the real code path with the write suppressed.** Not a separate validation pass.
Same preconditions, same per-item decisions, same report shape, with the PATCH call the only thing
not made. A dry run implemented separately is a second implementation of the executor, and the two
disagree only when it matters.

Dry run is the default. Applying for real requires an explicit `confirm`, and that is the second of
two independent conditions.

The first is already built and this phase inherits it rather than adding it. `selectTools` filters
`kind === "write"` out of the registry when the deployment was not started with writes enabled, so
on a read-only deployment `execute_rename_plan` is not published at all and a model cannot see it,
let alone call it. Refusing at the handler would have left the tool advertised.

`generate_rename_plan` is `kind: "plan"` and stays published either way, which is deliberate and
worth stating because it looks like a leak and is not. Generating a plan changes nothing in
SharePoint. A read-only deployment producing a reviewable plan that a write-enabled one later
executes is a useful separation, and it is the shape the plan-then-execute decision was written for.

**Preconditions are per item.** Each rename carries its own `If-Match`. A file touched since
planning fails its own precondition, is reported as skipped with the reason, and every untouched
file still applies. The operator gets a partial result they can re-plan against, and nothing changed
underneath is ever overwritten.

All-or-nothing was considered and rejected. Graph offers no transaction across items, so it could
only ever be a pre-check followed by the same per-item writes, which buys the appearance of atomicity
without the substance while letting one unrelated edit block hundreds of correct renames.

**The reversal log is written before any write and is itself a valid plan**, per the Decision Record.
Written up front it necessarily over-covers: it lists inverses for renames that may not have
happened. That self-corrects through the same machinery, because replaying it finds no file at the
source path and reports nothing to do, exactly like any other skipped item. Durability through a
crash mid-apply is the property being bought, and it is worth the over-coverage.

**Each reversal item's ETag is refreshed the moment its rename succeeds.** This is the part of the
reversal design that is easy to get wrong and silently useless. A rename changes the item's etag, so
the etag captured before the rename is stale for the inverse operation. A reversal log written up
front and never touched again would therefore have every one of its items refused on its own
precondition, and the rollback that this phase exists to prove would report a clean run having
changed nothing.

So the log is written before the first write, for durability, and each entry is corrected as its
rename lands. The crash window that remains is between a successful PATCH and its log update, and it
fails in the safe direction: that entry keeps a stale etag, replaying it refuses that one item, and
the operator sees it named as a skip rather than having a change silently reverted or clobbered.

Where the fresh etag comes from is a question this project does not get to assume. Graph's documented
response to a `driveItem` PATCH is the updated item, which would carry it at no extra request. If a
live call shows otherwise, the fallback is the same metadata GET the generator already makes. Which
one applies is settled by calling it, not by reading about it, and the answer belongs in the plan
before the code is written.

A dry run writes no reversal log, because it changes nothing to reverse.

## What the report says

Applied items, and skipped items each carrying which of four reasons applied:

- the item changed since the plan was generated, so its `If-Match` was refused;
- the item is no longer at that path;
- Graph refused the write for some other reason, which this server cannot interpret and does not
  try to;
- the item was excluded when the plan was generated, for one of the two name collisions or for
  having no usable ETag.

Plus the reversal plan id when one was written, and the Graph cost of this call.

**Amended 2026-09-18 while writing the implementation plan.** This section named three reasons and
had not contemplated the third above. Only a 412 and a 404 are outcomes the executor can read; every
other Graph failure is one it cannot, and folding those into either named reason would tell an
operator something this server did not observe. Such a failure is recorded against its own item and
the run continues, rather than ending the call, because abandoning it would discard the report, which
is the operator's only account of which renames already applied.

The third reason is decided at plan time and reported at execute time, rather than only appearing in
the plan. An operator reading an execution report should not have to hold the plan open beside it to
learn why a file they expected to be renamed was not.

Counts are computed over the complete set before any truncation and reported exactly, as everywhere
else in this server.

## Sequential, not batched

Renames are issued one at a time and the report says how many requests that cost.

`$batch` is the obvious optimization and this phase does not build it. The sandbox holds a handful of
misnamed files, so batching would be an untested complexity added for an unmeasured benefit, landing
per-sub-request preconditions and partial batch failures in the same review as the first mutation
this server has ever made. The measured request count from the live sitting is what should decide
when it arrives, and a real number will be available afterward rather than an estimate.

## Verification before merge

Different in kind from every sitting this project has run. Those were reads; a wrong read is
embarrassing. This writes to a real SharePoint library.

The sitting runs the whole loop on the sandbox tenant:

1. Generate a plan and read it.
2. Dry run it and confirm the report names exactly the files the plan does.
3. Execute it for real and confirm the files actually renamed in SharePoint.
4. **Roll back through the reversal log and confirm the library is exactly where it started.**
5. Deliberately edit one file between generating and executing, and confirm that item alone is
   refused on its precondition while the others still apply.

Step 4 is not a bonus. A write capability whose undo has never run is a write capability nobody
should trust, and the reversal log being a valid plan is only true if a real execution has consumed
one.

Step 5 exercises the ETag refusal against a real 412 rather than against a fixture, which is the
same reasoning that made earlier phases probe an API before designing for it.

## What 6b and 6c inherit

- `generate_move_plan` and `execute_move_plan`, including async cross-library polling, and the
  cross-field input constraint that phase 4c's contract test forbids expressing as a schema
  refinement. Two routes are recorded in `docs/OPEN-ITEMS.md`.
- `replicate_template`, which validates its source client internally before replicating.
- `$batch` and `conflictBehavior`, each with a measured reason to exist.
