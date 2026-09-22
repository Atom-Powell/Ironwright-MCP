# Design: the Microsoft Search cross-check

Date: 2026-09-17
Status: Implemented. Verified live on 2026-09-17. (Corrected 2026-09-22; this line read "Approved
(design only)" until then.)
Phase: 2c, the last outstanding piece of phase 2.
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, whose justification for this
cross-check is amended below rather than inherited.

## The original justification is stale, and this spec replaces it

The parent spec says the cross-check "is not optional: a pure tree walk counts a file sitting at a
client root as missing, which is pain point two and the highest-consequence false negative in the
system." That was written before phase 2a existed.

Phase 2a does not walk the tree. It runs delta over the whole drive, and `assembleSnapshot`
narrows that only when `--sub-path` is passed. The matcher already resolves a correctly named file
at an unexpected path to `misplaced`, at `src/domain/reconcile/match.ts:102`. The live sitting on
2026-09-17 demonstrated this without intending to: `starter.xlsx` sat in the library root, outside
the `2026/` taxonomy entirely, and the report found it. A file out of place inside the scanned
library is not invisible.

So the gap this phase closes is narrower and different: **a correctly named file filed into a
different document library of the same site.** The scan covers one drive. Anything in a sibling
library is outside it, and today the engine reports the deliverable as missing when it exists.

Cross-site is deliberately not in scope, and not because it was judged unimportant. The server
holds `Sites.Selected` on one site, and a live probe on 2026-09-17 confirmed Microsoft Search is
security trimmed to exactly that grant: a broad query returned 220 hits and every one was under
the granted site. Reaching another site would mean widening the grant, which the Decision Record
refuses. The permission boundary and the search boundary coincide, which is the right shape.

## What the live probe established, before any of this was designed

Run on 2026-09-17 against the `helloironwright` tenant with the server's own `Sites.Selected`
token, following the rule this project adopted after phase 2b-1: probe an unfamiliar API surface
before designing against it.

- `POST /search/query` for `driveItem` works with an app-only token. It is not delegated only,
  which is the failure that invalidated the Excel approach.
- It requires a `region` in the request when called with application permission. Without it the
  call fails with 400 and `Region is required when request with application permission.`
- Results are trimmed to the granted site.
- Hits carry `webUrl` in URL-name form, `.../Shared Documents/...`, while a profile carries the
  display name, `Documents`. The two do not match as strings.

## Scope

One thing: find candidate files in other document libraries of the profile's own site, and give
them to the reconciliation engine so an artifact that exists elsewhere stops being reported as
missing.

Out of scope: cross-site search, searching the profile's own library, which delta already covers,
and any change to how the engine decides compliance beyond the single matcher rule below.

## Architecture

```
src/scan/cross-check.ts   list site drives -> exclude the profile's own -> search each -> repository files
                                                                              |
src/graph/search.ts (impure) --------------------------------------------------+
```

**`src/graph/search.ts`** issues `POST /search/query` for `driveItem`, taking a region and a path
scope, and pages results. It carries no domain knowledge, the same way `src/graph/drive.ts` does
not: it does not know what a client or a deliverable is.

**`src/scan/cross-check.ts`** composes. It lists the site's drives, excludes the drive the profile
names, searches each remaining one, and converts hits into `RepositoryFile` values carrying a
library qualifier.

`src/graph/drive.ts` exports only `resolveDrive`, which lists the site's drives internally and
returns the one match. This phase needs the list, so that enumeration is extracted into an
exported `listDrives` and `resolveDrive` is rewritten to call it. That keeps one description of
how a site's libraries are found rather than two, which matters because `resolveDrive`'s existing
exact-then-case-insensitive matching rule exists to avoid picking the wrong library when two names
differ only in case, and a second copy of that enumeration would be a place for the rule to go
missing.

`assembleSnapshot` takes the cross-check result and sets `searchCrossCheckIncluded` from whether
it completed, not from whether it ran.

## The contract change

`RepositoryFile` gains an optional `library?: string`.

Absent means the profile's own library. That is exactly today's meaning, so every existing
fixture, the golden report, and every test stay valid without edits. Present means another
document library in the same site, named by the library this cross-check actually searched.

One rule is added to the matcher: **a candidate carrying a library qualifier can never resolve to
`compliant` or to plain `misnamed`.** Its location is wrong by definition, so it resolves to
`misplaced` or to `misnamed_and_misplaced` according to its name. No new state is introduced, and
the existing state set and its ranking are untouched.

### Cross-library files never become orphans

A file found by the cross-check participates only as a candidate for an expected artifact. If it
matches no expected artifact it is discarded, not reported.

This rule is load bearing rather than tidy. Without it, every unrelated file in every other
library of the site, every HR document and meeting note and scanned invoice, arrives in a
compliance report as an orphan. The tool would become unusable at precisely the customers who
have more than one library, which is most of them. Empty-folder detection likewise considers only
the profile's own library.

## Degraded stays honest

`searchCrossCheckIncluded` becomes true only when the cross-check completed for every other
library in the site. Anything less is still a degraded scan and says so.

Three distinct reasons must be distinguishable by an operator reading the report, because the
remedy differs for each:

- The profile carries no `searchRegion`, so the cross-check was skipped entirely.
- A search failed for one or more libraries.
- A library held more pages of results than the page cap allows, so it was not searched
  exhaustively.

**Amended 2026-09-22: four reasons shipped, not three.** `CrossCheckSkipReason` in
`src/scan/cross-check.ts` is `no-region`, `search-failed`, `library-not-addressable` and
`page-cap-reached`. The fourth is the one this spec could not have anticipated, and the live
sitting is what produced it: a drive's `webUrl` from `listDrives` is percent encoded while a search
hit's is not, so the path conversion's literal prefix strip failed for any library whose name
contains a space, and `Shared Documents` is the default library name. A library this cross-check
cannot address by path is now named as its own reason rather than silently contributing no hits to
a check that reported itself complete.

A failing search never fails the reconcile. A report without a cross-check is still worth having;
one that silently claims a cross-check it did not complete is not.

The third reason is the one worth stating plainly: a cap that truncates silently would be worse
than having no cross-check at all, because it would let the report drop its own disclaimer while
remaining blind to exactly the files the phase exists to find.

## The query

Per other library: a path scope of that library's own URL, narrowed by the file extension the
profile's `naming.template` produces. A cross-check for `.xlsx` deliverables has no reason to page
through a library's images.

The extension is the literal suffix of `naming.template` from its final `.` onward, which for the
example profile's `{year}-{month:02}_{client}_{deliverable}.xlsx` is `xlsx`. A template whose final
segment carries a placeholder, so that the extension is not a literal, produces no extension
narrowing and the search runs unnarrowed. That case is not an error: an unnarrowed search is
correct, merely more expensive, and refusing to run would trade a working cross-check for none.

Results page 200 hits at a time, to a cap of 25 pages, so at most 5000 hits per library. A
tracking repository's deliverables number in the hundreds, and the live site returned 220 hits for
a broad single term, so the cap sits roughly an order of magnitude above any plausible real
answer while still bounding a pathological one. Both numbers are constants with their reasoning
beside them rather than profile configuration, for the same reason the workbook limits are: no real
customer library has been measured, so a knob would be a guess at a shape nobody has seen.

Reaching the cap without exhausting the results marks the cross-check incomplete, per the rule
above.

## Matching a hit back to a library

A hit's `webUrl` carries the library's URL name while the profile carries its display name, and
the two differ. The conversion therefore qualifies each hit with the library this cross-check was
searching when the hit came back, rather than parsing a library name out of the URL.

Parsing the name out of a URL would work against every fixture this repository could write and
break on the first customer whose library has been renamed, which is the shape of failure this
project has already paid for once.

## Configuration

`identity.searchRegion`, optional, a string such as `NAM`. It is a property of the customer's
tenant, like `siteUrl`, so it belongs in the profile rather than in an environment variable.

Optional rather than required so existing profiles stay valid. A profile without it produces a
report that is degraded for a stated reason, which is the honest outcome and not a silent one.

There is no discovery call for this value that this project has verified, so it is configured
rather than detected. If one is found later, detection can replace configuration behind the same
field.

## Testing

The Graph layer tests against a fake transport with recorded search payloads, including a
multi-page response proving paging works and a response exceeding the cap proving the cross-check
degrades rather than lies.

The conversion and the matcher rule are pure and test from fixtures.

The live probe is already done and its results are recorded above, so the assumption that this API
accepts an app-only token is evidence rather than belief before any code is written. That ordering
is the whole lesson of phase 2b-1.

## What this phase does not do

It does not search other sites, and cannot without widening a permission the Decision Record
protects.

It does not change how compliance is decided, beyond the single matcher rule.

It does not make an unqualified report trustworthy on its own: a report is complete only when the
cross-check completed, and the report continues to say which of those it is.
