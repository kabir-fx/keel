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

Spawn `reviewer` agents in one message, one lens each. The briefs are in [lenses.md](lenses.md). A brief carries the diff command, the contract, and the lens. It never carries how the change was built or what you think of it.

| Rigor | Lenses |
|---|---|
| Light | break-it |
| Standard | spec, tests, break-it |
| High stakes | spec, tests, security, and break-it, each on Opus with a fresh context |

Add the security lens at any rigor when the diff touches a trust boundary: see [security.md](security.md). Add the standards lens when `QUALITY.md` has review standards. The rigor comes from `/build`. When called directly, choose it from the diff and say which you chose.

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
- The verdict: **READY** (no open Critical or Required finding) or **NOT READY**. It covers that commit and nothing after it.

For someone else's pull request, stop here. Draft the real findings as review comments, show them to me, and post them only when I say so.

## 6. Fix and review again

For my own change, fix real findings as new increments, with tests. Re-run the lens that found each one. Stop after two rounds: when findings keep coming, the design is the problem. Say so, and suggest the `architect` skill.
