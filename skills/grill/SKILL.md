---
name: grill
description: Interview the user until a plan, design, or idea is fully understood, recording new terms and hard decisions along the way. Use when the user asks to be grilled, interviewed, or challenged on a plan, or says an idea is still fuzzy.
argument-hint: "[the idea or plan]"
---

# Grill

Interview me relentlessly until we share one understanding of what is being built and why. Write no code and no spec in this skill.

## The design tree

Every decision branches into the decisions that hang off it. The **frontier** is every decision whose prerequisites are settled, so you can ask it now without guessing at an answer you have not heard.

Work in rounds. Each round, ask the whole frontier at once, numbered:

```
**Q1. <title>**: <the question, with the options when there are options>
Recommended: <your answer, and the reason in one line>
```

Word each question so that "yes" accepts your recommendation. Then wait. My answers reshape the tree: recompute the frontier and ask the next round. A question that depends on one still open belongs to a later round.

## Facts are yours

Never ask me something you can find out. Read the code, the docs, the installed dependency source. For a slow lookup, send a subagent with a fresh context and keep asking the questions that do not depend on it. When the code contradicts what I said, show me the contradiction and ask which is right. When a fork is empirical (behaviour, timing, layout, speed), use the `prototype` skill and let the result decide.

## Listen for the real want

- When I describe a solution, ask what problem it solves and who has that problem.
- "Whatever you think" is not a decision. Offer two concrete options with what each costs.
- Probe the edges with concrete scenarios: the empty case, the second user, the failure halfway, the action that happens twice.
- Ask what is out of scope. An explicit no is worth as much as a yes.

## Write things down as they settle

- **A term gets pinned.** When I use a vague or overloaded word, or one that conflicts with `GLOSSARY.md`, propose one canonical term and update the glossary on the spot. Format: `${CLAUDE_SKILL_DIR}/../keel/glossary.md`.
- **A hard decision gets recorded.** Offer a decision record only when the decision is hard to reverse, surprising without context, and the result of a real trade-off. Format: `${CLAUDE_SKILL_DIR}/../keel/adr.md`.

## Done

The session is done when the frontier is empty: every branch visited, nothing silently assumed. Close by restating the whole understanding in plain words: the goal, who it is for, the behaviour, the constraints, what is out of scope, and each decision made. Ask for an explicit yes.

On yes, name the next step: `/spec` for work bigger than one sitting, `/build` for a small change. Stay in this conversation for it, because the next step needs this reasoning word for word.
