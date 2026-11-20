# The owner agrees to one check, and only that check calls a part built

A part on the board is filled in when it is built, and built has to mean evidence. In the first version the agent posted "built" itself, and a review showed it would accept any commit name and its own word that a check had passed. We decided that the agent can never say "built". The blueprint shows one check command, the owner agrees to it by pressing "Build this", and a tool of ours runs exactly that command and reports the result.

**Status:** accepted

**How a build goes**

1. The agent reads the idea back as a blueprint. It names one check, such as `make check`, found by reading the repository.
2. The owner presses "Build this". The event records the track and the check, and the check must be the one the blueprint shows, word for word. That press is the owner's agreement to run that command. The server keeps the agreement outside the repository ([0009](0009-a-log-read-from-disk-grants-nothing.md)).
3. The board server starts a builder. The builder is a second process beside the board agent, in its own git worktree on its own branch. It never touches the owner's checkout.
4. For each part the builder says "building", writes the code, and commits. Then it calls `board_check`.
5. `board_check` is our code, not the model's word. It refuses unless the part is building and there is a new commit. It runs the command the owner agreed to on this machine, which the server hands it, never one from the model, and it refuses when the board names another. The command runs in the worktree, boxed in. When it passes, the tool posts "built" as the system, with the commit's hash. When it fails it posts a problem with the end of the output.
6. The server refuses "built" unless the commit exists in the repository.
7. When every part is built the chapter is built. The branch waits for the owner to merge. Merging is the owner's act.

A real build of three parts ran this way end to end: one commit per part, paused and resumed through the server, in under a minute for a toy repository.

**Alternatives**

- **Harness hooks on the commit and on the test command.** They hold when the agent forgets, but they tie the board to one harness, and matching "the test command" among shell commands is guesswork.
- **Trust the agent's report.** The review ruled it out.
- **Let the builder work in the owner's checkout.** The owner could not keep working there, and a bad build would be in their way.

**Consequences**

- No agreed check means nothing can become built. The agent must always name one on the blueprint.
- The check is only as strong as the tests it runs. A part that changes behaviour should add a test that the check runs, and its update should name it.
- The builder's fence is its own. Its file tools write inside its folder in the worktree and nowhere else. Its shell runs a short list of git commands and what the owner adds. It tries the check through a tool, never in its shell. Anything else is denied and reported on the board.
- The builder's git is told where the worktree's own git folder is, and runs no hook. A hook is a program, and a repository may keep its hooks in tracked files, which the builder writes.
- A decided part that the owner reopens holds the build until the owner decides it again.
- "Built" on a part the repository already had is a different claim: the agent names where it lives, and no check ran. The board calls such a part "already there", and draws it apart from a part built and checked here.
