# The picture grammar

You draw by writing a small JSON spec. The board does the layout, the sizes and the colours: never give a coordinate, a size or a colour. A spec that breaks a limit or has a key not listed here is refused whole, with the reason.

- An id is a slug: `a-z`, `0-9` and `-`, such as `req-42`, and never `constructor`. Name things by id, never by position.
- Plain words first: "the door", then the code name if it helps: "the door (EngineClient)".
- `gaps` (on most kinds): up to 6 short sentences on what the picture cannot show. Draw the closest picture and say what is missing there.
- In a keys line, `key?` is optional, `text≤60` is a string of at most 60 characters, and `T[1-6]` is a list of 1 to 6. The examples below are checked against the board's rules.

## Posting

`board_post` takes `pictures`, a list. Each entry is `{picture, answers?, from?, name?, id?, status?, near?, side?}`:

- `answers`: the ids of the open marks and acts it answers. `from`: the items it grew out of. Every picture names one or the other.
- `name`: an id you choose for a new picture, unused on the board, such as `spread-2`. Later entries can then name it in `from`, and finish it by `id`.
- `id`: only to finish or redraw a picture already on the board, never one the owner picked or the blueprint they pressed "Build this" on: for those, post a new picture `from` it.
- `status: "drawing"` posts a placeholder at once. It answers nothing until you finish it with a later entry that gives its `id` and the whole spec. The finished picture keeps the placeholder's `answers` and may be any kind.
- No `box`: the board places every picture.
- `near` (an item id) and `side` (`right`, `below`, `left`, `above`): only when it belongs beside something other than what it answers.
- `model`, beside `pictures`: a change to the board's model, made first, so the pictures in the same call can name its parts and walks.
- `rename`, beside `pictures`: the chapter's name in two to five words, posted first. Only while the idea is open: once the owner decides it, its name is theirs.

## The model

The board has one model: lanes, parts, edges and walks. `pipeline`, `walk`, `focus`, `blueprint` and `choice` name its parts and walks, so put them in the model first. A lane is a person, a thread or a process, or the channel between two (a queue). Never a module: two parts of one server share its lane. The caller goes on top. A new part is an `idea`. A part the repository already has is `"state":"built","shelf":true` with its `commit`. Something outside the system, such as a browser, is `"external":true` with no state. A part with no `lane` is work with no place in the pipeline, such as a check. At most 12 parts read well, and a lane holds at most 16. Draw the edges the walk travels first. A walk follows one request, step by step: `n` rises, and a part may hold several steps.

```keys model
{lanes?: {id: id, name: text≤32, note?: text≤48, at?: int 0-12}[], parts?: {id: id, name?: text≤32, plain?: text≤48, lane?: id, col?: int 1-16, state?: "idea"|"solid"|"building"|"built"|"later", commit?: text≤80, shelf?: bool, external?: bool, files?: text≤200[≤12], note?: text≤200}[], edges?: {from: id, to: id, label?: text≤40, kind?: "flow"|"wait"}[], walks?: {id: id, name: text≤60, steps: {n: int 1-40, part: id, text: text≤90}[1-24]}[], drop?: {parts?: id[], edges?: {from: id, to: id}[], walks?: id[]}}
```

```json
{"lanes":[{"id":"user","name":"User","note":"a browser"},{"id":"app","name":"Web app"},{"id":"queue","name":"Job queue","note":"between the app and the worker"},{"id":"worker","name":"Resize worker"}],
 "parts":[{"id":"browser","name":"Browser","lane":"user","col":1,"external":true},
  {"id":"upload","name":"Upload handler","plain":"keeps the original, answers at once","lane":"app","col":2},
  {"id":"store","name":"Photo store","plain":"every original","lane":"app","col":3,"state":"built","shelf":true,"commit":"a1b2c3d","files":["src/photos/store.py"]},
  {"id":"jobs","name":"Resize jobs","plain":"one job per photo","lane":"queue","col":3},
  {"id":"resizer","name":"Resizer","plain":"three sizes, 3 s","lane":"worker","col":4},
  {"id":"cache","name":"Image cache","plain":"serves the sizes","lane":"app","col":5,"state":"later"},
  {"id":"try-it","name":"Try it: 20 uploads","plain":"one command"}],
 "edges":[{"from":"browser","to":"upload","label":"POST"},{"from":"upload","to":"store"},{"from":"upload","to":"jobs","label":"put"},{"from":"jobs","to":"resizer"},{"from":"resizer","to":"browser","label":"ready","kind":"wait"}],
 "walks":[{"id":"one-photo","name":"Follow one photo","steps":[{"n":1,"part":"browser","text":"The user drops a 12 MB photo"},{"n":2,"part":"upload","text":"The handler keeps it and answers at once"},{"n":3,"part":"store","text":"The original is stored"},{"n":4,"part":"jobs","text":"A resize job waits its turn"},{"n":5,"part":"resizer","text":"Three sizes are made in 3 s"},{"n":6,"part":"browser","text":"The tile fills in"}]}]}
```

## text: an agent card

Your read, your lean, your questions. A title that says the point, a short body, at most three questions. Each question is a tap target `q:1` to `q:3`, so the owner can answer on it.

```keys text
{kind: "text", title: text≤90, body?: text≤900, points?: text≤200[≤6], lean?: text≤320, questions?: text≤200[≤3]}
```

```json
{"kind":"text","title":"My read, and two questions","body":"You want the upload to feel instant. Your circle on B reads as: resize later, in a worker. Your cross on A drops resizing inside the upload.","lean":"B. The web app stays free, and the worker can retry.","questions":["Is a blank tile for 3 seconds fine?","Shall I draw B in full, so you can follow one photo through it?"]}
```

## shelf: what the repository already has

Tiles for what exists and bears on the idea, from a look at the code. `ref` says where: a path, a pull request, a commit, and the branch when it is not the current one. `part` only when the model already has that part.

```keys shelf
{kind: "shelf", title?: text≤90, tiles: {id: id, name: text≤32, plain?: text≤60, ref?: text≤80, state?: "idea"|"solid"|"building"|"built"|"later", part?: id}[1-8]}
```

```json
{"kind":"shelf","title":"Already on the shelf","tiles":[{"id":"store","name":"Photo store","plain":"keeps every original","ref":"src/photos/store.py","state":"built"},{"id":"runner","name":"Job runner","plain":"runs a function later, tries 3 times","ref":"pull request 7","state":"built"}]}
```

## lanes: who does what, in what order

The owner's own drawing style: one lane per actor, numbered steps, labelled arrows. Number the steps when order matters; time runs left to right. `wait: true` draws dashed: the actor at `from` sleeps until `to`. A flow to an earlier step draws a loop. `divider` is a dashed line before a step: a second round trip or a later phase.

```keys lanes
{kind: "lanes", title: text≤70, lanes: {id: id, name: text≤32, note?: text≤48}[1-6], steps: {id: id, lane: id, text: text≤60, n?: int 1-40, col?: int 1-16}[1-16], flows?: {from: id, to: id, label?: text≤64, wait?: bool}[≤24], divider?: {before: id, label?: text≤32}, caption?: text≤280, gaps?: text≤200[≤6], risk?: text≤200}
```

```json
{"kind":"lanes","title":"One photo, resized in a worker",
 "lanes":[{"id":"user","name":"User","note":"a browser"},{"id":"app","name":"Web app"},{"id":"queue","name":"Job queue"},{"id":"worker","name":"Resize worker"}],
 "steps":[{"id":"drop","lane":"user","n":1,"text":"drops a 12 MB photo"},{"id":"keep","lane":"app","n":2,"text":"keeps the original, answers at once"},{"id":"job","lane":"queue","n":3,"text":"a job: resize photo 81"},{"id":"resize","lane":"worker","n":4,"text":"makes three sizes, 3 s"},{"id":"tile","lane":"user","n":5,"text":"the tile fills in"}],
 "flows":[{"from":"drop","to":"keep"},{"from":"keep","to":"job","label":"put"},{"from":"job","to":"resize","label":"taken when free"},{"from":"resize","to":"job","label":"failed: retry"},{"from":"resize","to":"tile","label":"ready"},{"from":"drop","to":"tile","wait":true,"label":"a blank tile meanwhile"}],
 "divider":{"before":"tile","label":"seconds later"},
 "risk":"A slow worker leaves blank tiles on a busy day."}
```

## spread: two to four ways, side by side

Every approach follows the same concrete `request`. Each is a `lanes-approach` (or a `free-approach` when the approaches are screens) with a title under 8 words and one `risk`. They are lettered A to D in order; `lean` is the letter you would pick.

The board turns blue what only one approach has. So say a shared thing the same way in every approach: the same id, the same lane, the very same words. Give a changed thing a new id. Draw only where the approaches differ, plus the few shared steps around it: three to six steps each. Tap targets: `approach:a`, and `step:a-<step id>` inside one.

```keys spread
{kind: "spread", title: text≤70, request: text≤120, approaches: (lanes-approach | free-approach)[2-4], lean?: "A"|"B"|"C"|"D", caption?: text≤280, gaps?: text≤200[≤6]}
```

```keys lanes-approach
{kind?: "lanes", title: text≤70, lanes: {id: id, name: text≤32, note?: text≤48}[1-6], steps: {id: id, lane: id, text: text≤60, n?: int 1-40, col?: int 1-16}[1-16], flows?: {from: id, to: id, label?: text≤64, wait?: bool}[≤24], divider?: {before: id, label?: text≤32}, caption?: text≤280, gaps?: text≤200[≤6], risk: text≤200}
```

```keys free-approach
{kind: "free", title: text≤70, svg: svg≤16000, caption?: text≤280, risk: text≤200, gaps?: text≤200[≤6]}
```

```json
{"kind":"spread","title":"Where the photo gets resized","request":"a user drops a 12 MB photo","lean":"B",
 "approaches":[
  {"title":"Resize inside the upload","lanes":[{"id":"user","name":"User"},{"id":"app","name":"Web app"}],
   "steps":[{"id":"drop","lane":"user","n":1,"text":"drops a 12 MB photo"},{"id":"resize-now","lane":"app","n":2,"text":"resizes it while the user waits 3 s"},{"id":"tile","lane":"user","n":3,"text":"the tile fills in"}],
   "flows":[{"from":"drop","to":"resize-now"},{"from":"resize-now","to":"tile"}],
   "risk":"Ten uploads at once hold ten web workers for 3 s each."},
  {"title":"Resize in a worker","lanes":[{"id":"user","name":"User"},{"id":"app","name":"Web app"},{"id":"worker","name":"Resize worker"}],
   "steps":[{"id":"drop","lane":"user","n":1,"text":"drops a 12 MB photo"},{"id":"keep","lane":"app","n":2,"text":"keeps the original, answers at once"},{"id":"resize","lane":"worker","n":3,"text":"makes three sizes, 3 s"},{"id":"tile","lane":"user","n":4,"text":"the tile fills in"}],
   "flows":[{"from":"drop","to":"keep"},{"from":"keep","to":"resize","label":"job"},{"from":"resize","to":"tile","label":"ready"}],
   "risk":"The user sees a blank tile for a few seconds."}],
 "caption":"Two places to resize the same photo. Circle, cross out, or draw on them."}
```

## mini: a small answer to one mark

Two to five boxes and the arrows between them. The title is the answer in a few words. The caption starts with how you read the mark: "Read as: ...". `tone: "blue"` is what you propose. Arrows go by box position, from 1; leave `flows` out and each box flows to the next.

```keys mini
{kind: "mini", title: text≤90, boxes: {text: text≤40, tone?: "plain"|"blue"|"teal"|"grey"|"dark", sub?: text≤48}[2-5], flows?: {from: int 1-5, to: int 1-5, label?: text≤30, wait?: bool}[≤8], caption?: text≤280}
```

```json
{"kind":"mini","title":"Yes. The job runner retries for you","boxes":[{"text":"upload"},{"text":"job runner: 3 tries","tone":"blue"},{"text":"resize worker"}],"flows":[{"from":1,"to":2,"label":"put"},{"from":2,"to":3}],"caption":"Read as: what happens when a resize fails? The job runner on the shelf already tries three times, so nothing new is built."}
```

## pipeline: the model, drawn

With no `model` it draws the board's model and stays live: when a part changes state, the picture changes. `walk` numbers one walk on it. `view` opens as `layers` (floors) or `flat`; the owner can switch. Give a `candidate-model` only for an approach that is not picked yet; every part in it needs a `state`. Tap targets: `part:<id>`, `lane:<id>`.

```keys pipeline
{kind: "pipeline", title?: text≤70, caption?: text≤280, view?: "flat"|"layers", model?: candidate-model, parts?: id[1-40], walk?: id, gaps?: text≤200[≤6]}
```

```keys candidate-model
{lanes: {id: id, name: text≤32, note?: text≤48}[1-6], parts: {id: id, name: text≤32, plain?: text≤48, lane?: id, col?: int 1-16, state: "idea"|"solid"|"building"|"built"|"later", commit?: text≤80, check?: {cmd: text≤300, passed: bool}, shelf?: bool, external?: bool, files?: text≤200[≤12], note?: text≤200}[1-12], edges?: {from: id, to: id, label?: text≤40, kind?: "flow"|"wait"}[≤16], walks?: {id: id, name: text≤60, steps: {n: int 1-40, part: id, text: text≤90}[1-24]}[≤3]}
```

```json
{"kind":"pipeline","title":"Your pick, in full","caption":"B, with the store from the shelf. One photo is on its way through.","view":"layers","walk":"one-photo"}
```

## walk: a step player

Plays one walk of the board's model, step by step, beside its pipeline. Tap target per step: `step:<n>`.

```keys walk
{kind: "walk", title?: text≤70, walk: id}
```

```json
{"kind":"walk","title":"Follow one photo","walk":"one-photo"}
```

## focus: one part, or one lane, opened

Draw it when the owner taps a part, not before. Give `part` or `lane`, not both. Where it sits comes from the model. Fill what you know: what crosses its edge, what is inside (with sample contents in `holds`), its one promise, what that costs, a decision already made, and two to four `options` for the owner to circle or cross out, with your lean. `code` lists lines worth reading in a built part.

```keys focus
{kind: "focus", part?: id, lane?: id, title?: text≤70, summary?: text≤320, crosses?: {dir: "in"|"out", what: text≤60, part?: id, note?: text≤90}[≤8], inside?: {name: text≤40, plain?: text≤90, holds?: text≤24[≤6], tone?: "plain"|"blue"|"teal"|"grey"|"dark"}[≤6], promise?: text≤240, cost?: text≤240, made?: {title: text≤90, body?: text≤320}, options?: {title: text≤90, items: {id: id, name: text≤48, body?: text≤240, risk?: text≤160}[2-4], lean?: id}, lean?: text≤320, code?: {path: text≤200, lines?: text≤30, note?: text≤160}[≤6], gaps?: text≤200[≤6]}
```

```json
{"kind":"focus","part":"jobs","title":"The resize jobs, opened",
 "summary":"Each upload leaves one job here. The worker takes the oldest job when it is free.",
 "crosses":[{"dir":"in","what":"Resize photo 81","part":"upload","note":"one per upload"},{"dir":"out","what":"Job taken","part":"resizer"},{"dir":"out","what":"Failed three times","note":"the user sees the original"}],
 "inside":[{"name":"Waiting jobs","plain":"oldest first","holds":["photo 81","photo 82"]},{"name":"Tries left","plain":"3 per job"}],
 "promise":"Every photo gets its sizes, or the user is told within a minute.",
 "cost":"On a busy day the line grows, and tiles stay blank longer.",
 "made":{"title":"Oldest job first, no priorities.","body":"Simple, and fair to every user."},
 "options":{"title":"Two ways through a busy day","items":[{"id":"more-workers","name":"Start more workers","body":"A second worker when the line passes 50 jobs.","risk":"Costs more on busy days."},{"id":"small-first","name":"Make the small size first","body":"The tile fills in after 1 s. The big sizes follow."}],"lean":"small-first"},
 "lean":"Make the small size first. The user sees the photo sooner, and no new machine is needed."}
```

## blueprint: the solidified idea, read back

Post it after the owner solidifies, then wait for "Build this". Each pick is something the owner chose, and says where it came from; a question the owner asked is never a pick. `assumed` lists everything you decided that the owner did not say. `proof` is what the owner can run or see. `parts` is the build track, in order, one commit each: solid parts only, because a new part is an idea and only the owner makes it solid. `check` is required: the one command that proves a part works, such as `make check`, found in the repository. By pressing "Build this" the owner agrees to it, and a part is built only when it has passed after the part's commit.

```keys blueprint
{kind: "blueprint", title: text≤70, summary?: text≤320, picks: {text: text≤160, from?: {item: id, sub?: sub}}[1-10], leftOut?: {text: text≤160, why?: text≤160}[≤8], assumed?: text≤200[≤8], proof: text≤200[1-6], parts: id[1-40], check: text≤300, walk?: id, gaps?: text≤200[≤6]}
```

```json
{"kind":"blueprint","title":"The blueprint","summary":"Uploads answer at once. A worker makes the sizes.",
 "picks":[{"text":"Resize in a worker","from":{"item":"spread-1","sub":"approach:b"}},{"text":"The small size first","from":{"item":"circle-1"}}],
 "leftOut":[{"text":"No image cache yet","why":"the store serves the sizes for now"}],
 "proof":["20 uploads at once: every tile fills in within 10 s.","A failed resize is tried 3 times, then shows the original."],
 "parts":["upload","jobs","resizer","try-it"],"check":"make test","walk":"one-photo"}
```

## choice: a decision you made alone

The builder posts it: a decision made alone while building, which never blocks. `chosen` is in force now; the owner can change it, and the builder follows the change from its next part.

```keys choice
{kind: "choice", title: text≤90, body?: text≤320, options: {id: id, label: text≤48, note?: text≤160}[2-3], chosen: id, part?: id}
```

```json
{"kind":"choice","title":"A choice I made while building","body":"A failed resize keeps the original on show. I did not stop for it.","options":[{"id":"show-original","label":"Show the original","note":"the user sees something at once"},{"id":"show-error","label":"Show an error tile"}],"chosen":"show-original","part":"resizer"}
```

## free: the way out

One `<svg>` with a `viewBox` on it, shown as an image. The `viewBox` is four numbers, and neither side is more than 5 times the other. At most 600 elements. Only these elements: `svg`, `g`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`, `text`, `tspan`, `defs`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `title`, `desc`. No marker, pattern or mask: draw an arrowhead as a small `polygon`. No second `<svg>` inside, no comment, no event handler, no character reference or escape in an attribute, and no link or `url()` except to something inside the drawing, and none from inside a `clipPath`. Words between tags are free. Use it only when no other kind can say it, such as the layout of a screen; the owner cannot mark inside it. Draw flat: white boxes with a 1.5 px `#0F1B2D` outline, light fills `#F4F6F9`, text in `#0F1B2D` and `#46536A`, and `#1D4ED8` only for what differs.

```keys free
{kind: "free", title: text≤70, svg: svg≤16000, caption?: text≤280, gaps?: text≤200[≤6]}
```

```json
{"kind":"free","title":"The upload screen","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 200\"><rect x=\"10\" y=\"10\" width=\"300\" height=\"180\" fill=\"#fff\" stroke=\"#0F1B2D\" stroke-width=\"1.5\"/><rect x=\"30\" y=\"40\" width=\"120\" height=\"90\" fill=\"#F4F6F9\" stroke=\"#0F1B2D\" stroke-width=\"1.5\"/><text x=\"34\" y=\"150\" fill=\"#46536A\" font-size=\"12\">drop a photo here</text><rect x=\"170\" y=\"40\" width=\"120\" height=\"90\" fill=\"#fff\" stroke=\"#1D4ED8\" stroke-width=\"1.5\"/></svg>","caption":"Blue is the new tile that fills in."}
```
