---
name: prototype
description: Build throwaway code that answers one design question by running it. Use when a decision depends on something observable (does this state model hold up, which layout reads best, which approach is fast enough), or when the user asks to prototype, mock up, spike, or try something.
argument-hint: "[the question to answer]"
---

# Prototype

A prototype is an instrument for making one decision cheaply. The code is disposable. The decision is the deliverable. With no decision to make, there is no prototype: build the real thing instead.

1. **Write the question** at the top of the prototype, where it can be checked later: what is being decided, and which result would pick each option.
2. **Pick the shape the question needs.**
   - *Does this logic or state model hold up?* One self-contained file. Put the logic in a small pure module (a reducer, a state machine, a few functions) and wrap it in the thinnest driver: an HTML page with one button per action and the full state re-rendered after each, or a script that prints the state after each step. Include the awkward scenarios: the edge case, the illegal move, the action that happens twice.
   - *What should this look like?* Two or three clearly different variants behind one switcher, each labelled.
   - *How does it behave, how fast is it, which approach works?* The smallest script that exercises the real question and prints what it observed.
3. **Keep it throwaway.** A scratch directory outside production source (`.scratch/prototype-<slug>/`, kept out of git), one command to run it, in-memory state, no tests, no error handling, no abstractions. Speed over polish. Propose a variant I did not ask for when you see one.
4. **Observe.** Run every variant and capture what you saw: the output, the timing, a screenshot. Here the observation is the test.
5. **Hand back the decision**: the variants, the evidence for each, the trade-offs, and your recommendation. Say plainly that the code is throwaway, and give its path.
6. **Capture the answer** where it will be read: the spec, a decision record, or the issue. A snippet that states the decision better than prose (the state machine, the type shape) may be quoted there.

The real build goes through `/build`. Prototype code is never merged. A pure logic module may be lifted into the real code, where it gets real tests.
