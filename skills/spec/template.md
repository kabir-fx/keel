# Spec template

Write for the person who builds a slice next week with none of today's context. Use `GLOSSARY.md` terms. Leave out file paths and code: they go stale. The one exception is a snippet from a prototype that states a decision more exactly than prose can (a state machine, a schema, a type shape). Trim it to the decision.

```markdown
# <Feature name>

Status: draft | approved | building | shipped

## Problem

<What is wrong or missing today, from the user's point of view. Who has the problem.>

## Solution

<What will be true afterwards, from the user's point of view.>

## User stories

1. As a <actor>, I want <capability>, so that <benefit>.
<Cover every actor and every path, including the unhappy ones.>

## Success criteria

1. <A condition someone can check by running something. A number where there is one.>

## Decisions

<The modules built or changed and their interfaces, contracts, schema changes, and each technical choice with its reason. Link decision records.>

## Testing

- Seams: <the interfaces tests go through, one line each on what it catches and what it misses>
- A good test here: <what behaviour to assert, what not to mock>
- Prior art: <existing tests of the same kind to copy the style from>

## Boundaries

- Always: <for example: run the fast check before each commit>
- Ask first: <for example: a new dependency, a schema change>
- Never: <for example: change the public response shape>

## Out of scope

<What this deliberately does not do, one line each, with the reason.>

## Open questions

<Anything still undecided, phrased as a question for a named person.>

## Slices

### 1. <Title: the behaviour this slice makes work>

Blocked by: none
Delivers: <the end-to-end behaviour, from the user's point of view>

- [ ] <acceptance criterion>
- [ ] <acceptance criterion>

Proof: `<command>` shows <observation>
Status: todo
```

Slice status moves `todo`, `in progress`, `done (<commit>)`. A slice with blockers lists their numbers.
