# Changed words take their old answers off

The owner can change the words of a note, and now of a box: a double click with Select opens them where they are. The reducer already opens the mark again when its words change, so the agent reads it again. But the agent's pictures stayed on the board, answering words that were gone, and its new answer came beside them. We decided that a change of words takes the old answers off: the owner's page removes them, with the owner's own removes, right after the board admits the change.

**Status:** accepted. It builds on 0008 ("Take the picture off, and the mark is open again") and reverses nothing in it.

**The rule**

When the board admits an owner's change to a mark and the words differ, these come off:

| A picture on the board | Comes off |
|---|---|
| Names the mark in `answers` | Yes |
| Names the mark in `from`, or a picture that comes off by this rule, all the way down | Yes |
| One of the owner's pictures (`ownersPictures`: a pick, the pressed blueprint, a choice the owner made) | No, and the walk does not go on through it |
| Already off the board | Not listed |

`answersTo` in `workspace/protocol/src/state.ts` is the one reading of this rule. It holds for every mark whose words the page changes through `changeWords` (`workspace/app/src/board/changeWords.ts`): a note, a box, and the words Undo brings back onto an arrow.

**Why the page does it with ordinary removes**

The board is the owner's, and the owner may take anything off it. A remove is an event every reader of the log already understands. The page posts the change and the removes as one step, so one Undo brings back the old words and every picture, and Redo does both again. A remove the board refuses leaves the change as it is, and the board says no more than it does for any refused post.

**Considered and not chosen**

- Leaving the old answers up. The board fills with answers to words that are gone, and the owner cannot tell which picture answers what the mark says now.
- A side effect in the reducer, or a new event. Every reader of the log (the server, the digest, the replay) would need the rule, and Undo would not bring the pictures back.
- Asking the agent to tidy up. It is slow, and not sure: the agent may leave a picture up, or take off one the owner wanted.

**Consequences**

- One picture may answer a whole drawing. Changing the words of one box takes that whole read off, so every other box it answered is open again. The agent holds, as it does for any box of the owner's own (0019), and reads the whole drawing again when the owner writes a note or presses "Answer now". A changed note is read again at once.
- The owner's picks and the pressed blueprint stay, and so does what grew out of them.
- Undo brings everything back in one press. The changed mark stays open after it, because Undo is itself a change of words, so the agent may read it once more.
