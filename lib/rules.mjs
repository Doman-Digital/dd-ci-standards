// The checks behind rules.json. Each takes a repo view (lib/view.mjs) and a
// context, and returns findings { rule, file, line?, message }. Whether a
// finding warns, fails or is exempt is decided in lib/engine.mjs, not here.
//
// Line-scanning on purpose, as before: these are structural shape checks on
// workflow YAML, not semantic ones, and the repo has no dependencies.

const POLICY_CALL = "dd-ci-standards/.github/workflows/policy.yml";
const HOSTED = /\b(ubuntu|windows|macos)-[\w.]+/;
const SELF_HOSTED = /self-hosted|\bdd-ci\b|CI_RUNNER/;
const FIXED_PORT = /(?:localhost|127\.0\.0\.1):3\d{3}\b|(?:\s-p|--port)[ =]3\d{3}\b|\bPORT[=:]\s*["']?3\d{3}\b/;
// Only a job that starts a server can collide; a URL in an env var cannot.
const STARTS_SERVER = /next (?:start|dev)\b|\b(?:pnpm|npm|yarn)(?: run)? (?:dev|start|preview)\b|http-server|\bserve\b -|start-server-and-test|vite preview|astro preview/;

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

export const CHECKS = {
  "CI-001"(view, ctx) {
    if (ctx.visibility !== "private") return [];
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
      for (const j of jobBlocks(w.text)) {
        if (j.runsOn && SELF_HOSTED.test(j.runsOn)) {
          out.push({ rule: "CI-002", file: w.path, line: j.runsOnLine, message: `job "${j.name}" can run on the self-hosted runners (${j.runsOn}) in a public repo. Use a GitHub-hosted runner.` });
        }
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

  "CI-009"(view) {
    const out = [];
    for (const w of view.workflows) {
      for (const j of jobBlocks(w.text)) {
        if (!j.runsOn || !SELF_HOSTED.test(j.runsOn) || !STARTS_SERVER.test(j.block)) continue;
        const m = FIXED_PORT.exec(j.block);
        if (m && !j.block.includes("CI_PORT_OFFSET")) {
          out.push({ rule: "CI-009", file: w.path, line: j.line, message: `job "${j.name}" uses a fixed port (${m[0].trim()}) on a self-hosted runner. Runners share one VM; add CI_PORT_OFFSET.` });
        }
      }
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

  "REG-003"(view, ctx) {
    if (!view.workflows.length || ctx.repoName === "dd-ci-standards") return [];
    if (view.workflows.some((w) => w.text.includes(POLICY_CALL))) return [];
    return [{ rule: "REG-003", file: ".github/workflows", message: "has workflows but none calls the policy check (Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1)." }];
  },
};
