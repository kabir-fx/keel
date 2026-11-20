# The hosted agent takes nothing from the repository as instruction, and reads only inside it

The board server starts an agent in whatever repository the owner opens, with no trust prompt, the moment a mark is open. A review showed what that allowed: a repository's own settings file ran hooks as the owner 15 seconds after `keel-board open`, and a file in the repository steered the agent into reading a file outside it and posting the contents on the board, which is a log meant to be committed. We decided that the hosted agent loads no settings, hooks or instruction files from the repository, and that its file tools stay inside the repository with a deny list for secrets.

**Status:** accepted

**What the fence is**

- No project or local settings, and hooks switched off. The repository's `.mcp.json` is ignored: the board tools are the only tools from outside.
- The repository's `CLAUDE.md` is not loaded. The agent may read it as a file, like any other. A repository's text reaches the agent as data it chose to read, never as instructions sent again on every wake.
- Read and Glob only. No shell, no edit, no write. Search is left out, because a deny rule on a file does not stop a search of the folder above it.
- Reads stay inside the repository's real path. A link that points outside is refused.
- Denied by name inside the repository: the board's own server file, `.env` files, key and certificate files, and the usual credential files.
- The owner's token is kept outside the repository, so nothing the agent can read lets it decide as the owner.

Each point was proven with the real agent against a hostile repository: no hook ran, and nothing from an outside file, an `.env` file or a key file reached the log.

**Alternatives**

- Trust the repository, as an interactive session does after its trust prompt. A board has no such prompt, and it wakes the agent by itself.
- Ask the owner to trust each repository once. It may come later for the owner's own rules. It is not the default.

**Consequences**

- The owner's own conventions in `CLAUDE.md` do not shape what the board agent says. A later option can load one file the owner names.
- The deny list is a list of names. A secret under another name inside the repository can still be read.
- The fence stops instructions, not persuasion. Text the agent reads can still mislead it. What limits the harm is what the agent can do: draw on the board, and nothing else.
- The builder is a separate process with its own fence, because it must write files and run the one check the owner agreed to.
- The plugin's guard hook, which keeps an interactive session's hands off the board's files, stops mistakes and not an attacker.
