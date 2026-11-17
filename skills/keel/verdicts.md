# Verdicts

`prove` ends in VERIFIED, NOT VERIFIED, or INCONCLUSIVE. `vet` ends in READY or NOT READY. Each verdict names the commit it was reached on. This file says which later commits it still covers, and where it is written down.

## What a verdict covers

The commit it names, plus each later commit that does only one of these:

- **Fixes a finding of that verdict without changing the design**, and shows the fix: the finding's reproduction or mutant fails before the fix and passes after it, and the full check is green. For a wording finding, the corrected line is the evidence.
- **Records the result**: ticks and status in the spec, a progress note, a figure in the quality bar, the brief's Result.

Changing the design means a new or changed interface, module, data structure, or algorithm. A design-changing fix gets one scoped re-check (`vet` step 6). Any other later change to code, tests, or check configuration is not covered: prove and vet what it touched.

Decision records and glossary entries are part of the change, not a record of the result. Write them before proof and review, so the reviewer reads them.

## The verdict record

`/build` writes it when both verdicts are in, and updates it after each covered commit. `/ship` reads it, so shipping can start after `/clear`.

Path: `.scratch/verdicts/<branch>.md`. It stays out of git: if `git check-ignore -q .scratch/x` fails, add `.scratch/` to `.git/info/exclude`.

```markdown
# Verdicts: <branch>

Proof: <verdict> at <commit>, exercised by <the verifier | the reviewer | me, not independent>
Review: <verdict> at <commit>, by <n> reviewer agent(s)
Agent runs: <n>

Covered since <commit>:
- <commit> <subject>: fixes <finding>. <before and after output, or the corrected line>
- <commit> <subject>: records the result

## Evidence

| Claim | How it was checked | Result | Label |
|---|---|---|---|

## Read these yourself

- `<file:line>`: <what to look for>
```
