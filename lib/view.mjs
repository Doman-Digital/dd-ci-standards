// A repo view: the plain data every rule reads. Rules never touch the disk or
// the network, so the same rules run on a checkout (dd doctor, the policy
// check) and, later, on files fetched through the API (the estate sweep).
//
// { workflows: [{ path, text }], actions: [{ path, text }], vercel: [{ path, json }],
//   files: { name: text|null }, wrangler: [{ path, name, crons, text }], paths: [tracked file paths] | null,
//   scripts: [{ path, text }] | undefined (tracked files that mention a name CI-045 keeps out of scripts),
//   csp: [{ path, text }] | undefined (tracked files that load Square's SDK or define a Content-Security-Policy, for CI-046),
//   required: [required status check names on the default branch] | null }
//
// actions are the repo's own composite actions (.github/actions/**/action.yml):
// the rules that read workflow text read them too, so a leftover cannot hide
// one level down. required is filled in by whoever can read the repo's rulesets
// (bin/dd.mjs, the estate sweep); null when nobody could.
//
// paths is what git tracks, never what is on disk: a local, ignored .env is
// fine, a committed one is the finding. null when that cannot be known.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { wranglerCrons, wranglerName, storageGrepTerms, CSP_GREP_TERMS } from "./rules.mjs";

/** A Wrangler config, outside node_modules and dot-folders. */
export const WRANGLER_FILE = /(^|\/)wrangler\.(jsonc?|toml)$/;
export const skipDir = (p) => /(^|\/)(node_modules|\.[^/]+)\//.test(p);

/** Root files the rules look at; null when absent. */
export const ROOT_FILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".npmrc",
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  ".github/dd.json",
  // How the site was started (PKG-003): written by @domandigital/create-site.
  ".dd/site-start.json",
  ".gitignore",
  // Lighthouse CI's config, read by CI-033 (a pull request must not fail on a lab speed number).
  "lighthouserc.json",
  ".lighthouserc.json",
  "lighthouserc.js",
  ".lighthouserc.js",
  "lighthouserc.cjs",
];

/** Every path git tracks under root, or null outside a git checkout. */
function trackedPaths(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The tracked text files that mention a name CI-045 keeps out of scripts (storage-drift.json): path and text, nothing
 * else. git finds them first, so a monorepo's thousands of files are not read to learn that two mention the bucket.
 * undefined outside a git checkout (CI-045 then reads workflows only).
 */
function scriptsMentioningStorage(root) {
  const terms = storageGrepTerms();
  if (!terms.length) return undefined;
  let out;
  try {
    out = execFileSync("git", ["-C", root, "grep", "-l", "-z", "-I", "-F", ...terms.flatMap((t) => ["-e", t]), "--", "."], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return e.status === 1 ? [] : undefined; // 1 = git ran and found nothing
  }
  return out
    .split("\0")
    .filter((p) => p && !/(^|\/)node_modules\//.test(p) && !/^\.github\/workflows\//.test(p))
    .flatMap((p) => {
      try {
        const text = readFileSync(join(root, p), "utf8");
        return text.length > 2_000_000 ? [] : [{ path: p, text }];
      } catch {
        return [];
      }
    });
}

/** The tracked text files CI-046 reads: ones that load Square's SDK or define a Content-Security-Policy. undefined outside git. */
function cspCandidates(root) {
  let out;
  try {
    out = execFileSync("git", ["-C", root, "grep", "-l", "-z", "-I", "-F", ...CSP_GREP_TERMS.flatMap((t) => ["-e", t]), "--", ".", ":(exclude)*.md", ":(exclude)*.lock", ":(exclude)*.svg", ":(exclude)*pnpm-lock.yaml", ":(exclude)*package-lock.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return e.status === 1 ? [] : undefined;
  }
  return out
    .split("\0")
    .filter((p) => p && !/(^|\/)node_modules\//.test(p) && !/^\.github\/workflows\//.test(p))
    .flatMap((p) => {
      try {
        const text = readFileSync(join(root, p), "utf8");
        return text.length > 2_000_000 ? [] : [{ path: p, text }];
      } catch {
        return [];
      }
    });
}

export function loadFsView(root) {
  const dir = join(root, ".github", "workflows");
  const workflows = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .sort()
        .map((f) => ({ path: `.github/workflows/${f}`, text: readFileSync(join(dir, f), "utf8") }))
    : [];

  const vercel = [];
  const wrangler = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (WRANGLER_FILE.test(entry.name)) {
        const text = readFileSync(p, "utf8");
        const path = relative(root, p);
        wrangler.push({ path, name: wranglerName(entry.name, text), crons: wranglerCrons(path, text), text });
      } else if (entry.name === "vercel.json") {
        try {
          vercel.push({ path: relative(root, p), json: JSON.parse(readFileSync(p, "utf8")) });
        } catch {
          // Unparseable vercel.json is Vercel's problem to report, not a cron.
        }
      }
    }
  };
  walk(root);

  const files = {};
  for (const name of ROOT_FILES) {
    const p = join(root, name);
    files[name] = existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  return { workflows, actions: loadActions(root), vercel, wrangler, files, paths: trackedPaths(root), scripts: scriptsMentioningStorage(root), csp: cspCandidates(root), required: null };
}

/** The repo's composite actions: every action.yml or action.yaml under .github/actions. */
export const ACTION_FILE = /^\.github\/actions\/.+\/action\.ya?ml$/;
function loadActions(root) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (ACTION_FILE.test(relative(root, p))) out.push({ path: relative(root, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, ".github", "actions"));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
