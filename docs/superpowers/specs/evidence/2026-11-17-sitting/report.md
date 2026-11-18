# Live sitting, 2026-11-17: results

Built from the result files `npm run sitting` wrote, which stay under `.superpowers/`, git-ignored.
Site addresses, ETags and GUIDs are redacted. Vendor names are the runner's and the campaign's own.
The run started 2026-11-17T23:53:32Z from commit `e9b5fa6` plus the uncommitted correction to the
runner's server environment, against the developer tenant, with the grant at `write` for its length.

## The runner's verdicts

| Step | Verdict | Detail |
|---|---|---|
| If-Match probe on list items | observed | Graph enforced on the fields address, where the server already writes: the fix is one header. L4a 412, L4b 200, L4c 200, L4d 412. |
| campaign | pass | s2, s3, s4, s5, s7 and s8 pass; s1 and s6 measured as before |
| get_assessment by status | pass | ASM-2026-00030 is among 23 in progress |
| get_assessment readback and readiness | pass | 1 finding, 10 journal entries, 4 readiness lines |
| a refusal through a client that lists tools | pass | refused with its evidence: expected "the publication present at its canonical path", observed "not present" |
| interrupted open | pass | stopped 1200 ms into the open; the retry answered ASM-2026-00031 (created false, resumed true) and the vendor has exactly one assessment |
| grant restored to read | pass | current roles: read |

## The probe, one line per step

```
R1   200  pass
R2   200  pass
L1   200  pass
L2a  201  pass
L2b  200  pass
L1b  200  pass
L3a  400  observed status 400, invalidRequest
L3b  200  pass
L4a  412  pass
L4b  200  pass
L4c  200  pass
L4d  412  pass
F0   409  pass
F1a  201  pass
F1b  409  pass
F2a  201  pass
F2b  409  pass
F3a  200  pass
F3b  412  pass
F3c  201  FAIL expected 412, received 201
F4   200  pass
```

The redacted requests and responses are in `../2026-11-17-list-if-match-probe/`.

## The campaign

| Scenario | Verdict | What happened |
|---|---|---|
| s1 implicit parent folder on a content PUT | MEASURED | Published deleted (204); save answered created; Published EXISTS again |
| s2 publication name case on lookup | PASS | uploaded 201; verify with wrong case present=false; get_assessment publication present=false; transition with wrong case refused; after rename verify present=true |
| s3 executive summary create, read back, overwrite | PASS | create created (hash matches), read ok, overwrite overwritten (stage EXECUTIVE_SUMMARY) |
| s4 four concurrent opens for one vendor | PASS | 1 assessment item(s) for the vendor, 1 distinct id(s) returned, 1 call(s) reported created, 0 error(s) |
| s5 six concurrent overwrites of one dossier | PASS | 6 overwritten, 0 refused or errored, final content is exactly one writer's |
| s6 State and Status edited by hand in the list | MEASURED | State=HANDEDIT (200): record_findings proceeded; Status=Completed (200): a save was refused |
| s7 grant boundary: a site the server was never granted | PASS | tenant root site answered 403; site search found 0 site(s), 0 outside the granted one |
| s8 resume after a subfolder goes missing | PASS | Evidence deleted (204); second open answered created=false resumed=true; Evidence is back; 1 item(s) for the vendor |

## The runner's own calls, in order

| Call | Outcome | Message |
|---|---|---|
| open_assessment | ok | Opened ASM-2026-00030 for Sitting Check 1117T2353 (Security): item 30 in IW Probe Assessments, workspace IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030, root and 3 subfolders read back. |
| save_assessment_artifact | ok | Created IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030/Research/Sitting Check 1117T2353_Research_Dossier.md: read back 56 bytes, sha256 877321ba5eeb, matching what was sent. Stage DOSSIER recorded on IW Probe Assessments item 30. |
| record_findings | ok | Findings for ASM-2026-00030: 1 created, 0 updated, 0 unchanged. Each finding written was answered with the values sent. The summary and stage FINDINGS were recorded on IW Probe Assessments item 30, and Graph's answer matched what was sent. |
| get_assessment | ok | 23 assessments in IW Probe Assessments with Status "In Progress": PRB-20261107T203526Z-00001 for probe 20261107T203526Z (no scope), PRB-20261107T203924Z-00002 for probe 20261107T203924Z (no scope), ASM-2026-00004 for Campaign S1 11091936 (Security), ASM-2026-00006 for Campaign S3 11091936 (Security), ASM-2026-00007 for Campaign S4 11091936 (Security), ASM-2026-00008 for Campaign S4 11091936 (Security), ASM-2026-00009 for Campaign S4 11091936 (Security), ASM-2026-00010 for Campaign S4 11091936 (Security), ASM-2026-00011 for Campaign S5 11091936 (Security), ASM-2026-00013 for Campaign S8 11091936 (Security), ASM-2026-00014 for Campaign S1 11092229 (Security), ASM-2026-00015 for Campaign S2 11092229 (Security), ASM-2026-00016 for Campaign S3 11092229 (Security), ASM-2026-00017 for Campaign S4 11092229 (Security), ASM-2026-00018 for Campaign S5 11092229 (Security), ASM-2026-00020 for Campaign S8 11092229 (Security), ASM-2026-00023 for Campaign S1 11172355 (Security), ASM-2026-00024 for Campaign S2 11172355 (Security), ASM-2026-00025 for Campaign S3 11172355 (Security), ASM-2026-00026 for Campaign S4 11172355 (Security), ASM-2026-00027 for Campaign S5 11172355 (Security), ASM-2026-00029 for Campaign S8 11172355 (Security), ASM-2026-00030 for Sitting Check 1117T2353 (Security). |
| get_assessment | ok | ASM-2026-00030: item 30 in IW Probe Assessments, status "In Progress", state "FINDINGS". Workspace root IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030 is present. Artifacts present: dossier. Journal entries: 10. On what this call read: save_assessment_artifact, record_findings and transition_assessment to provisional would proceed; transition_assessment to completed would be refused (expected the publication present at its canonical path, observed not present). Summary: "One finding, written by the sitting runner." Findings recorded: 1. F-1 (Low): A first line.  A second paragraph. Recommendation: None needed. Journal, oldest first: 2026-11-17T23:56:42.418Z ID list_item_updated IW Probe Assessments/30; 2026-11-17T23:56:42.953Z ID folder_created IW-Assessments/Sitting Check 1117T2353; 2026-11-17T23:56:43.189Z ID folder_created IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030; 2026-11-17T23:56:43.564Z ID folder_created IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030/Research; 2026-11-17T23:56:43.822Z ID folder_created IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030/Evidence; 2026-11-17T23:56:44.055Z ID folder_created IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030/Published; 2026-11-17T23:56:45.712Z DOSSIER file_created IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030/Research/Sitting Check 1117T2353_Research_Dossier.md; 2026-11-17T23:56:46.524Z DOSSIER list_item_updated IW Probe Assessments/30; 2026-11-17T23:56:47.455Z FINDINGS list_item_created IW Probe Findings/6; 2026-11-17T23:56:47.644Z FINDINGS list_item_updated IW Probe Assessments/30. |
| transition_assessment | refused | transition_assessment refused the LIFECYCLE stage for ASM-2026-00030: expected the publication present at its canonical path, observed not present. Read to decide: drive IW-Assessments/Sitting Check 1117T2353/ASM-2026-00030/Published/Sitting Check 1117T2353_ASM-2026-00030_Risk_Assessment.docx: not found. Nothing was written. |
| open_assessment | connection closed | MCP error -32000: Connection closed |
| open_assessment | ok | Resumed ASM-2026-00031 for Sitting Interrupt 1117T2353 1 (Security), which was already in progress: this call created 5 folders. Workspace IW-Assessments/Sitting Interrupt 1117T2353 1/ASM-2026-00031: root and 3 subfolders read back. |
| get_assessment | ok | 1 assessment in IW Probe Assessments for VendorFolder "Sitting Interrupt 1117T2353 1": ASM-2026-00031 "In Progress". |

The seventh call is the open the runner stopped the server under, 1200 ms after sending it.

## The server's call record

39 lines, one per call that settled: 36 ok, 3 refused. The interrupted open left no line, because the process that would have written it was stopped.

| Tool | Calls | Median ms | Longest ms | Graph requests, least to most |
|---|---|---|---|---|
| open_assessment | 13 | 3667 | 7335 | 8 to 19 |
| save_assessment_artifact | 14 | 2166 | 21157 | 12 to 14 |
| verify_publication | 2 | 537 | 537 | 4 to 4 |
| get_assessment | 4 | 680 | 793 | 3 to 8 |
| transition_assessment | 2 | 687 | 687 |  |
| read_assessment_artifact | 2 | 818 | 818 | 6 to 6 |
| record_findings | 2 | 1258 | 1258 | 10 to 10 |
