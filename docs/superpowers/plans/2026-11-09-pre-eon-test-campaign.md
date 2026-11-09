# Pre-EON Test Campaign

**Goal:** Find every defect that can be found on the Ironwright developer tenant before the server is deployed anywhere else.

**Rule:** Nothing here touches an employer tenant. Every run is against the IronwrightTest site, under the server application's own `Sites.Selected` token.

**How it runs:** `npm run campaign` drives the live server over MCP and does the out-of-band steps (delete a folder, rename a file, edit a list item by hand) directly against Graph, because the server never does those. Each scenario uses a vendor name of its own. The grant must be at `write` and the server started with `IW_ALLOW_WRITES=true`. Results print as one table; full results land under `.superpowers/campaign/` (git-ignored).

## Verdicts

PASS means the behavior matched the design. FAIL means a defect or a design claim that did not hold. MEASURED means the scenario records what happens and a person decides whether that is acceptable.

## Scenarios

| Key | What it does | Pass looks like |
|---|---|---|
| s1 | Deletes `Published`, then saves the executive summary | MEASURED. Either the save is refused, or `Published` reappears and the journal shows what wrote it. A silent recreation with no journal entry is the case to rule on. |
| s2 | Uploads the publication under a lowercase name, then verifies, reads and transitions | `verify_publication` says absent, and `transition_assessment` refuses. A completed transition on a misnamed file is a FAIL. |
| s3 | Saves an executive summary, reads it back, overwrites it | Created, hash matches the text sent, overwrite reports `overwritten` with the new hash. |
| s4 | Four concurrent `open_assessment` calls for one vendor | Exactly one assessment item, one id returned to all four, no errors. |
| s5 | Six concurrent overwrites of one dossier | The final content is exactly one writer's. Losers are refused cleanly or report overwritten, never a mixed file. |
| s6 | Edits State, then Status, by hand in the list, then calls tools | MEASURED. After Status is set to Completed by hand, a mutating save must be refused. |
| s7 | Asks Graph for the tenant root site and a site search | The root answers 403 or 404 and the search finds only the granted site. This is the security claim, tested negatively. |
| s8 | Deletes the `Evidence` subfolder, then opens again | The folder is rebuilt, the same id comes back, and there is still exactly one item. |

## Not automated here

- **Throttling and token expiry mid call.** Need a way to provoke a 429 on demand; carried until one exists.
- **Interrupted open.** A server killed mid create is a process this script did not start, so it is run by hand in a sitting.
- **Inbound authentication on a public tunnel, and the Copilot Studio contact.** Plan 9d.

## Recording

Each run's table goes into `docs/OPEN-ITEMS.md` as a dated sitting entry, with the redacted report beside the 9c evidence. A FAIL becomes a carried item or a fix before the next run. The status table gets a row for the campaign when its first run completes.
