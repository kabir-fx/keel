# GLOSSARY.md

The project's shared language. People and agents use these terms exactly, in conversation, names, tests, and commit messages. One word per concept is what keeps prompts short and code consistent.

Use the location named in the `## Keel` block of CLAUDE.md. With none, create `GLOSSARY.md` at the repo root when the first term is settled.

## Format

```md
# <Project or context name>

<One or two sentences: what this context is and why it exists.>

## Language

**Order**:
A customer's request to buy one or more items, from placement to delivery.
_Avoid_: purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: bill, payment request
```

## Rules

- **Be opinionated.** When several words exist for one concept, pick the best and list the others under _Avoid_.
- **Define what it is, not what it does.** One or two sentences.
- **Only terms specific to this project.** General programming words (timeout, retry, cache) stay out, even when the project uses them heavily.
- **No implementation detail.** The glossary is not a spec, a scratch pad, or a place for decisions. Decisions go in decision records.
- **Group under subheadings** when clusters appear. A flat list is fine for one cohesive area.
- **Update it the moment a term is settled**, not at the end of the session.

A repo with several distinct areas can keep one `GLOSSARY.md` per area and a root `GLOSSARY-MAP.md` that lists them and how they relate.
