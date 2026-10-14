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

test("REG-004 does not require auto-merge on a private personal-account repo, but still wants delete-on-merge", () => {
  const fail = FIXTURES["REG-004"].fail;
  const m = (over) => ({ ...base, meta: { full_name: "redacted/x", private: true, owner: { type: "User" }, allow_auto_merge: false, delete_branch_on_merge: true, ...over } });
  assert.ok(!ids(runDoctor(fail, rulebook, m({}))).includes("REG-004"));
  assert.match(runDoctor(fail, rulebook, m({ delete_branch_on_merge: false })).findings.find((f) => f.rule === "REG-004").message, /^delete branch on merge is off/);
  assert.ok(ids(runDoctor(fail, rulebook, m({ owner: { type: "Organization" } }))).includes("REG-004"), "org repos still need it");
  assert.ok(ids(runDoctor(fail, rulebook, m({ private: false }))).includes("REG-004"), "public repos still need it");
});

test("CI-001 checks only repos the organisation owns, since only they can use its runners", () => {
  const fail = FIXTURES["CI-001"].fail;
  const owned = (login) => ({ ...base, meta: { owner: { login } } });
  assert.ok(ids(runDoctor(fail, rulebook, owned("Doman-Digital"))).includes("CI-001"));
  assert.ok(ids(runDoctor(fail, rulebook, base)).includes("CI-001"), "owner unknown: still checked");
  assert.ok(!ids(runDoctor(fail, rulebook, owned("redacted"))).includes("CI-001"), "client account: nowhere else to run");
  assert.ok(!ids(runDoctor(fail, rulebook, { ...owned("dmitridoman"), kind: "dd-site" })).includes("CI-001"), "personal account");
});

test("SEC-007 catches the shapes in the estate and leaves non-deploys alone", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/deploy-astro.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "SEC-007");
  // redacted: the token set in the workflow env, the deploy further down.
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

test("CI-012 looks only at runs a push to main starts, and lets a per-run group cancel", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/ci.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "CI-012");
  const conc = (group, cancel) => `concurrency:\n  group: ${group}\n  cancel-in-progress: ${cancel}\njobs: {}\n`;
  assert.deepEqual(run("on:\n  pull_request:\n" + conc("ci-${{ github.ref }}", "true")), [], "pull requests only");
  assert.deepEqual(run("on:\n  push:\n    tags: ['v*']\n" + conc("rel", "true")), [], "tags only");
  assert.deepEqual(run("on:\n  push:\n    branches: [develop]\n" + conc("ci", "true")), [], "not main");
  assert.deepEqual(run("on:\n  push:\n" + conc("ci-${{ github.head_ref || github.run_id }}", "true")), [], "a group per run never cancels another");
  assert.deepEqual(run("on: [push, pull_request]\n" + conc("ci-${{ github.ref }}", "true")), ["CI-012"], "list form, no branch filter");
  assert.deepEqual(run("on:\n  push:\n    branches:\n      - main\njobs:\n  test:\n    concurrency:\n      group: t-${{ github.ref }}\n      cancel-in-progress: true\n"), ["CI-012"], "job-level group");
});

test("CI-014 wants the tip guard on push deploys too, and the tested commit after workflow_run", () => {
  const run = (text) => runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base).findings.filter((f) => f.rule === "CI-014");
  const push = "on:\n  push:\n    branches: [main]\nconcurrency:\n  group: d\n  cancel-in-progress: false\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n";
  assert.equal(run(push).length, 1);
  assert.match(run(push)[0].message, /tip of main/);
  const wr = "on:\n  workflow_run:\n    workflows: [CI]\njobs:\n  d:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npx wrangler deploy\n";
  assert.equal(run(wr).length, 2, "untested commit and no guard");
  // A manual run deploys the branch it is started on: limited to main, it is fine; unguarded, any branch ships.
  assert.equal(run("on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  d:\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - run: npx wrangler deploy\n").length, 0);
  assert.match(run("on:\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: npx wrangler deploy\n")[0].message, /any branch/);
  // The CI run a deploy follows must exist for every push to main.
  const deployAfterCi = { path: ".github/workflows/deploy.yml", text: "on:\n  workflow_run:\n    workflows:\n      - CI\n    types: [completed]\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n" };
  const ci = (push) => ({ path: ".github/workflows/ci.yml", text: `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\n${push}jobs: {}\n` });
  const both = (push) => runDoctor({ workflows: [deployAfterCi, ci(push)], vercel: [], files: {} }, rulebook, base).findings.filter((f) => f.rule === "CI-014");
  assert.deepEqual(both("    paths: ['src/**']\n").map((f) => f.file), [".github/workflows/ci.yml"]);
  assert.equal(both("").length, 0);
  // The shared deploy workflow has the guard inside it, so a caller has nothing to flag.
  assert.equal(run("on:\n  workflow_run:\n    workflows: [CI]\n  workflow_dispatch:\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n").length, 0);
  // A commented-out deploy is not a deploy.
  assert.equal(run("on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      # - run: npx wrangler deploy\n      - run: echo\n").length, 0);
});

test("deploys.json lists each Worker once per account, with a known path", () => {
  const reg = JSON.parse(readFileSync(new URL("../deploys.json", import.meta.url), "utf8"));
  const paths = new Set(["actions", "workers-builds", "manual", "retired", "not-deployed"]);
  const seen = new Set();
  for (const w of reg.workers) {
    assert.ok(w.worker && typeof w.repo === "string", `entry without a worker or repo: ${JSON.stringify(w)}`);
    assert.ok(paths.has(w.path), `${w.worker}: unknown path ${w.path}`);
    if (w.target) assert.ok(paths.has(w.target) && w.path === "manual", `${w.worker}: target is only for manual Workers`);
    if (w.workflow) assert.ok(/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(w.workflow), `${w.worker}: workflow must be a .github/workflows/ path`);
    const key = `${w.account}/${w.worker}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
  }
});

test("tokens.json records names and scopes, never a value", () => {
  const text = readFileSync(new URL("../tokens.json", import.meta.url), "utf8");
  const reg = JSON.parse(text);
  for (const tk of reg.tokens) assert.ok(tk.name && tk.observed_scope && tk.verdict, `incomplete entry: ${tk.name}`);
  // A Cloudflare API token is 40 URL-safe characters; nothing that long may appear.
  assert.ok(!/[A-Za-z0-9_-]{40}/.test(text), "tokens.json holds something shaped like a token value");
});

test("CF-001 ignores registry entries with no repo", () => {
  const ctx = { repo: "Doman-Digital/demo", deploys: { workers: [{ worker: "orphan", repo: "", path: "retired" }, { worker: "demo-site", repo: "Doman-Digital/demo", path: "manual" }] } };
  const r = runDoctor({ workflows: [], vercel: [], files: {}, wrangler: [{ path: "wrangler.jsonc", name: "demo-site" }] }, rulebook, { ...base, ...ctx });
  assert.ok(!ids(r).includes("CF-001"));
});

test("FW-002 reports an exemption that exempts nothing, and one for a rule that does not exist", () => {
  const text = "on:\n  pull_request:\n# dd: allow CI-005 until=2027-03-01 backstop\n# dd: allow CI-099 until=2027-03-01 typo\njobs: {}\n";
  const r = runDoctor({ workflows: [{ path: ".github/workflows/ci.yml", text }], vercel: [], files: {} }, rulebook, base);
  const fw = r.findings.filter((f) => f.rule === "FW-002").map((f) => f.message);
  assert.ok(fw.some((m) => /CI-005 exempts nothing/.test(m)), fw.join(" | "));
  assert.ok(fw.some((m) => /CI-099, which is not a rule/.test(m)), fw.join(" | "));
  // One that still exempts a finding is not reported as stale.
  const live = runDoctor(FIXTURES["FW-002"].pass, rulebook, base);
  assert.ok(!live.findings.some((f) => f.rule === "FW-002" && /exempts nothing/.test(f.message)));
});

test("FW-002 does not call an exemption stale when its check could not run", () => {
  const v = { workflows: [], vercel: [], files: { ".github/dd.json": JSON.stringify({ exempt: [{ rule: "REG-004", until: "2027-03-01", reason: "settings owned by the client" }] }) } };
  const r = runDoctor(v, rulebook, { ...base, meta: null });
  assert.ok(!r.findings.some((f) => f.rule === "FW-002" && /exempts nothing/.test(f.message)));
});

test("CI-005 accepts push and pull_request on a CI that a workflow_run deploy waits for", () => {
  const ci = { path: ".github/workflows/ci.yml", text: "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs: {}\n" };
  const deploy = { path: ".github/workflows/deploy.yml", text: "on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n" };
  assert.ok(!ids(runDoctor({ workflows: [ci, deploy], vercel: [], files: {} }, rulebook, base)).includes("CI-005"));
  assert.ok(ids(runDoctor({ workflows: [ci], vercel: [], files: {} }, rulebook, base)).includes("CI-005"));
});

test("CF-001 accepts an Actions deploy that runs wrangler inside a script, when deploys.json names its workflow", () => {
  const deploys = { workers: [{ worker: "demo-site", repo: "Doman-Digital/demo", path: "actions", workflow: ".github/workflows/deploy-sites.yml" }] };
  const wf = { path: ".github/workflows/deploy-sites.yml", text: "on:\n  workflow_dispatch:\njobs:\n  deploy:\n    steps:\n      - run: node tools/deploy.mjs\n" };
  const v = (workflows) => ({ workflows, vercel: [], files: {}, wrangler: [{ path: "wrangler.jsonc", name: "demo-site" }] });
  assert.ok(!ids(runDoctor(v([wf]), rulebook, { ...base, repo: "Doman-Digital/demo", deploys })).includes("CF-001"));
  assert.ok(ids(runDoctor(v([]), rulebook, { ...base, repo: "Doman-Digital/demo", deploys })).includes("CF-001"));
});

test("an OpenNext deploy counts as a production deploy (CI-013, SEC-007)", () => {
  const text = "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: pnpm exec opennextjs-cloudflare deploy\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n";
  const r = runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base);
  assert.ok(ids(r).includes("CI-013") && ids(r).includes("SEC-007"), ids(r).join(", "));
});

test("CI-017 leaves a job alone when its if: keeps it off pull requests", () => {
  assert.ok(!ids(runDoctor(FIXTURES["CI-017"].passAlso, rulebook, base)).includes("CI-017"));
});
