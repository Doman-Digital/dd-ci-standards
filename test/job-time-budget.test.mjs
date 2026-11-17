// CI-041 (DOM-17629): a job on a pull request or in the merge queue whose cap is over ten minutes has its expected
// minutes in its workflow's budget.yml row, and the figures have one home (the ledger in dd-repo-registry reads them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor } from "../lib/engine.mjs";
import { capMinutes, jobBlocks } from "../lib/rules.mjs";
import { parseBudget, parseJobMinutes, workflowRows } from "../lib/budget.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", meta: null, taxonomy };
const row = (over = {}) => ({ workflow: "ci.yml", events: ["pull_request", "merge_group"], runner_class: "hosted-linux", per_run_usd: 0.1, runs_a_month: 50, owner: "DD Framework", reason: "tests", ...over });
const ctxWith = (workflows, extra = {}) => ({ ...base, budget: { ghCrons: [], vercelCrons: [], workflows }, ...extra });
const view = (...ws) => ({ workflows: ws.map(([path, text]) => ({ path: `.github/workflows/${path}`, text })), vercel: [], files: {} });
const found = (v, ctx) => runDoctor(v, rulebook, ctx).findings.filter((f) => f.rule === "CI-041");
const job = (name, cap, extra = "") => `  ${name}:\n${extra}    runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: ${cap}\n    steps:\n      - run: make test\n`;
const wf = (on, ...jobs) => `on:\n${on}\njobs:\n${jobs.join("")}`;
const QUEUE = "  merge_group:";
const PR = "  pull_request:";

test("a merge-queue job over ten minutes with no expected duration is refused; with one it passes", () => {
  const v = view(["ci.yml", wf(QUEUE, job("slow", 45))]);
  const refused = found(v, ctxWith([row()]));
  assert.equal(refused.length, 1);
  assert.match(refused[0].message, /job slow may run 45 minutes on every merge queue entry and has no expected duration/);
  assert.match(refused[0].message, /job_minutes: \{ slow: <minutes> \}/);
  assert.equal(refused[0].level, "enforce", "from 1 December");
  assert.equal(found(v, ctxWith([row()], { today: "2026-11-20" }))[0].level, "warn", "a warning first");
  assert.deepEqual(found(v, ctxWith([row({ job_minutes: { slow: 30 } })])), []);
});

test("a job that is allowed on every pull request push (the exempt kind) needs its minutes too", () => {
  const v = view(["ci.yml", wf(PR, job("verify", 30))]);
  assert.match(found(v, ctxWith([row({ pr_exempt_jobs: ["verify"], pr_exempt_reason: "the check itself" })]))[0].message, /every pull request push and has no expected duration/);
  assert.deepEqual(found(v, ctxWith([row({ pr_exempt_jobs: ["verify"], pr_exempt_reason: "the check itself", job_minutes: { verify: 17 } })])), []);
});

test("ten minutes or less needs nothing; the ceiling is ten", () => {
  assert.deepEqual(found(view(["ci.yml", wf(PR, job("lint", 10))]), ctxWith([row()])), []);
  assert.equal(found(view(["ci.yml", wf(PR, job("lint", 11))]), ctxWith([row()])).length, 1);
});

test("a figure above the cap, below one, or not a number is refused", () => {
  const v = view(["ci.yml", wf(QUEUE, job("slow", 45))]);
  for (const bad of [46, 0, -3, NaN]) {
    const f = found(v, ctxWith([row({ job_minutes: { slow: bad } })]));
    assert.equal(f.length, 1, String(bad));
    assert.match(f[0].message, /no higher than the cap/);
  }
  assert.deepEqual(found(v, ctxWith([row({ job_minutes: { slow: 45 } })])), [], "exactly the cap is allowed");
});

test("a runner-aware cap is read as its largest number", () => {
  const expr = "${{ (vars.CI_RUNNER_BROWSER || 'ubuntu-latest') == 'ubuntu-latest' && 65 || 75 }}";
  const [j] = jobBlocks(wf(QUEUE, job("phone", expr)));
  assert.equal(capMinutes(j), 75);
  assert.equal(capMinutes(jobBlocks(wf(QUEUE, job("a", "20 # why")))[0]), 20);
  assert.equal(capMinutes(jobBlocks(wf(QUEUE, "  a:\n    runs-on: x\n    steps: []\n"))[0]), null, "no cap is CI-003's");
  const v = view(["ci.yml", wf(QUEUE, job("phone", expr))]);
  assert.equal(found(v, ctxWith([row()])).length, 1);
  assert.deepEqual(found(v, ctxWith([row({ job_minutes: { phone: 48 } })])), []);
});

test("jobs that never run on a pull request or in the queue are left to other rules", () => {
  const sched = view(["nightly.yml", wf("  schedule:\n    - cron: '17 4 * * 1'\n  push:\n    branches: [main]", job("slow", 45))]);
  assert.deepEqual(found(sched, ctxWith([row({ workflow: "nightly.yml", events: ["schedule", "push"] })])), []);
  const offQueue = view(["ci.yml", wf(`${PR}\n${QUEUE}`, job("slow", 45, "    if: github.event_name == 'schedule'\n"))]);
  assert.deepEqual(found(offQueue, ctxWith([row()])), [], "an if that keeps it to the schedule");
  const tiered = `  changes:\n    runs-on: x\n    timeout-minutes: 3\n    steps:\n      - env:\n          TIERS: '{"slow":"queue"}'\n        run: node plan.mjs\n`;
  const queueOnly = view(["ci.yml", wf(`${PR}\n${QUEUE}`, tiered, job("slow", 45))]);
  const f = found(queueOnly, ctxWith([row()]));
  assert.equal(f.length, 1, "the queue tier defers it from pull requests, not from the queue");
  assert.match(f[0].message, /every merge queue entry/);
});

test("a local reusable workflow is judged through its caller, by its full label or its caller's id", () => {
  const callee = ["called.yml", wf("  workflow_call:", job("test", 15))];
  const caller = ["ci.yml", `on:\n  pull_request:\njobs:\n  lcc:\n    uses: ./.github/workflows/called.yml\n`];
  const f = found(view(caller, callee), ctxWith([row()]));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /job lcc \/ test may run 15 minutes/);
  assert.deepEqual(found(view(caller, callee), ctxWith([row({ job_minutes: { "lcc / test": 1 } })])), []);
  assert.deepEqual(found(view(caller, callee), ctxWith([row({ job_minutes: { lcc: 1 } })])), []);
});

test("a figure for a job that is gone is refused, so a stale baseline cannot hide", () => {
  const v = view(["ci.yml", wf(QUEUE, job("slow", 45))]);
  const f = found(v, ctxWith([row({ job_minutes: { slow: 30, old: 5 } })]));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /names old, which is no longer a job of that workflow/);
});

test("a client's own account, and a budget with no workflows section, are not judged", () => {
  const v = view(["ci.yml", wf(QUEUE, job("slow", 45))]);
  assert.deepEqual(found(v, ctxWith([row()], { meta: { owner: { login: "someclient" } } })), []);
  assert.deepEqual(found(v, { ...base, budget: { ghCrons: [], vercelCrons: [] } }), []);
});

test("job_minutes is read from budget.yml as numbers, whatever the job's name", () => {
  assert.deepEqual(parseJobMinutes("a=1.5, portal-journeys / journeys=9.3, c="), { a: 1.5, "portal-journeys / journeys": 9.3, c: NaN });
  const sample = ["repos:", "  demo:", "    ceiling_usd: 5", "    workflows:", "      - workflow: ci.yml", '        events: "pull_request"', "        runner_class: hosted-linux", "        per_run_usd: 0.1", "        runs_a_month: 5", '        owner: "x"', '        reason: "y"', '        job_minutes: "verify=19.5, a / b=2"', '        job_minutes_basis: "measured"'].join("\n");
  assert.deepEqual(parseBudget(sample).get("demo").workflows[0].job_minutes, { verify: 19.5, "a / b": 2 });
});

test("every job_minutes row in budget.yml has finite figures above zero and says where they came from", () => {
  const raw = readFileSync(new URL("../budget.yml", import.meta.url), "utf8");
  const rows = workflowRows(raw).filter((r) => r.job_minutes);
  assert.ok(rows.some((r) => r.repo === "Doman-Digital" && r.workflow === "ci.yml"), "the monorepo's first baselines are here");
  for (const r of rows) {
    assert.ok(r.job_minutes_basis, `${r.repo} ${r.workflow}: job_minutes needs a job_minutes_basis`);
    for (const [name, minutes] of Object.entries(r.job_minutes)) assert.ok(Number.isFinite(minutes) && minutes > 0, `${r.repo} ${r.workflow} ${name}: ${minutes}`);
  }
});
