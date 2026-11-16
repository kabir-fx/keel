# Release

A release is done when users have the change and you have watched it work. It is not done when the command returns.

## Before

1. **Write the rollback plan first.** The exact command or step that returns to the last good state, who can run it, how long it takes, and what it does not undo: a migration, sent emails, a published package. If rollback is impossible, the release needs my explicit sign-off and a smaller first step.
2. **Separate deploy from release** where you can. Ship the code dark behind a flag, then turn it on. A flag is a rollback that takes seconds. Give every flag an owner and a removal date.
3. **Keep data changes backwards compatible.** Expand (add the new column or field), migrate, and contract in a later release. The old code must run against the new schema, because a rollback will need it to.
4. **Decide the watch signals.** Which numbers show it is healthy (error rate, latency, the event the change exists to produce), what they read now, and the threshold that triggers rollback. With no signal, add one first with the `observability` skill.
5. **Version and changelog.** Follow the repo's convention. With none, use semantic versioning and a changelog entry written for users: what changed for them, and anything they must do.

## Rollout

Expose it in stages when the platform allows: internal, then a small share, then everyone. Hold each stage long enough to see real traffic. Starting thresholds, to tune per project:

| Signal | Proceed | Hold and look | Roll back |
|---|---|---|---|
| Error rate | at baseline | up to 2x baseline | above 2x baseline |
| p95 latency | within 10% of baseline | within 50% | beyond 50% |
| The feature's own success event | happening | lower than expected | absent or failing |

When a rollback trigger fires, roll back first and diagnose after. Do not debug in production while users are affected.

For a package or a tag, the stages are: publish a pre-release, install it fresh the way a user would, run the smoke test, then publish the real version. A published version cannot be taken back in practice. Ask me before the publish command.

## After

1. Run the smoke test against the released artifact: the installed package, the live URL. This is the `prove` skill, pointed at production.
2. Watch the signals for the agreed window. Report the numbers, not "looks fine".
3. Clean up: remove the flag once it is fully on, delete the dead code path, set the spec to `Status: shipped`.
4. If anything went wrong, even if it was caught in time, run `/retro`.
