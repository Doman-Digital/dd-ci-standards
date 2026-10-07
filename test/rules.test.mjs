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
  assert.equal(levelOn(ci001, "2026-10-18"), "warn");
  assert.equal(levelOn(ci001, "2026-10-19"), "enforce");
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

test("scheduleCrons reads every cron, past comments (the 2026-10-03 fix)", () => {
  const text = 'on:\n  schedule:\n    - cron: "0 3 * * *"\n    # and weekly\n    - cron: "0 6 * * 1"\n  push:\n';
  assert.deepEqual(scheduleCrons(text).map((c) => c.cron), ["0 3 * * *", "0 6 * * 1"]);
});

test("REG-004 says nothing when the token cannot read the merge settings", () => {
  const unread = { ...base, meta: { full_name: "Doman-Digital/demo" } };
  assert.ok(!ids(runDoctor(FIXTURES["REG-004"].fail, rulebook, unread)).includes("REG-004"));
  assert.ok(!ids(runDoctor(FIXTURES["REG-004"].fail, rulebook, base)).includes("REG-004"), "no settings read at all");
  const both = runDoctor(FIXTURES["REG-004"].fail, rulebook, { ...base, meta: { full_name: "x/y", allow_auto_merge: false, delete_branch_on_merge: false } });
  assert.match(both.findings.find((f) => f.rule === "REG-004").message, /^auto-merge and delete branch on merge are off/);
});

test("CI-001 checks only repos the organisation owns, since only they can use its runners", () => {
  const fail = FIXTURES["CI-001"].fail;
  const owned = (login) => ({ ...base, meta: { owner: { login } } });
  assert.ok(ids(runDoctor(fail, rulebook, owned("Doman-Digital"))).includes("CI-001"));
  assert.ok(ids(runDoctor(fail, rulebook, base)).includes("CI-001"), "owner unknown: still checked");
  assert.ok(!ids(runDoctor(fail, rulebook, owned("sensphere"))).includes("CI-001"), "client account: nowhere else to run");
  assert.ok(!ids(runDoctor(fail, rulebook, { ...owned("dmitridoman"), kind: "dd-site" })).includes("CI-001"), "personal account");
});

test("SEC-007 catches the shapes in the estate and leaves non-deploys alone", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/deploy-astro.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "SEC-007");
  // RMP: the token set in the workflow env, the deploy further down.
  assert.deepEqual(run("env:\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\njobs:\n  deploy:\n    steps:\n      - run: pnpm exec wrangler deploy\n"), ["SEC-007"]);
  // The wrangler action takes it as an input.
  assert.deepEqual(run("jobs:\n  deploy:\n    steps:\n      - uses: cloudflare/wrangler-action@0000000000000000000000000000000000000000\n        with:\n          apiToken: ${{ secrets.CF_TOKEN }}\n"), ["SEC-007"]);
  // A dry run does not need the token, so a secret passed to it is still flagged.
  assert.deepEqual(run("jobs:\n  check:\n    steps:\n      - run: npx wrangler deploy --dry-run\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n"), ["SEC-007"]);
  // Doppler run with the token from Doppler: no Cloudflare secret in GitHub.
  assert.deepEqual(run("jobs:\n  deploy:\n    steps:\n      - run: doppler run -- pnpm exec wrangler deploy\n        env:\n          DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}\n"), []);
  // A token secret in a workflow that never deploys to Cloudflare.
  assert.deepEqual(run("jobs:\n  dns:\n    steps:\n      - run: node scripts/dns.mjs\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n"), []);
});
