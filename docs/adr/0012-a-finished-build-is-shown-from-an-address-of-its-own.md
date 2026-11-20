# A finished build is shown from an address of its own, and nothing is run to show it

When every part was built, the board said so and named a branch. The thing itself was nowhere the owner could see: not in their folder, which the builder never touches, and not on the board. To look at a page they had to merge the branch and open the file by hand. We decided that a finished build shows itself. When what was built is a page a browser can open, the board server serves it and opens it once, and the build panel keeps a "See it" that opens it again.

**Status:** accepted

**How it goes**

1. When the last part is built, the builder looks for a page among the committed files: `index.html` at the top of the board's folder, else the only HTML file there.
2. The page must stand alone: every script and style sheet it names is a file beside it, or on the network. A page that needs a build step or a server of its own is not shown. The builder says nothing it cannot keep.
3. The builder copies the committed files into its private folder, outside the repository, and hands the server the folder and the page (`BuildShow` in the contract). Links, files in a folder whose name starts with a dot, and the files on the secret list are not copied. Past 2000 files or 50 MB, or when the worktree holds a change that is not committed, nothing is shown.
4. The server checks what it was handed, then serves that copy from a second listener on a port of its own, at an address that holds a key made new for each start. It answers GET and HEAD only, and only to its own host and port.
5. It tells the owner's page the address, opens it once in the browser, and says in the feed that it did. On a Mac the browser is not pulled in front of what the owner is doing. With `--no-browser` nothing is opened, and the feed says where to press.
6. The folder and the page are kept in the server's private file, so "See it" still works after a restart, at a new address. The page is not opened a second time.

**Why an address of its own**

The page shown is code a model wrote. The owner's token lives in the browser's storage for the board's origin, and whoever holds it decides as the owner: it can press "Build this". A page served from the board's port would be in that origin. A port of its own is another origin: the page cannot read the token, and the board refuses any request that comes from it. A frame inside the board would need the board's content security policy opened for it, and a frame without an origin cannot keep the storage that many small apps use.

**What is never done**

- No command is run to show a build. The owner agreed to one command, the check ([0007](0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)), and showing is not it. A build that needs a command to be seen is not shown.
- The address is never written to the log. The log is committed with the repository, and an address with a key is for this machine only. It is said to the owner's page, and not to the agent or the system.
- Nothing is served from the repository or the builder's worktree. The copy is in the private folder, where the code a check runs cannot write ([0009](0009-a-log-read-from-disk-grants-nothing.md)). The server takes a folder only from inside the builder's private folder, serves regular files only, follows no link, and refuses a hard link and any name that starts with a dot.
- The owner's folder is not changed. Merging is still the owner's act.

**Alternatives**

- **Open the file from disk** (`file://`). There is no file in the owner's folder to open, and a page opened that way cannot load a module script.
- **A frame on the board.** It keeps the owner on the board, but see above: it needs the policy opened, or it breaks the app's storage.
- **Let the blueprint name a command that shows the build.** It would show a command line tool or a server too. It is a second command for the owner to agree to, and it runs outside the check's box. It may come later, with its own agreement.
- **Merge the build into the owner's folder when it is done.** It would put the thing where the owner expects it, and it moves the owner's branch without their press.

**Consequences**

- A build of a page ends with the page in front of the owner, with no step of theirs.
- A build of anything else ends as before: the feed names the branch and how to merge it.
- The shown copy is the commit the build ended on. It does not follow later commits on the branch.
- The page shown can reach the network, like any page the owner opens. It is on 127.0.0.1, so a browser sends it the cookies of other local servers, as it does to any local page.
- Every page a board shows is on the same port, so they share one origin: one can read what another kept in the browser's storage. They are all the owner's own builds.
- The port and the key are new for each start of the server. What a shown page kept in the browser's storage is gone after a restart.
- A chapter that goes back to building has nothing to show until it is built again. When the log changes outside the board, what was kept to show is dropped with the consents: a board that came another way shows nothing of this machine's.
- Whether a page stands alone is read from its `<script>` and style sheet tags only. A page whose script imports a package by name passes the check and opens broken.
