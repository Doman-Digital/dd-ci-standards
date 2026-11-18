// The envelope test (DOM-17682, I2): the cost register in budget.yml must add up to at most 60% of the
// $300 monthly allowance, no repo may declare more than its ceiling, and the ceilings themselves must fit
// the same limit. release.yml runs this before it tags, so a release that breaks it is blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBudget, budgetForRepo, workflowRows, envelope, envelopeProblems, acknowledgedOverages, ENVELOPE_USD } from "../lib/budget.mjs";
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

// DOM-18024: a dated, issue-linked acknowledgement of one repo's known overage. Narrow on purpose: one repo, one
// dollar figure, one issue, at most 45 days. It never raises a ceiling or the envelope limit.
const aRow = (usd, runs) => ({ workflow: "a.yml", events: ["push"], runner_class: "hosted-linux", per_run_usd: usd, runs_a_month: runs, owner: "x", reason: "x" });
const aRepos = (spec) => new Map(Object.entries(spec).map(([name, [ceilingUsd, overCeiling, ...r]]) => [name, { ghCrons: [], vercelCrons: [], ceilingUsd, overCeiling, workflows: r.map(([u, n]) => aRow(u, n)) }]));
const ACK = { until: "2026-12-15", issue: "DOM-18024", reason: "known, being brought back", usd: 250 };
const TODAY = "2026-11-18";
// big: $250 under a $100 ceiling, acknowledged; small: $30 under $40. Total $280 against the $180 limit.
const withAck = (over = ACK, big = 250) => aRepos({ big: [100, over, [1, big]], small: [40, null, [1, 30]] });
const problemsOf = (over, today = TODAY, big = 250) => envelopeProblems(withAck(over, big), 180, today);

test("a known overage passes while its acknowledgement holds, and shows in the output", (t) => {
  assert.deepEqual(problemsOf(ACK), [], "the acknowledged overage passes, the total included");
  const [o] = acknowledgedOverages(withAck(), TODAY);
  assert.deepEqual({ repo: o.repo, usd: o.usd, ceiling: o.ceiling, over: o.over, daysLeft: o.daysLeft, issue: o.issue }, { repo: "big", usd: 250, ceiling: 100, over: 150, daysLeft: 27, issue: "DOM-18024" });
  t.diagnostic(`acknowledged: ${o.repo} $${o.usd} against $${o.ceiling} (+$${o.over}) until ${o.until}, ${o.issue}`);
  assert.deepEqual(problemsOf({ ...ACK, until: TODAY }), [], "the last day still counts");
});

test("an acknowledgement fails once its date has passed, and the overage is a problem again", () => {
  const expired = problemsOf(ACK, "2026-12-16");
  assert.ok(expired.some((p) => /ran out on 2026-12-15/.test(p)), expired.join(" | "));
  assert.ok(expired.some((p) => /big declares \$250 a month, over its ceiling of \$100/.test(p)));
  assert.ok(expired.some((p) => /total \$280 a month, over the \$180/.test(p)));
  assert.deepEqual(acknowledgedOverages(withAck(), "2026-12-16"), [], "an expired one is not listed as acknowledged");
});

test("an acknowledgement fails when it is more than 45 days away, is not a date, or lacks an issue, reason or figure", () => {
  assert.deepEqual(problemsOf({ ...ACK, until: "2027-01-02" }), [], "exactly 45 days from 18 Nov is allowed");
  assert.ok(problemsOf({ ...ACK, until: "2027-01-03" }).some((p) => /more than 45 days away/.test(p)), "46 days is not");
  const bad = [
    [{ ...ACK, until: "2026-12-32" }, /real YYYY-MM-DD/],
    [{ ...ACK, until: "" }, /real YYYY-MM-DD/],
    [{ ...ACK, until: "15 Dec 2026" }, /real YYYY-MM-DD/],
    [{ ...ACK, issue: "" }, /over_ceiling_issue/],
    [{ ...ACK, issue: "ABC-1" }, /over_ceiling_issue/],
    [{ ...ACK, reason: "  " }, /over_ceiling_reason is empty/],
    [{ ...ACK, usd: NaN }, /over_ceiling_usd/],
    [{ ...ACK, until: "2027-01-03" }, /more than 45 days away/],
  ];
  for (const [over, re] of bad) {
    const p = problemsOf(over);
    assert.ok(p.some((x) => re.test(x)), `${JSON.stringify(over)}: ${p.join(" | ")}`);
    assert.ok(p.some((x) => /big declares \$250 a month, over its ceiling of \$100/.test(x)), "and the overage is not excused");
  }
});

test("an acknowledgement covers its figure and no more, and goes when the repo is back inside its ceiling", () => {
  const grown = problemsOf(ACK, TODAY, 250.01);
  assert.ok(grown.some((p) => /more than the \$250 acknowledged/.test(p)), grown.join(" | "));
  assert.ok(grown.some((p) => /big declares \$250.01 a month, over its ceiling of \$100/.test(p)), "growth is a plain overage again");
  const stale = envelopeProblems(aRepos({ big: [100, ACK, [1, 90]] }), 180, TODAY);
  assert.ok(stale.some((p) => /within its ceiling of \$100.*delete its over_ceiling_\* keys/.test(p)), stale.join(" | "));
  assert.ok(envelopeProblems(aRepos({ big: [100, ACK] }), 180, TODAY).some((p) => /within its ceiling/.test(p)), "a repo with no rows too");
});

test("an acknowledgement covers its own repo only: other overages and the rest of the envelope still fail", () => {
  const other = envelopeProblems(aRepos({ big: [100, ACK, [1, 250]], small: [40, null, [1, 41]] }), 180, TODAY);
  assert.ok(other.some((p) => /small declares \$41 a month, over its ceiling of \$40/.test(p)), "a second repo over its ceiling is a new overage");
  // the acknowledged repo explains $150; the other $190 of declared rows is over the $180 limit by itself
  const rest = envelopeProblems(aRepos({ big: [100, ACK, [1, 250]], mid: [200, null, [1, 190]] }), 180, TODAY);
  assert.ok(rest.some((p) => /total \$440 a month, over the \$180.*explains only \$150/.test(p)), rest.join(" | "));
  assert.equal(parseBudget(raw).get("Doman-Digital").ceilingUsd, 101, "the ceiling is not raised");
  assert.equal(ENVELOPE_USD, 180, "nor the limit");
});

test("over_ceiling_* keys are read as the repo's own keys and do not hide the rows after them", () => {
  const sample = ["repos:", "  demo:", "    ceiling_usd: 5", '    over_ceiling_until: "2026-12-15"', "    over_ceiling_issue: DOM-1", "    over_ceiling_usd: 9.5", '    over_ceiling_reason: "known, #1"', "    workflows:", "      - workflow: ci.yml", '        events: "push"', "        runner_class: hosted-linux", "        per_run_usd: 1", "        runs_a_month: 9", '        owner: "x"', '        reason: "y"', ""].join("\n");
  const b = budgetForRepo(sample, "demo");
  assert.deepEqual(b.overCeiling, { until: "2026-12-15", issue: "DOM-1", usd: 9.5, reason: "known, #1" });
  assert.equal(b.workflows.length, 1);
  assert.equal(budgetForRepo(sample, "nobody").overCeiling, null);
  assert.equal(parseBudget("repos:\n  d:\n    ceiling_usd: 1\n").get("d").overCeiling, null);
});

test("budget.yml's acknowledgement is the only one, is valid today, and is printed", (t) => {
  const acks = [...repos].filter(([, e]) => e.overCeiling).map(([name]) => name);
  assert.deepEqual(acks, ["Doman-Digital"], "a second repo needs its own review here");
  const [o] = acknowledgedOverages(repos);
  assert.ok(o, "valid today");
  t.diagnostic(`acknowledged overage: ${o.repo} $${o.usd} a month against its $${o.ceiling} ceiling (+$${o.over}), until ${o.until} (${o.daysLeft} days), ${o.issue}`);
  assert.equal(o.issue, "DOM-18024");
});
