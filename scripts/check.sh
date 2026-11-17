#!/usr/bin/env bash
# Checks keel itself. Run it after any edit to the suite.
#
#   scripts/check.sh            everything
#   scripts/check.sh lint       skill, agent, and reference checks
#   scripts/check.sh hook       the guard hook, against a table of commands
#   scripts/check.sh bar        bar-guard.sh, against a throwaway repository
#   scripts/check.sh brief      brief-check.sh, against a clean and a bad brief
#   scripts/check.sh install    the installer, against a throwaway config directory
#
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

  for file in install.sh scripts/check.sh hooks/guard.sh skills/vet/scripts/bar-guard.sh skills/keel/scripts/brief-check.sh; do
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

install_check() {
  local config="$tmp/config" before name cmd got
  mkdir -p "$config/skills/tdd"
  printf 'mine\n' >"$config/skills/tdd/SKILL.md"
  printf '{"model":"x","hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo hi"}]}]}}\n' >"$config/settings.json"
  before="$(jq -S . "$config/settings.json")"

  CLAUDE_CONFIG_DIR="$config" "$root/install.sh" --dry-run >/dev/null 2>&1
  [ ! -e "$config/skills/keel" ] && ok || fail "install --dry-run created files"
  expect "install --dry-run leaves settings alone" "$(jq -S . "$config/settings.json")" "$before"

  got="$(CLAUDE_CONFIG_DIR="$config" "$root/install.sh" 2>&1)"
  case "$got" in *"SKIPPED   $config/skills/tdd"*) ok ;; *) fail "install did not report the conflicting skills/tdd" ;; esac
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

  got="$(jq -S . "$config/settings.json")"
  CLAUDE_CONFIG_DIR="$config" "$root/install.sh" >/dev/null 2>&1
  expect "install twice changes nothing" "$(jq -S . "$config/settings.json")" "$got"

  CLAUDE_CONFIG_DIR="$config" "$root/install.sh" --uninstall >/dev/null 2>&1
  [ ! -e "$config/skills/keel" ] && [ ! -e "$config/agents/verifier.md" ] && [ ! -e "$config/rules/keel.md" ] && [ ! -e "$config/hooks/keel-guard.sh" ] && ok || fail "uninstall left links behind"
  expect "uninstall leaves a foreign skill alone" "$(cat "$config/skills/tdd/SKILL.md")" mine
  expect "uninstall restores settings" "$(jq -S . "$config/settings.json")" "$before"
}

case "$what" in
  lint) lint ;;
  hook) hook ;;
  bar) bar ;;
  brief) brief ;;
  install) install_check ;;
  all) lint; hook; bar; brief; install_check ;;
  *) echo "usage: scripts/check.sh [lint|hook|bar|brief|install]" >&2; exit 2 ;;
esac

if [ "$fails" -gt 0 ]; then
  printf '%s of %s checks failed\n' "$fails" "$checks"
  exit 1
fi
printf 'ok    %s checks passed\n' "$checks"
