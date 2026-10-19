// The same repo view as lib/view.mjs, read through the GitHub API instead of
// a checkout, so the estate sweep runs exactly the rules `dd doctor` runs.

import { ROOT_FILES, WRANGLER_FILE, ACTION_FILE, skipDir } from "./view.mjs";
import { wranglerName } from "./rules.mjs";

const API = "https://api.github.com";

export async function loadGithubView(repo, token, ref) {
  const get = async (path, accept = "application/vnd.github+json") => {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": "dd-doctor" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return accept.endsWith("raw") ? res.text() : res.json();
  };
  const raw = (path) => get(`/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw");

  const tree = await get(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const paths = (tree?.tree || []).filter((t) => t.type === "blob").map((t) => t.path);

  const workflows = [];
  for (const p of paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort()) {
    workflows.push({ path: p, text: (await raw(p)) ?? "" });
  }
  const actions = [];
  for (const p of paths.filter((p) => ACTION_FILE.test(p)).sort()) {
    actions.push({ path: p, text: (await raw(p)) ?? "" });
  }
  const vercel = [];
  for (const p of paths.filter((p) => /(^|\/)vercel\.json$/.test(p) && !/(^|\/)(node_modules|\.[^/]+)\//.test(p))) {
    try {
      vercel.push({ path: p, json: JSON.parse((await raw(p)) ?? "{}") });
    } catch {
      // as in view.mjs: an unparseable vercel.json is not a cron
    }
  }
  const wrangler = [];
  for (const p of paths.filter((p) => WRANGLER_FILE.test(p) && !skipDir(p))) {
    wrangler.push({ path: p, name: wranglerName(p, (await raw(p)) ?? "") });
  }
  const present = new Set(paths);
  const files = {};
  for (const name of ROOT_FILES) files[name] = present.has(name) ? await raw(name) : null;
  const required = await requiredChecks(repo, ref, get);
  // A truncated tree is a partial list; rules that need every path skip it.
  return { workflows, actions, vercel, wrangler, files, paths: tree?.truncated ? null : paths, truncated: Boolean(tree?.truncated), required };
}

/**
 * The status checks a ruleset requires on a branch that GitHub Actions has to
 * produce (checks from an app such as Workers Builds are left out), or null
 * when the rules cannot be read (a private repo on a free plan, no access).
 */
export async function requiredChecks(repo, branch, get) {
  try {
    const rules = await get(`/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
    if (!Array.isArray(rules)) return null;
    return rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .filter((c) => c.integration_id === undefined || c.integration_id === null || c.integration_id === GITHUB_ACTIONS_APP)
      .map((c) => c.context);
  } catch {
    return null;
  }
}
/** The GitHub Actions app: a required check from it comes from a workflow job. */
export const GITHUB_ACTIONS_APP = 15368;

