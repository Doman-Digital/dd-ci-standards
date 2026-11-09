// dd-repo-registry's cf.* job rows, for CF-002 and CF-003. The registry lives in its own repo, so a
// checkout beside this one (or DD_REPO_REGISTRY) is read; where there is none, readCfJobs returns null and
// the rules say they were not checked rather than guess (the same stance as CF-001 and PKG-001).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const scalar = (raw) => {
  const v = raw.trim();
  const quoted = v.match(/^(["'])(.*)\1/);
  return quoted ? quoted[2] : v.replace(/\s+#.*$/, "");
};

/** The fields CF-002 and CF-003 read, from one row's top-level lines (rows keep their values on one line). */
export function parseCfRow(text) {
  const top = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) top[m[1]] = scalar(m[2]);
  }
  // defined_in is "Owner/Repo:path", with "#staging" on a second environment in the same file.
  const at = top.defined_in || "";
  const colon = at.indexOf(":");
  const repo = colon < 0 ? at : at.slice(0, colon);
  const path = colon < 0 ? "" : at.slice(colon + 1).replace(/#.*$/, "");
  return { id: top.id, repo, path, schedule: top.schedule, database: top.database, dbGate: top.db_gate, verdict: top.verdict };
}

/** Every cf.* row in <registry>/jobs, or null when the registry is not on this machine. */
export function readCfJobs(registryDir) {
  const dir = join(registryDir, "jobs");
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((f) => /^cf\..+\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const row = parseCfRow(readFileSync(join(dir, f), "utf8"));
      return { ...row, id: row.id || f.replace(/\.ya?ml$/, "") };
    });
}
