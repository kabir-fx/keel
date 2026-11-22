# Keel

Keel is a board where you work out an idea with an agent, solidify it, watch it get built, try it, and approve it into your main branch. The board is a canvas in your browser, one per repository. You write, draw, drop files in, or talk. The agent is on the board with you, and it answers in pictures. When the idea is right, you solidify it. Then a builder writes the code in the background, and the same pictures fill in as it goes.

It runs on your machine, beside Claude Code, on your own Claude Code sign-in. It is early work: it has run on recorded boards and toy repositories, not yet in daily use.

Keel also holds an earlier way of working: rules, skills, review agents and hooks for Claude Code. That part is now frozen, and its rules still apply. It is described [at the end of this page](#the-earlier-way-of-working-rules-and-skills-frozen).

## The loop

1. **Ideate.** You mark the board: a note, a sketch, a circle, a cross, a dropped file, a spoken remark. There is no send button: when you pause, the agent answers in pictures. While you draw boxes and arrows of your own it holds, and answers the whole drawing once you write a note or press "Answer now". It shows how it read you, what the repository already has, and two to four approaches side by side. Each approach names its risk, and the agent gives its lean. You circle what you like and cross out the rest.
2. **Solidify.** You lasso the pictures you pick and press Solidify. The agent reads the idea back as one picture, the blueprint. It lists your picks, where each came from, and what was left out. It says how you will know it works, and names the parts to build and one check command. It names how you will try the result: a page, an app or a terminal, with its command. It may name one setup command, such as `npm ci`, that makes a fresh copy ready to run. Beside "Build this" it shows these commands, and where the build starts: "This build starts from main at abc1234, on a branch of its own." Nothing is built before this step.
3. **Watch.** You press "Build this" on the blueprint. A builder writes the code in its own copy of the repository, on the canvas's branch, one commit per part. It runs the setup once first. A part fills in only when the agreed check passes after its commit. A panel shows the build track, a feed of what the builder did, and a Pause button. You can keep marking, or leave: the board can tell you with a notification when something needs you.
4. **Try it.** When every part is built and the builder's run has ended, the panel offers "Try it". An app counts as built only once the builder has started it in its copy, as you will try it, and it answered: until then the panel says the builder is starting it. When it does not answer, the build stops with what it printed, and "Try again" runs that step again. "Try it" opens the try room, where the board runs what the blueprint named, in the build's own copy, only when you press Start ([0013](docs/adr/0013-a-finished-build-is-run-to-be-tried.md)). An app runs with `PORT` set and shows in a frame on the board, with a link that opens it in a tab, and what it printed. A terminal opens in the copy with the command typed in, and you go on from there. A page opens as files. Beside it is the blueprint's "How you will know it works", as a list you tick. When the app does not start, the room shows why and the last lines it printed. Esc closes the room, except inside the terminal.
5. **Approve.** "Approve: merge into main" merges the canvas's branch into your main branch, on your machine ([0014](docs/adr/0014-the-board-keeps-the-home-branch.md)). Main moves by fast-forward only, to a commit the agreed check passed on. When main moved since the build began, the builder joins the new commits into the branch first and runs the check again. When both changed the same lines, it joins them, and the board asks you to try it again and approve again. When your uncommitted changes are in the way, the board names the files and moves nothing. Approve waits until the builder's run on the canvas has ended, so main never takes a build without its last commit. After the merge, the branch and the copy are taken away. "Push main to origin" is a second press, and is never forced. When origin has commits that main here does not have, it does not take the push: the board says so in one sentence, with git's own line folded under it, and the home line says the two have both moved. One `git pull` in the board's folder joins them; the board does not do it for you.

A mark on a decided part reopens that part only. The build waits until you decide that part again, and then it builds the change. Then the loop starts again from step 1.

The Story is the second view of the board. A board has many canvases. A canvas is a blank place for an idea, and it owns a branch, `board/<its title>`. The Board view shows one canvas at a time, and the pill names it. The Story lists every canvas, newest first: each idea on it in words (idea, building part 3 of 6, built: try it, merged into main), its branch, and what can be done now: Open, Try it, Approve and Delete. A part the repository already had shows as "already there", apart from the parts built here.

- **Start a new canvas** in the Story for an idea of its own, on a branch of its own. A first note on it starts the idea.
- **A second idea on one canvas.** A note on a canvas where everything is built starts another idea there, on the same branch. Ideas on one canvas are approved together: the press names them all, and asks first. Approve waits while one of them still builds.
- **The next idea while one waits.** A build on another canvas starts from main, so it does not have an idea that is built and not approved yet. The blueprint says so, with a link to try that idea first.
- **Delete** takes a canvas off the board, with every idea on it, its build and its show. Its branch and copy go, with every commit main does not have. The confirmation names each idea and counts those commits. What was merged stays in main. The log keeps every line.
- **The home line** on top of the Story says how main stands with its remote: level, commits to push (with Push), behind with your files in the way, diverged (run `git pull`, then look again), not answering, or following no remote. When main needs you, the Board view says so once too, with the way to the Story.
- When the agent draws on another canvas, or a build there is done or needs you, a notice says so, and one press goes there.

## Quick start

One command, on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/kabir-fx/keel/main/get.sh | bash
```

It installs what the board needs, each only when it is missing: git, Node (into `~/.local/share/keel`, only when no Node 22 or newer is there), Claude Code (with Anthropic's own installer) and the board. It puts the `keel-board` command in `~/.local/bin` and on your PATH. It needs no sudo, except to install git on Linux. Run it again to update the board. `curl ... | bash -s -- --uninstall` removes what it made, and keeps Claude Code, git and your boards.

```sh
mkdir my-idea && cd my-idea    # an empty folder, or a repository you already work in
keel-board
```

The first time, the page that opens is a setup page ([0015](docs/adr/0015-the-first-page-sets-the-machine-up.md)). It lists what is left: Claude Code, your Claude sign-in, git. A Claude Code older than the board can run gets an "Update Claude Code" button there ([0018](docs/adr/0018-the-board-runs-only-a-claude-code-new-enough.md)). "Sign in to Claude" opens Claude's sign-in in a new tab, and the board opens by itself once you have approved it. Nothing is typed in a terminal.

**With npm.** When you have Node 22 or newer, `npx keel-workspace` runs the board without installing it, and `npm install -g keel-workspace` installs the `keel-board` command. The same setup page installs Claude Code and signs you in.

**From a clone.** Use a clone when you want to change keel itself, or the skills and instructions it ships. It needs Node 22 or newer, npm, git and `jq`.

```sh
git clone https://github.com/kabir-fx/keel.git && cd keel
./install.sh
cd ~/code/any-folder
keel-board
```

`./install.sh` builds the board in `workspace/` and links the `keel-board` command into `~/.local/bin` (or `$KEEL_BIN_DIR`). It says so when that folder is not on your PATH. It also installs the rules and skills below. After a `git pull`, run it again: it rebuilds the board.

`keel-board` makes `.keel/board/` in the folder, starts the board server, and opens the board in your browser. Before it loads the board, it fetches the remote your main branch follows, and fast-forwards main when the remote is ahead and main has nothing of its own. It never asks for a password, and it holds the board up a few seconds at most. When your changes are in the way, the two have diverged, or the remote does not answer, the board says so and builds from main as it is here. Open it in a folder for the project, not in your home folder: the agent can read the files in the folder a board is opened in, so the command refuses your home folder. It prints an address that works once, for five minutes. The page trades it for a key that lasts until the server stops, and keeps that key for the address. For a second tab, or after a restart, `keel-board link` prints a fresh address. The server runs until you press Ctrl-C or run `keel-board stop`. The agent shows as present in the pill at the top right.

The folder may be new and empty, and it need not be a git repository. When you press "Build this" there, the builder makes it a repository and starts its branch from nothing ([0011](docs/adr/0011-an-empty-folder-is-built-from-nothing.md)). A folder that holds files of yours and no commit is different: the build stops and asks you to commit them first, because the builder does not commit your files for you.

| Command | What it does |
|---|---|
| `keel-board` | Start the board for the current folder |
| `keel-board open [dir]` | Start the board for a folder. `--no-browser` only prints the address. `--port n` picks the port. |
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
| Select | S | Pick, move and resize items. A click anywhere inside a box picks the box, unless it lands on something the box was drawn round. Delete takes the selected item off, an agent's picture too. Nothing is deleted from the log, and undo puts it back. |
| Pan | H, or hold Space | Move around the board |
| Pen | P | Draw by hand. A circle on a picture picks it. A cross drops it. A sketch is a request too. |
| Box | B | Draw a box, then type its label inside it. The box grows down to fit the words. Double-click it with Select to change its label, and the agent's answers to the old words come off. |
| Arrow | A | Draw an arrow. An end that lands on a thing, or stops just short of one it points at, holds on to that thing when either moves. |
| Note | N | Write a note. When you change its words, the agent's answers to the old words come off and the agent reads it again. |
| Pin | I | Pin one place inside an item, such as one step of a picture |
| Lasso | L | Hold several items together. Solidify takes what the lasso holds. A lasso asks the agent nothing. |
| Erase | E | Drag across your own ink, boxes, arrows and pins, or one of the agent's pictures, to take it off. A sweep that reaches your drawing takes only the drawing, never the picture under it. Undo brings back what a sweep took. |
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

The board is built and tried for Chrome on a Mac, with a trackpad, a mouse and a keyboard. How it behaves under the hand follows [Excalidraw](https://github.com/excalidraw/excalidraw): its rules for the pointer, the wheel, the camera, ink, selection, arrows, text and keys, written again for the board ([0004](docs/adr/0004-a-hand-built-canvas.md)). [workspace/THIRD_PARTY_NOTICES.md](workspace/THIRD_PARTY_NOTICES.md) lists what was adapted.

Every mark is open until the agent answers it with something you can see: a picture, or one sentence beside the mark that says how it read you ([0008](docs/adr/0008-a-mark-is-closed-only-by-something-the-owner-can-see.md)). The pill at the top left counts the open marks. The pill at the top right shows what the agent does: listening, drawing, waiting for your go, building, or away. The agent wakes about 1.5 s after you stop drawing, and about 0.3 s after you close a note.

The agent is on the board too, as a small blue drop with two eyes. Its eyes are shut while it listens. When it wakes it goes to your mark and reads it, and its tag says what it does. It draws its answer where you can watch: a small picture right of what it answers, a wide one below, each dragged out to its size and then filled in. Several pictures in one answer are drawn at once, by one cursor each, and the cursors merge when the last is done ([0010](docs/adr/0010-motion-shows-what-the-log-and-presence-say.md), [0016](docs/adr/0016-the-agent-is-a-figure-and-draws-with-several-cursors.md)).

## What runs on your machine, and what it may do

These limits come from the decision records in [docs/adr/](docs/adr/). Each record says why, and what the limit does not cover.

**The board server** (`keel-board open`). It listens on 127.0.0.1 only. It answers only to its own address and refuses pages from other origins. Every request for the board's data needs a token. The page's own files need none, because they hold nothing. Every token is new each time the server starts, and is worth nothing once it stops: a tab left open cannot hand a working token to whatever takes the port later. The address the command prints holds a code that works once, never a token, so no token rests in your browser's history. There is no cookie: a cookie for 127.0.0.1 would go to every local port.

It checks every event against the board's rules, and it refuses an event that breaks one ([0002](docs/adr/0002-the-server-refuses-an-event-that-breaks-a-rule.md)). Only you decide. Nothing is deleted. A part is built only with a real commit and a check that passed. A part the repository already had is called "already there": that is the agent's reading, and no check ran. An event that seems to hold a key or a password is refused, because the log is committed with the repository. The server also checks the log against these rules when it loads it.

A log read from disk grants nothing ([0009](docs/adr/0009-a-log-read-from-disk-grants-nothing.md)). The log travels with the repository, so it can say anything. A build runs only when you pressed "Build this" or Resume on this machine. The server also keeps a seal of the log it wrote, outside the repository. A log that is not that one came with a clone, a pull or a checkout, or someone edited it. The board tags what came that way as "not made here", and a banner says how much there is. The agent leaves those marks alone until you keep them, or take them off. A build in such a log waits for your Resume. Before you press it, the panel shows the check and every remark the builder would follow as yours.

When the log file is replaced while the board runs, as a pull or a checkout does, the board stops saving and says why. Stop it and open it again.

A finished page is shown from an address of its own ([0012](docs/adr/0012-a-finished-build-is-shown-from-an-address-of-its-own.md)). The page shown is code a model wrote, so the server never serves it from the board's address, where your token is. It serves a copy of the built files from a second port on 127.0.0.1, at an address that holds a key made new for each start. Only the board's own page may frame it. The board refuses every request that comes from that address. The address is told to your page only, never to the agent, and it is never written to the log. With `--no-browser`, nothing opens by itself, and "Try it" on the build panel opens it.

A build is run to be tried, on your press only ([0013](docs/adr/0013-a-finished-build-is-run-to-be-tried.md)). The press carries the command the page showed, and the server runs it only when it is the idea's own command, word for word, as you agreed to it with "Build this". It runs in the build's copy, boxed in like the check, with two differences: it has the network, and an app may listen on 127.0.0.1. An app is on a port of its own, so it is another origin than the board and cannot read your token. A show stops when you stop it, when the idea is approved, deleted or built again, and when the server stops. Its address and its state are never written to the log.

The server moves your main branch only as record [0014](docs/adr/0014-the-board-keeps-the-home-branch.md) says: by fast-forward, when the board opens and on your Approve. It never rewrites it, never stashes, commits or overwrites your uncommitted changes, and never pushes without your press. Fetching and pushing use your own git credentials. With none stored, the remote counts as not answering.

**The setup page.** While this machine is not ready, the page that opens is a setup page, not the board ([0015](docs/adr/0015-the-first-page-sets-the-machine-up.md)). The server looks for Claude Code on your PATH and in `~/.local/bin`, asks them `claude --version` in that order until one is 2.1.316 or newer ([0018](docs/adr/0018-the-board-runs-only-a-claude-code-new-enough.md)), asks it `claude auth status`, and looks for git. Nothing else runs until you press. "Install Claude Code", or "Update Claude Code" when the one found is too old, fetches Anthropic's installer from `https://claude.ai/install.sh` and runs it as you: it installs into your home folder. "Sign in to Claude" runs `claude auth login`, which opens Claude's sign-in page in your browser. Your sign-in is Claude Code's own: keel never sees a password or a token, and stores nothing of it. Only the owner's page may ask for either step. A sign-in still waiting when the server stops is ended with it.

**The board agent.** The server starts one headless Claude Code process and wakes it when you pause ([0003](docs/adr/0003-the-board-server-hosts-the-agent.md)). It runs on your own Claude Code sign-in: keel starts it without `ANTHROPIC_API_KEY`. By default it uses Sonnet at low effort.

- It may read and list files inside the repository, and draw on the board through the board tools. Its only built-in tools are Read and Glob.
- It may not run commands, edit or write files, or search file contents.
- It may not read outside the repository's real path. It may not read inside `.git/`. It may not read files with secret names: `.env` files, keys, certificates and the usual credential files.
- It takes nothing from the repository as instructions: no project settings, no hooks, no `.mcp.json`, no `CLAUDE.md` ([0006](docs/adr/0006-the-hosted-agent-is-fenced-from-the-repository.md)). It can still read those as files.
- A turn that runs past 10 minutes is stopped.

What this does not cover: the deny list is a list of names. A secret under another name inside the repository can still be read, and drawn on the board. The fence stops instructions, not persuasion.

**The builder.** It starts only when you press "Build this" ([0007](docs/adr/0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)). By default it uses Sonnet at medium effort.

- It works in its own git worktree, one per canvas, kept outside the repository. The canvas's branch is named from its title at its first "Build this": `board/<title>`, with `-2` when the name is taken. It starts from main as the server just read it, never from where your folder is. Every later idea on the canvas is built on the same branch. It never touches your checkout.
- In a folder with no commit and no file of yours, its branch starts from an empty first commit, made on no branch of yours. In a folder that is no git repository it runs `git init` first. Your own branch has no commit until you approve.
- It runs the setup you agreed to once, in the worktree, before the first part, with the network on. It may write to the worktree, a temp folder and the usual package caches (`~/.npm`, `~/.cache`, `~/Library/Caches` and the like). For an app, the build is done only when the app has started and answered on its port once.
- The worktree stays when the build ends, so Try it runs in it. It is made again from the branch when it is gone.
- Its file tools write inside its folder in that worktree, and nowhere else.
- Its git is told where the worktree's own git folder is, and runs no hook. The code a check runs can write in the worktree, so nothing it leaves there is what git obeys.
- Its shell runs `git status`, `diff`, `log`, `show`, `add`, `commit`, `rev-parse` and `ls-files`, and the commands you add with `--link-opt builder-allow="npm test;npm run lint"`. Anything else is denied and reported on the board. It reads files with its file tools, not inside `.git/` and not files with secret names.
- It cannot run the check in its shell, and it cannot say "built". A tool of keel's runs the one check you agreed to, exactly as written, in the worktree. After each commit, when that check passes, the tool marks the part built, with the commit's hash. When it fails, the board shows the end of the output.
- The check runs code the builder wrote, so it runs in a sandbox: `sandbox-exec` on macOS, `bwrap` on Linux. It has no network. It writes only inside the worktree and a temp folder of its own. It cannot read keel's private folder, `~/.ssh`, `~/.aws`, `~/.claude` and a few more key folders. Its environment is a short allow-list, not yours. Its processes are stopped when the server stops. Where the system has no sandbox, only the allow-list holds, and the feed says so.
- It commits a brief and a decision record on its branch. It uses the repository's own folders for them, else `docs/briefs/` and `docs/adr/`. Its commits name you as the author and "Keel builder" as the committer.
- When the build is done and it holds a page that stands alone, the builder copies the committed files into keel's private folder for the server to show. It leaves out files whose names start with a dot, files with secret names, and links.
- Merging the branch is your act: Approve on the board. A part may take 30 minutes, and the check 10 minutes.

By pressing "Build this", you agree to run that one check command in the builder's worktree, the setup command, and the command that shows the build when you press Try it. They are the ones the blueprint shows, word for word. The server keeps that agreement outside the repository: the chapter, the commands and the parts. A build whose check or parts differ from what you agreed to does not run. When the log changes outside the board, every agreement is dropped, and you press Resume to agree again.

What this does not cover:

- The check can read your other files. Only the folders named above are closed to it. It has no network to send them over, but what it prints reaches the feed, and what it writes reaches the branch.
- The Mac sandbox also stops the check from asking the system to open a file, to script another program or to start a job. That is a list, not a wall.
- On a system with no sandbox, the check runs as you, with only its environment cut down.
- The builder is a model that reads your repository. The fence limits what it can do, not what it can be told.
- An app is told to listen on 127.0.0.1, and the macOS sandbox cannot hold it to that: an app that listens on every address can be reached from the network you are on while it runs.
- Where the system has no sandbox, as on Windows, Try it runs the command with a short environment and no box, and the try room says so.
- An app that needs a secret the repository does not hold, such as an `.env` file, will not start in the build's copy. The try room shows what it printed.
- The terminal needs the `script` command, which macOS and most Linux systems have. Where it is missing, the command runs on plain pipes: line tools work, full-screen ones do not. A terminal has no box against you: what you type there is yours to run, inside the box.
- Deleting a canvas with unmerged work loses its commits. Git keeps them for a while by their hashes, and the board does not promise that.
- The page a finished build shows runs in your browser like any page you open. It cannot act on the board, but it can reach the network, and every page the board shows shares one address, so one can read what another kept in the browser.

**Your own Claude Code session.** The installer registers a guard hook. It denies a Write or an Edit inside `.keel/board/`, and a shell command that writes there. It denies any read or write of keel's private folder, `~/.keel/boards/`, which holds the running server's tokens and the builds you agreed to. It reads the words of a command, so it stops mistakes, not an attacker.

## Where things live

| What | Where | In git? |
|---|---|---|
| What `get.sh` installs: the board, and a Node when the machine had none | `~/.local/share/keel/`, and the `keel-board` launcher in `~/.local/bin` | No. Not under `~/.keel`: a build's check may not read that folder, and it must be able to run this Node. |
| The board log | `.keel/board/log.jsonl` in the repository | Yes. The log is the board's story and memory. Nothing is deleted from it ([0001](docs/adr/0001-the-board-is-an-append-only-log.md)). |
| Snapshots and dropped files | `.keel/board/assets/` | The log names them. Large files need not be committed. |
| That a server is up: its process and its port, no token | `.keel/board/server.json` | No. `.keel/board/.gitignore` keeps it out. |
| The board's key, the running server's tokens, the port, the builds you agreed to, the seal of the log, which lines came from outside, the agent's session, the builder's worktrees, the copy of each finished build that is shown | `~/.keel/boards/<key>/`, or `$KEEL_STATE_DIR/boards/` | No. It is outside the repository. |
| A build's brief and decision record | on the canvas's branch, `board/<title>` | They arrive in main when you approve. |

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
- An install from npm adds nothing to your own Claude Code session: no guard hook, no rules, no skills. Those come only with `./install.sh` from a clone.
- The package from npm has run on a Mac only. It declares macOS and Linux, and Linux is not tried.
- `get.sh` has run on one Mac with Apple silicon. Its Linux steps, an Intel Mac, and the wait for Apple's developer tools window have run only against stand-ins. Windows has no `get.sh`.
- The setup page's sign-in has run once for real, on a Mac, with a Claude Pro account. A sign-in that ends while the board is open is not noticed until the agent's next turn fails.
- Pen and touch input have not been tried on a real pen or touch device ([0004](docs/adr/0004-a-hand-built-canvas.md)). Talk has not been tried with a real voice.
- Pictures fit a pipeline best. The agent can draw a screen only as one plain drawing. Branches in a walk, state machines and data shapes cannot be drawn yet ([0005](docs/adr/0005-the-agent-draws-from-a-grammar.md)).
- Your `CLAUDE.md` does not shape what the board agent says.
- The check's sandbox exists on macOS and on Linux with `bwrap`. On other systems the check runs with only its environment cut down, and the feed says so.
- The check for secrets on the board is a list of shapes. A secret that looks like ordinary words gets through. A file you drop on the board is not looked at, and git does not ignore `.keel/board/assets/`.
- A log from elsewhere can say a part is built. The board draws it as the log says. The terminal lists such a line when this repository does not have its commit.
- A build on a real project, and daily use, have not happened yet.

## Check that it works

```sh
scripts/check.sh board              # the workspace: lint, typecheck, unit tests, the plugin's files
KEEL_E2E=1 scripts/check.sh board   # the same, and the browser tests (they use your Chrome)
scripts/check.sh package            # the npm package: build it, stage it, install it, run it
scripts/check.sh install            # the installer, against throwaway folders
scripts/check.sh get                # get.sh, against a throwaway home, with stand-ins for every download
scripts/check.sh shell              # shellcheck, over keel's own scripts
```

Every pull request runs `scripts/check.sh` on GitHub, on Ubuntu and on macOS. The browser tests run there once, on Ubuntu. On a Mac, where Chrome draws with the GPU, `KEEL_E2E=1 scripts/check.sh` also compares the ink pixel for pixel.

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

Edit the files here. The rules, skills, agents and hooks are live through the symlinks. The board needs `./install.sh` again, or `npm run build` in `workspace/`. Run `scripts/check.sh` after any edit. It checks every skill and reference, runs the guard hook against a table of commands, runs `bar-guard.sh` against a throwaway repo, and runs `brief-check.sh` against a clean and a bad brief. It round-trips the installer against throwaway folders, and runs the board's and the package's checks when Node 22 is there. When a keel skill misfires, `/retro` proposes the edit as a diff.

A merge to `main` is a release. When the merge changes what the npm package holds, GitHub publishes the next version of `keel-workspace`, installs it from npm on Ubuntu and on macOS, and only then makes it the version `get.sh` and `npx keel-workspace` install. Nobody types a version: a `feat` commit raises the minor number, and anything else the patch number. [Record 0017](docs/adr/0017-a-merge-to-main-is-a-release.md) has the steps, and how to take a release back.

Keep it small. Before adding a skill, ask whether a rule, a line in an existing skill, or a check in the repo would do the job.
