// Minimal reader for budget.yml's own fixed shape:
//
//   repos:
//     <name>:
//       ceiling_usd: 12.5                  # optional: the most this repo's workflows may cost a month
//       github_actions_crons: [{workflow, cron, ...}]
//       vercel_crons:         [{app, path, schedule, ...}]
//       workflows:            [{workflow, events, runner_class, per_run_usd, runs_a_month, owner, reason, ...}]
//
// `workflows` is the cost register (DOM-17682): one row per workflow file that starts on an event of
// its own, with what one run costs and how many runs a month, so the declared envelope can be summed
// and tested (test/budget.test.mjs) and read by the daily ledger in dd-repo-registry. The repo is the
// parent key, as it is for the crons; workflowRows() puts it on each row as `repo`.
//
// Every list item starts with `- key: value` at six spaces and continues at eight. Scalars only, so a
// list such as `events` is a comma-separated string, read into an array here.

// No inline comments after a value: a reason may contain " #123".
const scalar = (v) => v.trim().replace(/^["']|["']$/g, "");
const NUMBERS = ["per_run_usd", "runs_a_month", "measured_per_run_usd"];
const LISTS = ["events", "pr_exempt_jobs"];

function typedRow(row) {
  const out = { ...row };
  for (const k of NUMBERS) if (k in out) out[k] = out[k] === "" ? NaN : Number(out[k]);
  for (const k of LISTS) if (k in out) out[k] = out[k].split(",").map((s) => s.trim()).filter(Boolean);
  return out;
}

/** Every repo's entry: Map name => { ghCrons, vercelCrons, workflows, ceilingUsd }. A repo named twice is merged. */
export function parseBudget(raw) {
  const repos = new Map();
  let inRepos = false;
  let entry = null;
  let section = null; // 'ga' | 'vercel' | 'wf'
  let cur = null;
  for (const line of raw.split("\n")) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    const repoMatch = line.match(/^  (\S+):\s*$/);
    if (repoMatch) {
      const name = repoMatch[1];
      if (!repos.has(name)) repos.set(name, { ghCrons: [], vercelCrons: [], workflows: [], ceilingUsd: null });
      entry = repos.get(name);
      section = null;
      cur = null;
      continue;
    }
    if (!entry) continue;
    const key = line.match(/^ {4}(\w+):(.*)$/);
    if (key) {
      section = { github_actions_crons: "ga", vercel_crons: "vercel", workflows: "wf" }[key[1]] ?? null;
      cur = null;
      if (key[1] === "ceiling_usd") entry.ceilingUsd = Number(scalar(key[2]));
      continue;
    }
    const itemStart = line.match(/^\s{6}-\s*(\w+):\s*(.*)$/);
    if (itemStart) {
      cur = { [itemStart[1]]: scalar(itemStart[2]) };
      if (section === "ga") entry.ghCrons.push(cur);
      if (section === "vercel") entry.vercelCrons.push(cur);
      if (section === "wf") entry.workflows.push(cur);
      continue;
    }
    const itemCont = line.match(/^\s{8}(\w+):\s*(.*)$/);
    if (itemCont && cur) cur[itemCont[1]] = scalar(itemCont[2]);
  }
  for (const e of repos.values()) e.workflows = e.workflows.map(typedRow);
  return repos;
}

export function budgetForRepo(raw, name) {
  const e = parseBudget(raw).get(name);
  return { ghCrons: e?.ghCrons ?? [], vercelCrons: e?.vercelCrons ?? [], workflows: e?.workflows ?? [], ceilingUsd: e?.ceilingUsd ?? null };
}

/** Every workflows: row in the file, with its repo on it. */
export function workflowRows(raw) {
  return [...parseBudget(raw)].flatMap(([repo, e]) => e.workflows.map((row) => ({ repo, ...row })));
}

/** What a row says it costs a month. */
export const rowMonthlyUsd = (row) => row.per_run_usd * row.runs_a_month;

/** The monthly GitHub Actions allowance, and the share the declared rows may use (DOM-17629: at or below 60%). */
export const ALLOWANCE_USD = 300;
export const ENVELOPE_SHARE = 0.6;
export const ENVELOPE_USD = ALLOWANCE_USD * ENVELOPE_SHARE;
const cents = (n) => Math.round(n * 100) / 100;

/**
 * What the declared rows add up to: { total, byRepo: { name: usd } }. Rounded to the cent, so a floating-point
 * crumb never decides a pass.
 */
export function envelope(repos) {
  const byRepo = {};
  for (const [name, e] of repos) if (e.workflows.length) byRepo[name] = cents(e.workflows.reduce((a, r) => a + rowMonthlyUsd(r), 0));
  return { total: cents(Object.values(byRepo).reduce((a, b) => a + b, 0)), byRepo };
}

/** What is wrong with the declared envelope, as sentences; empty when it fits. */
export function envelopeProblems(repos, limit = ENVELOPE_USD) {
  const out = [];
  const { total, byRepo } = envelope(repos);
  if (total > limit) out.push(`the declared envelopes total $${total} a month, over the $${limit} limit (${ENVELOPE_SHARE * 100}% of $${ALLOWANCE_USD})`);
  for (const [name, usd] of Object.entries(byRepo)) {
    const ceiling = repos.get(name).ceilingUsd;
    if (!Number.isFinite(ceiling)) out.push(`${name} has workflow rows but no ceiling_usd`);
    else if (usd > ceiling) out.push(`${name} declares $${usd} a month, over its ceiling of $${ceiling}`);
  }
  const ceilings = cents([...repos.values()].reduce((a, e) => a + (e.workflows.length && Number.isFinite(e.ceilingUsd) ? e.ceilingUsd : 0), 0));
  if (ceilings > limit) out.push(`the repo ceilings add up to $${ceilings}, over the $${limit} limit: the budget is allocated more than once`);
  return out;
}
