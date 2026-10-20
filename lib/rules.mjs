// The checks behind rules.json. Each takes a repo view (lib/view.mjs) and a
// context, and returns findings { rule, file, line?, message }. Whether a
// finding warns, fails or is exempt is decided in lib/engine.mjs, not here.
//
// Line-scanning on purpose, as before: these are structural shape checks on
// workflow YAML, not semantic ones, and the repo has no dependencies.

import { readFileSync } from "node:fs";
import { compareCatalogue } from "./craft.mjs";

const POLICY_CALL = "dd-ci-standards/.github/workflows/policy.yml";
// The estate sweep: the one place that scans every default branch for
// secrets (new commits daily, all history weekly), so CI-015 lets it be.
const ESTATE_SCANNER = "doman-digital/dd-repo-registry";
/** Workflows and the repo's own composite actions: the text the leftover rules read. */
const workflowText = (view) => [...view.workflows, ...(view.actions ?? [])];
const HOSTED = /\b(ubuntu|windows|macos)-[\w.]+/;
const SELF_HOSTED = /self-hosted|\bdd-ci\b|CI_RUNNER/;

// Runner choice (CI-022, DOM-834). The rulebook decides which pool a job runs
// on, from the job's own timeout, so no repo picks a runner. A job that says
// it is done within LIGHT_MAX_TIMEOUT minutes runs on the light pool
// (dd-ci-light, 2 vCPU / 3 GiB); every other job on the standard one. Both
// expressions fall back the same way: an unset variable leaves the job where
// it ran before, and a public repo never sees the private variables (CI-002).
export const LIGHT_MAX_TIMEOUT = 5;
export const LIGHT_RUNS_ON = "${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}";
export const STANDARD_RUNS_ON = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
export const DEPLOY_RUNS_ON = "${{ vars.CI_RUNNER_DEPLOY || vars.CI_RUNNER || 'ubuntu-latest' }}";
const DEPLOY_POOL = /CI_RUNNER_DEPLOY|\bdd-ci-deploy\b/;

/**
 * A deploy job (CI-029): its key or name says deploy, it is not a dry run or a preview, and its workflow does not
 * run on pull requests. Deploys run on their own slot so they never wait behind pull request CI (DOM-834).
 */
export function isDeploy(job, workflowText) {
  const name = `${job.name} ${(/^ {4}name:[ \t]*(.+)$/m.exec(job.block) || [])[1] || ""}`;
  if (!/deploy/i.test(name) || /dry[-_ ]?run|preview/i.test(name)) return false;
  return !triggers(workflowText).some((t) => t.startsWith("pull_request"));
}
const LIGHT = /CI_RUNNER_LIGHT|\bdd-ci-light\b/;

// GitHub's included minutes (CI-028, DOM-1079). The Enterprise plan includes
// 50,000 GitHub-hosted minutes a month on a $0 budget. A job registered in
// hosted-jobs.json runs there through the organisation variable
// CI_RUNNER_HOSTED, which a timer on dd-work-01 (dd-ci-hosted-valve) points
// back at dd-ci-ephemeral before the allowance runs out. Every other job stays
// on the organisation's own runners.
export const HOSTED_RUNS_ON = "${{ vars.CI_RUNNER_HOSTED || vars.CI_RUNNER || 'ubuntu-latest' }}";
const HOSTED_VAR = /CI_RUNNER_HOSTED/;
const sameExpr = (a, b) => a.replace(/\s+/g, "").replace(/"/g, "'") === b.replace(/\s+/g, "").replace(/"/g, "'");

/**
 * Which pool the rulebook puts a job on: "light", "standard", or null when
 * the job does not choose one (a reusable-workflow call runs on the called
 * workflow's runners).
 */
export function runnerPool(job) {
  if (job.reusable) return { pool: null };
  if (/^ {4}(services|container):/m.test(job.block)) return { pool: "standard", why: "it starts service containers, which need the standard VM's memory" };
  const t = /^ {4}timeout-minutes:[ \t]*(\S+)/m.exec(job.block);
  if (!t || !/^\d+$/.test(t[1])) return { pool: "standard", why: "its timeout-minutes is not a plain number of minutes" };
  const minutes = Number(t[1]);
  return minutes <= LIGHT_MAX_TIMEOUT
    ? { pool: "light", minutes }
    : { pool: "standard", minutes, why: `its timeout-minutes is ${minutes}, more than ${LIGHT_MAX_TIMEOUT}` };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Job blocks under `jobs:` (2-space indented headers). */
export function jobBlocks(text) {
  const jobsMatch = /^jobs:\s*\n/m.exec(text);
  if (!jobsMatch) return [];
  const bodyStart = jobsMatch.index + jobsMatch[0].length;
  const body = text.slice(bodyStart);
  const headers = [...body.matchAll(/^  ([^\s#][^:]*):\s*$/gm)];
  return headers.map((h, i) => {
    const start = h.index;
    const end = i + 1 < headers.length ? headers[i + 1].index : body.length;
    const block = body.slice(start, end);
    const runsOn = /^ {4}runs-on:[ \t]*(.*)$/m.exec(block);
    let runsOnValue = runsOn ? runsOn[1].trim() : null;
    if (runsOn && runsOnValue === "") {
      // list form: runs-on:\n      - self-hosted
      const after = block.slice(runsOn.index + runsOn[0].length);
      runsOnValue = [...after.matchAll(/^ {6}-\s*(.+)$/gm)].map((m) => m[1]).join(", ");
    }
    return {
      name: h[1],
      block,
      line: lineOf(text, bodyStart + start),
      runsOn: runsOnValue,
      runsOnLine: runsOn ? lineOf(text, bodyStart + start + runsOn.index) : null,
      reusable: /^ {4}uses:\s*\S/m.test(block),
    };
  });
}

/** Steps: each `- ` item with its lines, found from a line index inside it. */
function stepAround(lines, i) {
  const indentOf = (l) => l.match(/^(\s*)/)[1].length;
  let s = i;
  while (s >= 0 && !/^\s*- /.test(lines[s])) s--;
  if (s < 0) return { start: i, end: i, text: lines[i] };
  const ind = indentOf(lines[s]);
  let e = s + 1;
  while (e < lines.length) {
    const l = lines[e];
    if (l.trim() && indentOf(l) <= ind) break;
    e++;
  }
  return { start: s, end: e, text: lines.slice(s, e).join("\n") };
}

function onBlock(text) {
  const m = text.match(/^on:\s*\n([\s\S]*?)(?=\n\S|\n$)/m);
  return m ? m[1] : null;
}

function extractBranches(block, trigger) {
  const re = new RegExp(`^\\s{2}${trigger}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}\\S|\\n\\S|$)`, "m");
  const m = block.match(re);
  if (!m) return [];
  const branchLine = m[1].match(/branches:\s*\[([^\]]*)\]/);
  if (!branchLine) return [];
  return branchLine[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
}

/** Every cron under `schedule:`, however many and with comments between. */
export function scheduleCrons(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s{2}schedule:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && !l.trim().startsWith("#") && l.match(/^(\s*)/)[1].length <= 2) break;
      const m = l.match(/cron:\s*["']([^"']+)["']/);
      if (m) out.push({ cron: m[1], line: j + 1 });
    }
  }
  return out;
}


// Files that hold real secrets by convention. Examples and templates are the
// documented exception: they carry names, not values.
const SECRET_FILE = /(^|\/)(\.env(\.[^/]+)?|\.dev\.vars(\.[^/]+)?|\.doppler-token)$/;
const EXAMPLE_FILE = /(^|[./_-])(example|sample|template|dist|defaults?)([./_-]|$)/i;
export const isSecretFile = (path) => SECRET_FILE.test(path) && !EXAMPLE_FILE.test(path.split("/").pop());

/** What SEC-005 requires a .gitignore to cover, and the block that covers it. */
const MUST_IGNORE = [".env", ".env.local", ".env.production", ".dev.vars", ".doppler-token"];
export const IGNORE_BLOCK = `# secrets: never tracked (SEC-005)
.env
.env.*
!.env.example
!.env.*.example
.dev.vars
.doppler-token
`;

/** The ignore (not negated) patterns of a .gitignore, as tests on a bare file name. */
function ignorePatterns(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => l.replace(/^\*\*\//, "").replace(/^\//, ""))
    .filter((l) => !l.includes("/"))
    .map((l) => new RegExp(`^${l.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`));
}

// SEC-007: a step that deploys to Cloudflare, and a Cloudflare credential
// taken from a GitHub secret (directly, or as the fallback after `||`).
const CF_DEPLOY = /\bwrangler\s+(?:deploy|publish|versions\s+(?:upload|deploy)|pages\s+deploy)\b|\bopennextjs-cloudflare\s+(?:deploy|upload)\b|cloudflare\/wrangler-action/;
const CF_SECRET = /^\s*(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|apiToken)\s*:\s*\$\{\{[^}]*\bsecrets\./;

// CI-012 to CI-014 and CF-001: what a workflow is triggered by, its
// concurrency blocks, and whether it deploys to production.

/** The workflow's own lines with comments removed, so a commented-out step is not a step. */
const codeLines = (text) => text.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s+#.*$/, "")));

/** Trigger names under `on:` (block, list or single-word form). */
export function triggers(text) {
  const inline = text.match(/^on:\s*\[([^\]]*)\]/m) || text.match(/^on:\s*(\w+)\s*$/m);
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  const block = onBlock(text) || "";
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
}

/** Does a push to the default branch (main or master) start this workflow? */
function pushesToMain(text) {
  if (!triggers(text).includes("push")) return false;
  const block = onBlock(text) || "";
  const push = block.match(/^ {2}push:[^\n]*\n((?: {4,}[^\n]*\n?|\s*\n)*)/m);
  const body = push ? push[1] : "";
  if (/^\s*branches:/m.test(body)) {
    const list = body.match(/branches:\s*\[([^\]]*)\]/)?.[1] ?? [...body.matchAll(/^\s*-\s*["']?([^"'\s]+)/gm)].map((m) => m[1]).join(",");
    return /(^|[\s,"'])(main|master|\*\*?)([\s,"']|$)/.test(list);
  }
  // tags only: a release, not a push to main. No filter or branches-ignore: main is in.
  return !/^\s*tags:/m.test(body) || /^\s*branches-ignore:/m.test(body);
}

/** Every `concurrency:` block: its group, its cancel-in-progress value, and its line. */
export function concurrencyBlocks(text) {
  const lines = codeLines(text);
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)concurrency:\s*(.*)$/);
    if (!m) return;
    const indent = m[1].length;
    let group = m[2].trim();
    let cancel = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && l.match(/^(\s*)/)[1].length <= indent) break;
      const g = l.match(/^\s*group:\s*(.*)$/);
      if (g) group = g[1].trim();
      const c = l.match(/^\s*cancel-in-progress:\s*(.*)$/);
      if (c) cancel = c[1].trim();
    }
    out.push({ group, cancel, line: i + 1, workflowLevel: indent === 0 });
  });
  return out;
}

// A production deploy: wrangler deploy (not --dry-run), versions deploy,
// pages deploy, OpenNext's deploy (it runs wrangler deploy), the wrangler action, a Vercel --prod deploy, or the shared
// Cloudflare deploy workflow. `wrangler versions upload` is a preview.
const PROD_DEPLOY = /\bwrangler\s+(?:deploy|publish|versions\s+deploy|pages\s+deploy)\b(?![^\n]*--dry-run)|\bopennextjs-cloudflare\s+deploy\b|cloudflare\/wrangler-action|\bvercel\b[^\n]*--prod\b/;
const SHARED_DEPLOY = "dd-ci-standards/.github/workflows/cloudflare-deploy.yml";
export const deploysToProduction = (text) => codeLines(text).some((l) => PROD_DEPLOY.test(l));
const callsSharedDeploy = (text) => text.includes(SHARED_DEPLOY);

// The tip guard: a step that compares the commit about to be deployed with
// the branch tip now, and stops if a newer commit has landed.
const TIP_GUARD = /dd-ci-standards\/\.github\/actions\/deploy-tip@|ls-remote[^\n]*refs\/heads\/|repos\/\$\{\{\s*github\.repository\s*\}\}\/(?:commits|git\/ref)/;
// CI-019: the hour, minute or weekday read from the clock (shell date, JS, Python).
const WALL_CLOCK = /\bdate\b[^\n|;]*\+["']?[^\s"']*%[HkIlMuwaA]|\.get(?:UTC)?(?:Hours|Minutes|Day)\(\)|\b(?:utc)?now\(\)[^\n]*\.(?:hour|minute|weekday|isoweekday)\b/;
// CI-017: a job condition that never runs on a pull request.
const OFF_PR_JOB = /^ {4}if:[^\n]*github\.event_name\s*(?:!=\s*['"]pull_request['"]|==\s*['"](?:schedule|workflow_dispatch|push)['"])/m;
// CI-020: a dependency install.
const INSTALL = /\b(?:pnpm\s+(?:i|install)|npm\s+(?:ci|install)|bun\s+install|yarn\s+install)\b|^\s*(?:run:\s*)?yarn(?:\s+--(?:frozen-lockfile|immutable))?\s*$/;
/** A workflow's `name:`, and the workflows a workflow_run trigger waits for. */
const workflowName = (text) => text.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
function workflowRunNames(text) {
  if (!triggers(text).includes("workflow_run")) return [];
  const list = (onBlock(text) || "").match(/workflows:\s*(?:\[([^\]]*)\]|\n((?:\s*-\s*[^\n]+\n?)+))/);
  return (list?.[1] ?? list?.[2] ?? "").split(/[,\n]/).map((s) => s.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "")).filter(Boolean);
}

// A job or step limited to the default branch.
const DEFAULT_REF_GUARD = /github\.ref\s*==\s*['"]refs\/heads\/(?:main|master)['"]|github\.ref_name\s*==\s*(?:['"](?:main|master)['"]|github\.event\.repository\.default_branch)/;

// CI-016: what only made sense on the persistent runners (eight on one
// host, one $HOME, a workspace that outlived the job). Every job now gets a
// fresh VM that is destroyed when it ends (DOM-555).
const PERSISTENT_RUNNER = [
  [/CI_PORT_OFFSET|RUNNER_NAME##/, "a port offset worked out from the runner's name"],
  [/\brunner\.name\b/, "a branch on the runner's name"],
  [/\/srv\/dd-ci-out|ci-handoff/, "a hand-off folder on the host, gone when the VM is"],
  [/setup-pnpm/, "a private pnpm folder per runner"],
  [/chown\s+-R[^\n]*(?:GITHUB_WORKSPACE|github\.workspace)|find\s+["']?\$\{?GITHUB_WORKSPACE\}?["']?[^\n]*-delete/, "a workspace clean-up for the next job, which never comes"],
];

/** name from a wrangler.jsonc/json/toml: the top-level one, which is the first. */
export function wranglerName(path, text) {
  if (/\.toml$/.test(path)) return text.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  return text.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

/** deploys.json beside this file's repo: every Worker and the one way it is deployed. */
const DEPLOYS = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../deploys.json", import.meta.url), "utf8"));
  } catch {
    return null;
  }
})();

/** hosted-jobs.json beside this file's repo: the jobs allowed on GitHub's included minutes. */
const HOSTED_JOBS = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../hosted-jobs.json", import.meta.url), "utf8"));
  } catch {
    return null;
  }
})();

/** The account the self-hosted runners (dd-ci-01) are registered to. */
export const RUNNER_OWNER = "Doman-Digital";

export const CHECKS = {
  "CI-001"(view, ctx) {
    if (ctx.visibility !== "private") return [];
    // The runners are registered to the organisation, so only its own repos
    // can use them. A repo in a client's or a personal account has nowhere
    // else to run, and its minutes are billed to that account. Owner unknown
    // (no settings read): checked, as before.
    const owner = ctx.meta?.owner?.login;
    if (owner && owner !== RUNNER_OWNER) return [];
    const out = [];
    for (const w of view.workflows) {
      for (const j of jobBlocks(w.text)) {
        if (!j.runsOn || j.runsOn.includes("${{") || !HOSTED.test(j.runsOn)) continue;
        out.push({ rule: "CI-001", file: w.path, line: j.runsOnLine, message: `job "${j.name}" runs on ${j.runsOn}. Use runs-on: \${{ vars.CI_RUNNER || 'ubuntu-latest' }} so it runs on the organisation's own runners.` });
      }
    }
    return out;
  },

  "CI-002"(view, ctx) {
    if (ctx.visibility !== "public") return [];
    const out = [];
    for (const w of view.workflows) {
      // A reusable workflow runs in its caller's repo, on the caller's runners.
      if (triggers(w.text).every((t) => t === "workflow_call")) continue;
      for (const j of jobBlocks(w.text)) {
        if (j.runsOn && SELF_HOSTED.test(j.runsOn)) {
          out.push({ rule: "CI-002", file: w.path, line: j.runsOnLine, message: `job "${j.name}" can run on the self-hosted runners (${j.runsOn}) in a public repo. Use a GitHub-hosted runner.` });
        }
      }
    }
    return out;
  },

  "CI-022"(view, ctx) {
    // As CI-001: the pools are the organisation's, so only its own private
    // repos are put on them. A public repo is CI-002's.
    if (ctx.visibility !== "private") return [];
    const owner = ctx.meta?.owner?.login;
    if (owner && owner !== RUNNER_OWNER) return [];
    const out = [];
    for (const w of view.workflows) {
      // A reusable workflow's jobs run where its caller says (policy.yml).
      if (triggers(w.text).every((t) => t === "workflow_call")) continue;
      for (const j of jobBlocks(w.text)) {
        const runsOn = j.runsOn?.replace(/\s+#.*$/, "");
        if (!runsOn) continue;
        // A job on GitHub's included minutes is CI-028's.
        if (HOSTED_VAR.test(runsOn)) continue;
        if (isDeploy(j, w.text)) continue; // CI-029 decides a deploy job's pool
        const { pool, minutes, why } = runnerPool(j);
        if (pool === "light") {
          if (sameExpr(runsOn, LIGHT_RUNS_ON)) continue;
          // An expression the rulebook did not write (a matrix, an input) is the job's own business.
          if (runsOn.includes("${{") && !runsOn.includes("CI_RUNNER")) continue;
          out.push({ rule: "CI-022", file: w.path, line: j.runsOnLine, runsOn: LIGHT_RUNS_ON, message: `job "${j.name}" has timeout-minutes: ${minutes}, so it runs on the light runners. Use runs-on: ${LIGHT_RUNS_ON}` });
        } else if (pool === "standard" && LIGHT.test(runsOn)) {
          out.push({ rule: "CI-022", file: w.path, line: j.runsOnLine, runsOn: STANDARD_RUNS_ON, message: `job "${j.name}" runs on the light runners (2 vCPU, 3 GiB), but ${why}. Use runs-on: ${STANDARD_RUNS_ON}` });
        }
      }
    }
    return out;
  },

  "CI-029"(view, ctx) {
    // As CI-022: the org's pools, its private repos only.
    if (ctx.visibility !== "private") return [];
    const owner = ctx.meta?.owner?.login;
    if (owner && owner !== RUNNER_OWNER) return [];
    const out = [];
    for (const w of view.workflows) {
      if (triggers(w.text).every((t) => t === "workflow_call")) continue;
      for (const j of jobBlocks(w.text)) {
        const runsOn = j.runsOn?.replace(/\s+#.*$/, "");
        if (!runsOn || !isDeploy(j, w.text) || DEPLOY_POOL.test(runsOn)) continue;
        if (runsOn.includes("${{") && !runsOn.includes("CI_RUNNER")) continue;
        out.push({ rule: "CI-029", file: w.path, line: j.runsOnLine, runsOn: DEPLOY_RUNS_ON, message: `job "${j.name}" deploys, so it runs on the deploy slot and never waits behind pull request CI. Use runs-on: ${DEPLOY_RUNS_ON}` });
      }
    }
    return out;
  },

  "CI-003"(view) {
    const out = [];
    for (const w of view.workflows) {
      for (const j of jobBlocks(w.text)) {
        if (j.reusable) continue; // the timeout lives in the called workflow
        if (!/timeout-minutes:\s*(\d+|\$\{\{)/.test(j.block)) {
          out.push({ rule: "CI-003", file: w.path, line: j.line, message: `job "${j.name}" has no timeout-minutes. It can run to GitHub's 6-hour default if it hangs.` });
        }
      }
    }
    return out;
  },

  "CI-004"(view) {
    return view.workflows
      .filter((w) => /^\s{2}pull_request(_target)?:/m.test(w.text))
      .filter((w) => !(/^concurrency:/m.test(w.text) && /cancel-in-progress:\s*(true|\$\{\{)/.test(w.text)))
      .map((w) => ({ rule: "CI-004", file: w.path, message: "runs on pull_request but has no concurrency group with cancel-in-progress, so a stacked push keeps every earlier run alive." }));
  },

  "CI-005"(view) {
    const out = [];
    for (const w of view.workflows) {
      const block = onBlock(w.text);
      if (!block) continue;
      const hasPush = /^\s{2}push:\s*$/m.test(block);
      const hasPR = /^\s{2}pull_request:\s*$/m.test(block) || /^\s{2}pull_request:\s*\n/m.test(block);
      if (!hasPush || !hasPR) continue;
      const pushB = extractBranches(block, "push");
      const prB = extractBranches(block, "pull_request");
      const overlap = pushB.length === 0 || prB.length === 0 ? true : pushB.some((b) => prB.includes(b));
      if (!overlap) continue;
      // The policy check on a push scans the pushed commits for secrets, the
      // backstop for anything that reached main without a PR: not a repeat.
      if (w.text.includes(POLICY_CALL)) continue;
      // The push run is what a workflow_run deploy waits for (CI-014): not a repeat.
      const name = workflowName(w.text);
      if (name && view.workflows.some((d) => d !== w && workflowRunNames(d.text).includes(name))) continue;
      out.push({ rule: "CI-005", file: w.path, message: "runs on both push and pull_request for overlapping branches, so the push run re-tests a commit the PR already tested. Scope push to other branches, or record a deliberate backstop as an exemption." });
    }
    return out;
  },

  "CI-006"(view) {
    const out = [];
    for (const w of view.workflows) {
      const lines = w.text.split("\n");
      lines.forEach((line, i) => {
        if (!/continue-on-error:\s*true/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i).join("\n");
        if (!/^\s*#/m.test(context)) {
          out.push({ rule: "CI-006", file: w.path, line: i + 1, message: "continue-on-error: true has no comment in the three lines above saying why it is advisory." });
        }
      });
    }
    return out;
  },

  "CI-007"(view, ctx) {
    const out = [];
    for (const w of view.workflows) {
      const name = w.path.replace(/^\.github\/workflows\//, "");
      for (const { cron, line } of scheduleCrons(w.text)) {
        if (!ctx.budget.ghCrons.some((c) => c.workflow === name && c.cron === cron)) {
          out.push({ rule: "CI-007", file: w.path, line, message: `schedule cron "${cron}" is not registered in dd-ci-standards budget.yml for ${ctx.repoName || "this repo"}. Register it with a reason in the same change.` });
        }
      }
    }
    return out;
  },

  "CI-008"(view) {
    const out = [];
    for (const w of view.workflows) {
      const lines = w.text.split("\n");
      lines.forEach((line, i) => {
        if (!/uses:\s*["']?actions\/upload-artifact@/.test(line)) return;
        const step = stepAround(lines, i);
        const build = /path:[^\n]*\.next(?!\/(?:cache|diagnostics))|path:[^\n]*\b(dist|build|out)\b(?!-)/.test(step.text);
        if (build) {
          out.push({ rule: "CI-008", file: w.path, line: step.start + 1, message: "uploads build output as an artifact. On the free plan's storage this blocked every PR on 2 October 2026; hand the build over on the runner's disk instead." });
        } else if (!/continue-on-error:\s*true/.test(step.text)) {
          out.push({ rule: "CI-008", file: w.path, line: step.start + 1, message: "an artifact upload without continue-on-error: true fails the job when the storage quota is full. Mark it, with a comment." });
        }
      });
    }
    return out;
  },

  "CI-011"(view, ctx) {
    const out = [];
    for (const v of view.vercel) {
      for (const cron of v.json.crons || []) {
        if (!ctx.budget.vercelCrons.some((c) => c.path === cron.path && c.schedule === cron.schedule)) {
          out.push({ rule: "CI-011", file: v.path, message: `vercel.json cron "${cron.path}" (${cron.schedule}) is not registered in dd-ci-standards budget.yml. Each fire bills as a function call.` });
        }
      }
    }
    return out;
  },

  "CI-012"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!pushesToMain(w.text)) continue;
      for (const c of concurrencyBlocks(w.text)) {
        if (c.cancel !== "true") continue;
        // A group that differs per run (run id, commit) never cancels another run.
        if (/github\.(run_id|sha)\b|workflow_run\.head_sha/.test(c.group)) continue;
        out.push({
          rule: "CI-012",
          file: w.path,
          line: c.line,
          message: `runs on a push to main with cancel-in-progress: true (group ${c.group || "(none)"}), so each merge cancels the run before it, and anything that waits for it (a deploy) is skipped. Cancel pull request runs only: cancel-in-progress: \${{ github.event_name == 'pull_request' }}.`,
        });
      }
    }
    return out;
  },

  "CI-013"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!deploysToProduction(w.text)) continue;
      // A deploy that only a pull request starts is a preview: cancelling it is right.
      if (triggers(w.text).every((t) => t === "pull_request" || t === "pull_request_target")) continue;
      const blocks = concurrencyBlocks(w.text);
      if (!blocks.length) {
        out.push({ rule: "CI-013", file: w.path, message: "deploys to production with no concurrency group, so two deploys can run at once and the older one can finish last. Add concurrency: { group: deploy-production, cancel-in-progress: false }." });
        continue;
      }
      for (const c of blocks.filter((b) => b.cancel === "true")) {
        out.push({ rule: "CI-013", file: w.path, line: c.line, message: "deploys to production with cancel-in-progress: true, so a newer push can stop a deploy halfway (a Worker updated, its secrets or migrations not). Use cancel-in-progress: false: a waiting deploy is still replaced by a newer one." });
      }
    }
    return out;
  },

  "CI-014"(view) {
    const out = [];
    for (const w of view.workflows) {
      const shared = callsSharedDeploy(w.text);
      if (!deploysToProduction(w.text) && !shared) continue;
      const on = triggers(w.text);
      const fromRun = on.includes("workflow_run");
      // A manual run deploys the branch it is started on: without a guard,
      // any branch can go to production.
      if (!shared && on.includes("workflow_dispatch") && !TIP_GUARD.test(w.text) && !DEFAULT_REF_GUARD.test(w.text)) {
        out.push({ rule: "CI-014", file: w.path, message: "can be run by hand on any branch, and deploys that branch to production. Add the tip guard (deploy-tip@v1, or deploy through cloudflare-deploy.yml), or if: github.ref == 'refs/heads/main' on the deploy job." });
      }
      if (fromRun) {
        // The tip guard deploys only the newest commit, so the CI run it
        // follows must exist for every commit on main.
        const names = workflowRunNames(w.text);
        for (const ci of view.workflows.filter((c) => names.includes(workflowName(c.text)))) {
          const push = (onBlock(ci.text) || "").match(/^ {2}push:[^\n]*\n((?: {4,}[^\n]*\n?|\s*\n)*)/m)?.[1] ?? "";
          if (/^\s*paths(-ignore)?:/m.test(push)) {
            out.push({ rule: "CI-014", file: ci.path, message: `gates ${w.path} but skips some pushes to main (paths filter). When the newest commit is one it skipped, no run deploys it and the guard stops the run before it, so nothing ships. Run it on every push to main and skip work inside with a changes job.` });
          }
        }
      }
      if (shared || (!fromRun && !pushesToMain(w.text))) continue;
      if (fromRun && !/workflow_run\.head_sha/.test(w.text)) {
        out.push({ rule: "CI-014", file: w.path, message: "deploys after workflow_run but checks out the branch as it is when the deploy starts, which may be a commit CI has not tested. Check out ref: ${{ github.event.workflow_run.head_sha }}." });
      }
      if (!TIP_GUARD.test(w.text)) {
        out.push({ rule: "CI-014", file: w.path, message: "deploys without checking that its commit is still the tip of main, so when runs finish out of order an older commit can be deployed over a newer one. Add the guard step: uses: Doman-Digital/dd-ci-standards/.github/actions/deploy-tip@v1 (or deploy through cloudflare-deploy.yml, which has it)." });
      }
    }
    return out;
  },

  "CI-015"(view, ctx) {
    if (!view.workflows.some((w) => w.text.includes(POLICY_CALL))) return [];
    if ((ctx.repo || ctx.meta?.full_name || "").toLowerCase() === ESTATE_SCANNER) return [];
    const out = [];
    for (const w of workflowText(view)) {
      if (w.text.includes(POLICY_CALL)) continue;
      const i = codeLines(w.text).findIndex((l) => /\b(gitleaks|trufflehog|semgrep)\b/i.test(l));
      if (i < 0) continue;
      out.push({ rule: "CI-015", file: w.path, line: i + 1, message: "runs a scanner of its own. The policy check scans every pull request (gitleaks, and Semgrep for a repo listed in dd-ci-standards scanners.json), and the estate sweep scans every default branch: new commits daily, all of history weekly. Delete it; to run Semgrep, add the repo to scanners.json. Take its check out of the required checks first (REG-007)." });
    }
    return out;
  },

  "CI-016"(view) {
    const out = [];
    for (const w of view.workflows) {
      codeLines(w.text).forEach((l, i) => {
        const hit = PERSISTENT_RUNNER.find(([re]) => re.test(l));
        if (hit) out.push({ rule: "CI-016", file: w.path, line: i + 1, message: `${hit[1]}: left from the persistent runners. Every job now runs on a fresh VM, so remove it.` });
      });
    }
    return out;
  },

  "CI-017"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!triggers(w.text).includes("pull_request")) continue;
      for (const j of jobBlocks(w.text)) {
        const m = /^ {4}continue-on-error:\s*true\s*(?:#.*)?$/m.exec(j.block);
        if (!m) continue;
        // A job whose if: keeps it off pull requests is not on the PR path.
        if (OFF_PR_JOB.test(j.block)) continue;
        out.push({ rule: "CI-017", file: w.path, line: j.line + lineOf(j.block, m.index) - 1, message: `job ${j.name} runs on every pull request with continue-on-error: true, so it takes a VM on each push and nobody acts on its result. Run it on a schedule or by hand, or make it a real check.` });
      }
    }
    return out;
  },

  "CI-018"(view) {
    const out = [];
    for (const w of view.workflows) {
      for (const { cron, line } of scheduleCrons(w.text)) {
        if (!/^0{1,2}$/.test(cron.trim().split(/\s+/)[0])) continue;
        out.push({ rule: "CI-018", file: w.path, line, message: `schedule cron "${cron}" fires on the hour, when GitHub's scheduler is busiest and starts runs late or drops them. Pick another minute (17, 43) and update its line in budget.yml.` });
      }
    }
    return out;
  },

  "CI-019"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!triggers(w.text).includes("schedule")) continue;
      codeLines(w.text).forEach((l, i) => {
        if (!WALL_CLOCK.test(l)) return;
        out.push({ rule: "CI-019", file: w.path, line: i + 1, message: "a scheduled run works out what to do from the clock (the hour, minute or weekday it starts). GitHub starts scheduled runs hours late, so it picks the wrong batch or none. Pass the batch in, or keep a cursor of what was done last." });
      });
    }
    return out;
  },

  "CI-020"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!triggers(w.text).includes("pull_request")) continue;
      const groups = new Map();
      for (const j of jobBlocks(w.text)) {
        if (j.reusable || /^ {4}(?:services|container|strategy):/m.test(j.block)) continue;
        if (!codeLines(j.block).some((l) => INSTALL.test(l) && !/\s(?:-g|--global)\b/.test(l))) continue;
        const dir = j.block.match(/working-directory:\s*["']?([^"'\s#]+)/)?.[1] ?? ".";
        groups.set(dir, [...(groups.get(dir) || []), j]);
      }
      for (const [dir, jobs] of groups) {
        if (jobs.length < 3) continue;
        out.push({ rule: "CI-020", file: w.path, line: jobs[0].line, message: `${jobs.length} jobs (${jobs.map((j) => j.name).join(", ")}) each install the same dependencies${dir === "." ? "" : ` in ${dir}`} on a VM of their own, so each pull request push waits for ${jobs.length} VMs that spend most of their time on setup. Run them as steps of one job; keep a job of its own only for one that needs services, a container or a matrix.` });
      }
    }
    return out;
  },

  "CI-021"(view) {
    const out = [];
    for (const w of view.workflows) {
      for (const job of jobBlocks(w.text)) {
        if (!job.reusable || !/^ {4}uses:\s*["']?(?:Doman-Digital\/dd-ci-standards\/|\.\/)\.github\/workflows\/post-deploy-checks\.ya?ml(?:@[^\s"']+)?/mi.test(job.block)) continue;
        out.push({ rule: "CI-021", file: w.path, line: job.line, message: `job ${job.name} starts another runner just to request post-deploy checks. Use dd-ci-standards/.github/actions/post-deploy-checks@v1 as a step after deployment, passing ADMIN_RUN_TOKEN through env.` });
      }
    }
    return out;
  },

  "CI-023"(view) {
    const out = [];
    for (const w of workflowText(view)) {
      codeLines(w.text).forEach((l, i) => {
        if (/vercel/i.test(l)) out.push({ rule: "CI-023", file: w.path, line: i + 1, message: "names Vercel, which no longer builds or deploys anything here. Remove it; a portal still served by Vercel records an exemption with the date it moves." });
      });
    }
    return out;
  },

  "CI-024"(view) {
    const out = [];
    for (const w of workflowText(view)) {
      codeLines(w.text).forEach((l, i) => {
        const m = l.match(/\bdd-ci-01-[a-z]\b/);
        if (m) out.push({ rule: "CI-024", file: w.path, line: i + 1, message: `${m[0]} is one of the persistent runners, gone since every job got its own VM. Remove the branch on it.` });
      });
    }
    return out;
  },

  "CI-025"(view) {
    if (!view.files?.["turbo.json"]) return [];
    const out = [];
    for (const w of view.workflows) {
      if (!triggers(w.text).includes("pull_request")) continue;
      codeLines(w.text).forEach((l, i) => {
        if (/\bturbo\s+run\b/.test(l) && !/--filter|--affected|TURBO_FILTERS|turbo-filters/.test(l)) {
          out.push({ rule: "CI-025", file: w.path, line: i + 1, message: "runs `turbo run` over every workspace on each pull request. Scope it with Doman-Digital/dd-ci-standards/.github/actions/workspace-scope@v1 and pass its turbo-filters (or pnpm-filters), so a PR runs only the workspaces it affects." });
        }
      });
    }
    return out;
  },

  "CI-027"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!triggers(w.text).includes("pull_request")) continue;
      if (!concurrencyBlocks(w.text).some((c) => c.cancel && c.cancel !== "false")) continue;
      for (const j of jobBlocks(w.text)) {
        const m = /^ {4}if:[^\n]*\balways\(\)/m.exec(j.block);
        if (!m) continue;
        out.push({ rule: "CI-027", file: w.path, line: j.line + lineOf(j.block, m.index) - 1, message: `job ${j.name} runs with always(), so a run cancelled by a newer push still waits for a VM to run it, and holds its concurrency group until then: the newer run sits pending behind the whole queue. Use if: \${{ !cancelled() }} (add the rest of the condition after &&). A cancelled run then reports the job cancelled, which still blocks a merge.` });
      }
    }
    return out;
  },

  "CI-026"(view, ctx) {
    const out = [];
    for (const c of ctx.budget?.ghCrons ?? []) {
      const w = view.workflows.find((x) => x.path === `.github/workflows/${c.workflow}`);
      if (w && scheduleCrons(w.text).some((x) => x.cron === c.cron)) continue;
      out.push({ rule: "CI-026", file: "(dd-ci-standards budget.yml)", message: `budget.yml registers ${c.workflow} "${c.cron}" for ${ctx.repoName || "this repo"}, which ${w ? "no longer has that schedule" : "no longer exists"}. Remove the line from Doman-Digital/dd-ci-standards budget.yml.` });
    }
    return out;
  },

  "CI-028"(view, ctx) {
    if (ctx.visibility !== "private") return [];
    const owner = ctx.meta?.owner?.login;
    if (owner && owner !== RUNNER_OWNER) return [];
    const registry = ctx.hostedJobs ?? HOSTED_JOBS;
    if (!registry) return [];
    const name = ctx.repoName;
    const allowed = (registry.jobs ?? []).filter((e) => e.repo === name);
    const out = [];
    const seen = new Set();
    for (const w of view.workflows) {
      if (triggers(w.text).every((t) => t === "workflow_call")) continue;
      const file = w.path.replace(/^\.github\/workflows\//, "");
      for (const j of jobBlocks(w.text)) {
        const runsOn = j.runsOn?.replace(/\s+#.*$/, "");
        if (!runsOn || !HOSTED_VAR.test(runsOn)) continue;
        const entry = allowed.find((e) => e.workflow === file && e.job === j.name);
        if (!entry) {
          out.push({ rule: "CI-028", file: w.path, line: j.runsOnLine, message: `job "${j.name}" runs on CI_RUNNER_HOSTED, GitHub's included minutes, but ${name || "this repo"} ${file} ${j.name} is not in dd-ci-standards hosted-jobs.json. Register it, with its measured minutes, in the same change; unregistered jobs use dd-ci-01.` });
          continue;
        }
        seen.add(entry);
        if (!sameExpr(runsOn, HOSTED_RUNS_ON)) {
          out.push({ rule: "CI-028", file: w.path, line: j.runsOnLine, runsOn: HOSTED_RUNS_ON, message: `job "${j.name}" is registered for GitHub's minutes but its runs-on is ${runsOn}. Use runs-on: ${HOSTED_RUNS_ON}, so the valve can send it back to dd-ci-01.` });
        }
      }
    }
    // A registered job that no longer uses the variable keeps minutes reserved for nothing.
    for (const e of allowed.filter((x) => !seen.has(x))) {
      out.push({ rule: "CI-028", file: "(dd-ci-standards hosted-jobs.json)", message: `hosted-jobs.json registers ${e.workflow} ${e.job} for ${name}, which does not run on CI_RUNNER_HOSTED. Remove the line, or put the job on ${HOSTED_RUNS_ON}.` });
    }
    return out;
  },

  "REG-007"(view) {
    const produced = new Set();
    const callers = new Set();
    for (const w of view.workflows) {
      for (const j of jobBlocks(w.text)) {
        const named = /^ {4}name:\s*["']?([^"'\n#$]+?)["']?\s*(?:#.*)?$/m.exec(j.block)?.[1];
        for (const n of [j.name, named].filter(Boolean)) (j.reusable ? callers : produced).add(n.trim());
      }
    }
    const made = (ctxName) => {
      if (produced.has(ctxName)) return true;
      const base = ctxName.replace(/ \([^)]*\)$/, "");
      if (produced.has(base)) return true;
      const slash = base.indexOf(" / ");
      return slash > 0 && callers.has(base.slice(0, slash));
    };
    return (view.required ?? []).filter((c) => !made(c)).map((c) => ({ rule: "REG-007", file: "(default branch ruleset)", message: `the ruleset requires the check "${c}", and no workflow job here produces it, so every pull request waits for it forever. Remove it from the required checks, or restore the job.` }));
  },

  "SEC-008"(view) {
    return view.workflows.filter((w) => !/^permissions:[ \t]*(?:[^#\n]*)(?:#.*)?$/m.test(w.text)).map((w) => ({ rule: "SEC-008", file: w.path, message: "workflow token permissions are inherited. Declare explicit top-level permissions with only the reads needed; permissions: {} is valid when none are required." }));
  },

  "SEC-001"(view) {
    const out = [];
    for (const w of view.workflows) {
      w.text.split("\n").forEach((line, i) => {
        const m = line.match(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/);
        if (!m) return;
        const ref = m[1];
        if (ref.startsWith("./") || ref.startsWith("docker://")) return;
        const [repo, version = ""] = ref.split("@");
        if (repo.split("/")[0].toLowerCase() === "doman-digital") return;
        if (/^[0-9a-f]{40}$/.test(version)) return;
        out.push({ rule: "SEC-001", file: w.path, line: i + 1, message: `${ref} is not pinned to a full commit SHA. A tag can be moved to different code.` });
      });
    }
    return out;
  },

  "SEC-002"(view) {
    if (view.files["pnpm-lock.yaml"] == null) return [];
    const cfg = `${view.files["pnpm-workspace.yaml"] || ""}\n${view.files[".npmrc"] || ""}`;
    const out = [];
    if (!/minimumReleaseAge|minimum-release-age/.test(cfg)) {
      out.push({ rule: "SEC-002", file: "pnpm-workspace.yaml", message: "no minimumReleaseAge: a release published minutes ago installs immediately. Set it (for example 1440, one day), with minimumReleaseAgeExclude: [\"@domandigital/*\"] so our own releases install at once, as in the Renovate preset." });
    }
    if (/dangerouslyAllowAllBuilds:\s*true|dangerously-allow-all-builds\s*=\s*true/.test(cfg)) {
      out.push({ rule: "SEC-002", file: "pnpm-workspace.yaml", message: "dangerouslyAllowAllBuilds lets every dependency run install scripts. List the few that need it instead." });
    }
    return out;
  },

  "SEC-003"(view) {
    const renovate = ["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", ".github/renovate.json", ".github/renovate.json5"]
      .map((f) => [f, view.files[f]])
      .find(([, t]) => t != null);
    const dependabot = view.files[".github/dependabot.yml"] ?? view.files[".github/dependabot.yaml"];
    if (renovate) {
      const [f, t] = renovate;
      if (/Doman-Digital\/ci-standards\b/.test(t)) {
        return [{ rule: "SEC-003", file: f, message: "extends Doman-Digital/ci-standards, the repo's old name. Use github>Doman-Digital/dd-ci-standards//default.json#v1." }];
      }
      return [];
    }
    if (dependabot != null) return [];
    return [{ rule: "SEC-003", file: "renovate.json", message: 'no Renovate or Dependabot config, so security fixes never arrive as PRs. Add renovate.json with { "extends": ["github>Doman-Digital/dd-ci-standards//default.json#v1"] }.' }];
  },

  "SEC-004"(view) {
    if (!Array.isArray(view.paths)) return [];
    return view.paths.filter(isSecretFile).map((file) => ({
      rule: "SEC-004",
      file,
      message: "is tracked by git. Treat every value in it as leaked: rotate them, then `git rm --cached` the file. Deleting it later leaves it readable in history.",
    }));
  },

  "SEC-005"(view) {
    const patterns = ignorePatterns(view.files[".gitignore"] || "");
    const missing = MUST_IGNORE.filter((name) => !patterns.some((re) => re.test(name)));
    if (!missing.length) return [];
    return [{ rule: "SEC-005", file: ".gitignore", message: `does not ignore ${missing.join(", ")}. \`dd adopt\` adds the lines (.env, .env.*, .dev.vars, .doppler-token, with the examples kept).` }];
  },

  "SEC-006"(view) {
    if (view.workflows.some((w) => w.text.includes(POLICY_CALL) || /gitleaks/i.test(w.text))) return [];
    return [{ rule: "SEC-006", file: ".github/workflows/ci-standards-policy.yml", message: "no workflow scans pull requests for secrets. Call the policy check (it runs gitleaks on every PR), or run gitleaks in the repo's own CI." }];
  },

  "SEC-007"(view) {
    const out = [];
    for (const w of view.workflows) {
      if (!CF_DEPLOY.test(w.text)) continue;
      w.text.split("\n").forEach((line, i) => {
        if (!CF_SECRET.test(line)) return;
        out.push({
          rule: "SEC-007",
          file: w.path,
          line: i + 1,
          message: "the Cloudflare token comes from a GitHub secret, a long-lived copy nothing rotates. Deploy through dd-ci-standards' cloudflare-deploy.yml, which fetches a narrow token from Doppler with the repo's GitHub identity, then delete the secret. Only a simple client static site may use Cloudflare's GitHub app (Workers Builds) instead.",
        });
      });
    }
    return out;
  },

  "FW-004"(view) {
    const out = [];
    // A house workflow or action: Doman-Digital's, or the MMM owner's repos.
    const HOUSE_USES = /^\s*(?:-\s*)?uses:\s*["']?((?:Doman-Digital|Megameehunnah)\/[^@\s"']+)@([^\s"'#]+)/i;
    const PINNED = /^(?:v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/;
    for (const w of workflowText(view)) {
      codeLines(w.text).forEach((l, i) => {
        const m = l.match(HOUSE_USES);
        if (m && !PINNED.test(m[2])) out.push({ rule: "FW-004", file: w.path, line: i + 1, message: `${m[1]}@${m[2]} follows a branch, which moves without a release and breaks the day it is deleted. Use @v1, a release tag or a full commit SHA.` });
      });
    }
    return out;
  },

  "FW-003"(view) {
    const out = [];
    const PIN = /dd-ci-standards(?:\/[^@\s"'#]*)?@v\d+\.\d+[.\d]*|dd-ci-standards\/\/default\.json#v\d+\.\d+[.\d]*/i;
    for (const w of view.workflows) {
      codeLines(w.text).forEach((l, i) => {
        const m = l.match(PIN);
        if (m) out.push({ rule: "FW-003", file: w.path, line: i + 1, message: `${m[0]} pins the rulebook to one release, so this repo stops getting new rules and registrations. Use @v1, which moves with every release.` });
      });
    }
    for (const f of ["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", ".github/renovate.json", ".github/renovate.json5"]) {
      const m = (view.files[f] || "").match(PIN);
      if (m) out.push({ rule: "FW-003", file: f, message: `${m[0]} pins the Renovate preset to one release. Use #v1.` });
    }
    return out;
  },

  "CF-001"(view, ctx) {
    const registry = ctx.deploys ?? DEPLOYS;
    const repo = ctx.repo || ctx.meta?.full_name;
    if (!registry || !Array.isArray(view.wrangler) || !repo) return [];
    const mine = registry.workers.filter((w) => (w.repo || "").toLowerCase() === repo.toLowerCase());
    const out = [];
    for (const cfg of view.wrangler) {
      if (!cfg.name) continue;
      const entry = mine.find((w) => w.worker === cfg.name);
      if (!entry) {
        out.push({ rule: "CF-001", file: cfg.path, message: `Worker "${cfg.name}" has no deploy path in dd-ci-standards deploys.json. Register it (actions, workers-builds or retired) in the same change.` });
      }
    }
    // One path per Worker: a repo whose every Worker is built by Cloudflare's
    // GitHub app must not also deploy from Actions.
    const live = view.wrangler.map((c) => mine.find((w) => w.worker === c.name)).filter(Boolean);
    if (live.length && live.every((w) => w.path === "workers-builds")) {
      for (const wf of view.workflows.filter((w) => deploysToProduction(w.text) || callsSharedDeploy(w.text))) {
        out.push({ rule: "CF-001", file: wf.path, message: "deploys from Actions, but deploys.json says Cloudflare's GitHub app (Workers Builds) deploys this repo. Keep one path: remove this deploy, or move the Worker to actions in deploys.json and disconnect the app." });
      }
    }
    for (const w of live.filter((w) => w.path === "actions")) {
      // `workflow` names the file when wrangler runs inside a script it calls.
      if (w.workflow && view.workflows.some((wf) => wf.path === w.workflow)) continue;
      if (!view.workflows.some((wf) => deploysToProduction(wf.text) || callsSharedDeploy(wf.text))) {
        out.push({ rule: "CF-001", file: ".github/workflows", message: `deploys.json says Actions deploys Worker "${w.worker}", but no workflow here deploys it. Add the deploy (cloudflare-deploy.yml), name the workflow in its \`workflow\` field if wrangler runs inside a script, or correct deploys.json.` });
        break;
      }
    }
    return out;
  },

  "PKG-001"(view, ctx) {
    // ctx.craft comes from lib/craft.mjs: the network is read before the
    // rules, never inside them. Unknown (no ctx.craft, or npm unreachable)
    // reports nothing; the doctor says so in a note.
    const c = ctx.craft;
    if (!c || c.error) return [];
    const out = [];
    const seen = new Set();
    for (const v of c.versions) {
      if (v.catalogue !== "none" && compareCatalogue(v.catalogue, c.floor) >= 0) continue;
      const key = `${v.lockfile}:${v.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const where = c.versions.filter((x) => x.lockfile === v.lockfile && x.version === v.version).map((x) => x.importer);
      const carries = v.catalogue === "none" ? "carries no catalogue" : `carries catalogue ${v.catalogue}`;
      out.push({
        rule: "PKG-001",
        file: v.lockfile,
        message: `@domandigital/craft ${v.version} (${where.join(", ")}) ${carries}, older than ${c.floor}, the oldest copy-check trusts (floors.json). Merge Renovate's house packages PR, or run: ${v.lockfile === "package-lock.json" ? "npm install @domandigital/craft@latest" : "pnpm up -r @domandigital/craft@latest"}`,
      });
    }
    return out;
  },

  "REG-003"(view, ctx) {
    if (!view.workflows.length || ctx.repoName === "dd-ci-standards") return [];
    if (view.workflows.some((w) => w.text.includes(POLICY_CALL))) return [];
    return [{ rule: "REG-003", file: ".github/workflows", message: "has workflows but none calls the policy check (Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1)." }];
  },

  "REG-004"(view, ctx) {
    // Repo settings, not files. A token that cannot read them gets no field
    // back (or no meta at all): unknown, so not reported.
    const m = ctx.meta;
    if (!m || m.allow_auto_merge === undefined || m.delete_branch_on_merge === undefined) return [];
    // GitHub ignores allow_auto_merge on a private repo owned by a personal account on the Free plan
    // (the API answers 200 and changes nothing), so there it is not required; delete-on-merge still is.
    const autoMergeUnavailable = m.private === true && m.owner?.type === "User";
    const off = [m.allow_auto_merge || autoMergeUnavailable ? null : "auto-merge", m.delete_branch_on_merge ? null : "delete branch on merge"].filter(Boolean);
    if (!off.length) return [];
    const repo = m.full_name || "<owner>/<repo>";
    return [{ rule: "REG-004", file: "(repository settings)", message: `${off.join(" and ")} ${off.length > 1 ? "are" : "is"} off. Turn on with: gh api -X PATCH repos/${repo} -F allow_auto_merge=true -F delete_branch_on_merge=true` }];
  },
};
