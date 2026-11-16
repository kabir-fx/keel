# Decision records (ADRs)

Use the repo's existing convention first. The directory, numbering, and format already in use win (for example `docs/decisions/NNNN-title.md`). The `## Keel` block in CLAUDE.md names the location. With no convention, use `docs/adr/NNNN-slug.md`, numbered from `0001`, and create the directory when the first record is needed.

## When to write one

Only when all three hold:

1. **Hard to reverse.** Changing your mind later costs real work.
2. **Surprising without context.** A future reader will wonder why it was done this way.
3. **A real trade-off.** There were genuine alternatives and this one won for specific reasons.

That covers architectural shape, how two parts of the system talk, a technology with lock-in, an ownership boundary ("X owns this data, others hold only its id"), a deliberate departure from the obvious path, a constraint the code cannot show, and a rejected alternative that someone will propose again. It does not cover choices that are easy to reverse or obvious.

## Format

```md
# <Short title of the decision>

<One to three sentences: the context, what we decided, and why.>
```

A record can be one paragraph. Add a section only when it earns its place:

- **Status** (`accepted`, `superseded by NNNN`) when a decision is revisited.
- **Alternatives** when the rejected options are worth remembering.
- **Consequences** when a downstream effect is not obvious.

Never edit a past record to change its meaning. Write a new record that supersedes it.
