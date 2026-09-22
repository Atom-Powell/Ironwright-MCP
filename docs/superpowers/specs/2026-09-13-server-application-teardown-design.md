# Design: server application teardown

Date: 2026-09-13
Status: Implemented. `--delete-server-app`, `--force-orphan` and the purge step all ship, and the
teardown path has run against a live tenant. (Corrected 2026-09-22; this line read "Approved
(design only)" until then.)
Extends: `2026-09-11-repository-reconciliation-mcp-design.md`, which settles the two-phase setup and
the grant-issuer model. This addendum closes the teardown hole recorded in `docs/OPEN-ITEMS.md`:
the setup command can create a server application and grant it site access, and can undo neither.

## Why this exists

`--delete-bootstrap` removes the grant issuer. Nothing removes the server application or the
per-site permission it was granted, and the two have to come apart in an order the tool does not
currently know.

The gap has been hit in practice twice. A live run against a developer tenant could not be undone
by the tool that made it. And an application whose client secret was exposed had to be deleted and
purged by hand through the portal, including the purge step, which is the one that actually ends
the exposure and the one a person is most likely to skip.

## Scope

One new mode on the existing setup command, `--delete-server-app`, plus a documentation correction
that needs no code.

In scope: revoking a server application's per-site permission, deleting the application, purging it
from the tenant's deleted items, a dry run that previews all of that, and the refusals and
already-done paths around it.

Out of scope: deleting the grant issuer, which is `--delete-bootstrap`'s job and whose ordering
against this mode is the operator's call. Creating a grant issuer, which is `--create-bootstrap`'s.

Also out of scope, but with a caveat rather than a reason: removing the service principal as a
separate step. The existing rollback deletes the application alone and has been exercised against a
live tenant, so this mode follows that precedent. Whether deleting the registration also removes its
service principal has not been verified by anyone on this project, and it is worth checking during
the live run below. If a service principal survives, this mode needs a step and the rollback has the
same gap.

## Command shape

`--delete-server-app` takes the arguments a normal setup run takes:

- `--tenant`, required, as everywhere.
- `--site`, required. Unlike the two bootstrap modes, this one acts on a site, because the
  permission entry lives there.
- `--name`, defaulting to the same `DEFAULT_DISPLAY_NAME` a normal run uses, so an operator who
  accepted the default at setup does not have to remember it at teardown.
- Grant issuer credentials from the environment, the same ones a normal run uses. Revoking a site
  permission is refused on a delegated token, which is the whole reason the grant issuer exists.

It is mutually exclusive with `--create-bootstrap` and with `--delete-bootstrap`, guarded the way
those two already guard each other and for the same reason: letting one silently win is how an
operator tears down something they meant to create.

**Dry run is the default.** Without `--confirm` the mode resolves the site, the application and the
permission entry, prints exactly what it would remove, and issues no destructive call. This is the
Decision Record's stated posture for destructive work. It is also the discovery step: an operator
who mistypes a display name sees the wrong application named before anything is touched rather than
after.

The dry run requires the grant issuer credentials as well, because listing the site's permissions is
half of what it previews, and a preview that cannot see the permission entry is not worth printing.

## The sequence

Revoke, then delete, then purge. The order is not a preference. The permission entry is matched to
the application by app id, so the revoke has to happen while that identity still exists. Reversing
it is precisely how the current hole was created.

| Step | Call | Token |
|---|---|---|
| 1 | Device-code sign-in | n/a, produces the delegated token |
| 2 | Resolve site URL to site id | delegated |
| 3 | Find application by display name | delegated |
| 4 | Acquire grant issuer app-only token | n/a |
| 5 | List the site's permissions, find the entry granted to that app id | grant issuer, app-only |
| 6 | Revoke that permission entry | grant issuer, app-only |
| 7 | Delete the application | delegated |
| 8 | Purge it from deleted items | delegated |

Steps 1 through 4, 6 and 7 already exist, because rollback needed them. `SetupGraph` gains exactly
two methods:

- `listSitePermissions(siteId)`, a `GET /sites/{siteId}/permissions` on the grant issuer's token,
  returning each entry's id together with the application ids inside its granted identities.
- `purgeDeletedApplication(objectId)`, a `DELETE /directory/deletedItems/{objectId}` on the
  delegated token.

Step 8 is the one that matters most and the one a portal user forgets. Entra's delete of an
application registration is a soft delete: the object sits in deleted items for 30 days, where
anyone with Application Administrator can restore it along with its credentials. A teardown that
stops at step 7 has not removed the credential, it has scheduled its removal.

## When there is no grant issuer

Revoking needs one. Without it the mode refuses by default, names `--create-bootstrap` as the fix,
and states plainly that nothing was touched.

`--force-orphan` overrides that: the application is deleted and purged anyway, and the run reports
that the permission entry remains, that it now names an identity that does not exist, that it grants
access to nothing, and that clearing it later needs a grant issuer recreated.

That flag exists for a real case. An operator may hold no Privileged Role Administrator role at
teardown time and therefore cannot create a grant issuer, while still needing an exposed credential
gone. Removing the credential is the urgent half; the residue is untidiness. Refusing to do the
urgent half because the tidy half is blocked would be the wrong trade, but it is explicit rather
than silent.

## Already done is a success

This project shipped `--delete-bootstrap` with 352 tests and nine reviewers behind it, and the first
real use found it printing "Bootstrap deletion failed" and exiting 1 on a tenant that was already
correctly torn down. Nobody had asked what "already done" should mean. This mode answers that before
it ships rather than after.

Four states mean the outcome the operator wanted is already true. Each reports its own distinct
message and exits zero:

- No application by that display name.
- An application, but no permission entry granted to it on that site.
- A 404 from the delete.
- A 404 from the purge.

Only a genuine partial state is a failure: some step was needed, was attempted, and failed.

**The sibling bug gets fixed in the same work.** `runDeleteBootstrap` still throws when the grant
issuer is already absent, which is the defect the open item above describes and which was never
fixed. Designing the answer into a new mode while the identical bug sits two functions away in the
same file would be indefensible, and the fix establishes the pattern this mode then follows. It is a
targeted improvement to code this work is already touching, not unrelated refactoring.

## Failure reporting

Every string this mode can print is enumerated and audited against what the program actually did at
the moment it prints. Teardown is where a misleading message does the most damage, because it either
tells an operator a credential is gone when it is not, or sends them to delete something already
deleted.

Three messages carry the most weight.

**The no-grant-issuer refusal** must say nothing was touched. An operator reading a refusal needs to
know whether the run got partway.

**The `--force-orphan` report** must name exactly what remains and what clearing it would take.
Anything vaguer becomes residue nobody acts on, which is how this hole was recorded in the first
place.

**A partial failure states the real state rather than a verdict.** If the revoke succeeded and the
delete failed, the message says the grant is revoked and the application still exists. Not "teardown
failed", which tells the operator nothing about what to do next. Re-running is then safe and
finishes the job, which the already-done handling above makes true by construction.

An ambiguous display name, two applications sharing it, is refused rather than resolved by guessing,
matching what `--delete-bootstrap` already does.

## Testing

Unit tests against a fake `SetupGraph`, following the existing setup tests. Error-path cases live in
a `.errors.test.ts` file, which the separate CI gate runs on its own.

The cases that matter:

- Each of the four already-done states, asserting the distinct message and a zero exit.
- An ambiguous display name.
- A missing grant issuer, refused, asserting nothing was called.
- A missing grant issuer with `--force-orphan`, asserting the delete and purge ran and the report
  names the residue.
- A revoke that succeeds followed by a delete that fails, asserting the message describes that state
  rather than a generic failure.
- The dry run, asserting it issued no destructive call at all. This is the one test that would catch
  the worst possible defect in the mode.

## Live verification

Unlike phase 2a's request-count claim, this one needs no separate trip. The next live setup run
creates an application that has to come back out, so create, scan, tear down is one sitting and
teardown is exercised against a real tenant as a side effect of verifying phase 2a.

**Amended 2026-09-22. It did not work out that way, and one of the two questions is still open.**
Teardown was not a side effect of any single sitting. The 2026-09-16 and 2026-09-17 sittings both
ended with the applications left standing, and the tenant was torn down only after the phase 6a
sitting on 2026-09-19, by `npm run setup -- --delete-bootstrap --confirm`, which reported both the
delete and the purge. So the purge path has now reported success against a real tenant. **Whether
deleting a registration also removes its service principal was never separately checked**, so the
caveat in Scope above stands exactly as written: if a service principal survives, this mode needs a
step and the existing rollback has the same gap. `docs/OPEN-ITEMS.md` carries it.

## The documentation correction, no code

`docs/SETUP.md` and the setup command's success output currently tell the operator to delete the
grant issuer once onboarding is done. That advice is what strands the permission entry later, and it
is the root cause the open item identified as the more interesting half of this problem.

Both are corrected to say the grant issuer should be kept until the site is decommissioned, or that
teardown will need one recreated. No detection logic: having `--delete-bootstrap` check whether any
server application still holds a grant would need a grant issuer token to enumerate site
permissions, which is the very thing being deleted.
