#!/usr/bin/env bash
# bar-guard.sh [base-ref]
#
# Lists the places where the current change may have lowered the quality bar.
# It looks only at lines the change added or removed, never at old code.
# It lists. A reviewer judges: a hit is a question, not a verdict.
#
#   base-ref   what to compare against. Default: the merge base with the
#              default branch (origin/HEAD, origin/main, origin/master, main, master).
#
# Compares the base to the working tree, so committed, staged, unstaged, and
# untracked changes are all covered.
#
# In CI, pass the base explicitly and fetch full history first, for example
# `bar-guard.sh origin/main` after a checkout with fetch-depth 0. On GitHub
# Actions each finding is also printed as a warning annotation.
#
# Exit status: 0 clean, 1 findings, 2 could not run.

set -u

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "bar-guard: not inside a git repository" >&2
  exit 2
}
cd "$(git rev-parse --show-toplevel)" || exit 2

git rev-parse --verify --quiet HEAD >/dev/null || {
  echo "bar-guard: the repository has no commits yet" >&2
  exit 2
}

base="${1:-}"
if [ -n "$base" ]; then
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
    echo "bar-guard: unknown base ref: $base" >&2
    exit 2
  }
else
  for candidate in origin/HEAD origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
      base="$candidate"
      break
    fi
  done
fi

if [ -n "$base" ]; then
  from=$(git merge-base "$base" HEAD 2>/dev/null) || {
    echo "bar-guard: no merge base between $base and HEAD" >&2
    exit 2
  }
else
  base="HEAD"
  from=$(git rev-parse HEAD)
fi

echo "bar-guard: $(git rev-parse --short "$from")..working tree (base: $base)"

untracked_as_diff() {
  git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    [ "$(wc -c <"$f")" -le 1000000 ] || continue
    grep -Iq . "$f" 2>/dev/null || continue
    printf 'diff --git a/%s b/%s\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1 @@\n' "$f" "$f" "$f"
    sed 's/^/+/' "$f"
  done
}

# The awk program uses only double quotes, so it can sit in single quotes here.
scan='
function report(kind, where, text) {
  gsub(/[ \t]+/, " ", text)
  sub(/^ /, "", text)
  if (length(text) > 110) text = substr(text, 1, 107) "..."
  printf "%-13s %s  %s\n", kind, where, text
  if (ENVIRON["GITHUB_ACTIONS"] == "true") annotate(kind, where, text)
  findings++
}
function annotate(kind, where, text,    f, l) {
  f = where; l = ""
  if (match(where, /:[0-9]+$/)) { f = substr(where, 1, RSTART - 1); l = ",line=" substr(where, RSTART + 1) }
  gsub(/%/, "%25", text)
  printf "::warning file=%s%s,title=bar-guard %s::%s\n", f, l, kind, text
}
function is_doc(f)  { return f ~ /\.(md|mdx|rst|txt)$/ }
function is_self(f) { return f ~ /(^|\/)bar-guard\.sh$/ }
function is_test(f) {
  return f ~ /(^|\/)(tests?|__tests__|specs?|e2e)\// || f ~ /(_test\.|\.test\.|\.spec\.|_spec\.)/ || f ~ /(^|\/)test_[^\/]*$/ || f ~ /Tests?\.(java|kt|cs)$/
}
function is_js(f)   { return f ~ /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/ }
function runs_checks(f) {
  return f ~ /(^|\/)\.github\/workflows\// || f ~ /(^|\/)\.husky\// || f ~ /(^|\/)(Makefile|justfile|package\.json|\.pre-commit-config\.yaml|tox\.ini|noxfile\.py|lefthook\.yml|\.gitlab-ci\.yml)$/
}
function configures_checks(f) {
  return runs_checks(f) || f ~ /(^|\/)(QUALITY\.md|pyproject\.toml|setup\.cfg|mypy\.ini|pytest\.ini|ruff\.toml|\.ruff\.toml|\.coveragerc|\.flake8|biome\.json|clippy\.toml|deny\.toml)$/ || f ~ /(^|\/)(\.eslintrc[^\/]*|eslint\.config\.[a-z]+|tsconfig[^\/]*\.json|jest\.config\.[a-z]+|vitest\.config\.[a-z]+|\.golangci\.ya?ml|codecov\.ya?ml)$/
}

/^diff --git / { inhdr = 1; file = ""; old = ""; skip = 1; next }

inhdr && /^--- / { old = substr($0, 5); sub(/^a\//, "", old); next }
inhdr && /^\+\+\+ / {
  file = substr($0, 5); sub(/^b\//, "", file)
  gone = 0
  if (file == "/dev/null") { file = old; gone = 1 }
  testf = is_test(file); jsf = is_js(file); runf = runs_checks(file)
  skip = is_self(file) || is_doc(file)
  if (configures_checks(file)) notes[file] = 1
  if (gone) {
    if (testf && !skip) report("DELETED-TEST", file, "the whole test file was removed")
    skip = 1
  }
  next
}
/^@@ / {
  inhdr = 0
  n = split($0, part, " ")
  pos = part[3]; sub(/^\+/, "", pos); sub(/,.*/, "", pos)
  line = pos + 0
  prev = ""
  next
}
inhdr || skip { next }

/^ / { prev = substr($0, 2); line++; next }

/^-/ {
  if (testf && substr($0, 2) ~ /assert|expect(\.[A-Za-z]+)*\(|\.should|t\.(Error|Fatal)|require\.[A-Z]/) removed[file]++
  next
}

/^\+/ {
  text = substr($0, 2)
  low = tolower(text)
  where = file ":" line

  if (testf && text ~ /assert|expect(\.[A-Za-z]+)*\(|\.should|t\.(Error|Fatal)|require\.[A-Z]/) added[file]++

  if (text ~ /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|istanbul ignore|c8 ignore|# *type: *ignore|# *noqa|pylint: *disable|pyright: *ignore|# *mypy: *ignore|# *nosec|pragma: *no cover|\/\/ *nolint|#!?\[allow\(|@SuppressWarnings|rubocop:disable|NOLINT|@phpstan-ignore/)
    report("SUPPRESSION", where, text)
  else if (jsf && text ~ /(as any([^A-Za-z0-9_]|$)|as unknown as )/)
    report("SUPPRESSION", where, text)

  if (text ~ /(^|[^A-Za-z0-9_])(it|test|describe|context|suite)\.(skip|only|todo)([^A-Za-z0-9_]|$)/ || text ~ /pytest\.mark\.(skip|xfail)|pytest\.skip\(|unittest\.skip|#\[ignore|@Disabled|@Ignore([^A-Za-z]|$)/)
    report("SKIPPED-TEST", where, text)
  else if (jsf && text ~ /(^|[ \t;{])(xit|xdescribe|xtest|fit|fdescribe)\(/)
    report("SKIPPED-TEST", where, text)
  else if (file ~ /\.go$/ && text ~ /\.Skip(f|Now)?\(/)
    report("SKIPPED-TEST", where, text)

  if (text ~ /(^|[^A-Za-z0-9_])(TODO|FIXME|XXX|HACK)([^A-Za-z0-9_]|$)/ || text ~ /NotImplementedError|unimplemented!|todo!\(/ || low ~ /not (yet )?implemented/)
    report("STUB", where, text)

  if (text ~ /catch *(\([^)]*\))? *\{ *\}/ || text ~ /(^|[ \t])except[^:]*: *(pass|\.\.\.) *$/)
    report("EMPTY-HANDLER", where, text)
  else if (prev ~ /^[ \t]*except[^:]*:[ \t]*$/ && text ~ /^[ \t]*(pass|\.\.\.)[ \t]*$/)
    report("EMPTY-HANDLER", where, prev " " text)
  else if (prev ~ /catch *(\([^)]*\))? *\{[ \t]*$/ && text ~ /^[ \t]*\}/)
    report("EMPTY-HANDLER", where, prev " " text)

  if (text ~ /--no-verify|HUSKY=0|(^|[ ;])SKIP=[A-Za-z]/)
    report("BYPASS", where, text)
  else if (runf && text ~ /\|\| *true|continue-on-error: *true|allow_failure: *true|--exit-zero|--passWithNoTests/)
    report("BYPASS", where, text)

  prev = text
  line++
  next
}

END {
  for (f in removed) {
    a = (f in added) ? added[f] : 0
    if (removed[f] > a) report("ASSERTIONS", f, removed[f] " assertion lines removed, " a " added")
  }
  n = 0
  for (f in notes) {
    printf "%-13s %s  check configuration changed: read this diff by hand\n", "NOTE", f
    if (ENVIRON["GITHUB_ACTIONS"] == "true") printf "::notice file=%s,title=bar-guard NOTE::check configuration changed: read this diff by hand\n", f
    n++
  }
  print "---"
  printf "%d finding%s, %d note%s\n", findings, (findings == 1 ? "" : "s"), n, (n == 1 ? "" : "s")
  exit (findings > 0) ? 1 : 0
}
'

{
  git -c core.quotepath=off diff --no-color --no-ext-diff -M -U1 "$from" --
  untracked_as_diff
} | awk "$scan"
