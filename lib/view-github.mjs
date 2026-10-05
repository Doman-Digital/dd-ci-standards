// The same repo view as lib/view.mjs, read through the GitHub API instead of
// a checkout, so the estate sweep runs exactly the rules `dd doctor` runs.

import { ROOT_FILES } from "./view.mjs";

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
  const vercel = [];
  for (const p of paths.filter((p) => /(^|\/)vercel\.json$/.test(p) && !/(^|\/)(node_modules|\.[^/]+)\//.test(p))) {
    try {
      vercel.push({ path: p, json: JSON.parse((await raw(p)) ?? "{}") });
    } catch {
      // as in view.mjs: an unparseable vercel.json is not a cron
    }
  }
  const present = new Set(paths);
  const files = {};
  for (const name of ROOT_FILES) files[name] = present.has(name) ? await raw(name) : null;
  // A truncated tree is a partial list; rules that need every path skip it.
  return { workflows, vercel, files, paths: tree?.truncated ? null : paths, truncated: Boolean(tree?.truncated) };
}
