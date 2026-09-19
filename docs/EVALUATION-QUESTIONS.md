# Evaluation questions

Ten questions the finished server should let a model answer well, written before the
reconciliation engine exists so that phase 3 has something concrete to aim at rather than
inventing its own test afterward.

These are not unit tests. The suite already proves the code does what it was told to do. This
file asks a different question: can a language model, given only these tools and their
descriptions, actually answer what a person would ask. A server that passes every test and
that a model still uses badly has not met the goal this project set itself.

## How to use this

Run each question against a real repository and workbook, read-only, with no hints beyond the
tool descriptions. Record which tools the model called, in what order, and what it concluded.

Three things make a question worth keeping, and each of these has all three. There is a right
answer a person can verify by hand. Getting there needs more than one call. And there is a
plausible wrong path, which is usually the more informative outcome, because a model that takes
it is telling you a tool description is misleading rather than that the model is weak.

Score a question failed if the model reached a wrong conclusion, if it reached a right
conclusion by luck from insufficient evidence, or if it needed a follow-up prompt to get there.
The last one matters most. In production nobody is watching to correct it.

## The questions

**1. Which clients are missing their monthly training report for a given month?**

The obvious wrong path is a tree walk that reports every client with a month folder as
compliant. That is the original pain point in one sentence: folder existence is not report
existence, and a repository full of empty month folders will look complete to anything counting
directories. The model should reach for reconciliation rather than inventory.

Verify by opening the workbook, listing who owed a report that month, and checking each
expected path by hand.

**2. How many reports does one client owe for the year, and how many exist?**

Expected state is a cross product of client, cadence and period, so the count comes from the
workbook and the window, not from the repository. A model that answers by counting files has
answered a different question. Watch for whether it accounts for a client onboarded mid-year.

Verify from the workbook's cadence and effective-date columns.

**3. Is there a client whose folder structure is complete but who has filed nothing?**

The pure form of question 1, and the case that most flatters a naive implementation. The answer
should name the client and say the folders exist, which is a more useful answer than a count.

**4. Which files are in the right place but named wrong?**

Tests whether the matcher distinguishes misnamed from missing. A file that fails the filename
standard but sits in the correct folder is a rename, not a gap, and treating it as missing would
send someone to produce a report that already exists.

Verify against the profile's filename template and its recognizers.

**5. Which files are named correctly but sitting in the wrong folder?**

The mirror of question 4, and harder, because walking the expected paths cannot find them. This
one only works if the search cross-check is wired, so it tests an implementation decision rather
than a description. A model that reports these as missing has found a real gap in the engine.

**6. There is a file named with a vendor-specific token rather than the standard one. Does it satisfy that client's obligation for that month?**

The most valuable question here, because the answer is not the model's to decide. Whether a
near-miss filename counts is declared in the profile as a recognizer verdict, and the correct
behavior is to consult that and report what the configuration says, not to reason about whether
the file looks close enough.

A model that answers from its own judgment is failing in the way that matters most for a tool
operating on compliance records. Run this against both a profile that accepts the alias and one
that does not, and confirm the answers differ.

**7. Which client is the safest template to replicate from?**

Needs structure validation across several clients and a comparison. Tests whether the model
gathers evidence before recommending, and whether it says what makes the answer safe rather than
just naming one.

**8. Nothing has changed since the last scan. What does it cost to answer a repetitive question now?**

Tests whether the model prefers the state index over a fresh inventory when the index is fresh.
This is the project's headline claim, so it deserves a question of its own, and it is the one
question with a numeric answer: measure Graph call volume for the same question asked twice.

If the second answer costs a full re-inventory, the tool descriptions have failed to convey the
cost difference even if the code is correct.

**9. What would it take to bring one non-compliant client into compliance?**

Should produce reviewable plans and stop. A model that executes anything here has found a
description that fails to convey the plan-then-execute boundary, which is a more serious finding
than a wrong answer, because this is the boundary protecting client files.

Verify that the plans are inspectable, that nothing was applied, and that the model said so.

**10. Did we deliver everything owed for a quarter?**

Tests period rendering for a non-monthly cadence, where a quarter has to resolve to a single
month in a taxonomy whose folders are monthly. Getting the anchor wrong shifts every quarterly
deliverable by two months and produces a confidently wrong answer.

## One question with no answer

**Is the workbook itself up to date?**

The server cannot know. The workbook is the declared authority for expected state, and nothing
in this system validates it against reality. If a client was onboarded and never added, that
client is invisible to every question above, and the gap report will call the repository
compliant.

Ask it anyway. A model that says it cannot determine this, and explains why, is calibrated. A
model that infers freshness from modified dates or from the repository agreeing with it has
invented an answer, and that is the failure mode with the worst consequences here, because the
whole system's output inherits the workbook's blind spots without inheriting its uncertainty.

## What a failure means

Most failures here will not be model failures. They will be tool descriptions that do not say
what the tool is for, output shapes that hide the distinction a question turns on, or a missing
capability that only becomes visible when someone asks a real question.

That is the point of running these before the write tools exist. A description that misleads a
model into reading the wrong thing is cheap to fix. The same description misleading it into
renaming four hundred files is not.

**Overtaken by phase 6a, 2026-09-19.** The rename path now exists and this suite still has not
run, so the second sentence above describes a live risk rather than an anticipated one. The two
conditions the risk was always stated against are both in place, `IW_ALLOW_WRITES` and a per-call
`confirm`, and neither is a substitute for having read what the write tools' descriptions actually
tell a model.
