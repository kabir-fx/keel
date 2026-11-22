# The board runs only a Claude Code new enough, and the setup page updates one that is not

The agent and the builder are started with `--restricted` (record [0006](0006-the-hosted-agent-is-fenced-from-the-repository.md)). On a laptop that already had Claude Code, `get.sh` found it and installed nothing, the setup page saw it signed in, and the board opened. Every wake then ended with `error: unknown option '--restricted'`, and the agent never answered. That Claude Code was older than 2.1.248, the release that added the flag. Nothing had asked its version. We decided that the board has a floor, checks it before every start, and that the setup page brings an older Claude Code up to it.

**Status:** accepted. It extends record [0015](0015-the-first-page-sets-the-machine-up.md), and takes back one line of it: a Claude Code too old to have `claude auth status` is no longer taken as signed in.

**The floor**

`CLAUDE_MIN` in `workspace/plugin/src/claude-setup.ts`, now 2.1.316.

| Release | What it means for the board |
|---|---|
| 2.1.248 | `--restricted` exists. Below this the agent cannot start. |
| 2.1.290, 2.1.295 | Holes in `--restricted` closed: a read outside the folder through a link changed mid-read, and built-in tools that `--tools` did not remove. |
| 2.1.316 | The last hole closed so far: an upload from outside the working folders. |

The floor is the last release that fixed the fence, not the first that has the flag. A fence with a known hole breaks record 0006 without a sign. Raise the floor when a later release closes another hole, or when the agent's flags need one.

**What is checked, and where**

- `pickClaude` lists every `claude`: each on the PATH, then `~/.local/bin`. It asks each `claude --version` and takes the first that is new enough. A machine can hold two, an old one on the PATH and the installer's own, so an old one first does not end the search.
- One that does not say its version within 5 seconds counts as too old.
- The setup page has a fourth state, `outdated`. The first step then reads "Update Claude Code", runs Anthropic's installer as the install does, and comes before the sign-in. So no sign-in is ever started with a Claude Code the board will not run.
- The agent and the builder ask `pickClaude` before each start. With none new enough they start nothing, and the wake or the build fails with the versions and what to do: open the board in a new tab, where the setup page stands again. This covers "Open the board without this", which holds for one tab, and a Claude Code that went back in time while the board ran.
- Only `loggedIn: true` from `claude auth status` is signed in. Every version at the floor can say it, so no answer means not signed in.

**What this does not cover**

- The owner's own terminal still runs whichever `claude` is first on its PATH. The board does not remove or change an old one.
- `get.sh` still installs Claude Code only when none is found. The floor lives in one place, and the setup page applies it for both ways in.
- Anthropic's installer installs the newest release. A release that breaks the agent's flags is not caught by a floor.

**Alternatives**

- **Ask `claude --help` for each flag.** It tests the flag and not a number. But the help does not list every flag the agent passes, and it says nothing of the holes closed since.
- **Drop `--restricted` on an old Claude Code.** The agent would start, with no fence. Record 0006 forbids it.
- **Stop retrying when the agent exits on its options.** It hides the noise and leaves the owner with an agent that never answers.
- **Run `claude update` on the old one.** An old install from npm may need root to update. The installer never does.
