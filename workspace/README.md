# The keel workspace

This folder is the code behind the board and the `keel-board` command. It is one npm workspace of six packages, in TypeScript, with React in the browser and no database. It needs Node 22 or newer.

What the board is, and what it may do on a machine, is in the [top README](../README.md). The decisions behind the design are in [docs/adr/](../docs/adr/).

## The packages

| Package | Folder | Owns |
|---|---|---|
| `@keel/protocol` | `protocol/` | The contract. It holds the events, the items, the model and the picture specs. It holds the only reducer and the rules R1 to R8. It holds the digest the agent reads, the wire, and the two seams: the agent link and the builder. Start with its [README](protocol/README.md). |
| `@keel/pictures` | `pictures/` | One renderer per picture kind, as plain React components with no canvas dependency. The look, in `src/styles.css`. A gallery of every kind. |
| `@keel/board-server` | `server/` | The `keel-board` command. It owns the log. It checks each event against the rules and appends it. It sends events to the page over a websocket, and to the agent over HTTP. It wakes the agent when the owner pauses, drives the builder, and serves the built app. |
| `@keel/board-app` | `app/` | The canvas: the owner's tools, the chrome, where pictures are placed, and fixture replay. |
| `@keel/board-plugin` | `plugin/` | The Claude Code side. It holds the board tools (an MCP server), the hosted agent link and the hosted builder. It also holds the board skill with its picture grammar, and the guard hook. |
| `@keel/board-e2e` | `e2e/` | Browser tests with Playwright on the system Chrome. They cover fixture replay, the tools, the views, and the real server with a stand-in agent. |

The app, the server and the plugin depend on the protocol. The app also depends on the pictures. The server finds the plugin's built link by its path, `plugin/dist/hosted-link.js`, not as a package.

## Commands

Run these in `workspace/`.

| Command | What it does |
|---|---|
| `npm install` | Install the dependencies. `../install.sh` runs it too. |
| `npm run typecheck` | `tsc` in each package |
| `npm test` | The unit tests of protocol, pictures, server, app and plugin, with Vitest |
| `npm run build` | The server's bundle (`server/dist/keel-board.js`), the app (`app/dist/`), and the plugin's bundles (`plugin/dist/`) |
| `npm run e2e` | Build, then run the browser tests. They use the Chrome installed on the machine. No browser is downloaded. |
| `KEEL_LIVE_AGENT=1 npm run e2e` | The same, plus `e2e/agent.spec.ts`: the real hosted agent answers a note. It costs a real agent turn on your subscription. To run only that spec: `KEEL_LIVE_AGENT=1 npx playwright test agent.spec.ts` in `e2e/`. |
| `npm run check` | Typecheck, unit tests and browser tests |
| `npm run fixture` | Rebuild the golden fixture (see below) |
| `npm run live-check -w @keel/board-plugin` | One real agent turn: a note goes in, and it prints the seconds until the agent's card lands |
| `npx vite --config pictures/gallery/vite.config.ts` | The picture gallery: every kind, and the fixture's pictures |

From the keel folder, `scripts/check.sh board` runs the typecheck and the unit tests, and checks the plugin's skill and JSON files. `KEEL_E2E=1 scripts/check.sh board` adds the browser tests.

To run a board while you work on it:

- `node server/bin/keel-board.mjs open <repo> --link none` runs a board with no agent. `--link script:e2e/agents/echo.mjs` runs the stand-in agent, which answers each mark with one card.
- `KEEL_BOARD_SOURCE=1` runs the server from its source, through `tsx`, even when a bundle exists.
- `KEEL_STATE_DIR=<folder>` puts the board's private files in that folder, not in `~/.keel`. They are the board's key, the running server's tokens, the port, the builds the owner agreed to, the seal of the log, the agent's session and the builder's worktrees. Use a fresh folder for a throwaway board, and always for a test: a test must never write in `~/.keel`.
- For the app with hot reload: start the server with `--port 4790 --dev-origin http://localhost:5173`, then run `npm run dev -w @keel/board-app`. Vite sends `/api` and `/ws` to `KEEL_SERVER`, which is `http://127.0.0.1:4790` by default.

## The contract, and who changes it

`protocol/` is the contract every package builds on. Only the orchestrator, the session that coordinates the work, edits it. If your work needs a change there, say so when you hand back. Carry on with what does not depend on it.

Some rules come with the contract:

- The board is an append-only log. Nothing is deleted. Taking an item off appends an event ([0001](../docs/adr/0001-the-board-is-an-append-only-log.md)).
- The server refuses an event that breaks a rule. The refusal names the rule, and says in one sentence what to do instead. A new kind of event needs a row in the table `MAY` in `protocol/src/rules.ts`. It also needs a rule test before the server takes it ([0002](../docs/adr/0002-the-server-refuses-an-event-that-breaks-a-rule.md)).
- The actor comes from the connection's token, never from the event.
- Only the system may say a part is built, with a commit that exists and a check that passed ([0007](../docs/adr/0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)).

## Adding a picture kind

A kind touches three packages. The tests fail until all three agree.

1. **The contract.** Add the kind's schema to `protocol/src/pictures.ts`, then to the `PictureSpec` union and to `PICTURE_KINDS`. Give it a title in `pictureTitle` when it has no `title` field. Add its example to `EXAMPLES` in `protocol/test/schema.test.ts`. List its subs, the things a mark can point at, in the table in `protocol/README.md`. This step is the orchestrator's.
2. **The renderer.** Write `pictures/src/<Kind>.tsx`: a plain component that draws at its own natural size and never knows where it sits. Put `data-sub="<sub>"` on each thing a mark can point at, so the app can hit-test it. Add a case to `Picture`, and the kind to `DRAWN_KINDS`, in `pictures/src/Picture.tsx`. Add an example in `pictures/test/examples.ts`, and look at it in the gallery.
3. **The agent.** Describe the kind in `plugin/skills/board/grammar.md`, with one example. The hosted agent reads the grammar in its system prompt. `plugin/test/grammar.test.ts` checks that every example passes the contract's schema and that every kind has one.

Layout, sizes and colours belong to the renderer, never to the spec. A spec names things by id, never by position or coordinate ([0005](../docs/adr/0005-the-agent-draws-from-a-grammar.md)).

## Writing an agent link

The server talks to an agent through one seam: `AgentLink` in `protocol/src/link.ts` ([0003](../docs/adr/0003-the-board-server-hosts-the-agent.md)). A link is a module that exports `createLink(ctx)`, which returns an `AgentLink`:

- `wake(wake)` tells the agent that the board changed. `wake.text` is the digest, which is what the agent reads. It resolves when the agent's turn ends.
- `close()` stops the agent.
- `ctx` holds the repository's folder, the server's address and the agent's token. It also holds a private folder for the link's own files, the `--link-opt` options, and `presence()` for the pill.

The agent posts to the board over HTTP with the agent's token, through `ROUTES` in `protocol/src/wire.ts`. The plugin's board tools do this: they read `KEEL_BOARD_URL` and `KEEL_BOARD_TOKEN`, which the hosted link sets.

Run a link with `keel-board open --link ./my-link.mjs --link-opt key=value`. A package name works too. The smallest link is a script: `--link script:<file>`, where the file exports `answer(wake, post)`. `e2e/agents/echo.mjs` is one.

What the server does around a link:

- It wakes the agent once per pause. The pause is 1.5 s after a stroke, a box, an arrow, a pin or a lasso. It is 0.3 s after a note, a spoken remark, a file or an act.
- It holds new marks while a turn runs, and sends one wake when the turn ends. Each digest is built from what is open on the board, so a link that dies loses nothing.
- A wake that runs past 10 minutes counts as failed. A failed wake is tried again after 2, 8 and 30 seconds.

The hosted link, `plugin/src/hosted-link.ts`, is the one that ships. Its fence is in [0006](../docs/adr/0006-the-hosted-agent-is-fenced-from-the-repository.md): keep it when you change the link. Its options include `model`, `effort`, `timeout` (seconds), `bin` (the `claude` command), `transcript` and `debug`.

## Writing a builder

The builder is the second seam: `Builder` in `protocol/src/link.ts`. The `--link` module may also export `createBuilder(ctx)`, or `--builder <module>` names another module. `--builder none` runs no builder.

- `run(job)` builds the track and resolves when the builder stops: `done`, `paused` or `failed`. The job holds the chapter, the parts in build order, the agreed check, and the brief. The server never starts two runs at once.
- `pause()` stops after the current step. `close()` frees what the builder holds.
- `ctx.systemToken` is for what the build's tools report, such as a commit and a check that passed.

The hosted builder, `plugin/src/hosted-builder.ts`, works in its own git worktree and branch, kept in the board's private folder. A part becomes built only through its `board_check` tool, which runs the agreed check and nothing else. Its options are `builder-model`, `builder-effort`, `builder-allow` (extra commands, split by `;`), `builder-timeout`, `check-timeout` (both in seconds), `builder-prompt` and `builder-transcript`. The server's own tests drive a fake builder. The plugin's tests use the fake Claude processes in `plugin/test/`.

## The golden fixture

`protocol/fixtures/engine-loop/` is one board log that plays the seven storyboard screens, from a blank board to a built idea. It has 88 events, 7 checkpoints (`main`, `pictures`, `model`, `focus`, `solidify`, `watch`, `story`) and 2 assets.

- `story.ts` is the source. It writes each beat as a draft from the owner, the agent or the system.
- `build.ts` sends every beat through `admit()`, the same check the server runs. It writes `log.jsonl`, `checkpoints.json` and `assets/`. A beat that breaks a rule stops the build and names the beat and the rule.
- `npm run fixture` rebuilds it. `protocol/test/fixture.test.ts` fails when `log.jsonl` is not what `story.ts` builds, byte for byte. So change `story.ts`, rebuild, and keep both.
- The app replays it with no server and no agent: open `/?fixture=engine-loop&at=3` on the app for screen 3. The app has two small fixtures of its own in `app/src/fixtures/`. A protocol fixture of the same name wins.

The fixture is part of the contract, so the orchestrator changes it.
