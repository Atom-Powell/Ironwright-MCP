# Journal list probe, 2026-11-18 (UTC 2026-11-19T03:23Z)

Run by `.superpowers/write-session.ps1 -JournalProbe` against the developer tenant's Service Desk site, the server application at write for the run and put back to read after. Output as printed:

```
PASS     J1 create the journal list: "IW Probe Journal 20261119T032342" created; all 11 columns read back
PASS     J2a AssessmentId created indexed: the column reads back indexed true
PASS     J2b Target created multi line: the column reads back allowMultipleLines true
PASS     J3 the server application creates an entry: created, and the 400 character target read back whole
PASS     J2c filter on AssessmentId without the non-indexed header: answered 200 over 2 pages
PASS     J4 one id's entries, across pages: 60 of 60 entries for PROBE-A over 2 pages, and 0 for any other id
OBSERVED J5 left behind: the list "IW Probe Journal 20261119T032342" holds 63 probe entries and is left for inspection; delete it when done
```
