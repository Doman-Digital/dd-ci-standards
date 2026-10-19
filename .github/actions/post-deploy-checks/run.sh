#!/usr/bin/env bash
# ADMIN_RUN_TOKEN comes from the caller's env, never an action input.
# This advisory request must not turn a successful deploy into a failed one.
set +x
set +e
summary() { printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; }
skip() { echo "::warning title=DD Checks::$1"; summary "### DD Checks: not run"; summary "$1"; exit 0; }
[ -n "${ADMIN_RUN_TOKEN:-}" ] || skip "ADMIN_RUN_TOKEN is not set, so post-deploy checks were not requested."
# RFC6750 b64token alphabet: quotes, backslashes and controls cannot alter
# curl's quoted config syntax. Never include the rejected value in output.
case "$ADMIN_RUN_TOKEN" in *$'\n'*|*$'\r'*) skip "The post-deploy token has an invalid format." ;; esac
printf '%s' "$ADMIN_RUN_TOKEN" | LC_ALL=C grep -Eq '^[A-Za-z0-9._~+/-]+=*$' || skip "The post-deploy token has an invalid format."
[[ "$CLIENT" =~ ^[a-z0-9][a-z0-9-]*$ ]] || skip "The client is not a registry slug."
case "$DELAY" in ''|*[!0-9]*) skip "The post-deploy delay must be between 0 and 120 seconds." ;; esac
[ "${#DELAY}" -le 3 ] && [ "$DELAY" -le 120 ] || skip "The post-deploy delay must be between 0 and 120 seconds."
command -v jq >/dev/null && command -v curl >/dev/null || skip "Post-deploy checks need curl and jq on the runner."
[ "$DELAY" -eq 0 ] || sleep "$DELAY"
body=$(jq -cn --arg client "$CLIENT" --arg check "$CHECK" '{client: $client} + (if $check == "" then {} else {check: $check} end)') || skip "The post-deploy request could not be prepared."
out=$(mktemp) || skip "The post-deploy response file could not be created."
trap 'rm -f "$out"' EXIT
# The token travels on stdin. Never print the response or an API error body.
code=$(printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_RUN_TOKEN" |
  curl -q --silent --show-error --config - --max-time 60 \
    --request POST --header 'Content-Type: application/json' --data "$body" \
    --output "$out" --write-out '%{http_code}' 'https://checks.domandigital.co.uk/run' 2>/dev/null) || code=000
[ "$code" = 200 ] || skip "POST /run was refused or unreachable (HTTP $code). The deploy is unaffected."
jq -e '.runs | type == "array"' "$out" >/dev/null 2>&1 || skip "DD Checks returned an unreadable response. The deploy is unaffected."
summary "### DD Checks: post-deploy run for \`$CLIENT\`"
summary ""
summary "| Check | Result | Link |"
summary "| --- | --- | --- |"
jq -r '.runs[] | "| `\(.checkId)` | \(if .how == "inline" then (.status // "?") + (if .code then " (" + (.code | tostring) + ")" else "" end) else .how end) | [dashboard](\(.url)) |"' "$out" >> "$GITHUB_STEP_SUMMARY"
summary ""
summary "Queued form and browser checks report on the dashboard in a few minutes: $(jq -r '.dashboard' "$out")"
bad=$(jq -r '[.runs[] | select(.status == "fail" or .status == "error")] | length' "$out")
if [ "$bad" -gt 0 ]; then
  echo "::warning title=DD Checks::$bad check(s) failed straight after the deploy for $CLIENT. The alert goes out through dd-relay."
fi
exit 0
