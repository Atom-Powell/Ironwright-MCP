# Phase 6d: operator-authored plans

Design spec. Written 2026-09-23, after the phase 6b-1 design (`2026-09-22-move-write-path-design.md`)
and before either is implemented. Settled in a design dialogue with the operator the same day.

## What this phase delivers

`generate_custom_plan` and `execute_custom_plan`: plans an operator describes, usually through the
Copilot Studio agent, rather than plans derived from a reconciliation report. They rename and move
files inside the profile's own document library, with no tracking workbook involved, through the
same plan-then-execute path the reconciliation-derived write tools use.

It also delivers library-only profiles, so a document library with no tracking workbook can be
onboarded at all.

Deliberately out, each recorded in `docs/OPEN-ITEMS.md` so it stays visible:

- **Creating folders.** A move into a folder that does not exist is refused. Creating a folder makes
  its reversal a delete, which 6b-1 already kept out of the first move slice for the same reason.
- **Deleting anything.** It would be this server's first destructive operation and needs its own
  safety design.
- **Cross-library moves.** They wait on phase 6b-2's live probe.
- **Selecting folders.** Moving a folder moves its whole subtree, a wider change than this slice
  should make.
- **Chains and swaps.** A plan whose correctness depends on the order its items run in is excluded
  rather than ordered.
- **Regex and templated renames.** Only literal edits are offered.

## Why this is not a thin wrapper

The mission rejects one-tool-per-Graph-call servers, and a `move_item` or `rename_item` tool is
exactly that. This phase does not add one. What an operator supplies is a declarative description of
which files and what change; the server resolves it against the delta-maintained index into concrete
items, reports every exclusion with its reason, persists a reviewable plan, and applies it only on an
explicit confirm, with a precondition on every write and a reversal log written first. The workbook's
only role in the existing write path was deciding what should change. Everything after that decision
was already general, and this phase lets a second source make the decision.

## Placement

Built after 6b-1, which it depends on: 6b-1's `relocateDriveItem`, its shared executor, and its
stored plan entity. It adds no new Graph write, so it needs no live probe of its own beyond the one
6b-1 runs. It does not depend on 6b-2 or 6c.

## Library-only profiles

The profile schema gains a `kind` discriminator.

- `kind: "compliance"` is the current shape, unchanged, and the default when `kind` is absent. Every
  existing profile loads exactly as before, and no migration is needed.
- `kind: "library"` carries only identity: `siteUrl`, `library`, and the optional `searchRegion`. No
  `workbookPath`, `workbookMapping`, taxonomy, filename standard or deliverables.

The startup check refusing a profile whose `siteUrl` disagrees with `IW_SITE_URL` applies to both
kinds.

Each tool declares whether it needs a compliance profile. Given a library profile:

- `inventory_tree`, `generate_custom_plan` and `execute_custom_plan` work.
- `query_repository` answers empty folders and recently modified files, and refuses the
  filename-standard question.
- `reconcile_workbook_vs_repository`, `validate_structure`, `generate_rename_plan`,
  `execute_rename_plan`, `generate_move_plan`, `execute_move_plan` and `replicate_template` refuse
  before any Graph request, saying the profile is library-only and has no compliance definition.
- `describe_workbook` never took a profile and is unaffected.

The refusal is the point. An empty reconciliation report over a library profile would read as "all
compliant", which is a function asserting an outcome it cannot observe.

## Input

`generate_custom_plan` takes `profileId` and `steps`, an array of one to 20 steps. Each step is a
`selector` and an `action`.

### Selector

Selects files only, never folders. Fields are combined with AND.

- `folder`, required: a library-relative path such as `/Client A/2025`.
- `recursive`: default false, meaning direct children of `folder` only.
- `nameEquals`: an exact file name.
- `nameContains`: a literal substring.
- `extensions`: for example `[".pdf", ".docx"]`.
- `modifiedAfter` and `modifiedBefore`: ISO 8601 dates.

Name comparison ignores case, because SharePoint treats two names differing only in case as the same
name. A selector naming only `folder` selects every file there, which is valid; the plan size limit
is its guard.

### Action

`moveTo`, `rename`, or both. Both together is one PATCH per file changing the folder and the name,
as 6b-1 does for `misnamed_and_misplaced`.

- `moveTo`: a library-relative folder that must already exist in the index.
- `rename`: exactly one of
  - `setName`, permitted only when the selector matched exactly one file;
  - `replace: { find, with }`, literal;
  - `addPrefix`;
  - `addSuffix`, inserted before the extension.

### Rules

- **Extensions never change.** Edits apply to the name's stem. A `setName` whose extension differs
  from the source's is excluded.
- **Steps are independent.** Every step resolves against the same index snapshot, taken at plan
  time. A later step cannot see files an earlier step would move, so step order carries no meaning.
- **Overlap is excluded, not ordered.** A file matched by two steps is excluded from both, with a
  reason naming both steps.

`execute_custom_plan` takes `profileId`, `planId` and `confirm`, identical to the other execute
tools.

## What `generate_custom_plan` does

1. Load the profile. Either kind is accepted.
2. Run an incremental delta scan through the single-flight scan coordinator, so selectors never
   resolve against a stale index.
3. Resolve the steps against the snapshot in a new pure module, `src/domain/custom/resolve.ts`, with
   no I/O, per the domain-purity rule.
4. Fetch each candidate's ETag at plan time, one request per file, as 6a does.
5. Persist the plan and return it.

### Refused with no plan persisted

Each is an error in the request that the caller should correct and resend.

- **An unknown folder.** A selector `folder` or a `moveTo` folder absent from the index. The refusal
  names the deepest ancestor that does exist and lists up to 10 of its subfolders, taken from the
  index. This is how the server helps the agent recover from a wrong path: with evidence, not a
  guess.
- **An ambiguous `setName`.** `setName` on a selector matching more than one file. The refusal
  carries the match count.
- **Too many files.** More than 100 matched files across all steps. The limit is a constant set by
  the sequential plan-time ETag fetch, whose cost is one request per file. The refusal carries each
  step's count so the selectors can be narrowed. The plan is refused rather than truncated, because a
  truncated plan silently omits files.
- **Nothing matched.** The response still carries each step's count of zero.

### Excluded per item, plan still persisted

Each exclusion's reason states only what the code observed.

- `matched_by_multiple_steps`, naming the steps.
- `no_change`: the target equals the source.
- `extension_would_change`.
- `invalid_target_name`: a character SharePoint forbids, a leading or trailing space, or a reserved
  name.
- `target_path_already_occupied`: another file is at the target path, compared ignoring case. This
  includes a file that the same plan would move away, since chains and swaps are not ordered.
- `two_items_share_one_target`.
- The two ETag reasons from 6a: no usable ETag, and the file no longer at its path at plan time.

### Output

The `planId`; a per-step summary of matched, included and excluded counts; each included item as
source path to target path, tagged with its step; each exclusion with its reason; exact counts before
any display truncation; the Graph cost; and the index's last scan time.

### Stored plan

`StoredPlan.kind` widens to `"rename" | "move" | "custom"`. The Table reader accepts exactly those
three and still throws `MalformedPlanEntityError` on anything else. The item shape is 6b-1's,
unchanged. A custom plan additionally stores its `steps` verbatim, so an auditor reading a reversal
log later sees what the operator asked for alongside what it resolved to. Plans of the other kinds
carry no `steps` and read back identically.

### How this helps the agent compose plans

Generating is the preview, and it is safe because nothing writes until an execute call carries
`confirm: true`. The agent can generate, show the operator the per-step counts and items, adjust the
selectors, and generate again. The tool description carries worked examples for the common requests:
move every PDF in one folder to another, add a prefix to everything in a folder modified in a given
year, rename one named file.

## What `execute_custom_plan` does

It is a thin tool over 6b-1's shared executor, and inherits all of it: the dry-run default, a
per-item `If-Match`, one stale item never blocking another, the reversal log written before the first
write with each entry's ETag refreshed from its PATCH response, exact counts, and the Graph cost.

It refuses a plan whose `kind` is not `custom`, and the rename and move executors refuse a `custom`
plan, so one reviewed tool name still corresponds to one kind of write.

The reversal log of a custom plan is itself a `custom` plan, each item swapped, with its stored
`steps` replaced by a record that it reverses a named plan. Rollback runs through
`execute_custom_plan`, the same code path, as the Decision Record requires.

## Testing

- Unit tests for the pure resolver: every selector field, every exclusion reason, every refusal,
  including the folder suggestions.
- The resolver consumes the repository snapshot, so at least one test obtains that snapshot from the
  real snapshot assembler over fake delta pages rather than constructing it, per the rule in
  `CLAUDE.md`.
- Profile schema tests: an absent `kind` loads as `compliance`, every existing profile fixture loads
  unchanged, and a library profile loads.
- A registry-wide test in the manner of the contract test: every tool declaring that it needs a
  compliance profile refuses a library profile before any Graph request. A tool added later inherits
  the check.
- The contract test covers both new tools without change.
- Cross-kind refusal tests for all three executors.

## Verification before merge

Run against the sandbox tenant with the write grant. This sitting may share 6b-1's widened grant
window if the operator accepts the write grant standing between the two.

1. Load a library-only profile, run `inventory_tree`, and confirm reconciliation and structure
   validation refuse it.
2. Trigger an unknown-folder refusal and confirm its suggestions come from the real index.
3. Generate a mixed plan and read it: a multi-file move by extension, a prefix rename, a single
   `setName`, and one combined move and rename.
4. Dry run it, execute it for real, and confirm the result with a fresh delta scan.
5. Roll back through the reversal log and confirm the library is back where it started.
6. Edit one file between generating and executing, and confirm that item alone is refused on its
   precondition while the others apply.
7. Observe an overlap exclusion and an occupied-target exclusion arising from real data.

## Documents this branch updates

- `CLAUDE.md`: the Mission and Decision Record are amended to say the product covers general file
  work inside a granted site through operator-authored plans, still path-native, still
  plan-then-execute, and still without per-call Graph wrappers. The tool table goes to 12 tools and
  gains the profile-kind rule. The Build Sequence gains a 6d entry, edited in the same commit as the
  sitting's record.
- The parent design spec's tool table.
- `docs/SETUP.md`: a library-only profile example.
- `docs/OPEN-ITEMS.md`: the sitting's record and what it did not establish, and the deferred
  operations listed at the top of this document.

## Amendments, 2026-09-24, before the implementation plan

Written after phase 6b-1 and the token role guard merged, against the code as it now stands.

### Prior art read: `henrysouchien/drive-mcp`

The Google Drive MCP server the competitive refresh found, read at commit `9833c10` (MIT,
[repository](https://github.com/henrysouchien/drive-mcp)). It offers `dry_run` on its mutating
tools and returns a `restore_token` that `gdrive_undo` consumes. Its source settles three
questions its documentation leaves open, and each confirms a choice this spec already makes:

- The restore token is base64 JSON held by the caller and never stored or signed
  (`_make_restore_token` in `src/server.py`). Nothing on the server records what was changed, and
  a caller can hand `gdrive_undo` a token it wrote itself. This spec's reversal log is persisted by
  the server, carries the plan it reverses, and cannot be forged by a caller.
- Undo carries no precondition: it renames or re-parents by file id whatever the file is now, so
  undoing an old change overwrites anything done since. This spec's reversal entries carry ETags,
  so a stale undo is refused, which the 6b-1 sitting measured.
- Its move dry run returns before resolving the destination folder, so a preview can succeed where
  the real move fails. This spec refuses an unknown folder before any plan is stored.

One idea is worth keeping for a later slice, not this one: its undo of a create moves the item to
the trash rather than deleting it. SharePoint has a recycle bin too, so a created folder's reversal
could be recoverable, which weakens the reason 6b-1 and this spec both gave for deferring folder
creation. It is recorded for phase 6c, where `replicate_template` is the first caller of folder
creation, and changes nothing here.

### Four corrections from the code as built

1. **`query_repository` on a library profile answers `empty_folders` only.** `recent_reports`
   identifies a report by parsing its name against the profile's naming standard
   (`createFileParser(profile)` in `src/tools/query/run.ts`), so it needs a compliance profile as
   much as `naming_violations` does. Both refuse a library profile, before any store read.
2. **A library profile's scan skips the Microsoft Search cross-check.** The cross-check builds its
   query from the naming template's literal extension (`src/scan/cross-check.ts`), which a library
   profile does not have. It is skipped with a fifth named skip reason, `library-profile`, so a
   scan never reports a cross-check as incomplete without saying why.
3. **How a tool "declares" that it needs a compliance profile.** The registry's existing
   `get(profileId)` keeps its return type and refuses a library profile with a new
   `LibraryProfileError`, and a new `getAny(profileId)` returns either kind. Every compliance tool
   already calls `get`, so none of them changes; the three tools that accept a library profile
   call `getAny`. The registry-wide test names both sets explicitly and fails if a tool is in
   neither, so a tool added later has to choose.
4. **Rules spanning several input fields** (a step needs `moveTo` or `rename`; `rename` takes
   exactly one form; `setName` needs exactly one match) are enforced in the handler and stated in
   the tool's `inputConstraints`, since the installed SDK advertises an empty schema for a refined
   one (`docs/OPEN-ITEMS.md`, "The MCP SDK cannot advertise a refined input schema").

Two smaller clarifications. A selector's `folder` and a `moveTo` folder are matched against the
index ignoring case, and the plan records the folder's actual casing. And a custom plan's reversal
records the plan it reverses in the existing `reverses` field and carries no `steps`.
