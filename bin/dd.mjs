#!/usr/bin/env node
// dd: the DD Framework command.
//
//   dd doctor [dir]   what is missing in this repo, against rules.json
//   dd rules          the rulebook, with each rule's level today
//   dd adopt          (phase 3) bring a repo up to the rules, as a PR
//   dd new            (phase 4) create a repo that starts compliant
//
// doctor options:
//   --kind <kind>            repo kind (default: read from the repo's GitHub tags)
//   --visibility <v>         private | public (default: read from GitHub)
//   --repo <owner/name>      (default: GITHUB_REPOSITORY, or the git remote)
//   --today <YYYY-MM-DD>     the day the rules are judged on (default: today, UTC)
//   --format text|github|json
//
// Exit: 0 when nothing fails today, 1 when a rule at its enforce date fails,
// 2 on a usage error. Warnings and reports never fail.
//
// Run from a checkout: node bin/dd.mjs doctor <repo>. (npx github:... works only
// where npm allows git packages; dd-main-01 does not.)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFsView } from "../lib/view.mjs";
import { budgetForRepo } from "../lib/budget.mjs";
import { runDoctor, levelOn } from "../lib/engine.mjs";

const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rulebook = JSON.parse(readFileSync(join(HOME, "rules.json"), "utf8"));
const taxonomy = JSON.parse(readFileSync(join(HOME, "repo-topics.json"), "utf8"));

function opt(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function repoFromGit(dir) {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The repo's GitHub settings: GH_TOKEN, else the gh CLI, else null. */
async function readMeta(repo) {
  if (!repo) return null;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    if (token) {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dd-doctor" },
      });
      if (res.ok) return await res.json();
      return null;
    }
    const out = execFileSync("gh", ["api", `repos/${repo}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function format(result, how, repo) {
  const { findings, exempted, notes } = result;
  if (how === "json") return JSON.stringify(result, null, 1);
  const lines = [];
  if (how === "github") {
    for (const f of findings) {
      const kind = f.level === "enforce" ? "error" : f.level === "warn" ? "warning" : "notice";
      const loc = f.file && !f.file.startsWith("(") ? ` file=${f.file}${f.line ? `,line=${f.line}` : ""}` : "";
      lines.push(`::${kind}${loc}::[${f.rule}] ${f.message}`);
    }
  } else {
    // One line per distinct problem: the same unpinned action in 24 places
    // is one thing to fix, not 24.
    const order = { enforce: 0, warn: 1, report: 2 };
    const groups = new Map();
    for (const f of findings) {
      const key = `${f.level}|${f.rule}|${f.message}`;
      groups.set(key, [...(groups.get(key) || []), f]);
    }
    const sorted = [...groups.values()].sort((a, b) => order[a[0].level] - order[b[0].level] || a[0].rule.localeCompare(b[0].rule));
    for (const g of sorted) {
      const f = g[0];
      const tag = f.level === "enforce" ? "FAIL" : f.level === "warn" ? "warn" : "note";
      const at = g.slice(0, 3).map((x) => `${x.file || ""}${x.line ? `:${x.line}` : ""}`).join(", ");
      const more = g.length > 3 ? ` and ${g.length - 3} more` : "";
      lines.push(`${tag.padEnd(4)} ${f.rule.padEnd(7)} ${f.message}\n             ${at}${more}`);
    }
  }
  const fail = findings.filter((f) => f.level === "enforce").length;
  const warn = findings.filter((f) => f.level === "warn").length;
  lines.push(`dd doctor${repo ? ` (${repo})` : ""}: ${fail} failing, ${warn} warning, ${exempted.length} exempt.`);
  for (const n of notes) lines.push(how === "github" ? `::notice::${n}` : `  ${n}`);
  return lines.join("\n");
}

async function doctor(args) {
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  const dir = resolve(positional[0] || ".");
  const repo = opt(args, "--repo") || process.env.GITHUB_REPOSITORY || repoFromGit(dir);
  const today = opt(args, "--today") || new Date().toISOString().slice(0, 10);
  const how = opt(args, "--format") || "text";
  const meta = await readMeta(repo);
  const kind = opt(args, "--kind") || (meta?.topics || []).find((t) => taxonomy.kind.includes(t)) || null;
  const visibility = opt(args, "--visibility") || (meta ? (meta.private ? "private" : "public") : null);
  const repoName = repo ? repo.split("/")[1] : basename(dir);
  const budget = budgetForRepo(readFileSync(join(HOME, "budget.yml"), "utf8"), repoName);
  const result = runDoctor(loadFsView(dir), rulebook, { today, kind, visibility, repoName, budget, meta, taxonomy });
  console.log(format(result, how, repo));
  return result.findings.some((f) => f.level === "enforce") ? 1 : 0;
}

function rules(args) {
  const today = opt(args, "--today") || new Date().toISOString().slice(0, 10);
  for (const r of rulebook.rules) {
    console.log(`${r.id.padEnd(8)} ${levelOn(r, today).padEnd(8)} ${r.title}`);
  }
  return 0;
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === "doctor") return doctor(args);
  if (cmd === "rules") return rules(args);
  if (cmd === "adopt" || cmd === "new") {
    console.error(`dd ${cmd} is not built yet (DD Framework phase ${cmd === "adopt" ? 3 : 4}).`);
    return 2;
  }
  console.error("usage: dd doctor [dir] [--kind k] [--visibility private|public] [--today YYYY-MM-DD] [--format text|github|json]\n       dd rules");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`dd failed: ${err.message}`);
    process.exit(2);
  });
}
