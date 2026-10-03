#!/usr/bin/env node
// dd: the DD Framework command.
//
//   dd doctor [dir]   what is missing in this repo, against rules.json
//   dd rules          the rulebook, with each rule's level today
//   dd adopt [dir]    bring a repo up to the rules: owned files written,
//                     existing findings recorded as 60-day exemptions (lib/adopt.mjs)
//   dd new --kind <kind> <name> --description "<text>"
//                     a repo that starts compliant: create-next-app, create-site,
//                     dd adopt, dd doctor clean, then the GitHub repo and a
//                     registry PR (lib/new.mjs)
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFsView } from "../lib/view.mjs";
import { budgetForRepo } from "../lib/budget.mjs";
import { runDoctor, levelOn } from "../lib/engine.mjs";
import { planAdopt } from "../lib/adopt.mjs";
import { planNew, addToRegistry, cleanVerdict, ruleset, PR_BODY, REGISTRY_REPO, POLICY_CHECK } from "../lib/new.mjs";

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

/** The repo, its settings and the rule context, from the command line. */
async function context(args) {
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  const dir = resolve(positional[0] || ".");
  const repo = opt(args, "--repo") || process.env.GITHUB_REPOSITORY || repoFromGit(dir);
  const today = opt(args, "--today") || new Date().toISOString().slice(0, 10);
  const meta = await readMeta(repo);
  const kind = opt(args, "--kind") || (meta?.topics || []).find((t) => taxonomy.kind.includes(t)) || null;
  const visibility = opt(args, "--visibility") || (meta ? (meta.private ? "private" : "public") : null);
  const repoName = repo ? repo.split("/")[1] : basename(dir);
  const budget = budgetForRepo(readFileSync(join(HOME, "budget.yml"), "utf8"), repoName);
  return { dir, repo, ctx: { today, kind, visibility, repoName, budget, meta, taxonomy } };
}

async function doctor(args) {
  const { dir, repo, ctx } = await context(args);
  const result = runDoctor(loadFsView(dir), rulebook, ctx);
  console.log(format(result, opt(args, "--format") || "text", repo));
  return result.findings.some((f) => f.level === "enforce") ? 1 : 0;
}

async function adopt(args) {
  const { dir, repo, ctx } = await context(args);
  if (!ctx.kind) {
    console.error("dd adopt: the repo's kind is unknown. Tag the repo on GitHub (repo-topics.json) or pass --kind.");
    return 2;
  }
  const { writes, summary, before, after } = planAdopt(loadFsView(dir), rulebook, ctx);
  const count = (r, l) => r.findings.filter((f) => f.level === l).length;
  console.log(`dd adopt${repo ? ` (${repo})` : ""}: before, ${count(before, "enforce")} failing and ${count(before, "warn")} warning.`);
  if (!summary.length) console.log("  nothing to change.");
  for (const s of summary) console.log(`  ${s}`);
  if (!args.includes("--dry-run")) {
    for (const [path, text] of Object.entries(writes)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
  console.log(`after: ${count(after, "enforce")} failing, ${count(after, "warn")} warning, ${after.exempted.length} exempt.${args.includes("--dry-run") ? " (dry run, nothing written)" : ""}`);
  return count(after, "enforce") ? 1 : 0;
}

/** A token for the API: GH_TOKEN, else the gh CLI's. Never printed. */
function apiToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

async function api(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dd-new", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, json };
}

/** Run a command with the terminal attached; throws on a non-zero exit. */
function step(cmd, args, cwd, env) {
  console.log(`$ ${[cmd === process.execPath ? "node" : cmd, ...args].join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
}

// git authenticates with the token through the environment, as
// actions/checkout does, so it is never in argv or a remote URL.
const gitAuthEnv = (token) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

async function newRepo(args) {
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--dry-run", "--local"].includes(args[i - 1])));
  const siteArgs = [];
  for (const flag of ["--answers", "--client", "--trading-name", "--site-url", "--sector"]) {
    if (opt(args, flag)) siteArgs.push(flag, opt(args, flag));
  }
  if (opt(args, "--description")) siteArgs.push("--description", opt(args, "--description"));
  const today = opt(args, "--today") || new Date().toISOString().slice(0, 10);
  const plan = planNew(
    {
      kind: opt(args, "--kind"),
      name: positional[0],
      description: opt(args, "--description"),
      owner: opt(args, "--owner"),
      visibility: opt(args, "--visibility"),
      framework: opt(args, "--framework"),
      // Absolute, so create-next-app makes it where asked from any working directory.
      dir: resolve(opt(args, "--dir") || positional[0] || "."),
      createSite: opt(args, "--create-site") ? resolve(opt(args, "--create-site")) : null,
      siteArgs,
      local: args.includes("--local"),
      today,
    },
    taxonomy,
    rulebook,
  );
  if (plan.error) {
    console.error(`dd new: ${plan.error}`);
    return 2;
  }
  const dir = resolve(plan.dir);
  console.log(`dd new: ${plan.repo} (${plan.kind}, ${plan.visibility}, ${plan.framework}) in ${dir}${plan.local ? ", local only" : ""}`);
  if (args.includes("--dry-run")) {
    for (const s of plan.steps) console.log(`  run      ${s.cmd === process.execPath ? "node" : s.cmd} ${s.args.join(" ")}`);
    console.log("  run      dd adopt, then dd doctor (must be clean)");
    if (!plan.local) {
      console.log(`  create   github.com/${plan.repo}, ${plan.visibility}, tags ${plan.topics.join(", ")}`);
      console.log("  push     the first commit to main");
      console.log(`  protect  main: pull requests only, ${POLICY_CHECK} required`);
      console.log(`  open     a pull request on ${REGISTRY_REPO} adding:\n${plan.registry.trimEnd().replace(/^/gm, "           ")}`);
    }
    return 0;
  }
  if (existsSync(dir)) {
    console.error(`dd new: ${dir} already exists. Choose another --dir, or remove it.`);
    return 2;
  }

  // Before anything is made: the name is free on GitHub, and the register has no entry.
  let token = null;
  if (!plan.local) {
    token = apiToken();
    if (!token) {
      console.error("dd new: no GitHub token (GH_TOKEN, or gh auth login). Nothing was made.");
      return 2;
    }
    const existing = await api(token, "GET", `/repos/${plan.repo}`);
    if (existing.status !== 404) {
      console.error(`dd new: ${plan.repo} ${existing.ok ? "already exists" : `could not be checked (HTTP ${existing.status})`}. Nothing was made.`);
      return existing.ok ? 2 : 1;
    }
  }

  // 1. The starter.
  const [scaffold, install, createSite] = plan.steps;
  mkdirSync(dirname(dir), { recursive: true });
  step(scaffold.cmd, scaffold.args, dirname(dir));
  step(install.cmd, install.args, dir);
  step(createSite.cmd, createSite.args, dir);

  // 2. Adopt, then the doctor must be clean.
  const budget = budgetForRepo(readFileSync(join(HOME, "budget.yml"), "utf8"), plan.name);
  const ctx = { today, kind: plan.kind, visibility: plan.visibility, repoName: plan.name, budget, meta: null, taxonomy };
  const { writes, summary } = planAdopt(loadFsView(dir), rulebook, ctx);
  for (const line of summary) console.log(`dd adopt: ${line}`);
  for (const [path, text] of Object.entries(writes)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const result = runDoctor(loadFsView(dir), rulebook, ctx);
  console.log(format(result, "text", plan.repo));
  const verdict = cleanVerdict(result);
  if (!verdict.clean) {
    console.error(`dd new: the starter is not clean (${verdict.counted.length} finding(s), ${verdict.exempted.length} exempt). That is a bug in the starter; nothing was created on GitHub. The folder is left at ${dir}.`);
    return 1;
  }
  if (plan.local) {
    console.log(`dd new: ${dir} is clean. --local: no GitHub repo, no registry PR.`);
    return 0;
  }

  // 3. The repo, its tags, the first commit.
  const created = await api(token, "POST", `/orgs/${plan.owner}/repos`, {
    name: plan.name,
    description: plan.description,
    private: plan.visibility === "private",
    has_wiki: false,
    has_projects: false,
    delete_branch_on_merge: true,
  });
  if (!created.ok) {
    console.error(`dd new: creating ${plan.repo} failed: HTTP ${created.status} ${created.json?.message || ""}. The starter is at ${dir}.`);
    return 1;
  }
  const tagged = await api(token, "PUT", `/repos/${plan.repo}/topics`, { names: plan.topics });
  if (!tagged.ok) console.error(`dd new: setting the tags failed (HTTP ${tagged.status}); set ${plan.topics.join(", ")} by hand or REG-002 fails.`);
  step("git", ["init", "-q", "-b", "main"], dir);
  step("git", ["add", "-A"], dir);
  step("git", ["commit", "-q", "-m", plan.commitMessage], dir);
  step("git", ["remote", "add", "origin", `https://github.com/${plan.repo}.git`], dir);
  step("git", ["push", "-q", "-u", "origin", "main"], dir, gitAuthEnv(token));

  // Blocked, not merely red: the policy check is required on main.
  let blocking = true;
  const rules = await api(token, "POST", `/repos/${plan.repo}/rulesets`, ruleset());
  if (!rules.ok) {
    blocking = false;
    console.error(
      `dd new: the ruleset on main was refused (HTTP ${rules.status} ${rules.json?.message || ""}). A PR that breaks a rule shows a red check but can still be merged.` +
        (plan.visibility === "private" ? " GitHub's Free plan has no rulesets for private repos; on Team, re-run with the same token or add it by hand." : ""),
    );
  }

  // The doctor again, now that GitHub has the description and tags (REG-002).
  const meta = await readMeta(plan.repo);
  const remote = runDoctor(loadFsView(dir), rulebook, { ...ctx, meta });
  console.log(format(remote, "text", plan.repo));

  // 4. The registry PR.
  const pr = await registryPr(token, plan, today);
  if (pr.error) {
    console.error(`dd new: ${plan.repo} is made, but the registry PR was not: ${pr.error}. Add this to registry.yaml by hand:\n${plan.registry}`);
    return 1;
  }
  console.log(`dd new: ${plan.repo} made. Registry PR: ${pr.url}${blocking ? "" : ". Not protected: see above."}`);
  return remote.findings.some((f) => f.level === "enforce") ? 1 : 0;
}

async function registryPr(token, plan, today) {
  const branch = `dd-new/${plan.name}`;
  const file = await api(token, "GET", `/repos/${REGISTRY_REPO}/contents/registry.yaml?ref=main`);
  if (!file.ok) return { error: `could not read registry.yaml (HTTP ${file.status})` };
  const edited = addToRegistry(Buffer.from(file.json.content, "base64").toString("utf8"), { owner: plan.owner, name: plan.name, kind: plan.kind, today });
  if (edited.error) return edited;
  const main = await api(token, "GET", `/repos/${REGISTRY_REPO}/git/ref/heads/main`);
  if (!main.ok) return { error: `could not read main (HTTP ${main.status})` };
  const ref = await api(token, "POST", `/repos/${REGISTRY_REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.json.object.sha });
  if (!ref.ok) return { error: `could not create ${branch} (HTTP ${ref.status})` };
  const put = await api(token, "PUT", `/repos/${REGISTRY_REPO}/contents/registry.yaml`, {
    message: `chore(registry): add ${plan.name}, created by dd new`,
    content: Buffer.from(edited.text).toString("base64"),
    sha: file.json.sha,
    branch,
  });
  if (!put.ok) return { error: `could not commit registry.yaml (HTTP ${put.status})` };
  const pr = await api(token, "POST", `/repos/${REGISTRY_REPO}/pulls`, { title: `chore(registry): add ${plan.name}`, head: branch, base: "main", body: PR_BODY(plan) });
  if (!pr.ok) return { error: `could not open the pull request (HTTP ${pr.status})` };
  return { url: pr.json.html_url };
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
  if (cmd === "adopt") return adopt(args);
  if (cmd === "new") return newRepo(args);
  console.error(`usage: dd doctor [dir] [--kind k] [--visibility private|public] [--today YYYY-MM-DD] [--format text|github|json]
       dd adopt [dir] [--kind k] [--dry-run]
       dd new --kind <kind> <name> --description "<text>" [--visibility private|public] [--framework next|astro]
              [--answers <file> | --client <name> --site-url <url> --sector <sector>] [--dir <path>]
              [--create-site <create-site cli.js>] [--local] [--dry-run]
       dd rules`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`dd failed: ${err.message}`);
    process.exit(2);
  });
}
