# An empty folder is built from nothing: the builder starts its own branch, and the owner's never moves

The builder works on its own copy of the repository, made from the owner's last commit ([0007](0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)). A new idea often starts in a new folder, and a new folder has no commit, and may not be a git repository at all. There the build stopped at "Build this" and told the owner to run `git init` and make a first commit, after they had drawn the whole idea on the board. We decided that a folder with nothing in it is built from nothing, with no step for the owner, and that the rule from 0007 still holds: the builder never touches the owner's branch, index or files.

**Status:** accepted. It extends record 0007.

**What the builder does**

| The board's folder | What the builder does |
|---|---|
| A repository with a commit | As before: a worktree on `board/<chapter>`, made from the owner's commit. |
| A repository with no commit, and nothing of the owner's in it | It makes a first commit that holds no file, by git's plumbing, on no branch of the owner's. Its own branch starts there. |
| No git repository, and nothing of the owner's in it | It runs `git init` there, then does the same. |
| No commit, and files of the owner's | The build stops. The note names the files and says to commit them. |

"Nothing of the owner's" means no file beside the board's own `.keel/`, git's `.git`, and what an operating system leaves in a folder, such as `.DS_Store`. In a repository git is asked, so a file the owner told git to ignore does not count, and a staged file does. In a folder that is no repository only its top level is looked at, and anything there counts, an empty folder too.

The first commit names the builder as its committer, as every commit of a build does. Its message says what it is. No hook runs for it, and nothing is signed.

The feed says what was done, once: that the branch starts from nothing, and that the folder was made a repository when it was. A build that is resumed does not say it again.

Two smaller cases follow the same rule. When the board's folder is a new folder inside a repository, one that the owner's commit does not hold, the builder makes it in its own copy. When git is not installed, the build stops and says so.

**Why the build still stops when the owner has files and no commit**

The builder's copy is made from commits, so it would not have those files, and would build blind beside them. The other way is to commit them for the owner. A folder nobody has committed from may hold a key or a password that no `.gitignore` names yet, and a commit puts it in history for good. That is the owner's act. The note says what to commit and why.

**Alternatives**

- **`git worktree add --orphan`.** It gives the same result with no empty commit, but it needs git 2.42, and many machines have an older one. The plumbing works on every git.
- **Make the first commit on the owner's branch.** Simple, and it breaks the one promise the builder makes about the owner's checkout.
- **Keep the refusal, with a better note.** It is honest, but it sends the owner to a terminal at the moment the board said it would build.

**Consequences**

- The owner's branch has no commit until they merge. `git merge board/<chapter>` works there as anywhere else: git moves the unborn branch to the build and writes the files.
- The history of such a repository begins with a commit that holds nothing. Its message says what it is.
- A second idea built before the first is merged starts from nothing again, and does not have the first one's files. The same is true in any repository: a build starts from what the owner has merged.
- After the builder ran `git init`, the folder is a repository with one untracked folder, `.keel/`. The board's log in it is meant to be committed, and `.keel/board/.gitignore` already keeps this machine's files out.
- An empty folder no longer stops a build. A folder with the owner's uncommitted files still does, and the note names the files.
