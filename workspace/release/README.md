# Keel Workspace

Keel is a board where you work out an idea with an agent, solidify it, and watch it get built. The board is a canvas in your browser. You write, draw, drop files in, or talk. The agent is on the board with you, and it answers in pictures. When the idea is right, you solidify it. Then a builder writes the code in the background, and the same pictures fill in as it goes.

It runs on your machine, beside [Claude Code](https://claude.com/claude-code), on your own Claude Code sign-in. It is early work.

## Start

You need Node 22 or newer, git, and Claude Code installed and signed in.

```sh
mkdir my-idea && cd my-idea
npx keel-workspace
```

The folder may be new and empty, or a repository you already work in. The command makes `.keel/board/` in it, starts the board server on your machine, and opens the board in your browser. Press Ctrl-C to stop it.

To install it for good:

```sh
npm install -g keel-workspace
keel-board            # in any project folder
```

Open the board in a folder for the project, not in your home folder: the agent can read the files in the folder a board is opened in.

## The loop

1. **Ideate.** You mark the board: a note, a sketch, a circle, a cross, a dropped file. There is no send button. When you pause, the agent answers in pictures, with two to four approaches side by side.
2. **Solidify.** You lasso the pictures you pick and press Solidify. The agent reads the idea back as one picture, the blueprint, with the parts to build and one check command.
3. **Watch.** You press "Build this". A builder writes the code on its own branch, one commit per part. A part fills in only when the agreed check passes. When the result is a page a browser can open by itself, the board opens it for you.

## Commands

| Command | What it does |
|---|---|
| `keel-board` | Start the board for the current folder |
| `keel-board open [dir]` | Start the board for a folder. `--no-browser` only prints the address. `--port n` picks the port. |
| `keel-board status [dir]` | Is a server running, and what the agent and the builder do now |
| `keel-board link [dir]` | Print a fresh address for the board's page. It works once. |
| `keel-board stop [dir]` | Stop the server |

`--link-opt model=opus` and `--link-opt effort=medium` change the agent's model and effort. `--link none` runs no agent. `--builder none` runs no builder. `keel-board --help` lists the rest.

## What it does on your machine

- The server listens on 127.0.0.1 only, and every request for the board's data needs a token that is new for each start.
- The agent is a headless Claude Code process on your own sign-in, so it uses your Claude usage. It may read files inside the folder, and it may not run commands or write files. It may not read files with secret names, such as `.env` files and keys.
- The builder starts only when you press "Build this". It works in its own copy, on the branch `board/<name>`, and never touches your checkout. Merging that branch is your act: `git merge board/<name>`.
- The one check you agreed to runs in a sandbox with no network.
- The board's log is `.keel/board/log.jsonl` in your folder, and it is meant to be committed. Tokens and the builder's copies stay outside it, in `~/.keel/boards/`.

The full list of limits, and what they do not cover, is in the [README on GitHub](https://github.com/kabir-fx/keel#what-runs-on-your-machine-and-what-it-may-do).

## Where it has run

It is built and tried on a Mac, in Chrome. Linux is not tried yet. Windows is not supported.

## Changing how it works

The package is the board as it ships. To change keel itself, or the instructions its agent and its builder follow, use a clone: see [the repository](https://github.com/kabir-fx/keel).

## Licence

MIT. Code adapted from other projects is listed in `THIRD_PARTY_NOTICES.md`.
