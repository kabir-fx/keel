# @keel/protocol: the board contract

Every other package depends on this one. Read this page first, then the source file for the part you need. The source is the truth: each schema carries a comment that says what it is for.

| File | Holds |
|---|---|
| `src/ids.ts` | `Id`, `Target`, `Sub`, `Anchor`, `Box`, `Actor`, `AssetPath` |
| `src/model.ts` | The model: lanes, parts, edges, walks. Part states. Model patch ops. |
| `src/pictures.ts` | The picture grammar: one spec per picture kind |
| `src/items.ts` | Items: the owner's marks and the agent's pictures |
| `src/events.ts` | The events of the log, drafts and stamps |
| `src/state.ts` | `BoardState` and its selectors: `openThings`, `openQuestions`, `markings`, `liveItems`, `trackProgress`, `alreadyThere` |
| `src/reduce.ts` | `reduce(state, event)` and `replay(events)` |
| `src/rules.ts` | `check(state, draft)`: rules R1 to R8 |
| `src/log.ts` | `admit`, `admitAll`, `audit`, `parseLog`, `formatEvent` |
| `src/digest.ts` | `digest(state)` and `renderDigest`: what the agent reads on a wake |
| `src/wire.ts` | Websocket messages, HTTP routes, presence, the server file |
| `src/link.ts` | The agent link seam: `AgentLink`, `CreateLink` |
| `src/fixture.ts` | Checkpoints of a fixture |
| `fixtures/engine-loop/` | The golden fixture: the seven storyboard screens as one log |

## The life of an event

1. A sender makes a **draft**: an event with no `id` and no `at`.
2. The log owner calls `admit(state, draft, by, at)`. It checks the shape, sets `by` from who the sender really is, checks the rules, numbers the event (`e1`, `e2`, ...) and applies it.
3. A refused draft changes nothing. The refusal has a rule id and one sentence the sender can act on.
4. The state of a board is `replay(events)`. Nothing else holds state.

## Who sends what

| Actor | Sends |
|---|---|
| owner | Marks (`item.add` with a note, ink, box, arrow, pin, lasso, file or voice item). Moves of any item, and `item.place` from the app. `chapter.open`, `solidify`, `build.start`, `build.pause`, `build.resume`, `choice.pick`, `ask`. |
| agent | Pictures (`item.add` with a picture item), `item.update` of its own pictures, `answer`, `model.patch`, `part.state`, `feed.add`, `moment.add`. |
| system | `board.open`, `item.place`, `part.state` and `feed.add` from hooks. |

## Marks, targets and anchors

- A **target** is `{ item, sub? }`. A `sub` names one thing inside a picture: `part:door`, `step:reply`, `approach:b`, `option:cap-door`.
- A renderer puts `data-sub="<sub>"` on the element for each thing a mark can point at. The app wraps each item in an element with `data-item="<id>"`. So the app hit-tests the DOM and needs no knowledge of any picture.
- The app, not the agent, fills `targets`, the ink `hint` (`circle`, `cross`, `underline`, `none`) and the `snapshot`.
- Everything inside a mark is counted from the top-left corner of its `box`: ink strokes, a lasso's path, an arrow's ends, a pin's point. So moving a mark changes its `box` and nothing else, and it keeps its id and its answer.
- An arrow end that has a target is drawn to where that target is now.
- An arrow end with a target may carry a **tie**, `{ at: [x, y], mode }`: a spot inside the target as shares of its box (`[0, 0]` its top-left corner, `[1, 1]` its bottom-right), and how the end is drawn to it. `inside` draws the end at the spot. `outline` aims at the spot and stops at the target's outline. An end with a target and no tie is drawn as it was before ties existed.
- The owner sets an end of their arrow again with `item.update` and `arrowFrom` or `arrowTo`: `{ at, target?, tie? }`. It replaces that end whole, so an end with no target lets go. `labelAt` (0 to 1) is where the arrow's label sits along the line. Pointing an arrow at another thing makes it a new remark, as changed words do.
- An **anchor** is `{ item, sub?, box }`: the thing a mark was drawn against, and where that thing was then. The app draws the mark so that `box` lands on where the thing is now. Ink, lassos, boxes and arrows move and scale. Notes, pins and files only move: their top-left corner follows, and their size stays.
- An arrow hangs on the thing it points at, else on the thing it starts from. So when the owner sets an end again and that thing changes, the same `item.update` says so with `anchor`: the new anchor, or `null` when the arrow now hangs on nothing. The arrow's `box` and ends in that change are counted from the new anchor. It names another thing, never the arrow itself. No other mark's anchor can be changed.
- A note with `plain: true` is a label in the owner's hand with no paper behind it, such as a name inside a sketch.
- A lasso is drawn as a tidy dashed outline round where its targets are now, not as the raw path, so it stays right when pictures move.
- A cross or a circle on a target is read from the ink on the board by `markings(state)`. No event dims a picture: taking the stroke off undoes it.

The subs each picture kind offers:

| Kind | Subs |
|---|---|
| `text` | `q:1` to `q:3` for its questions |
| `shelf` | `tile:<id>` |
| `lanes` | `step:<step id>`, `lane:<lane id>` |
| `spread` | `approach:a` to `approach:d`, and `step:<letter>-<step id>` inside one |
| `mini` | `box:1` to `box:5` |
| `pipeline` | `part:<id>`, `lane:<id>` |
| `walk` | `step:<n>` |
| `focus` | `option:<id>` |
| `blueprint` | `pick:1` to `pick:10`, `part:<id>`, `assumed:1` to `assumed:8` |
| `choice` | `option:<id>` |
| `free` | none |

## Pictures and placement

- The agent never gives coordinates. A picture item has no `box` when it is added.
- The app measures the rendered picture, finds room for it, and posts `item.place` with the `box`. `place` on the item says what it belongs next to: an item (`near`), optionally one thing inside it (`sub`), and optionally on which side of it (`side`: `right`, `below`, `left` or `above`). With no `place`, a small picture goes right of what it answers and a wide one below what it belongs to; when the spot is taken it slides down, or up for `above`. A picture is placed once: a second `item.place` is refused under R8, so two open tabs cannot both place it, and the app ignores that refusal. A later move or resize is an `item.update`.
- `status: "drawing"` is a placeholder the owner sees at once. The agent replaces it with the finished picture through `item.update`. The page that showed the placeholder places the finished picture at the top left corner the placeholder stood at: a `place` in that update does not move it.
- A blueprint always names its `check`: the one command the owner agrees to by pressing "Build this". It lists in `assumed` everything the agent decided that the owner did not say, so the owner reads it before the press.
- `pipeline`, `walk`, `focus` and `blueprint` name parts and walks of the board's model. The agent patches the model first, then posts the picture. A `pipeline` with no `model` of its own stays live: it redraws when a part changes state.

## Open marks

- Every owner mark is **open** until something the owner can see answers it. So is each of the owner's acts: `solidify`, `build.start`, `build.pause`, `build.resume`, `choice.pick`, `ask`, and the owner's own `part.state`. An act is named by its event id.
- A mark or an act is answered:
  - while a finished picture that names it in `answers` is on the board. A placeholder (`status: "drawing"`) answers nothing yet, and a picture taken off the board answers nothing any more;
  - by an `answer` event, which must say how the agent read it (`read`). The board shows that sentence beside the mark;
  - an act only: by a `feed.add` that names it in `answers`.
- A lasso is never open. It is the owner holding things together, for a solidify or for their next remark. It wakes nobody. `heldLassos(state)` lists the ones no solidify has used, and the digest shows them as SELECTED.
- When the owner changes what a mark says, it is open again. A picture drawn before the change no longer answers it.
- `model.patch` and `part.state` carry no `answers`.
- `openQuestions(state)` lists the questions on the agent's text cards that no mark of the owner's points at yet. A mark on the card as a whole answers all of its questions.
- `openThings(state)` lists what is open, in the order it reached the log. `openCount(state)` is the number on the board pill. `isAnswered(state, id)` is the one test.

## States

- A **part** is `idea`, `solid`, `building`, `built` or `later`.
  - Only the owner makes a part solid. `solidify` lists the parts it decides: exactly the ones the owner saw as ideas. Nothing is decided by default.
  - `building` needs a solid part on the track of a chapter the owner started with `build.start`, and no pause.
  - `built` comes from `building` only, from the system only, with a `commit` and a `check` that passed. The check's command must be the one the owner agreed to in `build.start`.
  - A decided part goes back to `idea` for the owner, or for the agent when it names in `because` a mark of the owner's on that part that is still open and was made after the part was decided.
  - A part the owner decided once stays the owner's, even reopened: an agent cannot drop it, put it off, rename it or move it to another lane while it is decided. What the owner put off, only the owner brings back.
- A **chapter** is `idea`, `solid`, `building` or `built`. It is built when every part on its track is built. A part the owner put off counts as off the track. A part is on one building track at a time.
- A part with `external: true` is outside the system, such as a client. It is there already, and its state never changes. Draw it plain.
- A part added as `built` with `shelf: true` is one the repository already had. It is "already there", not "built": nothing on this board built or checked it. `alreadyThere(part)` answers that one question for every view, and the digest lists such a part as `[already there]`. When the owner reopens it and the board builds it with the agreed check, it is `built` like any other.
- A part with no `lane` is work that has no place in the pipeline, such as a check or a line in the docs. It shows on the build track and in the blueprint, and not in a pipeline picture.
- A `focus` opens one part or one lane. A tap on a lane sends `ask` with `lane`.

## What stays as the owner saw it

- A picture the owner picked at `solidify`, and the blueprint the owner pressed "Build this" on, can no longer be redrawn or taken off by the agent. A change is a new picture that comes `from` it. The owner can still move it.
- A choice the owner picked is frozen the same way: its options, its words and the question round them.
- The owner can take anything off their board, an agent's picture too. Taking an answer off opens the mark it answered.
- Once a chapter is decided, only the owner renames it. Where a decided part lives (`files`) and what is noted on it stay too.
- The agent gives no coordinates: its picture has no `box`, and it cannot move one.
- In the feed, a commit and a check are evidence. Only the system reports them. An agent's entry is an `update` or a `problem`, in words.

## The wire

- The app talks to the server over a websocket: `ClientMessage` and `ServerMessage` in `src/wire.ts`.
- The plugin and the `keel-board` command use HTTP: `ROUTES` in `src/wire.ts`.
- Each connection has a token, and the token sets the actor. The draft's own `by` is ignored.
- `build.start` names the check its blueprint shows, word for word, when it names a blueprint.
- Presence (`listening`, `drawing`, `waiting`, `building`, `away`) is live and never logged. While it is `drawing` it may also say what the agent does (`doing`: `reading`, `thinking`, `drawing` or `writing`) and which picture is being written (`picture`: its kind, and its title once that is whole).

## No secret on the board (R9)

The log is committed with the repository. Every event is looked at before it is admitted, whoever sent it. One that seems to hold a key, a token, a private key or a password in an address is refused, with a sentence that says what it looked like. `src/secrets.ts` has the list of shapes. It is a list: a secret that looks like ordinary words gets through.

## What reaches the builder

`renderBrief(state, chapter)` writes the idea as a page: the picks, the parts in build order, what is already there, the walk, what was left out, what the agent assumed, the proof and the check. Under each part it puts what the owner said on that part since the idea was decided, in the owner's words (`remarksOnPart`). So a change the owner asks for mid-build reaches the builder even when the agent forgets to rewrite the part. Every free text in it is put on one line.

## The private file

`PrivateBoardFile` in `src/wire.ts` is what the server keeps for a board outside its repository, at `<state root>/boards/<privateBoardKey(dev, ino)>/board.json`. It holds:

- `boardKey`: the board's own secret on this machine. A server proves with it that it is this board's server. It is not a token and lets no request in.
- `running`: the tokens of the server that runs now, the owner's among them. They are new for each start and gone when it stops.
- `consents`: the builds the owner started on this machine.
- `log`: the seal of the log as this machine's server last wrote it, its size and the SHA-256 of its bytes.
- `foreign`: the runs of events that came with a log from outside and that the owner has not kept.

A log read from disk grants nothing: a repository can ship a log that says anything. Only a build with a consent here is ever run here, with exactly the consent's check.

A log whose seal is not the one on file was changed outside the server: it came with a clone, a pull or a checkout, or someone edited it. The server drops the consents. The lines this server did not write become `foreign`: `BoardInfo.foreign` tells the page, which tags them, and `digest(state, { foreign })` tags them for the agent as not a request. `isForeign(ranges, event)` answers for one event. They stay so until the owner keeps them with `ROUTES.keep`.

## The owner's page and its token

Every token lives as long as the server that made it. The address `keel-board open` prints holds a one-time code, good for `ONE_TIME_CODE_MS`. The page posts it to `ROUTES.session` and gets the owner's token (`SessionReply`). `ROUTES.link`, with the system token, gives a fresh address. No token is ever in an address.

## Changing the contract

Only the orchestrator edits this package. If your work needs a change, say so in your hand-back and continue with what does not depend on it. Run the tests with `npx vitest run` from `workspace/`.
