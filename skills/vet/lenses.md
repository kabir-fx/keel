# Reviewer briefs

A brief is the common lines, then one section per lens the agent covers, in the order below. Fill the brackets and send it as written. Add nothing about how the change was built or what you think of it.

Every brief starts with these lines:

    Diff: `git diff <base>...HEAD` in <repo path>. Read the changed files in full, not only the hunks.
    Contract: <spec path and slice number, or the intended behaviour in three to five lines>
    Checks: fast `<command>`, full `<command>`
    Scratch directory: <path>. Write nowhere else.
    Lenses: <the lens names below that this brief carries>. Group your findings by lens.

## Spec lens

    Lens: spec. Does the change do what the contract says, all of it, and nothing else?
    - Take the acceptance criteria one by one. For each: met, partly met, or not met, with the `file:line` that implements it and how you checked.
    - Find behaviour the contract did not ask for: extra options, widened scope, changed defaults, unrelated edits.
    - Find contradictions with the decision records, and glossary terms used with a different meaning.
    - Find requirements the code handles only on the happy path.
    - Leave test quality to the tests lens. Do not mutate the code.

## Tests lens

    Lens: tests. Would these tests catch a real bug?
    - For each new or changed test: does it check observable behaviour through the public interface? Would it survive a refactor that keeps the behaviour? Would it fail if the behaviour broke?
    - Hunt tautologies: expected values derived from the code under test, assertions on mocks, assertions that only check a call happened.
    - For the two most important behaviours, name one edit each that should make a test fail: `file:line`, the old text, the new text, and the test to run. Say whether you expect the test to catch it. Do not apply the edit.
    - List the behaviours in the contract that have no test.
    - Flag any test the diff weakened, skipped, or deleted.

## Break-it lens

    Lens: break-it. Find the input, state, or sequence that makes this change do the wrong thing.
    - Try empty, huge, malformed, and duplicate input. The operation run twice. A crash halfway. Two callers at once. A dependency that is slow, down, or returns garbage. Old data from before the change.
    - Trace the callers of everything the diff changed. Which of them relied on the old behaviour?
    - For each finding, say whether a caller can reach it through the public entry points today, and how.
    - A finding counts only with a reproduction: the command or the test that shows the failure, and its output. Build reproductions in the scratch directory.

## Security lens

    Lens: security. Read <path to security.md> first. Find what an attacker controls and where it ends up.
    - Map the trust boundaries the diff touches, and what crosses each.
    - Check every item under "What to hunt".
    - If the diff changes dependencies, run the ecosystem's audit command.
    - Report anything on the "Ask first" list that the diff does without a recorded decision.

## Standards lens

    Lens: standards. Read the Review standards section of `QUALITY.md` and check the diff against each one.
    - Report each violation with `file:line` and the standard it breaks.
    - Report where the diff copies a pattern the standards say to move away from.
