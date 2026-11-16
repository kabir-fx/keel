---
name: prove
description: Prove a change works by exercising the real artifact, with an agent that did not write the code. Use after finishing a change, before claiming something works or is fixed, or when the user asks for proof, evidence, or a check that it actually works.
argument-hint: "[what to prove]"
---

# Prove

Passing tests show the code does what its author thought. Proof shows the software does what its user needs. The difference is the real artifact: the running app, the CLI, the built package, the API over the wire.

## 1. List the claims

Write each thing the change claims as something observable: "`report export --format json` writes a file that `jq .` parses", not "export works". Take the claims from the slice's acceptance criteria, or from the request. Add one claim about a neighbouring behaviour that must not have changed.

## 2. Choose how each is exercised

Use the surface a user or caller touches. Launch with the repo's run recipe: the `## Keel` block in `CLAUDE.md` names it, and the built-in `run` skill launches and drives the app. A library is exercised from a fresh script that imports it the way a consumer would. A bug fix is exercised with the original reproduction.

A claim that can only be checked by reading code is labelled `inferred`. Say what would make it checkable.

## 3. Choose who exercises them

Never the author, from Standard rigor up. Pick the one agent that can:

| The change | Who exercises the claims |
|---|---|
| Light rigor | You. Show the commands and the output, and say that the proof is not independent. |
| Standard, with nothing to launch: a library, a module, a script the tests import | The `vet` reviewer that has the break-it lens. Its brief gets your claims (`${CLAUDE_SKILL_DIR}/../vet/lenses.md`, Claims). A separate verifier would re-read the same diff and re-run the same code. |
| Standard, with something to launch: an app, a CLI, a server, a run recipe | The `verifier` agent. |
| High stakes | The `verifier` agent, on Opus (`model: opus`) with a fresh context. Never Fable. |

The verifier's brief holds the claims, how to launch, the diff range, and a scratch directory. It does not hold how you built the change or why you believe it works. Briefing format: `${CLAUDE_SKILL_DIR}/../keel/subagents.md`. Spawn it in the same message as the `vet` reviewers.

## 4. Check the proof has teeth

Take the most important claim. Break the change in the smallest way (revert the key line, or stash the diff) and re-run that claim's check. It must fail. Restore the change and confirm it passes again. A check that passes either way proves nothing: replace it.

Whoever exercised the claims does this once. An agent works on a copy in its scratch directory, and you read its result instead of repeating it.

## 5. Verdict

| Claim | How it was exercised | Result | Evidence |
|---|---|---|---|

One row per claim, with the command and the relevant output, or a screenshot path. Then one word:

- **VERIFIED**: every claim passed on the real artifact.
- **NOT VERIFIED**: at least one failed. Say which, with the output.
- **INCONCLUSIVE**: something could not be exercised. Say what blocked it and what would unblock it.

Name the commit the verdict covers (`git rev-parse --short HEAD`). Which later commits it still covers: `${CLAUDE_SKILL_DIR}/../keel/verdicts.md`.

List what was not covered. Never round INCONCLUSIVE up to VERIFIED. A failed claim is a finding: fix it as `vet` step 6 says, with the claim's check as its reproduction.

When launching the app took real effort to work out, tell me to run `/run-skill-generator`, so the recipe is saved for next time.
