import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { median, pick, evaluate, DEFAULT_BUDGETS } from "../.github/actions/psi-gate/psi-gate.mjs";

const action = readFileSync(new URL("../.github/actions/psi-gate/action.yml", import.meta.url), "utf8");
const run = (lcp, perf = 100, fcp = 900, cls = 0) => ({ performance: perf, "first-contentful-paint": fcp, "largest-contentful-paint": lcp, "cumulative-layout-shift": cls });

test("median of odd and even lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("a steady page passes on the median, one slow run does not fail it", () => {
  const v = evaluate([run(1650), run(1700), run(3100), run(1600), run(1680)]);
  assert.equal(v.ok, true, v.problems.join("; "));
});

test("a page whose median LCP is over the budget fails, naming the metric", () => {
  const v = evaluate([run(2600), run(2700), run(2400), run(2800), run(2650)]);
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /largest-contentful-paint median 2650 is over the budget 2500/);
});

test("layout shift and first paint have budgets too", () => {
  assert.equal(evaluate([run(1000, 100, 2000), run(1000, 100, 2100), run(1000, 100, 1900)]).ok, false);
  assert.equal(evaluate([run(1000, 100, 900, 0.3), run(1000, 100, 900, 0.3), run(1000, 100, 900, 0.3)]).ok, false);
});

test("too few usable runs fail instead of passing on thin evidence", () => {
  const v = evaluate([run(1000), run(1000)]);
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /only 2 usable run/);
});

test("a missing metric fails", () => {
  const bare = { performance: 100 };
  assert.equal(evaluate([bare, bare, bare]).ok, false);
});

test("the performance floor applies only when asked for", () => {
  const runs = [run(1000, 80), run(1000, 85), run(1000, 90)];
  assert.equal(evaluate(runs).ok, true);
  assert.equal(evaluate(runs, { minPerformance: 90 }).ok, false);
});

test("budgets are the lab gate's: FCP 1.8 s, LCP 2.5 s, CLS 0.1", () => {
  assert.deepEqual(DEFAULT_BUDGETS, { "first-contentful-paint": 1800, "largest-contentful-paint": 2500, "cumulative-layout-shift": 0.1 });
});

test("pick reads a PageSpeed response and rejects an empty one", () => {
  const body = { lighthouseResult: { categories: { performance: { score: 0.98 } }, audits: { "first-contentful-paint": { numericValue: 937 }, "largest-contentful-paint": { numericValue: 1652 }, "cumulative-layout-shift": { numericValue: 0 } } } };
  assert.deepEqual(pick(body), run(1652, 98, 937, 0));
  assert.throws(() => pick({}), /no lighthouseResult/);
});

test("the manifest is a composite that takes the key as an input and runs the script", () => {
  assert.match(action, /using: composite/);
  assert.match(action, /api-key:\n\s+description: .*\n\s+required: true/);
  assert.match(action, /node "\$GITHUB_ACTION_PATH\/psi-gate.mjs"/);
  assert.ok(!/\$\{\{ secrets\./.test(action), "the key comes in as an input, never read from secrets inside the action");
});

test("the category floors fail a median below them and leave a switched-off one alone (DOM-17811)", async () => {
  const { evaluate, pick, DEFAULT_MIN_SCORES } = await import("../.github/actions/psi-gate/psi-gate.mjs");
  assert.deepEqual(DEFAULT_MIN_SCORES, { accessibility: 90, "best-practices": 90, seo: 90 });
  const run = (a, b, s) => ({ performance: 95, accessibility: a, "best-practices": b, seo: s, "first-contentful-paint": 900, "largest-contentful-paint": 1200, "cumulative-layout-shift": 0.01 });
  const runs = [run(100, 96, 100), run(100, 78, 100), run(100, 79, 100)];
  const v = evaluate(runs, { minScores: DEFAULT_MIN_SCORES });
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems, ["best-practices median 79 is below 90"]);
  assert.equal(evaluate(runs, { minScores: { ...DEFAULT_MIN_SCORES, "best-practices": 0 } }).ok, true);
  // A category PageSpeed did not score is a failure, never a pass.
  const blind = evaluate([run(undefined, 96, 100), run(undefined, 96, 100), run(undefined, 96, 100)], { minScores: DEFAULT_MIN_SCORES });
  assert.deepEqual(blind.problems, ["accessibility has no score in any run"]);
  // pick() reads the category scores as 0 to 100.
  const json = { lighthouseResult: { categories: { performance: { score: 0.91 }, accessibility: { score: 1 }, "best-practices": { score: 0.78 }, seo: { score: 0.92 } }, audits: {} } };
  assert.deepEqual([pick(json).accessibility, pick(json)["best-practices"], pick(json).seo], [100, 78, 92]);
});

