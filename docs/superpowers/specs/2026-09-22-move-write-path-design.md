# Phase 6b-1: the same-library move write path

Design spec. Written 2026-09-22, after phase 6a merged and `main` reached `5deae67`.

## What this phase delivers

`generate_move_plan` and `execute_move_plan`, for files the reconciliation engine finds filed in the
wrong folder of the profile's own document library, plus only the substrate those two need.

- A move plan covers `misplaced` and `misnamed_and_misplaced` findings. The second is corrected by
  one PATCH that changes the folder and the name together, not by a move followed by a rename.
- The rename write path from phase 6a is generalized rather than duplicated: one Graph verb, one
  executor, one stored plan entity, with a rename being a move that keeps its folder.

Deliberately out, each arriving with the caller that exercises it:

- **Cross-library moves.** That is phase 6b-2, which begins with a live probe of how Graph moves an
  item across drives. Whether that is a native PATCH or an asynchronous `/copy` followed by a delete
  decides whether a moved file keeps its item id and version history and what its reversal even is,
  so no design for it is written until that call has been made.
- **Folder creation.** A move whose target folder does not exist is excluded, not preceded by a
  create. Creating a folder makes its reversal a delete, and a delete does not belong in the same
  slice as the first move. `replicate_template` is the plausible first caller for folder creation.
- **Deleting a source folder a move leaves empty.** The existing empty-folder finding reports it.
- **`$batch`.** Moves are issued sequentially, as renames are. Phase 6a measured one Graph operation
  per write, and nothing in this slice changes the arithmetic that deferred batching.

## Why split 6b

The parent spec describes `execute_move_plan` as "async cross-library moves polled to a terminal
state". That is one tool over two operations with very different risk. A same-library move is a
synchronous PATCH on the same item, reversible by another PATCH, and it reuses nearly all of 6a. A
cross-library move is an API surface this project has never called, and the rule adopted after
phase 2b-1 is that such a surface gets the cheapest possible live probe before any design assumes
its behavior. Splitting keeps the slice vertical, the same reasoning that put rename ahead of move,
and lets 6b-1 be designed now without guessing.

## Input

`generate_move_plan` takes `profileId` and an optional `clients` array, identical to
`generate_rename_plan`. The stub's `scope` and `scopeValue` are dropped.

This closes the `docs/OPEN-ITEMS.md` entry "Before a write tool needs a cross-field constraint". That
entry existed because `scopeValue` had to be present when `scope` was `client` or `deliverable`, and
the installed SDK cannot advertise a refined schema. Two independent optional fields need no
cross-field rule, and the two plan generators now agree on what narrowing a plan means. Narrowing by
deliverable is not offered because no caller has asked for it.

`execute_move_plan` takes `profileId`, `planId` and `confirm`, identical to `execute_rename_plan`.

## What a move plan is

`generate_move_plan` runs `reconcile()` itself, for the reason 6a gave: `reconcile` is the single
public entry for a compliance verdict, and two tools deciding independently what "misplaced" means is
what that rule prevents.

It takes the **winning** artifact findings whose state is `misplaced` or `misnamed_and_misplaced`.
Every other file matching a slot is already a `DuplicateFinding`, demoted by `matchArtifacts`, and is
never moved. That is the engine's own resolution, not a new rule. Each candidate's target is the
rendered `expectedPath` folder joined with `expectedName`.

The plan stores concrete pairs, not a rule: full source path and name, full target path and name,
and an ETag fetched at plan time, for the reasons 6a's spec records. A profile edited between
generating and executing cannot retarget a reviewed plan.

**The boundary with rename is by state.** `generate_rename_plan` keeps handling only `misnamed`;
`generate_move_plan` owns every state containing `misplaced`. A file lands in exactly one kind of
plan.

### Excluded at plan time

Each exclusion is reported as an item that will not be attempted, with a reason stating only what
the code observed.

- `in_another_library`: the match carries a `library`, so the file was found by the Microsoft Search
  cross-check in another document library of the same site. The reason names that library and says
  this server does not yet move files between libraries. It costs no Graph request.
- `target_folder_absent`: the target folder is not among the snapshot's `folderPaths`. It costs no
  Graph request.
- The three collision reasons from 6a, evaluated against the full target path:
  `target_path_already_occupied`, `slot_already_satisfied_by_another_file`, and
  `two_files_share_one_target_name`. For a move, `target_path_already_occupied` is expected to be
  largely unreachable, since a file already at the canonical path parses to the same slot and wins it
  as `compliant`, leaving the misplaced file a duplicate. Reachability of each reason is established
  by a test that obtains its report from the real `reconcile()`, per the rule in `CLAUDE.md`, and a
  reason no real report can reach is kept as a guard and labeled unreachable rather than covered by a
  hand-built fixture.
- The two ETag reasons from 6a: no usable ETag, and the file no longer at its path at plan time.

## The substrate

**One Graph verb.** `renameDriveItem` in `src/graph/rename.ts` becomes `relocateDriveItem`, taking
`driveId`, `path`, `etag`, and at least one of `newName` and `newParentPath`. It builds the PATCH
body from whichever are set and refuses a call setting neither. Its outcomes are `relocated`, carrying
the new etag when the response has one, `precondition_failed`, and the retained but unreachable
`not_found`, with 6a's reasoning for keeping that branch unchanged. The `etagOf` guard against a
bodiless response is carried over as is, since it is the fix for a defect the fakes could not see.
How `parentReference` is addressed is settled by the probe below, not here.

**One stored plan entity.** `StoredPlan.kind` widens from `"rename"` to `"rename" | "move"`. The Table
reader accepts exactly those two and still throws `MalformedPlanEntityError` on anything else,
rather than dropping the check. The item shape does not change, because `RenamePlanItem` already
carries a full source `path` and a full `targetPath` alongside both names, and nothing in it assumes
the folder is unchanged. No migration is needed; a plan stored under 6a reads back identically. The
type may be renamed to reflect that it now describes both kinds, with the stored field names
untouched.

**One executor.** The loop in `src/tools/rename/execute.ts` moves into a shared module parameterized
only by plan kind. Everything 6a's spec established about it is preserved: one loop for dry and
confirmed runs with the dry-run branch first, a per-item `If-Match`, the reversal log written before
the first write and each entry's etag refreshed from its PATCH response, the four skip reasons,
exact counts before truncation, and the Graph cost reported. The reversal of a move plan is a move
plan returning each file to its original folder and name, by the same swap `reversalItemsFor`
already performs.

`execute_rename_plan` and `execute_move_plan` are thin tools over it. Each refuses a plan whose
`kind` is not its own and says so, rather than running it, so one reviewed tool name corresponds to
one kind of write.

A move refused at execution because its target folder vanished after planning is reported under the
existing outcome for a Graph refusal this server cannot interpret. It gains an outcome of its own
only if the probe shows Graph answers that case with a distinguishable status.

**The refactor is proven behavior-preserving by 6a's own tests.** The rename suite passes with no
edits beyond import paths. If any rename assertion has to change, the refactor changed behavior, and
work stops for review rather than the assertion being updated.

## The probe comes first

A throwaway script under `.superpowers/live-sitting/`, in the manner of 6a's precondition probe, run
against a scratch folder in the sandbox library before the implementation plan is written, since the
plan encodes its answers.

1. Does a move PATCH accept `parentReference.path`, keeping it path-native, or does it require
   `parentReference.id`, costing one metadata GET per distinct target folder at plan time?
2. Does one PATCH carrying both `name` and `parentReference` apply both?
3. Does the response carry the item's `eTag`, and does a move change it?
4. Does a stale `If-Match` on a move answer 412, as it does on a rename?
5. What does Graph answer when the target folder does not exist?
6. **What does Graph do when the target name is already taken in the target folder and no
   `conflictBehavior` is sent?** A file can arrive there between generating and executing. If the
   default replaces or auto-renames, every move must send `conflictBehavior: fail`, which makes this
   slice `conflictBehavior`'s first real caller. If the default refuses, sending `fail` explicitly is
   still preferred to relying on an undocumented default. The probe's answer, and what the design
   does with it, are recorded in this document before the plan is written.

**Operator prerequisite.** The server application holds `Sites.Selected` with the read role on one
site, left that way by the 2026-09-19 teardown. The probe and the live sitting both need the write
role, so the grant issuer is stood back up per `docs/SETUP.md`, the grant widened, and the issuer
deleted and purged afterward. One widened window may serve both the probe and the sitting if the
operator accepts the write grant standing in between; otherwise it is two cycles.

## Verification before merge

The sitting runs 6a's five steps against move plans, and adds three.

1. Generate a plan and read it.
2. Dry run it and confirm the report names exactly the files the plan does.
3. Execute it for real and confirm the files moved.
4. Roll back through the reversal log and confirm the files returned.
5. Edit one file between generating and executing, and confirm that item alone is refused on its
   precondition while the others still apply.
6. Correct one `misnamed_and_misplaced` file by a single combined PATCH, and roll it back.
7. Observe a `target_folder_absent` exclusion arising from real data, not only from a fixture.
8. Run a rename plan end to end through the refactored executor, confirming the shared loop did not
   regress the path verified live on 2026-09-19.

## Documents this branch updates

- `docs/OPEN-ITEMS.md`: closes the cross-field constraint entry, records the probe's findings, and
  records the sitting with what it did not establish.
- `CLAUDE.md`: the Build Sequence entry for phase 6 gains 6b-1 and 6b-2, and is edited in the same
  commit as the sitting's record, per the working agreement written after 4b and 4c. The Decision
  Record's Graph access entry is amended if the probe settles `parentReference` addressing or
  `conflictBehavior`.
- The parent design spec's tool table: `execute_move_plan`'s note describes the two slices rather
  than a single asynchronous cross-library tool.
