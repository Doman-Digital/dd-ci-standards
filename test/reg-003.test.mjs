// One policy scan per commit (DOM-17635). The org ruleset dd-policy-required runs policy.yml on
// every private Doman-Digital repo, so a caller is required only where it does not apply (REG-003),
// and a caller where it does is a second scan of the same commit (REG-009). SEC-006 and CI-015 read
// the same answer, so deleting a covered repo's caller neither raises them nor hides a scanner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runDoctor } from "../lib/engine.mjs";
import { POLICY_RULESET, orgPolicyRuns } from "../lib/rules.mjs";
import { branchRules } from "../lib/view-github.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { selfHostedRetired: false, today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };
const ids = (r) => r.findings.map((f) => f.rule);

const CALLER = { path: ".github/workflows/ci-standards-policy.yml", text: "name: ci-standards policy\non:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" };
const CI = { path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: npm test\n" };
const SCANNER = { path: ".github/workflows/scan.yml", text: "on:\n  pull_request:\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: trufflehog git file://. --fail\n" };
const view = (workflows, extra = {}) => ({ workflows, vercel: [], files: {}, ...extra });
const org = { ...base, repo: "Doman-Digital/demo", repoName: "demo" };
const client = { ...base, repo: "someclient/site", repoName: "site" };

test("REG-003: a covered repo needs no caller; the live rules decide when they were read", () => {
  assert.ok(!ids(runDoctor(view([CI], { orgPolicy: true }), rulebook, client)).includes("REG-003"), "live rules say covered, whatever the owner");
  assert.ok(ids(runDoctor(view([CI], { orgPolicy: false }), rulebook, org)).includes("REG-003"), "live rules say not covered (left out by the registry, or the ruleset at evaluate)");
  assert.ok(!ids(runDoctor(view([CI, CALLER], { orgPolicy: false }), rulebook, client)).includes("REG-003"), "a client repo with its caller");
});

test("REG-003: rules unread, coverage is worked out as org-rulesets.yaml applies it", () => {
  assert.ok(!ids(runDoctor(view([CI]), rulebook, org)).includes("REG-003"), "a private org repo");
  assert.ok(ids(runDoctor(view([CI]), rulebook, { ...org, visibility: "public" })).includes("REG-003"), "a public org repo");
  assert.ok(ids(runDoctor(view([CI]), rulebook, client)).includes("REG-003"), "another account");
  assert.ok(ids(runDoctor(view([CI]), rulebook, { ...org, visibility: null })).includes("REG-003"), "visibility unknown: not presumed covered");
  assert.equal(orgPolicyRuns(view([]), { meta: { full_name: "Doman-Digital/x", owner: { login: "Doman-Digital" } }, visibility: "private" }), true, "the owner from the settings when no repo is given");
  const msg = runDoctor(view([CI]), rulebook, client).findings.find((f) => f.rule === "REG-003").message;
  assert.match(msg, /dd-policy-required does not apply here/);
  assert.match(msg, /dd adopt --only REG-003/);
});

test("REG-009: a caller in a covered repo is a second scan, named with its line", () => {
  const r = runDoctor(view([CI, CALLER], { orgPolicy: true }), rulebook, org);
  const f = r.findings.find((x) => x.rule === "REG-009");
  assert.ok(f, "fires");
  assert.equal(f.file, CALLER.path);
  assert.equal(f.line, 6);
  assert.match(f.message, /retire_checks/);
  assert.ok(!r.findings.some((x) => x.rule === "REG-009" && x.file === CI.path), "only the file that calls it");
});

test("REG-009: only the live rules count, never the guess from the owner", () => {
  assert.ok(!ids(runDoctor(view([CALLER]), rulebook, org)).includes("REG-009"), "rules unread: a repo left out by the registry would lose its only scan");
  assert.ok(!ids(runDoctor(view([CALLER], { orgPolicy: null }), rulebook, org)).includes("REG-009"));
  assert.ok(!ids(runDoctor(view([CALLER], { orgPolicy: true }), rulebook, { ...org, repoName: "dd-ci-standards" })).includes("REG-009"), "the repo that defines the check");
});

test("REG-009 warns before its enforce date, then fails", () => {
  const rule = rulebook.rules.find((r) => r.id === "REG-009");
  assert.ok(rule.warn_from < rule.enforce_from, "a dated rollout, not an immediate error");
  const v = view([CALLER], { orgPolicy: true });
  assert.equal(runDoctor(v, rulebook, { ...org, today: rule.warn_from }).findings.find((f) => f.rule === "REG-009").level, "warn");
  assert.equal(runDoctor(v, rulebook, { ...org, today: rule.enforce_from }).findings.find((f) => f.rule === "REG-009").level, "enforce");
});

test("SEC-006: a covered repo with no caller is scanned for secrets by the ruleset run", () => {
  assert.ok(!ids(runDoctor(view([CI], { orgPolicy: true }), rulebook, org)).includes("SEC-006"));
  assert.ok(!ids(runDoctor(view([CI]), rulebook, org)).includes("SEC-006"), "rules unread, a private org repo");
  assert.ok(ids(runDoctor(view([CI], { orgPolicy: false }), rulebook, org)).includes("SEC-006"));
});

test("CI-015: a scanner of its own is still caught once the caller is gone", () => {
  assert.ok(ids(runDoctor(view([CI, SCANNER], { orgPolicy: true }), rulebook, org)).includes("CI-015"), "the ruleset runs the scan");
  assert.ok(ids(runDoctor(view([CI, SCANNER, CALLER], { orgPolicy: false }), rulebook, client)).includes("CI-015"), "a caller runs the scan");
  assert.ok(!ids(runDoctor(view([CI, SCANNER], { orgPolicy: false }), rulebook, client)).includes("CI-015"), "nothing else scans: its own scanner is the only one");
});

test("branchRules reports whether an active workflows rule runs policy.yml", async () => {
  const policyRule = (w) => ({ type: "workflows", parameters: { workflows: [w] } });
  const at = (rules, extra = {}) => {
    const api = { "/repos/o/r/rules/branches/main": rules, "/repositories/7": { full_name: POLICY_RULESET.repo }, "/repositories/8": { full_name: "Someone/else" }, ...extra };
    return async (p) => {
      if (!(p in api)) throw new Error("HTTP 404");
      return api[p];
    };
  };
  const covered = await branchRules("o/r", "main", at([policyRule({ repository_id: 7, path: POLICY_RULESET.path, ref: POLICY_RULESET.ref })]));
  assert.equal(covered.orgPolicy, true);
  assert.equal((await branchRules("o/r", "main", at([{ type: "deletion" }]))).orgPolicy, false, "no workflows rule");
  assert.equal((await branchRules("o/r", "main", at([policyRule({ repository_id: 8, path: POLICY_RULESET.path })]))).orgPolicy, false, "another repo's policy.yml");
  assert.equal((await branchRules("o/r", "main", at([policyRule({ repository_id: 9, path: POLICY_RULESET.path })]))).orgPolicy, null, "the repo cannot be named: unknown");
  assert.equal((await branchRules("o/r", "main", async () => { throw new Error("HTTP 403"); })).orgPolicy, null, "rules unreadable: unknown");
});

// The registry's org-rulesets.yaml is the source; its own test/org-rulesets.test.mjs pins the same
// fields. This runs when a registry checkout sits beside this one (or DD_REPO_REGISTRY names one).
test("POLICY_RULESET matches dd-policy-required in org-rulesets.yaml, if a registry checkout sits beside this one", async (t) => {
  const dir = process.env.DD_REPO_REGISTRY || new URL("../../dd-repo-registry/", import.meta.url).pathname;
  let mod;
  try {
    mod = await import(pathToFileURL(join(dir, "bin/org-rulesets.mjs")).href);
  } catch {
    t.skip("no dd-repo-registry checkout beside this one");
    return;
  }
  const spec = mod.loadSpec(join(dir, "org-rulesets.yaml"));
  const rs = (spec.rulesets ?? spec).find((r) => r.name === POLICY_RULESET.name);
  assert.ok(rs, `org-rulesets.yaml has no ${POLICY_RULESET.name}`);
  assert.equal(spec.org ?? POLICY_RULESET.org, POLICY_RULESET.org);
  const run = rs.workflows.run;
  assert.ok(run.some((w) => w.repository === POLICY_RULESET.repo && w.path === POLICY_RULESET.path && w.ref === POLICY_RULESET.ref), "the ruleset runs policy.yml@v1 from dd-ci-standards");
  assert.deepEqual([...rs.exclude.visibility].sort(), [...POLICY_RULESET.excludeVisibility].sort());
});
