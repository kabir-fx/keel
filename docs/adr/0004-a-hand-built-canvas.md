# The canvas is hand-built from SVG and HTML

The board needs the agent's pictures to be our own live components that the owner can circle, cross out and tap, and it needs the event log to be the only state. We decided to build the canvas ourselves: one world transform over HTML items and SVG ink, with `perfect-freehand` for strokes and `html-to-image` for region snapshots. We built the same page two ways and probed a third, and this was the only one where both needs held.

**Status:** accepted

**Alternatives**

- **tldraw 5.6.1.** Out on licence. Its licence forbids production use without a key, and with no key it shows a "Get a license for production" watermark and loads assets from its own CDN. That does not fit a public MIT repository.
- **Excalidraw 0.18.1 with our own layer.** MIT, and it works, but only with our pictures in a separate layer under its transparent canvas and a tap router on top. It keeps a second store: its undo, eraser and drag change strokes behind the log's back, and our code has to put them back. As an Excalidraw embeddable, a picture cannot be drawn over or tapped. First load is 464 KB gzip against 84 KB hand-built, for the same amount of our own code.

**Consequences**

- We own the pointer edge cases: palm rejection, touch pinch, a pen with no hover. None has been tested on a real pen or touch device yet.
- One SVG path per stroke held 60 frames a second at 1,000 strokes. Beyond a few thousand it will need culling.
- A picture renderer is a plain React component with no canvas dependency. It marks what can be pointed at with `data-sub`, and the app hit-tests the DOM.
- Pen feel was not judged by a person. Both trial pages use the same stroke library, so the settings can be tuned later without changing the engine.

**Added on 2026-11-18: the mechanics come from Excalidraw, as rules**

After the first real use, the owner asked whether the board should have been a pruned copy of Excalidraw with the agent built in. We looked again and kept this decision. Excalidraw draws a closed set of elements on a 2D canvas and keeps its own store. Our pictures are live HTML components and the log is our only state, so its drawing code and its store do not fit, for the same reasons as above.

What does carry over is how it behaves under the hand, which years of use on real devices have hardened: how a press ends, how the wheel and a pinch zoom, how the camera glides, how ink is drawn the same live and saved, how things are selected, moved, resized and snapped, how an arrow holds on to what it points at, how text is edited, how keys are matched. We bring those over as rules and numbers, written again for our code. We copy code only where it is plain geometry that fits as it is (the trail engine, the frame loop), and such a file names its source. Excalidraw is MIT: its licence is in `workspace/THIRD_PARTY_NOTICES.md`.

The board keeps keel's own look. It is built and tried for a browser on a laptop: a trackpad, a mouse and a keyboard. Touch and pen input wait.
