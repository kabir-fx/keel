# A merge to main is a release: the pipeline checks it, publishes it, and moves `latest` last

`keel-workspace@0.1.0` was published by hand: eight steps on the owner's machine, with a one-time code. `get.sh` and `npx keel-workspace` install whatever npm calls `latest`, so a change merged to `main` reached nobody until the owner ran those steps again. Nothing checked a pull request either: `scripts/check.sh` ran only when someone remembered. We decided that GitHub Actions does both. Every pull request runs the whole of `scripts/check.sh`. Every push to `main` runs it again, and then publishes the package when what it holds has changed.

**Status:** accepted. It replaces the owner's steps in the publish plan, and the line in `skills/ship/release.md` that asks before a publish command does not apply to this pipeline: the owner's yes is the merge.

**The two workflows**

| File | Runs on | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | every pull request, and from `release.yml` | lints the workflows and the shell scripts, then runs `KEEL_E2E=1 scripts/check.sh` on Ubuntu with Node 24 and 22, and on macOS with Node 24 |
| `.github/workflows/release.yml` | every push to `main` | `ci.yml`, then package, publish, verify, promote, record |

`scripts/check.sh` stays the one list of checks. The workflow says where it runs and adds nothing a contributor cannot run. Two targets are new: `shell` (shellcheck) and `package` (build, stage, install the tarball, start the board from it). `board` now lints the TypeScript with oxlint.

**What a release is**

1. **Package.** Build, stage with `release/pack.mjs`, and ask `release/next.mjs` what to do: publish a new version, promote one that never became `latest`, or nothing.
2. **Publish.** `npm publish <tarball> --tag next`. The job has no checkout and runs no code from the repository. It uploads the file the package job installed and started.
3. **Verify.** On Ubuntu and on macOS: wait until npm lists the version, compare npm's checksum with the one the package job made, then run `curl get.sh | bash` for that version and start the installed `keel-board`.
4. **Promote.** `npm dist-tag add keel-workspace@<version> latest`. Only now do `get.sh` and `npx keel-workspace` install it.
5. **Record.** A git tag `v<version>` and GitHub release notes.

A version that fails step 3 stays on the `next` tag and never becomes `latest`. What happens next depends on why it failed:

- **The package is wrong.** The fix is a merge. It changes the package, so it publishes the next version, and that one is verified.
- **Something else failed**, such as the network. Any later run finds the newest version on npm is not `latest`, and that the staged package still holds what it holds. It publishes nothing: it verifies that version again and promotes it. Running the failed jobs again does the same.

**What decides a release, and its version**

- **Whether:** the staged package is compared, file by file, with the newest version on npm. The same bytes mean no release. So a change to a skill, a test or a document publishes nothing, and a change to a dependency that ends up in a bundle does. The build is the same from one run to the next, which makes the comparison hold.
- **Which commit:** each release writes `gitHead` into its `package.json`, and npm keeps it. `next.mjs` reads it back. A commit that is not after the newest release's commit is never released, so two runs that finish out of order cannot publish old code as new.
- **A job run again later:** GitHub can run one failed job of an old run again, with what that run decided at the time. So the publish job first checks that npm's newest version is still the one the run was decided against, and the promote job that the version it moves `latest` to is still npm's newest. Either one stops when npm has moved on.
- **Which version:** from the conventional commits since that commit that touch `workspace/` or `LICENSE`. A `feat` raises the minor number, anything else the patch number. From 1.0.0 on, a breaking change raises the major number. Before 1.0.0 it raises the minor number: the pipeline never reaches 1.0.0 by itself.
- `version` in `workspace/package.json` is `0.0.0` and is not a release. No workflow commits to `main`.

**Who may publish**

npm trusts the workflow, not a token. GitHub proves each run to npm with a short-lived identity, and the repository holds no npm secret. Every action is pinned to a commit. Two settings outside the repository carry this, and the pipeline is only as safe as they are:

- **On npmjs.com**, in the package's settings, the trusted publisher names this repository, the file `release.yml` and the environment `npm`. "npm publish" must be allowed, or every release waits for a person to approve it. "npm dist-tag" must be allowed, or no release ever becomes `latest`: npm leaves it off by default. npm drops a trusted publisher that has not published within 2 days of being made, so make it when the workflow is about to run.
- **On GitHub**, the environment `npm` is limited to the `main` branch, with no required reviewers. Without the limit, anyone who can push a branch can change `release.yml` on it and publish. With a reviewer, every release waits for a person, twice.

**Taking a release back**

A published version cannot be removed in practice. To put users back on the last good one, the owner runs `npm dist-tag add keel-workspace@<last good> latest` with their own sign-in. `get.sh` run again then installs it.

**What this does not cover**

- `get.sh` itself is served from `main` the moment a merge lands, before the release that follows it has finished. A change to `get.sh` that needs a new package is ahead of npm for those minutes.
- The check is as good as `scripts/check.sh`. The pipeline adds no test of its own beyond installing the published version.
- A real agent turn is not run: it needs a Claude sign-in, and the runners have none.
- Reaching 1.0.0, or any version the commits do not ask for, is a publish by hand, from a clean checkout of `origin/main`: `node release/pack.mjs --version <x.y.z>`, then `npm publish` in `release/keel-workspace`. The pipeline carries on from whatever version is newest on npm. A version published from a commit that is not on `main` stops every later release, because nothing on `main` comes after it.
- The workflows have not run on GitHub at the time of writing. Their steps were run by hand, on macOS and in a Linux container, up to a publish that sends nothing.
- Commit messages are not checked. A feature committed as `chore` gets a patch number.

**Alternatives**

- **A release pull request (release-please, changesets).** The version is a commit, and a person merges it. That is one more press for every release, and the owner asked for none.
- **semantic-release.** It decides by commit type alone, so a `feat` to a skill would publish a package with the same bytes, and a `chore` that changes the server would publish nothing. It is also a tree of dependencies in the one job that may publish.
- **Publish on a tag.** The publish plan's first idea. Someone still has to choose the number and push the tag.
- **Publish straight to `latest`.** One job fewer. A package that npm serves but that does not install would reach every `curl | bash` before anyone knew.
- **A token in the repository's secrets.** npm's write tokens last 90 days at most, and a token can be copied. A trusted publisher has nothing to copy.
- **Commit the version to `main`.** The pipeline would need the right to push to a protected branch, and every release would start another run.
