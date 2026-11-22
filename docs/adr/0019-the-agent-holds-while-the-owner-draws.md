# The agent holds while the owner draws, and the owner can hold it

The agent wakes after each pause, and every mark must be answered with a picture the owner can see (0008). A box is posted when its label closes, and the tool goes back to Select, so the next box never comes within the 1.5 s pause. We watched two owners. One drew a flowchart, and the agent answered after every box: a card per box, each one cutting into the drawing and filling the board. The other wrote a one-line idea in a box and waited, and was answered in under two seconds, which is what they wanted. Nothing let the board tell "still drawing" from "your turn". We decided that a box or an arrow of the owner's own means they are building the diagram themselves, so the agent holds from the first one; that words ask for an answer at once; and that the page points a still owner at "Answer now".

**Status:** accepted. It changes the pause rule of 0003 and reverses nothing in 0008.

**The rule**

| The owner | The agent |
|---|---|
| Writes words: a note, a spoken remark, an act, a change to a note's words | Wakes after 0.3 s, as before. Words end any hold, whoever started it. |
| Draws a box or an arrow of their own diagram (on bare board, or tied only to their own marks), or changes the label of one | Holds at once, the first one included. No wake until words come or the owner presses "Answer now". |
| Draws a box or an arrow on one of the agent's pictures (a box's anchor, or either end of an arrow, is on it), changes the label of one, draws ink, or puts a pin | With no hold on, wakes after 1.5 s, as before. During a hold, wakes nobody. |
| Drops a file in | With no hold on, wakes after 0.3 s, as before. During a hold the file is part of the drawing: it ends nothing. |
| Moves, resizes or removes a thing | Wakes nobody, and ends nothing. |
| Presses Hold on the agent's pill | Holds until words or "Answer now". |
| Makes no movement for 10 s while the agent holds and a mark waits | The owner's page says "Press Answer now for the agent's read of your drawing, or write a note." on the hint line, and fills the "Answer now" button. Any press, pointer move, key or wheel takes both away and starts the 10 s again. The page judges it, from the owner's own input: the server knows nothing of it. |

Only words or "Answer now" end a hold. When it ends there is one wake, with one digest of everything open. A hold is live state, like presence: it is never logged. A restart forgets it, so a server that starts with nothing of the owner's open but their own boxes and arrows begins held, and one that finds anything else open wakes as before. It reaches the page on its own message, not as presence, because the agent, the builder and the wake all set presence and would drop it. A wake already running when a hold starts finishes. A retry, or a wake that came due during a turn, does not go through a hold. The agent reads the boxes and arrows open together as one drawing: one read of the whole flow that names each of them, then the one "My read" card.

**Considered and not chosen**

- The rule this replaces: a lone box or arrow woke the agent after 1.5 s, a second one within 20 s held, and 20 s of stillness released the hold. The first box of every drawing was still answered alone, a slow drawer was still answered box by box, and the stillness release still guessed when the owner was done.
- A Hold switch alone. The drawing owner must first find it, and press it before the first box. It stays beside the auto-hold, for an owner who wants to hold on purpose.
- A longer pause for everyone. It slows the owner who asked and waits, and it still guesses: a slow drawer is still answered box by box.

**Consequences**

- An owner who types a one-line idea in a box is no longer answered by itself. After 10 s still, the hint line tells them to press "Answer now" or write a note. A note is the way to ask.
- A changed label holds as a new box does. The old read comes off (0020), and an owner who fixes three labels is not answered after the first.
- A mark-up on the agent's picture, a box round a thing with its why typed in, is still answered after the pause.
- The pointer is one quiet line and one filled button: no popup, no sound, no loop. It shows only on the owner's page.
- A picture and an answer may name up to 40 marks, as many as a digest lists, so one read can answer a whole flowchart.
- The pill says when the agent holds, how many marks wait, and gives the owner Hold or "Answer now". Other viewers see the hold and no buttons.
