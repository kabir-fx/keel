# The agent is a figure on the board, and it draws with several cursors

Record 0010 put the agent's cursor on the board and had each picture drawn on from the mark it answers. The owner used it and reported three things. Where a picture landed changed from turn to turn. The wait for the agent was a pointer standing still beside three dots. And a post that brought several pictures drew the first, then left the one cursor resting while the others sat out of sight, then crossed the board to the next. Frames of the owner's own session, as Chrome's compositor really drew them, showed two more: a large picture was scaled up from nothing, text and all, while the camera panned and zoomed under it.

We decided what the agent looks like while it works, how several pictures are drawn, and where a picture goes.

**Status:** proposed. It builds on record 0010 and changes three things that record decided: the cursor is one object per board; the pull scales the picture; the camera moves with the arrival.

**The rule of 0010 stands**

Motion shows what the log and presence say, and nothing else. Every pose of the figure and every word beside it comes from the agent's own stream. Nothing here shows progress nobody knows.

**What is real, and where it comes from**

| What the owner sees | The signal behind it | Where |
|---|---|---|
| The figure reads the mark | The wake names the mark the agent was handed, or the lasso a solidify was made from | `server/src/wake.ts` |
| It thinks | The model began a thinking block | `plugin/src/hosted-link.ts` |
| It reads the board, or the code | The model began a call to a tool that reads | `plugin/src/presence.ts` |
| It scribbles | The model began a call that draws or writes | `plugin/src/presence.ts` |
| Its tag says "drawing a small picture" | The call is a `board_post`, and the kind of its first picture is written | `plugin/src/presence.ts` |
| The picture's title under the tag | That title is written, whole | `plugin/src/presence.ts` |
| Several cursors | Several pictures are in the log and not drawn yet: from one post, or from one that came while another was drawn | `app/src/arrival/` |

Presence got two fields for this, `doing` and `picture`. Nothing was added to the log.

**What we decided**

- **A figure, not a pointer.** The agent is drawn as an ink drop in its own blue, with two eyes. Its point is its tip, where the pointer's tip was, so every rule about where the cursor may stand still holds. It is our own drawing: one inline SVG, posed by CSS. At rest it sleeps and nothing runs. Its loops run only while the agent works, which is when the owner waits. The three dots are gone from its tag: the figure is the sign that the agent works, and the tag is for words.
- **One cursor per picture.** Pictures that arrive together are drawn at once. The agent's own cursor draws the nearest, and a cursor split off it draws each of the others, a beat apart. When the last film is over, every cursor flies to where that film ended and they merge into the one figure, there. At most four draw at a time. While its cursors are split, or a picture waits to be drawn, the figure is at work, whatever presence says.
- **A box is dragged out, never scaled.** The cursor drags a band from where the arrow ends to the picture's rectangle, as a rectangle is dragged out by hand. The picture then shows in place, at its own size. No text is drawn at any size but its own.
- **The camera first.** When a picture must be brought into view, the camera moves first and the first stroke waits for it to stop, for 0.7 s at most. The cursor travels to where it will draw meanwhile.
- **One lane per picture.** A small picture goes right of what it answers, level with it, and down that column when the spot is taken. A wide one goes below what it belongs to, and further down. The placement no longer looks round the other sides for the nearest gap.
- **A placeholder holds its place.** The lanes place a picture once. A picture the agent posts as a placeholder and then finishes keeps the top left corner its placeholder stood at, and slides down from there only when its finished size is not clear. Before this the finished picture was placed again from nothing, by the rule for its new kind: a blueprint that began as a text card beside the owner's lasso was drawn 2,800 units away, below everything in the chapter. While the finished picture waits for the camera, the card's frame stands where the card was, and the picture is dragged out from it: the place is never empty.
- **The minimap leaves out what the board holds back.** A picture held out of sight until a cursor takes it is not on the minimap either. One that is being drawn is.
- **A film is over when its clock says it is finished.** Chrome reports a finished animation's time one float step under its length for about one length in a hundred. A film that waited for its time to reach its length never ended, and held every later picture out of sight.

**Alternatives**

- **A mascot from a library, or an animation file.** It brings a dependency, a second look and a second clock. The figure has six poses; CSS on one SVG does them.
- **Another character.** After using the drop, the owner was shown eight others: three drawn for keel (a pencil, a paper boat, a pixel sprite) and five from open-source sets (an owl, a robot, an octopus, a frog, a pixel cat). The owner kept the drop.
- **Keep the pointer and add a figure beside it.** Two things to follow. The figure's tip is the pointer.
- **Keep one cursor and draw faster.** The other pictures still wait out of sight, and the minimap still shows what the board does not.
- **Scale the picture, but sharper.** However it is drawn, scaled text reads as a zoom, and on a large picture it fills the screen.
- **The nearest clear spot on any side.** It keeps a reply closest to its mark on a crowded board. It is also why the owner could not tell where the next picture would land. With one lane a reply is sometimes further away, and always where the owner expects it.
- **Put the placeholder where the finished picture will go.** The page cannot: until the picture is finished it knows neither its kind nor its size.

**Consequences**

- A post of several pictures is whole on the board in about the time one picture took before.
- A reply on a crowded board can land some way down its column.
- A wide picture that began as a placeholder stays beside what it answers, where a wide picture posted whole goes below it. A `place` in the update that finishes it does not move it.
- The corner is kept by the page that showed the placeholder. A page opened after the placeholder and before the finished picture was placed uses the lanes.
- The link's reports are more of how the board feels. A link that reports no `doing` gets the thinking pose while it works.
- Whether a thinking block looks in the real stream as the link expects was not checked with a real turn when this was written.

**What this does not cover**

- Safari. The owner said on 2026-11-21 to build for Chrome only.
- The owner's own marks, the Story and the focus view, as in record 0010.
