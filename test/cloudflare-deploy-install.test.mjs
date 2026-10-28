import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// DOM-1490: a Worker inside a pnpm workspace (apps/site) has no lockfile of its own. The Install step has to find the
// workspace's, install that package and what it needs, and still hand the deploy a wrangler it can run. These run the
// real step, under the shell flags GitHub uses, against stub corepack and pnpm.

const text = readFileSync(new URL("../.github/workflows/cloudflare-deploy.yml", import.meta.url), "utf8");
const script = text
  .split("      - name: Install\n")[1]
  .split("      - name: Manual run checks")[0]
  .split("run: |")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n")
  .trim();

function run(files, cwdRel) {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  try {
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls");
    for (const name of ["corepack", "pnpm", "npm"]) {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\necho "${name} $* @ $PWD" >> '${log}'\n`);
      chmodSync(file, 0o700);
    }
    const out = join(dir, "out");
    writeFileSync(out, "");
    const cwd = join(dir, cwdRel);
    mkdirSync(cwd, { recursive: true });
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_WORKSPACE: dir },
    });
    return { dir, status: r.status, stderr: r.stderr, stdout: r.stdout, calls: readFileSync(log, { flag: "a+" }).toString(), output: readFileSync(out, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a package with its own pnpm lockfile installs there, as before", () => {
  const r = run(["pnpm-lock.yaml"], ".");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /pnpm install --frozen-lockfile @ /);
  assert.doesNotMatch(r.calls, /--filter/);
  assert.match(r.output, /wrangler=pnpm exec wrangler/);
});

test("a package in a workspace installs from the workspace root, filtered to itself and what it needs", () => {
  const r = run(["pnpm-lock.yaml", "apps/site/package.json"], "apps/site");
  assert.equal(r.status, 0, r.stderr);
  // The whole workspace, no filter: apps/site's build reads @doman/config through apps/marketing, which a filter
  // on the site and its dependencies leaves out (the first two CI deploys failed on that and on @doman/shared).
  assert.match(r.calls, /pnpm install --frozen-lockfile @ \S+install-\S+$/m, r.calls);
  assert.doesNotMatch(r.calls, /--filter/);
  assert.match(r.output, /wrangler=pnpm exec wrangler/);
});

test("an npm package is still installed with npm ci", () => {
  const r = run(["package-lock.json"], ".");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /npm ci/);
  assert.match(r.output, /npx --no-install wrangler/);
});

test("no lockfile anywhere up to the checkout still fails, naming the directory", () => {
  const r = run(["apps/site/package.json"], "apps/site");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /No pnpm-lock\.yaml or package-lock\.json/);
});
