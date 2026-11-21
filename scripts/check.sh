#!/usr/bin/env bash
# Checks keel itself. Run it after any edit to the suite.
#
#   scripts/check.sh            everything
#   scripts/check.sh lint       skill, agent, and reference checks
#   scripts/check.sh hook       the guard hook, against a table of commands
#   scripts/check.sh bar        bar-guard.sh, against a throwaway repository
#   scripts/check.sh brief      brief-check.sh, against a clean and a bad brief
#   scripts/check.sh install    the installer, against a throwaway config directory and bin folder
#   scripts/check.sh get        get.sh, against a throwaway home, install folder and bin folder
#   scripts/check.sh board      the workspace: typecheck, unit tests, the plugin's files.
#                               KEEL_E2E=1 adds the browser tests.
#
# `all` runs `board` only when Node 22 or newer and npm are there.
# Exit status: 0 when every check passes, 1 otherwise.

set -u

root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$root" || exit 1
what="${1:-all}"

fails=0
checks=0
ok() { checks=$((checks + 1)); }
fail() { checks=$((checks + 1)); fails=$((fails + 1)); printf 'FAIL  %s\n' "$*"; }
expect() { # expect <description> <actual> <wanted>
  if [ "$2" = "$3" ]; then ok; else fail "$1: got '$2', wanted '$3'"; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Commands and bundled skills that ship with Claude Code. A keel skill must not
# take one of these names, and a `/name` in keel's text must be one of these or
# a keel skill.
builtin_names="add-dir advisor agents autofix-pr batch branch btw bug clear code-review color compact config context copy cost debug deep-research design design-sync diff doctor effort exit export fast feedback fork goal help hooks ide import init insights login logout loop mcp memory model permissions plan plugin recap release-notes reload-skills rename resume review rewind run run-skill-generator sandbox schedule security-review simplify skill-doctor skills status statusline subtask tasks team-onboarding theme ultrareview usage verify vim"
skill_keys="name description when_to_use argument-hint disable-model-invocation user-invocable allowed-tools disallowed-tools model effort context agent paths hooks"
agent_keys="name description tools disallowedTools model permissionMode maxTurns skills effort isolation color omitClaudeMd"

in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }

frontmatter() { awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit } NR > 1 { print }' "$1"; }
field() { frontmatter "$1" | sed -n "s/^$2:[[:space:]]*//p" | head -n 1; }

check_frontmatter() { # check_frontmatter <file> <expected name> <allowed keys>
  local file="$1" want="$2" keys="$3" key desc
  [ "$(head -n 1 "$file")" = "---" ] || { fail "$file: no frontmatter"; return; }
  expect "$file name" "$(field "$file" name)" "$want"
  desc="$(field "$file" description)"
  [ -n "$desc" ] && ok || fail "$file: empty description"
  [ "${#desc}" -le 1024 ] && ok || fail "$file: description is ${#desc} characters, over 1024"
  case "$desc" in
    \"*) ok ;;
    *": "*|*" #"*) fail "$file: unquoted description contains ': ' or ' #', which breaks YAML" ;;
    *) ok ;;
  esac
  for key in $(frontmatter "$file" | sed -n 's/^\([A-Za-z_-][A-Za-z_-]*\):.*/\1/p'); do
    in_list "$key" "$keys" && ok || fail "$file: unknown frontmatter key '$key'"
  done
}

lint() {
  local dir name file ref target n rules skills="" agents="" lines

  for dir in skills/*/; do skills="$skills $(basename "$dir")"; done
  for file in agents/*.md; do agents="$agents $(basename "$file" .md)"; done

  for name in $skills; do
    file="skills/$name/SKILL.md"
    [ -f "$file" ] || { fail "skills/$name has no SKILL.md"; continue; }
    check_frontmatter "$file" "$name" "$skill_keys"
    in_list "$name" "$builtin_names" && fail "$file: '$name' collides with a built-in command" || ok
    lines=$(wc -l <"$file" | tr -d ' ')
    [ "$lines" -le 150 ] && ok || fail "$file: $lines lines, over keel's cap of 150"
  done

  for name in $agents; do
    check_frontmatter "agents/$name.md" "$name" "$agent_keys"
  done

  rules=$(grep -c '^[0-9][0-9]*\. \*\*' rules/keel.md)
  lines=$(wc -l <rules/keel.md | tr -d ' ')
  [ "$lines" -le 40 ] && ok || fail "rules/keel.md: $lines lines. It loads in every session: keep it under 40."

  while IFS= read -r file; do
    dir="$(dirname "$file")"

    # Relative markdown links resolve.
    for ref in $(grep -o '\]([^)#]*\.md)' "$file" | sed 's/^](//; s/)$//'); do
      case "$ref" in http*) continue ;; esac
      [ -f "$dir/$ref" ] && ok || fail "$file: broken link $ref"
    done

    # ${CLAUDE_SKILL_DIR} references resolve from the skill's own directory.
    for ref in $(grep -o '\${CLAUDE_SKILL_DIR}/[A-Za-z0-9_./-]*' "$file" | sed 's/^\${CLAUDE_SKILL_DIR}\///'); do
      target="${file#skills/}"; target="skills/${target%%/*}/$ref"
      [ -e "$target" ] && ok || fail "$file: \${CLAUDE_SKILL_DIR}/$ref does not exist"
    done

    # `/name` is a keel skill or a built-in command.
    for ref in $(grep -o '`/[a-z][a-z-]*' "$file" | sed 's/^`\///' | sort -u); do
      in_list "$ref" "$skills $builtin_names" && ok || fail "$file: /$ref is neither a keel skill nor a known built-in"
    done

    # "the `name` skill" and "the `name` agent" exist.
    for ref in $(grep -o '`[a-z][a-z-]*` skill' "$file" | sed 's/^`//; s/` skill$//' | sort -u); do
      in_list "$ref" "$skills $builtin_names" && ok || fail "$file: no skill named '$ref'"
    done
    for ref in $(grep -o '`[a-z][a-z-]*` agent' "$file" | sed 's/^`//; s/` agent$//' | sort -u); do
      in_list "$ref" "$agents" && ok || fail "$file: no agent named '$ref'"
    done

    # "rule N" points at a rule that exists.
    for n in $(grep -o 'rule [0-9][0-9]*' "$file" | sed 's/rule //' | sort -u); do
      [ "$n" -ge 1 ] && [ "$n" -le "$rules" ] && ok || fail "$file: rule $n does not exist (there are $rules)"
    done

    grep -q '—' "$file" && fail "$file: contains an em dash" || ok
  done < <(find skills agents rules -name '*.md' | sort; ls README.md 2>/dev/null)

  # Agents per change, from the rigor table in /build. A cap rises only by editing it here.
  local row cell cap max i=2
  row="$(grep '^| Agents |' skills/build/SKILL.md)"
  if [ -z "$row" ]; then
    fail "skills/build/SKILL.md: the rigor table has no Agents row"
  else
    for cap in 1 2 3; do
      i=$((i + 1))
      cell="$(printf '%s\n' "$row" | awk -F'|' -v n="$i" '{ print $n }')"
      max="$(printf '%s\n' "$cell" | grep -o '[0-9][0-9]*' | sort -n | tail -n 1)"
      [ -n "$max" ] && [ "$max" -le "$cap" ] && ok || fail "skills/build/SKILL.md: '${cell# }' agents, over the cap of $cap"
    done
    expect "README rigor dial Agents row" "$(grep '^| Agents |' README.md)" "$row"
  fi

  # What a verdict covers is defined once.
  for file in skills/build/SKILL.md skills/prove/SKILL.md skills/vet/SKILL.md skills/ship/SKILL.md; do
    grep -q 'keel/verdicts.md' "$file" && ok || fail "$file: does not point at keel/verdicts.md for what a verdict covers"
  done
  grep -rq 'nothing after it' skills agents && fail "a skill voids a verdict on any later commit: point at keel/verdicts.md instead" || ok

  for file in install.sh get.sh scripts/check.sh hooks/guard.sh skills/vet/scripts/bar-guard.sh skills/keel/scripts/brief-check.sh; do
    [ -x "$file" ] && ok || fail "$file is not executable"
    bash -n "$file" 2>/dev/null && ok || fail "$file has a syntax error"
  done

  # What keel costs in every session before any skill is used.
  n=0
  for name in $skills; do
    grep -q '^disable-model-invocation: true' "skills/$name/SKILL.md" && continue
    n=$((n + $(field "skills/$name/SKILL.md" description | wc -c)))
  done
  printf 'info  always-on cost: rules %s words, model-invoked skill descriptions %s characters, %s skills, %s agents\n' \
    "$(wc -w <rules/keel.md | tr -d ' ')" "$n" "$(echo $skills | wc -w | tr -d ' ')" "$(echo $agents | wc -w | tr -d ' ')"
}

hook_decision() { # hook_decision <cwd> <command>
  jq -cn --arg c "$2" --arg d "$1" '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d}' |
    "$root/hooks/guard.sh" | jq -r '.hookSpecificOutput.permissionDecision // "none"' 2>/dev/null | grep . || echo none
}

hook() {
  local want where command got
  command -v jq >/dev/null 2>&1 || { fail "hook tests need jq"; return; }
  for where in feature main; do
    git init -q "$tmp/on-$where"
    git -C "$tmp/on-$where" symbolic-ref HEAD "refs/heads/$where"
  done

  while read -r want where command; do
    [ -n "$want" ] || continue
    case "$want" in \#*) continue ;; esac
    got="$(hook_decision "$tmp/on-$where" "$command")"
    expect "guard [$where] $command" "$got" "$want"
  done <<'ROWS'
none feature ls -la
none feature git status
none feature git push
none feature git push -u origin feature
none feature git push --follow-tags
ask  feature git push --force origin feature
ask  feature git push --force-with-lease
ask  feature git push -f
ask  feature GIT_TRACE=1 git push --force
deny feature git push --force origin main
deny feature git push -f origin master
deny feature git push origin +main
deny feature echo ok; git push -f origin main
ask  feature git push origin main
ask  feature git push origin HEAD:main
ask  feature git push origin --delete old-branch
ask  feature git push origin :old-branch
ask  feature git push --no-verify
ask  main    git push
deny main    git push --force
deny main    git push --force-with-lease
deny feature timeout 60 git push --force origin main
ask  feature nice -n 5 git push -f
ask  feature git push --mirror
none feature timeout 120 make test
none main    git status
ask  feature git reset --hard HEAD~1
ask  feature cd repo && git reset --hard
none feature git reset --soft HEAD~1
none feature git reset HEAD file.txt
ask  feature git clean -fd
ask  feature echo $(git clean -fdx)
none feature git clean -n
none feature git clean -nfd
ask  feature git checkout .
ask  feature git checkout -- .
ask  feature git checkout -f
none feature git checkout -b feature-x
none feature git checkout main
none feature git checkout -- src/a.py
ask  feature git restore .
none feature git restore --staged .
none feature git restore src/a.py
ask  feature git branch -D old
none feature git branch -d old
ask  feature git stash drop
ask  feature git stash clear
none feature git stash
none feature git stash pop
ask  feature git commit --no-verify -m "x"
ask  feature git commit -n -m "x"
ask  feature git -C sub commit -n -m "x"
ask  feature git -c core.hooksPath=/dev/null commit -m "x"
none feature git -c user.name=keel commit -m "x"
none feature git commit -m "docs: explain the --no-verify flag"
none feature git commit -m "note; git push --force origin main is denied"
none feature git commit -am "add notes"
none feature git add -A && git commit -m "feat: x" && git status
none feature git log --oneline -n 5
ask  feature gh pr merge 12 --squash
none feature gh pr create --fill
none feature gh pr view 12
ask  feature gh release create v1.0.0
ask  feature gh repo delete me/x --yes
ask  feature gh api -X PUT repos/me/x/branches/main/protection
ask  feature gh api --method DELETE repos/me/x/branches/main/protection
ask  feature gh api repos/me/x/rulesets -f name=open
none feature gh api repos/me/x/branches/main/protection
none feature gh api repos/me/x/rulesets
none feature gh api repos/me/x/pulls
ask  feature npm publish
none feature npm publish --dry-run
ask  feature pnpm -r publish
none feature npm run build
none feature npm run publish-docs
ask  feature cargo publish
ask  feature uv publish
ask  feature twine upload dist/*
ask  feature docker push me/app:1
none feature docker build -t app .
deny feature rm -rf /
deny feature rm -rf ~
deny feature rm -rf "$HOME"
deny feature sudo rm -rf /*
deny feature rm -fr ${HOME}/
ask  feature rm -rf .
ask  feature rm -rf .git
ask  feature rm -rf *
none feature rm -rf node_modules
none feature rm -rf ./build
none feature rm file.txt
none feature rm -f /tmp/x.log
none feature echo "rm -rf /"
none feature grep -rn "git push --force" docs/
ROWS

  # A commit message passed through a heredoc is text, not commands.
  command=$'git commit -m "$(cat <<\'EOF\'\nfix: guard\n\nThe body mentions rm -rf / and git push --force origin main.\nEOF\n)"'
  expect "guard heredoc commit message" "$(hook_decision "$tmp/on-feature" "$command")" none

  got="$(jq -cn --arg d "$tmp/on-feature" '{tool_input: {command: "gh pr merge 12 --admin --squash"}, cwd: $d}' |
    "$root/hooks/guard.sh" | jq -r .hookSpecificOutput.permissionDecisionReason)"
  case "$got" in *"--admin merges past"*) ok ;; *) fail "guard does not name --admin on a merge: $got" ;; esac

  got="$(KEEL_GUARD=off hook_decision "$tmp/on-feature" "git push --force origin main")"
  expect "guard switched off" "$got" none

  got="$(printf 'not json' | "$root/hooks/guard.sh"; echo "exit=$?")"
  expect "guard on malformed input" "$got" "exit=0"
}

bar() {
  local repo="$tmp/bar" ci="$tmp/ci" out status n
  local guard="$root/skills/vet/scripts/bar-guard.sh"
  unset GITHUB_ACTIONS
  mkdir -p "$repo/src" "$repo/tests"
  (
    cd "$repo" || exit 1
    git init -q
    git symbolic-ref HEAD refs/heads/main
    git config user.email keel@example.invalid
    git config user.name keel
    printf 'def compute():\n    return 1\n' >src/app.py
    printf 'def test_a():\n    assert compute() == 1\n    assert compute() != 2\n    assert compute() > 0\n' >tests/test_app.py
    printf 'def test_old():\n    assert True\n' >tests/test_old.py
    printf 'test:\n\tpytest\n' >Makefile
    printf '# Demo\n' >README.md
    printf 'export const a = 1;\n' >src/a.test.ts
    git add -A && git commit -qm "chore: start"
    git checkout -qb change

    printf 'def compute():\n    value = load()  # type: ignore\n    try:\n        risky()\n    except Exception:\n        pass\n    # TODO: finish this\n    raise NotImplementedError\n' >src/app.py
    printf 'import pytest\n\n@pytest.mark.skip\ndef test_a():\n    assert compute() == 1\n' >tests/test_app.py
    git rm -q tests/test_old.py
    printf 'test:\n\tpytest || true\n' >Makefile
    printf '# Demo\n\nTODO: write the docs. Use # noqa sparingly.\n' >README.md
    printf 'export const a = (1 as any);\nit.skip("later", () => {});\n' >src/a.test.ts
    printf 'model.fit(x)\nprofit(1)\n' >src/model.py
    git add -A && git commit -qm "feat: change"
    printf 'import os  # noqa\n' >src/untracked.py
    printf 'x = 1\ntry { run() } catch (e) {}\n' >src/staged.js
    git add src/staged.js
  ) >/dev/null 2>&1

  out="$(cd "$repo" && "$guard" main 2>&1)"; status=$?
  expect "bar-guard exit status with findings" "$status" 1

  n=$(grep -n 'type: ignore' "$repo/src/app.py" | cut -d: -f1)
  for want in \
    "SUPPRESSION   src/app.py:$n " \
    "EMPTY-HANDLER src/app.py:6  except Exception: pass" \
    "STUB          src/app.py:7 " \
    "STUB          src/app.py:8 " \
    "SKIPPED-TEST  tests/test_app.py:3 " \
    "ASSERTIONS    tests/test_app.py  2 assertion lines removed, 0 added" \
    "DELETED-TEST  tests/test_old.py" \
    "BYPASS        Makefile:2 " \
    "NOTE          Makefile " \
    "SUPPRESSION   src/a.test.ts:1 " \
    "SKIPPED-TEST  src/a.test.ts:2 " \
    "SUPPRESSION   src/untracked.py:1 " \
    "EMPTY-HANDLER src/staged.js:2 " \
    "12 findings, 1 note"; do
    case "$out" in *"$want"*) ok ;; *) fail "bar-guard output lacks: $want" ;; esac
  done
  for want in README.md model.py; do
    case "$out" in *"$want"*) fail "bar-guard flagged $want, which it should ignore" ;; *) ok ;; esac
  done
  case "$out" in *"::warning"*|*"::notice"*) fail "bar-guard printed annotations outside GitHub Actions" ;; *) ok ;; esac
  [ "$fails" = 0 ] || printf '%s\n' "$out" | sed 's/^/      /'

  (cd "$repo" && git stash -qu && git checkout -q main && git checkout -qb clean &&
    printf 'def compute():\n    return 2\n' >src/app.py && git commit -qam "fix: two") >/dev/null 2>&1
  out="$(cd "$repo" && "$guard" main 2>&1)"; status=$?
  expect "bar-guard exit status when clean" "$status" 0
  case "$out" in *"0 findings, 0 notes"*) ok ;; *) fail "bar-guard clean summary missing: $out" ;; esac

  # As a CI job: a fresh clone, detached at the merge of the change into main,
  # running the copy of the script that lives in the repository.
  git clone -q "$repo" "$ci" >/dev/null 2>&1
  (cd "$ci" && git config user.email keel@example.invalid && git config user.name keel &&
    git checkout -q --detach origin/main && git merge -q --no-ff -m "merge" origin/change &&
    mkdir -p scripts && cp "$guard" scripts/bar-guard.sh) >/dev/null 2>&1
  out="$(cd "$ci" && GITHUB_ACTIONS=true scripts/bar-guard.sh origin/main 2>&1)"; status=$?
  expect "bar-guard exit status as a CI job" "$status" 1
  n=$(grep -n 'type: ignore' "$ci/src/app.py" | cut -d: -f1)
  for want in \
    "10 findings, 1 note" \
    "::warning file=src/app.py,line=$n,title=bar-guard SUPPRESSION::" \
    "::warning file=tests/test_old.py,title=bar-guard DELETED-TEST::the whole test file was removed" \
    "::warning file=tests/test_app.py,title=bar-guard ASSERTIONS::2 assertion lines removed, 0 added" \
    "::notice file=Makefile,title=bar-guard NOTE::"; do
    case "$out" in *"$want"*) ok ;; *) fail "bar-guard as a CI job lacks: $want" ;; esac
  done
  [ "$(printf '%s\n' "$out" | grep -c '^::warning ')" = 10 ] && ok || fail "bar-guard as a CI job: wanted 10 warning annotations"
  case "$out" in *"scripts/bar-guard.sh"*) fail "bar-guard flagged its own copy in the repository" ;; *) ok ;; esac

  out="$(cd "$repo" && "$guard" no-such-ref 2>&1)"; status=$?
  expect "bar-guard exit status on unknown base" "$status" 2
  mkdir -p "$tmp/not-a-repo"
  out="$(cd "$tmp/not-a-repo" && "$guard" 2>&1)"; status=$?
  expect "bar-guard exit status outside a repository" "$status" 2
}

brief() {
  local checker="$root/skills/keel/scripts/brief-check.sh" dir="$tmp/docs/briefs" out status want
  mkdir -p "$dir" "$tmp/notes"
  cat >"$dir/good.md" <<'EOF'
# A heading is never checked, so this one can be far longer than twenty words and still pass the brief check

**State:** waiting for your approval. Read this page first.

One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.

One. Two. Three. Four. Five. Six.

| Word | Meaning |
|---|---|
| Ticket | A message from one thread to the other. |

```
a code block can hold a long line; it can say ensure, and the checker reads none of it, so it passes
```

- A list item with `code; spans` counts each span as one word, so `a b c d e f g h i j k l m n o p q r s t u` is one.
- Trivia and viable plans are fine words.
EOF
  cat >"$dir/bad.md" <<'EOF'
# Bad

One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone.

One. Two. Three. Four. Five. Six. Seven.

The agent ensures it works; it does.

| Word | One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone. |

- A list item can also go via a word the checker refuses.
EOF
  cp "$dir/bad.md" "$tmp/notes/bad.md"

  out="$("$checker" "$dir/good.md" 2>&1)"; status=$?
  expect "brief-check exit status on a clean brief" "$status" 0
  expect "brief-check output on a clean brief" "$out" ""

  out="$("$checker" "$dir/good.md" "$dir/bad.md" 2>&1)"; status=$?
  expect "brief-check exit status with findings" "$status" 1
  for want in \
    "bad.md:3: sentence of 21 words, max 20: \"One two three four five six seven eight ...\"" \
    "bad.md:5: paragraph of 7 sentences, max 6" \
    "bad.md:7: semicolon: write two sentences" \
    "bad.md:7: \"ensure\": write \"make sure\"" \
    "bad.md:9: sentence of 21 words, max 20" \
    "bad.md:11: \"via\": write \"through\""; do
    case "$out" in *"$want"*) ok ;; *) fail "brief-check output lacks: $want" ;; esac
  done
  expect "brief-check finding count" "$(printf '%s\n' "$out" | grep -c 'bad.md:')" 6
  case "$out" in *good.md*) fail "brief-check flagged the clean brief: $out" ;; *) ok ;; esac

  "$checker" "$dir/missing.md" >/dev/null 2>&1; status=$?
  expect "brief-check exit status on a missing file" "$status" 2
  "$checker" >/dev/null 2>&1; status=$?
  expect "brief-check exit status with no file" "$status" 2

  command -v jq >/dev/null 2>&1 || { fail "brief hook tests need jq"; return; }
  hook_run() { # hook_run <file>: prints stderr, then exit=<status>
    jq -cn --arg f "$1" '{tool_name: "Write", tool_input: {file_path: $f}}' | "$checker" --hook 2>&1 >/dev/null
    echo "exit=$?"
  }
  out="$(hook_run "$dir/bad.md")"
  case "$out" in *"bad.md:3: sentence of 21 words"*"Rewrite these lines"*"exit=2") ok ;; *) fail "brief hook on a bad brief: $out" ;; esac
  expect "brief hook on a clean brief" "$(hook_run "$dir/good.md")" "exit=0"
  expect "brief hook outside a briefs directory" "$(hook_run "$tmp/notes/bad.md")" "exit=0"
  expect "brief hook on malformed input" "$(printf 'not json' | "$checker" --hook 2>&1; echo "exit=$?")" "exit=0"
}

has_node() { # Node 22 or newer, and npm
  command -v npm >/dev/null 2>&1 || return 1
  [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] 2>/dev/null
}

# A PATH with no node on it. A folder that holds node is left out, so a folder of
# links keeps the other commands the installer needs, in case they lived beside it.
path_without_node() {
  local d keep="" shim="$tmp/no-node" t
  mkdir -p "$shim"
  while IFS= read -r d; do
    [ -n "$d" ] && [ ! -x "$d/node" ] && keep="$keep:$d"
  done < <(printf '%s\n' "$PATH" | tr ':' '\n')
  for t in bash jq ln mkdir rm readlink cat cp cmp diff sed mktemp dirname basename tail head tr; do
    PATH="${keep#:}" command -v "$t" >/dev/null 2>&1 || ln -sf "$(command -v "$t")" "$shim/$t"
  done
  printf '%s%s' "$shim" "$keep"
}

install_check() {
  local config="$tmp/config" bin="$tmp/bin" fake="$tmp/fake-npm" calls="$tmp/npm-calls" before name cmd got first
  local board_guard board_matcher mine weird proj legacy
  command -v jq >/dev/null 2>&1 || { fail "install tests need jq"; return; }
  board_guard="node $(jq -rn --arg p "$root/workspace/plugin/hooks/guard-board.mjs" '$p | @sh')"
  board_matcher="$(jq -r '.hooks.PreToolUse[0].matcher' "$root/workspace/plugin/hooks/hooks.json")"

  # A stand-in npm notes where it ran and what it was asked, so no check here builds the
  # board for real. Every run gets its own config directory and bin folder.
  mkdir -p "$fake"
  printf '#!/bin/sh\nprintf "%%s %%s\\n" "$PWD" "$*" >>"%s"\n' "$calls" >"$fake/npm"
  chmod +x "$fake/npm"
  : >"$calls"
  inst() { CLAUDE_CONFIG_DIR="$config" KEEL_BIN_DIR="$bin" PATH="$fake:$PATH" "$root/install.sh" "$@"; }

  mkdir -p "$config/skills/tdd" "$bin"
  printf 'mine\n' >"$config/skills/tdd/SKILL.md"
  printf 'mine\n' >"$bin/other"
  ln -s "$root/skills/build" "$config/skills/my-build"
  printf '{"model":"x","hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo hi"}]}]}}\n' >"$config/settings.json"
  before="$(jq -S . "$config/settings.json")"

  got="$(inst --dry-run 2>&1)"
  [ ! -e "$config/skills/keel" ] && ok || fail "install --dry-run created files"
  expect "install --dry-run leaves settings alone" "$(jq -S . "$config/settings.json")" "$before"
  if has_node; then
    expect "install --dry-run links no keel-board" "$(ls "$bin")" other
    expect "install --dry-run runs no npm" "$(cat "$calls")" ""
    case "$got" in *"would build the board"*) ok ;; *) fail "install --dry-run does not say it would build the board" ;; esac
  fi

  first="$(inst 2>&1)"
  case "$first" in *"SKIPPED   $config/skills/tdd"*) ok ;; *) fail "install did not report the conflicting skills/tdd" ;; esac
  expect "install leaves a foreign skill alone" "$(cat "$config/skills/tdd/SKILL.md")" mine
  for name in keel build vet; do
    [ "$(readlink "$config/skills/$name")" = "$root/skills/$name" ] && ok || fail "skills/$name is not linked"
  done
  [ -f "$config/skills/vet/scripts/bar-guard.sh" ] && ok || fail "bar-guard.sh is not reachable through the link"
  [ -f "$config/skills/grill/../keel/adr.md" ] && ok || fail "shared references are not reachable from a sibling skill"
  [ "$(readlink "$config/agents/verifier.md")" = "$root/agents/verifier.md" ] && ok || fail "agents/verifier.md is not linked"
  [ "$(readlink "$config/rules/keel.md")" = "$root/rules/keel.md" ] && ok || fail "rules/keel.md is not linked"
  expect "install keeps other settings" "$(jq -r .model "$config/settings.json")" x
  expect "install keeps other hooks" "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$config/settings.json")" "echo hi"
  expect "install registers one guard hook" "$(jq '[.hooks.PreToolUse[] | select(.matcher == "Bash")] | length' "$config/settings.json")" 1
  [ -f "$config/settings.json.keel-backup" ] && ok || fail "install left no settings backup"

  cmd="$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[0].command' "$config/settings.json")"
  got="$(jq -cn '{tool_input: {command: "rm -rf /"}}' | sh -c "$cmd" | jq -r .hookSpecificOutput.permissionDecision)"
  expect "the registered hook command runs" "$got" deny

  expect "install registers one brief hook" "$(jq '[.hooks.PostToolUse[] | select(.matcher == "Edit|Write")] | length' "$config/settings.json")" 1
  mkdir -p "$tmp/install/briefs"
  printf 'The agent will ensure it.\n' >"$tmp/install/briefs/x.md"
  cmd="$(jq -r '.hooks.PostToolUse[] | select(.matcher == "Edit|Write") | .hooks[0].command' "$config/settings.json")"
  got="$(jq -cn --arg f "$tmp/install/briefs/x.md" '{tool_input: {file_path: $f}}' | sh -c "$cmd" 2>&1; echo "exit=$?")"
  case "$got" in *'"ensure": write "make sure"'*"exit=2") ok ;; *) fail "the registered brief hook command does not report: $got" ;; esac

  if has_node; then
    expect "install builds the board with npm in workspace/" "$(cat "$calls")" \
      "$root/workspace install --no-audit --no-fund
$root/workspace run build"
    expect "install links keel-board" "$(readlink "$bin/keel-board")" "$root/workspace/server/bin/keel-board.mjs"
    case "$first" in *"$bin is not on your PATH"*) ok ;; *) fail "install does not say that the bin folder is off PATH" ;; esac
    expect "install registers one board guard" "$(jq --arg c "$board_guard" '[.hooks.PreToolUse[] | select(any(.hooks[]; .command == $c))] | length' "$config/settings.json")" 1
    expect "the board guard watches the tools hooks.json names" \
      "$(jq -r --arg c "$board_guard" '.hooks.PreToolUse[] | select(any(.hooks[]; .command == $c)) | .matcher' "$config/settings.json")" "$board_matcher"

    mkdir -p "$tmp/install/repo/.keel/board"
    cmd="$(jq -r --arg c "$board_guard" '.hooks.PreToolUse[] | .hooks[] | select(.command == $c) | .command' "$config/settings.json")"
    got="$(jq -cn --arg f "$tmp/install/repo/.keel/board/log.jsonl" --arg d "$tmp/install/repo" '{tool_name: "Write", tool_input: {file_path: $f}, cwd: $d}' |
      sh -c "$cmd" | jq -r .hookSpecificOutput.permissionDecision)"
    expect "the registered board guard denies a write into .keel/board" "$got" deny
    got="$(jq -cn --arg f "$tmp/install/repo/notes.md" --arg d "$tmp/install/repo" '{tool_name: "Write", tool_input: {file_path: $f}, cwd: $d}' | sh -c "$cmd"; echo "exit=$?")"
    expect "the registered board guard lets another write go" "$got" "exit=0"

    if [ -d "$root/workspace/node_modules" ]; then
      got="$(node "$bin/keel-board" --help 2>&1)"
      case "$got" in *"keel-board open"*) ok ;; *) fail "keel-board --help through the link: $got" ;; esac
    fi
  else
    printf 'info  no Node 22 here: the installed board is not checked\n'
  fi

  got="$(jq -S . "$config/settings.json")"
  : >"$calls"
  first="$(inst 2>&1)"
  expect "install twice changes nothing" "$(jq -S . "$config/settings.json")" "$got"
  case "$first" in *"  linked "*|*"  relinked "*|*"  updated "*) fail "install twice changed something: $first" ;; *) ok ;; esac

  : >"$calls"
  inst --uninstall >/dev/null 2>&1
  [ ! -e "$config/skills/keel" ] && [ ! -e "$config/agents/verifier.md" ] && [ ! -e "$config/rules/keel.md" ] && [ ! -e "$config/hooks/keel-guard.sh" ] && [ ! -e "$config/hooks/keel-brief-check.sh" ] && ok || fail "uninstall left links behind"
  expect "uninstall leaves a foreign skill alone" "$(cat "$config/skills/tdd/SKILL.md")" mine
  expect "uninstall restores settings" "$(jq -S . "$config/settings.json")" "$before"
  expect "uninstall leaves only the foreign file in the bin folder" "$(ls -A "$bin")" other
  expect "uninstall runs no npm" "$(cat "$calls")" ""
  expect "uninstall keeps the user's own link into keel" "$(readlink "$config/skills/my-build")" "$root/skills/build"

  # A hook of the user's own, put into keel's matcher group, survives install, refresh and uninstall.
  config="$tmp/config-mine" bin="$tmp/bin-mine"
  mine='{"type":"command","command":"echo mine"}'
  inst >/dev/null 2>&1
  cmd="$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[0].command' "$config/settings.json")"
  jq --argjson m "$mine" --arg c "$cmd" '(.hooks.PreToolUse[] | select(any(.hooks[]; .command == $c)) | .hooks) += [$m]' \
    "$config/settings.json" >"$tmp/mine.json" && cat "$tmp/mine.json" >"$config/settings.json"
  inst >/dev/null 2>&1
  expect "refresh keeps the user's hook in keel's group" "$(jq --arg c "$cmd" '[.hooks.PreToolUse[] | select(any(.hooks[]; .command == $c)) | .hooks[] | select(.command == "echo mine")] | length' "$config/settings.json")" 1
  expect "refresh keeps one guard hook" "$(jq --arg c "$cmd" '[.. | .command? | select(. == $c)] | length' "$config/settings.json")" 1
  inst --uninstall >/dev/null 2>&1
  expect "uninstall keeps the user's hook from keel's group" "$(jq -c . "$config/settings.json")" \
    '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}'

  # An install by an earlier installer, which wrote each path in double quotes, is
  # recognised: a refresh replaces it, and uninstall removes it.
  config="$tmp/config-legacy" bin="$tmp/bin-legacy"
  mkdir -p "$config"
  legacy="$(jq -n --arg c "$config" --arg b "$root/workspace/plugin/hooks/guard-board.mjs" --arg m "$board_matcher" --argjson node "$(has_node && echo true || echo false)" '
    {hooks: ({PreToolUse: [{matcher: "Bash", hooks: [{type: "command", command: "\"\($c)/hooks/keel-guard.sh\""}, {type: "command", command: "echo mine"}]}],
             PostToolUse: [{matcher: "Edit|Write", hooks: [{type: "command", command: "\"\($c)/hooks/keel-brief-check.sh\" --hook"}]}]}
      | if $node then .PreToolUse += [{matcher: $m, hooks: [{type: "command", command: "node \"\($b)\"", timeout: 10}]}] else . end)}')"
  printf '%s\n' "$legacy" >"$config/settings.json"
  inst >/dev/null 2>&1
  expect "refresh leaves no double-quoted keel command" "$(jq '[.. | .command? | strings | select(startswith("\"") or contains(" \""))] | length' "$config/settings.json")" 0
  expect "refresh writes each keel hook once" "$(jq '[.. | .command? | strings | select(contains("keel-guard.sh") or contains("keel-brief-check.sh") or contains("guard-board.mjs"))] | length' "$config/settings.json")" "$(has_node && echo 3 || echo 2)"
  expect "refresh keeps the user's hook beside an old keel hook" "$(jq '[.. | .command? | select(. == "echo mine")] | length' "$config/settings.json")" 1
  inst --uninstall >/dev/null 2>&1
  expect "uninstall after an old install keeps only the user's hook" "$(jq -c . "$config/settings.json")" \
    '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}'

  # A config path with a space, quotes, `$(...)` and a backtick installs, runs its
  # hooks' commands as plain words, and uninstalls clean.
  weird="$tmp/cfg \"q\" it's \$(touch pwned) \`touch pwned\`"
  config="$weird" bin="$tmp/bin-weird" proj="$tmp/proj"
  mkdir -p "$proj/.keel/board" "$proj/briefs"
  printf 'The agent will ensure it.\n' >"$proj/briefs/x.md"
  got="$(cd "$proj" && inst 2>&1; echo "exit=$?")"
  case "$got" in *"exit=0") ok ;; *) fail "install into an odd config path: $got" ;; esac
  cmd="$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[0].command' "$config/settings.json")"
  got="$(cd "$proj" && jq -cn '{tool_input: {command: "rm -rf /"}}' | sh -c "$cmd" 2>&1 | jq -r .hookSpecificOutput.permissionDecision 2>&1)"
  expect "the guard hook runs from an odd config path" "$got" deny
  cmd="$(jq -r '.hooks.PostToolUse[] | select(.matcher == "Edit|Write") | .hooks[0].command' "$config/settings.json")"
  got="$(cd "$proj" && jq -cn --arg f "$proj/briefs/x.md" '{tool_input: {file_path: $f}}' | sh -c "$cmd" 2>&1; echo "exit=$?")"
  case "$got" in *'"ensure": write "make sure"'*"exit=2") ok ;; *) fail "the brief hook from an odd config path: $got" ;; esac
  if has_node; then
    got="$(cd "$proj" && jq -cn --arg f "$proj/.keel/board/log.jsonl" --arg d "$proj" '{tool_name: "Write", tool_input: {file_path: $f}, cwd: $d}' |
      sh -c "$board_guard" | jq -r .hookSpecificOutput.permissionDecision)"
    expect "the board guard runs as registered" "$got" deny
  fi
  inst --uninstall >/dev/null 2>&1
  expect "uninstall from an odd config path leaves no hooks" "$(jq -c . "$config/settings.json")" '{}'
  expect "uninstall from an odd config path leaves no links" "$(find "$config" "$bin" -type l | wc -l | tr -d ' ')" 0
  expect "no command in a path ran" "$(find "$tmp" -name pwned | wc -l | tr -d ' ')" 0

  # Without Node: the board is skipped and said so, and the rest is installed.
  config="$tmp/config-no-node" bin="$tmp/bin-no-node"
  : >"$calls"
  got="$(CLAUDE_CONFIG_DIR="$config" KEEL_BIN_DIR="$bin" PATH="$fake:$(path_without_node)" "$root/install.sh" 2>&1; echo "exit=$?")"
  case "$got" in *"SKIPPED   the board: Node is not installed. Install Node 22"*"exit=0") ok ;; *) fail "install without Node: $got" ;; esac
  [ "$(readlink "$config/skills/keel")" = "$root/skills/keel" ] && ok || fail "install without Node did not link the skills"
  [ ! -e "$bin/keel-board" ] && ok || fail "install without Node linked keel-board"
  expect "install without Node registers no board guard" "$(jq '[.. | .command? | strings | select(contains("guard-board"))] | length' "$config/settings.json")" 0
  expect "install without Node registers the guard hook" "$(jq '[.hooks.PreToolUse[] | select(.matcher == "Bash")] | length' "$config/settings.json")" 1
  expect "install without Node runs no npm" "$(cat "$calls")" ""

  # With a Node older than 22: the same.
  mkdir -p "$tmp/old-node"
  printf '#!/bin/sh\ncase "$1" in -p) echo 20 ;; *) echo v20.11.0 ;; esac\n' >"$tmp/old-node/node"
  chmod +x "$tmp/old-node/node"
  config="$tmp/config-old-node" bin="$tmp/bin-old-node"
  got="$(CLAUDE_CONFIG_DIR="$config" KEEL_BIN_DIR="$bin" PATH="$tmp/old-node:$fake:$PATH" "$root/install.sh" 2>&1)"
  case "$got" in *"SKIPPED   the board: Node v20.11.0 is older than 22"*) ok ;; *) fail "install with Node 20: $got" ;; esac
  [ ! -e "$bin/keel-board" ] && ok || fail "install with Node 20 linked keel-board"

  # A keel folder that was moved leaves dead links, and a board guard hook that names a
  # script that is gone. Uninstall from the new place removes them, and nothing else.
  moved() { # what an install from /gone/keel left behind, in $config and $bin
    local d gone=/gone/keel
    mkdir -p "$config/skills" "$config/agents" "$config/rules" "$config/hooks" "$bin"
    for d in "$root"/skills/*/; do d="${d%/}"; ln -s "$gone/skills/$(basename "$d")" "$config/skills/$(basename "$d")"; done
    for d in "$root"/agents/*.md; do ln -s "$gone/agents/$(basename "$d")" "$config/agents/$(basename "$d")"; done
    ln -s "$gone/rules/keel.md" "$config/rules/keel.md"
    ln -s "$gone/workspace/server/bin/keel-board.mjs" "$bin/keel-board"
    # The user's own: a dead link to something else, a live link, and a hook.
    ln -s /gone/elsewhere/notes "$config/skills/my-notes"
    ln -s "$root/skills/build" "$config/skills/my-build"
    jq -n --arg dead "node '$gone/workspace/plugin/hooks/guard-board.mjs'" \
      '{hooks: {PreToolUse: [{matcher: "Write", hooks: [{type: "command", command: "echo mine"}]}, {matcher: "Write|Edit", hooks: [{type: "command", command: $dead, timeout: 10}]}]}}' >"$config/settings.json"
  }
  config="$tmp/config-moved" bin="$tmp/bin-moved"
  moved
  inst --uninstall >/dev/null 2>&1
  expect "uninstall after a move leaves no dead keel link" "$(find "$config" "$bin" -type l | sort | sed "s|^$tmp/||" | tr '\n' ' ')" "config-moved/skills/my-build config-moved/skills/my-notes "
  expect "uninstall after a move removes the dead board guard, and keeps the user's hook" "$(jq -c . "$config/settings.json")" \
    '{"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo mine"}]}]}}'

  # Install from the new place takes the dead links over, and replaces the dead hook.
  config="$tmp/config-moved-in" bin="$tmp/bin-moved-in"
  moved
  got="$(inst 2>&1)"
  case "$got" in *SKIPPED*) fail "install after a move skipped something: $got" ;; *) ok ;; esac
  expect "install after a move relinks a skill" "$(readlink "$config/skills/build")" "$root/skills/build"
  expect "install after a move relinks the rules" "$(readlink "$config/rules/keel.md")" "$root/rules/keel.md"
  expect "install after a move leaves no dead keel link" "$(find "$config" "$bin" -type l ! -exec test -e {} \; -print | sed "s|^$tmp/||" | tr '\n' ' ')" "config-moved-in/skills/my-notes "
  expect "install after a move leaves no hook that names a script that is gone" "$(jq '[.. | .command? | strings | select(contains("/gone/"))] | length' "$config/settings.json")" 0
  expect "install after a move keeps the user's hook" "$(jq '[.. | .command? | select(. == "echo mine")] | length' "$config/settings.json")" 1
  if has_node; then
    expect "install after a move relinks keel-board" "$(readlink "$bin/keel-board")" "$root/workspace/server/bin/keel-board.mjs"
    expect "install after a move registers one board guard" "$(jq '[.. | .command? | strings | select(contains("guard-board.mjs"))] | length' "$config/settings.json")" 1
  fi
  # A board guard whose script is still there belongs to another keel folder: it stays.
  config="$tmp/config-other" bin="$tmp/bin-other"
  mkdir -p "$config" "$tmp/other-keel/workspace/plugin/hooks"
  : >"$tmp/other-keel/workspace/plugin/hooks/guard-board.mjs"
  jq -n --arg live "node '$tmp/other-keel/workspace/plugin/hooks/guard-board.mjs'" '{hooks: {PreToolUse: [{matcher: "Write", hooks: [{type: "command", command: $live}]}]}}' >"$config/settings.json"
  inst --uninstall >/dev/null 2>&1
  expect "uninstall leaves another keel folder's board guard" "$(jq '[.. | .command? | strings | select(contains("other-keel"))] | length' "$config/settings.json")" 1

  # --no-board: no build, no link, no board guard.
  config="$tmp/config-no-board" bin="$tmp/bin-no-board"
  : >"$calls"
  got="$(inst --no-board 2>&1)"
  expect "install --no-board runs no npm" "$(cat "$calls")" ""
  [ ! -e "$bin/keel-board" ] && ok || fail "install --no-board linked keel-board"
  expect "install --no-board registers no board guard" "$(jq '[.. | .command? | strings | select(contains("guard-board"))] | length' "$config/settings.json")" 0
  case "$got" in *"Done. Start a new Claude Code session"*) ok ;; *) fail "install --no-board counted the board as skipped: $got" ;; esac
}

# A stand-in node: answers --version with $2, and otherwise notes which node ran,
# the PATH it saw, and each argument, in $GET_LAUNCH.
fake_node() { # fake_node <path> <version>
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\nif [ "$1" = --version ]; then echo v%s; exit 0; fi\n{ echo "node $0"; echo "PATH=$PATH"; for a in "$@"; do echo "arg [$a]"; done; } >>"$GET_LAUNCH"\n' "$2" >"$1"
  chmod +x "$1"
}

# get.sh against a throwaway home, install folder and bin folder. Stand-ins for
# uname, curl, xcode-select, node, npm and Claude's installer note how they were
# called, and curl serves files from a folder, so nothing here uses the network.
get_check() {
  local g="$tmp/get" fake shim calls launch t name sum h inst bin extra serve xcode got out n sys_os sys_arch shell_
  fake="$g/fake" shim="$g/shim" calls="$g/calls" launch="$g/launch"
  mkdir -p "$fake" "$shim" "$g/goodnode" "$g/hasclaude" "$g/serve-ok" "$g/serve-bad" "$g/serve-noclaude" "$g/linux"

  # The PATH of a bare machine: only the tools get.sh runs, so no node, git or claude.
  for t in bash sh tar gzip sed grep head tail cut mkdir rm mv chmod cat dirname basename mktemp id tr readlink rmdir env sleep ls shasum sha256sum; do
    command -v "$t" >/dev/null 2>&1 && ln -sf "$(command -v "$t")" "$shim/$t"
  done

  cat >"$fake/uname" <<'EOF'
#!/bin/sh
case "$1" in -m) echo "${FAKE_ARCH:-arm64}" ;; *) echo "${FAKE_OS:-Darwin}" ;; esac
EOF
  cat >"$fake/curl" <<'EOF'
#!/bin/sh
url="" out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "curl $url" >>"$GET_CALLS"
f="$GET_SERVE/${url##*/}"
[ -f "$f" ] || { echo "curl: (22) not served: $url" >&2; exit 22; }
if [ -n "$out" ]; then cat "$f" >"$out"; else cat "$f"; fi
EOF
  cat >"$fake/xcode-select" <<'EOF'
#!/bin/sh
case "$1" in
  -p) [ -f "$GET_XCODE" ] && echo /Library/Developer/CommandLineTools ;;
  --install) echo "xcode-select --install" >>"$GET_CALLS"; : >"$GET_XCODE" ;;
esac
EOF
  cat >"$g/npm" <<'EOF'
#!/bin/sh
prefix="" prev=""
for a in "$@"; do [ "$prev" = --prefix ] && prefix="$a"; prev="$a"; done
echo "npm $0 PATH=${PATH%%:*} $*" >>"$GET_CALLS"
d="$prefix/lib/node_modules/keel-workspace"
mkdir -p "$d/server/bin"
printf '{\n  "name": "keel-workspace",\n  "version": "%s"\n}\n' "${FAKE_PKG_VERSION:-0.1.0}" >"$d/package.json"
: >"$d/server/bin/keel-board.mjs"
EOF
  cat >"$g/serve-ok/install.sh" <<'EOF'
echo "claude installer" >>"$GET_CALLS"
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\n' >"$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
EOF
  printf 'echo "claude installer" >>"$GET_CALLS"\necho "error: boom, no route to host"\nexit 1\n' >"$g/serve-noclaude/install.sh"
  printf '#!/bin/sh\n' >"$g/hasclaude/claude"
  chmod +x "$fake"/* "$g/npm" "$g/hasclaude/claude"
  fake_node "$g/goodnode/node" 24.1.0
  cp "$g/npm" "$g/goodnode/npm"
  fake_node "$g/oldnode/node" 20.11.0
  cp "$g/npm" "$g/oldnode/npm"

  # A Node tarball as nodejs.org lays it out, with its sum, and the same tarball with a wrong sum.
  name="node-v24.1.0-darwin-arm64"
  fake_node "$g/build/$name/bin/node" 24.1.0
  cp "$g/npm" "$g/build/$name/bin/npm"
  tar -czf "$g/serve-ok/$name.tar.gz" -C "$g/build" "$name"
  sum="$( (shasum -a 256 "$g/serve-ok/$name.tar.gz" 2>/dev/null || sha256sum "$g/serve-ok/$name.tar.gz") | cut -d ' ' -f 1)"
  printf '%s  node-v24.1.0-linux-x64.tar.gz\n%s  %s.tar.gz\n%s  %s.tar.xz\n' "$(printf '1%.0s' $(seq 64))" "$sum" "$name" "$(printf '2%.0s' $(seq 64))" "$name" >"$g/serve-ok/SHASUMS256.txt"
  cp "$g/serve-ok/$name.tar.gz" "$g/serve-ok/install.sh" "$g/serve-bad/"
  printf '%s  %s.tar.gz\n' "$(printf '0%.0s' $(seq 64))" "$name" >"$g/serve-bad/SHASUMS256.txt"
  cp "$g/serve-ok/$name.tar.gz" "$g/serve-ok/SHASUMS256.txt" "$g/serve-noclaude/"

  # Each case sets h, inst, bin, extra (PATH folders before the bare ones), serve and
  # xcode (a file that exists when Apple's developer tools are there), then calls run_get.
  run_get() {
    : >"$calls"
    env -i HOME="$h" KEEL_INSTALL_DIR="$inst" KEEL_BIN_DIR="$bin" PATH="$fake:$extra$shim" SHELL="${shell_:-/bin/zsh}" \
      GET_CALLS="$calls" GET_SERVE="$serve" GET_XCODE="$xcode" GET_LAUNCH="$launch" FAKE_OS="${sys_os:-Darwin}" FAKE_ARCH="${sys_arch:-arm64}" \
      bash "$root/get.sh" "$@" 2>&1
    echo "exit=$?"
  }
  : >"$g/xcode-ready"
  xcode="$g/xcode-ready" serve="$g/serve-ok" sys_os="" sys_arch="" shell_=""

  # A good Node and Claude Code on PATH: no Node is downloaded and Claude's installer does not run.
  h="$g/h1" inst="$g/h1/share/keel" bin="$g/h1/bin" extra="$g/goodnode:$g/hasclaude:"
  mkdir -p "$h"
  out="$(run_get)"
  case "$out" in *"found      Node v24.1.0 at $g/goodnode/node"*"exit=0") ok ;; *) fail "get.sh with a good Node: $out" ;; esac
  [ ! -e "$inst/node" ] && ok || fail "get.sh with a good Node installed a Node"
  expect "get.sh with a good Node and Claude Code downloads nothing" "$(grep -c '^curl' "$calls")" 0
  expect "get.sh installs the board with npm into its prefix" "$(grep '^npm' "$calls")" \
    "npm $g/goodnode/npm PATH=$g/goodnode install --global --prefix $inst/pkg --no-audit --no-fund keel-workspace@latest"
  head -n 2 "$bin/keel-board" | grep -q "keel-board launcher, written by keel's get.sh" && ok || fail "the launcher lacks get.sh's marker"
  [ -x "$bin/keel-board" ] && [ ! -L "$bin/keel-board" ] && ok || fail "the launcher is not an executable file"
  : >"$launch"
  env -i HOME="$h" PATH="$g/goodnode:$shim" GET_LAUNCH="$launch" "$bin/keel-board" --help
  expect "the launcher without a managed Node runs the node on PATH" "$(head -n 1 "$launch")" "node $g/goodnode/node"

  # No Node, no Claude Code, and an install folder with a space: Node is downloaded and
  # checked, Claude's installer runs, and the launcher puts that Node first.
  h="$g/h2" inst="$g/h2/my share/keel" bin="$g/h2/.local/bin" extra=""
  mkdir -p "$h"
  out="$(run_get)"
  case "$out" in *"installed  Node v24.1.0 in $inst/node"*"installed  Claude Code"*"exit=0") ok ;; *) fail "get.sh on a bare machine: $out" ;; esac
  [ -x "$inst/node/bin/node" ] && [ ! -e "$inst/node.new" ] && ok || fail "get.sh did not unpack Node into $inst/node"
  expect "get.sh fetches the sums, then the tarball, then Claude's installer" "$(grep '^curl' "$calls")" \
    "curl https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
curl https://nodejs.org/dist/latest-v24.x/$name.tar.gz
curl https://claude.ai/install.sh"
  grep -q '^claude installer$' "$calls" && ok || fail "get.sh did not run Claude's installer"
  case "$(grep '^npm' "$calls")" in "npm $inst/node/bin/npm PATH=$inst/node/bin install "*) ok ;; *) fail "get.sh runs the downloaded npm with its Node first: $(cat "$calls")" ;; esac
  : >"$launch"
  env -i HOME="$h" PATH="$g/goodnode:$shim" GET_LAUNCH="$launch" "$bin/keel-board" open "two words" "it's" >/dev/null 2>&1
  expect "the launcher runs the managed Node, the package's launcher and every argument" "$(grep -v '^PATH=' "$launch")" \
    "node $inst/node/bin/node
arg [$inst/pkg/lib/node_modules/keel-workspace/server/bin/keel-board.mjs]
arg [open]
arg [two words]
arg [it's]"
  case "$(grep '^PATH=' "$launch")" in "PATH=$inst/node/bin:$g/goodnode:$shim:$h/.local/bin") ok ;; *) fail "the launcher's PATH: $(cat "$launch")" ;; esac
  case "$out" in *"(in a new terminal)  mkdir my-idea && cd my-idea && keel-board"*"sign in to Claude"*) ok ;; *) fail "get.sh's last lines: $out" ;; esac

  # A second run changes nothing, says so, adds no second PATH line, and updates the board.
  out="$(FAKE_PKG_VERSION=0.2.0 run_get)"
  case "$out" in *"installed "*|*"written "*|*"added "*|*fetching*) fail "get.sh run twice changed something: $out" ;; *"exit=0") ok ;; *) fail "get.sh run twice: $out" ;; esac
  case "$out" in *"found      Node v24.1.0 in $inst/node"*"found      Claude Code"*"found      $bin/keel-board"*"found      $bin on PATH in $h/.zshrc"*) ok ;; *) fail "get.sh run twice does not say each thing is there: $out" ;; esac
  expect "get.sh run twice downloads nothing" "$(grep -c '^curl' "$calls")" 0
  expect "get.sh run twice runs npm install again" "$(grep -c '^npm' "$calls")" 1
  expect "get.sh adds one PATH line across two runs" "$(grep -c "keel's get.sh" "$h/.zshrc")" 1
  expect "the PATH line puts the bin folder on PATH" "$(env -i HOME="$h" PATH=/x /bin/sh -c ". '$h/.zshrc'; echo \"\$PATH\"")" "$bin:/x"

  # With a managed Node already there, a Node older than 22 on PATH is passed over.
  extra="$g/oldnode:"
  out="$(run_get)"
  case "$out" in *"found      Node v24.1.0 in $inst/node"*"exit=0") ok ;; *) fail "get.sh with Node 20 and a managed Node: $out" ;; esac

  # Uninstall takes out exactly what get.sh made.
  mkdir -p "$h/.keel/boards/x"
  printf 'mine\n' >"$bin/other"
  printf 'alias ll=ls\n' >>"$h/.zshrc"
  extra=""
  out="$(run_get --uninstall)"
  case "$out" in *"exit=0") ok ;; *) fail "get.sh --uninstall: $out" ;; esac
  [ ! -e "$inst" ] && [ ! -e "$bin/keel-board" ] && ok || fail "get.sh --uninstall left $(ls -A "$inst" "$bin" 2>&1)"
  [ -d "$h/my share" ] && ok || fail "get.sh --uninstall removed the install folder's parent"
  expect "get.sh --uninstall leaves the foreign file and Claude Code" "$(ls -A "$bin")" "claude
other"
  [ -d "$h/.keel/boards/x" ] && [ -x "$h/.local/bin/claude" ] && ok || fail "get.sh --uninstall removed the boards or Claude Code"
  expect "get.sh --uninstall takes out only its PATH line" "$(cat "$h/.zshrc")" "alias ll=ls"

  # The download does not match its sum: a hard stop that leaves no Node folder.
  h="$g/h3" inst="$g/h3/keel" bin="$g/h3/bin" serve="$g/serve-bad"
  mkdir -p "$h"
  out="$(run_get)"
  case "$out" in *"does not match its checksum"*"exit=1") ok ;; *) fail "get.sh with a bad checksum: $out" ;; esac
  [ ! -e "$inst/node" ] && [ ! -e "$inst/node.new" ] && ok || fail "get.sh with a bad checksum left a Node folder"
  expect "get.sh with a bad checksum runs no npm" "$(grep -c '^npm' "$calls")" 0

  # Claude's installer fails: get.sh says so and goes on.
  h="$g/h4" inst="$g/h4/keel" bin="$g/h4/bin" serve="$g/serve-noclaude" extra="$g/goodnode:"
  mkdir -p "$h"
  out="$(run_get)"
  case "$out" in *"Claude Code did not install"*"boom, no route to host"*"Still to do:"*"Claude Code: run  curl -fsSL https://claude.ai/install.sh | bash"*"exit=0") ok ;; *) fail "get.sh when Claude's installer fails: $out" ;; esac
  [ -f "$bin/keel-board" ] && ok || fail "get.sh stopped when Claude's installer failed"

  # A keel-board that is not get.sh's own is left alone, and the exit status is not 0.
  h="$g/h5" inst="$g/h5/keel" bin="$g/h5/bin" serve="$g/serve-ok" extra="$g/goodnode:$g/hasclaude:"
  mkdir -p "$bin"
  ln -s "$root/workspace/server/bin/keel-board.mjs" "$bin/keel-board"
  out="$(run_get)"
  case "$out" in *"SKIPPED    $bin/keel-board exists and is a link to $root/workspace/server/bin/keel-board.mjs. Move it away and run again."*"exit=1") ok ;; *) fail "get.sh over a foreign keel-board: $out" ;; esac
  expect "get.sh leaves a foreign keel-board" "$(readlink "$bin/keel-board")" "$root/workspace/server/bin/keel-board.mjs"
  out="$(run_get --uninstall)"
  expect "get.sh --uninstall leaves a foreign keel-board" "$(readlink "$bin/keel-board")" "$root/workspace/server/bin/keel-board.mjs"

  # Shells: bash on macOS gets both startup files, fish gets its own syntax, a bin folder on PATH gets none.
  h="$g/h6" inst="$g/h6/keel" bin="$g/h6/bin" shell_=/bin/bash
  mkdir -p "$h"
  run_get >/dev/null
  [ "$(grep -c "keel's get.sh" "$h/.bashrc")" = 1 ] && [ "$(grep -c "keel's get.sh" "$h/.bash_profile")" = 1 ] && ok || fail "get.sh for bash on macOS: $(ls -A "$h")"
  h="$g/h7" inst="$g/h7/keel" bin="$g/h7/bin" shell_=/usr/local/bin/fish
  mkdir -p "$h"
  run_get >/dev/null
  expect "get.sh for fish" "$(cat "$h/.config/fish/config.fish")" "set -gx PATH '$bin' \$PATH # keel-board: added by keel's get.sh"
  h="$g/h8" inst="$g/h8/keel" bin="$g/h8/bin" shell_="" extra="$g/goodnode:$g/hasclaude:$g/h8/bin:"
  mkdir -p "$h"
  out="$(run_get)"
  [ ! -e "$h/.zshrc" ] && ok || fail "get.sh changed .zshrc with the bin folder on PATH"
  case "$out" in *"Done. Next, type:"*"  mkdir my-idea && cd my-idea && keel-board"*) ok ;; *) fail "get.sh's last lines with the bin folder on PATH: $out" ;; esac

  # git: on macOS the developer tools are asked for; on Linux with no package manager it is a note.
  h="$g/h9" inst="$g/h9/keel" bin="$g/h9/bin" xcode="$g/h9/xcode" extra="$g/goodnode:$g/hasclaude:"
  mkdir -p "$h"
  out="$(run_get)"
  case "$out" in *"press Install"*"installed  Apple's developer tools, with git"*"exit=0") ok ;; *) fail "get.sh without git on macOS: $out" ;; esac
  grep -q '^xcode-select --install$' "$calls" && ok || fail "get.sh did not run xcode-select --install"
  h="$g/h10" inst="$g/h10/keel" bin="$g/h10/bin" sys_os=Linux
  mkdir -p "$h"
  out="$(run_get)"
  case "$out" in *"no known package manager"*"Still to do:"*"git: install it"*"exit=0") ok ;; *) fail "get.sh without git on Linux: $out" ;; esac
  cat >"$g/linux/apt-get" <<EOF
#!/bin/sh
echo "apt-get \$*" >>"\$GET_CALLS"
printf '#!/bin/sh\\n' >"$g/linux/git"; chmod +x "$g/linux/git"
EOF
  printf '#!/bin/sh\necho "sudo $*" >>"$GET_CALLS"\nexec "$@"\n' >"$g/linux/sudo"
  chmod +x "$g/linux/apt-get" "$g/linux/sudo"
  extra="$g/goodnode:$g/hasclaude:$g/linux:"
  out="$(run_get)"
  case "$out" in *"installed  git"*"exit=0") ok ;; *) fail "get.sh installing git with apt-get: $out" ;; esac
  if [ "$(id -u)" = 0 ]; then
    expect "get.sh runs apt-get as root" "$(grep -c '^sudo' "$calls")" 0
  else
    expect "get.sh runs apt-get with sudo" "$(grep '^sudo' "$calls")" "sudo apt-get update -qq
sudo apt-get install -y -qq git"
  fi
  xcode="$g/xcode-ready" sys_os=""

  # Systems it does not support.
  h="$g/h11" inst="$g/h11/keel" bin="$g/h11/bin"
  for t in MINGW64_NT-10.0:x86_64:"Windows is not supported yet" FreeBSD:amd64:"FreeBSD is not supported" Darwin:i686:"i686 processor is not supported"; do
    sys_os="${t%%:*}" sys_arch="${t#*:}" sys_arch="${sys_arch%%:*}"
    out="$(run_get)"
    case "$out" in *"${t##*:}"*"exit=1") ok ;; *) fail "get.sh on $sys_os $sys_arch: $out" ;; esac
  done
  [ ! -e "$h" ] && ok || fail "get.sh on an unsupported system made $h"
  sys_os="" sys_arch=""

  # Read from a pipe, as `curl | bash` runs it.
  h="$g/h12" inst="$g/h12/keel" bin="$g/h12/bin" extra="$g/goodnode:$g/hasclaude:"
  mkdir -p "$h"
  out="$(env -i HOME="$h" KEEL_INSTALL_DIR="$inst" KEEL_BIN_DIR="$bin" PATH="$fake:$extra$shim" SHELL=/bin/zsh GET_CALLS="$calls" GET_SERVE="$serve" GET_XCODE="$xcode" \
    bash <"$root/get.sh" 2>&1; echo "exit=$?")"
  case "$out" in *"Done. Next, type:"*"exit=0") ok ;; *) fail "bash < get.sh: $out" ;; esac
  [ -f "$bin/keel-board" ] && ok || fail "bash < get.sh wrote no launcher"
  out="$(cat "$root/get.sh" | env -i HOME="$h" PATH="$shim" bash -s -- --help 2>&1; echo "exit=$?")"
  case "$out" in "get.sh: install the keel board"*"--uninstall"*"exit=0") ok ;; *) fail "cat get.sh | bash -s -- --help: $out" ;; esac

  # The real npm installs a local package, and the launcher runs it with the real Node.
  if has_node; then
    n="$(dirname "$(command -v node)")"
    h="$g/h13" inst="$g/h13/a b/keel" bin="$g/h13/bin"
    mkdir -p "$g/pkg/package/server/bin" "$h"
    printf '{"name":"keel-workspace","version":"0.0.0-check","bin":{"keel-board":"server/bin/keel-board.mjs"}}\n' >"$g/pkg/package/package.json"
    printf 'console.log(JSON.stringify(process.argv.slice(2)));\n' >"$g/pkg/package/server/bin/keel-board.mjs"
    tar -czf "$g/keel-workspace-check.tgz" -C "$g/pkg" package
    out="$(env -i HOME="$h" KEEL_INSTALL_DIR="$inst" KEEL_BIN_DIR="$bin" KEEL_PACKAGE="$g/keel-workspace-check.tgz" PATH="$fake:$g/hasclaude:$n:$shim" SHELL=/bin/zsh \
      GET_CALLS="$calls" GET_SERVE="$serve" GET_XCODE="$xcode" npm_config_offline=true npm_config_update_notifier=false bash "$root/get.sh" 2>&1; echo "exit=$?")"
    case "$out" in *"installed  the board, keel-workspace 0.0.0-check"*"exit=0") ok ;; *) fail "get.sh with the real npm and a local package: $out" ;; esac
    expect "the launcher runs the real package with its arguments" "$(env -i HOME="$h" PATH="$n:/usr/bin:/bin" "$bin/keel-board" open "a b" 2>&1)" '["open","a b"]'
  else
    printf 'info  no Node 22 here: get.sh is not checked with the real npm\n'
  fi
}

board() {
  local file out
  has_node || { fail "the board checks need Node 22 or newer and npm"; return; }
  [ -d workspace/node_modules ] || { fail "workspace/node_modules is missing: run ./install.sh, or npm install in workspace/"; return; }

  check_frontmatter workspace/plugin/skills/board/SKILL.md board "$skill_keys"
  for file in workspace/plugin/.claude-plugin/plugin.json workspace/plugin/hooks/hooks.json workspace/plugin/.mcp.json; do
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" 2>/dev/null && ok || fail "$file is not valid JSON"
  done

  in_workspace() { # in_workspace <description> <command...>: shows the end of the output when it fails
    local what="$1"
    shift
    if out="$(cd "$root/workspace" && "$@" 2>&1)"; then
      ok
    else
      fail "$what"
      printf '%s\n' "$out" | tail -n 30 | sed 's/^/      /'
    fi
  }
  in_workspace "workspace typecheck (npm run typecheck)" npm run typecheck
  in_workspace "workspace unit tests (npm test)" npm test
  printf 'info  unit tests: %s\n' "$(printf '%s\n' "$out" | grep -E '^ +Tests ' | sed 's/^ *//')"
  if [ "${KEEL_E2E:-}" = 1 ]; then
    in_workspace "workspace browser tests (npm run e2e)" npm run e2e
    printf 'info  browser tests: %s\n' "$(printf '%s\n' "$out" | grep -E '^ +[0-9]+ (passed|failed|skipped)' | sed 's/^ *//' | tr '\n' ' ')"
  else
    printf 'info  browser tests not run: set KEEL_E2E=1 to run them\n'
  fi
}

case "$what" in
  lint) lint ;;
  hook) hook ;;
  bar) bar ;;
  brief) brief ;;
  install) install_check ;;
  get) get_check ;;
  board) board ;;
  all)
    lint; hook; bar; brief; install_check; get_check
    if has_node; then board; else printf 'skipped board: it needs Node 22 or newer and npm\n'; fi
    ;;
  *) echo "usage: scripts/check.sh [lint|hook|bar|brief|install|get|board]" >&2; exit 2 ;;
esac

if [ "$fails" -gt 0 ]; then
  printf '%s of %s checks failed\n' "$fails" "$checks"
  exit 1
fi
printf 'ok    %s checks passed\n' "$checks"
