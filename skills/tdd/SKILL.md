---
name: tdd
description: Write tests that catch real bugs, test-first. Use when writing or changing tests, building a feature or fixing a bug test-first, or when the user mentions TDD, red-green-refactor, or test quality.
argument-hint: "[the behaviour to build or the tests to judge]"
---

# TDD

A test earns its place by failing when the behaviour breaks and passing when the behaviour holds, whatever the implementation looks like.

## What a good test is

It checks observable behaviour through the public interface, the way a caller would. Hold each test against two imagined edits:

1. A refactor that keeps the behaviour. The test must still pass. If it would fail, it is coupled to the implementation.
2. A bug in the behaviour. The test must fail. If it would pass, it is a tautology.

Tautologies to watch for: an expected value computed by the code under test or copied from its output, an assertion that a mock returns what you told it to, an assertion only that something was called, an assertion only that nothing threw.

## Before writing

Agree the seams: the interfaces the tests go through. Take them from the spec. With no spec, name them, and confirm with me when the choice is not obvious. Prefer an existing seam, the highest one that reaches the behaviour, and as few as possible.

Then list the behaviours to test, most important first. You cannot test everything, so choose.

## The loop

One behaviour at a time. Never write all the tests first and all the code after: tests written in bulk describe imagined behaviour.

1. **Red.** Write one test for the next behaviour. Run it. Read the failure: it must fail for the reason you expect, not for a typo or a missing import.
2. **Green.** Write the least code that passes it. Nothing for the next test yet.
3. **Check.** Run the fast check.
4. **Commit.**

Refactor only on green, in its own commit, with the tests untouched.

A bug fix is two commits: the failing test that reproduces the bug, then the fix (rule 9).

## Rules of the craft

- **Expected values come from outside the code.** Work them out by hand, from the spec, from a reference implementation, or from a known-good example. Say where each came from.
- **Mock only at the system boundary**: the network, the clock, randomness, the filesystem, a paid API. Use real code for everything the repo owns. Prefer a fake you inject over patching internals.
- **Assert state, not calls.** Check what came back or what changed, not which functions ran.
- **Use a property test for an invariant**: a round trip, an ordering, idempotence, "never negative". Use examples for specific cases.
- **Cover the unhappy paths that matter**: the empty input, the boundary value, the dependency that fails.
- **One reason to fail per test**, named for the behaviour: `rejects_expired_token`, not `test_auth_2`.
- **Never edit a test to make wrong code pass** (rule 6). If the test itself is wrong, say why and what the right expectation is, then change it in its own commit.
- **No test beats a bad test.** A test that cannot fail gives false confidence. Fix it or delete it, and say which.

## Teeth check

Before calling a set of tests done, break the code on purpose: flip a condition, return early, change a constant. Run the tests. If nothing fails, they have no teeth: fix the tests. Then restore the code.

When there is no sound seam (the code is tangled, and the only handle is the internals), say so. That is a design finding for the `architect` or `refactor` skill. It is not a reason to test internals.
