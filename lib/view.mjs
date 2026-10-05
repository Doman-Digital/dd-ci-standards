// A repo view: the plain data every rule reads. Rules never touch the disk or
// the network, so the same rules run on a checkout (dd doctor, the policy
// check) and, later, on files fetched through the API (the estate sweep).
//
// { workflows: [{ path, text }], vercel: [{ path, json }], files: { name: text|null },
//   paths: [tracked file paths] | null }
//
// paths is what git tracks, never what is on disk: a local, ignored .env is
// fine, a committed one is the finding. null when that cannot be known.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

/** Root files the rules look at; null when absent. */
export const ROOT_FILES = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
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
  ".gitignore",
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

export function loadFsView(root) {
  const dir = join(root, ".github", "workflows");
  const workflows = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .sort()
        .map((f) => ({ path: `.github/workflows/${f}`, text: readFileSync(join(dir, f), "utf8") }))
    : [];

  const vercel = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "vercel.json") {
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
  return { workflows, vercel, files, paths: trackedPaths(root) };
}
