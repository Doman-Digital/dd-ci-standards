import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";

const policy = readFileSync(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8");
const scan = policy.split("      - name: Scan the commits this pull request adds\n")[1].split("\n\n      # Was sen-sphere")[0];
const script = scan.split("        run: |\n")[1].split("\n").map((s) => s.replace(/^ {10}/, "")).join("\n");

test("policy checkout retains commit history and uses read-only, non-persistent blob filtering", () => {
  assert.match(policy, /^permissions:\n  contents: read\n/m);
  assert.match(policy, /fetch-depth: 0\n\s+filter: blob:none/);
  assert.match(policy, /persist-credentials: false/);
  assert.match(scan, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.ok(!script.includes("${{"));
});

const run = (file, args, options = {}) => new Promise((resolve) => {
  const p = spawn(file, args, options); let stdout = "", stderr = "";
  p.stdout.on("data", (x) => { stdout += x; }); p.stderr.on("data", (x) => { stderr += x; });
  p.on("close", (code) => resolve({ code, stdout, stderr }));
});

test("filtered private history is fetched with scan-only auth and leaves no credential on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-policy-"));
  const source = join(dir, "source"), bare = join(dir, "repo.git"), checkout = join(dir, "checkout"), tools = join(dir, "bin");
  mkdirSync(source); mkdirSync(tools);
  const git = (args, cwd = source) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const fixtureToken = "local-policy-fixture";
  const authorization = `Basic ${Buffer.from(`x-access-token:${fixtureToken}`).toString("base64")}`;
  let denied = 0, accepted = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization?.replace(/^basic /i, "Basic ") !== authorization) { denied++; res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }); res.end(); return; }
    accepted++;
    const url = new URL(req.url, "http://localhost");
    const backend = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers["content-type"] || "", CONTENT_LENGTH: req.headers["content-length"] || "", HTTP_GIT_PROTOCOL: req.headers["git-protocol"] || "" } });
    const chunks = []; backend.stdout.on("data", (x) => chunks.push(x)); backend.stderr.resume(); req.pipe(backend.stdin);
    backend.on("close", () => {
      const data = Buffer.concat(chunks), end = data.indexOf("\r\n\r\n");
      if (end < 0) { res.writeHead(500); res.end(); return; }
      let status = 200;
      for (const line of data.subarray(0, end).toString().split("\r\n")) { const colon = line.indexOf(":"); if (colon < 0) continue; const name = line.slice(0, colon), value = line.slice(colon + 1).trim(); if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else res.setHeader(name, value); }
      res.writeHead(status); res.end(data.subarray(end + 4));
    });
  });
  try {
    git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(source, "history.txt"), "before\n"); git(["add", "."]); git(["commit", "-qm", "before"]); const base = git(["rev-parse", "HEAD"]);
    writeFileSync(join(source, "history.txt"), "after\n"); git(["commit", "-qam", "after"]); const head = git(["rev-parse", "HEAD"]);
    git(["clone", "--bare", source, bare], dir); git(["config", "uploadpack.allowFilter", "true"], bare);
    git(["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(bare).href, checkout], dir);
    assert.match(git(["rev-list", "--objects", "--all", "--missing=print"], checkout), /^\?/m, "fixture must start without history blobs");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    git(["remote", "set-url", "origin", `${origin}/repo.git`], checkout);
    writeFileSync(join(tools, "gitleaks"), '#!/bin/sh\ngit log --format= --patch "$BASE_SHA..$HEAD_SHA" > "$SCAN_CAPTURE"\n', { mode: 0o755 });
    const file = join(dir, "scan.sh"); writeFileSync(file, script);
    const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, GH_TOKEN: fixtureToken, BASE_SHA: base, HEAD_SHA: head, GITHUB_SERVER_URL: origin, GIT_TERMINAL_PROMPT: "0", SCAN_CAPTURE: join(dir, "patch") };
    const noAuth = await run("git", ["log", "--format=", "--patch", `${base}..${head}`], { cwd: checkout, env });
    assert.notEqual(noAuth.code, 0); assert.ok(denied > 0, "negative control must reach the protected HTTP endpoint");
    const result = await run("bash", [file], { cwd: checkout, env });
    assert.equal(result.code, 0, "actual policy scan step must fetch private historical blobs"); assert.ok(accepted > 0);
    assert.match(readFileSync(env.SCAN_CAPTURE, "utf8"), /-before\n\+after/);
    assert.ok(!result.stdout.includes(fixtureToken) && !result.stderr.includes(fixtureToken));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(authorization.slice(6)));
    const config = readFileSync(join(checkout, ".git/config"), "utf8");
    assert.ok(!/extraheader|AUTHORIZATION|local-policy-fixture/i.test(config));
    const child = await run("git", ["config", "--get-regexp", "http.*extraheader"], { cwd: checkout });
    assert.notEqual(child.code, 0, "auth must not survive the scan process");
  } finally { await new Promise((resolve) => server.listening ? server.close(resolve) : resolve()); rmSync(dir, { recursive: true, force: true }); }
});


test("the caller has no switches: the workflow takes only a runner and runs on pull requests", () => {
  const inputs = policy.split("    inputs:\n")[1].split("\npermissions:")[0];
  assert.deepEqual([...inputs.matchAll(/^ {6}([a-z_-]+):$/gm)].map((m) => m[1]), ["runner"]);
  assert.ok(!/secrets:\n\s+SLACK/.test(policy), "no secrets input");
  assert.ok(!/github\.event\.(before|after)/.test(policy), "no push mode");
});

test("Semgrep runs only for a repo scanners.json lists, read before the doctor", () => {
  assert.match(policy, /- id: scanners\n\s+uses: Doman-Digital\/dd-ci-standards\/scanners@v1\n\n\s+- uses: Doman-Digital\/dd-ci-standards\/doctor@v1/);
  assert.match(policy, /steps\.scanners\.outputs\.semgrep == 'true' && github\.event_name == 'pull_request'/);
  assert.match(policy, /SEMGREP_IMAGE: semgrep\/semgrep@sha256:[0-9a-f]{64}/);
});

test("the failure message and the docs tell the author to push: a ruleset run ignores types, and a re-run reads the old PR (DOM-1363 probe)", () => {
  assert.match(policy, /\n  pull_request:\n  merge_group:/, "types here would promise a re-run the ruleset never does");
  const rules = readFileSync(new URL("../lib/rules.mjs", import.meta.url), "utf8");
  assert.match(rules, /Then push a commit .*editing the description or labels does not start this check again/);
});
