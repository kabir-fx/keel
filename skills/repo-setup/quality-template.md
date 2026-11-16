# Quality bar template

`QUALITY.md` is the one place that says what "good enough to merge" means in this repo. Agents read it before building and reviewers check against it. Keep it under a page. Every line must be something a command or a reviewer can check.

```markdown
# Quality bar

A change may never weaken this file, a check, or a test to get green. If a line here is wrong, say so and propose the edit on its own.

## Checks

| Check | Command | When | Typical time |
|---|---|---|---|
| Fast | `<command>` | after every increment | <seconds> |
| Full | `<command>` | before proof, before a PR | <minutes> |

## Floor

Always true on the default branch. A change that breaks one of these does not merge.

- The full check passes.
- <for example: no type errors, no lint warnings>
- <for example: every public function has a test through its interface>
- <for example: no secrets, tokens, or personal data in code, logs, or fixtures>

## Numbers

Measured limits. Each has a command that produces the number.

| What | Limit | Measured by |
|---|---|---|
| <for example: test coverage of src/> | <at least 85%> | `<command>` |
| <for example: p95 of the main request> | <under 200 ms> | `<command>` |

## Ratchets

Numbers not yet where we want them. They may only move in the good direction. Record the new value when a change improves one.

| What | Today | Direction | Measured by |
|---|---|---|---|
| <for example: lint suppressions> | <42> | down | `<command>` |

## Review standards

Judgement a machine cannot check yet. Phrase each so a reviewer can answer yes or no.

- <for example: a new module's interface is smaller than its implementation>
- <for example: an error message says what happened and what the user can do>
- <for example: every comment says something the code cannot: an external constraint, a public contract, a link to a decision>
- <for example, in a UI: every interactive element can be reached and used from the keyboard>

## Exceptions

Deliberate, dated departures from the bar. An exception without an expiry is a lowered bar.

| What | Why | Owner | Expires |
|---|---|---|---|
```

Drop a section that has nothing real in it. An empty table teaches agents to ignore the file.
