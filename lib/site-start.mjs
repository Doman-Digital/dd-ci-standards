// How a site was started, for PKG-003 and for dd new (DOM-18123).
//
// Every site starts with @domandigital/create-site, which writes
// .dd/site-start.json:
//
//   { tool, version, mode: "programme" | "handover", programme, reason?,
//     stage05Gate?, startedAt }
//
// The label only describes. The proof is `create-site --check` exiting 0 (3
// means a house file has drifted). Rules never run commands (lib/view.mjs), so
// siteStartContext() runs the check before them and its answer goes in the
// context as ctx.siteStart, as ctx.craft does for PKG-001.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const LABEL_PATH = ".dd/site-start.json";
export const SITE_TOOL = "@domandigital/create-site";
export const MODES = ["programme", "handover"];
export const CHECK_TIMEOUT_MS = 180_000;

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const PROGRAMME = /^DOM-\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What is wrong with a label's text: [] when it is valid. Reasons are plain
 * sentences that finish "The start label ...".
 */
export function labelProblems(text) {
  let label;
  try {
    label = JSON.parse(text);
  } catch (err) {
    return [`is not valid JSON (${err.message})`];
  }
  if (!label || typeof label !== "object" || Array.isArray(label)) return ["is not a JSON object"];
  const out = [];
  if (label.tool !== SITE_TOOL) out.push(`names tool ${JSON.stringify(label.tool)}, not ${SITE_TOOL}`);
  if (typeof label.version !== "string" || !SEMVER.test(label.version)) out.push("has no version of the tool (a semantic version)");
  if (!MODES.includes(label.mode)) out.push(`has mode ${JSON.stringify(label.mode)}, not programme or handover`);
  // --no-gate (the nightly starter, tests) records a skipped gate and may have no programme; the estate sweep
  // does not count such a site as started, so the label stays valid here and dd new --local stays clean.
  const gateSkipped = label.stage05Gate === false || label.handoverGate === false;
  if (!(typeof label.programme === "string" && PROGRAMME.test(label.programme)) && !(label.programme == null && gateSkipped)) out.push("does not name the site's programme issue (DOM-123)");
  if (label.mode === "handover" && !(typeof label.reason === "string" && label.reason.trim().length >= 10)) out.push("is a handover with no reason (why the site was copied in rather than built new)");
  if (typeof label.startedAt !== "string" || !DAY.test(label.startedAt)) out.push("has no startedAt date (YYYY-MM-DD)");
  return out;
}

/**
 * The command that runs create-site --check in dir: DD_CREATE_SITE (a cli.js,
 * as dd new's --create-site), else the repo's own install, else the published
 * package. `answers` is a file of the answers the site was made with; `extra`
 * is any other create-site flags (dd new passes the ones it started the site with).
 */
export function checkCommand(dir, { env = process.env, answers = null, visibility = null, extra = [], exists = existsSync } = {}) {
  const tail = ["--check", "--yes", ...(visibility ? ["--visibility", visibility] : []), ...(answers ? ["--answers", answers] : []), ...extra];
  if (env.DD_CREATE_SITE) return { cmd: process.execPath, args: [env.DD_CREATE_SITE, ...tail] };
  const local = join(dir, "node_modules", ".bin", "create-site");
  if (exists(local)) return { cmd: local, args: tail };
  return { cmd: "npx", args: ["--yes", `${SITE_TOOL}@latest`, ...tail] };
}

/** First line that says something, trimmed for a one-line message. */
const firstLine = (s) => (String(s || "").split("\n").map((l) => l.trim()).find(Boolean) || "").slice(0, 200);

/**
 * { ran, exit, output } for create-site --check in dir. Only exit 0 (up to date)
 * and exit 3 (work to do) are verdicts, and so is create-site's own refusal (exit
 * 1 with a "create-site:" message: the folder is not a Next.js or Astro project).
 * Anything else is ran: false, with the reason: the command would not start, was
 * killed, npx failed, or exit 2 (it needs the answers the site was made with,
 * which --check cannot recover on its own). PKG-003 says so in a note instead of
 * guessing either way. `run` is spawnSync, injectable for tests.
 */
export function runSiteCheck(dir, opts = {}, run = spawnSync) {
  const { cmd, args } = checkCommand(dir, opts);
  const r = run(cmd, args, { cwd: dir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(opts.env || {}) } });
  const command = `${cmd === process.execPath ? "node" : cmd.replace(/^.*\//, "")} ${args.join(" ")}`;
  if (r.error || r.status === null) return { ran: false, command, error: r.error ? r.error.message : `ended by ${r.signal}` };
  const output = firstLine(r.status === 0 ? r.stdout : r.stderr || r.stdout);
  // exit 1 is create-site refusing the folder ("create-site: no package.json ..."): that is a verdict, and a bad one.
  // The same exit from npx (no network, no such package) has no "create-site:" prefix and is not.
  const refused = r.status === 1 && /^create-site\b/.test(output);
  if (r.status !== 0 && r.status !== 3 && !refused) return { ran: false, command, error: `exit ${r.status}${output ? `: ${output}` : ""}` };
  return { ran: true, command, exit: r.status, output };
}

/**
 * ctx.siteStart for the doctor: null when the repo has no valid label (PKG-003
 * reports that without running anything) or the kind is not one the rule
 * covers; otherwise { check }.
 */
export function siteStartContext(dir, view, opts = {}, run = spawnSync) {
  const text = view.files?.[LABEL_PATH];
  if (typeof text !== "string" || labelProblems(text).length) return null;
  return { check: runSiteCheck(dir, opts, run) };
}
