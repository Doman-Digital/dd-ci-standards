#!/usr/bin/env bash
# The workspace-scope action's logic (action.yml says what it decides).
# Inputs from the environment: EVENT_NAME, BASE_SHA, INCLUDE, DOCS,
# GITHUB_OUTPUT. Needs git, node and `pnpm exec turbo`.
set -euo pipefail
root_name=$(node -p 'require("./package.json").name || ""' 2>/dev/null || true)
all() {
  echo "Scope: every workspace ($1)"
  {
    echo "run=true"
    echo "turbo-filters="
    echo "pnpm-filters=${root_name:+--filter=!$root_name}"
  } >> "$GITHUB_OUTPUT"
  exit 0
}
[ "$EVENT_NAME" = pull_request ] || all "not a pull request"
# A pull request's checkout is its merge commit: the first parent is the base
# it was merged onto, which is exactly what the PR changes.
if git rev-parse -q --verify HEAD^2 >/dev/null; then
  base=$(git rev-parse HEAD^1)
else
  base=${BASE_SHA:-}
fi
[ -n "$base" ] || all "no base commit"
packages=$(pnpm exec turbo ls --output=json 2>/dev/null)
dirs=$(printf '%s' "$packages" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).packages.items)if(p.path&&p.path!==".")console.log(p.path)})')
[ -n "$dirs" ] || all "no workspaces found"
outside=$(git diff --name-only "$base" HEAD | node -e '
  const dirs = process.argv[1].split("\n").filter(Boolean).map((d) => d.replace(/\/$/, "") + "/");
  const docs = new RegExp(process.argv[2]);
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    for (const f of s.split("\n").filter(Boolean)) if (!dirs.some((d) => f.startsWith(d)) && !docs.test(f)) console.log(f);
  });' "$dirs" "$DOCS")
if [ -n "$outside" ]; then
  echo "Changed outside every workspace:"
  printf '%s\n' "$outside" | head -20
  all "a shared file changed"
fi
names=$(TURBO_SCM_BASE="$base" TURBO_SCM_HEAD=HEAD pnpm exec turbo ls --affected --output=json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).packages.items)console.log(p.name)})')
# shellcheck disable=SC2086 # INCLUDE is a space-separated list
names=$(printf '%s\n' $names $INCLUDE | sort -u | grep -v '^$' || true)
if [ -z "$names" ]; then
  echo "Scope: no workspace is affected"
  echo "run=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
echo "Scope:" $names
# shellcheck disable=SC2086
filters=$(printf -- '--filter=%s ' $names)
{
  echo "run=true"
  echo "turbo-filters=$filters"
  echo "pnpm-filters=$filters"
} >> "$GITHUB_OUTPUT"
