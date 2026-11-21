# Third-party notices

The board in this folder is keel's own code, under keel's MIT licence (see `../LICENSE`). Parts of it are taken or closely adapted from other projects. Each is listed here with its licence.

## Excalidraw

Source: https://github.com/excalidraw/excalidraw, read at commit `9fbeaed` (17 November 2026).

How the board's canvas behaves under the hand follows Excalidraw: its rules for the pointer, the wheel, the camera, ink, selection, arrows, text editing and keys. Most of that came over as rules and numbers, written again for our code. Where code was taken or closely adapted, the file says so at its top: it names the Excalidraw file it came from and this commit.

Files with adapted code are listed at the end of this section. The list is kept current as the work lands.

The board also depends on the published package `@excalidraw/laser-pointer` (MIT), which is part of the same repository.

Licence:

```
MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Files with code adapted from Excalidraw:

- `app/src/frame.ts`: the once-a-frame wrapper and the frame loop, from `packages/common/src/utils.ts` and `packages/excalidraw/renderer/animation.ts`.
- `app/test/pointer.ts`: the shape of the `Pointer` and `Keyboard` test helpers, from `packages/excalidraw/tests/helpers/ui.ts`.
- `app/src/camera/motion.ts`: the in-between cameras of a glide and its easing, from `packages/excalidraw/components/App.viewport.ts` and `packages/common/src/utils.ts`.
- `app/src/camera/wheel.ts`: what a wheel event does, from `packages/excalidraw/components/App.wheel.ts`.
- `app/src/camera/gesture.ts`: Safari's trackpad pinch, from the gesture handlers in `packages/excalidraw/components/App.tsx`.
- `app/src/camera/fit.ts`: the free area a fit keeps clear of the panels, from `packages/excalidraw/components/App.viewport.ts`.
- `app/src/camera/miniView.ts`: the minimap's scale and drag, from `packages/excalidraw/components/Minimap/`.
- `app/src/camera/Minimap.tsx`: the handling of a press, a drag and the wheel on the minimap, from `packages/excalidraw/components/Minimap/minimap-controller.chunk.ts`.
- `app/src/camera/back.ts`: finding the way back to the content, from `packages/excalidraw/viewport.ts`.
- `app/src/input/match.ts`: which key was pressed on any keyboard layout, from `matchKey` in `packages/common/src/keys.ts`.
- `app/src/board/drop.ts`: the count of how deep a drag is inside the board, from `packages/excalidraw/components/FileDropOverlay.tsx`.
- `app/src/ink/recognise.ts`: resampling a stroke and the measure of its straightness, from `packages/element/src/convertToShape.ts`.
- `app/src/overlay/trails.ts`: a trail that follows the pointer and fades behind it, from `packages/excalidraw/animatedTrail.ts`, and how wide it is along its length, from `packages/excalidraw/eraser/index.ts` and `packages/excalidraw/lasso/index.ts`.
- `app/src/tools/erasable.ts`: testing the newest piece of the eraser's path and how far it reaches, from `packages/excalidraw/eraser/index.ts`, and the distance between two segments, from `packages/math/src/segment.ts`.
- `app/src/select/snap.ts`: snapping a move and a resize to edges, centres and equal gaps, from `packages/excalidraw/snapping.ts`.
- `app/src/tips.ts`: when a tooltip shows and where it is put, from `packages/excalidraw/components/Tooltip.tsx`.
- `app/src/binding.ts`: how near an arrow's end ties, the gap at a tied end and its guards, from `packages/element/src/binding.ts`; the spot an end holds on a thing it stops short of, on the thing's diagonals, from `packages/element/src/utils.ts`; and the angle lock, from `packages/element/src/sizeHelpers.ts`.
- `app/src/arrowhead.ts`: an arrowhead's size, its opening and its points, from `packages/element/src/bounds.ts`.

## xterm.js

Source: https://github.com/xtermjs/xterm.js, the published package `@xterm/xterm` 6.0.0.

The try room's terminal (`app/src/TryTerminal.tsx`) is xterm.js, bundled into the page with its stylesheet. No code of it was copied or adapted.

Licence:

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
