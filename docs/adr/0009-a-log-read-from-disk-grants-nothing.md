# A log read from disk grants nothing: what the machine trusts lives outside the repository

The board's log is committed with the repository, so that the board is the story of the project. A second security review showed what follows from that: a repository can ship a log that says anything. A cloned repository's log held an "owner" solidify and a "Build this" with a check command of the repository's choosing. On open, the server resumed that build and ran the command, and the owner had pressed nothing. We decided that a log read from disk is history and never authority. What the machine acts on is kept in a private file outside the repository, written only when the owner acts on this machine.

**Status:** accepted. It tightens records 0001, 0003 and 0007.

**What is trusted, and where it lives**

| Thing | Where | Why not in the repository |
|---|---|---|
| The board's key, which a server proves itself with | The private file | A server that cannot prove it is this board's own is not trusted with anything |
| The running server's tokens: the owner's, the agent's and the system's | The private file, while the server runs | Whoever holds the owner's token decides as the owner, and a check the builder runs can read any file in the repository |
| Which builds the owner started here, each with its check and its track | The private file | A log can be forged |
| The log as this machine's server last wrote it: its size and the SHA-256 of its bytes | The private file | It tells this log from any log that came another way |
| Which lines came from outside and are not kept yet | The private file | The log says who made each line, and the log can say anything |
| The agent's session, the builder's worktrees | The private folder | Nothing in the repository should point them elsewhere |

The private folder is `~/.keel/boards/<key>/`, or under `$KEEL_STATE_DIR`. The key comes from the board folder's device and inode, so one board has one folder however its path is spelled, and one lock: two servers never write one log. The lock is put in place whole, and it names when its holder started, so a process number that is used again, or a clock that is set, does not free it.

**What follows**

- A build runs on this machine only with a consent recorded here: the owner pressed "Build this" or Resume on this machine, and the server admitted it live. The check that runs is the consent's. With no consent the board says so, shows the check, and waits for the owner.
- A consent holds only for the log the owner saw. When the log on disk is not the one this machine's server last wrote, it changed outside the board: a clone, a pull, a checkout, an edit. Then every consent is dropped. Without this, a changed log could keep the chapter, the check and the parts of an old consent and change everything else the builder is told, or wind a finished build back and run it again.
- The lines that came from outside are marked: all of a cloned log, or the lines after what this machine's server wrote. The page tags what they made as "not made here" and says so in a banner. The agent's digest tags them as not a request, and they wake nobody. They stay marked, across restarts, until the owner keeps them. An item the owner rewrites here is the owner's.
- Before the owner agrees to a build in such a log, the page shows the check and every remark the builder would follow as "the owner said". A build that arrives paused is shown the same way, never as an ordinary paused build.
- The server writes only to the log it opened. When the file at the log's path is replaced under it, as a pull or a checkout does, or another hand writes into it, the server stops saving and says why. Nothing is written to a file that is no longer there.
- `.keel/board/server.json` says only that a server is up. It holds no token.
- The session cookie is gone. A cookie for 127.0.0.1 is sent to every local port, so it was the owner's token handed to any local web server.
- Every token is new each time the server starts, the owner's too, and is worth nothing once it stops. A tab left open keeps trying its address after the server is gone. Whatever answers there next gets a token that opens nothing.
- No token is ever in an address. The address the command prints holds a code that works once, for five minutes. The page trades it for the owner's token. What stays in the browser's history is a spent code.
- The agreed check runs code the builder wrote. It runs in a sandbox where the system has one: no network, writes only inside the builder's worktree, no reads of the private folder or of the folders that hold the owner's keys. Where there is no sandbox, the board says so.
- Git in the builder's worktree is told where its own git folder is, by keel and by the builder alike, and runs no hook. The code a check runs can write in the worktree, so a `.git` it leaves there, or a hook script the repository tracks, is never what git obeys.
- No secret on the board: an event that holds the shape of a key or a password is refused, because the log is published with the repository.

**Alternatives**

- **Do not commit the log.** Then the board is not the project's story, and a second machine starts blank. The log stays committed. Authority does not travel with it.
- **Sign each owner event.** It proves who wrote a line. It needs keys to manage, and a consent file outside the repository answers the question that matters here: did the owner of this machine press it.

**Consequences**

- A board cloned from someone else shows their history, their decisions and their built parts as history. Nothing in it runs anything.
- A build started on one machine does not carry on by itself on another. The owner agrees to it there.
- After a pull or a checkout that changes the log, a build that was going waits for the owner's Resume, and the new lines wait for the owner to keep them. The same happens after a crash that stopped the server before it wrote the seal. It costs a press or two, and it fails safe.
- After a restart, a tab from before is signed out. The command opens a new one, and `keel-board link` prints a fresh address.
- Losing the private folder loses little: the builder's work that was not committed, the agent's session, the port, and the agreements, which are asked for again.

**What this does not cover**

- The sandbox closes the network, writes outside the worktree, and the named folders. The check can still read the owner's other files, and what it prints reaches the feed. On a Mac it also cannot ask the system to open a file, script another program or start a job, but that is a list, not a wall.
- A log from outside can say a part is built. The board draws it as the log says. The terminal lists such a line when this repository does not have its commit.
- Files dropped on the board are not looked at for secrets.
