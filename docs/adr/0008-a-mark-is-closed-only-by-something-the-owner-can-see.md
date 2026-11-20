# A mark is closed only by something the owner can see, and the owner's decisions are listed, not implied

A second review read the contract itself and looked for ways round its rules. It found several, each a place where the contract let something happen by default or by an agent's word alone. We decided to remove every such default: what closes a mark, what a solidify decides, what a built part proves and what the owner picked are each stated in the event, checked by the server, and visible on the board.

**Status:** accepted. It tightens records 0002 and 0007 and reverses nothing in them.

**What the review showed, and what changed**

| The fault | The change |
|---|---|
| An agent could answer a mark with a picture and then take the picture off, or with a placeholder, or with words nobody saw. The open count fell to zero with nothing on the board. | A mark is answered while a finished picture that names it is on the board, or by an answer that says how it was read. Take the picture off, and the mark is open again. |
| A solidify with no list made solid every idea in the chapter at that moment. An agent could add a part just before the press. | A solidify lists its parts: the ones the owner saw. |
| After the owner picked a picture or pressed "Build this" on a blueprint, the agent could redraw it. The brief the builder read followed the redraw. | The owner's picks and the pressed blueprint are frozen for the agent. A change is a new picture. The brief reads only the pressed blueprint and the agreed check. |
| An agent could override a choice the owner made by drawing the card again without that option. | A choice the owner picked keeps that option and its words. |
| "Built" took any command as its check, could skip "building", and could be claimed in the feed by the agent. | Built comes from building, from the system, with the check the owner agreed to. Evidence in the feed comes from the system only. |
| A reopened part could be put off or dropped by the agent, so a chapter came out built without it. Any old mark could serve as the reason to reopen. | A part the owner decided once stays the owner's. A reopen needs an open mark made after the decision. |
| The word "constructor" as an id passed every "does it exist" check, and could make the digest throw for good. | Such words are refused as ids. |
| A chapter title or a part name with a line break could add a forged line to the digest the agent reads, or a heading to the brief the builder reads. | Every free text in the digest and the brief is put on one line. An owner's act is always listed, however many marks are open. |
| A log line with a huge event number, or a time the schema refuses, was admitted and lost on reload. | Both are refused when posted. |

**Consequences**

- The app sends more with each act: the parts with a solidify, the check with "Build this".
- An agent that wants to change a picked picture must post a new one. The board shows both, which is the story.
- An agent's quick acknowledgement is a sentence the owner can read, never a silent close.
- The same review should be repeated when the contract changes in substance. Its probes are throwaway, and its findings are now tests in `workspace/protocol/test/`.
