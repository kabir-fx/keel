#!/usr/bin/env bash
# keel guard: a PreToolUse hook for the Bash tool.
#
# Denies a few commands that are never what you want.
# Asks before commands that are hard to undo or that publish something.
# Says nothing about everything else, so normal permission rules apply.
#
# It is a seatbelt, not a sandbox: it reads the command text and can be fooled
# by indirection (a script, an alias, eval). It fails open when jq is missing.
#
# Turn it off for one session: start Claude Code with KEEL_GUARD=off.

[ "${KEEL_GUARD:-on}" = "off" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

case "$cmd" in
  *git*|*gh\ *|*rm\ *|*publish*|*push*|*upload*) ;;
  *) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd="$PWD"

deny=""
ask=""
want_deny() { [ -n "$deny" ] || deny="$1"; }
want_ask() { [ -n "$ask" ] || ask="$1"; }

# Split a command into one simple command per line.
#   bare: quoted strings are blanked, so a flag inside a commit message does not count.
#   flat: quote characters are dropped, so rm "$HOME" is still seen.
split() {
  printf '%s' "$cmd" | awk -v mode="$1" '
    BEGIN { RS = "\001" }
    {
      if (mode == "bare") { gsub(/"[^"]*"/, "\"\""); gsub(/\047[^\047]*\047/, "\047\047") }
      else { gsub(/["\047]/, "") }
      gsub(/&&|\|\||;|\||\$\(|`|\(|\)|\n/, "\n")
      print
    }'
}

# Drop leading whitespace, wrappers with their options and durations, and
# VAR=value prefixes. Result in $seg.
strip_prefix() {
  local first wrapped=0
  while :; do
    seg="${seg#"${seg%%[![:space:]]*}"}"
    first="${seg%%[[:space:]]*}"
    case "$first" in
      sudo|command|time|env|nohup|exec|builtin|timeout|nice) wrapped=1 ;;
      [A-Za-z_]*=*) ;;
      -*|[0-9]*) [ "$wrapped" = 1 ] || return ;;
      *) return ;;
    esac
    [ "$first" = "$seg" ] && return
    seg="${seg#"$first"}"
  done
}

current_branch() {
  git -C "$cwd" symbolic-ref --quiet --short HEAD 2>/dev/null
}

has() { case "$rest" in *" $1 "*) return 0 ;; esac; return 1; }

re_force='( --force | --force-with-lease| --force-if-includes| --mirror | -[a-zA-Z]*f[a-zA-Z]* | \+[^ ])'
re_protected='[ :+/](main|master)[ :]'
re_delete='( --delete | -d | :[^ ]+ )'
re_noverify_short=' -[a-zA-Z]*n[a-zA-Z]* '
re_clean_force='( --force | -[a-zA-Z]*f[a-zA-Z]* )'
re_clean_dry='( --dry-run | -[a-zA-Z]*n[a-zA-Z]* )'
re_whole_tree=' (\.|:/|\*|\./) '

check_git() {
  local i=1 n=${#words[@]} sub="" branch
  while [ "$i" -lt "$n" ]; do
    case "${words[$i]}" in
      -c)
        case "${words[$((i + 1))]:-}" in
          [cC]ore.[hH]ooks[pP]ath=*) want_ask "core.hooksPath on the command line skips the repo's hooks, the same as --no-verify." ;;
        esac
        i=$((i + 2)) ;;
      -C|--git-dir|--work-tree|--namespace) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) sub="${words[$i]}"; i=$((i + 1)); break ;;
    esac
  done
  rest=" "
  while [ "$i" -lt "$n" ]; do rest="$rest${words[$i]} "; i=$((i + 1)); done

  case "$sub" in
    push)
      local forced=0 protected=0
      [[ $rest =~ $re_force ]] && forced=1
      if [[ $rest =~ $re_protected ]]; then
        protected=1
      else
        branch=$(current_branch)
        case "$branch" in main|master) protected=1 ;; esac
      fi
      if [ "$forced" = 1 ] && [ "$protected" = 1 ]; then
        want_deny "force push to the default branch rewrites shared history. Push a new commit or a revert instead."
      elif [ "$forced" = 1 ]; then
        want_ask "force push replaces the remote branch. Confirm nobody else has work on it."
      elif [[ $rest =~ $re_delete ]]; then
        want_ask "this deletes a branch on the remote."
      elif [ "$protected" = 1 ]; then
        want_ask "this pushes straight to the default branch, without a pull request."
      fi
      has --no-verify && want_ask "--no-verify skips the pre-push checks."
      ;;
    commit|merge)
      if has --no-verify || { [ "$sub" = commit ] && [[ $rest =~ $re_noverify_short ]]; }; then
        want_ask "this skips the commit hooks. Fix what the hook reports instead, unless you mean to bypass it."
      fi
      ;;
    reset)
      has --hard && want_ask "git reset --hard throws away uncommitted work."
      ;;
    clean)
      if [[ $rest =~ $re_clean_force ]] && ! [[ $rest =~ $re_clean_dry ]]; then
        want_ask "git clean deletes untracked files for good. Run it with -n first."
      fi
      ;;
    checkout)
      if [[ $rest =~ $re_whole_tree ]] || has -f || has --force; then
        want_ask "this discards uncommitted changes across the working tree."
      fi
      ;;
    restore)
      if [[ $rest =~ $re_whole_tree ]]; then
        if { has --staged || has -S; } && ! has --worktree && ! has -W; then :; else
          want_ask "this discards uncommitted changes across the working tree."
        fi
      fi
      ;;
    branch)
      if has -D || { has --delete && has --force; }; then
        want_ask "git branch -D deletes a branch even when it is not merged."
      fi
      ;;
    stash)
      case "$rest" in " drop "*|" clear "*) want_ask "this deletes stashed work for good." ;; esac
      ;;
  esac
}

check_gh() {
  local all=" ${words[*]} "
  if [ "${words[1]:-}" = api ]; then
    case "$all" in
      *protection*|*rulesets*)
        case "$all" in
          *" -X GET "*|*" -XGET "*|*" --method GET "*) ;;
          *" -X"*|*" --method "*|*" -f "*|*" -F "*|*" --field "*|*" --raw-field "*|*" --input "*)
            want_ask "this changes branch protection on the host. A merge must pass the checks, not remove them." ;;
        esac ;;
    esac
    return
  fi
  case "${words[1]:-} ${words[2]:-}" in
    "pr merge")
      case "$all" in *" --admin "*) want_ask "--admin merges past the required checks and branch protection." ;; esac
      want_ask "this merges the pull request." ;;
    "release create"|"release delete") want_ask "this changes a public release." ;;
    "repo delete"|"repo archive"|"repo rename") want_ask "this changes the repository itself and is hard to undo." ;;
  esac
}

check_publish() {
  local w
  for w in "${words[@]:1}"; do
    [ "$w" = --dry-run ] && return
  done
  case "${words[0]}" in
    npm|pnpm|yarn|bun)
      for w in "${words[@]:1}"; do
        [ "$w" = publish ] && want_ask "this publishes a package. A published version cannot be taken back."
      done
      ;;
    cargo|uv|poetry|flit|hatch)
      [ "${words[1]:-}" = publish ] && want_ask "this publishes a package. A published version cannot be taken back."
      ;;
    twine)
      [ "${words[1]:-}" = upload ] && want_ask "this uploads a package to an index. A published version cannot be taken back."
      ;;
    gem|docker|podman)
      [ "${words[1]:-}" = push ] && want_ask "this pushes an artifact to a public registry."
      ;;
  esac
}

check_rm() {
  local w recursive=0
  for w in "${words[@]:1}"; do
    case "$w" in
      --recursive) recursive=1 ;;
      --*) ;;
      -*[rR]*) recursive=1 ;;
    esac
  done
  [ "$recursive" = 1 ] || return
  for w in "${words[@]:1}"; do
    case "$w" in
      -*) ;;
      "/"|"/*"|"~"|\~/|\~/\*|"\$HOME"|"\$HOME/"|"\$HOME/*"|"\${HOME}"|"\${HOME}/"|"\${HOME}/*")
        want_deny "this would delete the home directory or the filesystem root." ;;
      "."|"./"|"./*"|".."|"../"|"../*"|"*"|".git"|"./.git"|".git/")
        want_ask "this deletes the whole directory, or the repository's history. Name the exact paths instead." ;;
    esac
  done
}

while IFS= read -r seg; do
  strip_prefix
  [ -n "$seg" ] || continue
  read -ra words <<<"$seg"
  case "${words[0]}" in
    git) check_git ;;
    gh) check_gh ;;
    npm|pnpm|yarn|bun|cargo|uv|poetry|flit|hatch|twine|gem|docker|podman) check_publish ;;
  esac
done <<EOF
$(split bare)
EOF

while IFS= read -r seg; do
  strip_prefix
  [ -n "$seg" ] || continue
  read -ra words <<<"$seg"
  [ "${words[0]}" = rm ] && check_rm
done <<EOF
$(split flat)
EOF

emit() {
  jq -cn --arg d "$1" --arg r "keel guard: $2" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
}

if [ -n "$deny" ]; then
  emit deny "$deny"
elif [ -n "$ask" ]; then
  emit ask "$ask"
fi
exit 0
