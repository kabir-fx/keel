# The board server refuses an event that breaks a rule

The owner decides and the agent proposes. We put that in the one place every event passes: the board server checks each event against the board's state before it appends it, and refuses an event that breaks a rule. It does not warn. A refusal names the rule and says in one sentence what to do instead, so an agent can correct itself in the same turn.

**Status:** accepted

The rules, as code in `workspace/protocol/src/rules.ts`:

| Rule | What it holds |
|---|---|
| R1 | Only the owner decides. Only an owner event makes a part solid. A decided part changes only after it is reopened, and an agent reopens one only by naming the owner's mark on that part. |
| R2 | Built means evidence. A part is built when it has a commit and a check that passed. |
| R3 | Every agent picture names the marks it answers, or the items it comes from. This draws the lineage arrows and counts the open marks. |
| R4 | Nothing is deleted. An id is used once, and a removed item stays in the log. |
| R5 | A fresh agent can continue from the digest alone. |
| R6 | Each actor sends only its own kinds of event. The server takes the actor from the connection, never from the event. |
| R7 | Every name in an event points at something that exists on the board. |
| R8 | A part and a chapter move one step at a time: idea, solid, building, built. Nothing is built before the owner presses "Build this". |

**Alternatives**

- Trust the agent's instructions to hold these. Instructions are followed most of the time. A rule in the server holds every time, and it still holds when a better model replaces the instructions.
- Warn and append anyway. The board would then show states that no owner decided.

**Consequences**

- The rules guard against mistakes, not against an attacker. The agent runs as the owner's user and could write the log file directly. The plugin's guard hook covers that path.
- An agent must patch the model before it posts a picture that names a part. The refusal tells it so.
- A new kind of event needs a row in the permission table and a rule test before the server will take it.
