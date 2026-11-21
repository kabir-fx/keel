# A finished build is run to be tried: on the owner's press, in its own copy, boxed in

A built idea showed itself only when it was a page that stands alone ([0012](0012-a-finished-build-is-shown-from-an-address-of-its-own.md)). Anything else, an app with a server, a command line tool, a library, ended with a branch name and a git command. The owner could not tell whether what they asked for was done without leaving the board. We decided that every built idea can be tried on the board: the blueprint names how, and the board runs it when the owner presses.

**Status:** accepted. It changes one line of record 0012: "No command is run to show a build." A command is now run, under the conditions below.

**How it goes**

1. The blueprint names how the result is tried (`show`), beside the check:

   | Kind | What the board does | For |
   |---|---|---|
   | `page` | Serves the built files from an address of its own. Nothing runs. Record 0012, unchanged. | A page that stands alone |
   | `app` | Runs one command with `PORT` set to a free port, waits until the app answers there, and shows it. | Anything a command serves: a web app, an API with a page |
   | `terminal` | Opens a terminal in the build's copy and types one command into it. The owner goes on from there. | A command line tool, a library, a script |

   It may also name one `setup` command, such as `npm ci`: what makes a fresh copy ready to run.
2. "Build this" must name the setup and the show as the blueprint shows them, word for word, like the check ([0007](0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)). The press is the owner's agreement, and the server keeps it outside the repository ([0009](0009-a-log-read-from-disk-grants-nothing.md)).
3. The builder runs the setup once, in its copy, before the first part. For an `app`, the build is not done until the command has started and answered on its port once: "built" now means it starts. The log says so with `build.proved`, which only the server's side may say. Until then the idea is building with every part built, so it cannot be tried or approved. When the app does not answer, the build stops there with what the command printed, and going on with the build tries again.
4. The builder's copy stays when the build ends. The show runs in it, so it has the dependencies the setup fetched.
5. Nothing starts by itself. The owner presses "Try it". The press carries the command the page showed, and the server runs it only when it is the chapter's own command, word for word.
6. The command runs boxed in, like the check, with two differences: it has the network, and for an `app` it may listen on 127.0.0.1.
7. An `app` is shown inside the board, in a frame, with a link that opens it in a tab of its own. The frame may run scripts and keep its storage, and may not move the board's page.
8. A show stops when the owner stops it, when the idea is approved or deleted, when its build goes on, and when the server stops.
9. When the blueprint named no show, the board looks for a page that stands alone, as before. When there is none, it offers a terminal with the check typed in. So every built idea has something to try.

**Why this is safe enough**

- The app answers on a port of its own, so it is another origin than the board, as a served page is in record 0012. It cannot read the owner's token, and the board refuses what it sends.
- A command from the log runs only after a press that showed it. A log that came from outside is tagged as such on the page, and a build nobody agreed to on this machine shows its commands and waits.
- The box denies the same folders the check's box denies: the board's private folder, the owner's keys. It writes only inside the build's copy and a temp folder of its own.
- A terminal is the owner's hands. What they type there they chose to run. It is still inside the box.

**What is never done**

- No show starts without a press, and none starts at "built".
- No command but the agreed setup, check and show is run by the board. A terminal runs what the owner types.
- The address of an app and the state of a command are never written to the log. They are said to the owner's page only.
- Nothing runs in the owner's folder. The owner's files are not read by a show.

**Alternatives**

- **Keep "nothing is run".** It is the safest, and it leaves every idea that is not one page unproven on the board. The owner asked for the opposite.
- **Let the builder choose the command when the build ends.** It knows what it built. But the owner would agree to a command only after the code that it runs was written by the same model. Named on the blueprint, it is agreed before.
- **A terminal library with a native part (`node-pty`).** The package ships with nothing to install, so the terminal is made with the system's own `script` command instead.
- **Open the app in a tab only.** The owner would try it away from the board and come back to approve. A frame keeps trying and approving in one place. The tab stays as a link, for an app that refuses to be framed.

**Consequences**

- The setup runs with the network, and writes to the caches of the usual package managers, outside the copy. It is the one step with that reach, and the owner agrees to its exact words. It runs again, by the build's own code, when a part changes a dependency file, and when the home branch is joined in before a merge.
- An app is told to listen on 127.0.0.1, and the macOS box cannot hold it to that: an app that listens on every address can be reached from the network it is on while it runs. The builder's instructions say 127.0.0.1.
- An app that needs a secret the repository does not hold, such as an `.env` file, will not start in the copy. The board shows what the command printed, and the idea is not built, so it is not approved. Such an idea is tried in a `terminal` instead, where the owner sets what it needs.
- Where the system has no box (Windows, some containers), the show runs with a short environment and no box, and the board says so, as it does for the check.
- A terminal has no box against the owner: they can read what the box allows. It is their machine.
- An app that sends "do not frame me" shows an empty frame. The link beside it opens it in a tab.
- A build that is "built" for an `app` has answered on its port once. That it does what was asked is still the owner's to see, which is the point of trying it.
- The terminal needs the `script` command, which macOS and most Linux systems have. Where it is missing, the command runs without a terminal: tools that draw full-screen will not work there.
