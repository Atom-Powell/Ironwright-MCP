# Third live sitting, 2026-11-18: results

Built from the result files `npm run sitting` wrote, which stay under `.superpowers/`, git-ignored.
Site addresses and GUIDs are redacted. Vendor and client names are the runner's and the campaign's own.
The run started 2026-11-18T17:14:46Z from commit `148069a`, against the developer tenant, with each
grant at `write` only for its part of the run. It is the first run of the department step.

## The runner's verdicts

| Step | Verdict | Detail |
|---|---|---|
| If-Match probe on list items | observed | Graph enforced on the fields address, where the server already writes: the fix is one header. L4a 412, L4b 200, L4c 200, L4d 412. |
| campaign | pass | s2, s3, s4, s5, s7 and s8 pass; s1 and s6 measured as before |
| get_assessment by status | pass | ASM-2026-00050 is among 38 in progress |
| get_assessment readback and readiness | pass | 1 finding, 10 journal entries, 4 readiness lines |
| a refusal through a client that lists tools | pass | refused with its evidence: expected "the publication present at its canonical path", observed "not present" |
| an identical save leaves State alone | pass | the save answered unchanged and State still reads FINDINGS |
| open returns a provisional assessment | pass | ASM-2026-00050 was parked as Provisional, and open answered it and created nothing |
| interrupted open | pass | stopped 1200 ms into the open; the retry answered ASM-2026-00051 (created false, resumed true) and the vendor has exactly one assessment |
| department workflow professional-services-onboarding | pass | ONB-2026-00001: opened, saved intake, runbook, one finding recorded, parked as Awaiting Handover, completion refused until handover was uploaded, then completed from Awaiting Handover as Completed |
| department workflow service-desk-incidents | pass | INC-2026-00001: opened, saved timeline, containment, one finding recorded, parked as Contained, completion refused until postmortem was uploaded, then completed from Contained as Closed |
| department workflow technology-success-vendor-risk | pass | ASM-2026-00001: opened, saved dossier, one finding recorded, parked as Provisional, completion refused until publication was uploaded, then completed from Provisional as Completed |
| second site before its grant | observed | the site already answered the server application, so a grant from an earlier run stands; the refusal before a grant was not seen this time |
| grant on the second site | pass | widened from read to write |
| the server application on the second site | pass | resolved the site and its Documents library, found the folder IW-MultiSite, wrote IW-MultiSite/probe 20261118T171446Z.md and read back the 63 bytes it sent |
| the first site under the same token | pass | still resolves with its library: one application, one token, two sites |
| second site grant restored to read | pass | roles after the update: read |
| grant restored to read on ProfessionalServices | pass | roles after the update: read |
| grant restored to read on ServiceDesk | pass | roles after the update: read |
| grant restored to read on TechnologySuccess | pass | roles after the update: read |
| grant restored to read | pass | current roles: read |

All 20 steps answered as expected.

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

Each step answered as it did in both sittings of 2026-11-17. F3c is the known measurement that
`If-Match` on a content PUT does not guard an absent path, which the spec was amended for on 2026-11-07.

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

## Department workflow `professional-services-onboarding`, in order

| Call | Outcome | Message |
|---|---|---|
| open_assessment | ok | Opened ONB-2026-00001 for Pilot Check 1118T1714 (Pilot): item 1 in Onboardings, workspace Clients/Pilot Check 1118T1714/Onboarding/ONB-2026-00001, root and 3 subfolders read back. |
| save_assessment_artifact (kind intake) | ok | Created Clients/Pilot Check 1118T1714/Onboarding/ONB-2026-00001/Intake/Pilot Check 1118T1714_Intake.md: read back 78 bytes, sha256 5821c95fae0a, matching what was sent. Stage INTAKE recorded on Onboardings item 1. |
| record_findings | ok | Findings for ONB-2026-00001: 1 created, 0 updated, 0 unchanged. Each finding written was answered with the values sent. The summary and stage FINDINGS were recorded on Onboardings item 1, and Graph's answer matched what was sent. |
| save_assessment_artifact (kind runbook) | ok | Created Clients/Pilot Check 1118T1714/Onboarding/ONB-2026-00001/Handover/Pilot Check 1118T1714_Runbook.md: read back 79 bytes, sha256 5ef6bbc2fdc0, matching what was sent. Stage RUNBOOK recorded on Onboardings item 1. |
| transition_assessment (target provisional) | ok | Moved ONB-2026-00001 from "In Progress" to "Awaiting Handover" with disposition "Onboarded", risk "Low" and State "LIFECYCLE", as read back from Onboardings item 1. |
| transition_assessment (target completed) | refused | transition_assessment refused the LIFECYCLE stage for ONB-2026-00001: expected the handover present at its canonical path, observed not present. Read to decide: drive Clients/Pilot Check 1118T1714/Onboarding/ONB-2026-00001/Handover/Pilot Check 1118T1714_ONB-2026-00001_Signed_Handover.pdf: not found. Nothing was written. |
| verify_publication (kind handover) | ok | The handover is not at Clients/Pilot Check 1118T1714/Onboarding/ONB-2026-00001/Handover/Pilot Check 1118T1714_ONB-2026-00001_Signed_Handover.pdf; Graph answered 404 for that path. |
| verify_publication (kind handover) | ok | The handover for ONB-2026-00001 is at Clients/Pilot Check 1118T1714/Onboarding/ONB-2026-00001/Handover/Pilot Check 1118T1714_ONB-2026-00001_Signed_Handover.pdf: Pilot Check 1118T1714_ONB-2026-00001_Signed_Handover.pdf, 65 bytes, last modified 2026-11-18T17:18:32Z. |
| transition_assessment (target completed) | ok | Moved ONB-2026-00001 from "Awaiting Handover" to "Completed" with disposition "Onboarded", risk "Low" and State "LIFECYCLE", as read back from Onboardings item 1. |

## Department workflow `service-desk-incidents`, in order

| Call | Outcome | Message |
|---|---|---|
| open_assessment | ok | Opened INC-2026-00001 for Pilot Check 1118T1714 (Pilot): item 1 in Incidents, workspace Incidents/Pilot Check 1118T1714/INC-2026-00001, root and 3 subfolders read back. |
| save_assessment_artifact (kind timeline) | ok | Created Incidents/Pilot Check 1118T1714/INC-2026-00001/Record/INC-2026-00001_Timeline.md: read back 70 bytes, sha256 6f543b5612f3, matching what was sent. Stage TIMELINE recorded on Incidents item 1. |
| record_findings | ok | Findings for INC-2026-00001: 1 created, 0 updated, 0 unchanged. Each finding written was answered with the values sent. The summary and stage FINDINGS were recorded on Incidents item 1, and Graph's answer matched what was sent. |
| save_assessment_artifact (kind containment) | ok | Created Incidents/Pilot Check 1118T1714/INC-2026-00001/Record/INC-2026-00001_Containment.md: read back 73 bytes, sha256 7329cfb2b138, matching what was sent. Stage CONTAINMENT recorded on Incidents item 1. |
| transition_assessment (target provisional) | ok | Moved INC-2026-00001 from "Open" to "Contained" with disposition "Resolved", risk "Low" and State "LIFECYCLE", as read back from Incidents item 1. |
| transition_assessment (target completed) | refused | transition_assessment refused the LIFECYCLE stage for INC-2026-00001: expected the postmortem present at its canonical path, observed not present. Read to decide: drive Incidents/Pilot Check 1118T1714/INC-2026-00001/Review/Pilot Check 1118T1714_INC-2026-00001_Postmortem.docx: not found. Nothing was written. |
| verify_publication (kind postmortem) | ok | The postmortem is not at Incidents/Pilot Check 1118T1714/INC-2026-00001/Review/Pilot Check 1118T1714_INC-2026-00001_Postmortem.docx; Graph answered 404 for that path. |
| verify_publication (kind postmortem) | ok | The postmortem for INC-2026-00001 is at Incidents/Pilot Check 1118T1714/INC-2026-00001/Review/Pilot Check 1118T1714_INC-2026-00001_Postmortem.docx: Pilot Check 1118T1714_INC-2026-00001_Postmortem.docx, 67 bytes, last modified 2026-11-18T17:18:50Z. |
| transition_assessment (target completed) | ok | Moved INC-2026-00001 from "Contained" to "Closed" with disposition "Resolved", risk "Low" and State "LIFECYCLE", as read back from Incidents item 1. |

## Department workflow `technology-success-vendor-risk`, in order

| Call | Outcome | Message |
|---|---|---|
| open_assessment | ok | Opened ASM-2026-00001 for Pilot Check 1118T1714 (Pilot): item 1 in Assessments, workspace Assessments/Pilot Check 1118T1714/ASM-2026-00001, root and 3 subfolders read back. |
| save_assessment_artifact (kind dossier) | ok | Created Assessments/Pilot Check 1118T1714/ASM-2026-00001/Research/Pilot Check 1118T1714_Research_Dossier.md: read back 77 bytes, sha256 939940824965, matching what was sent. Stage DOSSIER recorded on Assessments item 1. |
| record_findings | ok | Findings for ASM-2026-00001: 1 created, 0 updated, 0 unchanged. Each finding written was answered with the values sent. The summary and stage FINDINGS were recorded on Assessments item 1, and Graph's answer matched what was sent. |
| transition_assessment (target provisional) | ok | Moved ASM-2026-00001 from "In Progress" to "Provisional" with disposition "Approved", risk "Low" and State "LIFECYCLE", as read back from Assessments item 1. |
| transition_assessment (target completed) | refused | transition_assessment refused the LIFECYCLE stage for ASM-2026-00001: expected the publication present at its canonical path, observed not present. Read to decide: drive Assessments/Pilot Check 1118T1714/ASM-2026-00001/Published/Pilot Check 1118T1714_ASM-2026-00001_Risk_Assessment.docx: not found. Nothing was written. |
| verify_publication (kind publication) | ok | The publication is not at Assessments/Pilot Check 1118T1714/ASM-2026-00001/Published/Pilot Check 1118T1714_ASM-2026-00001_Risk_Assessment.docx; Graph answered 404 for that path. |
| verify_publication (kind publication) | ok | The publication for ASM-2026-00001 is at Assessments/Pilot Check 1118T1714/ASM-2026-00001/Published/Pilot Check 1118T1714_ASM-2026-00001_Risk_Assessment.docx: Pilot Check 1118T1714_ASM-2026-00001_Risk_Assessment.docx, 68 bytes, last modified 2026-11-18T17:19:06Z. |
| transition_assessment (target completed) | ok | Moved ASM-2026-00001 from "Provisional" to "Completed" with disposition "Approved", risk "Low" and State "LIFECYCLE", as read back from Assessments item 1. |

## The runner's own calls on the first site, in order

| Call | Outcome | Message |
|---|---|---|
| open_assessment | ok | Opened ASM-2026-00050 for Sitting Check 1118T1714 (Security): item 50 in IW Probe Assessments, workspace IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050, root and 3 subfolders read back. |
| save_assessment_artifact (kind dossier) | ok | Created IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Research/Sitting Check 1118T1714_Research_Dossier.md: read back 56 bytes, sha256 877321ba5eeb, matching what was sent. Stage DOSSIER recorded on IW Probe Assessments item 50. |
| record_findings | ok | Findings for ASM-2026-00050: 1 created, 0 updated, 0 unchanged. Each finding written was answered with the values sent. The summary and stage FINDINGS were recorded on IW Probe Assessments item 50, and Graph's answer matched what was sent. |
| get_assessment | ok | 38 assessments in IW Probe Assessments with Status "In Progress": PRB-20261107T203526Z-00001 for probe 20261107T203526Z (no scope), PRB-20261107T203924Z-00002 for probe 20261107T203924Z (no scope), ASM-2026-00004 for Campaign S1 11091936 (Security), ASM-2026-00006 for Campaign S3 11091936 (Security), ASM-2026-00007 for Campaign S4 11091936 (Security), ASM-2026-00008 for Campaign S4 11091936 (Security), ASM-2026-00009 for Campaign S4 11091936 (Security), ASM-2026-00010 for Campaign S4 11091936 (Security), ASM-2026-00011 for Campaign S5 11091936 (Security), ASM-2026-00013 for Campaign S8 11091936 (Security), ASM-2026-00014 for Campaign S1 11092229 (Security), ASM-2026-00015 for Campaign S2 11092229 (Security), ASM-2026-00016 for Campaign S3 11092229 (Security), ASM-2026-00017 for Campaign S4 11092229 (Security), ASM-2026-00018 for Campaign S5 11092229 (Security), ASM-2026-00020 for Campaign S8 11092229 (Security), ASM-2026-00023 for Campaign S1 11172355 (Security), ASM-2026-00024 for Campaign S2 11172355 (Security), ASM-2026-00025 for Campaign S3 11172355 (Security), ASM-2026-00026 for Campaign S4 11172355 (Security), ASM-2026-00027 for Campaign S5 11172355 (Security), ASM-2026-00029 for Campaign S8 11172355 (Security), ASM-2026-00030 for Sitting Check 1117T2353 (Security), ASM-2026-00031 for Sitting Interrupt 1117T2353 1 (Security), ASM-2026-00033 for Campaign S1 11180454 (Security), ASM-2026-00034 for Campaign S2 11180454 (Security), ASM-2026-00035 for Campaign S3 11180454 (Security), ASM-2026-00036 for Campaign S4 11180454 (Security), ASM-2026-00037 for Campaign S5 11180454 (Security), ASM-2026-00039 for Campaign S8 11180454 (Security), ASM-2026-00041 for Sitting Interrupt 1118T0423 1 (Security), ASM-2026-00043 for Campaign S1 11181716 (Security), ASM-2026-00044 for Campaign S2 11181716 (Security), ASM-2026-00045 for Campaign S3 11181716 (Security), ASM-2026-00046 for Campaign S4 11181716 (Security), ASM-2026-00047 for Campaign S5 11181716 (Security), ASM-2026-00049 for Campaign S8 11181716 (Security), ASM-2026-00050 for Sitting Check 1118T1714 (Security). |
| get_assessment | ok | ASM-2026-00050: item 50 in IW Probe Assessments, status "In Progress", state "FINDINGS". Workspace root IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050 is present. Artifacts present: dossier. Journal entries: 10. On what this call read: save_assessment_artifact, record_findings and transition_assessment to provisional would proceed; transition_assessment to completed would be refused (expected the publication present at its canonical path, observed not present). Summary: "One finding, written by the sitting runner." Findings recorded: 1. F-1 (Low): A first line.  A second paragraph. Recommendation: None needed. Journal, oldest first: 2026-11-18T17:17:33.956Z ID list_item_updated IW Probe Assessments/50; 2026-11-18T17:17:34.546Z ID folder_created IW-Assessments/Sitting Check 1118T1714; 2026-11-18T17:17:34.779Z ID folder_created IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050; 2026-11-18T17:17:35.122Z ID folder_created IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Research; 2026-11-18T17:17:35.469Z ID folder_created IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Evidence; 2026-11-18T17:17:35.730Z ID folder_created IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Published; 2026-11-18T17:17:37.817Z DOSSIER file_created IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Research/Sitting Check 1118T1714_Research_Dossier.md; 2026-11-18T17:17:38.772Z DOSSIER list_item_updated IW Probe Assessments/50; 2026-11-18T17:17:45.508Z FINDINGS list_item_created IW Probe Findings/10; 2026-11-18T17:17:45.693Z FINDINGS list_item_updated IW Probe Assessments/50. |
| transition_assessment (target completed) | refused | transition_assessment refused the LIFECYCLE stage for ASM-2026-00050: expected the publication present at its canonical path, observed not present. Read to decide: drive IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Published/Sitting Check 1118T1714_ASM-2026-00050_Risk_Assessment.docx: not found. Nothing was written. |
| save_assessment_artifact (kind dossier) | ok | The dossier at IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050/Research/Sitting Check 1118T1714_Research_Dossier.md already held this content (56 bytes, sha256 877321ba5eeb), so the file was not written. State on IW Probe Assessments item 50 reads "FINDINGS" and was left as it is: a save that writes no file records no stage. Nothing was written. |
| get_assessment | ok | ASM-2026-00050: item 50 in IW Probe Assessments, status "In Progress", state "FINDINGS". Workspace root IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050 is present. Artifacts present: dossier. Journal entries: 10. On what this call read: save_assessment_artifact, record_findings and transition_assessment to provisional would proceed; transition_assessment to completed would be refused (expected the publication present at its canonical path, observed not present). |
| transition_assessment (target provisional) | ok | Moved ASM-2026-00050 from "In Progress" to "Provisional" with disposition "Approved", risk "Low" and State "LIFECYCLE", as read back from IW Probe Assessments item 50. |
| open_assessment | ok | ASM-2026-00050 for Sitting Check 1118T1714 (Security) is already open with status "Provisional"; nothing was written. Workspace IW-Assessments/Sitting Check 1118T1714/ASM-2026-00050: root and 3 subfolders read as folders. |
| open_assessment | cut off |  |
| open_assessment | ok | Resumed ASM-2026-00051 for Sitting Interrupt 1118T1714 1 (Security), which was already in progress: this call created 5 folders. Workspace IW-Assessments/Sitting Interrupt 1118T1714 1/ASM-2026-00051: root and 3 subfolders read back. |
| get_assessment | ok | 1 assessment in IW Probe Assessments for VendorFolder "Sitting Interrupt 1118T1714 1": ASM-2026-00051 "In Progress". |

## The server's call record

The server logged 69 tool calls: 63 ok, 6 refused.
The campaign's calls are in that count and not in the tables above, which hold the runner's own.
