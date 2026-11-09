// House pins to a commit SHA, resolved against the pinned repo (CI-032).
//
// A full SHA pin names a commit, and GitHub resolves a `uses:` only to a
// commit some branch or tag still contains. When dd-ci-standards' history was
// rewritten, dd-relay's deploy.yml kept calling cloudflare-deploy.yml at a
// commit no ref held any more: every run failed at startup with "workflow was
// not found", and the relay stayed on its 31 October build for six days
// (Doman-Digital/dd-relay#350). The commit itself is still served by SHA, so
// "does the commit exist" passes it; only reachability from a ref is evidence.
//
// This is the one rule input that needs the network, so it is read here, before
// the rules run, and handed to them as view.pins:
//   { "<owner>/<name>@<sha>": "ok" | "orphaned" | "unknown" }
// {} when nothing is pinned to a SHA; null when there are SHA pins and no token to ask with. "unknown" is never a finding: the
// pinned repo could not be read (a private repo and a token scoped to this one),
// or GitHub did not give a clear answer.

import { shaPinOf } from "./rules.mjs";

/** Compares a pin may cost before it is left unknown (default branch, other branches, tags). */
export const MAX_COMPARES = 150;

/** Every "<owner>/<repo>@<sha>" a set of workflow and action texts pins. */
export function shaPins(texts) {
  const out = new Set();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      const pin = shaPinOf(line);
      if (pin) out.add(pin.key);
    }
  }
  return [...out];
}

/** A GET on the API: { status, json }. Never throws for an HTTP answer. */
function getter(token, fetchFn) {
  return async (path) => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dd-doctor" },
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // an empty or non-JSON body
    }
    return { status: res.status, json };
  };
}

/** A list endpoint, every page up to `pages` of 100. null when it cannot be read. */
async function list(get, path, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const { status, json } = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`);
    if (status !== 200 || !Array.isArray(json)) return p === 1 ? null : all;
    all.push(...json);
    if (json.length < 100) break;
  }
  return all;
}

/**
 * Is `sha` contained in the ref `base`? true, false, or null when GitHub gave no
 * clear answer. compare base...sha says "behind" or "identical" when base holds
 * sha; "ahead" or "diverged" when it does not; 404 when the two share no history
 * (a commit left behind by a rewrite) or the commit is gone.
 */
async function contains(get, repo, base, sha) {
  const { status, json } = await get(`/repos/${repo}/compare/${encodeURIComponent(base)}...${sha}`);
  if (status === 200) return json?.status === "behind" || json?.status === "identical";
  if (status === 404 || status === 422) return false;
  return null;
}

/** "ok", "orphaned" or "unknown" for one pin. */
export async function resolvePin(get, repo, sha) {
  const meta = await get(`/repos/${repo}`);
  if (meta.status !== 200 || !meta.json?.default_branch) return "unknown";
  const main = meta.json.default_branch;
  let unclear = false;
  const first = await contains(get, repo, main, sha);
  if (first) return "ok";
  if (first === null) unclear = true;

  // Off the default branch: another branch or a tag may still hold it.
  const branches = await list(get, `/repos/${repo}/branches`);
  const tags = await list(get, `/repos/${repo}/tags`);
  if (!branches || !tags) return "unknown";
  const seen = new Set();
  const bases = [];
  for (const b of branches) if (b.name !== main && b.commit?.sha && !seen.has(b.commit.sha)) seen.add(b.commit.sha), bases.push(b.commit.sha);
  for (const t of tags) if (t.commit?.sha && !seen.has(t.commit.sha)) seen.add(t.commit.sha), bases.push(t.commit.sha);
  if (bases.some((b) => b.toLowerCase() === sha)) return "ok";
  if (bases.length + 1 > MAX_COMPARES) return "unknown";
  // Ten at a time: an orphan asks every ref (92 for dd-ci-standards on 8 November 2026).
  for (let i = 0; i < bases.length; i += 10) {
    const answers = await Promise.all(bases.slice(i, i + 10).map((b) => contains(get, repo, b, sha)));
    if (answers.includes(true)) return "ok";
    if (answers.includes(null)) unclear = true;
  }
  return unclear ? "unknown" : "orphaned";
}

/**
 * view.pins for a repo view, asking GitHub once per pin (cached for the run).
 * Without a token, view.pins is null and CI-032 is not judged.
 */
export async function resolvePins(view, { token, fetchFn = fetch, cache = new Map() } = {}) {
  const pins = shaPins([...view.workflows, ...(view.actions ?? [])].map((w) => w.text));
  if (!pins.length) return {};
  if (!token) return null;
  const get = getter(token, fetchFn);
  const out = {};
  for (const key of pins) {
    if (!cache.has(key)) {
      const [repo, sha] = key.split("@");
      cache.set(key, resolvePin(get, repo, sha).catch(() => "unknown"));
    }
    out[key] = await cache.get(key);
  }
  return out;
}
