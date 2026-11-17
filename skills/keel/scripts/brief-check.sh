#!/usr/bin/env bash
# keel brief check: holds a brief to the writing limits in keel/brief.md.
#
#   brief-check.sh <file>...   check each file; one line per finding
#   brief-check.sh --hook      PostToolUse hook for Edit and Write: checks the
#                              written file when it is a .md file in a directory
#                              named briefs, and reports to Claude on stderr
#
# Exit status: 0 clean, 1 findings, 2 a file is missing (hook mode: 2 findings).
# Hook mode fails open when jq is missing.

set -u

check() { # check <file>
  awk '
    BEGIN {
      max_words = 20
      max_sentences = 6
      # Words that ASD-STE100 does not approve, with the word to use.
      nw = split("ensure:make sure|utilize:use|utilise:use|leverage:use|commence:start|terminate:stop|facilitate:help|prior to:before|in order to:to|via:through", pairs, "|")
      for (i = 1; i <= nw; i++) { split(pairs[i], kv, ":"); bad[i] = kv[1]; good[i] = kv[2] }
    }
    function report(msg) { printf "%s:%d: %s\n", FILENAME, start, msg; found++ }
    function count(s,   w, i, m, c) {
      m = split(s, w, /[ \t]+/)
      for (i = 1; i <= m; i++) if (w[i] ~ /[A-Za-z0-9]/) c++
      return c + 0
    }
    function head(s,   w, i, m, n, out) {
      m = split(s, w, /[ \t]+/)
      for (i = 1; i <= m; i++) {
        if (w[i] == "") continue
        if (++n > 8) return out " ..."
        out = out (n == 1 ? "" : " ") w[i]
      }
      return out
    }
    function flush(   rest, s, n, sentences, low, i) {
      if (block !~ /[A-Za-z0-9]/) { block = ""; return }
      if (index(block, ";")) report("semicolon: write two sentences")
      low = tolower(block)
      for (i = 1; i <= nw; i++)
        if (low ~ ("(^|[^a-z])" bad[i] "[sd]?([^a-z]|$)")) report("\"" bad[i] "\": write \"" good[i] "\"")
      rest = block
      while (rest != "") {
        if (match(rest, /[.!?]+[]"\047)]*([ \t]+|$)/)) {
          s = substr(rest, 1, RSTART + RLENGTH - 1)
          rest = substr(rest, RSTART + RLENGTH)
        } else {
          s = rest
          rest = ""
        }
        n = count(s)
        if (n == 0) continue
        sentences++
        if (n > max_words) report("sentence of " n " words, max " max_words ": \"" head(s) "\"")
      }
      if (sentences > max_sentences) report("paragraph of " sentences " sentences, max " max_sentences)
      block = ""
    }
    function add(text) {
      if (block == "") start = FNR
      block = block " " text
    }
    { sub(/\r$/, "") }
    /^[ \t]*(```|~~~)/ { flush(); fenced = !fenced; next }
    fenced { next }
    /^[ \t]*$/ || /^[ \t]*#+[ \t]/ || /^[ \t]*(---+|\*\*\*+)[ \t]*$/ { flush(); next }
    {
      line = $0
      gsub(/`[^`]*`/, "`code`", line)
      gsub(/\]\([^)]*\)/, "", line)
      gsub(/[[]/, "", line)
      gsub(/<[^>]*>/, " ", line)
      sub(/^[ \t]*>[ \t]?/, "", line)
      if (line ~ /^[ \t]*\|/) {
        flush()
        if (line ~ /^[ \t]*\|[ \t:|-]*$/) next
        m = split(line, cells, "|")
        for (i = 1; i <= m; i++) { add(cells[i]); flush() }
        next
      }
      if (line ~ /^[ \t]*([-*+]|[0-9]+[.)])[ \t]+/) {
        flush()
        sub(/^[ \t]*([-*+]|[0-9]+[.)])[ \t]+/, "", line)
      }
      gsub(/\*+/, "", line)
      add(line)
    }
    END { flush(); exit (found > 0 ? 1 : 0) }
  ' "$1"
}

if [ "${1:-}" = --hook ]; then
  command -v jq >/dev/null 2>&1 || exit 0
  file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
  case "$file" in */briefs/*.md|briefs/*.md) ;; *) exit 0 ;; esac
  [ -f "$file" ] || exit 0
  out=$(check "$file") && exit 0
  printf '%s\nThis brief breaks the writing limits in keel/brief.md. Rewrite these lines now.\n' "$out" >&2
  exit 2
fi

[ "$#" -gt 0 ] || { echo "usage: brief-check.sh <file>... | --hook" >&2; exit 2; }
status=0
for file in "$@"; do
  [ -f "$file" ] || { echo "brief-check: no such file: $file" >&2; exit 2; }
  check "$file" || status=1
done
exit "$status"
