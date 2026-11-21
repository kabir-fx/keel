#!/usr/bin/env bash
# Install the keel board and what it needs, on macOS or Linux, with one command.
# What it does and its options are in usage(), which -h prints. Under
# `curl | bash` there is no file to read the help from, so it lives in the code.

set -euo pipefail

usage() {
  cat <<'EOF'
get.sh: install the keel board (the keel-board command) and what it needs.

  curl -fsSL https://raw.githubusercontent.com/kabir-fx/keel/main/get.sh | bash
  curl -fsSL https://raw.githubusercontent.com/kabir-fx/keel/main/get.sh | bash -s -- --uninstall

  (no option)   install. Run it again to update the board.
  --uninstall   remove what this script made
  -h, --help    show this

What it installs, each only when missing:
  git           macOS: Apple's developer tools. Linux: the package manager.
  Node 24       into $KEEL_INSTALL_DIR/node, only when no Node 22 or newer is on PATH
  Claude Code   with Anthropic's installer, into ~/.local/bin
  the board     the npm package keel-workspace, into $KEEL_INSTALL_DIR/pkg
  keel-board    a small launcher in $KEEL_BIN_DIR, put on PATH in your shell's startup file

It needs no sudo, except to install git on Linux.
Signing in to Claude happens on the board's first page, not here.
Uninstall keeps Claude Code, git, and your boards in ~/.keel.

  KEEL_INSTALL_DIR  default ~/.local/share/keel
  KEEL_BIN_DIR      default ~/.local/bin
  KEEL_PACKAGE      what npm installs, default keel-workspace@latest
EOF
}

launcher_marker="# keel-board launcher, written by keel's get.sh. get.sh --uninstall removes it."
path_marker="# keel-board: added by keel's get.sh"

say() { printf '%s\n' "$*"; }
item() { printf '  %-10s %s\n' "$1" "$2"; }
die() { printf '%s%s%s\n' "$red" "$*" "$off" >&2; exit 1; }
todo() { todos="$todos  - $1"$'\n'; }
has() { command -v "$1" >/dev/null 2>&1; }
on_path() { case ":$PATH:" in *":$1:"*|*":$1/:"*) return 0 ;; esac; return 1; }
absolute() { case "$1" in /*) say "$1" ;; *) say "$PWD/$1" ;; esac; }
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
fish_q() { printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")"; }
show_tail() { tail -n 20 "$1" | sed 's/^/    /'; }

check_system() {
  local s m t
  s="$(uname -s)"
  m="$(uname -m)"
  case "$s" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows*) die "Windows is not supported yet. keel runs on macOS and Linux." ;;
    *) die "$s is not supported. keel runs on macOS and Linux." ;;
  esac
  case "$m" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) die "A $m processor is not supported. keel runs on arm64 and x64." ;;
  esac
  for t in curl tar; do
    has "$t" || die "$t is needed and is not installed. Install it, then run this again."
  done
  item system "$os-$arch"
}

git_ready() {
  local g
  if [ "$os" = darwin ]; then
    g="$(command -v git || true)"
    { [ -n "$g" ] && [ "$g" != /usr/bin/git ]; } || xcode-select -p >/dev/null 2>&1
  else
    has git
  fi
}

git_mac() {
  local deadline=$((SECONDS + 1800))
  xcode-select --install >/dev/null 2>&1 || true
  item waiting "for Apple's developer tools, which hold git. A macOS window asks to install them: press Install. This waits up to 30 minutes."
  until xcode-select -p >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      item NOTE "git is not installed yet. Finish later with: xcode-select --install"
      todo "git: run  xcode-select --install  and press Install"
      return 0
    fi
    sleep 5
  done
  item installed "Apple's developer tools, with git"
}

git_linux() {
  local pm="" p cmd s="" shown log="$work/git.log"
  for p in apt-get dnf yum pacman zypper apk; do
    if has "$p"; then pm="$p"; break; fi
  done
  if [ "$(id -u)" != 0 ]; then s="sudo "; fi
  case "$pm" in
    apt-get) cmd="${s}apt-get update -qq && ${s}apt-get install -y -qq git" ;;
    dnf|yum) cmd="${s}$pm install -y git" ;;
    pacman) cmd="${s}pacman -S --noconfirm git" ;;
    zypper) cmd="${s}zypper --non-interactive install git" ;;
    apk) cmd="${s}apk add git" ;;
    *)
      item NOTE "git is not installed and no known package manager was found. Install git, then run this again."
      todo "git: install it with your system's package manager"
      return 0
      ;;
  esac
  shown="$cmd"
  if [ -n "$s" ] && ! has sudo; then
    item NOTE "git is not installed, and installing it needs root. As root, run: ${cmd//sudo /}"
    todo "git: as root, run  ${cmd//sudo /}"
    return 0
  fi
  item installing "git: $shown"
  if sh -c "$cmd" >"$log" 2>&1 && has git; then
    item installed "git"
    return 0
  fi
  item NOTE "git did not install. The end of the output:"
  show_tail "$log"
  todo "git: run  $shown"
}

step_git() {
  if git_ready; then
    item found git
  elif [ "$os" = darwin ]; then
    git_mac
  else
    git_linux
  fi
}

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'; }

download_node() {
  local base="https://nodejs.org/dist/latest-v24.x" sum name want got new="$install_dir/node.new"
  if has shasum; then
    sum="shasum -a 256"
  elif has sha256sum; then
    sum=sha256sum
  else
    die "Neither shasum nor sha256sum is installed, so the Node download cannot be checked. Install one, then run this again."
  fi
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt" ||
    die "Could not download $base/SHASUMS256.txt. Check the network, then run this again."
  name="$(sed -n "s/^[0-9a-f]\{64\}  \(node-v24\.[0-9]*\.[0-9]*-$os-$arch\.tar\.gz\)\$/\1/p" "$work/SHASUMS256.txt" | head -n 1)"
  [ -n "$name" ] || die "nodejs.org lists no Node 24 for $os-$arch."
  want="$(sed -n "s/^\([0-9a-f]\{64\}\)  $name\$/\1/p" "$work/SHASUMS256.txt")"
  item fetching "$base/$name"
  curl -fsSL "$base/$name" -o "$work/$name" ||
    die "Could not download $base/$name. Check the network, then run this again."
  got="$($sum "$work/$name" | cut -d ' ' -f 1)"
  [ "$got" = "$want" ] ||
    die "The Node download does not match its checksum from nodejs.org, so it was not installed. Run this again. If it happens again, the download is being changed on the way."
  rm -rf "$new"
  mkdir -p "$new"
  tar -xzf "$work/$name" -C "$new" --strip-components 1 || die "Could not unpack $name."
  [ "$(node_major "$new/bin/node")" = 24 ] ||
    die "The Node downloaded from nodejs.org does not run on this system. Install Node 22 or newer yourself, then run this again."
  rm -rf "$install_dir/node.old"
  if [ -e "$install_dir/node" ]; then mv "$install_dir/node" "$install_dir/node.old"; fi
  mv "$new" "$install_dir/node"
  rm -rf "$install_dir/node.old"
  node_bin="$install_dir/node/bin"
  item installed "Node $("$node_bin/node" --version) in $install_dir/node"
}

step_node() {
  local n m
  if n="$(command -v node)" && has npm; then
    m="$(node_major "$n")"
    if [ "${m:-0}" -ge 22 ]; then
      node_bin="$(dirname "$n")"
      item found "Node $("$n" --version) at $n"
      return 0
    fi
  fi
  n="$install_dir/node/bin/node"
  if [ -x "$n" ]; then
    m="$(node_major "$n")"
    if [ "${m:-0}" -ge 22 ]; then
      node_bin="$install_dir/node/bin"
      item found "Node $("$n" --version) in $install_dir/node"
      return 0
    fi
  fi
  download_node
}

claude_found() { has claude || [ -x "$HOME/.local/bin/claude" ]; }

step_claude() {
  local log="$work/claude.log"
  if claude_found; then
    item found "Claude Code"
    return 0
  fi
  item installing "Claude Code, with https://claude.ai/install.sh (a few minutes)"
  if curl -fsSL https://claude.ai/install.sh -o "$work/claude-install.sh" >"$log" 2>&1 &&
    bash "$work/claude-install.sh" >>"$log" 2>&1 && claude_found; then
    item installed "Claude Code"
    return 0
  fi
  item NOTE "Claude Code did not install. The end of its installer's output:"
  show_tail "$log"
  todo "Claude Code: run  curl -fsSL https://claude.ai/install.sh | bash  or install it from the board's setup page"
}

pkg_version() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1; }

step_board() {
  local log="$work/npm.log" json="$install_dir/pkg/lib/node_modules/keel-workspace/package.json" had="" now
  if [ -f "$json" ]; then had="$(pkg_version "$json")"; fi
  mkdir -p "$install_dir/pkg"
  if ! PATH="$node_bin:$PATH" npm install --global --prefix "$install_dir/pkg" --no-audit --no-fund "$package" >"$log" 2>&1; then
    say "  npm install failed. The end of its output:"
    show_tail "$log"
    die "The board did not install."
  fi
  [ -f "$board_entry" ] || die "npm installed $package, but $board_entry is not there."
  now="$(pkg_version "$json")"
  if [ -z "$had" ]; then
    item installed "the board, keel-workspace $now"
  elif [ "$had" = "$now" ]; then
    item found "the board, keel-workspace $now, the newest"
  else
    item updated "the board, keel-workspace $had to $now"
  fi
}

launcher_text() {
  printf '#!/bin/sh\n%s\n' "$launcher_marker"
  printf 'keel_dir=%s\n' "$(sq "$install_dir")"
  cat <<'EOF'
if [ -x "$keel_dir/node/bin/node" ]; then PATH="$keel_dir/node/bin:$PATH"; fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$PATH:$HOME/.local/bin" ;; esac
export PATH
exec node "$keel_dir/pkg/lib/node_modules/keel-workspace/server/bin/keel-board.mjs" "$@"
EOF
}

ours_launcher() { [ -f "$launcher" ] && [ ! -L "$launcher" ] && grep -qxF "$launcher_marker" "$launcher"; }

step_launcher() {
  local what
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if ! ours_launcher; then
      if [ -L "$launcher" ]; then what="a link to $(readlink "$launcher")"; else what="a file this script did not write"; fi
      item SKIPPED "$launcher exists and is $what. Move it away and run again."
      skipped=$((skipped + 1))
      return 0
    fi
    if [ "$(launcher_text)" = "$(cat "$launcher")" ]; then
      item found "$launcher"
      return 0
    fi
  fi
  mkdir -p "$bin_dir"
  launcher_text >"$launcher.new"
  chmod 755 "$launcher.new"
  mv -f "$launcher.new" "$launcher"
  item written "$launcher"
}

rc_files() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) say "$HOME/.zshrc" ;;
    bash)
      say "$HOME/.bashrc"
      if [ "$os" = darwin ]; then say "$HOME/.bash_profile"; fi
      ;;
    fish) say "$HOME/.config/fish/config.fish" ;;
    *) say "$HOME/.profile" ;;
  esac
}

path_line() { # path_line <startup file>
  case "$1" in
    *.fish) printf 'set -gx PATH %s $PATH %s\n' "$(fish_q "$bin_dir")" "$path_marker" ;;
    *) printf 'export PATH=%s:"$PATH" %s\n' "$(sq "$bin_dir")" "$path_marker" ;;
  esac
}

step_path() {
  local f
  if on_path "$bin_dir"; then
    item found "$bin_dir on PATH"
    return 0
  fi
  path_changed=1
  while IFS= read -r f; do
    if [ -f "$f" ] && grep -qF "$path_marker" "$f"; then
      item found "$bin_dir on PATH in $f"
      continue
    fi
    mkdir -p "$(dirname "$f")"
    if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\n' >>"$f"; fi
    path_line "$f" >>"$f"
    item added "$bin_dir to PATH in $f"
  done < <(rc_files)
}

install_all() {
  say "${bold}Installing the keel board${off}"
  check_system
  step_git
  step_node
  step_claude
  step_board
  step_launcher
  step_path
  say ""
  if [ "$skipped" -gt 0 ]; then
    say "Not finished: $skipped item(s) skipped. See above."
  else
    say "Done. Next, type:"
    if [ "$path_changed" = 1 ]; then
      say "  (in a new terminal)  mkdir my-idea && cd my-idea && keel-board"
      say "  (or in this one)     mkdir my-idea && cd my-idea && $(sq "$launcher")"
    else
      say "  mkdir my-idea && cd my-idea && keel-board"
    fi
    say "The board opens in your browser and, the first time, asks you to sign in to Claude there."
  fi
  if [ -n "$todos" ]; then
    say ""
    say "Still to do:"
    printf '%s' "$todos"
  fi
  [ "$skipped" = 0 ] || exit 1
}

uninstall_all() {
  local d f tmpf
  say "${bold}Removing the keel board${off}"
  for d in node node.new node.old pkg; do
    if [ -e "$install_dir/$d" ]; then
      rm -rf "${install_dir:?}/$d"
      item removed "$install_dir/$d"
    fi
  done
  if [ -d "$install_dir" ] && rmdir "$install_dir" 2>/dev/null; then item removed "$install_dir"; fi
  if ours_launcher; then
    rm -f "$launcher"
    item removed "$launcher"
  elif [ -e "$launcher" ] || [ -L "$launcher" ]; then
    item kept "$launcher: this script did not write it"
  fi
  for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.config/fish/config.fish" "$HOME/.profile"; do
    [ -f "$f" ] && grep -qF "$path_marker" "$f" || continue
    tmpf="$work/rc"
    grep -vF "$path_marker" "$f" >"$tmpf" || true
    cat "$tmpf" >"$f"
    item removed "the PATH line in $f"
  done
  say ""
  say "Done. Claude Code, git, and your boards in ~/.keel stay."
}

main() {
  # Under `curl | bash` the script itself is stdin, so no child may read it.
  exec </dev/null

  local mode=install_all arg
  for arg in "$@"; do
    case "$arg" in
      --uninstall) mode=uninstall_all ;;
      -h|--help) usage; exit 0 ;;
      *) say "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
  done

  bold="" red="" off=""
  if [ -t 1 ]; then bold=$'\033[1m' red=$'\033[31m' off=$'\033[0m'; fi

  # The board's build sandbox refuses to read anything under ~/.keel, so nothing goes there.
  install_dir="$(absolute "${KEEL_INSTALL_DIR:-$HOME/.local/share/keel}")"
  bin_dir="$(absolute "${KEEL_BIN_DIR:-$HOME/.local/bin}")"
  package="${KEEL_PACKAGE:-keel-workspace@latest}"
  launcher="$bin_dir/keel-board"
  board_entry="$install_dir/pkg/lib/node_modules/keel-workspace/server/bin/keel-board.mjs"
  os="" arch="" node_bin="" todos="" skipped=0 path_changed=0

  work="$(mktemp -d)"
  trap 'rm -rf "$work" "$install_dir/node.new"' EXIT

  "$mode"
}

main "$@"
