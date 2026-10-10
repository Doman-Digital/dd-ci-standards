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
