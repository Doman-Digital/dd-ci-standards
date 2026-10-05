// dd adopt: bring a repo up to the rulebook in one reviewable change.
//
// Two kinds of change. Files the framework owns are written outright: the
// policy check caller and a Renovate config. Everything else the doctor finds
// is recorded in .github/dd.json as an exemption that expires in 60 days, so
// the adopting PR is green on arrival and every piece of existing debt has a
// date and a line in the repo, instead of a red check people learn to ignore.
//
// Pure: takes a view and returns the files to write. bin/dd.mjs does the disk.

import { runDoctor } from "./engine.mjs";
import { IGNORE_BLOCK } from "./rules.mjs";

export const BASELINE_DAYS = 60;

export const POLICY_CALLER = `name: ci-standards policy

# The DD Framework policy check: runs \`dd doctor\` from
# Doman-Digital/dd-ci-standards on every PR. Added by \`dd adopt\`.

on:
  pull_request:

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  ci-standards-policy:
    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1
`;

export const RENOVATE = `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1"]
}
`;

const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

/** Apply file writes to a view, for re-running the doctor on the result. */
function withFiles(view, writes) {
  const next = { workflows: [...view.workflows], vercel: view.vercel, files: { ...view.files } };
  for (const [path, text] of Object.entries(writes)) {
    if (path.startsWith(".github/workflows/")) {
      next.workflows = next.workflows.filter((w) => w.path !== path).concat({ path, text }).sort((a, b) => a.path.localeCompare(b.path));
    } else next.files[path] = text;
  }
  return next;
}

/**
 * Returns { writes: { path: text }, summary: [lines], after } where after is
 * the doctor's result on the adopted repo (it should have nothing failing).
 */
export function planAdopt(view, rulebook, ctx) {
  const writes = {};
  const summary = [];
  const before = runDoctor(view, rulebook, ctx);
  const has = (id) => before.findings.some((f) => f.rule === id);

  if (has("REG-003") || has("SEC-006")) {
    writes[".github/workflows/ci-standards-policy.yml"] = POLICY_CALLER;
    summary.push("add .github/workflows/ci-standards-policy.yml: the policy check and secret scan on every PR (REG-003, SEC-006)");
  }
  if (has("SEC-005")) {
    const current = view.files[".gitignore"] || "";
    writes[".gitignore"] = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${IGNORE_BLOCK}`;
    summary.push(".gitignore: ignore env and token files (SEC-005)");
  }
  const sec3 = before.findings.find((f) => f.rule === "SEC-003");
  if (sec3) {
    const f = sec3.file;
    const current = view.files[f];
    if (current && /Doman-Digital\/ci-standards\b/.test(current)) {
      writes[f] = current.replace(/Doman-Digital\/ci-standards\b/g, "Doman-Digital/dd-ci-standards");
      summary.push(`${f}: extend dd-ci-standards, the preset's current name (SEC-003)`);
    } else if (!current) {
      writes["renovate.json"] = RENOVATE;
      summary.push("add renovate.json extending the shared preset (SEC-003)");
    }
  }

  // Everything still found becomes a dated baseline exemption.
  const mid = runDoctor(withFiles(view, writes), rulebook, ctx);
  let dd = {};
  try {
    dd = view.files[".github/dd.json"] ? JSON.parse(view.files[".github/dd.json"]) : {};
  } catch {
    dd = {};
  }
  const exempt = [...(dd.exempt || [])];
  const until = addDays(ctx.today, BASELINE_DAYS);
  const seen = new Set(exempt.map((e) => `${e.rule}|${e.file || ""}`));
  let added = 0;
  for (const f of mid.findings) {
    if (f.level === "report" || f.rule === "FW-002") continue;
    const key = `${f.rule}|${f.file || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    exempt.push({ rule: f.rule, file: f.file || undefined, until, reason: `Baseline at adoption on ${ctx.today}: fix it, or replace this with a reasoned exemption, before it expires.` });
    added += 1;
  }
  if (added) {
    writes[".github/dd.json"] = JSON.stringify({ ...dd, exempt }, null, 2) + "\n";
    summary.push(`.github/dd.json: ${added} existing finding(s) recorded as exemptions until ${until}`);
  }
  const after = runDoctor(withFiles(view, writes), rulebook, ctx);
  return { writes, summary, before, after };
}
