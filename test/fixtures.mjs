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
    // beautyops' gitleaks.yml beside the policy caller; a weekly full-history sweep is fine.
    fail: { workflows: [
      { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
      { path: ".github/workflows/gitleaks.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  scan:\n    steps:\n      - uses: gitleaks/gitleaks-action@0000000000000000000000000000000000000000\n" },
    ], vercel: [], files: {} },
    pass: { workflows: [
      { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" },
      { path: ".github/workflows/gitleaks.yml", text: "on:\n  schedule:\n    - cron: '17 3 * * 1'\njobs:\n  scan:\n    steps:\n      - uses: gitleaks/gitleaks-action@0000000000000000000000000000000000000000\n" },
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
  "FW-003": {
    fail: { workflows: [{ path: ".github/workflows/ci-standards-policy.yml", text: "jobs:\n  p:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1.0.22\n" }], vercel: [], files: { "renovate.json": '{ "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1.0.13"] }' } },
    pass: { workflows: [{ path: ".github/workflows/ci-standards-policy.yml", text: "jobs:\n  p:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" }], vercel: [], files: { "renovate.json": '{ "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1"] }' } },
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
