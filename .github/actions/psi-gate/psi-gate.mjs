// PageSpeed Insights gate (DOM-17734). Runs PSI against a public URL `runs` times per strategy,
// takes the median of each paint metric and fails when a median breaks its budget. This replaces a
// lab Lighthouse budget on a shared CI runner, where the same build swung 2.1 to 3.1 s on LCP.
import { appendFileSync } from "node:fs";

export const DEFAULT_BUDGETS = {
  "first-contentful-paint": 1800,
  "largest-contentful-paint": 2500,
  "cumulative-layout-shift": 0.1,
};

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// One PSI v5 response to the numbers the gate needs.
export function pick(json) {
  const lh = json?.lighthouseResult;
  if (!lh?.audits || !lh?.categories?.performance) throw new Error("PageSpeed response has no lighthouseResult");
  const out = { performance: Math.round((lh.categories.performance.score ?? 0) * 100) };
  for (const id of Object.keys(DEFAULT_BUDGETS)) out[id] = lh.audits[id]?.numericValue;
  return out;
}

// Pure verdict: runs is an array of pick() results for one strategy.
export function evaluate(runs, { budgets = DEFAULT_BUDGETS, minPerformance = 0, minRuns = 3 } = {}) {
  const problems = [];
  if (runs.length < minRuns) problems.push(`only ${runs.length} usable run(s), need ${minRuns}`);
  const metrics = {};
  for (const id of Object.keys(budgets)) {
    const values = runs.map((r) => r[id]).filter((v) => Number.isFinite(v));
    const m = median(values);
    metrics[id] = { median: m, min: Math.min(...values), max: Math.max(...values), budget: budgets[id] };
    if (!Number.isFinite(m)) problems.push(`${id} has no value in any run`);
    else if (m > budgets[id]) problems.push(`${id} median ${Math.round(m * 1000) / 1000} is over the budget ${budgets[id]}`);
  }
  const perf = runs.map((r) => r.performance);
  const perfMedian = median(perf);
  if (minPerformance && perfMedian < minPerformance) problems.push(`performance median ${perfMedian} is below ${minPerformance}`);
  return { ok: problems.length === 0, problems, metrics, performance: { median: perfMedian, min: Math.min(...perf), max: Math.max(...perf), runs: perf } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRun(url, strategy, key) {
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", strategy);
  api.searchParams.set("category", "performance");
  api.searchParams.set("key", key);
  const res = await fetch(api, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`PageSpeed answered ${res.status} for ${strategy}`);
  return pick(await res.json());
}

// PageSpeed caches an identical request for about a minute, so runs of one strategy are spaced out.
async function collect(url, strategy, key, runs, gapMs, tries = 2) {
  const got = [];
  for (let i = 0; i < runs; i++) {
    if (i) await sleep(gapMs);
    for (let t = 1; t <= tries; t++) {
      try { got.push(await fetchRun(url, strategy, key)); break; }
      catch (err) { console.log(`${strategy} run ${i + 1} attempt ${t}: ${err.message}`); if (t < tries) await sleep(5000); }
    }
  }
  return got;
}

export async function main(env = process.env) {
  const key = env.PSI_API_KEY;
  const url = env.PSI_URL;
  if (!key) throw new Error("PSI_API_KEY is not set");
  if (!/^https:\/\//.test(url ?? "")) throw new Error("PSI_URL must be a public https URL");
  const runs = Number(env.PSI_RUNS || 5);
  const gapMs = Number(env.PSI_GAP_SECONDS ?? 61) * 1000;
  const budgets = { ...DEFAULT_BUDGETS };
  if (env.PSI_LCP_MS) budgets["largest-contentful-paint"] = Number(env.PSI_LCP_MS);
  if (env.PSI_FCP_MS) budgets["first-contentful-paint"] = Number(env.PSI_FCP_MS);
  if (env.PSI_CLS) budgets["cumulative-layout-shift"] = Number(env.PSI_CLS);
  const strategies = (env.PSI_STRATEGIES || "mobile,desktop").split(",").map((s) => s.trim()).filter(Boolean);
  const minPerformance = Number(env.PSI_MIN_PERFORMANCE || 0);

  const results = await Promise.all(strategies.map(async (s) => [s, evaluate(await collect(url, s, key, runs, gapMs), { budgets, minPerformance })]));
  let failed = false;
  const lines = [`### PageSpeed gate for ${url}`, "", "| Strategy | Performance (median, runs) | FCP ms | LCP ms | CLS | Result |", "| --- | --- | --- | --- | --- | --- |"];
  for (const [s, v] of results) {
    const f = v.metrics["first-contentful-paint"], l = v.metrics["largest-contentful-paint"], c = v.metrics["cumulative-layout-shift"];
    const r = (m) => `${Math.round(m.median * 1000) / 1000} (${Math.round(m.min * 1000) / 1000} to ${Math.round(m.max * 1000) / 1000})`;
    lines.push(`| ${s} | ${v.performance.median} (${v.performance.runs.join(", ")}) | ${r(f)} | ${r(l)} | ${r(c)} | ${v.ok ? "pass" : "FAIL"} |`);
    for (const p of v.problems) { console.error(`${s}: ${p}`); failed = true; }
    console.log(`${s}: ${v.ok ? "pass" : "fail"} performance median ${v.performance.median}, LCP median ${Math.round(l.median)} ms (budget ${l.budget}), runs ${v.performance.runs.length}`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}
