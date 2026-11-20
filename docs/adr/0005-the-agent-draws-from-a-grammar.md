# The agent draws from a small picture grammar, and one model carries the idea

The agent answers the owner in pictures. We decided that the agent writes a small spec in a fixed grammar and the renderer does all the layout, sizes and colours. We also decided that one model per board (lanes, parts, edges, walks) sits behind every pipeline picture. We tested the grammar with fresh agents that saw only the grammar and a request: 13 of 13 replies passed a strict schema first time, and the pictures matched a hand-drawn answer key on step order, arrows and the divider.

**Status:** accepted

**What the test showed**

- A spec costs about 1,200 tokens for one lanes picture and 3,000 to 4,000 for a spread plus a pipeline. A screen placed by hand is 15 to 48 KB.
- Time is the risk, not quality. At default effort one model spent 155 to 308 seconds, most of it thinking. At low effort it took 34 seconds for the same picture. So the agent draws at low effort and posts each picture as soon as it is ready.
- Layout belongs to the renderer. Every layout fault was fixed there and never in a spec: columns by step number, arrows routed between columns and never through a box, labels kept off boxes.
- Blue belongs to the renderer too. It marks what is unique to one approach in a spread. The agent's job is to say a shared thing with the same id and the same words.
- The grammar cannot draw a screen. Without a way out, agents turned "design a settings screen" into a data flow. With the `free` kind, they drew comparable screens. So `free` is in the first version: one SVG element, shown as an image, so nothing in it can run or load.

**Rules of the grammar**

- No coordinates, colours or sizes in a spec. A lane, a column and an order at most.
- Strict: an unknown key or a text over its limit is refused, with a message the agent can act on.
- A lane is a person, a thread or a process, or the channel between two of them. Never a module.
- A candidate model holds at most 12 parts and 16 edges. More does not read.
- Names by id, never by position.

**Consequences**

- Pipeline pictures name the board's model and stay live. When a part is built, every picture of it fills in. That is how one picture carries the idea, the decision, the progress and the status.
- The agent patches the model before it posts a picture that names a part. The server refuses the picture otherwise.
- A project that is not a pipeline is only partly served: screens through `free`, the rest not yet. Branches in a walk, state machines and data shapes are known gaps.
