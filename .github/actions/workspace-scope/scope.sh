#!/usr/bin/env bash
# The workspace-scope action's logic (action.yml says what it decides).
# Inputs from the environment: EVENT_NAME, BASE_SHA, INCLUDE, DOCS,
# INDEPENDENT (optional), GITHUB_OUTPUT. Needs git, node and `pnpm exec turbo`.
set -euo pipefail
INDEPENDENT=${INDEPENDENT:-}
# Independent paths, normalised: one per line, no leading ./ or trailing /.
indep=$(printf '%s\n' $INDEPENDENT | sed -e 's#^\./##' -e 's#/*$##' | grep -v '^$' || true)
root_name=$(node -p 'require("./package.json").name || ""' 2>/dev/null || true)
all() {
  echo "Scope: every workspace ($1)"
  {
    echo "run=true"
    echo "turbo-filters="
    echo "pnpm-filters=${root_name:+--filter=!$root_name}"
    # Running everything includes every independent path: a shared file may feed them.
    echo "independent=$(printf '%s ' $indep | sed 's/ $//')"
  } >> "$GITHUB_OUTPUT"
  exit 0
}
case "$EVENT_NAME" in
  pull_request | merge_group) ;;
  *) all "not a pull request or merge group" ;;
esac
# A pull request's checkout is its merge commit: the first parent is the base
# it was merged onto, which is exactly what the PR changes. A merge group's
# checkout is the queue's commit on top of every entry ahead of it, so its first
# parent is not the base: BASE_SHA is the group's base (main), and the diff
# against it covers everything the group adds.
if [ "$EVENT_NAME" = pull_request ] && git rev-parse -q --verify HEAD^2 >/dev/null; then
  base=$(git rev-parse HEAD^1)
else
  base=${BASE_SHA:-}
fi
[ -n "$base" ] || all "no base commit"
packages=$(pnpm exec turbo ls --output=json 2>/dev/null)
dirs=$(printf '%s' "$packages" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).packages.items)if(p.path&&p.path!==".")console.log(p.path)})')
[ -n "$dirs" ] || all "no workspaces found"
# Classify every changed file: under an independent path (own lockfile and test
# job, so the root workspaces never see it), documentation, or outside every
# workspace (a shared file). Lines come back as "I <path>" or "O <file>".
classified=$(git diff --name-only "$base" HEAD | node -e '
  const under = (f, d) => f === d || f.startsWith(d + "/");
  const dirs = process.argv[1].split("\n").filter(Boolean);
  const indep = process.argv[2].split("\n").filter(Boolean);
  const docs = new RegExp(process.argv[3]);
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const seen = new Set();
    for (const f of s.split("\n").filter(Boolean)) {
      const i = indep.find((d) => under(f, d));
      if (i) { if (!seen.has(i)) { seen.add(i); console.log("I " + i); } }
      else if (!dirs.some((d) => under(f, d)) && !docs.test(f)) console.log("O " + f);
    }
  });' "$dirs" "$indep" "$DOCS")
outside=$(printf '%s\n' "$classified" | sed -n 's/^O //p')
touched=$(printf '%s\n' "$classified" | sed -n 's/^I //p' | tr '\n' ' ' | sed 's/ $//')
if [ -n "$outside" ]; then
  echo "Changed outside every workspace:"
  # sed reads all of its input; `head -20` closes the pipe early, and under pipefail a long list kills the script with SIGPIPE.
  printf '%s\n' "$outside" | sed -n '1,20p'
  all "a shared file changed"
fi
[ -z "$touched" ] || echo "Independent: $touched"
names=$(TURBO_SCM_BASE="$base" TURBO_SCM_HEAD=HEAD pnpm exec turbo ls --affected --output=json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const ind=process.argv[1].split("\n").filter(Boolean);for(const p of JSON.parse(s).packages.items)if(!ind.some(d=>p.path===d||(p.path||"").startsWith(d+"/")))console.log(p.name)})' "$indep")
# shellcheck disable=SC2086 # INCLUDE is a space-separated list
names=$(printf '%s\n' $names $INCLUDE | sort -u | grep -v '^$' || true)
if [ -z "$names" ]; then
  echo "Scope: no workspace is affected"
  {
    echo "run=false"
    echo "independent=$touched"
  } >> "$GITHUB_OUTPUT"
  exit 0
fi
echo "Scope:" $names
# shellcheck disable=SC2086
filters=$(printf -- '--filter=%s ' $names)
{
  echo "run=true"
  echo "turbo-filters=$filters"
  echo "pnpm-filters=$filters"
  echo "independent=$touched"
} >> "$GITHUB_OUTPUT"
