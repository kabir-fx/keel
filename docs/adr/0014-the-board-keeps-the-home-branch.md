# The board keeps the home branch: it pulls when it opens, builds from it, and an approval fast-forwards it

A build ended on a branch, and the board's part ended there too. Merging was a git command the owner typed ([0007](0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)). The next idea then started from a main branch that lacked the first one, and the agent warned that earlier work was not merged. We decided that the board carries an idea all the way: it brings the main branch up to date when it opens, starts every build from it, and merges a build into it when the owner approves. The owner never types a git command.

**Status:** accepted. It changes two lines of earlier records. Record 0007: "The branch waits for the owner to merge" becomes an Approve on the board. Record 0011: "the owner's branch never moves" still binds the builder, and no longer binds the board server, which moves the home branch on the owner's press and when it opens.

**Canvases**

A board has many canvases. A canvas is a blank place for an idea, and it owns a branch. Every idea on one canvas is built on that canvas's branch, one after another. A new canvas means a new branch. The owner starts a canvas from the Story. A first note on a canvas opens an idea there, and a note on a canvas where everything is built opens the next idea on the same canvas, so on the same branch.

**The home branch**

The home branch is the repository's main branch: the one `origin/HEAD` names, else `main`, else `master`, else the branch the owner's folder is on. Every build starts from it and every approved build goes into it. When the owner's folder is on another branch, the board says so: builds still start from the home branch.

**When the board opens, and before each build**

1. The server fetches the remote the home branch follows. It waits a bounded time, never asks for a password, and never touches a terminal.
2. When the remote is ahead and the home branch has nothing of its own, the home branch is fast-forwarded. In the folder where it is checked out, git does this, and git refuses when the owner has changes in the files it would write. Nothing is ever merged, rebased or stashed for the owner.
3. Anything else is said, not fixed: the remote did not answer, the two have diverged, the owner's changes are in the way. The board opens either way, and builds start from the home branch as it is here.

**A build**

The builder makes the canvas's branch from the home branch's commit, as the server just read it, and never from where the owner's folder happens to be. The branch is named from the canvas's title when "Build this" is first pressed there: `board/<title>`. A later idea on the same canvas is built on the same branch, in the same copy.

**Approve**

After a build, the owner tries it ([0013](0013-a-finished-build-is-run-to-be-tried.md)) and presses Approve. An approval is of the canvas: its branch, with every built idea on it. It is refused while an idea on that canvas is still building, and while the builder's run there has not ended, since the branch would be merged half done. The server then:

1. Brings the home branch level with its remote, as above.
2. When the home branch has moved since the build started, asks the builder to merge it into the build's branch, in the builder's own copy, and to run the agreed check on the result. When the two changed the same lines, the builder joins them, the check must pass, and the server stops there: what the owner tried has changed, so they try it again and approve again.
3. Moves the home branch to the build's commit, by fast-forward only. The home branch therefore only ever moves to a commit the agreed check passed on.
4. Says `canvas.merged` in the log, with the commit. Only the server may say it. Every built idea on the canvas is merged from then on.
5. Takes the build's copy and its branch away. The work is in the home branch.

Pushing is a second press. After a merge the board offers "Push" when the home branch follows a remote. It is never forced. A push that the remote refuses is said in the feed with git's own words.

**Deleting a canvas**

The owner can delete a canvas from the Story. Every idea on it leaves the board with its items, its build and its show stop, and its copy and its branch are taken away, with every commit the home branch does not have. The board names the ideas and says how many commits before the owner confirms. The log keeps every line ([0001](0001-the-board-is-an-append-only-log.md)): the canvas and its ideas move to lists of what was removed, and their ids are never used again. What was merged stays in the home branch. One idea of several on a canvas cannot be deleted alone: its commits are on the branch they share.

**What is never done**

- The home branch is never moved except by fast-forward, never rewritten, and never pushed without a press.
- The owner's uncommitted changes are never stashed, committed or overwritten. When they are in the way, the board names the files and waits.
- A build is never merged without the owner's Approve, and never when the check does not pass on what would be merged.
- The builder still never touches the owner's branch, index or files. The server does, and only as written here.

**Alternatives**

- **Merge with a merge commit on the home branch.** It needs no second run of the check, and it puts a commit nobody tested on main. Merging main into the build's branch first, and checking there, costs one more check and keeps the promise.
- **Open a pull request instead of merging.** It fits a team with a protected main. It needs a hosting service and its login, and the owner asked for a merge. The push is a separate press, so a team can push the build's branch by hand instead.
- **Rebase the build onto the new main.** It rewrites commits the board's log names as evidence.
- **One log per canvas.** It would make each canvas a board of its own, with its own server state. One log with many canvases keeps the project's model whole for the Story, and one agent that knows every idea.
- **A branch per idea, on a shared canvas.** It was the first design. The owner ruled that a canvas is the unit: what is drawn together is built together.
- **Build the next idea on top of an unapproved one.** It would need the second branch to follow the first. The board says instead that the first is not approved yet, and offers to try it.

**Consequences**

- An idea built here ends in the home branch with two presses: Try it, Approve.
- An unapproved canvas is not in another canvas's start. The board says so where the owner agrees to the next build, and the agent no longer tells the owner to merge by hand.
- When the owner's folder is on the home branch, an approval writes the merged files into it, as `git pull` would.
- A home branch that was approved and not pushed is ahead of its remote. The board shows it until it is pushed.
- When someone pushes between an Approve and the Push, the push is refused and the two have diverged. The board says so and names the one command that joins them, `git pull`. It does not join them itself: that would put a commit on the home branch that no check ran on.
- A repository with no commit ([0011](0011-an-empty-folder-is-built-from-nothing.md)) has a home branch with nothing in it. Approve moves it to the build, which writes the files into the owner's folder.
- Fetching and pushing use the owner's own git credentials, as their own git would. With no stored credential the remote counts as unreachable.
- Deleting a canvas with unmerged work loses its commits. Git keeps them for a while by their hashes, and the board does not promise that.
