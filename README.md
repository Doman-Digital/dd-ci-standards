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

It also rewrites the lines the rulebook decides: each job's `runs-on`
(CI-022, below).

So the adopting PR is green on arrival, and every piece of existing debt has
a line in the repo and a date. When the date passes the finding fails again.
A second run changes nothing. `--dry-run` prints the plan. `--only CI-022`
writes that rule's fix and nothing else, for a repo that adopted before the
rule existed.

### Runner pools

Which runner a job uses is decided here, never in the repo (CI-022,
DOM-834). dd-ci-01 has two pools: the standard one (`vars.CI_RUNNER`,
4 vCPU) and the light one (`vars.CI_RUNNER_LIGHT`, `dd-ci-light`, 2 vCPU and
3 GiB). A job's own `timeout-minutes` places it:

| The job | runs-on |
| --- | --- |
| `timeout-minutes` of 5 or less | `${{ vars.CI_RUNNER_LIGHT \|\| vars.CI_RUNNER \|\| 'ubuntu-latest' }}` |
| a longer timeout, one set by an expression, or `services:` / `container:` | `${{ vars.CI_RUNNER \|\| 'ubuntu-latest' }}` |

The 5 is `LIGHT_MAX_TIMEOUT` in `lib/rules.mjs`. Measured over the 7 days
to 19 October 2026, the jobs it moves finish in a median of under a
minute (the monorepo's `changes` 0.65 minutes over 204 runs, its gate 0.17).
A job that runs out of time on the light pool had the wrong timeout: raise
it and the rule moves the job back. Both expressions fall back to the pool
the job used before when a variable is unset, and both variables are
private to the organisation's private repos, so a public repo never reaches
either (CI-002 still fails it). `dd adopt` rewrites `runs-on`; nothing else
in the job changes.
### Making a repo

**GitHub's included minutes (CI-028, DOM-1079).** The Enterprise plan includes
50,000 GitHub-hosted minutes a month on an Actions budget of $0, so a job may
run there only if `hosted-jobs.json` lists it (repo, workflow file, job id),
and then as `${{ vars.CI_RUNNER_HOSTED || vars.CI_RUNNER || 'ubuntu-latest' }}`.
The organisation variable `CI_RUNNER_HOSTED` is `ubuntu-latest` until
`dd-ci-hosted-valve` (dd-netcup-config `alerts/ci-hosted-valve.py`) reads 90%
of the allowance and sets it to `dd-ci-ephemeral`; it sets it back when the
billing month rolls over. CI-022 leaves a job on the variable to CI-028, and
CI-028 reports a job on the variable that is not listed, a listed job that
left it, and a listed job whose `runs-on` is not the expression above. The
list is empty until the organisation's plan reads `enterprise`.

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
   `in-development`, `doman-digital`), auto-merge and delete-branch-on-merge
   turned on (REG-004), and the first commit on `main`;
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
invalid, expire within 14 days, or exempt nothing (the rule finds nothing in
that file, so the exemption would hide the next real finding unreviewed).
Remove those. The old
`# ci-standards: allow-double-run <reason>` comment still works, and is
reported as undated.

This exists because CI cost across the portfolio grew unchecked, with 400+
Actions runs/month in two repos, an 18-PR
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
      # A private repo passes its runner pool; nothing else is configured here.
      # with:
      #   runner: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
  ```

  The caller is the same in every repo, and `dd adopt` writes it. Anything
  that differs between repos lives in a register here, read by the workflow
  at the same release:

  - **`scanners.json`**: the repos that also run Semgrep (`p/default` over
    each PR's changed files, a step of the same job).

  **One scanner per kind of commit.** Pull requests are scanned by this
  workflow. Default branches are scanned by the estate sweep in
  Doman-Digital/dd-repo-registry, over every repo the GitHub App sees: the
  last 26 hours daily, all of history weekly. A repo needs no gitleaks,
  TruffleHog or Semgrep workflow of its own, and CI-015 fails one. On
  20 October 2026 (DOM-776) the separate scans in the monorepo,
  MMM-Beauty, mmm-beauty-app, beautyops and sen-sphere went, a VM and a
  full-history clone each.

  **Turbo monorepos** scope pull request work with
  `.github/actions/workspace-scope` (`uses:
  Doman-Digital/dd-ci-standards/.github/actions/workspace-scope@v1`): the
  workspaces a PR changes and their dependents, or every workspace when a
  file outside them changes. CI-025 reports a PR `turbo run` without it.

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
  shouldn't be swapped blind without a run to verify the migration). Adopt
  one repo at a time, confirming each with a green run on the repo's runner.

- **`.github/actions/post-deploy-checks`**: use this composite step after
  deployment in the same job. It requests DD Checks without another runner
  boot or queue wait (DOM-776 audit pattern 10, CI-021):

  ```yaml
  - name: Request post-deploy checks
    uses: Doman-Digital/dd-ci-standards/.github/actions/post-deploy-checks@v1
    with:
      client: rmp-electrical
      delay_seconds: "30"
    env:
      ADMIN_RUN_TOKEN: ${{ secrets.ADMIN_RUN_TOKEN }}
  ```

  Inputs are the client slug, optional check id and a delay from 0 to 120
  seconds. The runner needs Bash, curl and jq. Pass the optional token only
  through the step environment. A missing token, refused request, invalid
  response or failing check warns without failing the deployment. The token
  goes to curl on stdin; raw response and error bodies aren't printed.
  Existing client sign-off rules still apply.

- **`.github/workflows/post-deploy-checks.yml`**: legacy reusable workflow (DD
  Checks C29). After a successful production deploy it calls `POST /run` on
  `checks.domandigital.co.uk`, so the client's `http`, `domain`, `form` and
  `browser` checks run now rather than at their next slot (Schedule A s.2,
  "after any platform change"), and it lists each check with its dashboard
  link in the job summary. Its interface remains available for existing callers;
  migrate to the composite above to avoid the additional runner. Legacy call:

  ```yaml
  checks:
    needs: deploy
    uses: Doman-Digital/dd-ci-standards/.github/workflows/post-deploy-checks.yml@v1
    with:
      client: rmp-electrical   # the slug in config/clients.registry.json
    secrets:
      ADMIN_RUN_TOKEN: ${{ secrets.ADMIN_RUN_TOKEN }}
  ```

  A host that deploys outside Actions triggers the caller on
  `deployment_status` and gates the job on `state == 'success'` and
  `environment == 'Production'`. Inputs: `check` (one check id), `delay_seconds`
  (default 30, so the release is serving), `runner`.

  `ADMIN_RUN_TOKEN` is Doppler `dd-checks`/`prd`. Set it as a secret on the
  calling repo; client repos sit in their own GitHub accounts, so an
  organisation secret does not reach them. It is never a `with:` input and
  never in this repo. The token goes to curl on stdin, and the response is
  read field by field into the summary, never printed. The run never fails the
  deploy: a missing token, a refused call or a failing check is a warning
  annotation and a summary line, and the alert for a failing check goes
  through dd-relay as for any scheduled run. A form check withheld for want
  of a client's `syntheticSignOff` cannot be forced from here.

- **Deploying a Worker** (DOM-776, 13 October 2026). Every Cloudflare
  Worker has one deploy path, and **`deploys.json`** lists them all: the
  Worker, its account, its repo and config, and the path. CF-001 fails a repo
  with a wrangler config that is not listed, or deployed both ways. When an
  Actions deploy runs wrangler inside a script (client-previews'
  `deploy-sites.yml`), the entry's `workflow` field names that workflow, so
  CF-001 can see it.

  | Path | For | How |
  | --- | --- | --- |
  | `actions` | every internal Worker, and anything with checks, migrations, secrets or several Workers to deploy | `.github/workflows/cloudflare-deploy.yml` after CI passes on main |
  | `workers-builds` | a simple client static site, nothing to gate | Cloudflare's GitHub app builds main |
  | `manual` | none by choice: listed so it is visible, with the path it moves to in `target` | `wrangler deploy` from a workstation |
  | `retired` | a Worker that no longer serves anything; deleting it is the founder's call | nothing |
  | `not-deployed` | a wrangler config with no Worker in any account (a template or a spike) | nothing |

  The shared workflow ships only the commit CI tested, and only while it is
  still the tip of main (CI-014). It fetches the deploy token from Doppler
  `dd-deploy/<config>` with the repo's GitHub identity, so no Cloudflare
  token is stored in GitHub (SEC-007), and deploys of one repo queue rather
  than cancel (CI-013). Main CI is never cancelled by a newer push (CI-012):
  each run finishes, and the guard lets only the newest one deploy, so a
  burst of merges ends with the newest commit live.

  ```yaml
  on:
    workflow_run:
      workflows: [CI]
      types: [completed]
      branches: [main]
    workflow_dispatch:
  permissions:
    contents: read
  jobs:
    deploy:
      permissions:
        contents: read
        id-token: write
      uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1
      with:
        doppler-config: relay          # Doppler dd-deploy/relay holds CLOUDFLARE_DEPLOY_VALUE
        configs: |
          wrangler.jsonc
        pre-deploy: node scripts/check-migrations.mjs   # optional
  ```

  Runtime secret sync can opt into `sync-secrets-filter`, a repository Node
  script receiving Doppler JSON on stdin and emitting a filtered JSON object.
  Use it to keep CLI credentials, metadata and unused provider keys out of a
  Worker's binding budget. It must validate the complete input before writing
  output and keep values out of diagnostics. An empty input preserves the
  existing unfiltered sync. Both paths retain pipefail and the existing tip,
  CI and migration gates. Filtering does not remove existing Worker secrets.

  Setting up a repo for it, once: a deploy token in Doppler
  `dd-deploy/<config>` as `CLOUDFLARE_DEPLOY_VALUE` (Workers Scripts edit
  on that one account, with an expiry date; add Workers Routes edit on the
  zone only when the wrangler config has a route or custom domain, and the
  edit permission of any binding wrangler creates), a Doppler service account
  identity that trusts the repo's default branch, and the repo variable
  `DOPPLER_IDENTITY_ID`, plus `CLOUDFLARE_ACCOUNT_ID` when the token can see
  more than one account. The identity and both variables come from one row
  in `doppler-identities.json`: add the row (repo, branch, the configs it
  reads, the Cloudflare account), then `node bin/doppler-identity.mjs
  <owner/repo>` with the owner's Doppler sign-in creates the service account
  and identity, sets the variables and writes the identity id back into the
  row; commit it. SEC-009 fails a repo that signs in without its row, without
  the variable, or with a value that differs from the row. Rows with no
  `service_account` were made by hand before the script; rerunning it for
  them creates a new `ci-<repo>` account. `tokens.json` records every Cloudflare token by
  name, account, observed scope, where it is stored and a verdict (keep,
  narrow or retire): never a value.

  A deploy that has its own workflow (a monorepo service with staging first)
  keeps it, with the same three properties: the
  `.github/actions/deploy-tip` step first, the tested commit checked out,
  and `cancel-in-progress: false`.

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

  House packages (`@domandigital/*`) are the other exception: their own
  "house packages" group, at any time, `rangeStrategy: "bump"`, automerged
  once CI is green. `renovate.yml` runs every day for them; everything else
  still waits for Monday. Automerge waits for the repo's checks: the preset no
  longer sets `requiredStatusChecks: null`, which Renovate reads as
  `ignoreTests: true`, merge without waiting. Renovate's own commit statuses
  are off (`statusCheckNames`), because the App that runs it can read statuses
  but not write them, and the 403 aborted every repo (DOM-1043).

  A repo that falls behind anyway fails PKG-001: `dd doctor` reads the craft
  versions the lockfile resolves for the repo's own packages, reads the
  catalogue each release carries from its npm tarball (cached by version),
  and compares it with `floors.json`, the oldest catalogue copy-check trusts.
  claude-kit's `tools/copy_check.py` holds the same number; it is private and
  the policy check runs on each caller's token, so the doctor's copy is here.

  Renovate updates a lockfile by running `pnpm install --lockfile-only` in its
  folder, with no way to add `--ignore-workspace`. A nested project that sits
  inside the root pnpm workspace without being one of its packages (an
  `astro/` beside `apps/*`) therefore never gets its lockfile updated: pnpm
  installs the root workspace and exits 0, and the next frozen install fails
  (MMM-Beauty #722, DOM-1273). PKG-002 reports that layout; the fix is a
  `pnpm-workspace.yaml` with `packages: []` in the nested folder.
  Raise both together. Where a claude-kit checkout is present, `dd doctor`
  says when they differ.

## Every pull request names its issue (LIN-001, LIN-002)

The policy check reads the pull request it runs on (the Actions event file)
and fails one that names no Linear issue. It reads the title and description
the way dd-relay does when it moves Linear on a merge (`CLOSES_RE`,
`PART_OF_RE` and `BRANCH_RE` in `dd-relay/src/github-webhook/webhook.ts`,
copied into `lib/rules.mjs`):

- a `Closes DOM-123` or `Part of DOM-123` line (also `Fixes`, `Resolves`;
  `CRO-7` works too) in the title or description, or
- the key at the start of the branch name, `dom-123-short-name`, or
- the `no-issue` label, for work that has no issue.

A key mentioned in passing (`see DOM-123`) does not count, because the relay
ignores it too. Renovate and Dependabot branches are exempt. It warns from
21 October 2026 and fails from 28 October (27 October 2026, DOM-1363: the
reading tightened to the relay's, and the `no-issue` label arrived).

**LIN-002** warns when a closing word sits inside backticks, a code block, a
`>` quote or double quotes beside a key the pull request does not claim as its
own (a Closes or Part of line outside the quote, or the branch). The Linear
GitHub app, installed on the whole org, reads closing words anywhere, so a
quoted `Closes DOM-1014` in dd-claude-kit#178 closed DOM-1014 on 26 October
2026. When you mention another issue write `names DOM-n`, never `closes DOM-n`.
It warns until 25 January 2027, the 90-day limit, then fails.

**Where it runs.** In the org, the `dd-policy-required` ruleset (DOM-1084, active
from 27 October 2026) runs `policy.yml@v1` on every private repo, so the check
needs nothing in the repo. Client repos on other accounts keep their caller.

**After fixing a failing PR, push a commit** (`git commit --allow-empty` will
do). Editing the title or description, or adding the label, does not start the
check again: a ruleset run ignores `edited`, `labeled` and `unlabeled` in its
workflow's `types` (probed on dd-photo-pack#22, 27 October 2026), and a re-run
reads the PR as it was when the run began.

Why: on 20 October 2026 the founder found client work shipping with nothing
in Linear or HubSpot to show for it. Since 22 July, 640 of the 869 pull
requests merged into the client repos named no issue (DOM-1100). The rule
runs wherever the policy check runs, so every client repo that calls it, and
every private org repo through the org ruleset, is covered at once.

Outside a pull request (`dd doctor` on a machine, the estate sweep)
there is no pull request to read, and the rule is not checked.

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

Never pin a caller to a release (`@v1.0.22`, `#v1.0.13`): a pinned caller
stops getting rules. Renovate did exactly that to several callers, and
`policy.yml` itself ran `doctor@v1.0.13` until 13 October 2026, so every PR
gate ran 5 October's rules. `default.json` now leaves this repo alone, and
FW-003 fails a pin.

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
New rules, warning until 31 December 2026: CI-001, CI-008, SEC-001,
SEC-002, SEC-003, SEC-005, SEC-006, REG-003. SEC-004 (a tracked file of
secrets) enforces from 18 October 2026. CI-002 (self-hosted runners in a public repo)
fails from the start.

DOM-776 follow-up rules CI-021 and SEC-008 warn from 15 October 2026 and
are enforced from 15 November. CI-021 finds the legacy post-deploy workflow
at job level; SEC-008 finds a workflow without a top-level permissions
block. These are structural checks, not a full assessment of the granted
permissions. Existing rule semantics and dates are unchanged.

DOM-834 rule CI-022 warns from 20 October 2026 and is enforced from 20
November: a job runs on the runner pool its timeout gives it (Runner pools,
above). `dd adopt` writes the fix; `dd adopt --only <rules>` writes only
those rules' fixes.

DOM-834 rule CI-029 warns from 20 October 2026 and is enforced from 20
November: a deploy job (not a dry run, a preview or a pull request workflow)
runs on `${{ vars.CI_RUNNER_DEPLOY || vars.CI_RUNNER || 'ubuntu-latest' }}`,
the reserved deploy slot `dd-ci-deploy`, so it never waits behind pull request
CI. `cloudflare-deploy.yml` reads the same variable. `dd adopt` writes the fix.

Guards from DOM-776 step 5, each warning from 20 October 2026. Every one of
them also runs daily over the whole estate in the estate sweep
(dd-repo-registry), so a repo that drifts is reported even with no PR open.

- **CI-015** (reworded; fails from 14 November): any scanner workflow beside
  the policy check, whatever triggers it.
- **CI-023** (fails from 27 October): a workflow or composite action line
  (not a comment) names Vercel. A site still served by Vercel records an
  exemption with the date it moves.
- **CI-024** (fails from 27 October): a workflow or composite action names
  one of the persistent runners, `dd-ci-01-a` to `dd-ci-01-h`.
- **FW-004** (fails from 27 October): a house workflow or action
  (`Doman-Digital/...` or `Megameehunnah/...`) is pinned to a branch. Use
  `@v1`, a release tag or a full commit SHA.
- **CI-025** (fails from 20 November): a Turbo monorepo's PR job runs
  `turbo run` over every workspace.
- **CI-026** (fails from 20 November): budget.yml registers a schedule the
  repo no longer has, the reverse of CI-007.
- **CI-028** (fails from 20 November): a job runs on `CI_RUNNER_HOSTED`
  without being listed in `hosted-jobs.json`, or is listed and does not.
- **CI-027** (fails from 27 October): a job in a cancellable pull request
  workflow runs with `always()`. GitHub runs it even after the run is
  cancelled, so the cancelled run holds its concurrency group until a VM is
  free for it. Use `!cancelled()`: a cancelled run then reports the job
  cancelled, which still blocks a merge.
- **REG-007** (fails from 27 October): the default branch's ruleset requires
  a check that no workflow job produces, so every PR waits for it.
- **REG-008** (fails from 28 October): the default branch has a merge queue,
  and a workflow that produces a required check does not run on
  `merge_group`, so the queue waits for a check that never starts. Add
  `merge_group:` and keep anything live to push, schedule or a manual run. The
  caller `dd adopt` writes has the trigger (DOM-1262).

The estate sweep in dd-repo-registry raises ids of its own (REG-001, REG-005,
REG-006, DEL-, SEC-101 to SEC-105, EST-, JOB-, DEP-) into the same report. It
fails its run when one of those ids is also in rules.json, so pick a new id
here rather than reuse one (REG-007 was REG-005 for its first day).

The policy checkout keeps full commit history with `filter: blob:none`.
Private historical blobs fetched by the secret scan use the existing job
token through process-scoped Git configuration. Credentials are neither
persisted in the checkout nor passed in process arguments. The regression
uses a real filtered local repository and protected HTTP endpoint, with an
unauthenticated negative control. Composite tests execute its actual script
against a local command stub; they never contact DD Checks or deploy.
