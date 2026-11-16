---
name: ship
description: Take a vetted change to a pull request, through CI, and for a release through rollout with a rollback plan. Asks before every push, merge, and deploy.
disable-model-invocation: true
argument-hint: "[pr | merge | release] [notes]"
---

# Ship

Everything here is visible to other people or hard to undo. Ask me before each push, each merge, and each deploy, every time. An earlier yes does not carry over.

## 1. Preflight

- The tree is clean, and the branch is not the default branch.
- The full check passes now, on this commit. Show the output.
- The change has been through `prove` and `vet`. The verdicts and their commit are in the `/build` report in this conversation, or in the spec as `Status: done (<commit>)`. Finding neither means it has not: say so and offer to run them. Do not ship past a NOT VERIFIED or NOT READY verdict without my explicit say.
- The verdicts still describe the code. Run `git diff --stat <verdict commit>..HEAD`. A change to code, tests, or check configuration after the verdict was never proven or reviewed: run the `vet` skill with the verdict commit as its base, and the `prove` skill for the claims those commits touch.
- The branch is up to date with its base. If it is behind, bring the base in and re-run the full check.
- The diff holds only this change: no debug lines, no scratch files, no secrets, no unrelated edits. Read `git diff <base>...HEAD --stat`.

## 2. Tidy the history

The commits should read as the story of the change: small, single-purpose, conventional messages, a failing test before its fix (rule 9). Rework them only while the branch is unpushed. Never rewrite history that is already on the remote without asking.

## 3. Open the pull request

Write the body from [pr-body.md](pr-body.md). It carries the evidence, so the reviewer does not have to trust either of us. After I say yes, push the branch and run `gh pr create`. Give me the URL.

One pull request per slice. Past roughly 400 changed lines, say so and propose a split.

## 4. Get CI green

Watch the run with `gh pr checks --watch`. For each failure, read the log before touching anything, and classify it:

- **Caused by the diff**: fix it through the `diagnose` skill, as a new commit. Never by weakening the check (rule 6).
- **Stale base**: update the branch and re-run.
- **Flake**: re-run once. If it passes, report the flaky test by name. If it fails again, it is not a flake.

Answer every review comment: fix it, or say why not. Do not resolve a thread you did not address.

A commit pushed after the verdicts is not covered by them. Before asking to merge, run the preflight check "the verdicts still describe the code" again, and update the verdict line in the pull request body.

## 5. Merge

Only when I ask. Before merging, read back the pull request, the CI state, the approvals, and the merge method this repo uses.

- Every required check has passed on the head commit. Pending, skipped, or cancelled is not passed.
- A red check that is not required, such as the bar guard job, is mine to judge. Show me its findings and wait.
- Never merge with an admin override, and never change branch protection to get a merge through.

After merging, confirm the default branch is green.

## 6. Release

When the change reaches users (a deploy, a package publish, a tagged release), follow [release.md](release.md). The rollback plan is written before the rollout starts.
