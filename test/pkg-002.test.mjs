import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS, workspaceGlobs } from "../lib/rules.mjs";

const run = (workspace, paths) => CHECKS["PKG-002"]({ workflows: [], vercel: [], files: { "pnpm-workspace.yaml": workspace }, paths });
const ROOT = "packages:\n  - 'apps/*'\n  - \"packages/**\"\n  - '!packages/**/fixtures'\n";

test("workspaceGlobs reads block and inline lists, quotes, ** and negation", () => {
  const g = workspaceGlobs(ROOT);
  assert.equal(g.include.length, 2);
  assert.ok(g.include[1].test("packages/a/b"));
  assert.ok(g.exclude[0].test("packages/a/fixtures"));
  assert.equal(workspaceGlobs("packages: ['apps/*', services/x] # two\n").include.length, 2);
  assert.equal(workspaceGlobs("packages: []\n").include.length, 0);
});

test("a nested project outside the root workspace is reported once per lockfile", () => {
  const f = run(ROOT, ["pnpm-workspace.yaml", "services/checks/pnpm-lock.yaml", "services/dd-cron/pnpm-lock.yaml", "tests/smoke/pnpm-lock.yaml"]);
  assert.deepEqual(f.map((x) => x.file), ["services/checks/pnpm-lock.yaml", "services/dd-cron/pnpm-lock.yaml", "tests/smoke/pnpm-lock.yaml"]);
  assert.match(f[0].message, /services\/checks\/pnpm-workspace\.yaml/);
});

test("members, excluded members, own workspaces and workspaces further up the tree", () => {
  // apps/web is a member; packages/a/fixtures is excluded, so it is reported.
  assert.deepEqual(run(ROOT, ["apps/web/pnpm-lock.yaml", "packages/a/fixtures/pnpm-lock.yaml"]).map((x) => x.file), ["packages/a/fixtures/pnpm-lock.yaml"]);
  // astro has its own workspace, and astro/studio's nearest one is astro's: not the root's business.
  assert.deepEqual(run(ROOT, ["astro/pnpm-workspace.yaml", "astro/pnpm-lock.yaml", "astro/studio/pnpm-lock.yaml"]), []);
});

test("no root workspace, or an unknown path list: nothing to report", () => {
  assert.deepEqual(CHECKS["PKG-002"]({ workflows: [], vercel: [], files: {}, paths: ["astro/pnpm-lock.yaml"] }), []);
  assert.deepEqual(CHECKS["PKG-002"]({ workflows: [], vercel: [], files: { "pnpm-workspace.yaml": ROOT }, paths: null }), []);
});
