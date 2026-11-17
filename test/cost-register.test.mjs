// The cost register rules CI-035 to CI-039 (DOM-17682): what each reads, and what it leaves alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor } from "../lib/engine.mjs";
import { excludesEvents, queueJobs } from "../lib/rules.mjs";
import { starterBudgetRows } from "../lib/new.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", meta: null, taxonomy };
const row = (over = {}) => ({ workflow: "ci.yml", events: ["pull_request"], runner_class: "hosted-linux", per_run_usd: 0.1, runs_a_month: 50, owner: "DD Framework", reason: "tests", ...over });
const ctxWith = (workflows, extra = {}) => ({ ...base, budget: { ghCrons: [], vercelCrons: [], workflows }, ...extra });
const view = (...ws) => ({ workflows: ws.map(([path, text]) => ({ path: `.github/workflows/${path}`, text })), vercel: [], files: {} });
const found = (v, ctx, id) => runDoctor(v, rulebook, ctx).findings.filter((f) => f.rule === id);
const job = (name, minutes, steps = "      - run: make test", extra = "") => `  ${name}:\n${extra}    runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: ${minutes}\n    steps:\n${steps}\n`;
const wfText = (on, ...jobs) => `on:\n${on}\njobs:\n${jobs.join("")}`;

test("an unpriced 20-minute job is refused; the same job with a priced row passes (CI-035)", () => {
  const v = view(["nightly.yml", wfText("  push:\n    branches: [main]", job("slow", 20))]);
  const refused = found(v, ctxWith([]), "CI-035");
  assert.equal(refused.length, 1);
  assert.match(refused[0].message, /no row in dd-ci-standards budget\.yml/);
  assert.deepEqual(found(v, ctxWith([row({ workflow: "nightly.yml", events: ["push"] })]), "CI-035"), []);
  assert.equal(refused[0].level, "enforce", "after 29 November");
  assert.equal(found(v, ctxWith([], { today: "2026-11-20" }), "CI-035")[0].level, "warn", "a warning first");
});

test("CI-035 refuses a new trigger and an incomplete row, and leaves workflow_call-only files and bare budgets alone", () => {
  const v = view(["ci.yml", wfText("  pull_request:\n  schedule:\n    - cron: '17 4 * * 1'", job("t", 5))]);
  assert.match(found(v, ctxWith([row()]), "CI-035")[0].message, /starts on schedule, which its budget\.yml row does not list/);
  assert.deepEqual(found(v, ctxWith([row({ events: ["pull_request", "schedule"] })]), "CI-035"), []);
  const bad = found(v, ctxWith([row({ events: ["pull_request", "schedule"], runner_class: "laptop", owner: "", per_run_usd: NaN })]), "CI-035");
  assert.match(bad[0].message, /runner_class.*owner|per_run_usd/);
  assert.deepEqual(found(view(["lib.yml", wfText("  workflow_call:", job("t", 5))]), ctxWith([]), "CI-035"), [], "priced in its caller's row");
  assert.deepEqual(found(v, { ...base, budget: { ghCrons: [], vercelCrons: [] } }, "CI-035"), [], "a budget with no workflows section is not judged");
  assert.deepEqual(found(v, ctxWith([], { meta: { owner: { login: "someclient" } } }), "CI-035"), [], "a client's account pays its own minutes");
});

test("CI-036 reports a row for a workflow, or an event, that is gone", () => {
  const v = view(["ci.yml", wfText("  pull_request:", job("t", 5))]);
  assert.match(found(v, ctxWith([row(), row({ workflow: "old.yml" })]), "CI-036")[0].message, /old\.yml.*no longer exists/);
  assert.match(found(v, ctxWith([row({ events: ["pull_request", "schedule"] })]), "CI-036")[0].message, /schedule, which the workflow no longer starts on/);
  assert.deepEqual(found(v, ctxWith([row()]), "CI-036"), []);
  const called = view(["ci.yml", wfText("  workflow_call:", job("t", 5))]);
  assert.match(found(called, ctxWith([row()]), "CI-036")[0].message, /caller's row/);
});

test("CI-037: a job over ten minutes may not run on every pull request push; the row records the exceptions, and only for CI-037", () => {
  const long = view(["ci.yml", wfText("  pull_request:", job("verify", 30), job("lint", 10))]);
  const f = found(long, ctxWith([row()]), "CI-037");
  assert.equal(f.length, 1, "ten minutes is allowed, thirty is not");
  assert.match(f[0].message, /job verify may run 30 minutes/);
  assert.deepEqual(found(long, ctxWith([row({ pr_exempt_jobs: ["verify"], pr_exempt_reason: "the PR check" })]), "CI-037"), []);
  assert.equal(found(long, ctxWith([row({ pr_exempt_jobs: ["verify"] })]), "CI-037").length, 1, "an exemption with no reason is none");
  // The row does not switch off the browser guard for the same job.
  const browser = view(["ci.yml", wfText("  pull_request:", job("verify", 30, "      - run: pnpm exec playwright test"))]);
  const ex = ctxWith([row({ pr_exempt_jobs: ["verify"], pr_exempt_reason: "the PR check" })]);
  assert.equal(found(browser, ex, "CI-037").length, 0);
  assert.equal(found(browser, ex, "CI-038").length, 1);
  // Merge queue, push and schedule are where long jobs belong.
  const elsewhere = view(["ci.yml", wfText("  merge_group:\n  push:\n    branches: [main]\n  schedule:\n    - cron: '17 4 * * 1'", job("verify", 30))]);
  assert.deepEqual(found(elsewhere, ctxWith([row()]), "CI-037"), []);
});

test("CI-037 reads event_name conditions, the queue tier map and local reusable workflows", () => {
  const gated = (cond) => view(["ci.yml", wfText("  pull_request:\n  push:\n    branches: [main]", job("slow", 30, undefined, `    if: ${cond}\n`))]);
  assert.deepEqual(found(gated("github.event_name != 'pull_request'"), ctxWith([row()]), "CI-037"), []);
  assert.deepEqual(found(gated("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"), ctxWith([row()]), "CI-037"), []);
  assert.deepEqual(found(gated("(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'"), ctxWith([row()]), "CI-037"), []);
  assert.equal(found(gated("github.event_name != 'pull_request' || needs.changes.outputs.code == 'true'"), ctxWith([row()]), "CI-037").length, 1, "|| with anything else may still run on the pull request");
  assert.equal(found(gated("contains(fromJSON(needs.changes.outputs.plan).run, 'slow')"), ctxWith([row()]), "CI-037").length, 1, "a plan alone is not a tier");
  const tiered = view(["ci.yml", wfText("  pull_request:\n  merge_group:", `  changes:\n    runs-on: x\n    timeout-minutes: 3\n    steps:\n      - id: plan\n        env:\n          TIERS: '{"slow":"queue","fast":"pr"}'\n        run: node plan.mjs\n`, job("slow", 30), job("fast", 30))]);
  assert.deepEqual([...queueJobs(tiered.workflows[0].text)], ["slow"]);
  const t = found(tiered, ctxWith([row()]), "CI-037");
  assert.deepEqual(t.map((x) => /job (\S+)/.exec(x.message)[1]), ["fast"]);
  // A local reusable workflow is judged through the job that calls it, and the caller's row exempts it.
  const callee = ["called.yml", wfText("  workflow_call:", job("test", 15))];
  const caller = (cond) => ["ci.yml", `on:\n  pull_request:\njobs:\n  lcc:\n    if: ${cond}\n    uses: ./.github/workflows/called.yml\n`];
  const via = found(view(caller("true"), callee), ctxWith([row()]), "CI-037");
  assert.equal(via.length, 1);
  assert.match(via[0].message, /job lcc \/ test may run 15 minutes/);
  assert.deepEqual(found(view(caller("true"), callee), ctxWith([row({ pr_exempt_jobs: ["lcc"], pr_exempt_reason: "its own paths only" })]), "CI-037"), []);
  assert.deepEqual(found(view(caller("github.event_name != 'pull_request'"), callee), ctxWith([row()]), "CI-037"), []);
});

test("excludesEvents reads the && terms and refuses to trust an ||", () => {
  const pr = ["pull_request"];
  assert.equal(excludesEvents("false", pr), true);
  assert.equal(excludesEvents("${{ github.event_name != 'pull_request' }}", pr), true);
  assert.equal(excludesEvents("github.event_name == 'merge_group'", pr), true);
  assert.equal(excludesEvents("github.event_name == 'merge_group' || github.event_name == 'pull_request'", pr), false);
  assert.equal(excludesEvents("github.ref == 'refs/heads/main'", pr), false);
  assert.equal(excludesEvents("", pr), false);
  assert.equal(excludesEvents("github.event_name != 'pull_request'", ["pull_request", "push"]), false, "push is not excluded");
  assert.equal(excludesEvents("github.event_name != 'pull_request' && github.event_name != 'push'", ["pull_request", "push"]), true);
});

test("CI-038 reads steps: a browser step behind an event_name condition is fine, an unconditional one is not", () => {
  const steps = (cond) => `      - uses: ./.github/actions/playwright\n${cond ? `        if: ${cond}\n` : ""}      - run: pnpm test\n`;
  const run = (cond, on = "  pull_request:") => found(view(["ci.yml", wfText(on, job("e2e", 8, steps(cond)))]), ctxWith([row()]), "CI-038");
  assert.equal(run("").length, 1);
  assert.equal(run("${{ !cancelled() && github.event_name != 'pull_request' }}").length, 0);
  assert.equal(run("", "  merge_group:\n  schedule:\n    - cron: '17 4 * * 1'").length, 0, "queue and schedule are where browsers belong");
  const commented = view(["ci.yml", wfText("  pull_request:", job("t", 8, "      # playwright runs in the queue\n      - run: pnpm test"))]);
  assert.deepEqual(found(commented, ctxWith([row()]), "CI-038"), []);
  const dated = "# dd: allow CI-038 until=2027-02-01 the checks service tests need Chromium\n";
  assert.deepEqual(runDoctor(view(["ci.yml", dated + wfText("  pull_request:", job("e2e", 8, steps("")))]), rulebook, ctxWith([row()])).findings.filter((f) => f.rule === "CI-038"), [], "a dated allow works");
});

test("CI-039 refuses macOS on push and pull request, and leaves dispatch and schedule alone", () => {
  const mac = (on, cond = "") => view(["screen-reader.yml", wfText(on, `  voiceover:\n${cond}    runs-on: macos-latest\n    timeout-minutes: 8\n    steps:\n      - run: echo\n`)]);
  assert.equal(found(mac("  pull_request:"), ctxWith([]), "CI-039").length, 1);
  assert.equal(found(mac("  push:\n    branches: [main]"), ctxWith([]), "CI-039").length, 1);
  assert.deepEqual(found(mac("  workflow_dispatch:"), ctxWith([]), "CI-039"), []);
  assert.deepEqual(found(mac("  schedule:\n    - cron: '17 4 * * 1'"), ctxWith([]), "CI-039"), []);
  assert.deepEqual(found(mac("  pull_request:\n  workflow_dispatch:", "    if: github.event_name == 'workflow_dispatch'\n"), ctxWith([]), "CI-039"), []);
  assert.equal(found(mac("  push:\n  workflow_dispatch:", "    if: github.event_name != 'pull_request'\n"), ctxWith([]), "CI-039").length, 1, "still runs on push");
});

test("a starter's own workflows are priced by dd new, so it starts clean (CI-035, CI-037)", () => {
  const v = view(["ci.yml", wfText("  pull_request:\n  push:\n    branches: [main]", job("build", 20), job("lint", 5))]);
  const rows = starterBudgetRows(v);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].pr_exempt_jobs, ["build"]);
  const ctx = ctxWith(rows);
  assert.deepEqual(found(v, ctx, "CI-035"), []);
  assert.deepEqual(found(v, ctx, "CI-037"), []);
  assert.deepEqual(found(v, ctx, "CI-036"), []);
});

// CI-040 (DOM-17865): the merge queue's browser tier reads CI_RUNNER_BROWSER so the 60% flip leaves it on GitHub-hosted runners.
test("CI-040: a queue-tier job must read CI_RUNNER_BROWSER; jobs outside the tier, and workflows with no tier map, are left alone", () => {
  const tiers = `      - run: echo plan\n        env:\n          TIERS: '{"phone":"queue","journeys":"queue"}'\n`;
  const j = (name, runsOn) => `  ${name}:\n    runs-on: ${runsOn}\n    timeout-minutes: 8\n    steps:\n      - run: echo ${name}\n`;
  const CI = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
  const BR = "${{ vars.CI_RUNNER_BROWSER || 'ubuntu-latest' }}";
  const mg = "  pull_request:\n  merge_group:";
  const wf = (...jobs) => view(["ci.yml", wfText(mg, job("changes", 5, tiers), ...jobs)]);
  const f = found(wf(j("phone", CI), j("lint", CI)), ctxWith([row()]), "CI-040");
  assert.equal(f.length, 1, "only the tier's job is flagged, not lint");
  assert.match(f[0].message, /job phone .*CI_RUNNER_BROWSER/);
  assert.equal(f[0].level, "enforce", "refused after 1 December 2026");
  assert.equal(found(wf(j("phone", CI)), ctxWith([row()], { today: "2026-11-20" }), "CI-040")[0].level, "warn", "a warning first");
  assert.equal(found(wf(j("phone", CI)), ctxWith([row()], { today: "2026-11-16" }), "CI-040").length, 0, "silent before the warning date");
  assert.deepEqual(found(wf(j("phone", BR), j("lint", CI)), ctxWith([row()]), "CI-040"), []);
  // no merge_group trigger, no tier map, a client's account, a public repo: nothing to judge
  assert.deepEqual(found(view(["ci.yml", wfText("  pull_request:", job("changes", 5, tiers), j("phone", CI))]), ctxWith([row()]), "CI-040"), []);
  assert.deepEqual(found(view(["ci.yml", wfText(mg, j("phone", CI))]), ctxWith([row()]), "CI-040"), []);
  assert.deepEqual(found(wf(j("phone", CI)), ctxWith([row()], { meta: { owner: { login: "someclient" } } }), "CI-040"), []);
  assert.deepEqual(found(wf(j("phone", CI)), ctxWith([row()], { visibility: "public" }), "CI-040"), []);
  // a tier job that calls a local reusable workflow is judged on the inner job's runs-on
  const caller = wfText(mg, job("changes", 5, tiers), "  journeys:\n    uses: ./.github/workflows/inner.yml\n");
  const inner = (runsOn) => `on:\n  workflow_call:\njobs:\n  run:\n    runs-on: ${runsOn}\n    timeout-minutes: 8\n    steps:\n      - run: echo hi\n`;
  assert.equal(found(view(["ci.yml", caller], ["inner.yml", inner(CI)]), ctxWith([row()]), "CI-040").length, 1);
  assert.deepEqual(found(view(["ci.yml", caller], ["inner.yml", inner(BR)]), ctxWith([row()]), "CI-040"), []);
  // a dated allow works
  const allowed = "# dd: allow CI-040 until=2027-02-01 the box runs it\n" + wfText(mg, job("changes", 5, tiers), j("phone", CI));
  assert.deepEqual(runDoctor(view(["ci.yml", allowed]), rulebook, ctxWith([row()])).findings.filter((x) => x.rule === "CI-040"), []);
});
