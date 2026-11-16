# Keel

A small suite for building software with Claude Code: 12 always-on rules, 17 skills, 2 review agents, and 1 safety hook. It covers the whole life of a change, from a fuzzy idea to a release you watched work, and it runs on one Claude subscription.

It was designed from three public skill collections. [docs/analysis.md](docs/analysis.md) says what was taken from each, what was left out, and why.

## The change in how you work

A naive loop: write a prompt, let the agent build, look at the result or trust the tests the agent wrote. Keel replaces it with three habits.

1. **Decide before the agent builds.** The agent finds every fact itself. You answer only the real decisions, each with a recommended answer in front of you. What you decide is written down (a spec, a decision record, a glossary term), so the next session starts from files and not from memory.
2. **"The tests pass" is not proof.** A change is done when the real thing ran: the CLI, the app, the API. An agent that did not write the code exercises it, and reviewers that never saw the author's reasoning try to break it. Every finding needs evidence.
3. **Spend your attention where it pays.** Every report ends with "Read these yourself": the two or three places where a mistake would cost the most. A mistake that happens twice becomes a check (a type, a lint rule, a test), not a longer prompt.

## Install

```sh
./install.sh             # install or refresh
./install.sh --dry-run   # show what would change
./install.sh --uninstall # remove everything it added
```

It symlinks the skills, agents, and rules into your Claude Code config directory (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), so edits in this folder are live. It adds one hook entry to `settings.json` and leaves a one-time copy at `settings.json.keel-backup`. It needs `jq` for the hook. Start a new session afterwards and type `/keel`.

## A day with keel

| You are | Type | What you get |
|---|---|---|
| Not sure what to use | `/keel <situation>` | the one next step |
| In a repo for the first time | `/repo-setup` | the checks found, `QUALITY.md`, a pointer block in `CLAUDE.md`, and an audit of the pipeline |
| Starting from a fuzzy idea | `/grill` | an interview, one round of decisions at a time |
| Planning work bigger than one sitting | `/spec` | a spec with checkable success criteria, then vertical slices |
| Making a small, clear change | `/build <what to change>` | the change, test-first, proven, reviewed, committed |
| Building a slice | `/build docs/specs/x.md slice 2` | the same, against the slice's acceptance criteria |
| Facing a bug | "this is broken: ..." | `diagnose` builds a failing loop before it guesses |
| Reviewing a pull request | `/vet 123` | findings with evidence, drafted as comments |
| Opening a pull request, releasing | `/ship` | a PR that carries its evidence. It asks before every push. |
| Seeing the same mistake again | `/retro` | a check that prevents it |
| Trying to understand code | `/explain how ...`, `/explain quiz ...` | a traced path with `file:line`, or a quiz |

## The flow

```
/grill ──▶ /spec ──▶ /architect ──▶ /build ──────────────────────▶ /ship ──▶ /retro
 align     specify    design         tdd ▶ clean up ▶ prove ▶ vet    PR, CI,    fix the
           + slice                   one slice per fresh session     release    environment
```

A small change skips straight to `/build`. Use the whole line when the work is bigger than one sitting, hard to reverse, or still vague.

## What is in the box

**Rules** ([rules/keel.md](rules/keel.md)). Twelve lines that load in every session: restate first, facts are the agent's and decisions are yours, smallest change, evidence labelled `verified`, `inferred`, or `guess`, done means the whole contract with nothing moved to a follow-up, never lower the bar to get green, fix the cause, no comment unless the code cannot say it.

**Skills you type**

| Skill | Job |
|---|---|
| `/keel` | The map. Names the next step. |
| `/repo-setup` | Prepares a repo: checks, quality bar, pointers, and an audit of what the pipeline enforces. |
| `/spec` | Writes the spec, then slices it. |
| `/build` | One change, end to end. Picks the rigor. |
| `/ship` | Pull request, CI, merge, release with a rollback plan. |
| `/retro` | Turns a mistake into a check. |

**Skills that also fire on their own**

| Skill | Fires when |
|---|---|
| `grill` | you ask to be interviewed or challenged on a plan |
| `architect` | a change crosses a module boundary or is hard to reverse |
| `prototype` | a decision depends on something you can only see by running it |
| `tdd` | tests are being written or changed |
| `diagnose` | something is broken, failing, or flaky |
| `refactor` | structure changes and behaviour must not |
| `perf` | something is slow, or a number is about to be reported |
| `prove` | a change needs proof from the real artifact |
| `vet` | a change or pull request needs review |
| `observability` | logs, metrics, traces, or alerts are being added |
| `explain` | you want to understand code |

**Agents.** `verifier` exercises the real artifact and returns PASS, FAIL, or INCONCLUSIVE per claim. `reviewer` reviews a diff through the lenses its brief names (spec, tests, break-it, security, standards), and runs the proof's claims when there is nothing to launch. Neither can edit files, and neither is told how the change was built.

**Hook** ([hooks/guard.sh](hooks/guard.sh)). Denies a force push to the default branch and `rm -rf` of home or root. Asks before other force pushes, direct pushes to the default branch, `git reset --hard`, `git clean -f`, discarding the whole tree, `--no-verify`, `gh pr merge`, a `gh api` call that changes branch protection, releases, and package publishes. Silent otherwise. It is a seatbelt that reads command text, not a sandbox. Start Claude Code with `KEEL_GUARD=off` to switch it off for a session.

**Scripts.** `skills/vet/scripts/bar-guard.sh` lists where a diff may have lowered the bar (suppressions, skipped or deleted tests, removed assertions, stubs, empty handlers, bypasses). `/repo-setup` offers to copy it into a repo as a CI job. `scripts/check.sh` tests keel itself.

**Who runs each gate.** This decides how much a gate can be trusted.

| Gate | Run by | Holds when the agent skips a step? |
|---|---|---|
| The Bash hook | the harness, on every command | yes |
| The contract walk, `prove`, `vet`, the bar guard inside `vet` | the agent, when it follows `/build` | no |
| CI, branch protection, the bar guard as a CI job | the pipeline, on every pull request | yes |

That is why `/repo-setup` audits the pipeline, and why `/ship` ties each verdict to a commit and never merges past a required check ([pipeline.md](skills/repo-setup/pipeline.md)).

## The rigor dial

`/build` picks a level, says why, and you can override it.

| | Light | Standard | High stakes |
|---|---|---|---|
| Fits | small, reversible, one module | a slice or a feature | auth, money, user data, migrations, public interfaces, concurrency |
| Design | interface named in the restate | `architect` when a boundary changes | `architect`, your approval before logic |
| Proof | exercised by the author, labelled as not independent | the reviewer, or the `verifier` agent when there is something to launch | `verifier` agent on Opus, fresh context |
| Review | 1 reviewer | 1 reviewer, every lens | 2 reviewers |
| Agents | 1 | 1, or 2 with something to launch | 3 |

There is one review round. Fixes are checked with each finding's own reproduction, and a commit that only fixes a finding or records the result stays covered by the verdict ([verdicts.md](skills/keel/verdicts.md)). A second agent pass runs only when a fix changes the design, and it checks only that diff.

## What keel uses from Claude Code, and what it does not

Each built-in was judged on one question: for this job, does it give a better result inside this flow than a keel skill would?

| Built-in | Verdict | Reason |
|---|---|---|
| `run`, `/run-skill-generator` | used | Launching apps per project type is plumbing. The recipe is saved in the repo. `prove` adds claims, independence, and a verdict. |
| `/goal` | used | Only the harness can keep a session running until a condition holds. `/build` adds the discipline. |
| `/clear`, `/compact`, `/subtask` | used | Harness mechanisms for context. |
| `/doctor`, `/skill-doctor`, `/insights` | used | Diagnostics that feed `/retro`. |
| `/code-review`, `/security-review` | not in the flow | They review a diff without the contract. `vet` checks the change against the spec, checks that the tests have teeth, demands a reproduction for every bug claim, and gives the reviewer a fresh context with none of the author's reasoning. Two review tools would mean two reports to reconcile. |
| `/simplify` | not in the flow | It starts 4 review agents on every run. Measured on a 10-line function in Claude Code 2.1.325: about 66,000 input tokens and no findings, on top of the 4 subagent runs a standard change already costs. `/build` cleans up in line instead. Type `/simplify` yourself on a diff too large to reread. |
| `/verify` | not in the flow | `prove` is the one proof procedure. |
| `/plan` | not in the flow | Its plan lives in the conversation. `/grill`, `/spec`, and `/architect` leave files that outlive the session. |
| `/batch` | not in the flow | Many parallel agents for one mechanical change. A codemod makes the same edit every time and costs far less. |
| `/init` | not in the flow | `/repo-setup` writes a short pointer block, not a long generated `CLAUDE.md`. |

Apart from `/simplify`, these verdicts come from how each tool is designed, not from a measured comparison. To test the biggest one: for your first five slices, run `/code-review` once after `vet` says READY. If it finds a real bug that `vet` missed more than once, bring that to `/retro` and change `vet`.

## Files keel writes in your repos

| File | Written by | Holds |
|---|---|---|
| `## Keel` block in `CLAUDE.md` | `/repo-setup` | the fast check, the full check, and where everything else lives |
| `QUALITY.md` | `/repo-setup` | the floor, measured limits, ratchets, review standards, dated exceptions |
| a copy of `bar-guard.sh` and one CI job | `/repo-setup`, only on your yes | the bar guard on every pull request |
| `docs/specs/<slug>.md` | `/spec` | the spec, and its slices with status |
| `GLOSSARY.md` | `grill`, when a term is pinned | one meaning per word |
| decision records | `grill`, `architect` | hard-to-reverse decisions, one to three sentences each |

A repo's own conventions win. Keel points at what exists and does not create a second copy.

## What it costs

- **Every session**: the rules (about 510 words) and the descriptions of the 11 model-invoked skills (about 2,900 characters). `scripts/check.sh lint` prints the current numbers.
- **Per change**: light is 1 subagent run. Standard is 4 (a verifier and 3 reviewers). High stakes is 5.
- **Measured once** (Claude Code 2.1.325, Fable 5.2, a throwaway repo): `/build` forced to standard rigor on a 10-line `median` function made 6 subagent runs, because a real tests-lens finding meant a second review. It used about 1.85M input tokens, almost all cache reads, and 72k output tokens: about $6.40 at API list prices, and a large share of a 5-hour usage window. A change that small fits light rigor.
- **Context**: start each slice in a fresh session. The spec is the memory. `/keel` has the rules for when to continue, clear, hand off, or compact.

## Changing keel

Edit the files here. They are live through the symlinks. Run `scripts/check.sh` after any edit: it checks every skill and reference, runs the guard hook against a table of commands, runs `bar-guard.sh` against a throwaway repo, and round-trips the installer. When a keel skill misfires, `/retro` proposes the edit as a diff.

Keep it small. Before adding a skill, ask whether a rule, a line in an existing skill, or a check in the repo would do the job.
