# The board is an append-only log in the target repository

The workspace keeps one file of events per repository, `.keel/board/log.jsonl`, and the state of a board is that log, reduced. We chose a log because the board must be the story and the memory of a project: nothing the owner sees may live only in an agent session. A file of events commits and diffs beside the code it describes, and it lets an agent session be thrown away, because a short digest of the log is enough to continue.

**Status:** accepted

**Alternatives**

- A SQLite file. Better queries, but opaque in git, and "nothing is deleted" becomes a promise instead of a property of the format.
- One JSON document of the current state. Simple, but it loses the history, and two writers overwrite each other.
- A hosted store. The owner's project content would leave the machine.

**Consequences**

- The log only grows. Taking a mark off the board appends a tombstone event. The mark stays in the log.
- Only the board server appends. It numbers and dates each event, so the app and the agent never race for an id.
- `workspace/protocol` holds the only reducer. The app, the server and the plugin all read state through it.
- Snapshots and dropped files sit in `.keel/board/assets/`. The log is meant to be committed. Large assets need not be.
- `.keel/board/server.json` says only that a server is up, while one runs. It holds no token, and git ignores it. The tokens are kept outside the repository ([0009](0009-a-log-read-from-disk-grants-nothing.md)).
