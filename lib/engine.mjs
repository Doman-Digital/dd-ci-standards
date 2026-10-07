// Runs the rulebook against a repo view: picks the rules that apply to the
// repo's kind and visibility on the given day, runs their checks, and applies
// exemptions. The one place that decides warn, fail or exempt.

import { CHECKS } from "./rules.mjs";
import { checkRepoMetadata } from "../scripts/repo-metadata-rules.mjs";

const DAY = 864e5;
const MAX_EXEMPT_DAYS = 180;
const EXPIRY_NOTICE_DAYS = 14;
export const OUT_OF_SCOPE_KINDS = ["personal", "it-portfolio"];

CHECKS["REG-002"] = (view, ctx) => {
  if (!ctx.meta || !ctx.taxonomy) return [];
  return checkRepoMetadata({ description: ctx.meta.description, topics: ctx.meta.topics }, ctx.taxonomy).map((p) => ({
    rule: "REG-002",
    file: "(repository settings)",
    message: `${p}. Set it in the repo's About settings.`,
  }));
};

/** off | warn | enforce | report, for a rule on a day (YYYY-MM-DD). */
export function levelOn(rule, today) {
  if (today < rule.warn_from) return "off";
  if (rule.report_only) return "report";
  return today >= rule.enforce_from ? "enforce" : "warn";
}

/** Does the rule apply to this kind and visibility? null kind: unknown, apply. */
export function applies(rule, rulebook, kind, visibility) {
  if (rule.visibility && visibility && rule.visibility !== visibility) return false;
  if (rule.visibility && !visibility) return false;
  if (!kind) return true;
  if (OUT_OF_SCOPE_KINDS.includes(kind)) return false;
  const { full, light } = rulebook.kinds;
  if (rule.applies === "all") return full.includes(kind) || light.includes(kind);
  if (rule.applies === "full") return full.includes(kind);
  return Array.isArray(rule.applies) && rule.applies.includes(kind);
}

/** Exemptions from workflow comments and .github/dd.json. */
export function collectExemptions(view) {
  const list = [];
  for (const w of view.workflows) {
    w.text.split("\n").forEach((line, i) => {
      const m = line.match(/#\s*dd:\s*allow\s+([A-Z]+-\d+)(?:\s+until=(\S+))?\s*(.*)$/);
      if (m) list.push({ rule: m[1], file: w.path, until: m[2] || null, reason: m[3].trim(), where: `${w.path}:${i + 1}` });
      if (/#\s*ci-standards:\s*allow-double-run\b/.test(line)) {
        list.push({ rule: "CI-005", file: w.path, until: null, reason: line.replace(/.*allow-double-run/, "").trim(), legacy: true, where: `${w.path}:${i + 1}` });
      }
    });
  }
  const dd = view.files[".github/dd.json"];
  if (dd) {
    try {
      for (const e of JSON.parse(dd).exempt || []) list.push({ ...e, file: e.file || null, where: ".github/dd.json" });
    } catch (err) {
      list.push({ invalid: `.github/dd.json is not valid JSON: ${err.message}`, where: ".github/dd.json" });
    }
  }
  return list;
}

/** valid | expired | invalid, with a reason. Legacy double-run comments stay valid. */
export function exemptionState(e, today) {
  if (e.invalid) return { state: "invalid", why: e.invalid };
  if (e.legacy) return { state: "valid", why: "legacy comment with no expiry" };
  if (!e.reason) return { state: "invalid", why: "no reason given" };
  if (!e.until || !/^\d{4}-\d{2}-\d{2}$/.test(e.until)) return { state: "invalid", why: "no until=YYYY-MM-DD date" };
  if (e.until < today) return { state: "expired", why: `expired on ${e.until}` };
  if ((Date.parse(e.until) - Date.parse(today)) / DAY > MAX_EXEMPT_DAYS) return { state: "invalid", why: `until ${e.until} is more than ${MAX_EXEMPT_DAYS} days away` };
  return { state: "valid", why: "" };
}

/**
 * ctx: { today, kind, visibility, repoName, budget, meta?, taxonomy? }
 * Returns { findings, exempted, notes } where each finding has a level.
 */
export function runDoctor(view, rulebook, ctx) {
  const notes = [];
  if (ctx.kind && OUT_OF_SCOPE_KINDS.includes(ctx.kind)) {
    return { findings: [], exempted: [], notes: [`kind ${ctx.kind} is outside the framework; nothing checked.`] };
  }
  if (!ctx.kind) notes.push("kind unknown: every rule was applied. Pass --kind, or run where the repo's GitHub tags can be read.");
  if (!ctx.visibility) notes.push("visibility unknown: CI-001 and CI-002 were not checked.");
  if (!ctx.meta) notes.push("repository settings not read: REG-002 (description and tags) and REG-004 (auto-merge, delete branch on merge) were not checked.");

  const exemptions = collectExemptions(view).map((e) => ({ ...e, ...exemptionState(e, ctx.today) }));
  const raw = [];
  for (const rule of rulebook.rules) {
    const level = levelOn(rule, ctx.today);
    if (level === "off" || !applies(rule, rulebook, ctx.kind, ctx.visibility)) continue;
    const check = CHECKS[rule.id];
    if (!check) continue;
    for (const f of check(view, ctx)) raw.push({ ...f, level });
  }

  const findings = [];
  const exempted = [];
  for (const f of raw) {
    const ex = exemptions.find((e) => e.state === "valid" && e.rule === f.rule && (!e.file || e.file === f.file));
    if (ex) exempted.push({ ...f, exemption: ex });
    else findings.push(f);
  }

  const fw = rulebook.rules.find((r) => r.id === "FW-002");
  if (fw && levelOn(fw, ctx.today) !== "off") {
    for (const e of exemptions) {
      if (e.state !== "valid") {
        findings.push({ rule: "FW-002", level: "report", file: e.where, message: `exemption for ${e.rule || "?"} does not count: ${e.why}.` });
      } else if (e.until && (Date.parse(e.until) - Date.parse(ctx.today)) / DAY <= EXPIRY_NOTICE_DAYS) {
        findings.push({ rule: "FW-002", level: "report", file: e.where, message: `exemption for ${e.rule} expires on ${e.until}.` });
      } else if (e.legacy) {
        findings.push({ rule: "FW-002", level: "report", file: e.where, message: "legacy allow-double-run comment has no expiry. Replace it with # dd: allow CI-005 until=YYYY-MM-DD <reason>." });
      }
    }
  }
  return { findings, exempted, notes };
}
