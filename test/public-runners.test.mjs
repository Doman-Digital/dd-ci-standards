import test from "node:test";
import assert from "node:assert/strict";
import { CHECKS, jobBlocks } from "../lib/rules.mjs";
const repo = "Doman-Digital/dd-ci-standards";
const clean = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  self-check:\n    runs-on:\n      group: dd-public-untrusted\n      labels: dd-public-ephemeral\n    timeout-minutes: 15\n    steps:\n      - run: npm test\n`;
const check = (text = clean, context = {}) => CHECKS["CI-002"]({ workflows: [{ path: ".github/workflows/check.yml", text }] }, { repo, visibility: "public", ...context });
test("public profile accepts canonical direct PR jobs and empty read authority", () => {
  assert.deepEqual(check(), []);
  assert.deepEqual(check(clean.replace("permissions:\n  contents: read", "permissions: {}")), []);
});
const failures = {
  "private group": ["group: dd-public-untrusted", "group: Default"],
  "duplicate overriding group": ["labels: dd-public-ephemeral", "labels: dd-public-ephemeral\n      group: Default"],
  "duplicate overriding timeout": ["timeout-minutes: 15", "timeout-minutes: 15\n    timeout-minutes: 360"],
  "private label": ["labels: dd-public-ephemeral", "labels: dd-ci-ephemeral"],
  "dynamic group": ["group: dd-public-untrusted", "group: ${{ vars.RUNNER_GROUP }}"],
  "dynamic label": ["labels: dd-public-ephemeral", "labels: ${{ vars.CI_RUNNER }}"],
  "label-only selection": ["runs-on:\n      group: dd-public-untrusted\n      labels: dd-public-ephemeral", "runs-on: dd-public-ephemeral"],
  "legacy private runner": ["runs-on:\n      group: dd-public-untrusted\n      labels: dd-public-ephemeral", "runs-on: dd-ci-ephemeral"],
  "fallback runner expression": ["runs-on:\n      group: dd-public-untrusted\n      labels: dd-public-ephemeral", "runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}"],
  "privileged pull request target": ["pull_request:", "pull_request_target:"],
  "workflow run": ["pull_request:", "workflow_run:"],
  "manual run": ["pull_request:", "workflow_dispatch:"],
  "push release": ["pull_request:", "push:"],
  "mixed triggers": ["pull_request:", "pull_request:\n  pull_request_target:"],
  "write token": ["contents: read", "contents: write"],
  "job write token": ["    timeout-minutes:", "    permissions:\n      actions: write\n    timeout-minutes:"],
  "OIDC": ["    timeout-minutes:", "    permissions:\n      id-token: write\n    timeout-minutes:"],
  "inherited permissions": ["permissions:\n  contents: read\n", ""],
  "read-all token": ["permissions:\n  contents: read", "permissions: read-all"],
  "secret context": ["- run: npm test", "- run: npm test\n        env:\n          VALUE: ${{ secrets.EXAMPLE }}"],
  "environment secrets": ["    timeout-minutes:", "    environment: production\n    timeout-minutes:"],
  "unbounded runtime": ["    timeout-minutes: 15\n", ""],
  "timeout over profile": ["timeout-minutes: 15", "timeout-minutes: 16"],
  "timeout expression": ["timeout-minutes: 15", "timeout-minutes: ${{ inputs.timeout }}"],
  "quoted selector key": ["runs-on:", '"runs-on":'],
  "alias runner": ["runs-on:\n      group: dd-public-untrusted\n      labels: dd-public-ephemeral", "runs-on: *private"],
};
for (const [name, [before, after]] of Object.entries(failures)) test(`public profile rejects ${name}`, () => assert.ok(check(clean.replace(before, after)).length));
test("repository declaration cannot add itself to initial platform scope", () => assert.ok(check(clean, { repo: "Doman-Digital/dd-packages" }).length));
test("unrecognised YAML and missing triggers do not inherit workflow_call exemption", () => {
  assert.ok(check(clean.replace("on:\n  pull_request:\n", "")).length);
  assert.ok(check('on: pull_request\njobs: { check: { runs-on: dd-ci-ephemeral } }\n').length);
});
test("private callers and static hosted images retain their existing behaviour", () => {
  assert.deepEqual(check(clean.replace("group: dd-public-untrusted", "group: Default"), { visibility: "private" }), []);
  assert.deepEqual(check("on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n"), []);
});
test("group mapping is visible to runner selection checks", () => {
  assert.match(jobBlocks(clean)[0].runsOn, /group: dd-public-untrusted/);
});
test("generic reusable workflow definitions remain caller-scoped", () => {
  assert.deepEqual(check("on:\n  workflow_call:\njobs:\n  check:\n    runs-on: ${{ inputs.runner }}\n"), []);
});
