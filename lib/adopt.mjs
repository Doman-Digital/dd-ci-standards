// dd adopt: bring a repo up to the rulebook in one reviewable change.
//
// Three kinds of change. Files the framework owns are written outright: the
// policy check caller and a Renovate config. Lines the rulebook decides are
// rewritten: a job's runs-on (CI-022). Everything else the doctor finds
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
  # A branch with a merge queue waits for this check on the queue's own run (REG-008).
  merge_group:

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

/**
 * CI-022: set each job's runs-on to the pool the rulebook gives it. Returns
 * { path: text } for the workflows it changed. A list-form runs-on loses its
 * items; a trailing comment on the line is kept.
 */
export function fixRunners(view, findings) {
  const writes = {};
  for (const w of view.workflows) {
    const mine = findings.filter((f) => (f.rule === "CI-022" || f.rule === "CI-029") && f.file === w.path && f.line && f.runsOn);
    if (!mine.length) continue;
    const lines = w.text.split("\n");
    // Bottom up, so removing list items does not move the lines still to do.
    for (const f of [...mine].sort((a, b) => b.line - a.line)) {
      const i = f.line - 1;
      const m = /^(\s*runs-on:)[ \t]*(.*?)([ \t]+#.*)?$/.exec(lines[i]);
      if (!m) continue;
      let end = i + 1;
      if (!m[2]) while (end < lines.length && /^ {6}-\s/.test(lines[end])) end++;
      lines.splice(i, end - i, `${m[1]} ${f.runsOn}${m[3] || ""}`);
    }
    writes[w.path] = lines.join("\n");
  }
  return writes;
}

/**
 * CI-030: add `actions: write` to the permissions of each job that calls the
 * shared deploy. A job with a permissions block gets the line first in it; a
 * job with none (it inherits the workflow's) gets a block of its own holding
 * the workflow's entries and the new one. An inline map (`permissions: write-all`,
 * `permissions: { ... }`) is left for a person.
 */
export function fixDeployPermissions(view, findings) {
  const writes = {};
  for (const w of view.workflows) {
    const mine = findings.filter((f) => f.rule === "CI-030" && f.file === w.path && f.line);
    if (!mine.length) continue;
    const lines = w.text.split("\n");
    const top = /^permissions:[ \t]*$/m.exec(w.text);
    const topEntries = top ? (/^permissions:[ \t]*\n((?: {2,}\S.*\n?)*)/m.exec(w.text)?.[1] ?? "").split("\n").filter(Boolean).map((l) => l.replace(/^ {2}/, "      ")) : [];
    // Bottom up, so an insertion does not move the jobs still to do.
    for (const f of [...mine].sort((a, b) => b.line - a.line)) {
      let end = f.line;
      while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++;
      const at = lines.slice(f.line, end).findIndex((l) => /^ {4}permissions:/.test(l));
      if (at >= 0) {
        const i = f.line + at;
        if (!/^ {4}permissions:[ \t]*(?:#.*)?$/.test(lines[i])) continue;
        const child = /^( +)\S/.exec(lines[i + 1] ?? "")?.[1] ?? "      ";
        lines.splice(i + 1, 0, `${child}actions: write`);
      } else if (top) {
        lines.splice(f.line, 0, "    permissions:", ...topEntries, "      actions: write");
      }
    }
    writes[w.path] = lines.join("\n");
  }
  return writes;
}

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
 * opts.only: rule ids; write those rules' fixes and nothing else (no owned
 * files, no baseline), for a repo that adopted before the rule existed.
 */
export function planAdopt(view, rulebook, ctx, opts = {}) {
  const writes = {};
  const summary = [];
  const before = runDoctor(view, rulebook, ctx);
  const wanted = (id) => !opts.only || opts.only.includes(id);
  const has = (id) => wanted(id) && before.findings.some((f) => f.rule === id);

  if (has("CI-022") || has("CI-029")) {
    const findings = before.findings.filter((f) => (f.rule !== "CI-022" || has("CI-022")) && (f.rule !== "CI-029" || has("CI-029")));
    const fixed = fixRunners(view, findings);
    for (const [path, text] of Object.entries(fixed)) {
      writes[path] = text;
      const moved = findings.filter((f) => (f.rule === "CI-022" || f.rule === "CI-029") && f.file === path);
      const light = moved.filter((f) => /CI_RUNNER_LIGHT/.test(f.runsOn)).length;
      const deploy = moved.filter((f) => f.rule === "CI-029").length;
      if (moved.length - deploy) summary.push(`${path}: ${light} job(s) to the light runners, ${moved.length - deploy - light} to the standard ones (CI-022)`);
      if (deploy) summary.push(`${path}: ${deploy} deploy job(s) to the deploy slot (CI-029)`);
    }
  }

  if (has("CI-030")) {
    const fixed = fixDeployPermissions(view, before.findings.filter((f) => f.rule === "CI-030"));
    for (const [path, text] of Object.entries(fixed)) {
      writes[path] = text;
      summary.push(`${path}: the deploy job grants actions: write, so a superseded deploy reports cancelled, not success (CI-030)`);
    }
  }

  if (has("REG-003") || has("SEC-006")) {
    writes[".github/workflows/ci-standards-policy.yml"] = POLICY_CALLER;
    summary.push("add .github/workflows/ci-standards-policy.yml: the policy check and secret scan on every PR (REG-003, SEC-006)");
  }
  if (has("SEC-005")) {
    const current = view.files[".gitignore"] || "";
    writes[".gitignore"] = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${IGNORE_BLOCK}`;
    summary.push(".gitignore: ignore env and token files (SEC-005)");
  }
  const sec3 = wanted("SEC-003") && before.findings.find((f) => f.rule === "SEC-003");
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

  if (opts.only) return { writes, summary, before, after: runDoctor(withFiles(view, writes), rulebook, ctx) };

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
