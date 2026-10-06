import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor, levelOn, exemptionState } from "../lib/engine.mjs";
import { scheduleCrons } from "../lib/rules.mjs";
import { FIXTURES } from "./fixtures.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const TODAY = "2027-01-15"; // every rule past its enforce date
const base = { today: TODAY, kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };
const ids = (r) => r.findings.map((f) => f.rule);

test("every rule has a failing and a passing example", () => {
  const missing = rulebook.rules.map((r) => r.id).filter((id) => !FIXTURES[id]?.fail || !FIXTURES[id]?.pass);
  assert.deepEqual(missing, [], `rules with no fixture pair in test/fixtures.mjs: ${missing.join(", ")}`);
});

test("enforce_from is at most 90 days after warn_from, so nothing warns forever", () => {
  for (const r of rulebook.rules) {
    const days = (Date.parse(r.enforce_from) - Date.parse(r.warn_from)) / 864e5;
    assert.ok(days >= 0 && days <= 90, `${r.id}: ${days} days between warn_from and enforce_from`);
  }
});

for (const rule of rulebook.rules) {
  const fx = FIXTURES[rule.id];
  if (!fx) continue;
  test(`${rule.id} catches its failing example`, () => {
    const r = runDoctor(fx.fail, rulebook, { ...base, ...(fx.ctx || {}) });
    assert.ok(ids(r).includes(rule.id), `${rule.id} did not fire; got ${ids(r).join(", ") || "nothing"}`);
  });
  test(`${rule.id} passes its passing example`, () => {
    const r = runDoctor(fx.pass, rulebook, { ...base, ...(fx.ctx || {}), ...(fx.passCtx || {}) });
    assert.ok(!ids(r).includes(rule.id), `${rule.id} fired on the passing example: ${r.findings.filter((f) => f.rule === rule.id).map((f) => f.message).join(" | ")}`);
  });
}

test("a rule warns before its enforce date and fails after it", () => {
  const ci001 = rulebook.rules.find((r) => r.id === "CI-001");
  assert.equal(levelOn(ci001, "2026-10-02"), "off");
  assert.equal(levelOn(ci001, "2026-11-01"), "warn");
  assert.equal(levelOn(ci001, "2026-12-31"), "enforce");
});

test("an exemption with a date and a reason exempts; expired, undated or too long does not", () => {
  const today = "2026-11-01";
  assert.equal(exemptionState({ rule: "CI-005", reason: "backstop", until: "2027-01-31" }, today).state, "valid");
  assert.equal(exemptionState({ rule: "CI-005", reason: "backstop", until: "2026-10-31" }, today).state, "expired");
  assert.equal(exemptionState({ rule: "CI-005", reason: "", until: "2027-01-31" }, today).state, "invalid");
  assert.equal(exemptionState({ rule: "CI-005", reason: "x", until: "2027-06-01" }, today).state, "invalid");
  const r = runDoctor(FIXTURES["FW-002"].pass, rulebook, { ...base, today });
  assert.ok(!ids(r).includes("CI-005") && r.exempted.some((f) => f.rule === "CI-005"));
});

test("the legacy allow-double-run comment still exempts CI-005, and is reported as undated", () => {
  const v = { workflows: [{ path: ".github/workflows/scan.yml", text: "# ci-standards: allow-double-run backstop on main\non:\n  push:\n  pull_request:\njobs: {}\n" }], vercel: [], files: {} };
  const r = runDoctor(v, rulebook, base);
  assert.ok(!ids(r).includes("CI-005"));
  assert.ok(r.findings.some((f) => f.rule === "FW-002" && /legacy/.test(f.message)));
});

test("out-of-scope kinds are not checked; sales-demo gets the light profile", () => {
  const fail = FIXTURES["CI-005"].fail;
  assert.deepEqual(runDoctor(fail, rulebook, { ...base, kind: "it-portfolio" }).findings, []);
  assert.ok(!ids(runDoctor(fail, rulebook, { ...base, kind: "sales-demo" })).includes("CI-005"));
  assert.ok(ids(runDoctor(FIXTURES["CI-003"].fail, rulebook, { ...base, kind: "sales-demo" })).includes("CI-003"));
});

test("CI-002 lets a call-only workflow use the CI_RUNNER fallback, and nothing looser (2026-10-06)", () => {
  const pub = { ...base, visibility: "public" };
  const reusable = (on, runsOn) => ({ workflows: [{ path: ".github/workflows/policy.yml", text: `${on}\njobs:\n  check:\n    runs-on: ${runsOn}\n    timeout-minutes: 5\n    steps:\n      - run: x\n` }], vercel: [], files: {} });
  const FALLBACK = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
  assert.ok(!ids(runDoctor(reusable("on:\n  workflow_call: {}", FALLBACK), rulebook, pub)).includes("CI-002"));
  assert.ok(!ids(runDoctor(reusable("on: workflow_call", FALLBACK), rulebook, pub)).includes("CI-002"));
  // Another trigger beside workflow_call runs in this public repo, so it still fails.
  assert.ok(ids(runDoctor(reusable("on:\n  workflow_call: {}\n  pull_request:", FALLBACK), rulebook, pub)).includes("CI-002"));
  // A call-only workflow naming the VM outright still fails.
  assert.ok(ids(runDoctor(reusable("on:\n  workflow_call: {}", "dd-ci"), rulebook, pub)).includes("CI-002"));
});

test("scheduleCrons reads every cron, past comments (the 2026-10-03 fix)", () => {
  const text = 'on:\n  schedule:\n    - cron: "0 3 * * *"\n    # and weekly\n    - cron: "0 6 * * 1"\n  push:\n';
  assert.deepEqual(scheduleCrons(text).map((c) => c.cron), ["0 3 * * *", "0 6 * * 1"]);
});
