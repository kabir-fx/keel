# The keel workspace

This folder is the code behind the board and the `keel-board` command. It is one npm workspace of six packages, in TypeScript, with React in the browser and no database. It needs Node 22 or newer.

What the board is, and what it may do on a machine, is in the [top README](../README.md). The decisions behind the design are in [docs/adr/](../docs/adr/).

## The packages

| Package | Folder | Owns |
|---|---|---|
| `@keel/protocol` | `protocol/` | The contract. It holds the events, the items, the model and the picture specs. It holds the only reducer and the rules R1 to R8. It holds the digest the agent reads, the wire, and the two seams: the agent link and the builder. Start with its [README](protocol/README.md). |
| `@keel/pictures` | `pictures/` | One renderer per picture kind, as plain React components with no canvas dependency. The look, in `src/styles.css`. A gallery of every kind. |
| `@keel/board-server` | `server/` | The `keel-board` command. It owns the log. It checks each event against the rules and appends it. It sends events to the page over a websocket, and to the agent over HTTP. It wakes the agent when the owner pauses, drives the builder, keeps the home branch, runs the shows the owner tries, and merges an approved canvas. |
| `@keel/board-app` | `app/` | The canvas: the owner's tools, the chrome, where pictures are placed, and fixture replay. |
| `@keel/board-plugin` | `plugin/` | The Claude Code side. It holds the board tools (an MCP server), the hosted agent link and the hosted builder. It also holds the board skill with its picture grammar, and the guard hook. |
| `@keel/board-e2e` | `e2e/` | Browser tests with Playwright on the system Chrome. They cover fixture replay, the tools, the views, and the real server with a stand-in agent and a scripted builder, through try it, approve, push and delete. |

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
- `KEEL_STATE_DIR=<folder>` puts the board's private files in that folder, not in `~/.keel`. They are the board's key, the running server's tokens, the port, the builds the owner agreed to, the seal of the log, the agent's session, the builder's worktrees and the pid files of running shows. Use a fresh folder for a throwaway board, and always for a test: a test must never write in `~/.keel`.
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
2. **The renderer.** Write `pictures/src/<Kind>.tsx`: a plain component that draws at its own natural size and never knows where it sits. Put `data-sub="<sub>"` on each thing a mark can point at, so the app can hit-test it. Mark what the picture is made of with `asPart` (`data-build`, see `pictures/src/build.ts`), so the board can draw it on in order: the root and each sheet a frame, and everything that shows inside a head, block, shape, line or label; `pictures/test/build.test.tsx` checks it. Add a case to `Picture`, and the kind to `DRAWN_KINDS`, in `pictures/src/Picture.tsx`. Add an example in `pictures/test/examples.ts`, and look at it in the gallery.
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

- `run(job)` builds the track and resolves when the builder stops: `done`, `paused` or `failed`. The job holds the chapter, its canvas and the canvas's title, the parts in build order, the agreed check, setup and show, the brief, and `base`: the home branch and its commit, as the server just read them. The server never starts two runs at once.
- The branch is the canvas's: named from `job.canvasTitle` at its first run (`board/<slug>`), made from `job.base.commit`, and used by every later chapter on that canvas. Report it with `ctx.place(canvas, { branch })` as soon as it is there. The server keeps it for this machine, never in the log.
- With `done`, the result may carry `show: { dir, page }` (`BuildShow`): a folder inside the builder's private folder (`ctx.stateDir`) that holds a copy of the built files, and the page in it to open. The server serves that folder from a port of its own, and only the board's page may frame it ([0012](../docs/adr/0012-a-finished-build-is-shown-from-an-address-of-its-own.md)). It takes plain files only: no link, no hard link, no name that starts with a dot.
- `show(req)` starts an `app` or a `terminal` in the canvas's copy, on the owner's press ([0013](../docs/adr/0013-a-finished-build-is-run-to-be-tried.md)). The session's `ready` resolves with the app's address once it answers on `PORT`. `stop()` ends the command and everything it started. `boxed: false` says it runs with no box.
- `refresh(req)` merges the home commit into the canvas's branch and runs every agreed check on the result: `level`, `joined`, `resolved` (both changed the same lines, so the owner tries again), or `failed`. The server calls it at Approve when the home branch moved ([0014](../docs/adr/0014-the-board-keeps-the-home-branch.md)).
- `discard({ canvas, branch })` takes the copy away, and the branch when asked. The server calls it after a merge and when the owner deletes a canvas.
- `pause()` stops after the current step. `close()` frees what the builder holds.
- `ctx.systemToken` is for what the build's tools report, such as a commit and a check that passed, and `build.proved`.
- For a chapter whose show is an `app`, the builder starts the app once when every part is built, as the owner will try it, and posts `build.proved` with the system token after its last commit. Only then is the chapter `built`; until then it is `building` with every part built. An app that does not answer ends the run `failed`, with no `build.proved`. The run the owner's Try again starts for such a chapter has an empty track: it goes straight to the start. While a run is active on a canvas, `works[canvas].busy` is `building`, and the server refuses Approve and Try it there.

A builder that keeps no copy leaves out `show`, `refresh` and `discard`. The board then shows a page only, and Approve says what is missing when the home branch moved.

What the server does around a builder, by canvas: it reads the home branch before each build and at Approve, runs no build on a canvas while it merges or deletes it, stops a canvas's shows when it is approved, deleted or built again, and moves the home branch only by fast-forward. `server/src/home.ts` keeps the home branch; `server/src/tryout.ts` runs the shows.

The hosted builder, `plugin/src/hosted-builder.ts`, works in one git worktree per canvas, kept in the board's private folder. The worktree stays after the build, so the show runs in it, and it is made again from the branch when it is gone. In a folder with no commit and nothing of the owner's, the branch starts from an empty first commit, and a folder that is no repository gets `git init` first ([0011](../docs/adr/0011-an-empty-folder-is-built-from-nothing.md)). A part becomes built only through its `board_check` tool, which runs the agreed check and nothing else. It runs the setup once in a new worktree. For an `app`, it starts the app once when every part is built, gives the model one turn to fix it when it does not answer, and posts `build.proved` after the last commit. The brief and the decision record never take or replace a file of the same name in the repository: a second "An adder" gets `an-adder-2.md`. When the build is done, `plugin/src/show.ts` looks for a page that stands alone among the committed files and copies them out as the show. `plugin/src/session.ts` runs an app or a terminal for the show, boxed in with the network on; the terminal is a pty made by the system's `script`. Its options are `builder-model`, `builder-effort`, `builder-allow` (extra commands, split by `;`), `builder-timeout`, `check-timeout` (both in seconds), `builder-prompt`, `builder-transcript` and `app-wait` (seconds an app has to answer). The server's own tests drive a fake builder. The plugin's tests use the fake Claude processes in `plugin/test/`. The browser tests use `e2e/agents/builder.mjs`, a scripted builder that makes real branches and commits, starts the app once and posts `build.proved`, runs a real app and a real terminal, and joins and discards for real. From the server's environment, `KEEL_E2E_APP_SILENT=<n>` makes the app never answer at its first n starts, and `KEEL_E2E_HOLD_LAST_STEP=1` holds the run after its last part until a file `last-step.go` is beside the repository.

## The golden fixture

`protocol/fixtures/engine-loop/` is one board log that plays the seven storyboard screens, from a blank board to a built idea. It has 88 events, 7 checkpoints (`main`, `pictures`, `model`, `focus`, `solidify`, `watch`, `story`) and 2 assets.

- `story.ts` is the source. It writes each beat as a draft from the owner, the agent or the system.
- `build.ts` sends every beat through `admit()`, the same check the server runs. It writes `log.jsonl`, `checkpoints.json` and `assets/`. A beat that breaks a rule stops the build and names the beat and the rule.
- `npm run fixture` rebuilds it. `protocol/test/fixture.test.ts` fails when `log.jsonl` is not what `story.ts` builds, byte for byte. So change `story.ts`, rebuild, and keep both.
- The app replays it with no server and no agent: open `/?fixture=engine-loop&at=3` on the app for screen 3. The app has two small fixtures of its own in `app/src/fixtures/`. A protocol fixture of the same name wins.

The fixture is part of the contract, so the orchestrator changes it.

## How the agent's answers are shown

The agent has a cursor on the board, and a picture it posts is drawn on from the mark it answers. The motion shows only what the log and the agent's presence say, and nothing waits on it: a press on a picture that is being drawn on lands it at once ([0010](../docs/adr/0010-motion-shows-what-the-log-and-presence-say.md)).

What the owner sees, and where it comes from:

- **The cursor goes to the mark.** The server's wake names the newest mark the agent was handed (`wakePresence` in `server/src/wake.ts`).
- **Its tag says what the agent does.** The hosted link reads the agent's stream as it is written: "drawing" when a `board_post` begins, "drawing a card" once the first picture's kind is written (`followCall` in `plugin/src/hosted-link.ts`, `plugin/src/presence.ts`).
- **The picture is drawn on.** The cursor draws the picture's arrow, pulls the picture out by its corner, and rests while what is on it fills in, in the order its renderer marked (`buildParts` in `pictures/src/build.ts`).
- **What is not a new picture has a film of its own.** A placeholder is drawn on like a picture, and pulled from its rectangle to the finished one when the agent finishes it. A picture the agent draws again keeps its paper, and what is on it fills in anew. An answer in words is written in from the left under its mark (`planFinish`, `planRedraw`, `planChip` in `app/src/arrival/plan.ts`).
- **The camera moves only when it must.** It makes the smallest move that shows the picture with its mark, and only for an answer to the owner's last mark. A placeholder finished at another size is shown again the same way (`app/src/camera/reveal.ts`, `app/src/board/news.ts`).

How it is built, in `app/src/`:

| Where | What it is |
|---|---|
| `arrival/cues.ts` | Reads two moments of the board and says what deserves motion. Pure. |
| `arrival/plan.ts` | One cue and what the page measures become plain data: beats for the parts, legs for the cursor. Pure, so the same input gives the same film. |
| `arrival/player.ts` | Plays plans on the page, one after another: Web Animations for the parts, the cursor led along its legs, all on the board's one frame loop. |
| `arrival/useArrivals.ts` | Wires the three to the board, and lands what plays when it must. |
| `overlay/cursorStore.ts` | The cursor, one per board: presence names its place, an arrival leads it. |
| `motion/timing.ts`, `motion/ease.ts` | Every number and every easing, each with a line that says what it is for. |
| `motion/plays.ts` | `motionPlays()`: the one answer to "does anything play". |

Nothing plays with "reduce motion", on a hidden page, in the Story or the focus view, or for a picture that is out of view. The picture is simply there, as it always was. When "reduce motion" is turned on or the page is hidden while something plays, it lands at once. There is no animation library: the parts are moved by the browser's Web Animations.

### Playing a fixture

A fixture can be played, not only opened. This is how the motion is looked at and tested.

- `/?fixture=arrival&at=1&play=1` opens the board as it was before checkpoint 1 and feeds in the events up to it over time, with the presence the server and the link would set. Leave `at` out to play the whole log from a blank board.
- Add `&clock=manual` and nothing on the page moves by itself. `await window.renderAt(ms)` moves the board's clock forward to that moment, in steps of 1/60 s, and resolves when the page shows it. The same address and the same moments give the same frames. It goes forward only: load the page again to go back. `window.__keel` says how far the play has run.
- `e2e/replay.ts` has the helpers for a browser test: `openReplay`, `renderAt`, `playStatus` and `contactSheet`, which writes many moments as one image.
- `app/src/fixtures/arrival/` is the fixture made for the motion: a note answered by a card, a small picture, a remark answered in words, a spread, a placeholder that is finished, and a redraw. `story.ts` is its source; `npx tsx src/fixtures/arrival/build.ts` in `app/` rebuilds it.

These hooks exist only on a played fixture. A live board has none of them and is never on the manual clock.
