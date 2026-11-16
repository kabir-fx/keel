---
name: keel
description: Map of the keel suite. Says which skill or built-in command fits the situation you describe.
disable-model-invocation: true
argument-hint: "[what you are trying to do]"
---

# Keel

Answer "what do I use now?" from this map. If I described a situation, name the single next step and why, then stop. Read a skill's own SKILL.md before explaining it in detail.

## The main line

| Stage | Type | What comes out |
|---|---|---|
| Align | `/grill` | One shared understanding. New terms in `GLOSSARY.md`, hard decisions as decision records. |
| Specify | `/spec` | A spec with checkable success criteria, then vertical slices with a proof each. |
| Design | `/architect` | The caller's usage, a type sketch, competing designs compared, a rationale. |
| Build | `/build` | One slice: test-first, proven on the real artifact, vetted, committed. |
| Ship | `/ship` | A PR that carries its evidence, green CI, and for a release a rollback plan. |
| Learn | `/retro` | A better environment: the mistake becomes a check, not a longer prompt. |

A small, clear change skips straight to `/build <what to change>`. Use the whole line when the work is bigger than one sitting, hard to reverse, or still vague. First time in a repo: `/repo-setup`.

## Skills that fire on their own

You can also type them. `/build` calls most of them.

| Skill | Fires when |
|---|---|
| `tdd` | writing or changing tests |
| `diagnose` | something is broken, failing, or flaky |
| `prototype` | a decision depends on something you can only see by running it |
| `refactor` | changing structure without changing behaviour: migrations, removals |
| `perf` | measuring, benchmarking, or speeding something up |
| `prove` | a change needs proof from the real artifact |
| `vet` | a finished change needs its pre-merge gate |
| `observability` | adding logs, metrics, traces, or alerts |
| `explain` | you want to understand code: how it works, why it is this way |

## What keel takes from Claude Code

Keel uses a built-in only where it is a harness mechanism a skill cannot copy, or a narrow tool that does its one job as well as anything keel could add. Every other job has one keel skill, so there is one way to do it.

| Need | Built-in | Why this one |
|---|---|---|
| Launch and drive the app | the `run` skill, with the recipe saved once by `/run-skill-generator` | It knows launch patterns per project type and stores the recipe in the repo. `prove` adds the claims, the independent verifier, and the verdict. |
| Work until a condition holds | `/goal <condition>` | Only the harness can keep a session going. `/build` supplies the discipline. |
| Manage context | `/clear`, `/compact`, `/subtask` | Harness mechanisms. |
| Audit instruction and skill cost | `/doctor`, `/skill-doctor`, `/insights` | Diagnostics that feed `/retro`. |

Left out of the flow on purpose: `/code-review` and `/security-review` (`vet` reviews against the contract with independent reviewers), `/verify` (`prove`), `/plan` (`/grill`, `/spec`, and `/architect` leave files that outlive the session), `/batch` (`refactor` writes a codemod), `/init` (`/repo-setup`), `/simplify` (it starts four review agents on every run, as many as a whole standard review: `/build` cleans up in line, and you can still type it on a diff too large to reread).

## Situations

- "I am starting a new project." Use `/grill`, then `/spec`. Make the first slice the walking skeleton with its checks, then run `/repo-setup`.
- "I have an idea but it is fuzzy." Use `/grill`.
- "I know what I want and it is big." Use `/spec`, then `/build` per slice in fresh sessions.
- "Which of these approaches?" If you can observe the answer, `prototype`. If it is a question of shape, `/architect`.
- "It is broken." Use `diagnose`. If it is slow, `perf`.
- "The agent says it is done." Use `prove`, then `vet`.
- "It stops early, or leaves work for later." Type `/goal <the slice's proof command passes and the full check is green>` before `/build`. The harness keeps the session working until that holds.
- "I have to review someone's pull request." Use `vet <number>`.
- "I inherited this code." Use `explain`, then `refactor` if it must change shape.
- "It keeps making the same mistake." Use `/retro`.

## Context hygiene

Decide at a phase boundary (after grilling, after a slice, after a review), never mid-phase. The first yes wins:

1. Does the next phase need this conversation word for word, and is there room for it? Continue.
2. Is everything here disposable for what comes next? `/clear`. Slices start this way: the spec is the memory.
3. Can the next task run without me? Hand it to a subagent (`/subtask`) and keep this window.
4. Otherwise `/compact <what the next phase needs>`.

Mid-phase, keep going or split the remainder into subagents. What must survive a session lives in files (the spec, decision records, the glossary, commits), not in the conversation.

## Shared references

Other keel skills point here: [adr.md](adr.md), [glossary.md](glossary.md), [subagents.md](subagents.md).
