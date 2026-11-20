# Motion on the board shows what the log and presence say, and nothing else

The agent's answers used to appear whole, two or three seconds after the owner's mark, with nothing on the board in between and a camera that re-centred and re-zoomed to show them. The owner said it did not feel like working with someone. We decided how the agent's work is shown: its cursor is on the board at the thing it reads, and a picture is drawn on, in order, from the mark it answers. We also decided what that motion may claim. It may show only what the log and the agent's presence really say.

**Status:** accepted. It builds on records 0001, 0003 and 0004.

**The rule**

- The log and presence are the only truth. A picture is on the board from the moment its event is in the log. What plays afterwards is the board showing how it was made: a short drawing-on of something that is already there.
- Nothing shows progress that is not real. There is no "thinking" bar and no pretend typing. The cursor waits beside a mark because the server handed that mark to the agent. Its tag says "drawing a card" because the model has begun to write a `board_post` whose first picture is a card.
- Nothing waits on motion. An item can be pressed, moved, erased or marked while it is drawn on, and a press on it lands it at once.
- With "reduce motion", or on a page nobody is looking at, nothing plays. The picture is there, and the cursor and the camera jump.

**What is real, and where it comes from**

| What the owner sees | The signal behind it | Where |
|---|---|---|
| The cursor goes to the mark, about 0.3 s after a note | The wake's presence names the newest mark the agent was handed, if it was made on this board | `server/src/wake.ts` |
| The tag says "drawing", then "drawing a card" | The agent's stream says the model began a tool call, and then holds the first picture's kind | `plugin/src/hosted-link.ts`, `plugin/src/presence.ts` |
| The picture is drawn on from the mark | The picture's event is in the log and the page has placed it | `app/src/arrival/` |
| The camera moves | The picture, with its mark, is not wholly in the free room, and the owner has not moved the view since the mark | `app/src/camera/reveal.ts`, `app/src/board/news.ts` |

No event was added to the log for any of this, and presence got no new state.

**How it is built**

- **Layers.** The stream (events and presence) gives *cues*: what just happened that deserves motion. A cue and measured geometry give a *plan*: a list of beats and the cursor's path, as a pure function, so the same input always gives the same film. A *player* runs plans on the page. The cursor is one object per board, like the camera.
- **The film of one picture is one stroke.** The cursor draws the picture's arrow, pulls the picture out by its far corner as a rectangle is dragged out, and rests there while what is on it fills in behind. It never crosses the picture and never goes back over what is drawn.
- **A picture says what it is made of.** Each renderer marks its parts (`data-build`: frame, head, block, shape, line, label), and `buildParts` reads them back in the order they are drawn on. The board knows no picture kind by name.
- **No animation library.** The board has one frame loop that runs only while something moves. The cursor and the camera are on it. A picture's parts are moved by Web Animations, which the browser has. GSAP was looked at and left out: it brings a second ticker, its timelines are stateful objects and not a plan we can test, and it is not under an open-source licence.
- **The camera makes the smallest move that shows it.** If the picture and its mark are in view, it does not move. Else it pans by the least it can. It zooms out only when they cannot fit at the owner's zoom, and it never zooms in.
- **A fixture can be played on a clock that only a test moves.** `?fixture=<name>&at=<n>&play=1&clock=manual` and `window.renderAt(ms)` show the same frame for the same moment, every time. The motion is tested and looked at frame by frame this way. A live board is never on that clock.
- **The numbers are in one file**, `app/src/motion/timing.ts`, each with a line that says what it is for.

**Alternatives**

- **Stream the picture as the model writes it.** The parts would then appear as they are really written. A picture's spec is not valid until it is whole, the server admits whole events only (0002), and half a drawing can be wrong in ways the finished one is not. The stream is used for what it can say truthfully: that a call has begun, and what kind of picture it holds.
- **The cursor visits every part as it comes in.** It was built first: the cursor swept down a card and traced each connector. On frames it read as a tour and not a hand. The cursor drifted over an empty card, went back over what it had drawn, and its tag crossed the labels. One stroke replaced it.
- **A progress bar or a skeleton while the agent thinks.** It fills the wait, and it claims a progress nobody knows. The cursor at the mark and the pill's words say what is true.
- **Follow the agent with the camera, always.** The owner would lose the view each time the agent draws. The camera follows only an answer to the owner's last mark, and only if they have not moved since.

**Consequences**

- A card is seen whole about a second after it is in the log, and the widest picture about two and a half. When many arrive at once they are drawn faster, and beyond that the oldest simply land, so the board is never more than a few seconds behind.
- A new picture kind must mark its parts, or it comes in as one piece. A test in the pictures package checks every kind.
- The server's wake and the link's presence are now part of how the board feels. A link that reports no presence still gets its pictures drawn on, with the cursor coming in from the edge.
- The link starts the agent with `--include-partial-messages`. An older `claude` that writes no partial stream behaves as before: the tag says "drawing" only once the call is whole.

**What this does not cover**

- The owner's own marks have no motion of this kind. They are drawn by the owner's hand.
- The Story view and the focus view show pictures as they are. Nothing is drawn on there.
