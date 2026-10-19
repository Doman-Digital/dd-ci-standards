import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";

const policy = readFileSync(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8");
const scan = policy.split("      - name: Scan for secrets\n")[1].split("\n\n      # Was redacted")[0];
const script = scan.split("        run: |\n")[1].split("\n").map((s) => s.replace(/^ {10}/, "")).join("\n");

test("policy checkout retains commit history and uses read-only, non-persistent blob filtering", () => {
  assert.match(policy, /^permissions:\n  contents: read\n/m);
  assert.match(policy, /fetch-depth: 0\n\s+filter: \$\{\{ \(github.event_name == 'pull_request' \|\| github.event_name == 'push'\) && 'blob:none' \|\| '' \}\}/);
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
    const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, GH_TOKEN: fixtureToken, EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head, GITHUB_SERVER_URL: origin, GIT_TERMINAL_PROMPT: "0", SCAN_CAPTURE: join(dir, "patch") };
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

// The range each event scans, with gitleaks replaced by a stub that prints
// the log options it was given.
const rangeFor = (env, setup) => {
  const dir = mkdtempSync(join(tmpdir(), "dd-policy-range-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(dir, "a.txt"), "1\n"); git(["add", "."]); git(["commit", "-qm", "one"]);
    writeFileSync(join(dir, "a.txt"), "2\n"); git(["commit", "-qam", "two"]);
    const shas = { one: git(["rev-parse", "HEAD~1"]), two: git(["rev-parse", "HEAD"]) };
    const tools = join(dir, ".bin"); mkdirSync(tools);
    writeFileSync(join(tools, "gitleaks"), '#!/bin/sh\nfor a in "$@"; do case "$a" in --log-opts=*) echo "${a#--log-opts=}";; esac; done\n', { mode: 0o755 });
    const file = join(dir, ".scan.sh"); writeFileSync(file, script);
    const out = execFileSync("bash", [file], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, GH_TOKEN: "x", GITHUB_SERVER_URL: "https://github.com", ...setup(shas), ...env } });
    return { range: out.trim().split("\n").pop(), shas };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("a push scans the pushed commits, and only the pushed commit when before is unknown", () => {
  const known = rangeFor({ EVENT_NAME: "push" }, (s) => ({ BEFORE_SHA: s.one, AFTER_SHA: s.two }));
  assert.equal(known.range, `${known.shas.one}..${known.shas.two}`);
  const created = rangeFor({ EVENT_NAME: "push" }, (s) => ({ BEFORE_SHA: "0".repeat(40), AFTER_SHA: s.two }));
  assert.equal(created.range, `-1 ${created.shas.two}`);
  const forced = rangeFor({ EVENT_NAME: "push" }, (s) => ({ BEFORE_SHA: "1".repeat(40), AFTER_SHA: s.two }));
  assert.equal(forced.range, `-1 ${forced.shas.two}`);
});

test("a scheduled or manual run scans the checked-out branch's history, not every branch", () => {
  assert.equal(rangeFor({ EVENT_NAME: "schedule" }, () => ({})).range, "HEAD");
  assert.equal(rangeFor({ EVENT_NAME: "workflow_dispatch" }, () => ({})).range, "HEAD");
});

test("the doctor and Semgrep run on pull requests only; Semgrep only when asked", () => {
  assert.match(policy, /- if: github.event_name == 'pull_request'\n\s+uses: Doman-Digital\/dd-ci-standards\/doctor@v1/);
  assert.match(policy, /if: \$\{\{ !cancelled\(\) && inputs.semgrep && github.event_name == 'pull_request' \}\}/);
  assert.match(policy, /SEMGREP_IMAGE: semgrep\/semgrep@sha256:[0-9a-f]{64}/);
});
