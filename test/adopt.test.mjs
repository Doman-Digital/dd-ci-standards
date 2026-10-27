import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planAdopt, POLICY_CALLER } from "../lib/adopt.mjs";
import { runDoctor } from "../lib/engine.mjs";
import { IGNORE_BLOCK } from "../lib/rules.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const ctx = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };

// A repo with debt: no timeout, a hosted runner, no policy caller, an old Renovate preset name.
const messy = {
  workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\nconcurrency:\n  group: g\n  cancel-in-progress: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n" }],
  vercel: [],
  files: { "renovate.json": '{ "extends": ["github>Doman-Digital/ci-standards//default.json#v1"] }' },
};

test("adopt writes the owned files and leaves nothing failing", () => {
  const { writes, before, after } = planAdopt(messy, rulebook, ctx);
  assert.ok(before.findings.some((f) => f.level === "enforce"), "the example should start with a failure");
  assert.equal(writes[".github/workflows/ci-standards-policy.yml"], POLICY_CALLER);
  assert.match(writes["renovate.json"], /dd-ci-standards/);
  assert.match(writes[".gitignore"], /^\.doppler-token$/m);
  assert.deepEqual(after.findings.filter((f) => f.level !== "report"), []);
});

test("the debt it cannot fix is dated, not hidden: exemptions expire in 60 days", () => {
  const { writes } = planAdopt(messy, rulebook, ctx);
  const dd = JSON.parse(writes[".github/dd.json"]);
  const rules = dd.exempt.map((e) => e.rule).sort();
  assert.deepEqual(rules, ["CI-001", "CI-003", "SEC-008"]);
  assert.ok(dd.exempt.every((e) => e.until === "2027-03-16" && /Baseline at adoption/.test(e.reason)));
  // the day after they expire, the findings come back
  const adopted = {
    workflows: [...messy.workflows, { path: ".github/workflows/ci-standards-policy.yml", text: POLICY_CALLER }],
    vercel: [],
    files: { ...messy.files, "renovate.json": writes["renovate.json"], ".github/dd.json": writes[".github/dd.json"], ".gitignore": writes[".gitignore"] },
  };
  const later = runDoctor(adopted, rulebook, { ...ctx, today: "2027-03-17" });
  assert.ok(later.findings.some((f) => f.rule === "CI-003" && f.level === "enforce"));
});

test("adopt is idempotent: a second run changes nothing", () => {
  const { writes } = planAdopt(messy, rulebook, ctx);
  const adopted = {
    workflows: [...messy.workflows, { path: ".github/workflows/ci-standards-policy.yml", text: POLICY_CALLER }],
    vercel: [],
    files: { ...messy.files, "renovate.json": writes["renovate.json"], ".github/dd.json": writes[".github/dd.json"], ".gitignore": writes[".gitignore"] },
  };
  assert.deepEqual(planAdopt(adopted, rulebook, ctx).writes, {});
});

const LIGHT = "${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}";
const STANDARD = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
const pools = {
  workflows: [{
    path: ".github/workflows/ci.yml",
    text: `name: CI
on:
  pull_request:
concurrency:
  group: g
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  changes:
    runs-on: ${STANDARD} # the pool
    timeout-minutes: 2
    steps:
      - run: echo
  lint:
    runs-on:
      - self-hosted
      - dd-ci-ephemeral
    timeout-minutes: 4
    steps:
      - run: echo
  build:
    runs-on: dd-ci-light
    timeout-minutes: 20
    steps:
      - run: echo
  gate:
    runs-on: ${LIGHT}
    timeout-minutes: 5
    steps:
      - run: echo
`,
  }, { path: ".github/workflows/ci-standards-policy.yml", text: POLICY_CALLER }],
  vercel: [],
  files: { "renovate.json": '{ "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1"] }', ".gitignore": IGNORE_BLOCK },
};

test("adopt moves each job to the pool its timeout gives it (CI-022), keeping comments", () => {
  const { writes, after } = planAdopt(pools, rulebook, ctx);
  const text = writes[".github/workflows/ci.yml"];
  assert.match(text, /changes:\n    runs-on: \$\{\{ vars\.CI_RUNNER_LIGHT \|\| vars\.CI_RUNNER \|\| 'ubuntu-latest' \}\} # the pool\n    timeout-minutes: 2/);
  assert.match(text, /lint:\n    runs-on: \$\{\{ vars\.CI_RUNNER_LIGHT[^\n]*\n    timeout-minutes: 4/);
  assert.match(text, /build:\n    runs-on: \$\{\{ vars\.CI_RUNNER \|\| 'ubuntu-latest' \}\}\n    timeout-minutes: 20/);
  assert.doesNotMatch(text, /self-hosted|dd-ci-ephemeral/);
  assert.ok(!after.findings.some((f) => f.rule === "CI-022"));
  assert.ok(!after.exempted.some((f) => f.rule === "CI-022"), "fixed, not baselined");
});

test("adopt --only writes that rule's fix and nothing else, and a second run changes nothing", () => {
  const debt = { ...pools, workflows: pools.workflows.map((w) => (w.path.endsWith("ci.yml") ? { ...w, text: w.text.replace("    timeout-minutes: 20\n", "") } : w)) };
  const { writes } = planAdopt(debt, rulebook, ctx, { only: ["CI-022"] });
  assert.deepEqual(Object.keys(writes), [".github/workflows/ci.yml"], "no dd.json baseline for the CI-003 debt");
  const again = { ...debt, workflows: debt.workflows.map((w) => (writes[w.path] ? { ...w, text: writes[w.path] } : w)) };
  assert.deepEqual(planAdopt(again, rulebook, ctx, { only: ["CI-022"] }).writes, {});
});

test("adopt --only CI-030 adds actions: write to the job that calls the shared deploy, and nothing else", () => {
  const call = (perms) => `on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  deploy:\n${perms}    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n    with:\n      doppler-config: relay\n`;
  const plan = (text) => planAdopt({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, ctx, { only: ["CI-030"] });
  const own = plan(call("    permissions:\n      contents: read\n      id-token: write\n"));
  assert.equal(own.writes[".github/workflows/deploy.yml"], call("    permissions:\n      actions: write\n      contents: read\n      id-token: write\n"));
  assert.deepEqual(own.after.findings.filter((f) => f.rule === "CI-030"), []);
  const inherited = plan(call(""));
  assert.equal(inherited.writes[".github/workflows/deploy.yml"], call("    permissions:\n      contents: read\n      actions: write\n"));
  assert.deepEqual(inherited.after.findings.filter((f) => f.rule === "CI-030"), []);
  // Already granted: a second run changes nothing.
  assert.deepEqual(plan(own.writes[".github/workflows/deploy.yml"]).writes, {});
});
