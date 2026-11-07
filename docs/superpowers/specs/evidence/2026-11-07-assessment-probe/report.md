# Assessment probe report, run 20261107T203924Z

Each row whose Observed status is not 0 is one request sent under a token whose roles the runner verified to be exactly: Sites.Selected.
A row whose Observed status is 0 was not sent, because its request could not be built.
The site is the one configured in IW_SITE_URL, which the recordings show as <host>. Verdicts are the
judge's reading of the status and body; the redacted request and response are in recordings.jsonl
beside this file.

| Step | Assumption | Expected | Observed | Verdict |
|---|---|---|---|---|
| R1 | the probe site resolves under the server's grant | 200 | 200 | pass |
| R2 | the probe library resolves to a drive | 200 with a drive named as configured | 200 | pass |
| L1 | Sites.Selected reaches list items for read | 200 | 200 | pass |
| L2a | Sites.Selected creates a list item and the response carries its integer id | 201 with id | 201 | pass |
| L2b | a fields PATCH writes the rendered AssessmentId back and returns the updated fields | 200 with AssessmentId | 200 | pass |
| L1b | a single item reads back with the field just written | 200 with fields.AssessmentId | 200 | pass |
| L3a | a list query filtered on a text field works without the non-indexed header | 200 with one item, or a status that says the column must be indexed | 400 | observed: status 400, invalidRequest |
| L3b | the same query works with Prefer: HonorNonIndexedQueriesWarningMayFailRandomly | 200 with one item | 200 | pass |
| F0 | the probe root folder exists at the library root (created once, 409 on later runs) | 201, or 409 nameAlreadyExists | 201 | pass |
| F1a | folder create by path with conflictBehavior fail returns the item with an ETag | 201 with eTag | 201 | pass |
| F1b | a second create of the same folder answers 409 nameAlreadyExists | 409 nameAlreadyExists | 409 | pass |
| F2a | a small content PUT with conflictBehavior fail creates the file and returns its ETag | 201 with eTag | 201 | pass |
| F2b | the same PUT against the occupied name answers 409 and replaces nothing | 409 nameAlreadyExists | 409 | pass |
| F3a | a content PUT under If-Match with the current ETag succeeds and returns a new ETag | 200 with a different eTag | 200 | pass |
| F3b | a content PUT under a stale If-Match answers 412 | 412 | 412 | pass |
| F3c | a content PUT under If-Match against an absent path answers 412, so the precondition is checked before existence | 412 | 201 | fail: expected 412, received 201 |
| F4 | the content reads back as what the last successful write sent | the overwritten text | 200 | pass |
