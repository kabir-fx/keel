---
name: vet
description: The review gate for a finished change or a pull request. Guards the quality bar and runs independent reviewers against the contract, the tests, and the failure modes, with evidence for every finding. Use when a change is complete and needs review before a pull request or merge, or when asked to review a branch, a diff, or a pull request.
argument-hint: "[base ref or pull request number, default the current branch]"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/bar-guard.sh *)
---

# Vet

The gate between "built" and "ready to merge". The author's confidence is not evidence. So the review is done by agents that did not write the change, and they are shown only the artifact and the contract.

## 1. Pin the diff and find the contract

- **The diff**: `git diff <base>...HEAD`, plus any uncommitted changes. The base is the merge base with the default branch, unless I named one. For someone else's pull request, start from a clean tree, run `gh pr checkout <number>`, and use the pull request's base branch. State the exact range.
- **The contract**: the spec and slice, the issue, or the request as I stated it. For a pull request, its description and linked issue. Plus `QUALITY.md`, and the decision records and glossary for the area. With no written contract, write the intended behaviour in three to five lines and use that.
- An empty diff, or a red full check: stop and say so. Review starts from green.

## 2. Guard the bar

Run `${CLAUDE_SKILL_DIR}/scripts/bar-guard.sh <base>`. It lists the places where the diff may have lowered the bar: suppression comments, skipped or deleted tests, removed assertions, stubs, empty error handlers, hook bypasses, changed check configuration.

Judge each hit. An intended one needs a reason in the diff, or an entry under Exceptions in `QUALITY.md`. Anything else is a Critical finding (rule 6). Then compare the change against the numbers and ratchets in `QUALITY.md`: a ratchet may only move in the good direction.

## 3. Review with fresh eyes

Spawn the `reviewer` agents in one message, with the `verifier` if `prove` needs one. Build each brief from [lenses.md](lenses.md): the common lines, then the sections for the lenses that agent covers. A brief never carries how the change was built or what you think of it.

| Rigor | Reviewer agents | Lenses in each brief |
|---|---|---|
| Light | 1 | break-it |
| Standard | 1 | spec, tests, break-it, standards |
| High stakes | 2, on Opus with a fresh context | first: spec, tests, standards. Second: break-it, security |

One agent covers several lenses because every extra agent re-reads the same diff and re-runs the same tests. Add the standards lens only when `QUALITY.md` has review standards. Add the security lens to the break-it brief at any rigor when the diff touches a trust boundary: see [security.md](security.md). When `prove` hands its claims to the review, they go into the brief that has break-it. The rigor comes from `/build`. When called directly, choose it from the diff and say which you chose.

## 4. Reconcile

A reviewer's finding is a claim, not a fact. For each one:

1. Read the cited `file:line` yourself, and run the command behind it.
2. When the tests lens names an edit that should make a test fail, try it: with a clean tree, apply the edit, run the test, record the result, and restore the file with `git restore`. One edit at a time.
3. Classify the finding: **real** (fix it), **trade-off** (mine to decide: state both sides), **contract unclear** (the spec is ambiguous: ask me), or **noise** (say why in one line).

Keep the lenses apart. A change can pass the tests lens and fail the spec lens, and an average hides that. Do not drop a finding because it is inconvenient. Do not accept one you could not confirm.

## 5. Report

- The range reviewed, the commit it ends at, and the rigor.
- Bar guard: clean, or each hit with your ruling.
- Findings per lens, most severe first: `file:line`, what is wrong, the evidence, the classification.
- **Read these yourself**: the two or three places a human should read line by line, with what to look for.
- The verdict: **READY** (no open Critical or Required finding) or **NOT READY**, at the reviewed commit. Which later commits it covers: `${CLAUDE_SKILL_DIR}/../keel/verdicts.md`.

For someone else's pull request, stop here. Draft the real findings as review comments, show them to me, and post them only when I say so.

## 6. Fix, then check the fixes

For my own change there is one review round. Then:

1. Fix each real finding as a new increment through the `tdd` skill. The evidence: the finding's reproduction fails before the fix and passes after it, or, for a test with no teeth, the edit the reviewer named now makes a test fail. Run the full check. That output is the re-check: do not send the agent back.
2. A fix that changes the design gets one scoped re-check. Spawn a new `reviewer` with the re-check brief in [lenses.md](lenses.md), and never resume the first one.
3. If the re-check finds a Critical or Required problem, stop. Findings that keep coming mean the design is the problem: say so, suggest the `architect` skill, and say how many agent runs the change has used. Another agent pass needs my yes.

When every Critical and Required finding is fixed this way, the verdict is READY. It covers the reviewed commit and the fix commits, listed as `verdicts.md` says.
