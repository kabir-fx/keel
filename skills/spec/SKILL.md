---
name: spec
description: Turn the conversation into a written spec with checkable success criteria, then slice it into vertical pieces that can each be built and proven alone.
disable-model-invocation: true
argument-hint: "[feature name, or path to notes]"
---

# Spec

Synthesise what we already discussed into a spec, get it approved, then slice it. Do not interview me here. If large questions are still open, list them and send me to `/grill`.

## Phase 1: write the spec

1. Explore the affected code if you have not. Use `GLOSSARY.md` terms and respect the decision records for the area.
2. Turn every vague requirement into a success criterion someone could check. "Make search faster" becomes "p95 search latency under 200 ms on the 60k-row fixture".
3. Choose the **seams** to test at: the public interfaces where behaviour is observed. Prefer existing seams, the highest seam that reaches the behaviour, and as few as possible. One is ideal.
4. Write the spec from [template.md](template.md) to the specs location. The `## Keel` block in CLAUDE.md names it. The default is `docs/specs/<slug>.md`.
5. Stop. Show me the success criteria, the seams, the out-of-scope list, and the open questions. Phase 2 starts only after I approve.

## Phase 2: slice it

Skip slicing when the work fits one sitting. Say so, and the success criteria serve as the acceptance criteria.

1. Break the work into **tracer-bullet slices**. Each slice cuts a thin, complete path through every layer it needs (data, logic, interface, tests) and can be demonstrated on its own. A slice of one layer is horizontal: cut it again.
2. Put the riskiest unknown first. Put anything every later slice needs (scaffold, shared types, the test harness) before the features.
3. Give each slice its **blockers** (the slices that must land first), two to four **acceptance criteria**, and its **proof**: the command or observation that shows it works. If you cannot name the proof, the slice is not scoped yet.
4. Size each slice to one fresh session. A title that needs "and" is two slices.
5. A wide mechanical change (renaming a shared symbol, retyping a column) cannot be a tracer bullet. Sequence it as expand, migrate in batches, contract.
6. Append the slices to the spec under `## Slices`, in the format in [template.md](template.md). Show me the list: title, blockers, what each delivers. Ask whether the granularity and the blocking edges are right. Iterate until I approve.

## After approval

Set the spec's status to `approved`. Tell me the first unblocked slice and how to start it: `/build <spec path> slice <n>`, in a fresh session (`/clear` first) so the slice gets a full context window.
