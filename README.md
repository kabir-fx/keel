# Keel

Keel is a board where you work out an idea with an agent, solidify it, and watch it get built. The board is a canvas in your browser, one per repository. You write, draw, drop files in, or talk. The agent is on the board with you, and it answers in pictures. When the idea is right, you solidify it. Then a builder writes the code in the background, and the same pictures fill in as it goes.

It runs on your machine, beside Claude Code, on your own Claude Code sign-in. It is early work: it has run on recorded boards and toy repositories, not yet in daily use.

Keel also holds an earlier way of working: rules, skills, review agents and hooks for Claude Code. That part is now frozen, and its rules still apply. It is described [at the end of this page](#the-earlier-way-of-working-rules-and-skills-frozen).

## The loop

1. **Ideate.** You mark the board: a note, a sketch, a circle, a cross, a dropped file, a spoken remark. There is no send button: when you pause, the agent answers in pictures. It shows how it read you, what the repository already has, and two to four approaches side by side. Each approach names its risk, and the agent gives its lean. You circle what you like and cross out the rest.
2. **Solidify.** You lasso the pictures you pick and press Solidify. The agent reads the idea back as one picture, the blueprint. It lists your picks, where each came from, and what was left out. It says how you will know it works, and names the parts to build and one check command. Nothing is built before this step.
3. **Watch.** You press "Build this" on the blueprint. A builder writes the code in its own copy of the repository, one commit per part. A part fills in only when the agreed check passes after its commit. A panel shows the build track, a feed of what the builder did, and a Pause button. You can keep marking, or leave: the board can tell you with a notification when something needs you.

A mark on a decided part reopens that part only. The build waits until you decide that part again, and then it builds the change. Then the loop starts again from step 1.

The Story is the second view of the board. It lists every idea as a chapter, newest first, with its moments and how far it is built. A part the repository already had shows as "already there", apart from the parts built here.

## Quick start

You need Node 22 or newer with npm, `jq`, git, and Claude Code installed and signed in.

```sh
./install.sh            # from this folder
cd ~/code/any-repo
keel-board open
```

`./install.sh` builds the board in `workspace/` and links the `keel-board` command into `~/.local/bin` (or `$KEEL_BIN_DIR`). It says so when that folder is not on your PATH. It also installs the rules and skills below. After a `git pull`, run it again: it rebuilds the board.

`keel-board open` makes `.keel/board/` in the repository, starts the board server, and opens the board in your browser. It prints an address that works once, for five minutes. The page trades it for a key that lasts until the server stops, and keeps that key for the address. For a second tab, or after a restart, `keel-board link` prints a fresh address. The server runs until you press Ctrl-C or run `keel-board stop`. The agent shows as present in the pill at the top right.

| Command | What it does |
|---|---|
| `keel-board open [dir]` | Start the board for a repository. `--no-browser` only prints the address. `--port n` picks the port. |
| `keel-board status [dir]` | Is a server running, how many marks are open, what the agent and the builder do now |
| `keel-board link [dir]` | Print a fresh address for the board's page. It works once. |
| `keel-board stop [dir]` | Stop the server |
| `keel-board tail [dir]` | Follow the board's events as they come |
| `keel-board read [dir]` | Print the digest, the short summary the agent reads when it wakes |

Options for `open`: `--link none` runs no agent. `--link-opt model=opus` and `--link-opt effort=medium` change the agent's model and effort. `--builder none` runs no builder. `keel-board --help` lists the rest.

`./install.sh --no-board` installs without the board. `./install.sh --dry-run` shows every change and makes none. `./install.sh --uninstall` removes what the installer added: the links, the `keel-board` command and the three hook entries in `settings.json`. Your boards stay.

## The tools on the board

| Tool | Key | What it does |
|---|---|---|
| Select | V | Pick, move and resize items. Delete takes the selected item off, an agent's picture too. Nothing is deleted from the log, and undo puts it back. |
| Pan | H, or hold Space | Move around the board |
| Pen | P | Draw by hand. A circle on a picture picks it. A cross drops it. A sketch is a request too. |
| Box | B | Draw a box |
| Arrow | A | Draw an arrow. An end that lands on a thing, or stops just short of one it points at, holds on to that thing when either moves. |
| Note | N | Write a note. When you change its words, the agent reads it again. |
| Pin | I | Pin one place inside an item, such as one step of a picture |
| Lasso | L | Hold several items together. Solidify takes what the lasso holds. A lasso asks the agent nothing. |
| Erase | E | Drag across your own ink, boxes, arrows and pins to take them off |
| Drop in | D | Add a file, a picture or a link. A file is kept in `.keel/board/assets/`, up to 20 MB. |
| Talk | hold T | Speak a remark. It needs a browser with speech recognition, such as Chrome or Safari. |
| Solidify | Shift+S | Turn the pictures in your lasso into the decided idea |

Box, Arrow and Pin go back to Select after one use. Pen and Lasso stay in hand.

With Select in hand:

- A click selects a thing. Shift and a click adds it, or takes it away. Shift and a drag on bare board draws a box that adds what it holds. A plain drag on bare board moves the view.
- A drag moves what is selected, and lines it up with what is near. Hold Cmd or Ctrl to line up with nothing, and Shift to keep to one direction. The arrow keys move it by one unit, and by five with Shift.
- A box or a note has handles to resize it.
- A selected arrow has a handle on each end. Drag one to point the arrow somewhere else. Drag its words to slide them along the line. Drag the arrow itself and it lets go of what it pointed at. An arrow moved by itself lines up with nothing.

While you draw an arrow, Shift holds it to steps of 15 degrees, and Cmd or Ctrl ties it to nothing.

Two fingers on a trackpad, or the wheel, move the view. A pinch, or the wheel with Cmd or Ctrl, zooms, from 20% to 400%. The keys + and - zoom, 0 goes to 100%, 1 fits everything and 2 fits what is selected. Cmd+Z or Ctrl+Z undoes, and with Shift it does the step again. Esc closes a note without sending it, and undo brings its words back.

Tap a part or a lane of a pipeline picture, and the agent opens it in focus. Press Esc to go back. Arrow keys step through a selected walk.

The board is built and tried for a browser on a Mac, with a trackpad, a mouse and a keyboard. How it behaves under the hand follows [Excalidraw](https://github.com/excalidraw/excalidraw): its rules for the pointer, the wheel, the camera, ink, selection, arrows, text and keys, written again for the board ([0004](docs/adr/0004-a-hand-built-canvas.md)). [workspace/THIRD_PARTY_NOTICES.md](workspace/THIRD_PARTY_NOTICES.md) lists what was adapted.

Every mark is open until the agent answers it with something you can see: a picture, or one sentence beside the mark that says how it read you ([0008](docs/adr/0008-a-mark-is-closed-only-by-something-the-owner-can-see.md)). The pill at the top left counts the open marks. The pill at the top right shows what the agent does: listening, drawing, waiting for your go, building, or away. The agent wakes about 1.5 s after you stop drawing, and about 0.3 s after you close a note.

## What runs on your machine, and what it may do

These limits come from the decision records in [docs/adr/](docs/adr/). Each record says why, and what the limit does not cover.

**The board server** (`keel-board open`). It listens on 127.0.0.1 only. It answers only to its own address and refuses pages from other origins. Every request for the board's data needs a token. The page's own files need none, because they hold nothing. Every token is new each time the server starts, and is worth nothing once it stops: a tab left open cannot hand a working token to whatever takes the port later. The address the command prints holds a code that works once, never a token, so no token rests in your browser's history. There is no cookie: a cookie for 127.0.0.1 would go to every local port.

It checks every event against the board's rules, and it refuses an event that breaks one ([0002](docs/adr/0002-the-server-refuses-an-event-that-breaks-a-rule.md)). Only you decide. Nothing is deleted. A part is built only with a real commit and a check that passed. A part the repository already had is called "already there": that is the agent's reading, and no check ran. An event that seems to hold a key or a password is refused, because the log is committed with the repository. The server also checks the log against these rules when it loads it.

A log read from disk grants nothing ([0009](docs/adr/0009-a-log-read-from-disk-grants-nothing.md)). The log travels with the repository, so it can say anything. A build runs only when you pressed "Build this" or Resume on this machine. The server also keeps a seal of the log it wrote, outside the repository. A log that is not that one came with a clone, a pull or a checkout, or someone edited it. The board tags what came that way as "not made here", and a banner says how much there is. The agent leaves those marks alone until you keep them, or take them off. A build in such a log waits for your Resume. Before you press it, the panel shows the check and every remark the builder would follow as yours.

When the log file is replaced while the board runs, as a pull or a checkout does, the board stops saving and says why. Stop it and open it again.

**The board agent.** The server starts one headless Claude Code process and wakes it when you pause ([0003](docs/adr/0003-the-board-server-hosts-the-agent.md)). It runs on your own Claude Code sign-in: keel starts it without `ANTHROPIC_API_KEY`. By default it uses Sonnet at low effort.

- It may read and list files inside the repository, and draw on the board through the board tools. Its only built-in tools are Read and Glob.
- It may not run commands, edit or write files, or search file contents.
- It may not read outside the repository's real path. It may not read inside `.git/`. It may not read files with secret names: `.env` files, keys, certificates and the usual credential files.
- It takes nothing from the repository as instructions: no project settings, no hooks, no `.mcp.json`, no `CLAUDE.md` ([0006](docs/adr/0006-the-hosted-agent-is-fenced-from-the-repository.md)). It can still read those as files.
- A turn that runs past 10 minutes is stopped.

What this does not cover: the deny list is a list of names. A secret under another name inside the repository can still be read, and drawn on the board. The fence stops instructions, not persuasion.

**The builder.** It starts only when you press "Build this" ([0007](docs/adr/0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)). By default it uses Sonnet at medium effort.

- It works in its own git worktree, on the branch `board/<chapter>`, kept outside the repository. It never touches your checkout.
- Its file tools write inside its folder in that worktree, and nowhere else.
- Its git is told where the worktree's own git folder is, and runs no hook. The code a check runs can write in the worktree, so nothing it leaves there is what git obeys.
- Its shell runs `git status`, `diff`, `log`, `show`, `add`, `commit`, `rev-parse` and `ls-files`, and the commands you add with `--link-opt builder-allow="npm test;npm run lint"`. Anything else is denied and reported on the board. It reads files with its file tools, not inside `.git/` and not files with secret names.
- It cannot run the check in its shell, and it cannot say "built". A tool of keel's runs the one check you agreed to, exactly as written, in the worktree. After each commit, when that check passes, the tool marks the part built, with the commit's hash. When it fails, the board shows the end of the output.
- The check runs code the builder wrote, so it runs in a sandbox: `sandbox-exec` on macOS, `bwrap` on Linux. It has no network. It writes only inside the worktree and a temp folder of its own. It cannot read keel's private folder, `~/.ssh`, `~/.aws`, `~/.claude` and a few more key folders. Its environment is a short allow-list, not yours. Its processes are stopped when the server stops. Where the system has no sandbox, only the allow-list holds, and the feed says so.
- It commits a brief and a decision record on its branch. It uses the repository's own folders for them, else `docs/briefs/` and `docs/adr/`. Its commits name you as the author and "Keel builder" as the committer.
- Merging the branch is your act. A part may take 30 minutes, and the check 10 minutes.

By pressing "Build this", you agree to run that one check command in the builder's worktree. The check is the one the blueprint shows, word for word. The server keeps that agreement outside the repository: the chapter, the check and the parts. A build whose check or parts differ from what you agreed to does not run. When the log changes outside the board, every agreement is dropped, and you press Resume to agree again.

What this does not cover:

- The check can read your other files. Only the folders named above are closed to it. It has no network to send them over, but what it prints reaches the feed, and what it writes reaches the branch.
- The Mac sandbox also stops the check from asking the system to open a file, to script another program or to start a job. That is a list, not a wall.
- On a system with no sandbox, the check runs as you, with only its environment cut down.
- The builder is a model that reads your repository. The fence limits what it can do, not what it can be told.

**Your own Claude Code session.** The installer registers a guard hook. It denies a Write or an Edit inside `.keel/board/`, and a shell command that writes there. It denies any read or write of keel's private folder, `~/.keel/boards/`, which holds the running server's tokens and the builds you agreed to. It reads the words of a command, so it stops mistakes, not an attacker.

## Where things live

| What | Where | In git? |
|---|---|---|
| The board log | `.keel/board/log.jsonl` in the repository | Yes. The log is the board's story and memory. Nothing is deleted from it ([0001](docs/adr/0001-the-board-is-an-append-only-log.md)). |
| Snapshots and dropped files | `.keel/board/assets/` | The log names them. Large files need not be committed. |
| That a server is up: its process and its port, no token | `.keel/board/server.json` | No. `.keel/board/.gitignore` keeps it out. |
| The board's key, the running server's tokens, the port, the builds you agreed to, the seal of the log, which lines came from outside, the agent's session, the builder's worktrees | `~/.keel/boards/<key>/`, or `$KEEL_STATE_DIR/boards/` | No. It is outside the repository. |
| A build's brief and decision record | on the branch `board/<chapter>` | They arrive when you merge. |

The port stays the same across restarts. The tokens do not: after a restart, use the tab the command opens, or run `keel-board link`. A tab from before says so.

## What it costs

These numbers were measured on one machine on 2026-11-17 and 2026-11-18, with a signed-in subscription. The dollar figures are what Claude Code reports for a turn. They are not a promise.

- **A turn of the board agent**, with Sonnet at low effort: $0.014 to $0.13. Most turns cost $0.01 to $0.04. A first note, which draws three pictures, cost $0.07, and the largest blueprint $0.13. Two whole sessions, from a first note to a build, cost $0.44 for 15 turns and $0.32 for 12.
- **How fast**: on four recorded boards the first picture came in 2.6 to 8 s, and the last in 9 to 36 s. A typed note got the real agent's first card in 4 to 5 s.
- **A wake** holds about 23,000 tokens of context. A warm wake reads about 15,000 of them from the prompt cache. The cache lasts an hour on a subscription ([0003](docs/adr/0003-the-board-server-hosts-the-agent.md)).
- **A build** on a toy repository, with one change from the owner in the middle: three parts ran end to end in about a minute, and four parts in under four, most of that waiting for the owner. The builder, with Sonnet at medium effort, cost $0.03 to $0.09 per part: $0.12 to $0.16 for three parts, $0.30 for four. The board agent's turns beside it cost $0.03. A build on a real project has not been measured.
- **A large board**: a log of 50,000 events, 9 MB, loads in about a quarter of a second.

## What is not there yet

- The board tools in your own Claude Code session. The installer adds only the guard hook. The tools are in `workspace/plugin/`.
- Pen and touch input have not been tried on a real pen or touch device ([0004](docs/adr/0004-a-hand-built-canvas.md)). Talk has not been tried with a real voice.
- Pictures fit a pipeline best. The agent can draw a screen only as one plain drawing. Branches in a walk, state machines and data shapes cannot be drawn yet ([0005](docs/adr/0005-the-agent-draws-from-a-grammar.md)).
- Your `CLAUDE.md` does not shape what the board agent says.
- The check's sandbox exists on macOS and on Linux with `bwrap`. On other systems the check runs with only its environment cut down, and the feed says so.
- The check for secrets on the board is a list of shapes. A secret that looks like ordinary words gets through. A file you drop on the board is not looked at, and git does not ignore `.keel/board/assets/`.
- A log from elsewhere can say a part is built. The board draws it as the log says. The terminal lists such a line when this repository does not have its commit.
- A build on a real project, and daily use, have not happened yet.

## Check that it works

```sh
scripts/check.sh board              # the workspace: typecheck, unit tests, the plugin's files
KEEL_E2E=1 scripts/check.sh board   # the same, and the browser tests (they use your Chrome)
scripts/check.sh install            # the installer, against throwaway folders
```

To see the board with no agent and no cost, run `keel-board open --link none` in a scratch repository. To see one real agent turn, run `npm run live-check -w @keel/board-plugin` in `workspace/`. It posts a note and prints how many seconds the card took. It costs one turn on your subscription.

To change the board's code, start with [workspace/README.md](workspace/README.md).

## The earlier way of working: rules and skills (frozen)

Keel began as a suite for building software with Claude Code: 12 always-on rules, 17 skills, 2 review agents and 2 hooks. The board is where new work goes now. The suite is frozen: no new features, and fixes only when the board needs one. The rules still load in every session and still apply. Rule 2, "facts are yours, decisions are mine", is the core of the board. Rule 5 defines what built means.

The suite was designed from three public skill collections. [docs/analysis.md](docs/analysis.md) says what was taken from each, what was left out, and why.

### The change in how you work

A naive loop: write a prompt, let the agent build, look at the result or trust the tests the agent wrote. Keel replaces it with three habits.

1. **Decide before the agent builds.** The agent finds every fact itself. You answer only the real decisions, each with a recommended answer in front of you. What you decide is written down (a spec, a decision record, a glossary term), so the next session starts from files and not from memory.
2. **"The tests pass" is not proof.** A change is done when the real thing ran: the CLI, the app, the API. An agent that did not write the code exercises it, and reviewers that never saw the author's reasoning try to break it. Every finding needs evidence.
3. **Spend your attention where it pays.** Every report ends with "Read these yourself": the two or three places where a mistake would cost the most. A mistake that happens twice becomes a check (a type, a lint rule, a test), not a longer prompt.

### Install

`./install.sh` installs the suite with the board. It symlinks the skills, agents, and rules into your Claude Code config directory (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), so edits in this folder are live. It adds hook entries to `settings.json` and leaves a one-time copy at `settings.json.keel-backup`. It needs `jq` for the hooks. Start a new session afterwards and type `/keel`.

### A day with keel

| You are | Type | What you get |
|---|---|---|
| Not sure what to use | `/keel <situation>` | the one next step |
| In a repo for the first time | `/repo-setup` | the checks found, `QUALITY.md`, a pointer block in `CLAUDE.md`, and an audit of the pipeline |
| Starting from a fuzzy idea | `/grill` | an interview, one round of decisions at a time |
| Planning work bigger than one sitting | `/spec` | a spec with checkable success criteria, then vertical slices |
| Making a small, clear change | `/build <what to change>` | the change, test-first, proven, reviewed, committed |
| Building a slice | `/build docs/specs/x.md slice 2` | the same, against the slice's acceptance criteria |
| Facing a bug | "this is broken: ..." | `diagnose` builds a failing loop before it guesses |
| Reviewing a pull request | `/vet 123` | findings with evidence, drafted as comments |
| Opening a pull request, releasing | `/ship` | a PR that carries its evidence. It asks before every push. |
| Seeing the same mistake again | `/retro` | a check that prevents it |
| Trying to understand code | `/explain how ...`, `/explain quiz ...` | a traced path with `file:line`, or a quiz |

### The flow

```
/grill ──▶ /spec ──▶ /architect ──▶ /build ──────────────────────▶ /ship ──▶ /retro
 align     specify    design         tdd ▶ clean up ▶ prove ▶ vet    PR, CI,    fix the
           + slice    + brief        one slice per fresh session     release    environment
```

You approve a design from its brief, a short page in plain words. The decision record stays the contract for agents. `/build` writes the brief's result when it ends.

A small change skips straight to `/build`. Use the whole line when the work is bigger than one sitting, hard to reverse, or still vague.

### What is in the box

**Rules** ([rules/keel.md](rules/keel.md)). Twelve lines that load in every session: restate first, facts are the agent's and decisions are yours, smallest change, evidence labelled `verified`, `inferred`, or `guess`, done means the whole contract with nothing moved to a follow-up, never lower the bar to get green, fix the cause, no comment unless the code cannot say it.

**Skills you type**

| Skill | Job |
|---|---|
| `/keel` | The map. Names the next step. |
| `/repo-setup` | Prepares a repo: checks, quality bar, pointers, and an audit of what the pipeline enforces. |
| `/spec` | Writes the spec, then slices it. |
| `/build` | One change, end to end. Picks the rigor. |
| `/ship` | Pull request, CI, merge, release with a rollback plan. |
| `/retro` | Turns a mistake into a check. |

**Skills that also fire on their own**

| Skill | Fires when |
|---|---|
| `grill` | you ask to be interviewed or challenged on a plan |
| `architect` | a change crosses a module boundary or is hard to reverse |
| `prototype` | a decision depends on something you can only see by running it |
| `tdd` | tests are being written or changed |
| `diagnose` | something is broken, failing, or flaky |
| `refactor` | structure changes and behaviour must not |
| `perf` | something is slow, or a number is about to be reported |
| `prove` | a change needs proof from the real artifact |
| `vet` | a change or pull request needs review |
| `observability` | logs, metrics, traces, or alerts are being added |
| `explain` | you want to understand code |

**Agents.** `verifier` exercises the real artifact and returns PASS, FAIL, or INCONCLUSIVE per claim. `reviewer` reviews a diff through the lenses its brief names (spec, tests, break-it, security, standards), and runs the proof's claims when there is nothing to launch. Neither can edit files, and neither is told how the change was built.

**Hooks.** The guard ([hooks/guard.sh](hooks/guard.sh)) denies a force push to the default branch and `rm -rf` of home or root. Asks before other force pushes, direct pushes to the default branch, `git reset --hard`, `git clean -f`, discarding the whole tree, `--no-verify`, `gh pr merge`, a `gh api` call that changes branch protection, releases, and package publishes. Silent otherwise. It is a seatbelt that reads command text, not a sandbox. Start Claude Code with `KEEL_GUARD=off` to switch it off for a session.

The brief check ([skills/keel/scripts/brief-check.sh](skills/keel/scripts/brief-check.sh)) runs after every Write and Edit of a Markdown file in a `briefs` directory. It reports each sentence over 20 words, each paragraph over 6 sentences, each semicolon, and each word on its short list of words ASD-STE100 does not approve. Claude sees the report and rewrites those lines.

The board's guard is the third hook. It is described [above](#what-runs-on-your-machine-and-what-it-may-do).

**Scripts.** `skills/vet/scripts/bar-guard.sh` lists where a diff may have lowered the bar (suppressions, skipped or deleted tests, removed assertions, stubs, empty handlers, bypasses). `/repo-setup` offers to copy it into a repo as a CI job. `scripts/check.sh` tests keel itself.

**Who runs each gate.** This decides how much a gate can be trusted.

| Gate | Run by | Holds when the agent skips a step? |
|---|---|---|
| The Bash hook | the harness, on every command | yes |
| The brief check | the harness, on every Write and Edit of a brief | yes, for those tools. A brief written through Bash is checked only when the agent runs the script, as `architect` and `/build` say. |
| The contract walk, `prove`, `vet`, the bar guard inside `vet` | the agent, when it follows `/build` | no |
| CI, branch protection, the bar guard as a CI job | the pipeline, on every pull request | yes |

That is why `/repo-setup` audits the pipeline, and why `/ship` ties each verdict to a commit and never merges past a required check ([pipeline.md](skills/repo-setup/pipeline.md)).

### The rigor dial

`/build` picks a level, says why, and you can override it.

| | Light | Standard | High stakes |
|---|---|---|---|
| Fits | small, reversible, one module | a slice or a feature | auth, money, user data, migrations, public interfaces, concurrency |
| Design | interface named in the restate | `architect` when a boundary changes | `architect`, your approval before logic |
| Proof | exercised by the author, labelled as not independent | the reviewer, or the `verifier` agent when there is something to launch | `verifier` agent on Opus, fresh context |
| Review | 1 reviewer | 1 reviewer, every lens | 2 reviewers |
| Agents | 1 | 1, or 2 with something to launch | 3 |

There is one review round. Fixes are checked with each finding's own reproduction, and a commit that only fixes a finding or records the result stays covered by the verdict ([verdicts.md](skills/keel/verdicts.md)). A second agent pass runs only when a fix changes the design, and it checks only that diff.

### What keel uses from Claude Code, and what it does not

Each built-in was judged on one question: for this job, does it give a better result inside this flow than a keel skill would?

| Built-in | Verdict | Reason |
|---|---|---|
| `run`, `/run-skill-generator` | used | Launching apps per project type is plumbing. The recipe is saved in the repo. `prove` adds claims, independence, and a verdict. |
| `/goal` | used | Only the harness can keep a session running until a condition holds. `/build` adds the discipline. |
| `/clear`, `/compact`, `/subtask` | used | Harness mechanisms for context. |
| `/doctor`, `/skill-doctor`, `/insights` | used | Diagnostics that feed `/retro`. |
| `/code-review`, `/security-review` | not in the flow | They review a diff without the contract. `vet` checks the change against the spec, checks that the tests have teeth, demands a reproduction for every bug claim, and gives the reviewer a fresh context with none of the author's reasoning. Two review tools would mean two reports to reconcile. |
| `/simplify` | not in the flow | It starts 4 review agents on every run. Measured on a 10-line function in Claude Code 2.1.325: about 66,000 input tokens and no findings, on top of the subagent run a standard change already costs. `/build` cleans up in line instead. Type `/simplify` yourself on a diff too large to reread. |
| `/verify` | not in the flow | `prove` is the one proof procedure. |
| `/plan` | not in the flow | Its plan lives in the conversation. `/grill`, `/spec`, and `/architect` leave files that outlive the session. |
| `/batch` | not in the flow | Many parallel agents for one mechanical change. A codemod makes the same edit every time and costs far less. |
| `/init` | not in the flow | `/repo-setup` writes a short pointer block, not a long generated `CLAUDE.md`. |

Apart from `/simplify`, these verdicts come from how each tool is designed, not from a measured comparison. To test the biggest one: for your first five slices, run `/code-review` once after `vet` says READY. If it finds a real bug that `vet` missed more than once, bring that to `/retro` and change `vet`.

### Files keel writes in your repos

| File | Written by | Holds |
|---|---|---|
| `## Keel` block in `CLAUDE.md` | `/repo-setup` | the fast check, the full check, and where everything else lives |
| `QUALITY.md` | `/repo-setup` | the floor, measured limits, ratchets, review standards, dated exceptions |
| a copy of `bar-guard.sh` and one CI job | `/repo-setup`, only on your yes | the bar guard on every pull request |
| `docs/specs/<slug>.md` | `/spec` | the spec, and its slices with status |
| `GLOSSARY.md` | `grill`, when a term is pinned | one meaning per word |
| decision records | `grill`, `architect` | hard-to-reverse decisions, one to three sentences each |
| `docs/briefs/<slice>.md` | `architect`, or `/build` at Standard and above | your page for one slice in short ASD-STE100 sentences: the goal, how it works, what you get, the progress board, what you approve, and the result |

A repo's own conventions win. Keel points at what exists and does not create a second copy. The board adds its own files, listed [above](#where-things-live).

### What the suite costs

- **Every session**: the rules (about 510 words) and the descriptions of the 11 model-invoked skills (about 2,900 characters). `scripts/check.sh lint` prints the current numbers.
- **Per change**: light is 1 subagent run. Standard is 1, or 2 when there is something to launch. High stakes is 3. A fix that changes the design adds one scoped re-check.
- **Measured on a real slice** (uLLM M1-T2, Opus 5.5, medium effort): with one agent per lens and repeated review rounds it cost $25.15 at API list prices, about 70% of a 5-hour window. The current Standard gate, replayed on the same commit, cost $1.74 to $1.93. Re-priced, the whole slice comes to about $11.73, about a third of a window. [docs/analysis.md](docs/analysis.md) section 8 has the breakdown, and what one reviewer misses.
- **Context**: start each slice in a fresh session. The spec is the memory. `/keel` has the rules for when to continue, clear, hand off, or compact.

## Changing keel

Edit the files here. The rules, skills, agents and hooks are live through the symlinks. The board needs `./install.sh` again, or `npm run build` in `workspace/`. Run `scripts/check.sh` after any edit. It checks every skill and reference, runs the guard hook against a table of commands, runs `bar-guard.sh` against a throwaway repo, and runs `brief-check.sh` against a clean and a bad brief. It round-trips the installer against throwaway folders, and runs the board's checks when Node 22 is there. When a keel skill misfires, `/retro` proposes the edit as a diff.

Keep it small. Before adding a skill, ask whether a rule, a line in an existing skill, or a check in the repo would do the job.
