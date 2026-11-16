---
name: retro
description: Turn what went wrong or went slowly in a session into a permanent fix to the environment. Prefers a check that makes the mistake impossible over another paragraph of instructions.
disable-model-invocation: true
argument-hint: "[what to look back on]"
---

# Retro

The output is not a list of lessons. It is an environment where the same mistake cannot happen again, at the lowest cost in future context.

## 1. Read what happened

Go through this conversation. If I point at them, also the recent commits, review findings, and CI failures. Collect:

- every correction I made, and anything I had to say twice;
- every finding from `vet` or `prove` that the build should have caught;
- where the time went: wrong turns, re-reading, waiting, permission prompts, missing tools;
- what worked well enough to keep doing on purpose.

Quote the moment for each. A retro built on impressions produces vague rules. For a retro wider than this conversation, the built-in `/insights` report covers past sessions.

## 2. Fix at the highest level that works

For each item, take the first row that fits. A fix in a higher row costs nothing once built. A fix in a lower row costs attention in every future session.

| The problem was | The fix | It lives in |
|---|---|---|
| A mistake a machine can detect | make it impossible: a type, a schema, a module boundary | the code |
| The same, when the code cannot prevent it | make it fail fast: a lint rule, a test, a pre-commit hook, a CI step | the repo's checks |
| A judgement call that went wrong | a review standard a reviewer can answer yes or no | `QUALITY.md` |
| Knowledge the agent lacked | a pointer to where the knowledge lives, not a copy of it | `CLAUDE.md`, the glossary, a decision record |
| Access or tooling the agent lacked | a script, a run recipe, a permission rule, an MCP server | the repo, or settings |
| A keel skill that misfired or stayed silent | an edit to that skill or its description | the keel repo, as a diff |
| A preference of mine that holds everywhere | one line | user memory, or the keel rules |

Before adding any prose instruction, ask two things. Could a check do this instead (rule 11)? Would the agent do this anyway without being told? If either answer is yes, do not write the prose.

## 3. Prove each new check

A check that has never failed is unproven. Recreate the original mistake (check out the bad commit, or re-apply the bad line) and confirm the new check catches it. Then confirm it passes on the good code.

## 4. Prune

Instructions go stale, and every line is read at the start of every session. In the files this retro touches, delete what a check now covers, what repeats, and what no longer holds. The built-in `/doctor` and `/skill-doctor` measure the always-on cost.

## 5. Present, then apply

Show me a table: what happened (with the quote), the fix, where it lives, and the evidence that it works. Apply only the rows I approve, each as its own commit. Changes to shared checks, CI, or keel itself always wait for my yes.
