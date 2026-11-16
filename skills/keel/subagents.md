# Briefing subagents

One subscription pays for every agent. Spawn one when it buys independence, protects this context window from bulk, or runs disjoint work in parallel. Work that one agent can do in line stays in line.

## When

- **Independence.** A reviewer, verifier, or competing designer must not see the author's reasoning. This is the main reason keel spawns agents.
- **Bulk.** Reading many files, a long log, or a large artifact. The subagent returns the finding and the pointers, not the payload.
- **Parallel disjoint work.** Slices that touch different files. Each writer gets its own worktree (`isolation: "worktree"`), because two writers in one tree corrupt each other.

The rigor table in `/build` sets how many agents a change gets: one to three. Say why before spawning more.

## The brief

A subagent starts cold. Its brief stands alone and names:

1. The goal, restated in one or two sentences.
2. Scope: what it may read, what it may write (usually only a scratch directory), and what it must not touch.
3. Inputs as pointers: file paths, the diff command, the spec path. Do not paste dumps.
4. The evidence it must return: commands run and their output, `file:line` citations. A finding without evidence gets dropped.
5. The output format.

For a reviewer or verifier, leave out your conclusions and how you built the change. Hand over the artifact and the contract only. A reviewer shown your reasoning returns your reasoning.

Send parallel agents in one message so they run together.

## What an agent costs

- An agent re-reads its whole context on every turn, and its report is re-read on every later turn of yours. Ask for findings and pointers. Long output stays in its scratch files.
- An agent idle for more than five minutes has lost its prompt cache. A message to it re-sends its whole context at the cache-write price. Spawn a fresh agent with a brief that covers only what changed. Message a running agent only to answer its question.
- Never send a reviewer back over work it already reviewed. Check the fixes yourself with each finding's reproduction (`vet` step 6).

## Which model

- Default: omit `model`, and the agent runs on the session's model.
- Independence at high stakes: run the agent on Opus (`opus`), with a fresh context. Never use Fable. Independence comes from the fresh context: the agent sees only the artifact and the contract, never the author's reasoning.
- Mechanical bulk (searching, listing, summarising files, running a checklist): `sonnet` or `haiku`.

## Own the result

A subagent's report is a claim. Read the diff or the evidence, not only the summary. Re-run the command behind any finding before you act on it. After an agent that could write files returns, check `git status` for changes outside its scope.
