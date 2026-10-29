import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = new URL("../.github/actions/workspace-scope/scope.sh", import.meta.url).pathname;
const DOCS = "^docs/.*\\.(md|csv)$|^[^/]*\\.md$";

// A two-app monorepo, and a `pnpm` stub whose `turbo ls` answers like Turbo's:
// every workspace, or (with --affected) those with a change since TURBO_SCM_BASE.
function repo(change) {
  const dir = mkdtempSync(join(tmpdir(), "dd-scope-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "F"); git("config", "user.email", "f@example.invalid");
  writeFileSync(join(dir, "package.json"), '{ "name": "mono" }\n');
  for (const a of ["apps/web", "apps/admin"]) { mkdirSync(join(dir, a), { recursive: true }); writeFileSync(join(dir, a, "index.js"), "1\n"); }
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  for (const [f, text] of Object.entries(change)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), text); }
  git("add", "."); git("commit", "-qm", "change");
  const bin = join(dir, ".bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const all = [{ name: "web", path: "apps/web" }, { name: "admin", path: "apps/admin" }, { name: "mono", path: "." }];
let items = all.filter((p) => p.path !== ".");
if (process.argv.includes("--affected")) {
  const changed = execFileSync("git", ["diff", "--name-only", process.env.TURBO_SCM_BASE, "HEAD"], { encoding: "utf8" }).split("\\n");
  items = items.filter((p) => changed.some((f) => f.startsWith(p.path + "/")));
}
console.log(JSON.stringify({ packages: { items } }));
`, { mode: 0o755 });
  return { dir, base, bin };
}

function scope(change, env = {}) {
  const { dir, base, bin } = repo(change);
  try {
    const out = join(dir, ".out");
    writeFileSync(out, "");
    execFileSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVENT_NAME: "pull_request", BASE_SHA: base, INCLUDE: "", DOCS, GITHUB_OUTPUT: out, ...env } });
    return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a change inside one workspace scopes to that workspace", () => {
  assert.deepEqual(scope({ "apps/web/index.js": "2\n" }), { run: "true", "turbo-filters": "--filter=web", "pnpm-filters": "--filter=web" });
});

test("a change outside every workspace runs everything, as does any event but a pull request", () => {
  for (const change of [{ "package.json": '{ "name": "mono", "x": 1 }\n' }, { "scripts/build.mjs": "x\n" }, { "docs/facts.json": "{}\n" }]) {
    assert.deepEqual(scope(change), { run: "true", "turbo-filters": "", "pnpm-filters": "--filter=!mono" }, Object.keys(change)[0]);
  }
  assert.equal(scope({ "apps/web/index.js": "2\n" }, { EVENT_NAME: "schedule" })["turbo-filters"], "");
});

test("documentation alone runs nothing; include adds a workspace", () => {
  assert.deepEqual(scope({ "docs/notes.md": "x\n" }), { run: "false" });
  assert.equal(scope({ "docs/notes.md": "x\n" }, { INCLUDE: "admin" })["turbo-filters"], "--filter=admin");
});

test("a very long list of files outside every workspace still runs everything (no SIGPIPE from head)", () => {
  // Past the 64 KiB pipe buffer, `printf | head -20` under pipefail killed the script. Deleting a whole app is one such change.
  const change = {};
  for (let i = 0; i < 1500; i++) change[`gone/${"d".repeat(60)}/file-${i}.txt`] = "x\n";
  assert.deepEqual(scope(change), { run: "true", "turbo-filters": "", "pnpm-filters": "--filter=!mono" });
});
