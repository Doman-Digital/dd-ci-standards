#!/usr/bin/env node
// Fails a PR that reintroduces the CI waste patterns found in the 2026-08-16
// portfolio audit: push+pull_request double-runs, jobs with no timeout,
// PR-triggered workflows with no concurrency cancellation, unregistered
// cron schedules (GitHub Actions or Vercel), and unexplained
// continue-on-error. Line-scanning on purpose — these are structural
// YAML-shape checks, not semantic ones, so a full YAML parse buys nothing.
//
// Usage: node scripts/check-workflow-policy.mjs <path-to-checked-out-repo> <path-to-budget.yml>

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const [, , repoRoot, budgetPath] = process.argv;
if (!repoRoot || !budgetPath) {
  console.error("usage: check-workflow-policy.mjs <repo-root> <budget.yml>");
  process.exit(2);
}

const violations = [];
const repoSlug = process.env.GITHUB_REPOSITORY || "";
const repoName = repoSlug.split("/")[1] || "";

function loadBudgetForRepo(name) {
  const raw = readFileSync(budgetPath, "utf8");
  // Minimal YAML reader for this file's own fixed shape (repos: <name>:
  // github_actions_crons: [{workflow, cron}], vercel_crons: [{app, path,
  // schedule}]) — avoids pulling in a YAML dependency for a structure this
  // constrained.
  const lines = raw.split("\n");
  let inRepos = false;
  let currentRepo = null;
  let section = null; // 'ga' | 'vercel'
  const ghCrons = [];
  const vercelCrons = [];
  let cur = null;
  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    const repoMatch = line.match(/^  (\S+):\s*$/);
    if (repoMatch) {
      currentRepo = repoMatch[1];
      section = null;
      continue;
    }
    if (currentRepo !== name) continue;
    if (/^\s{4}github_actions_crons:/.test(line)) {
      section = "ga";
      continue;
    }
    if (/^\s{4}vercel_crons:/.test(line)) {
      section = "vercel";
      continue;
    }
    const itemStart = line.match(/^\s{6}-\s*(\w+):\s*(.*)$/);
    if (itemStart) {
      cur = {};
      cur[itemStart[1]] = itemStart[2].replace(/^["']|["']$/g, "");
      if (section === "ga") ghCrons.push(cur);
      if (section === "vercel") vercelCrons.push(cur);
      continue;
    }
    const itemCont = line.match(/^\s{8}(\w+):\s*(.*)$/);
    if (itemCont && cur) {
      cur[itemCont[1]] = itemCont[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ghCrons, vercelCrons };
}

function listWorkflowFiles(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(dir, f));
}

function checkDoubleRun(file, text) {
  const onBlockMatch = text.match(/^on:\s*\n([\s\S]*?)(?=\n\S|\n$)/m);
  if (!onBlockMatch) return;
  const onBlock = onBlockMatch[1];
  const hasPush = /^\s{2}push:\s*$/m.test(onBlock);
  const hasPR = /^\s{2}pull_request:\s*$/m.test(onBlock) || /^\s{2}pull_request:\s*\n/m.test(onBlock);
  if (!hasPush || !hasPR) return;
  // Extract branches: list under each trigger, only flag when they overlap —
  // a push scoped to a different branch than the PR target isn't a double-run.
  const pushBranches = extractBranches(onBlock, "push");
  const prBranches = extractBranches(onBlock, "pull_request");
  const overlap = pushBranches.length === 0 || prBranches.length === 0
    ? true // no explicit branch filter on one side — can't rule out overlap, so flag it
    : pushBranches.some((b) => prBranches.includes(b));
  if (overlap) {
    violations.push({
      file,
      rule: "double-run",
      message:
        "triggers on both push and pull_request for overlapping branches — the push run re-tests a commit the PR already tested. If this is deliberate (e.g. no other automated gate exists for this repo), add a comment explaining why and keep this check happy by scoping push to non-overlapping branches, or ask for an exception in the ci-standards repo.",
    });
  }
}

function extractBranches(onBlock, trigger) {
  const re = new RegExp(`^\\s{2}${trigger}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}\\S|\\n\\S|$)`, "m");
  const m = onBlock.match(re);
  if (!m) return [];
  const branchLine = m[1].match(/branches:\s*\[([^\]]*)\]/);
  if (!branchLine) return [];
  return branchLine[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
}

function checkTimeouts(file, text) {
  // Walk job blocks (top-level keys under `jobs:`, 2-space indented) and
  // require a sibling `timeout-minutes:` before the next job or EOF.
  const jobsMatch = text.match(/^jobs:\s*\n([\s\S]*)$/m);
  if (!jobsMatch) return;
  const body = jobsMatch[1];
  const jobHeaderRe = /^  (\S+):\s*$/gm;
  const headers = [...body.matchAll(jobHeaderRe)];
  for (let i = 0; i < headers.length; i++) {
    const name = headers[i][1];
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : body.length;
    const block = body.slice(start, end);
    if (/uses:\s*\S/.test(block) && /^  \S+:\s*\n\s{4}uses:/m.test(block)) {
      // Job calls a reusable workflow (uses: at job level) — timeout lives
      // in the called workflow, not here.
      continue;
    }
    // Accept an expression as well as a literal — a reusable workflow sets
    // its timeout from an input (`timeout-minutes: ${{ inputs.timeout_minutes }}`),
    // which is a real timeout, not a missing one. Mirrors how the
    // cancel-in-progress check treats expressions.
    if (!/timeout-minutes:\s*(\d+|\$\{\{)/.test(block)) {
      violations.push({
        file,
        rule: "missing-timeout",
        message: `job "${name}" has no timeout-minutes — it can run to GitHub's 6-hour default if it hangs.`,
      });
    }
  }
}

function checkConcurrency(file, text) {
  const hasPR = /^\s{2}pull_request:/m.test(text);
  if (!hasPR) return;
  const hasConcurrency = /^concurrency:/m.test(text);
  const hasCancel = /cancel-in-progress:\s*(true|\$\{\{)/.test(text);
  if (!hasConcurrency || !hasCancel) {
    violations.push({
      file,
      rule: "missing-concurrency",
      message:
        "runs on pull_request but has no concurrency group with cancel-in-progress — a stacked push keeps every prior run alive to completion instead of cancelling it.",
    });
  }
}

function checkCrons(file, text, ghCrons) {
  const scheduleBlock = text.match(/^\s{2}schedule:\s*\n([\s\S]*?)(?=\n\s{2}\S|\n\S|$)/m);
  if (!scheduleBlock) return;
  const crons = [...scheduleBlock[1].matchAll(/cron:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const cron of crons) {
    const fileName = relative(join(repoRoot, ".github", "workflows"), file);
    const registered = ghCrons.some((c) => c.workflow === fileName && c.cron === cron);
    if (!registered) {
      violations.push({
        file,
        rule: "unregistered-cron",
        message: `schedule cron "${cron}" is not registered in ci-standards budget.yml for this repo. Register it there with an owner and justification before merging, or the recurring cost is invisible until it shows up in the bill.`,
      });
    }
  }
}

function checkContinueOnError(file, text) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/continue-on-error:\s*true/.test(line)) {
      const context = lines.slice(Math.max(0, i - 3), i).join("\n");
      if (!/^\s*#/m.test(context)) {
        violations.push({
          file,
          rule: "unexplained-continue-on-error",
          message: `continue-on-error: true at line ${i + 1} has no preceding comment explaining why it's advisory. Add one — this is exactly the pattern that let 3 permanently-red jobs run unnoticed for months in the Doman-Digital audit.`,
        });
      }
    }
  });
}

function checkVercelCrons(root, vercelCrons) {
  const candidates = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "vercel.json") candidates.push(p);
    }
  };
  walk(root);
  for (const file of candidates) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const cron of json.crons || []) {
      const registered = vercelCrons.some(
        (c) => c.path === cron.path && c.schedule === cron.schedule
      );
      if (!registered) {
        violations.push({
          file,
          rule: "unregistered-vercel-cron",
          message: `vercel.json crons entry "${cron.path}" (${cron.schedule}) is not registered in ci-standards budget.yml. These bill as function invocations on every fire — register it with an owner before merging.`,
        });
      }
    }
  }
}

const { ghCrons, vercelCrons } = loadBudgetForRepo(repoName);
const files = listWorkflowFiles(repoRoot);

for (const file of files) {
  const text = readFileSync(file, "utf8");
  checkDoubleRun(file, text);
  checkTimeouts(file, text);
  checkConcurrency(file, text);
  checkCrons(file, text, ghCrons);
  checkContinueOnError(file, text);
}
checkVercelCrons(repoRoot, vercelCrons);

if (violations.length === 0) {
  console.log(`ci-standards policy: clean (${files.length} workflow file(s) checked)`);
  process.exit(0);
}

console.log(`ci-standards policy: ${violations.length} violation(s)\n`);
for (const v of violations) {
  console.log(`::error file=${relative(repoRoot, v.file)}::[${v.rule}] ${v.message}`);
}
process.exit(1);
