// Minimal reader for budget.yml's own fixed shape:
//
//   repos:
//     <name>:
//       ceiling_usd: 12.5                  # optional: the most this repo's workflows may cost a month
//       over_ceiling_until: "2026-12-15"   # optional, all four or none: a dated, issue-linked acknowledgement that this
//       over_ceiling_issue: DOM-18024      #   repo is known to declare more than its ceiling_usd, for no more than
//       over_ceiling_usd: 249.69           #   over_ceiling_usd a month, until that day (see envelopeProblems)
//       over_ceiling_reason: "why, and what brings it back"
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
// job_minutes (CI-041): the expected minutes of the jobs that may run over ten minutes, as "job=minutes, other job=minutes".
// A job's name may hold spaces and a slash ("portal-journeys / journeys"), never a comma or an equals sign.
const MAPS = ["job_minutes"];

/** "a=1.5, b / c=20" => { a: 1.5, "b / c": 20 }; a part with no number reads as NaN, so a rule can refuse it. */
export function parseJobMinutes(text) {
  const out = {};
  for (const part of String(text).split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = part.lastIndexOf("=");
    if (at < 0) out[part] = NaN;
    else out[part.slice(0, at).trim()] = part.slice(at + 1).trim() === "" ? NaN : Number(part.slice(at + 1));
  }
  return out;
}

function typedRow(row) {
  const out = { ...row };
  for (const k of NUMBERS) if (k in out) out[k] = out[k] === "" ? NaN : Number(out[k]);
  for (const k of LISTS) if (k in out) out[k] = out[k].split(",").map((s) => s.trim()).filter(Boolean);
  for (const k of MAPS) if (k in out) out[k] = parseJobMinutes(out[k]);
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
      if (!repos.has(name)) repos.set(name, { ghCrons: [], vercelCrons: [], workflows: [], ceilingUsd: null, overCeiling: null });
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
      const over = { over_ceiling_until: "until", over_ceiling_issue: "issue", over_ceiling_reason: "reason", over_ceiling_usd: "usd" }[key[1]];
      if (over) {
        entry.overCeiling ??= { until: "", issue: "", reason: "", usd: NaN };
        const v = scalar(key[2]);
        entry.overCeiling[over] = over === "usd" ? (v === "" ? NaN : Number(v)) : v;
      }
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
  return { ghCrons: e?.ghCrons ?? [], vercelCrons: e?.vercelCrons ?? [], workflows: e?.workflows ?? [], ceilingUsd: e?.ceilingUsd ?? null, overCeiling: e?.overCeiling ?? null };
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

/** The longest an acknowledged overage may run from today: a short loan, never a standing exemption. */
export const OVER_CEILING_MAX_DAYS = 45;
const DAY_MS = 86400000;
const utcToday = () => new Date().toISOString().slice(0, 10);
/** A real UTC calendar day as milliseconds, or NaN: "2026-12-32" and "15 Dec 2026" are both NaN. */
const isoDay = (s) => {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? ms : NaN;
};

/**
 * What is wrong with a repo's acknowledgement of a known overage (empty when it holds): the date is a real
 * YYYY-MM-DD, not yet past (the day itself still counts) and at most OVER_CEILING_MAX_DAYS away; the issue is a
 * DOM-n; there is a reason and a dollar figure; the repo really is over its ceiling; and it has not grown past
 * the figure.
 */
function acknowledgementProblems(name, e, usd, today) {
  const a = e.overCeiling;
  const out = [];
  const until = isoDay(a.until);
  const now = isoDay(today);
  if (Number.isNaN(until)) out.push(`${name} over_ceiling_until must be a real YYYY-MM-DD date`);
  else if (until < now) out.push(`${name}'s acknowledged overage ran out on ${a.until}: bring it back inside its ceiling (${a.issue || "no issue named"}) or get a new dated yes`);
  else if ((until - now) / DAY_MS > OVER_CEILING_MAX_DAYS) out.push(`${name} over_ceiling_until ${a.until} is more than ${OVER_CEILING_MAX_DAYS} days away`);
  if (!/^DOM-\d+$/.test(a.issue)) out.push(`${name} over_ceiling_issue must name the Linear issue that brings it back, as DOM-123`);
  if (!a.reason.trim()) out.push(`${name} over_ceiling_reason is empty`);
  if (!(a.usd > 0)) out.push(`${name} over_ceiling_usd must be the monthly figure being acknowledged, above 0`);
  if (!Number.isFinite(e.ceilingUsd)) return out;
  if (!(usd > e.ceilingUsd)) out.push(`${name} is within its ceiling of $${e.ceilingUsd} (declares $${usd}): delete its over_ceiling_* keys`);
  else if (a.usd > 0 && usd > a.usd) out.push(`${name} declares $${usd} a month, more than the $${a.usd} acknowledged: the acknowledgement covers that figure and no more`);
  return out;
}

/**
 * The known overages that are acknowledged and valid today: [{ repo, usd, ceiling, over, until, issue, reason,
 * daysLeft }], `over` being the dollars above the ceiling. One that has run out, is too far away, is incomplete or
 * is outdated is not listed: envelopeProblems reports it as a problem instead.
 */
export function acknowledgedOverages(repos, today = utcToday()) {
  const { byRepo } = envelope(repos);
  const out = [];
  for (const [name, usd] of Object.entries(byRepo)) {
    const e = repos.get(name);
    if (!e.overCeiling || !Number.isFinite(e.ceilingUsd) || usd <= e.ceilingUsd) continue;
    if (acknowledgementProblems(name, e, usd, today).length) continue;
    const a = e.overCeiling;
    out.push({ repo: name, usd, ceiling: e.ceilingUsd, over: cents(usd - e.ceilingUsd), until: a.until, issue: a.issue, reason: a.reason, daysLeft: Math.round((isoDay(a.until) - isoDay(today)) / DAY_MS) });
  }
  return out;
}

/**
 * What is wrong with the declared envelope, as sentences; empty when it fits. A repo over its ceiling is a problem
 * unless it carries a valid acknowledgement (see acknowledgedOverages) for at least what it declares. The total may
 * then pass the limit only by the overage those acknowledgements explain, so a new overage anywhere else, or growth
 * past an acknowledged figure, still fails. `today` is a UTC YYYY-MM-DD, passed in by tests.
 */
export function envelopeProblems(repos, limit = ENVELOPE_USD, today = utcToday()) {
  const out = [];
  const { total, byRepo } = envelope(repos);
  const acknowledged = acknowledgedOverages(repos, today);
  const explained = cents(acknowledged.reduce((a, o) => a + o.over, 0));
  if (cents(total - explained) > limit) out.push(`the declared envelopes total $${total} a month, over the $${limit} limit (${ENVELOPE_SHARE * 100}% of $${ALLOWANCE_USD})${explained ? `, and the acknowledged overage explains only $${explained} of it` : ""}`);
  for (const [name, usd] of Object.entries(byRepo)) {
    const ceiling = repos.get(name).ceilingUsd;
    if (!Number.isFinite(ceiling)) out.push(`${name} has workflow rows but no ceiling_usd`);
    else if (usd > ceiling && !acknowledged.some((o) => o.repo === name)) out.push(`${name} declares $${usd} a month, over its ceiling of $${ceiling}`);
  }
  for (const [name, e] of repos) if (e.overCeiling) out.push(...acknowledgementProblems(name, e, byRepo[name] ?? 0, today));
  const ceilings = cents([...repos.values()].reduce((a, e) => a + (e.workflows.length && Number.isFinite(e.ceilingUsd) ? e.ceilingUsd : 0), 0));
  if (ceilings > limit) out.push(`the repo ceilings add up to $${ceilings}, over the $${limit} limit: the budget is allocated more than once`);
  return out;
}
