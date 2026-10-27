#!/usr/bin/env bash
# Cancels the workflow run this job is part of, so a deploy that the tip guard
# skipped reports `cancelled` instead of `success` (DOM-1422). Nothing here may
# fail the job: a caller that never granted `actions: write` must end exactly
# as it did before this action existed, with a success and a warning.
#
# It cancels only when no other job of the run is still going. Cancelling a run
# stops every job in it, and a caller can hold several deploy calls (one per
# Worker) that reach the guard at different moments: one that is superseded
# must not stop another that is mid-deploy. The last superseded job to finish
# finds nothing else running and cancels. A job named `superseded` is the
# cancelling job of another call and does not count as running.
set -uo pipefail

api="${GITHUB_API_URL:-https://api.github.com}"
wait_seconds="${WAIT_SECONDS:-20}"
run="${api}/repos/${REPO}/actions/runs/${RUN_ID}"
hdr=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")

if ! command -v jq >/dev/null 2>&1; then
  echo "::warning::jq is not on this runner, so the run was not cancelled and will report success. Install jq."
  exit 0
fi

if ! jobs=$(curl -sSf "${hdr[@]}" "${run}/jobs?filter=latest&per_page=100"); then
  echo "::warning::Could not read this run's jobs, so it was not cancelled and will report success. Give the calling job permissions: actions: write (CI-030)."
  exit 0
fi

busy=$(jq -r '[.jobs[] | select(.status != "completed") | select(.name | test("(^|/ )superseded$") | not) | .name] | join(", ")' <<<"$jobs")
if [ -n "$busy" ]; then
  echo "::notice::Superseded, but ${busy} is still running in this run, so the run was not cancelled. The last job to finish cancels it."
  exit 0
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${hdr[@]}" "${run}/cancel") || code=000
case "$code" in
  202)
    echo "Cancel accepted: this run reports cancelled, not success." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    # GitHub stops this job when the cancel lands. Outliving the wait means it did not.
    sleep "$wait_seconds"
    echo "::warning::The cancel was accepted but this job is still running after ${wait_seconds}s. The run will report success."
    ;;
  409) echo "::notice::The run is already finishing or cancelled." ;;
  403|404) echo "::warning::Not allowed to cancel this run, so it will report success, as a deploy skipped by the tip guard did before. Give the calling job permissions: actions: write (CI-030)." ;;
  *) echo "::warning::Cancelling the run answered HTTP ${code}, so it will report success." ;;
esac
exit 0
