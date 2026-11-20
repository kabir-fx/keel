# The board server hosts the agent as a headless Claude Code process

A mark on the board has to reach an agent within a couple of seconds, with no send button and no terminal for the owner to watch. We decided that the board server starts and owns one long-lived headless Claude Code process (`claude -p --input-format stream-json --output-format stream-json`) and wakes it by writing one line to its input. We ran eight ways of reaching an agent, and this one was the fastest, needed no preview flag and no API key, and left the server in charge of start, wake, turn end, restart and stop.

**Status:** accepted

**What was measured** (Claude Code 2.1.326, a signed-in subscription, Sonnet, 2026-11-17)

| Way | Wakes from idle | Mark to answer | Verdict |
|---|---|---|---|
| A long-lived headless process, a wake is one line on stdin | yes | 1.3 to 1.4 s | Chosen |
| A new headless run per wake, with `--resume` | yes | 1.9 to 2.0 s | The restart path of the chosen way |
| The Agent SDK with streaming input | yes | 2.2 s | Same engine. Its docs restrict subscription login in products built on it. |
| A plugin monitor in an interactive session, hosted in a pty | yes | 1.7 to 2.1 s | The fallback |
| An `asyncRewake` hook | yes | 2.4 to 2.9 s | A mark that lands mid-turn waits 7.5 s. The hook timeout can leave the session deaf. |
| A long-poll tool the agent calls in a loop, headless | yes | 2.2 s | Cheapest per wake, but it relies on the model never ending its turn |
| The same long poll in an interactive session | badly | 123 s after idle | The harness moves a long tool call to the background after two minutes |
| A channel (`notifications/claude/channel`) | no | none | A research preview, and blocked by organisation policy on the test account |

A warm wake reads about 15,000 tokens from the prompt cache, writes about 170 and outputs about 30. On a subscription the cache lasts one hour, so a wake after ten idle minutes is still warm. A second headless process, the builder, ran beside a wake without slowing it.

**Consequences**

- The server talks to the agent through one seam, `AgentLink.wake(digest)` in `workspace/protocol`. An adapter is a module the server loads by name, so another harness or another way in needs a new adapter and no change to the server.
- The server holds new marks while a turn runs, and sends one wake when the turn ends. It builds each digest from what is open on the board, not from what it sent before, so a process that dies mid-turn loses nothing: the restart gets the same marks.
- The hosted agent gets the board tools and read-only repository tools, and nothing else. It cannot edit files or run commands. The builder is a separate process with its own tools.
- The agent's context must stay small, because every wake re-reads all of it. The agent reads a digest, never the log.
- The risk we accept: this rests on headless mode keeping the subscription login. The Claude Code docs say a mode that ignores that login will become the headless default. The seam and the pty fallback are the hedge.
- The owner's own interactive session is not the board agent. It can still call the board tools through the plugin.
