# Pipeline gates

Keel's own gates (`prove`, `vet`, the bar guard) run only when an agent follows the skill. The pipeline runs whether or not anyone remembers. Every check that matters belongs in the pipeline. The agent-side gates are the earlier, cheaper catch.

## What to check

| Gate | How to check it | Cheapest fix |
|---|---|---|
| CI runs the full check on every pull request | Read the workflow files. The trigger includes pull requests, and the jobs run the full check. | One workflow that runs the full check command. |
| The default branch is protected | `gh api repos/{owner}/{repo}/branches/<branch>/protection` and `gh api repos/{owner}/{repo}/rulesets`. A 403 or 404 means could not tell: say so. | Every CI job required. Branch up to date before merge. No force push, no deletion. One required review when the repo has more than one contributor. |
| Local and CI run the same thing | Compare the commands of the local full check with the commands in the workflows, flag by flag. | One target (`make ci`, `npm run ci`) that the workflow calls, so there is one list. |
| The quality bar is enforced | Each Floor line, number, and ratchet in `QUALITY.md` names a command, and a workflow runs it. | Add the command to CI. A line no command can check moves to Review standards. |
| The fast check runs before a push | A pre-commit or pre-push hook, in whatever tool the repo already uses. | A `pre-push` hook that runs the fast check. |

Report the five as a table of yes, no, or could not tell, with what you read for each. Change nothing without my yes.

## The bar guard as a CI job

`bar-guard.sh` is one self-contained script that needs bash, git, and awk. Copied into the repo, it puts every pull request's suppressions, skipped or deleted tests, removed assertions, stubs, and bypasses on the pull request itself. It runs for every author, human or agent, whether or not a review skill ran.

1. Copy the script into the repo's scripts folder and keep it executable. It ignores its own file.
2. Add a job of its own. Match the action versions the repo's other jobs use.

   ```yaml
   bar-guard:
     if: github.event_name == 'pull_request'
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
         with:
           fetch-depth: 0
       - run: scripts/bar-guard.sh "origin/$BASE"
         env:
           BASE: ${{ github.base_ref }}
   ```

   `fetch-depth: 0` matters: the script needs the base branch to find the merge base. On GitHub Actions it also prints each finding as an annotation, so the hits show on the diff.
3. Leave the job out of the required checks. A hit is a question, not a verdict: a justified suppression must stay mergeable, and I am the judge. The job goes red, I read the findings, and I merge past it only on purpose.

The pull request that adds the job shows one note, because the script reports every change to a workflow file. A note does not fail the job. Only findings do.
