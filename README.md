# ci-standards

Shared CI policy, cost registry, and Renovate preset for the Doman Digital
portfolio (15 repos across 8 GitHub accounts as of 2026-08-16). Public
because both Renovate's cross-owner `extends` and GitHub's cross-owner
reusable workflows require it. Nothing in here is a secret: callers pass
their own via `secrets: inherit`.

**Status:** in use, consumed by tag (`@v1`, which moves with every release since 2026-10-03).
**Used by:** every repo whose CI calls `policy.yml` or whose Renovate config extends `default.json`, the `dd` command, and the estate sweep in `dd-repo-registry`.

## The DD Framework rulebook

Since 3 October 2026 this repo is the rulebook of the DD Framework: one
versioned set of rules that every Doman Digital repo is checked against, the
same way in three places.

| Where | How |
| --- | --- |
| On your machine | `node <dd-ci-standards checkout>/bin/dd.mjs doctor <repo>` (npx from GitHub is blocked where npm has `allow-git` off, as on dd-main-01) |
| On every PR | `policy.yml` (below), which runs the `doctor` action |
| Daily, every repo | the estate sweep in `Doman-Digital/dd-repo-registry` |

- **`rules.json`**: each rule's id, the incident it came from, the repo kinds
  it applies to, and two dates. From `warn_from` it is reported; from
  `enforce_from` it fails. The two are at most 90 days apart, so a new rule
  warns everyone first and nothing warns forever. `dd rules` lists them with
  today's level.
- **`lib/rules.mjs`**: the checks. **`lib/engine.mjs`**: which rules apply to
  a repo's kind and visibility on a date, and exemptions.
- **`test/fixtures.mjs`**: a failing and a passing example of every rule. The
  tests fail if a rule has none, so no rule ships that has not been seen to
  catch its own target.
- **`bin/dd.mjs`**: the command. `dd doctor` reports; `dd adopt` brings a
  repo up to the rules (`lib/adopt.mjs`); `dd new` makes a repo that starts
  compliant (`lib/new.mjs`).

### Adopting a repo

`dd adopt <repo checkout>` makes one reviewable change:

- writes the files the framework owns: the policy check caller
  (`.github/workflows/ci-standards-policy.yml`) and a `renovate.json`
  extending the shared preset, or corrects one that uses the old name;
- records everything else the doctor finds in `.github/dd.json` as
  exemptions that expire in 60 days.

So the adopting PR is green on arrival, and every piece of existing debt has
a line in the repo and a date. When the date passes the finding fails again.
A second run changes nothing. `--dry-run` prints the plan.
### Making a repo

```sh
node <dd-ci-standards checkout>/bin/dd.mjs new --kind dd-site dd-example \
  --description "What the repo is, in a sentence." --answers answers.json
```

In order, and stopping at the first failure:

1. `create-next-app` (or `create-astro` with `--framework astro`), `pnpm
   install`, then `@domandigital/create-site` with the repo's visibility;
2. `dd adopt`, then `dd doctor`, which must be clean: nothing failing,
   warning or exempt. A starter that needs an exemption on its first day is a
   bug in the starter, so nothing is made on GitHub;
3. the repo in Doman-Digital with its description and tags (kind,
   `in-development`, `doman-digital`), and the first commit on `main`;
4. a ruleset on `main`: pull requests only, and the policy check
   (`ci-standards-policy / check`) required, so a PR that breaks a rule past
   its enforce date cannot merge. GitHub's Free plan has no
   rulesets for private repos; there `dd new` says the repo is unprotected
   instead of pretending;
5. a pull request on `Doman-Digital/dd-repo-registry` adding its entry.

Deleting a repo made this way needs its registry entry removed too (close
the PR if it has not merged), or the sweep reports it every morning as
REG-005, registered but not visible.

`--dry-run` prints the plan; `--local` stops after step 2 (the nightly
starter job in dd-packages uses it); `--create-site <cli.js>` runs a
create-site build instead of the published one. It needs a token that can
create repos in the organisation (`GH_TOKEN`, or `gh auth login`).

It refuses `client-site` and `client-app`: client repos are pushed and merged
by the Doman Digital GitHub App, from the client work's own tooling. It also
refuses `personal` and `it-portfolio` (outside the framework) and any owner
but Doman-Digital (personal-account repos cannot run Actions).
- **`doctor/action.yml`**: the same command as a GitHub Action.
- **`lib/view-github.mjs`**: the same repo view read through the API, which
  the estate sweep uses, so it runs exactly these rules.

Kinds come from `repo-topics.json`. Organisation sites, products and tooling
and client sites and apps get every rule; `sales-demo` gets the light set;
`personal` and `it-portfolio` repos are outside the framework.

### Exemptions

An exemption is written where the next reader is standing, with a reason and
an end date at most 180 days away:

```yaml
# dd: allow CI-005 until=2027-01-31 secret-scan backstop that must re-run on main
```

or, for a repo-wide one, in `.github/dd.json`:

```json
{ "exempt": [{ "rule": "CI-001", "file": ".github/workflows/sweep.yml", "until": "2027-01-31", "reason": "needs pipx" }] }
```

An exemption counts only with a reason and a date inside the limit.
When it expires the finding comes back. FW-002 reports exemptions that are
invalid or expire within 14 days. The old
`# ci-standards: allow-double-run <reason>` comment still works, and is
reported as undated.

This exists because CI cost across the portfolio grew unchecked until it
tripped a billing block, with 400+ Actions runs/month in two repos, an 18-PR
Dependabot fan-out in one afternoon, crons added with no registry anywhere.
The point of this repo is to be the ceiling that holds by itself: new waste
has to pass a policy check to merge, not get caught in the next audit.

## What's in here

- **`budget.yml`**: the registry of every recurring cost: GitHub Actions
  `schedule:` crons and Vercel `crons:` entries, one entry per repo, each
  with a reason. `scripts/check-workflow-policy.mjs` fails a PR that adds a
  schedule or Vercel cron not listed here.
- **`.github/workflows/policy.yml`**: reusable workflow, call it from any
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

  # The check only reads the repo.
  permissions:
    contents: read

  jobs:
    ci-standards-policy:
      uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1
  ```

  Checks: push+pull_request double-runs on overlapping branches, jobs
  missing `timeout-minutes`, PR-triggered workflows missing a `concurrency`
  cancel group, unregistered crons (GitHub Actions and Vercel), and
  `continue-on-error: true` with no explanatory comment.

  Two of those take an in-file opt-out, because the intent belongs where the
  next reader is standing rather than in a config file they won't open:

  - `continue-on-error: true` is accepted with a comment in the three lines
    above it.
  - A deliberate double-run is accepted with a
    `# ci-standards: allow-double-run <reason>` comment anywhere in the
    workflow. Use it for a genuine backstop: a secret scan or commit-author
    check that re-runs on push to main catches whatever reaches main without
    a PR, which is the exact case branch protection can be bypassed for.
    Scoping push to a non-overlapping branch there would delete the coverage,
    not the waste.

  Neither opt-out is a way to silence the gate on ordinary waste. A full
  test suite re-running on push to main is the thing this rule exists for.

- **`.github/workflows/node-ci.yml`**: reference reusable CI for a single
  pnpm/Node app. **Not yet adopted anywhere**: see the comment at the top
  of the file for why (existing repo CI reflects real tested logic that
  shouldn't be swapped blind while Actions billing is blocked and no run
  can verify the migration). Adopt one repo at a time once that clears.

- **`default.json`**: shared Renovate preset. Weekly Monday-morning window,
  concurrency caps, majors grouped by manager (the fix for an 18-PR fan-out
  where individually-grouped minors still let every major land separately),
  automerge on devDependencies and patch bumps only. Vulnerability handling
  is the deliberate exception to all of the above: `osvVulnerabilityAlerts`
  + `vulnerabilityAlerts` bypass the weekly schedule and concurrency cap
  entirely (`schedule: "at any time"`, `prConcurrentLimit: 0`): a real CVE
  gets an immediate PR, everything else stays batched.

  Two supply-chain defaults sit on top. `minimumReleaseAge: "3 days"` holds
  every third-party update until the release is three days old, long enough
  for a compromised release (tj-actions, March 2025) to be caught and pulled
  before it reaches us; Renovate raises security updates immediately
  regardless. `helpers:pinGitHubActionDigestsToSemver` pins each
  third-party action to a commit SHA with the version as a comment, so a
  re-pointed tag can't change what runs. Our own repos are exempt from both:
  the wait protects against someone else's release, and `@v1` stays a tag
  on purpose (see Versioning).

## Repo description and tags

Every repo must be identifiable from its GitHub page alone. `repo-topics.json` sets the rule:

* **A description**, 350 characters at most, with no em or en dashes.
* **Exactly one kind tag:** client-site, client-app, sales-demo, dd-site, dd-tooling, dd-product, personal or it-portfolio.
* **Exactly one status tag:** live, in-use, in-development, concept, demo-expired, reference or unverified.
* **A client-<name> tag** on client sites and apps, and **doman-digital** on everything except personal and it-portfolio repos.
* **Tech tags** from the list only.

It is enforced twice. The policy workflow fails any PR whose repo breaks the rule (REG-002), and the estate sweep in dd-repo-registry checks every repo daily, including the ones nobody opens a PR on and any new repo not yet registered. Add a word to `repo-topics.json` before using it anywhere.

## Versioning

Callers use `@v1`. Every merge to `main` is a release: `release.yml` runs the
tests, tags `v1.0.<next>` and moves `v1` to it, so every caller runs the new
rules on its next PR. A new rule is safe to release this way because it only
warns until its `enforce_from` date. A breaking change to how callers call
`policy.yml` needs `v2`.

This replaces the earlier rule here, "bump the tag deliberately; no existing
tag is retargeted". Under it `v1` sat at 2026-09-25 while `v1.0.1` and
`v1.0.2` carried fixes most callers never received, and Renovate, which was
meant to bump the pins, opened no routine update anywhere for a month
(`renovate.yml` explains why). Decided 2026-10-03 with the DD Framework plan.

### v1.0.1

Registers the existing main-repository weekly review calibration job with its owner, purpose and 120-minute cap.

### v1.0.2

Registers the weekly client-stack capture cron (#11) for consumers.

### v1.0.6

`dd new` (`lib/new.mjs`). budget.yml registers dd-packages' nightly starter check.

### v1.0.5

`dd adopt` (`lib/adopt.mjs`).

### v1.0.4

The repo view through the API (`lib/view-github.mjs`), used by the estate sweep.

### v1.0.3

The rulebook (`rules.json`), `dd doctor`, the `doctor` action, `release.yml`.
The six original checks keep their behaviour and gain ids (CI-003 to CI-007,
CI-011), with one fix: the cron check read only the first cron under
`schedule:`, which hid this repo's own Renovate cron and one in sen-sphere.
New rules, warning until 31 December 2026: CI-001, CI-008, CI-009, SEC-001,
SEC-002, SEC-003, SEC-005, SEC-006, REG-003. SEC-004 (a tracked file of
secrets) enforces from 18 October 2026. CI-002 (self-hosted runners in a public repo)
fails from the start.
