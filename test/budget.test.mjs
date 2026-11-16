// The envelope test (DOM-17682, I2): the cost register in budget.yml must add up to at most 60% of the
// $300 monthly allowance, no repo may declare more than its ceiling, and the ceilings themselves must fit
// the same limit. release.yml runs this before it tags, so a release that breaks it is blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBudget, budgetForRepo, workflowRows, envelope, envelopeProblems, ENVELOPE_USD } from "../lib/budget.mjs";
import { rowProblems, RUNNER_CLASSES } from "../lib/rules.mjs";

const raw = readFileSync(new URL("../budget.yml", import.meta.url), "utf8");
const repos = parseBudget(raw);

test("the declared envelope is at most 60% of $300, and every repo is within its ceiling", () => {
  assert.equal(ENVELOPE_USD, 180);
  assert.deepEqual(envelopeProblems(repos), []);
  assert.ok(envelope(repos).total > 0, "the register has rows");
});

test("every row prices its workflow, and is listed once", () => {
  const rows = workflowRows(raw);
  assert.ok(rows.length > 0);
  const seen = new Set();
  for (const r of rows) {
    assert.deepEqual(rowProblems(r), [], `${r.repo} ${r.workflow}`);
    assert.ok(RUNNER_CLASSES.includes(r.runner_class));
    const key = `${r.repo}/${r.workflow}`;
    assert.ok(!seen.has(key), `${key} has two rows`);
    seen.add(key);
    if (r.pr_exempt_jobs) assert.ok(r.pr_exempt_reason, `${key}: pr_exempt_jobs needs a pr_exempt_reason`);
  }
});

test("the envelope check refuses a register over the limit, a repo over its ceiling, and ceilings that add up to more", () => {
  const row = (usd, runs) => ({ workflow: "a.yml", events: ["push"], runner_class: "hosted-linux", per_run_usd: usd, runs_a_month: runs, owner: "x", reason: "x" });
  const make = (spec) => new Map(Object.entries(spec).map(([name, [ceilingUsd, ...r]]) => [name, { ghCrons: [], vercelCrons: [], ceilingUsd, workflows: r.map(([u, n]) => row(u, n)) }]));
  assert.deepEqual(envelopeProblems(make({ a: [100, [1, 100]], b: [80, [0.5, 100]] })), [], "$150 under ceilings that add up to $180");
  const over = envelopeProblems(make({ a: [200, [1, 100]], b: [100, [1, 100]] }));
  assert.ok(over.some((p) => /total \$200 a month, over the \$180/.test(p)), over.join(" | "));
  assert.ok(envelopeProblems(make({ a: [50, [1, 60]] })).some((p) => /a declares \$60 a month, over its ceiling of \$50/.test(p)));
  assert.ok(envelopeProblems(make({ a: [null, [1, 1]] })).some((p) => /a has workflow rows but no ceiling_usd/.test(p)));
  assert.ok(envelopeProblems(make({ a: [100, [1, 1]], b: [100, [1, 1]] })).some((p) => /ceilings add up to \$200/.test(p)));
  assert.deepEqual(envelopeProblems(make({ a: [90, [1, 90]] }), 90), [], "exactly at the limit passes");
});

test("workflows: rows are read as rows, and never as crons", () => {
  const sample = [
    "repos:",
    "  demo:",
    "    ceiling_usd: 5",
    "    github_actions_crons:",
    "      - workflow: nightly.yml",
    '        cron: "17 3 * * *"',
    "    workflows:",
    "      - workflow: ci.yml",
    '        events: "pull_request, merge_group"',
    "        runner_class: hosted-linux",
    "        per_run_usd: 0.25",
    "        runs_a_month: 40",
    '        owner: "DD Framework"',
    '        reason: "tests, see #123 for why"',
    '        pr_exempt_jobs: "verify, build"',
    '        pr_exempt_reason: "the PR check"',
    "    vercel_crons: []",
    "",
  ].join("\n");
  const b = budgetForRepo(sample, "demo");
  assert.equal(b.ghCrons.length, 1, "the cron list is only the cron");
  assert.equal(b.workflows.length, 1);
  assert.deepEqual(b.workflows[0].events, ["pull_request", "merge_group"]);
  assert.deepEqual(b.workflows[0].pr_exempt_jobs, ["verify", "build"]);
  assert.equal(b.workflows[0].per_run_usd, 0.25);
  assert.equal(b.workflows[0].reason, "tests, see #123 for why", "a # inside a value is kept");
  assert.equal(b.ceilingUsd, 5);
  assert.equal(budgetForRepo(sample, "nobody").workflows.length, 0);
});

test("each repo appears once under repos: (a duplicate key is invalid YAML and was merged silently)", () => {
  const keys = [];
  let inRepos = false;
  for (const line of raw.split("\n")) {
    if (/^repos:\s*$/.test(line)) { inRepos = true; continue; }
    if (inRepos && /^\S/.test(line) && !line.startsWith("#")) break;
    const m = inRepos && /^  ([^\s#][^:]*):\s*$/.exec(line);
    if (m) keys.push(m[1]);
  }
  assert.ok(keys.length > 20, "found the repo keys");
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], "repo keys listed twice");
});
