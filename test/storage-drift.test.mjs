// CI-045: a script or workflow must not name where the capsule and metrics live (DOM-438, Phase 1b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runDoctor } from "../lib/engine.mjs";
import { storageNamePattern, EXEMPT_PATH, isScriptFile } from "../lib/rules.mjs";
import { loadFsView } from "../lib/view.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const config = JSON.parse(readFileSync(new URL("../storage-drift.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null };
const found = (view, ctx = {}) => runDoctor({ workflows: [], vercel: [], files: {}, ...view }, rulebook, { ...base, ...ctx }).findings.filter((f) => f.rule === "CI-045");
const script = (path, text) => ({ scripts: [{ path, text }] });

test("each way of spelling the home of the capsule or metrics is caught", () => {
  for (const line of [
    "CAPSULE=$HOME/dd-client-capsule",
    "cd ~/dd-client-metrics && ls",
    'ROOT = pathlib.Path.home() / "dd-client-metrics"',
    "os.path.join(HOME, 'dd-client-capsule')",
    'rclone sync r2:dd-client-capsule/_state "$DIR"',
    "R2_BUCKET=dd-client-capsule",
    'rclone lsf "r2:$B/_metrics/"',
    'const prefix = "_metrics"',
    "path: ${HOME}/dd-client-metrics/gsc",
  ]) assert.equal(found(script("scripts/job.sh", `#!/bin/sh\n${line}\n`)).length, 1, line);
});

test("a job name, a user agent and an ordinary variable are not the folder", () => {
  for (const line of [
    'problems = jobs / "dd-client-metrics.problems"',
    'headers = {"User-Agent": "dd-client-metrics/2"}',
    "_metrics = []",
    "self._metrics.append(x)",
    "echo dd-client-metrics-timer",
    "const total_metrics = 3",
  ]) assert.equal(found(script("scripts/job.py", `${line}\n`)).length, 0, line);
});

test("comment lines, tests, fixtures and data files are not read as scripts", () => {
  assert.equal(found(script("a.py", "# the bucket dd-client-capsule\n// dd-client-capsule\n * dd-client-capsule\n")).length, 0);
  for (const p of ["tests/a.py", "src/__tests__/a.ts", "x/test_sync.py", "lib/sync_test.go", "lib/sync.test.mjs", "web/a.spec.ts", "test/fixtures/z.sh", "fixtures/a.sh"]) {
    assert.ok(EXEMPT_PATH.test(p), p);
    assert.equal(found(script(p, "R2=dd-client-capsule\n")).length, 0, p);
  }
  for (const p of ["README.md", "docs/a.md", "registry.yaml", "config.json"]) assert.equal(found(script(p, "dd-client-capsule\n")).length, 0, p);
  assert.ok(isScriptFile("bin/dd-thing", "#!/usr/bin/env python3\n") && !isScriptFile("bin/notes", "plain"));
  assert.equal(found(script("bin/dd-thing", "#!/usr/bin/env python3\nBUCKET = 'dd-client-capsule'\n")).length, 1);
});

test("a workflow step that names the bucket fails, and a commented one does not", () => {
  const wf = (step) => ({ workflows: [{ path: ".github/workflows/x.yml", text: `on: push\njobs:\n  a:\n    steps:\n${step}\n` }] });
  assert.equal(found(wf("      - run: rclone ls r2:dd-client-capsule")).length, 1);
  assert.equal(found(wf("      - run: echo ok # r2:dd-client-capsule was here")).length, 0);
});

test("the allow list names a repo and a path, and only that file escapes", () => {
  const text = "#!/usr/bin/env python3\nX = '~/dd-client-capsule'\n";
  const ctx = { repoName: "dd-agent-kit" };
  assert.equal(found(script("tools/sync/dd-claude-state-sync.sh", text), ctx).length, 0);
  assert.equal(found(script("tools/other.py", text), ctx).length, 1);
  assert.equal(found(script("tools/sync/dd-claude-state-sync.sh", text), { repoName: "some-client-site" }).length, 1, "the allow row is for the kit only");
  for (const a of config.allow) assert.ok(a.repo && a.path && a.reason.length > 20, `allow row for ${a.path} needs a repo, a path and a reason`);
});

test("the message tells the author the resolver call to use", () => {
  const [f] = found(script("s.sh", "#!/bin/sh\nB=dd-client-capsule\n"));
  assert.match(f.message, /dd-storage get/);
  assert.equal(f.line, 2);
});

test("on a checkout, git finds the files: red on a planted offender, green once it is routed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci044-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "scripts", "nightly.sh"), '#!/bin/bash\nrclone copy "$HOME/dd-client-metrics" r2:dd-client-capsule/_state\n');
  writeFileSync(join(dir, "tests", "nightly.test.sh"), "dd-client-capsule\n");
  writeFileSync(join(dir, "README.md"), "dd-client-capsule\n");
  git("add", ".");
  git("commit", "-qm", "x");
  assert.deepEqual(found(loadFsView(dir)).map((f) => f.file), ["scripts/nightly.sh"]);
  writeFileSync(join(dir, "scripts", "nightly.sh"), '#!/bin/bash\nrclone copy "$(dd-storage get local.metrics_dir)" "$(dd-storage dest --prefix state)"\n');
  git("commit", "-qam", "route it");
  assert.deepEqual(found(loadFsView(dir)), []);
});

test("the pattern is built from storage-drift.json and nothing else", () => {
  assert.ok(storageNamePattern(config).test("~/dd-client-capsule"));
  assert.equal(storageNamePattern({ names: [], retired_prefixes: [] }), null);
});
