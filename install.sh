#!/usr/bin/env bash
# Install keel into your Claude Code config directory.
#
#   ./install.sh              install or refresh
#   ./install.sh --uninstall  remove everything this script added
#   ./install.sh --dry-run    show what would change, change nothing
#
# Everything is a symlink back to this folder, so edits here are live and
# `git pull` is the update. The only file it edits is settings.json, to register
# two hooks. The first edit leaves a copy at settings.json.keel-backup.
#
# The config directory is $CLAUDE_CONFIG_DIR, or ~/.claude when that is unset.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
settings="$config/settings.json"
guard_link="$config/hooks/keel-guard.sh"
brief_link="$config/hooks/keel-brief-check.sh"

mode=install
dry=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

link() { # link <source> <target>
  local src="$1" dst="$2"
  if ours "$dst"; then
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

unlink_ours() { # unlink_ours <target>
  if ours "$1"; then
    run rm "$1"
    say "  removed   $1"
  fi
}

# The hooks keel registers, with each command as it is stored in settings.json.
keel_hooks() {
  jq -cn --arg guard "\"$guard_link\"" --arg brief "\"$brief_link\" --hook" '[
    {event: "PreToolUse", matcher: "Bash", command: $guard},
    {event: "PostToolUse", matcher: "Edit|Write", command: $brief}]'
}

settings_without_hooks() {
  jq --argjson keel "$(keel_hooks)" '
    reduce $keel[] as $h (.;
      if (.hooks[$h.event] | type) == "array" then
        .hooks[$h.event] |= map(select((.hooks // []) | any(.command == $h.command) | not))
        | if (.hooks[$h.event] | length) == 0 then del(.hooks[$h.event]) else . end
        | if (.hooks | length) == 0 then del(.hooks) else . end
      else . end)' "$1"
}

settings_with_hooks() {
  jq --argjson keel "$(keel_hooks)" '
    reduce $keel[] as $h (.;
      if ((.hooks[$h.event] // []) | any((.hooks // []) | any(.command == $h.command))) then .
      else
        .hooks = (.hooks // {})
        | .hooks[$h.event] = ((.hooks[$h.event] // []) + [{matcher: $h.matcher, hooks: [{type: "command", command: $h.command}]}])
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

skipped=0
[ "$dry" = 0 ] || say "Dry run: nothing is changed."

if [ "$mode" = install ]; then
  say "Installing keel into $config"
  for d in "$here"/skills/*/; do
    d="${d%/}"
    [ -f "$d/SKILL.md" ] || continue
    link "$d" "$config/skills/$(basename "$d")"
  done
  for f in "$here"/agents/*.md; do
    link "$f" "$config/agents/$(basename "$f")"
  done
  link "$here/rules/keel.md" "$config/rules/keel.md"
  link "$here/hooks/guard.sh" "$guard_link"
  link "$here/skills/keel/scripts/brief-check.sh" "$brief_link"
  write_settings settings_with_hooks
  say ""
  if [ "$skipped" -gt 0 ]; then
    say "Done, with $skipped item(s) skipped. See above."
  else
    say "Done. Start a new Claude Code session and type /keel."
  fi
else
  say "Removing keel from $config"
  for dir in skills agents rules hooks; do
    [ -d "$config/$dir" ] || continue
    for p in "$config/$dir"/*; do
      unlink_ours "$p"
    done
  done
  write_settings settings_without_hooks
  say ""
  say "Done. Files keel wrote inside your repos (QUALITY.md, specs, the Keel block in CLAUDE.md) are yours and stay."
fi
