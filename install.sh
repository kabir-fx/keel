#!/usr/bin/env bash
# Install keel into your Claude Code config directory, with its board.
#
#   ./install.sh              install or refresh
#   ./install.sh --no-board   install or refresh, without the board
#   ./install.sh --uninstall  remove everything this script added
#   ./install.sh --dry-run    show what would change, change nothing
#
# Everything is a symlink back to this folder, so edits here are live and
# `git pull` is the update. Run this again after a pull: it rebuilds the board.
# The only file it edits is settings.json, to register three hooks. The first
# edit leaves a copy at settings.json.keel-backup.
#
# The board needs Node 22 or newer and npm. It is built in workspace/, and the
# keel-board command is linked into $KEEL_BIN_DIR, or ~/.local/bin when unset.
# Without Node, the board is skipped and the rest is installed.
#
# The config directory is $CLAUDE_CONFIG_DIR, or ~/.claude when that is unset.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
settings="$config/settings.json"
guard_link="$config/hooks/keel-guard.sh"
brief_link="$config/hooks/keel-brief-check.sh"
bin="${KEEL_BIN_DIR:-$HOME/.local/bin}"
board_cmd="$bin/keel-board"
board_src="$here/workspace/server/bin/keel-board.mjs"
# The board's guard is registered by its real path in this folder.
board_guard="$here/workspace/plugin/hooks/guard-board.mjs"
board_hooks="$here/workspace/plugin/hooks/hooks.json"

mode=install
dry=0
board=1
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --dry-run) dry=1 ;;
    --no-board) board=0 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { [ "$dry" = 1 ] || "$@"; }

# True when $1 is a symlink that points into this folder.
ours() {
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in "$here"/*) return 0 ;; esac
  return 1
}

# True when $2 is a dead symlink left by a keel folder that has moved or gone: it
# points nowhere, and its target ends with the same path inside that folder as $1
# has inside this one. A link that still leads somewhere is never taken for it.
stale() { # stale <source> <target>
  [ -L "$2" ] && [ ! -e "$2" ] || return 1
  case "$(readlink "$2")" in */"${1#"$here"/}") return 0 ;; esac
  return 1
}

link() { # link <source> <target>
  local src="$1" dst="$2"
  if ours "$dst" || stale "$src" "$dst"; then
    [ "$(readlink "$dst")" = "$src" ] && return 0
    run ln -sfn "$src" "$dst"
    say "  relinked  $dst"
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    say "  SKIPPED   $dst exists and is not keel's. Move it away and run again."
    skipped=$((skipped + 1))
  else
    run mkdir -p "$(dirname "$dst")"
    run ln -s "$src" "$dst"
    say "  linked    $dst"
  fi
}

# Every link the installer makes in the config directory: calls <function> <source> <target>.
# Uninstall walks the same list, so it never takes away a link it did not make.
each_link() { # each_link <function>
  local d f
  for d in "$here"/skills/*/; do
    d="${d%/}"
    [ -f "$d/SKILL.md" ] || continue
    "$1" "$d" "$config/skills/$(basename "$d")"
  done
  for f in "$here"/agents/*.md; do
    "$1" "$f" "$config/agents/$(basename "$f")"
  done
  "$1" "$here/rules/keel.md" "$config/rules/keel.md"
  "$1" "$here/hooks/guard.sh" "$guard_link"
  "$1" "$here/skills/keel/scripts/brief-check.sh" "$brief_link"
}

unlink_made() { # unlink_made <source> <target>
  if ours "$2" || stale "$1" "$2"; then
    run rm "$2"
    say "  removed   $2"
  fi
}

# The tools the board's guard watches, as the plugin's hooks.json names them.
board_matcher() {
  jq -r '[.hooks.PreToolUse[] | select(any(.hooks[]; .command | contains("guard-board.mjs"))) | .matcher][0] // empty' "$board_hooks"
}

# The hooks keel registers, with each command as it is stored in settings.json.
# Each path is quoted for the shell with jq's @sh, so a path that holds a quote,
# a `$(...)` or a backtick stays one plain word. `legacy` is the same command in
# the double quotes earlier installers wrote: a refresh replaces it, and
# uninstall removes it. Given the tools it watches, the board's guard is one of them.
keel_hooks() { # keel_hooks [<board guard matcher>]
  jq -cn --arg guard "$guard_link" --arg brief "$brief_link" --arg board "$board_guard" --arg matcher "${1:-}" '[
    {event: "PreToolUse", matcher: "Bash", command: ($guard | @sh), legacy: ["\"\($guard)\""]},
    {event: "PostToolUse", matcher: "Edit|Write", command: "\($brief | @sh) --hook", legacy: ["\"\($brief)\" --hook"]}]
    + if $matcher != "" then [{event: "PreToolUse", matcher: $matcher, command: "node \($board | @sh)", legacy: ["node \"\($board)\""], timeout: 10}] else [] end'
}

# A jq function: strip($cmds) takes each hook whose command is in $cmds out of its
# group's list. The group goes only when that leaves it empty, the event only when
# that leaves it empty, and `hooks` only when that leaves it empty. Nothing else changes.
strip_def='def strip($cmds):
  def keel: (.command? // null) as $c | any($cmds[]; . == $c);
  def touched: any((.hooks? // [])[]?; keel);
  if (.hooks | type) == "object" and any(.hooks[]; type == "array" and any(.[]; touched)) then
    .hooks |= with_entries(
      if (.value | type) == "array" and any(.value[]; touched) then
        .value |= map(if touched then (.hooks |= map(select(keel | not))) | select(.hooks | length > 0) else . end)
        | select(.value | length > 0)
      else . end)
    | if .hooks == {} then del(.hooks) else . end
  else . end;'

# The board guard's hook names its script by the full path of the keel folder. When
# that folder has moved or gone, the hook is left pointing nowhere. This prints, as a
# JSON list, each such command in the settings file $1: a board guard whose script
# is not there. A path that is not plain (it holds a quote, a `$`, a backtick or a
# backslash) is left alone.
dead_board_hooks() { # dead_board_hooks <settings file>
  local out='[]' cmd script
  while IFS= read -r cmd; do
    case "$cmd" in
      "node '"*"/workspace/plugin/hooks/guard-board.mjs'") script="${cmd#"node '"}"; script="${script%"'"}" ;;
      'node "'*'/workspace/plugin/hooks/guard-board.mjs"') script="${cmd#'node "'}"; script="${script%'"'}" ;;
      *) continue ;;
    esac
    case "$script" in *"'"*|*'"'*|*'$'*|*'`'*|*'\'*) continue ;; esac
    [ -e "$script" ] && continue
    out="$(jq -c --arg c "$cmd" '. + [$c]' <<<"$out")"
  done < <(jq -r '[.. | .command? | strings | select(contains("/workspace/plugin/hooks/guard-board.mjs"))] | unique | .[]' "$1" 2>/dev/null || true)
  printf '%s\n' "$out"
}

# Uninstall removes every keel hook, the board's guard included, in both quotings,
# and a board guard left by a keel folder that has moved.
# It goes by the command, so the matcher given here does not matter.
settings_without_hooks() {
  jq --argjson keel "$(keel_hooks any)" --argjson dead "$(dead_board_hooks "$1")" "$strip_def"' strip([$keel[] | .command, .legacy[]] + $dead)' "$1"
}

# Install takes out the old quoting of each hook, and a board guard left by a keel
# folder that has moved, then adds the hook when its command is not there yet.
settings_with_hooks() {
  jq --argjson keel "$(keel_hooks "$board_tools")" --argjson dead "$(dead_board_hooks "$1")" "$strip_def"'
    strip($dead)
    | reduce $keel[] as $h (.;
      strip($h.legacy)
      | if any(.hooks[$h.event]?[]?; any(.hooks[]?; .command? == $h.command)) then .
        else
          .hooks = (.hooks // {})
          | .hooks[$h.event] = ((.hooks[$h.event] // []) + [{matcher: $h.matcher, hooks: [{type: "command", command: $h.command} + (if $h.timeout then {timeout: $h.timeout} else {} end)]}])
        end)' "$1"
}

write_settings() { # write_settings <function that prints the new settings>
  local tmp
  if ! command -v jq >/dev/null 2>&1; then
    say "  SKIPPED   settings.json: jq is not installed. Install jq and run again to get keel's hooks."
    skipped=$((skipped + 1))
    return 0
  fi
  if [ ! -f "$settings" ]; then
    [ "$1" = settings_without_hooks ] && return 0
    if [ "$dry" = 1 ]; then
      say "  would create $settings with keel's hooks"
      return 0
    fi
    mkdir -p "$config"
    printf '{}\n' >"$settings"
  fi
  tmp="$(mktemp)"
  if ! "$1" "$settings" >"$tmp"; then
    rm -f "$tmp"
    say "  SKIPPED   $settings is not valid JSON. Fix it and run again."
    skipped=$((skipped + 1))
    return 0
  fi
  if cmp -s "$tmp" "$settings" || [ "$(jq -S . "$tmp")" = "$(jq -S . "$settings")" ]; then
    rm -f "$tmp"
    return 0
  fi
  if [ "$dry" = 1 ]; then
    say "  would update $settings:"
    diff <(jq -S . "$settings") <(jq -S . "$tmp") | sed 's/^/    /' || true
    rm -f "$tmp"
    return 0
  fi
  [ -f "$settings.keel-backup" ] || cp "$settings" "$settings.keel-backup"
  cat "$tmp" >"$settings"
  rm -f "$tmp"
  say "  updated   $settings (first-run backup: settings.json.keel-backup)"
}

# Why the board cannot be built here, or nothing when it can.
board_missing() {
  local major
  if ! command -v node >/dev/null 2>&1; then
    say "Node is not installed"
    return 0
  fi
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -lt 22 ]; then
    say "Node $(node --version 2>/dev/null) is older than 22"
  elif ! command -v npm >/dev/null 2>&1; then
    say "npm is not installed"
  fi
}

# npm install and npm run build in workspace/. Its output is shown only when it fails.
build_board() {
  local out
  if [ "$dry" = 1 ]; then
    say "  would build the board in $here/workspace (npm install, npm run build)"
    return 0
  fi
  say "  building  the board in $here/workspace (npm install, npm run build)"
  out="$(mktemp)"
  if (cd "$here/workspace" && npm install --no-audit --no-fund && npm run build) >"$out" 2>&1; then
    rm -f "$out"
    say "  built     the board"
    return 0
  fi
  say "  SKIPPED   the board: its build failed. The end of its output:"
  tail -n 20 "$out" | sed 's/^/    /'
  rm -f "$out"
  skipped=$((skipped + 1))
  return 1
}

on_path() { case ":$PATH:" in *":$1:"*|*":$1/:"*) return 0 ;; esac; return 1; }

skipped=0
board_tools=""
[ "$dry" = 0 ] || say "Dry run: nothing is changed."

if [ "$mode" = install ]; then
  say "Installing keel into $config"
  each_link link

  if [ "$board" = 0 ]; then
    say "  left out  the board (--no-board)"
  else
    why="$(board_missing)"
    if [ -n "$why" ]; then
      say "  SKIPPED   the board: $why. Install Node 22 or newer with npm (https://nodejs.org), then run ./install.sh again."
      skipped=$((skipped + 1))
      board=0
    else
      if build_board; then
        link "$board_src" "$board_cmd"
        on_path "$bin" || say "  NOTE      $bin is not on your PATH. Add it, for example: export PATH=\"$bin:\$PATH\""
      fi
      if command -v jq >/dev/null 2>&1; then
        board_tools="$(board_matcher 2>/dev/null || true)"
        if [ -z "$board_tools" ]; then
          say "  SKIPPED   the board's guard: $board_hooks names no guard-board.mjs hook."
          skipped=$((skipped + 1))
        fi
      fi
    fi
  fi

  write_settings settings_with_hooks
  say ""
  if [ "$skipped" -gt 0 ]; then
    say "Done, with $skipped item(s) skipped. See above."
  else
    say "Done. Start a new Claude Code session and type /keel."
  fi
  if [ "$board" = 1 ] && ours "$board_cmd"; then
    say "For the board, go to a repository and run: keel-board open"
  fi
else
  say "Removing keel from $config"
  each_link unlink_made
  unlink_made "$board_src" "$board_cmd"
  write_settings settings_without_hooks
  say ""
  say "Done. Files keel wrote inside your repos (QUALITY.md, specs, the Keel block in CLAUDE.md) are yours and stay."
  say "So are your boards: .keel/board/ in each repository, and ~/.keel/boards/. The board's build output in workspace/ is ignored by git."
fi
