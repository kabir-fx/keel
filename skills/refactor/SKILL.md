---
name: refactor
description: Change the structure of code without changing its behaviour, safely. Use for refactors, restructures, migrations to a new API or pattern, removing dead code or a deprecated path, or when the user says code is tangled, hard to change, or hard to test.
argument-hint: "[what to restructure]"
---

# Refactor

Behaviour stays. Structure changes. Never put a behaviour change in the same commit as a refactor: do one, then the other.

1. **Understand first.** Before removing or reshaping anything, find out why it is there: `git log`, `git blame`, the decision records, the tests, the callers. Code that looks pointless may guard a case you have not seen. If you cannot find the reason, say so and ask before deleting.
2. **Pin the behaviour.** Find the tests that cover what you are about to move, and run them. Where coverage is thin, add characterisation tests at the seam first (the `tdd` skill) and commit them. No pin, no refactor.
3. **Name the target shape.** One paragraph or a sketch: what the code looks like afterwards, and what gets easier. For anything that moves a module boundary, use the `architect` skill. State how you will know it worked: fewer concepts to hold, a smaller interface, one way instead of two.
4. **Subtract first.** Delete dead code, unused options, and pass-through layers before adding anything. Often the new abstraction turns out not to be needed.
5. **Move in small steps.** Each step is one mechanical move (rename, extract, inline, move), keeps the checks green, and is its own commit. A step that goes red is reverted, not debugged in place.
6. **Leave one way.** Migrate every caller and delete the old path in the same piece of work. When the change is too wide for one sitting, use expand, migrate, contract: add the new path beside the old, move callers in batches, then delete the old path. Write down what remains, so the migration cannot stall half done.
7. **Build the lever.** For the same edit across many files, write a codemod or a script instead of editing by hand. Run it, review its diff, and commit its output on its own. A script makes the same edit every time. A fleet of agents does not.
8. **Prove it is unchanged.** The full check passes with the pinning tests unmodified. For anything with observable output, compare before and after on the real artifact (the `prove` skill).
9. **Check the gain.** Did the measure from step 3 move? If the result is not simpler to read, revert and say so.
