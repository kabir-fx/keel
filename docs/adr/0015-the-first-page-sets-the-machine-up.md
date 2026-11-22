# The first page sets the machine up: the board installs Claude Code and signs the owner in

The board needs Node, git, and Claude Code installed and signed in. The package from npm brought none of them. On a machine without Claude Code the board opened, a line in the terminal said the agent would not answer, and the owner's first note sat on the board with no reply. The fix was a second terminal, an installer, and `claude` typed once to sign in. We decided that the board carries the owner through this itself. One command installs everything a bare machine lacks. The page that opens is a setup page for as long as something is left, and the board takes its place when nothing is.

**Status:** accepted. It extends record [0003](0003-the-board-server-hosts-the-agent.md): the agent's adapter now also says what its harness needs on this machine.

**Two ways in, one page**

| The owner has | What they type | What installs the rest |
|---|---|---|
| Nothing | `curl -fsSL https://raw.githubusercontent.com/kabir-fx/keel/main/get.sh \| bash` | `get.sh`: git, Node, Claude Code, the board, the `keel-board` command |
| Node 22 or newer | `npx keel-workspace` | The setup page: Claude Code |

Both end on the same setup page, which signs the owner in.

**What `get.sh` does**

It installs each thing only when it is missing, and asks nothing.

1. git. On macOS it opens Apple's install window for the developer tools and waits. On Linux it uses the package manager, with sudo. That is the only use of sudo. When git cannot be installed, the script says the command and goes on: the board opens without git.
2. Node 24, from nodejs.org, checked against the sha256 sums nodejs.org publishes, into `~/.local/share/keel/node`. Only when no Node 22 or newer with npm is on the PATH.
3. Claude Code, with Anthropic's installer.
4. The board, with `npm install --global --prefix ~/.local/share/keel/pkg`, so it never needs root.
5. A launcher, `~/.local/bin/keel-board`. It puts the Node from step 2 first on the PATH when there is one, so the board, the builder and every check find `node` and `npm`.
6. One line in the shell's startup file, when `~/.local/bin` is not on the PATH.

Nothing goes under `~/.keel`. A build's check runs in a sandbox that may not read that folder (record [0007](0007-the-owner-agrees-to-one-check-and-only-it-calls-a-part-built.md)), and the check must be able to run the Node from step 2.

`get.sh` does not sign in. The page does.

**The setup page**

The server knows three facts about the machine, and looks at them again each time it is asked: is Claude Code there, does it say it is signed in, is there a git. The page lists them as steps, with one button, on the first step that is not done.

- **Install Claude Code.** The server fetches Anthropic's installer and runs it as the owner.
- **Sign in to Claude.** The server runs `claude auth login`. Claude Code opens its sign-in page in a new tab, and the owner approves there. When that page shows a code, the owner pastes it into the setup page, and the server hands it to the waiting sign-in.
- **git.** The page says how to get it. It has no button: on macOS the install is Apple's window, and on Linux it needs a password.

The page asks the server every 1.5 seconds, so a sign-in finished in another tab, or an install finished in a terminal, moves it on. "Open the board without this" opens the board as it is, for that tab.

The page is shown by what is true now, and not by a mark that the setup ran once. An owner who signs out of Claude Code sees it again at the next start.

**Where the code lives**

The server asks the agent's adapter, through `AgentLink.setup`: `look`, `install`, `signIn`, `code`. The adapter for Claude Code answers by running Claude Code's own commands, in the environment the agent gets. So the sign-in the page finds is the one the agent will use, and another harness brings its own setup with its adapter. An adapter that needs nothing leaves `setup` out, and the page then lists git alone. Whether there is a git is the server's own question. `ROUTES.setup` is for the owner only.

**What this does not cover**

- The server runs an installer it fetched over the network, on the owner's press. It is Anthropic's, fetched over HTTPS from `claude.ai`. keel does not pin it or check a sum: it changes with every Claude Code release.
- A Claude Code that is there and too old was not noticed. Record [0018](0018-the-board-runs-only-a-claude-code-new-enough.md) adds that check, and an update step to this page.
- A sign-in that ends while the board is open is not noticed until the agent's next turn fails.
- The sign-in is for a Claude subscription. The agent is started without `ANTHROPIC_API_KEY` (record 0003), so the page offers no key.
- `get.sh` is served from the `main` branch. What it installs is the newest `keel-workspace` on npm, which can be older or newer than the script.
- Windows has no `get.sh`.

**Alternatives**

- **Sign in from `get.sh`, in the terminal.** The script runs under `curl | bash`, where its input is the script itself, so it cannot ask anything. It would also leave the npm way in with no sign-in.
- **A mark that setup ran once.** It would be wrong the day the owner signs out.
- **A terminal on the setup page that runs `claude`.** The board already has one for Try it (record [0013](0013-a-finished-build-is-run-to-be-tried.md)). It would show Claude Code's whole first-run screen, where the page needs one button.
- **Put Node and the board in `~/.keel`.** The check's sandbox denies that folder, so no build's `npm test` could start.
