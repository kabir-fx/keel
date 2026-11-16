---
name: explain
description: Explain code so the user understands it well enough to change and review it. Covers how something works, why it is the way it is, layered teaching, and quizzing. Use when the user asks how or why code works, wants a walkthrough or to learn an area, asks to be quizzed, or must review code they did not write.
argument-hint: "[how | why | teach | quiz] <what>"
---

# Explain

The measure is whether I can predict what the code does and change it safely afterwards. Pick the mode from what I asked. Ground every statement in what you read: cite `file:line`, and mark anything you did not read as `inferred`.

## How it works

1. Find the entry point a user or caller touches, and follow one real path through to the result. Read the code on the path. Never explain from names alone.
2. Answer in this order:
   - one sentence on what it does;
   - the path, as five to nine steps, each with `file:line`;
   - the data: what shape goes in, how it changes, what comes out;
   - the invariants the code depends on, and where each is enforced;
   - what is surprising or easy to break.
3. Draw a small diagram when there are more than three components, or a state machine.
4. For a large area, send two or three subagents to trace separate paths in parallel, and combine what they find yourself.

## Why it is this way

History, not guesswork.

1. Look for the record: decision records, the spec, `git log -S` and `git blame` on the lines in question, the pull request or issue linked from the commit, comments, and tests.
2. Report what the record says, and quote it. Separate **recorded** (the author said so) from **inferred** (you are reconstructing it from the code). A comment is a claim, not a fact: check it against the code before repeating it, and tell me when the code contradicts it.
3. Name the constraint that was true then, and whether it still holds. That tells me whether the code is safe to change.

## Teach me

Build understanding in layers, and check each before the next:

1. The problem this code solves, and for whom. No code yet.
2. The model: the three to five concepts and how they relate, in the repo's own terms (`GLOSSARY.md`).
3. One concrete path, traced with real values.
4. The edges: failure modes, invariants, the parts that bite.

After each layer, ask me one question that needs that layer to answer. If I miss it, explain it another way, with a different example and not the same words again. Tie new ideas to what I already know. Do not give me everything at once.

## Quiz me

Check that I understand a change or an area before I approve it or build on it.

1. Ask three to five questions, all at once, that need understanding and not recall: "what happens if this runs twice?", "why is the check here and not in the caller?", "which test fails if I delete this line?"
2. Wait for my answers. Do not hint.
3. Grade each **solid**, **partial**, or **missing**, with the `file:line` that settles it. For anything short of solid, explain it and ask one follow-up.
