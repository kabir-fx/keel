---
name: build
description: Build one change end to end. Restates it, shapes it, builds it test-first in small commits, proves it on the real artifact, vets it, and reports with evidence.
disable-model-invocation: true
argument-hint: "<spec path and slice number, issue, or description of the change>"
---

# Build

Take one change from request to a vetted, committed result. One slice, one issue, or one described change per run. Stop before pushing: `/ship` does that.

## 1. Orient

- Read the input: the spec and the slice, the issue, or my description. Read the `## Keel` block in `CLAUDE.md`, `QUALITY.md`, and the glossary terms and decision records for the area. With no `## Keel` block, use the checks you can find and suggest `/repo-setup` in the report.
- Check the starting state: `git status` clean or explained, a branch other than the default one, and the fast check green before you touch anything. Report a red start. Do not build on it.
- Restate (rule 1): the goal, the problem behind it, the smallest change that meets it, your assumptions, and what you will leave alone.
- Pick the rigor. Say which and why. I can override it either way. When unsure, go one level up.

| | Light | Standard | High stakes |
|---|---|---|---|
| Fits | a small, reversible change inside one module | a slice or a feature | auth, money, user data, migrations, public interfaces, concurrency, anything hard to undo |
| Shape | name the interface in the restate | `architect` when a boundary or public interface changes | `architect`, with my approval before any logic |
| Tests | `tdd` for any behaviour change | `tdd` at the agreed seams | `tdd`, plus a property test or a failure-path test |
| Proof | `prove`, exercised by you | `prove`: the reviewer exercises the claims, or the `verifier` agent when there is something to launch | `prove` with the `verifier` agent on Opus, fresh context |
| Review | `vet`, light: 1 reviewer | `vet`, standard: 1 reviewer, every lens | `vet`, high stakes: 2 reviewers |
| Agents | 1 | 1, or 2 with something to launch | 3 |

## 2. Shape

- When the change adds or moves a boundary, use the `architect` skill. At light rigor, name the data shape and the interface in two lines (rule 4).
- For each library call you are not certain of, read the installed source or the docs for the pinned version, and cite what you read. Never write an API from memory.
- An empirical fork goes to the `prototype` skill.
- Agree the seams the tests go through: the spec's, or name them now.
- List the increments. Each adds one behaviour and leaves the checks green.

## 3. Build in increments

For each increment, use the `tdd` skill: a failing test, the least code that passes it, the fast check, a commit (rule 9).

- A failure you do not understand after two tries: stop guessing and use the `diagnose` skill.
- The same workaround a second time: the shape is wrong. Return to step 2.
- Something unrelated is broken: note it for the report. Do not fix it here (rule 3).
- The work is bigger than the slice: stop and tell me. Never widen the scope silently. Never shrink it silently either: a slice delivered in part is my call, not yours (rule 5).
- A decision that is mine (rule 2): ask, with your recommended answer. Keep working on what does not depend on it.

## 4. Close the loop

1. Walk the contract. List every acceptance criterion, or every part of the request, with the code and the test that meet it. One that lacks either goes back to step 3 now. It does not go into the report.
2. Run the full check. It is green, and you show the output.
3. Clean up, in line. Read your own diff once as its next maintainer: reuse what the repo already has, delete what the change does not need, rename what misleads. Behaviour stays the same. Re-run the fast check, and commit the cleanup on its own.
4. Use the `prove` skill: the change demonstrated on the real artifact.
5. Use the `vet` skill at the chosen rigor.
6. Findings from proof and review go back through step 3 as new increments. Then prove and vet again what the fix touched: a verdict covers one commit and nothing after it.
7. Only with VERIFIED and READY in hand, update the record: tick the slice's criteria, set `Status: done (<verdict commit>)` in the spec, and update the glossary or a decision record if this change settled something.

Do not push, open a pull request, or merge. That is `/ship`.

## 5. Report

The first line is the state. **DONE** means every acceptance criterion is met and shown, the proof says VERIFIED, and the review says READY: name the commit those verdicts cover. Anything less is **NOT DONE**: say what remains and why you stopped.

Then what changed for the user of the software, then for its maintainer. Then:

- **Evidence**: a table of claim, how it was checked, result, and label (`verified`, `inferred`, `guess`).
- **Decisions I made**: each choice a reviewer might question, with the reason.
- **Outside the contract**: what you noticed and left alone, or found broken elsewhere. Unfinished work inside the contract never goes here. It makes the report NOT DONE.
- **Read these yourself**: the two or three places where a mistake would cost the most, as `file:line`, with what to look for. My review time goes here.
- **Teach-back**: three questions that test whether I understand the change: one on the design, one on a failure mode, one on how it was proven. Give the answers only after I try.
- **Next**: the next unblocked slice, or `/ship`.

## Unattended runs

When I tell you to run without me, or under `/goal`:

- Start only with an exit condition a command can check. If there is none, ask for it first.
- Make one change at a time. The check runs after each: keep the change or revert it.
- For a decision that would be mine, take the reversible option and add a line to `.scratch/decisions.md`: what, why, how to undo.
- Whatever blocks the exit condition is yours to fix: a flaky check, a broken tool, a bug on the path. Fix it in its own commit and return to the goal. Do not park reversible work for me.
- The same failure a third time means the approach is wrong, not that the run is over. Use the `diagnose` skill and take a different route. Stop for me only at a real dead end, with what you tried.
- Never relax the exit condition to reach it (rule 6).
- Stop at anything irreversible or outward-facing.
