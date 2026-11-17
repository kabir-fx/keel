---
name: architect
description: Design the shape of code before writing it. Settles the caller's usage, types, signatures, and module boundaries by comparing competing designs. Use before building anything that crosses a module boundary, adds a public interface, or is hard to reverse, or when the user asks to design or architect something.
argument-hint: "[what to design]"
---

# Architect

Settle the shape before the logic. The output is a sketch (types, signatures, module boundaries, bodies left unimplemented) and a one-page rationale. Writing the logic comes after.

## Vocabulary

Use these words exactly. They are how designs get compared.

- **Module**: anything with an interface and an implementation, at any scale: a function, a class, a package.
- **Interface**: everything a caller must know to use it correctly. The signature, and also the invariants, ordering rules, error modes, and required configuration.
- **Depth**: how much behaviour sits behind how little interface. A deep module hides a lot behind a small interface. A shallow one has an interface nearly as complicated as its body.
- **Seam**: the place where the interface lives and where behaviour can be swapped or observed. Tests cross the same seam callers do.
- **Adapter**: a concrete thing that fills an interface at a seam. One adapter means the seam is hypothetical. Two means it is real.

## Steps

1. **Ground.** Trace every system the new code touches until you can write three to six lines on each: what it owns, its interface, the invariants it keeps. When the design changes who owns something, read why it is the way it is (the `explain` skill, why mode). Skip grounding only for greenfield code with nothing around it.
2. **Usage first.** Write what the caller writes: two or three realistic call sites, commands, or requests, and what comes back. The usage is the spec. The types serve it.
3. **Design it twice.** Send two or three subagents in one message, each with the grounding, the usage, and a different constraint:
   - minimise the interface: one to three entry points;
   - make the most common call trivial;
   - isolate what varies behind an injected dependency (use this one when the code talks to something external).

   Each returns the interface with its invariants and error modes, a usage example, what it hides, and where it is weak. Brief them per `${CLAUDE_SKILL_DIR}/../keel/subagents.md`. For a small design, write two whole-shape alternatives yourself instead. Variations inside one shape do not count.
4. **Screen** every candidate against [red-flags.md](red-flags.md). Compare the survivors on depth, on where a future change would land, and on seam placement.
5. **Pick a base and graft.** Choose the design a maintainer can extend most easily without breaking an invariant. When two tie, take the smaller interface. Port the one or two best ideas from the losers by hand, so the result stays one coherent design. If the candidates converged, that agreement is evidence. If they diverged wildly, the framing was too loose: return to step 1.
6. **Stress it.** Answer each in a line: What if it runs twice? What if it crashes halfway? What if two actors write at once? What does hostile input do at each trust boundary? How will we see it working, or failing, in production?
7. **Write the rationale** from [rationale.md](rationale.md), next to the spec. Record a decision record when one is warranted: `${CLAUDE_SKILL_DIR}/../keel/adr.md`. Then write my brief from `${CLAUDE_SKILL_DIR}/../keel/brief.md`, and run `${CLAUDE_SKILL_DIR}/../keel/scripts/brief-check.sh <brief>` until it passes.
8. **Checkpoint.** Give me the path to the brief, and ask the open questions from its *What you approve*, each with your recommended answer. The rationale and the decision record stay the contract for agents: point at them, do not repeat them. Wait for my approval before any logic is written. Skip the wait only when I asked for an unattended run.

## While implementing

The sketch is the contract. A deviation is a signal, not friction to absorb: when a function needs a parameter the sketch did not have, ask whether the sketch was wrong, a requirement was missed, or the implementation is overreaching.

Throw the sketch away, and return to step 3, when a pattern appears: the same workaround in unrelated places, special cases piling up, types that need escape hatches to compile, a lock where the sketch said nothing was shared, or callers that must know the internals to use the module. Do not bolt fixes onto a wrong shape.
