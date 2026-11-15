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
  mkdirSync(join(dir, "services/checks/src"), { recursive: true }); writeFileSync(join(dir, "services/checks/src/a.js"), "1\n");
  writeFileSync(join(dir, "services/checks/pnpm-lock.yaml"), "1\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  for (const [f, text] of Object.entries(change)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), text); }
  git("add", "."); git("commit", "-qm", "change");
  const bin = join(dir, ".bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const all = [{ name: "web", path: "apps/web" }, { name: "admin", path: "apps/admin" }, { name: "mono", path: "." }];
if (process.env.TEST_WORKSPACE_IN_INDEPENDENT) all.push({ name: "dd-checks", path: "services/checks" });
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
    execFileSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVENT_NAME: "pull_request", BASE_SHA: base, INCLUDE: "", DOCS, INDEPENDENT: "", GITHUB_OUTPUT: out, ...env } });
    return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a change inside one workspace scopes to that workspace", () => {
  assert.deepEqual(scope({ "apps/web/index.js": "2\n" }), { run: "true", "turbo-filters": "--filter=web", "pnpm-filters": "--filter=web", independent: "" });
});

test("a change outside every workspace runs everything, as does any event but a pull request", () => {
  for (const change of [{ "package.json": '{ "name": "mono", "x": 1 }\n' }, { "scripts/build.mjs": "x\n" }, { "docs/facts.json": "{}\n" }]) {
    assert.deepEqual(scope(change), { run: "true", "turbo-filters": "", "pnpm-filters": "--filter=!mono", independent: "" }, Object.keys(change)[0]);
  }
  assert.equal(scope({ "apps/web/index.js": "2\n" }, { EVENT_NAME: "schedule" })["turbo-filters"], "");
});

test("documentation alone runs nothing; include adds a workspace", () => {
  assert.deepEqual(scope({ "docs/notes.md": "x\n" }), { run: "false", independent: "" });
  assert.equal(scope({ "docs/notes.md": "x\n" }, { INCLUDE: "admin" })["turbo-filters"], "--filter=admin");
});

test("a very long list of files outside every workspace still runs everything (no SIGPIPE from head)", () => {
  // Past the 64 KiB pipe buffer, `printf | head -20` under pipefail killed the script. Deleting a whole app is one such change.
  const change = {};
  for (let i = 0; i < 1500; i++) change[`gone/${"d".repeat(60)}/file-${i}.txt`] = "x\n";
  assert.deepEqual(scope(change), { run: "true", "turbo-filters": "", "pnpm-filters": "--filter=!mono", independent: "" });
});

test("a merge group is scoped against the group's base, not its first parent", () => {
  // The queue's commit is a plain commit on top of earlier entries: HEAD^1 is not main. BASE_SHA is.
  assert.deepEqual(scope({ "apps/web/index.js": "2\n" }, { EVENT_NAME: "merge_group" }), { run: "true", "turbo-filters": "--filter=web", "pnpm-filters": "--filter=web", independent: "" });
  assert.deepEqual(scope({ "scripts/build.mjs": "x\n" }, { EVENT_NAME: "merge_group" }), { run: "true", "turbo-filters": "", "pnpm-filters": "--filter=!mono", independent: "" });
  assert.deepEqual(scope({ "docs/notes.md": "x\n" }, { EVENT_NAME: "merge_group" }), { run: "false", independent: "" });
  assert.equal(scope({ "apps/web/index.js": "2\n" }, { EVENT_NAME: "merge_group", BASE_SHA: "" })["turbo-filters"], "", "no base commit runs everything");
  assert.equal(scope({ "apps/web/index.js": "2\n" }, { EVENT_NAME: "push" })["turbo-filters"], "", "a push still runs everything");
});

test("action.yml gives a merge group its base commit", () => {
  const action = readFileSync(new URL("../.github/actions/workspace-scope/action.yml", import.meta.url), "utf8");
  assert.match(action, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/);
});

const INDEP = { INDEPENDENT: "services/checks" };
const EVERYTHING = { run: "true", "turbo-filters": "", "pnpm-filters": "--filter=!mono" };

test("a change only under an independent path skips the root workspaces and names the service", () => {
  for (const change of [{ "services/checks/src/a.js": "2\n" }, { "services/checks/pnpm-lock.yaml": "2\n" }, { "services/checks/src/new/b.js": "x\n", "services/checks/README.md": "x\n" }]) {
    assert.deepEqual(scope(change, INDEP), { run: "false", independent: "services/checks" }, Object.keys(change)[0]);
  }
  // The same holds in a merge group, and a trailing slash or ./ in the input changes nothing.
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n" }, { ...INDEP, EVENT_NAME: "merge_group" }), { run: "false", independent: "services/checks" });
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n" }, { INDEPENDENT: "./services/checks/" }), { run: "false", independent: "services/checks" });
});

test("an independent path beside a workspace change scopes the workspace and still names the service", () => {
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n", "apps/web/index.js": "2\n" }, INDEP), { run: "true", "turbo-filters": "--filter=web", "pnpm-filters": "--filter=web", independent: "services/checks" });
  // Documentation beside it still widens nothing.
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n", "docs/notes.md": "x\n" }, INDEP), { run: "false", independent: "services/checks" });
});

test("an independent path plus a root file runs everything, independent paths included", () => {
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n", "package.json": '{ "name": "mono", "x": 1 }\n' }, INDEP), { ...EVERYTHING, independent: "services/checks" });
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n", "docs/facts.json": "{}\n" }, INDEP), { ...EVERYTHING, independent: "services/checks" });
});

test("an unknown top-level directory still runs everything, with the reason printed", () => {
  const { dir, base, bin } = repo({ "tools/new/x.js": "x\n" });
  try {
    const out = join(dir, ".out"); writeFileSync(out, "");
    const log = execFileSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVENT_NAME: "pull_request", BASE_SHA: base, INCLUDE: "", DOCS, ...INDEP, GITHUB_OUTPUT: out } });
    assert.match(log, /Changed outside every workspace:\ntools\/new\/x\.js/);
    assert.match(log, /Scope: every workspace \(a shared file changed\)/);
    assert.match(readFileSync(out, "utf8"), /run=true\nturbo-filters=\npnpm-filters=--filter=!mono\nindependent=services\/checks\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a folder that merely shares a name prefix with an independent path is not independent", () => {
  assert.deepEqual(scope({ "services/checks-extra/x.js": "x\n" }, INDEP), { ...EVERYTHING, independent: "services/checks" });
});

test("a workspace that sits under an independent path is not counted as a root workspace", () => {
  // Turbo would list it, but its own job owns it.
  assert.deepEqual(scope({ "services/checks/src/a.js": "2\n" }, { ...INDEP, TEST_WORKSPACE_IN_INDEPENDENT: "1" }), { run: "false", independent: "services/checks" });
});

test("action.yml wires the independent input and output", () => {
  const action = readFileSync(new URL("../.github/actions/workspace-scope/action.yml", import.meta.url), "utf8");
  assert.match(action, /INDEPENDENT: \$\{\{ inputs\.independent \}\}/);
  assert.match(action, /value: \$\{\{ steps\.scope\.outputs\.independent \}\}/);
});
