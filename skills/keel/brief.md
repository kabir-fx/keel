# Briefs

A brief is the owner's page for one slice. The rationale and the decision record are the contract for agents: exact, complete, and long. The brief is for the owner, in plain words. It says what the slice does, how it works, and what it gives at the end. It also shows how far the slice moves the project. The owner approves a design from the brief, and learns the system from it.

## Where and when

- One file per slice, in the directory the `## Keel` block names as `Briefs:`, else `docs/briefs/`. The directory must be named `briefs`: the brief hook checks Markdown files only there. Name the file after the slice: `M1-T3-engine-loop.md`, `checkout-slice-2.md`.
- `architect` writes it with the rationale. At Standard and High stakes, `/build` writes it when no design step did. A Light change has none.
- `/build` fills in **Result** before its report, DONE or NOT DONE. Nothing else changes the brief during the build.
- The brief adds no decision. Every fact in it comes from the record, the spec, or a command that ran. When the brief and the record disagree, the record wins: fix the brief.

## Writing rules

Write in ASD-STE100 Simplified Technical English, for an owner who did not see the design session.

The brief check enforces four limits after every Edit and Write of a brief. After any other write, run [scripts/brief-check.sh](scripts/brief-check.sh) on the brief yourself. It does not read headings, code blocks, or code spans, and a code span counts as one word.

- A sentence has 20 words or fewer. STE allows 25 in descriptive text. Keel holds every sentence to 20, so no sentence needs a label.
- A paragraph, a list item, or a table cell has 6 sentences or fewer.
- No semicolons. A semicolon joins two sentences and hides the second from the word count.
- No word from the checker's list of words STE does not approve. The checker names the word to use.

Follow these rules too. The checker cannot see them.

- One topic per sentence, and one topic per paragraph.
- Active voice. Name who acts: the agent, the engine, you.
- Simple tenses: present, past, and future with "will". No "has been", no "would have".
- An -ing form only inside a technical name, such as "streaming detokenizer".
- Keep the articles. Do not drop words to make a sentence shorter.
- Not more than three nouns in a row: "request state machine" is the limit.
- One word for one meaning. Use the glossary terms. Do not reuse a word that the project uses for something else.
- Speak to the owner as "you". Put code names in backticks, so the owner can search for them.
- Use a code block only for a diagram or the progress board.

## Template

Replace each note. Drop a section that has nothing to say.

```markdown
# <slice id>: <name>

**State:** <waiting for your approval | in build | DONE at `<commit>` | NOT DONE>. <What the owner does now, in one sentence.>
**Decision record:** [<NNNN>](<path>) (the full design, for agents) · **Spec:** <where the slice is defined>

## The goal

<Two sentences or fewer: what this slice adds, for the user of the software.>

## The problem

<Three to five bullets: what is missing or wrong now, and the constraints the design must keep, with rule numbers.>

## How it works

<A diagram in a code block when two or more parts talk. Then one numbered item per part: its name, its file, and what it does. Then any fact the agent measured to settle the design, and how.>

## What you get at the end

<What the owner can run or see, with the command. The new tests, by what each proves. Then "What you do not get yet", with the slice that brings each thing.>

## Where this puts the project

<A code block with one row per milestone, or one row for the spec, and one cell per task or slice: done █, this slice ▓, not started ░. Count the cells from the spec. Then the next slices that this one opens.>

## What you approve

<After a design step: each choice the owner can disagree with, the option it beat, and why. Then each open question, with your recommended answer. Without a design step, name this section "Choices the agent made", and say that the owner can still change them before /ship.>

## What can go wrong

<Each trade-off accepted and each failure mode, with what the owner sees when it happens.>

## Words

| Word | Meaning |
|---|---|
| <technical name> | <one sentence> |

## Learn from this slice

<Two or three ideas this slice teaches, each in two to four sentences. Then one "Test yourself" question, with its answer inside a <details> block.>

## Result

<Empty until /build reports. Then: the state, the verdicts and the commit they cover, and the full check. What changed against the plan, and why. The bugs that proof and review found. What is not proven. What passes to later slices. "Read these yourself": `file:line` and what to look for.>
```
