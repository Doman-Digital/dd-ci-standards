// A failing and a passing example of every rule in rules.json. The tests fail
// if a rule has no pair here, so a rule cannot ship that has never been seen
// to catch its own target (docs/trackers/guards.md in Doman-Digital: four
// guards there were found unable to catch theirs).
//
// ctx is merged over a default context: private dd-tooling repo "demo".

const wf = (text, path = ".github/workflows/ci.yml") => ({ workflows: [{ path, text }], vercel: [], files: {} });
const view = (over) => ({ workflows: [], vercel: [], files: {}, ...over });

const JOB = (runsOn, extra = "") => `on:
  pull_request:
concurrency:
  group: x
  cancel-in-progress: true
jobs:
  test:
    runs-on: ${runsOn}
    timeout-minutes: 10
    steps:
      - run: echo hi
${extra}`;

export const FIXTURES = {
  "CI-001": {
    fail: wf(JOB("ubuntu-latest")),
    pass: wf(JOB("${{ vars.CI_RUNNER || 'ubuntu-latest' }}")),
  },
  "CI-002": {
    ctx: { visibility: "public" },
    fail: wf(JOB("${{ vars.CI_RUNNER || 'ubuntu-latest' }}")),
    pass: wf(JOB("ubuntu-latest")),
  },
  "CI-029": {
    // A push-triggered deploy on the standard pool.
    fail: wf("on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: 15\n    steps:\n      - run: x\n"),
    // On the deploy slot; a dry run in a pull request workflow is CI, not a deploy.
    pass: view({
      workflows: [
        { path: ".github/workflows/deploy.yml", text: "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ${{ vars.CI_RUNNER_DEPLOY || vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: 15\n    steps:\n      - run: x\n" },
        { path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  dry-run-deploy:\n    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: 10\n    steps:\n      - run: x\n" },
      ],
    }),
  },
  "CI-022": {
    // A two-minute job on the standard pool, and a long one on the light pool.
    fail: view({
      workflows: [
        { path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  changes:\n    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: 2\n    steps:\n      - run: x\n" },
        { path: ".github/workflows/build.yml", text: "on:\n  pull_request:\njobs:\n  build:\n    runs-on: ${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: 20\n    steps:\n      - run: x\n" },
      ],
    }),
    pass: wf(`on:
  pull_request:
jobs:
  changes:
    runs-on: \${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 2
    steps:
      - run: x
  build:
    runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 20
    steps:
      - run: x
  db:
    runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 5
    services:
      postgres:
        image: postgres:17
    steps:
      - run: x
  call:
    uses: ./.github/workflows/other.yml
`),
  },
  "CI-003": {
    fail: wf("on:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n"),
    pass: wf("on:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: x\n  b:\n    uses: ./.github/workflows/other.yml\n"),
  },
  "CI-004": {
    fail: wf("on:\n  pull_request:\njobs:\n  a:\n    timeout-minutes: 5\n"),
    pass: wf("on:\n  pull_request:\nconcurrency:\n  group: g\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs:\n  a:\n    timeout-minutes: 5\n"),
  },
  "CI-005": {
    fail: wf("on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs: {}\n"),
    pass: wf("on:\n  push:\n    branches: [release]\n  pull_request:\n    branches: [main]\njobs: {}\n"),
  },
  "CI-006": {
    fail: wf("jobs:\n  a:\n    steps:\n      - run: x\n        continue-on-error: true\n"),
    pass: wf("jobs:\n  a:\n    steps:\n      # advisory: the script never exits non-zero\n      - run: x\n        continue-on-error: true\n"),
  },
  "CI-007": {
    // The second cron, after a comment, was invisible before 2026-10-03.
    ctx: { budget: { ghCrons: [{ workflow: "nightly.yml", cron: "0 3 * * *" }], vercelCrons: [] } },
    fail: wf('on:\n  schedule:\n    - cron: "0 3 * * *"\n    # weekly as well\n    - cron: "0 6 * * 1"\n  workflow_dispatch:\njobs: {}\n', ".github/workflows/nightly.yml"),
    pass: wf('on:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\njobs: {}\n', ".github/workflows/nightly.yml"),
  },
  "CI-008": {
    fail: wf("jobs:\n  a:\n    steps:\n      - uses: actions/upload-artifact@v7\n        with:\n          name: report\n          path: report.json\n"),
    pass: wf("jobs:\n  a:\n    steps:\n      - uses: actions/upload-artifact@v7\n        # a full quota must not fail the job\n        continue-on-error: true\n        with:\n          name: report\n          path: report.json\n"),
  },
  "CI-011": {
    ctx: { budget: { ghCrons: [], vercelCrons: [{ path: "/api/cron/a", schedule: "0 9 * * *" }] } },
    fail: view({ vercel: [{ path: "vercel.json", json: { crons: [{ path: "/api/cron/b", schedule: "0 9 * * *" }] } }] }),
    pass: view({ vercel: [{ path: "vercel.json", json: { crons: [{ path: "/api/cron/a", schedule: "0 9 * * *" }] } }] }),
  },
  "CI-012": {
    // dd-relay, 13 October 2026: every merge cancelled the main run before it.
    fail: wf("on:\n  pull_request:\n  push:\n    branches: [main]\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs: {}\n"),
    pass: wf("on:\n  pull_request:\n  push:\n    branches: [main]\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs: {}\n"),
  },
  "CI-013": {
    fail: wf("on:\n  push:\n    branches: [main]\nconcurrency:\n  group: deploy\n  cancel-in-progress: true\njobs:\n  deploy:\n    steps:\n      - run: npx wrangler deploy\n", ".github/workflows/deploy.yml"),
    // A dry run is not a deploy, and a preview on pull_request may be cancelled.
    pass: { workflows: [
      { path: ".github/workflows/deploy.yml", text: "on:\n  push:\n    branches: [main]\nconcurrency:\n  group: deploy-production\n  cancel-in-progress: false\njobs:\n  deploy:\n    steps:\n      - run: npx wrangler deploy\n" },
      { path: ".github/workflows/ci.yml", text: "on:\n  push:\n    branches: [main]\njobs:\n  check:\n    steps:\n      - run: npx wrangler deploy --dry-run\n" },
      { path: ".github/workflows/preview.yml", text: "on:\n  pull_request:\nconcurrency:\n  group: preview-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  preview:\n    steps:\n      - run: npx wrangler deploy --env preview\n" },
    ], vercel: [], files: {} },
  },
  "CI-014": {
    fail: wf("on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\nconcurrency:\n  group: deploy-production\n  cancel-in-progress: false\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npx wrangler deploy\n", ".github/workflows/deploy.yml"),
    pass: wf("on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\nconcurrency:\n  group: deploy-production\n  cancel-in-progress: false\njobs:\n  deploy:\n    steps:\n      - uses: Doman-Digital/dd-ci-standards/.github/actions/deploy-tip@v1\n        id: tip\n        with:\n          sha: ${{ github.event.workflow_run.head_sha }}\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.workflow_run.head_sha }}\n      - run: npx wrangler deploy\n", ".github/workflows/deploy.yml"),
  },
  "CI-015": {
    // redacted's TruffleHog beside the policy caller, on push to main only:
    // the estate sweep already scans what reaches main.
    fail: { workflows: [
      { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
      { path: ".github/workflows/secret-scan.yml", text: "on:\n  push:\n    branches: [main]\njobs:\n  trufflehog:\n    steps:\n      - uses: trufflesecurity/trufflehog@0000000000000000000000000000000000000000\n" },
    ], vercel: [], files: {} },
    // The policy caller alone; a comment naming gitleaks is not a scanner.
    pass: { workflows: [
      { path: ".github/workflows/ci-standards-policy.yml", text: "# gitleaks runs inside the policy check\non:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
      { path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  test:\n    steps:\n      # was: gitleaks detect\n      - run: pnpm test\n" },
    ], vercel: [], files: {} },
  },
  "CI-016": {
    fail: wf("jobs:\n  e2e:\n    steps:\n      - name: Runner port offset\n        run: echo \"CI_PORT_OFFSET=${RUNNER_NAME##*-}\" >> \"$GITHUB_ENV\"\n"),
    // A comment about the old runners is not a step.
    pass: wf("jobs:\n  e2e:\n    steps:\n      # was: CI_PORT_OFFSET from runner.name\n      - run: pnpm test\n"),
  },
  "CI-017": {
    fail: wf("on:\n  pull_request:\njobs:\n  visual:\n    runs-on: x\n    continue-on-error: true\n    steps:\n      - run: pnpm test:visual\n"),
    // The same advisory job, run on a schedule.
    pass: wf("on:\n  schedule:\n    - cron: '17 3 * * 1'\njobs:\n  visual:\n    runs-on: x\n    continue-on-error: true\n    steps:\n      - run: pnpm test:visual\n"),
    // A PR workflow whose advisory job only runs on its schedule.
    passAlso: wf("on:\n  pull_request:\n  schedule:\n    - cron: '17 3 * * 1'\njobs:\n  visual:\n    if: github.event_name != 'pull_request'\n    runs-on: x\n    continue-on-error: true\n    steps:\n      - run: pnpm test:visual\n"),
  },
  "CI-018": {
    fail: wf("on:\n  schedule:\n    - cron: '0 6 * * 1'\njobs: {}\n"),
    pass: wf("on:\n  schedule:\n    - cron: '17 6 * * 1'\njobs: {}\n"),
  },
  "CI-019": {
    fail: wf("on:\n  schedule:\n    - cron: '17 * * * *'\njobs:\n  batch:\n    steps:\n      - run: echo \"BATCH=$(( $(date -u +%H) % 4 ))\" >> \"$GITHUB_ENV\"\n"),
    // A date stamp is not a choice of work.
    pass: wf("on:\n  schedule:\n    - cron: '17 * * * *'\njobs:\n  batch:\n    steps:\n      - run: echo \"STAMP=$(date -u +%Y-%m-%d)\" >> \"$GITHUB_ENV\"\n"),
  },
  "CI-020": {
    fail: wf("on:\n  pull_request:\njobs:\n  lint:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm lint\n  typecheck:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm typecheck\n  test:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n"),
    // One job for the checks; e2e needs a database, so it keeps its own VM.
    pass: wf("on:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm lint\n      - run: pnpm test\n  e2e:\n    services:\n      postgres:\n        image: postgres:16\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm e2e\n  smoke:\n    steps:\n      - run: npm install -g wrangler\n"),
  },
  "CF-001": {
    ctx: { repo: "Doman-Digital/demo", deploys: { workers: [{ worker: "demo-site", repo: "Doman-Digital/demo", path: "workers-builds" }] } },
    // An unregistered Worker, and an Actions deploy beside the app's build.
    fail: { workflows: [{ path: ".github/workflows/deploy.yml", text: "on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: npx wrangler deploy\n" }], vercel: [], files: {}, wrangler: [{ path: "wrangler.jsonc", name: "demo-site" }, { path: "worker/wrangler.toml", name: "demo-cron" }] },
    pass: { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  b:\n    steps:\n      - run: npx wrangler deploy --dry-run\n" }], vercel: [], files: {}, wrangler: [{ path: "wrangler.jsonc", name: "demo-site" }] },
  },
  "PKG-001": {
    // The catalogue comes in the context (lib/craft.mjs reads npm before the rules run).
    fail: view({}),
    pass: view({}),
    ctx: { craft: { floor: "2026.10.3", versions: [{ version: "0.20.2", catalogue: "2026.10.2", lockfile: "pnpm-lock.yaml", importer: "apps/portal" }, { version: "0.5.0", catalogue: "none", lockfile: "pnpm-lock.yaml", importer: "packages/ui" }] } },
    passCtx: { craft: { floor: "2026.10.3", versions: [{ version: "0.20.5", catalogue: "2026.10.3", lockfile: "pnpm-lock.yaml", importer: "." }] } },
  },
  "CI-027": {
    fail: wf("on:\n  pull_request:\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  gate:\n    needs: [test]\n    if: ${{ always() }}\n    runs-on: x\n    steps:\n      - run: x\n"),
    // !cancelled() on the job; always() on a step inside a running job is fine.
    pass: wf("on:\n  pull_request:\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  gate:\n    needs: [test]\n    if: ${{ !cancelled() }}\n    runs-on: x\n    steps:\n      - if: always()\n        run: x\n"),
  },
  "CI-028": {
    fail: wf(JOB("${{ vars.CI_RUNNER_HOSTED || vars.CI_RUNNER || 'ubuntu-latest' }}")),
    ctx: { hostedJobs: { jobs: [] } },
    pass: wf(JOB("${{ vars.CI_RUNNER_HOSTED || vars.CI_RUNNER || 'ubuntu-latest' }}")),
    passCtx: { hostedJobs: { jobs: [{ repo: "demo", workflow: "ci.yml", job: "test" }] } },
  },
  "REG-007": {
    // redacted: the ruleset still requires gitleaks.yml's `scan` after the file went.
    fail: { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  lint:\n    steps:\n      - run: x\n" }], vercel: [], files: {}, required: ["lint", "scan"] },
    // A job's name:, a matrix leg and a reusable caller's "<job> / <called job>" all count.
    pass: { workflows: [
      { path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  gate:\n    name: All checks passed\n    steps:\n      - run: x\n  audit:\n    name: Security audit (cargo audit)\n    steps:\n      - run: x\n  test:\n    strategy:\n      matrix:\n        node: [22]\n    steps:\n      - run: x\n" },
      { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
    ], vercel: [], files: {}, required: ["All checks passed", "Security audit (cargo audit)", "test (22)", "policy / check", "policy / secrets"] },
  },
  "REG-008": {
    // The merge queue waits for `test` on its merge_group run, and ci.yml never starts one.
    fail: { workflows: [
      { path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    steps:\n      - run: x\n" },
      { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\n  merge_group:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
    ], vercel: [], files: {}, required: ["test", "policy / check"], mergeQueue: true },
    // Every producer runs on merge_group (list form too); a workflow that produces no required check needs nothing.
    pass: { workflows: [
      { path: ".github/workflows/ci.yml", text: "on: [pull_request, merge_group]\njobs:\n  test:\n    steps:\n      - run: x\n" },
      { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\n  merge_group:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
      { path: ".github/workflows/nightly.yml", text: "on:\n  schedule:\n    - cron: '7 3 * * *'\njobs:\n  sweep:\n    steps:\n      - run: x\n" },
    ], vercel: [], files: {}, required: ["test", "policy / check"], mergeQueue: true },
  },
  "FW-003": {
    fail: { workflows: [{ path: ".github/workflows/ci-standards-policy.yml", text: "jobs:\n  p:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1.0.22\n" }], vercel: [], files: { "renovate.json": '{ "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1.0.13"] }' } },
    pass: { workflows: [{ path: ".github/workflows/ci-standards-policy.yml", text: "jobs:\n  p:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" }], vercel: [], files: { "renovate.json": '{ "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1"] }' } },
  },
  "FW-004": {
    fail: wf("on: [pull_request]\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@dom-776-ci-deploy-standards\n"),
    pass: wf("on: [pull_request]\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n  deploy:\n    uses: Doman-Digital/dd-photo-pack/.github/workflows/grade.yml@0123456789abcdef0123456789abcdef01234567\n  other:\n    steps:\n      - uses: Doman-Digital/dd-photo-pack/action@v1.2.0\n"),
  },
  "CI-021": {
    fail: wf("on: [push]\njobs:\n  checks:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/post-deploy-checks.yml@v1\n"),
    pass: wf("on: [push]\njobs:\n  deploy:\n    steps:\n      - uses: Doman-Digital/dd-ci-standards/.github/actions/post-deploy-checks@v1\n"),
  },
  "CI-023": {
    fail: wf("on: [schedule]\njobs:\n  sweep:\n    steps:\n      - run: node sweep.mjs\n        env:\n          VERCEL_TOKEN_redacted: ${{ secrets.VERCEL_TOKEN_redacted }}\n"),
    // A comment recording why Vercel went is history, not a dependency.
    pass: wf("on: [schedule]\njobs:\n  sweep:\n    steps:\n      # Vercel was retired on 2 September 2026.\n      - run: node sweep.mjs\n"),
  },
  "CI-024": {
    fail: wf("jobs:\n  lh:\n    steps:\n      - if: runner.name != 'dd-ci-01-h'\n        run: pnpm lhci\n"),
    // The host's own name is not a runner name.
    pass: wf("jobs:\n  lh:\n    steps:\n      # Runs on a fresh VM on dd-ci-01.\n      - run: echo dd-ci-01 && pnpm lhci\n"),
  },
  "CI-025": {
    fail: { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - run: pnpm exec turbo run lint --concurrency=1\n" }], vercel: [], files: { "turbo.json": "{}" } },
    pass: { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - id: scope\n        uses: Doman-Digital/dd-ci-standards/.github/actions/workspace-scope@v1\n      - run: pnpm exec turbo run lint $TURBO_FILTERS\n" }], vercel: [], files: { "turbo.json": "{}" } },
  },
  "CI-026": {
    fail: { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  schedule:\n    - cron: '43 4 * * 1'\njobs: {}\n" }], vercel: [], files: {} },
    ctx: { budget: { ghCrons: [{ workflow: "ci.yml", cron: "43 4 * * 1" }, { workflow: "lighthouse.yml", cron: "0 3 * * 1" }], vercelCrons: [] } },
    pass: { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  schedule:\n    - cron: '43 4 * * 1'\njobs: {}\n" }], vercel: [], files: {} },
    passCtx: { budget: { ghCrons: [{ workflow: "ci.yml", cron: "43 4 * * 1" }], vercelCrons: [] } },
  },
  "SEC-008": {
    fail: wf("on: [pull_request]\njobs: {}\n"),
    pass: wf("on: [pull_request]\npermissions: {}\njobs: {}\n"),
  },
  "SEC-001": {
    fail: wf("jobs:\n  a:\n    steps:\n      - uses: tj-actions/changed-files@v45\n"),
    pass: wf("jobs:\n  a:\n    steps:\n      - uses: tj-actions/changed-files@48d8f15b2aaa3d255ca5af3eba4870f807ce6b3c # v45\n      - uses: Doman-Digital/dd-ci-standards/doctor@v1\n      - uses: ./.github/actions/setup\n"),
  },
  "SEC-002": {
    fail: view({ files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'", "pnpm-workspace.yaml": "packages:\n  - apps/*\n" } }),
    pass: view({ files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'", "pnpm-workspace.yaml": "packages:\n  - apps/*\nminimumReleaseAge: 1440\n" } }),
  },
  "SEC-003": {
    fail: view({ files: { "renovate.json": '{ "extends": ["github>Doman-Digital/ci-standards:default"] }' } }),
    pass: view({ files: { "renovate.json": '{ "extends": ["github>Doman-Digital/dd-ci-standards:default"] }' } }),
  },
  "SEC-004": {
    fail: view({ paths: ["package.json", ".env.example", "apps/web/.env.migrate"] }),
    pass: view({ paths: ["package.json", ".env.example", "apps/web/.env.local.example", ".dev.vars.example", "src/env.ts"] }),
  },
  "SEC-005": {
    // .env.migrate named on its own leaves every other env file unignored.
    fail: view({ files: { ".gitignore": "node_modules\n.env*.local\n.env.migrate\n" } }),
    pass: view({ files: { ".gitignore": "node_modules\n.env\n.env.*\n!.env.example\n.dev.vars\n.doppler-token\n" } }),
  },
  "SEC-006": {
    fail: wf("on:\n  pull_request:\njobs:\n  test:\n    steps:\n      - run: npm test\n"),
    pass: { workflows: [{ path: ".github/workflows/policy.yml", text: "jobs:\n  p:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" }], vercel: [], files: {} },
  },
  "SEC-007": {
    // The old fallback: the Doppler token first, the repo secret if that is empty.
    fail: wf("jobs:\n  deploy:\n    steps:\n      - run: npx wrangler deploy\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ steps.doppler.outputs.CLOUDFLARE_DEPLOY_VALUE || secrets.CLOUDFLARE_API_TOKEN }}\n", ".github/workflows/deploy.yml"),
    pass: wf("jobs:\n  deploy:\n    steps:\n      - run: npx wrangler deploy\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ steps.doppler.outputs.CLOUDFLARE_DEPLOY_VALUE }}\n", ".github/workflows/deploy.yml"),
  },
  "REG-002": {
    ctx: { meta: { description: "", topics: ["dd-tooling"] } },
    fail: view({}),
    passCtx: { meta: { description: "A test repo.", topics: ["dd-tooling", "in-use", "doman-digital"] } },
    pass: view({}),
  },
  "REG-003": {
    fail: wf(JOB("${{ vars.CI_RUNNER || 'ubuntu-latest' }}")),
    pass: { workflows: [{ path: ".github/workflows/policy.yml", text: "jobs:\n  p:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" }], vercel: [], files: {} },
  },
  "LIN-001": {
    // The pull request, not files: the view is empty and the pull request comes in the context.
    fail: view({}),
    pass: view({}),
    ctx: { pr: { title: "Add the booking page", body: "", branch: "feat/booking" } },
    passCtx: { pr: { title: "Add the booking page", body: "Closes DOM-123", branch: "feat/booking" } },
  },
  "REG-004": {
    // Settings, not files: the view is empty and the settings come in the context.
    fail: view({}),
    pass: view({}),
    ctx: { meta: { full_name: "Doman-Digital/demo", allow_auto_merge: false, delete_branch_on_merge: true } },
    passCtx: { meta: { full_name: "Doman-Digital/demo", allow_auto_merge: true, delete_branch_on_merge: true } },
  },
  "FW-002": {
    // An exemption with no expiry does not count, and says so.
    fail: wf("on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n# dd: allow CI-005 a backstop with no date\njobs: {}\n"),
    pass: wf("on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n# dd: allow CI-005 until=2027-01-31 secret-scan backstop on main\njobs: {}\n"),
  },
};
