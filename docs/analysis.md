# Where keel comes from

Keel was designed from three public skill collections and from what Claude Code already ships. This page records what each source is, what keel took, what it left, and why. Counts are from the clones as read in November 2026.

## 1. pstack (poteto)

**What it is.** 58 skills, 23 playbooks, and 2 agents, built first for Cursor and ported to Claude Code. One skill, `poteto-mode`, is the operating mode: it routes each task to a playbook. 24 of the skills are single principles (`principle-fix-root-causes`, `principle-prove-it-works`, `principle-subtract-before-you-add`, and so on) that the other skills cite.

**Its core idea.** An agent's claim is worth nothing until something ran. Almost every skill ends in a demonstration: `interrogate` drops any review finding that was not reproduced, `benchmark-checklist` asks "why is the number not double?", `create-verification-skill` records how to launch the app so that proof is cheap next time. It is also the strongest of the three on design: `architect` writes the caller's usage first, produces competing designs under different constraints, and treats the type sketch as a contract.

**Strong.** Verification discipline. Design method. The principles are sharp and short. Its `reflect`, `correct`, and `sharpen` skills treat the agent's environment as the thing to fix.

**Weak for this setup.** Its best-known skills (`arena`, `swarm`, `interrogate`) get independence by running several vendors' models side by side, which a single Claude subscription cannot do. Much of it assumes Cursor features (automations, cloud agents). 24 principle skills plus 23 playbooks is a large surface to learn, and several skills are personal taste (`bro`, `ketchup`, `unslop`).

**Taken.**

| From | Into |
|---|---|
| the 24 principles | 12 always-on rules, and lines inside the skills that apply them |
| `architect` and its references | `architect`: usage first, design it twice, red flags, the sketch as contract, when to scrap it |
| `interrogate` (a finding must be proven by a run) | the `reviewer` agent's evidence rule, and the break-it lens |
| `principle-prove-it-works`, `create-verification-skill` | `prove`, the `verifier` agent, and the run recipe |
| `benchmark-checklist`, `principle-explain-the-number` | `perf`: the seven questions before a number is reported |
| `blast-radius` | the Risk section of the pull request body |
| `tdd`, `principle-test-behavior-not-implementation` | `tdd` |
| `principle-migrate-callers-then-delete-legacy-apis`, `principle-build-the-lever` | `refactor` |
| `reflect`, `correct`, `sharpen`, `principle-encode-lessons-in-structure` | `/retro` |
| `how`, `why`, `teach`, `in-your-own-words` | `explain` and its four modes |
| `show-me-your-work` | evidence labels (rule 5) and the `/build` report |
| `principle-guard-the-context-window` | context hygiene in `/keel` |
| the `autonomous-run` playbook ("do not park reversible work", "never relax the predicate") | rule 5, the contract walk and the DONE or NOT DONE line in `/build`, and its unattended runs |
| `no-comments` and the `comment-sicko` agent | the comment sentences in rule 12, and the reviewer's rule that a comment is a claim. The rule is kept. The agent is not: it would add a subagent run to every change. |
| the `shipping` playbook (a verdict covers one patch) | verdicts tied to a commit in `prove`, `vet`, and `/ship` |

**Left.** Multi-vendor panels (`arena`, `swarm`). Cursor automations. Formal verification and `statechart`. The taste skills. `typescript-best-practices`, because language rules belong in a repo's own `QUALITY.md`.

## 2. Matt Pocock's skills

**What it is.** 39 skills in four groups: engineering (20), productivity (7), misc (4), and in-progress (8). Small, composable, and written with great care for how an agent reads them.

**Its core idea.** Most agent failures are alignment failures, so align first. `grilling` interviews the user by walking a design tree and asking only the decisions whose prerequisites are settled, each with a recommended answer. Shared language is kept in `GLOSSARY.md`. Decisions are recorded sparingly. Work is cut into tracer-bullet slices that each go through every layer.

**Strong.** The best alignment method of the three. The best vocabulary for module design (depth, seams, adapters). `tdd` gives a usable test for test quality. `diagnosing-bugs` insists on a feedback loop before any hypothesis. `writing-for-agents` explains how to write a skill that an agent follows, and when a skill should be typed by the user or invoked by the model.

**Weak for this setup.** Several skills are tied to an issue tracker (`to-tickets`, `triage`, `wayfinder`). There is little after the pull request: no release, no observability, no security. The misc group is tooling for his own courses.

**Taken.**

| From | Into |
|---|---|
| `grilling`, `grill-me`, `grill-with-docs` | `grill`: the design tree, the frontier, recommended answers, facts looked up and never asked |
| `domain-modeling` | the glossary and decision-record references in `/keel` |
| `to-spec`, `to-tickets` | `/spec`: the template, tracer-bullet slices, blocking edges, a proof per slice (kept in the spec file, not in a tracker) |
| `tdd` | `tdd`: seams agreed first, the two imagined edits, tautologies |
| `diagnosing-bugs` | `diagnose`: the loop first, the ordered ways to build it, ranked hypotheses, tagged debug lines |
| `prototype` | `prototype`: question first, a shape per kind of question, throwaway code |
| `codebase-design`, `improve-codebase-architecture` | the vocabulary in `architect`, and `refactor` |
| `retro` | `/retro` |
| `git-guardrails-claude-code` | the guard hook |
| `setup-pre-commit` | the pre-push item in the pipeline audit of `/repo-setup` |
| `writing-for-agents` | how every keel file is written, and the split between typed and model-invoked skills |

**Left.** Issue-tracker skills. `handoff`, because `/clear`, `/compact`, and files do that job. The in-progress and course-specific skills.

## 3. agent-skills (Addy Osmani)

**What it is.** 25 skills, 9 slash commands, 4 agent personas, 7 reference checklists, a session-start hook, and an evals folder. It maps skills onto the life cycle: define, plan, build, verify, review, ship.

**Its core idea.** Senior engineering process, written down so an agent cannot skip it. Each skill has steps, the excuses an agent uses to skip them, red flags, and an exit checklist.

**Strong.** The only one of the three that covers the whole life cycle. `shipping-and-launch` (rollback plan, staged rollout, thresholds), `observability-and-instrumentation`, and `security-and-hardening` have no equal in the other two. `constraint-driven-development` gives a repo a quality bar with a floor, ratchets, and dated exceptions. `doubt-driven-development` states the rule for independent review most clearly: show the reviewer the artifact and the contract, never the author's claim. `source-driven-development` makes the agent read real documentation before it writes an API call.

**Weak for this setup.** It is long: skills run to hundreds of lines and repeat each other. Several are web-specific. Four personas overlap. Its hook injects a meta-skill into every session, which costs context all the time.

**Taken.**

| From | Into |
|---|---|
| the life-cycle map and its commands | the main line in `/keel` |
| `spec-driven-development`, `planning-and-task-breakdown` | `/spec`: checkable success criteria, and the Always / Ask first / Never boundaries |
| `constraint-driven-development` | `QUALITY.md`, `/repo-setup`, rule 6, and `bar-guard.sh` |
| `doubt-driven-development` | how `vet` and `prove` brief their agents |
| `source-driven-development` | rule 2, and step 2 of `/build` |
| `security-and-hardening` | `vet/security.md`, and the security lens |
| `observability-and-instrumentation` | `observability` |
| `shipping-and-launch`, `git-workflow-and-versioning` | `/ship`, the pull request body, the release reference |
| `deprecation-and-migration` | expand, migrate, contract in `refactor` and `/spec` |
| `performance-optimization` | `perf` |
| `references/definition-of-done.md` | the `/build` report |
| `ci-cd-and-automation` (required checks, branch protection, "failures block merge") | the pipeline audit in `/repo-setup`, and the bar guard as a CI job |
| `code-review-and-quality` ("don't accept I'll clean it up later") | rule 5: nothing moves to a follow-up without a yes |

**Left.** Web-specific skills and the performance persona. Full CI templates: keel audits a pipeline and adds one job, and does not generate workflows. The evals framework. The four personas, replaced by two agents and five lenses. The always-on hook, replaced by a 16-line rules file. The long excuse tables: one rule ("never lower the bar to get green") and a script that looks for the evidence do the same job.

## 4. What each source does best, by stage

| Stage | Strongest source | Keel |
|---|---|---|
| Align | Matt Pocock (`grilling`) | `grill` |
| Specify and slice | Matt Pocock (`to-spec`, `to-tickets`), agent-skills (success criteria, boundaries) | `/spec` |
| Design | pstack (`architect`), Matt Pocock (vocabulary) | `architect`, `prototype` |
| Build | all three agree on small increments and tests first | `/build`, `tdd` |
| Debug | Matt Pocock (`diagnosing-bugs`) | `diagnose` |
| Prove | pstack | `prove`, `verifier` |
| Review | pstack (`interrogate`), agent-skills (`doubt-driven-development`) | `vet`, `reviewer`, `bar-guard.sh` |
| Ship | agent-skills | `/ship` |
| Operate | agent-skills | `observability`, the release reference |
| Maintain | pstack (principles), agent-skills (migration) | `refactor`, `perf` |
| Learn | pstack (`reflect`), Matt Pocock (`retro`) | `/retro`, `explain` |

## 5. One subscription

All three sources reach for independence somewhere: a second opinion that does not share the author's blind spots. pstack gets it from other vendors' models. Keel gets it three ways that one Claude subscription allows:

1. **A fresh context.** The reviewer and the verifier start cold.
2. **A withheld brief.** They get the artifact and the contract, never the author's reasoning.
3. **No second model.** An earlier version put high-stakes agents on a different top-tier model. Every agent now runs on Opus: the fresh context and the withheld brief give the independence.

Fan-out is kept to what the rigor needs: one subagent for a light change, four for a standard one, five at high stakes. Mechanical bulk work goes to a smaller model.

## 6. Claude Code's own commands

Each built-in was judged on whether it gives a better result inside this flow than a keel skill would. Shipping with the product was not a reason to use one.

| Built-in | Verdict | Reason |
|---|---|---|
| `run`, `/run-skill-generator` | used | Launch patterns per project type are plumbing that keel should not copy. The recipe is stored per repo. |
| `/goal` | used | A harness mechanism. A skill cannot keep a session running. |
| `/clear`, `/compact`, `/subtask` | used | Harness mechanisms. |
| `/doctor`, `/skill-doctor`, `/insights` | used | Diagnostics with no keel equivalent worth writing. |
| `/code-review` | left out | It hunts bugs in a diff. It is not given the spec, does not check that the tests have teeth, and its lower effort levels review in the author's own context. `vet` covers the same ground with a break-it lens that demands a reproduction, plus the lenses the built-in lacks. Running both would give two reports to reconcile. |
| `/security-review` | left out | The same reasoning: the security lens runs inside `vet`, against the contract, with one report. |
| `/simplify` | left out | First judged narrow and used inside `/build`. A real run in Claude Code 2.1.325 showed it starts 4 review agents every time: about 66,000 input tokens on a 10-line function, with no findings. That doubled the fan-out of a standard change, so `/build` now cleans up in line. It stays useful by hand on a large diff. |
| `/verify` | left out | It overlaps `prove`, which adds the claims list, the withheld brief, the teeth check, and a three-way verdict. |
| `/plan` | left out | The plan lives in the conversation and is gone after `/clear`. Keel's planning leaves files. |
| `/batch` | left out | Many parallel agents for one mechanical edit. A codemod is deterministic and costs a fraction. |
| `/advisor` | left out | Keel's second opinions come from briefed agents with a withheld context. |
| `/init` | left out | It generates a long `CLAUDE.md`. Keel wants a short one that points at files. |

Keel's skill names avoid the built-in names (`architect` not `design`, `prove` not `verify`, `vet` not `review`, `diagnose` not `debug`), so nothing is shadowed and both stay available.

## 7. What is not known yet

- The choice of `vet` over `/code-review` rests on design, not on a measured comparison. The README gives a cheap way to test it on real work.
- The skills have been checked for structure, and the hook, the bar guard, and the installer have been tested against real inputs. One `/build` ran end to end, headless, on a throwaway repo: it reached DONE with a contract table, a verdict commit, and a real tests-lens finding fixed and re-reviewed. It also showed mutation testing repeated by the verifier, the parent, and the spec lens, which is now assigned to one owner each. The skills have not yet been used on a real project. Expect the first few slices to show where wording needs to change, and use `/retro` for that.
- The built-in list is from one Claude Code version. When a built-in changes, re-judge its row.
