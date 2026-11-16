---
name: repo-setup
description: Prepare a repository for keel. Finds the checks, writes the quality bar, and records the pointers every other keel skill reads.
disable-model-invocation: true
argument-hint: "[nothing, or what to refresh]"
---

# Repo setup

Run once per repo, and again when the checks change. Every other keel skill reads what this writes. Keep the repo's conventions: where it already has an equivalent, point at it. Never create a second one.

## 1. Detect, do not ask

Read what is there: the Makefile, `package.json` scripts, `pyproject.toml`, `go.mod`, `Cargo.toml`, the CI workflows, the pre-commit config, `CLAUDE.md` and `AGENTS.md`, the docs folder, and any existing specs, decision records, or glossary.

From that, work out:

- the **fast check**: what to run after every increment (lint, types, the quick tests). It should take under a minute.
- the **full check**: everything CI runs.
- where specs, decision records, and the glossary live, or should live.
- how the software is launched.

Run the fast check now. Record how long it took and whether it passed. A check that is already red goes in the report: I decide whether to fix it first.

Ask me only what the repo cannot tell you. At most three questions, each with your recommended answer.

## 2. Write the quality bar

Create `QUALITY.md` from [quality-template.md](quality-template.md). Fill it from what the repo enforces today, not from what would be nice.

- A number nobody has measured becomes a ratchet: record today's value and the rule "may only improve".
- If the repo already states its bar somewhere (a contributing guide, a rules section in `CLAUDE.md`), link to it from `QUALITY.md` and add only what is missing.

## 3. Audit the pipeline

A check an agent runs on itself is advice. A check the pipeline runs is a gate. Find out which of these hold, by reading the workflows and asking the host. Report each as yes, no, or could not tell. How to check each one, and the cheapest fix, are in [pipeline.md](pipeline.md).

1. CI runs the full check on every pull request.
2. The default branch is protected: the CI jobs are required, and force pushes are off.
3. The local full check runs what CI runs. List every command CI runs that the local one does not.
4. Every Floor line, number, and ratchet in `QUALITY.md` names a command that CI runs.
5. The fast check runs before a push without anyone remembering it.

For each no, propose the cheapest fix that fits the repo, and wait for my yes before changing anything. A setting on the host, such as branch protection, is mine to apply: give me the exact values.

Then offer the bar guard as a CI job, so every pull request shows its own suppressions, skipped tests, and stubs, whoever wrote it. The script is `${CLAUDE_SKILL_DIR}/../vet/scripts/bar-guard.sh`, and the job is in [pipeline.md](pipeline.md). When the repo already has a copy, compare it with keel's and offer to refresh it.

## 4. Check the run recipe

Proof needs the real thing running. If launching takes one standard command, record it. If it takes more (services, seed data, a login, environment variables), tell me to run `/run-skill-generator` once, so the recipe is saved for every later session.

## 5. Write the pointers

Add this block to `CLAUDE.md`, or refresh it if it exists. Create `CLAUDE.md` if the repo has none. Leave everything else in the file alone.

```markdown
## Keel

- Fast check: `<command>` (after every increment)
- Full check: `<command>` (before proof and before shipping)
- Quality bar: `QUALITY.md`. Never weaken it to make a change pass.
- Specs: `<dir>` · Decisions: `<dir>` · Glossary: `<path>`
- Run recipe: `<path, or "standard launch: <command>">`
```

Do not create an empty glossary or an empty decisions folder. They appear when the first term or decision does.

## 6. Prove the setup

Run the fast check and the full check as written in the block, and `${CLAUDE_SKILL_DIR}/../vet/scripts/bar-guard.sh`. Report: what you detected, what you wrote, what you left alone because it already existed, the check timings, and anything red.
