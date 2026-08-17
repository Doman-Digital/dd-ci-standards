# ci-standards

Shared CI policy, cost registry, and Renovate preset for the Doman Digital
portfolio (15 repos across 8 GitHub accounts as of 2026-08-16). Public
because both Renovate's cross-owner `extends` and GitHub's cross-owner
reusable workflows require it — nothing in here is a secret; callers pass
their own via `secrets: inherit`.

This exists because CI cost across the portfolio grew unchecked until it
tripped a billing block — 400+ Actions runs/month in two repos, an 18-PR
Dependabot fan-out in one afternoon, crons added with no registry anywhere.
The point of this repo is to be the ceiling that holds by itself: new waste
has to pass a policy check to merge, not get caught in the next audit.

## What's in here

- **`budget.yml`** — the registry of every recurring cost: GitHub Actions
  `schedule:` crons and Vercel `crons:` entries, one entry per repo, each
  with a reason. `scripts/check-workflow-policy.mjs` fails a PR that adds a
  schedule or Vercel cron not listed here.
- **`.github/workflows/policy.yml`** — reusable workflow, call it from any
  repo's own CI to run the policy check against that repo:

  ```yaml
  name: ci-standards policy

  on:
    pull_request:

  # The gate has to satisfy its own [missing-concurrency] rule. Copy this
  # block along with the job or the policy workflow flags its own file on
  # every PR.
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true

  jobs:
    ci-standards-policy:
      uses: Doman-Digital/ci-standards/.github/workflows/policy.yml@v1
  ```

  Checks: push+pull_request double-runs on overlapping branches, jobs
  missing `timeout-minutes`, PR-triggered workflows missing a `concurrency`
  cancel group, unregistered crons (GitHub Actions and Vercel), and
  `continue-on-error: true` with no explanatory comment.

- **`.github/workflows/node-ci.yml`** — reference reusable CI for a single
  pnpm/Node app. **Not yet adopted anywhere** — see the comment at the top
  of the file for why (existing repo CI reflects real tested logic that
  shouldn't be swapped blind while Actions billing is blocked and no run
  can verify the migration). Adopt one repo at a time once that clears.

- **`default.json`** — shared Renovate preset. Weekly Monday-morning window,
  concurrency caps, majors grouped by manager (the fix for an 18-PR fan-out
  where individually-grouped minors still let every major land separately),
  automerge on devDependencies and patch bumps only. Vulnerability handling
  is the deliberate exception to all of the above: `osvVulnerabilityAlerts`
  + `vulnerabilityAlerts` bypass the weekly schedule and concurrency cap
  entirely (`schedule: "at any time"`, `prConcurrentLimit: 0`) — a real CVE
  gets an immediate PR, everything else stays batched.

## Versioning

Everything is consumed pinned to a tag (`@v1`), not `@main` — a breaking
change to the reusable workflow or the policy script shouldn't silently
break every caller at once. Bump the tag deliberately; let Renovate keep
each repo's pin current via its own PR.
