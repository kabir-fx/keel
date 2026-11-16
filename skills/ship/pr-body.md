# Pull request body

Write for a reviewer with ten minutes and no context. Lead with what they need in order to decide. Leave out the story of how you got there.

Title: `<type>(<scope>): <what changes for the user>`, under 70 characters, in the repo's commit convention.

```markdown
## Why

<The problem, in one or two sentences. Link the spec, the slice, or the issue.>

## What changed

<The behaviour that is different now, from the user's or the caller's side. Then the shape of the change in two to four bullets: the modules touched, and why.>

## Scope

<What this deliberately does not do. What comes in a later pull request.>

## Evidence

| Claim | How it was checked | Result |
|---|---|---|
| <observable behaviour> | `<command>`, or what was exercised | <output, number, or screenshot> |

Proof: <VERIFIED | NOT VERIFIED | INCONCLUSIVE> · Review: <READY | NOT READY> · both at `<commit>`, by agents that did not write the change.

<For a bug: the failing output before and the passing output after. For UI: before and after screenshots. For performance: the numbers, with run count and range.>

## Risk

- Reversible: <yes, by reverting the commit | no, because ...>
- Blast radius: <who or what is affected if this is wrong>
- Rollback: <the exact step>
- Review these first: <`file:line` of the two or three riskiest places>
```

Only put a claim in the Evidence table if it was run. Anything else goes under Risk as unverified.
