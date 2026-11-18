// CI-043 (DOM-17629): a declared price per run must be within 50% of the measured one when a row records it.
// The case that started it: ci.yml declared at $0.0292 a run and measured $0.157, so the envelope passed on a wrong number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor } from "../lib/engine.mjs";
import { PRICE_TOLERANCE } from "../lib/rules.mjs";
import { parseBudget, workflowRows } from "../lib/budget.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", meta: null, taxonomy };
const row = (over = {}) => ({ workflow: "ci.yml", events: ["push"], runner_class: "hosted-linux", per_run_usd: 0.0292, runs_a_month: 2212, owner: "DD Framework", reason: "x", ...over });
const view = { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  push:\n    branches: [main]\njobs: {}\n" }], vercel: [], files: {} };
const found = (workflows, extra = {}) => runDoctor(view, rulebook, { ...base, budget: { ghCrons: [], vercelCrons: [], workflows }, ...extra }).findings.filter((f) => f.rule === "CI-043");
const measured = (m, over = {}) => row({ measured_per_run_usd: m, measured_on: "2026-11-17", ...over });

test("a declared price far from the measured one is refused, with what to do and where the live figure is", () => {
  const f = found([measured(0.157)]);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /declares \$0\.0292 a run for ci\.yml in demo but records a measured \$0\.157 \(2026-11-17\): more than 50% apart/);
  assert.match(f[0].message, /Set per_run_usd \(and runs_a_month\)/);
  assert.match(f[0].message, /BUD-004.*ledger\.json.*workflow_costs/);
  assert.equal(f[0].level, "enforce", "from 1 December");
  assert.equal(found([measured(0.157)], { today: "2026-11-20" })[0].level, "warn", "a warning first");
});

test("a declared price within half of the measured one passes, and the band is the same either way up", () => {
  assert.equal(PRICE_TOLERANCE, 0.5);
  assert.deepEqual(found([measured(0.157, { per_run_usd: 0.1586 })]), [], "the corrected monorepo row");
  assert.deepEqual(found([measured(0.1, { per_run_usd: 0.15 })]), [], "exactly 50% over passes");
  assert.deepEqual(found([measured(0.1, { per_run_usd: 0.05 })]), [], "exactly 50% under passes");
  assert.equal(found([measured(0.1, { per_run_usd: 0.1501 })]).length, 1, "just over");
  assert.equal(found([measured(0.1, { per_run_usd: 0.0499 })]).length, 1, "just under: a declared price too high is also far from the truth");
});

test("a row with no measured price is not judged; a bad figure or a missing date is refused", () => {
  assert.deepEqual(found([row()]), []);
  for (const bad of [0, -1, NaN]) assert.match(found([row({ measured_per_run_usd: bad, measured_on: "2026-11-17" })])[0].message, /not a number above 0/, String(bad));
  const noDate = found([row({ measured_per_run_usd: 0.03 })]);
  assert.equal(noDate.length, 1);
  assert.match(noDate[0].message, /no measured_on/);
  assert.equal(found([row({ measured_per_run_usd: 0.03, measured_on: "17 Nov" })]).length, 1, "the date is YYYY-MM-DD");
});

test("a client's own account, and a budget with no workflows section, are not judged", () => {
  assert.deepEqual(found([measured(0.157)], { meta: { owner: { login: "someclient" } } }), []);
  assert.deepEqual(runDoctor(view, rulebook, { ...base, budget: { ghCrons: [], vercelCrons: [] } }).findings.filter((f) => f.rule === "CI-043"), []);
});

test("budget.yml reads the measured price as a number, and the monorepo's ci.yml row records its measurement", () => {
  const raw = readFileSync(new URL("../budget.yml", import.meta.url), "utf8");
  const ci = workflowRows(raw).find((r) => r.repo === "Doman-Digital" && r.workflow === "ci.yml");
  assert.equal(typeof ci.measured_per_run_usd, "number");
  assert.match(ci.measured_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(ci.measured_basis.length > 40, "the measurement says how it was made");
  const sample = ["repos:", "  demo:", "    workflows:", "      - workflow: ci.yml", "        measured_per_run_usd: 0.157", '        measured_on: "2026-11-17"', '        events: "push"', "        runner_class: hosted-linux", "        per_run_usd: 0.1", "        runs_a_month: 5", '        owner: "x"', '        reason: "y"'].join("\n");
  assert.equal(parseBudget(sample).get("demo").workflows[0].measured_per_run_usd, 0.157);
});

test("every row that records a measured price in budget.yml is within the band, the monorepo row included", () => {
  const raw = readFileSync(new URL("../budget.yml", import.meta.url), "utf8");
  const apart = workflowRows(raw).filter((r) => "measured_per_run_usd" in r && Math.abs(r.per_run_usd - r.measured_per_run_usd) > PRICE_TOLERANCE * r.measured_per_run_usd);
  // The monorepo ci.yml row is priced at its measured $0.1586 a run (DOM-17629, dd-ci-standards#178). The envelope it breaks is
  // carried by a dated acknowledgement in budget.yml (DOM-18024), not by an exception here: no row may be far from its measurement.
  assert.deepEqual(apart.map((r) => `${r.repo} ${r.workflow}`), [], "a row far from its measurement");
});
