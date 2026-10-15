import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const action = readFileSync(new URL("../.github/actions/post-deploy-checks/action.yml", import.meta.url), "utf8");
const script = fileURLToPath(new URL("../.github/actions/post-deploy-checks/run.sh", import.meta.url));
const token = "local-action-fixture";
function request({ response = { runs: [], dashboard: "https://example.invalid/dashboard" }, status = "200", curlExit = 0, ...over } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dd-post-deploy-")); mkdirSync(join(dir, "bin"));
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CLIENT: "fixture-client", CHECK: "", DELAY: "0", ADMIN_RUN_TOKEN: token, GITHUB_STEP_SUMMARY: join(dir, "summary"), TEST_CAPTURE: join(dir, "request.json"), TEST_RESPONSE: typeof response === "string" ? response : JSON.stringify(response), TEST_STATUS: status, TEST_EXIT: String(curlExit), ...over };
  writeFileSync(join(dir, "bin/curl"), `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(process.env.TEST_CAPTURE,JSON.stringify({args,stdin:fs.readFileSync(0,'utf8')}));fs.writeFileSync(args[args.indexOf('--output')+1],process.env.TEST_RESPONSE);process.stdout.write(process.env.TEST_STATUS);process.exit(Number(process.env.TEST_EXIT));\n`, { mode: 0o755 });
  try {
    const r = spawnSync("bash", [script], { env, encoding: "utf8" });
    const summary = existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, "utf8") : "";
    const captured = existsSync(env.TEST_CAPTURE) ? JSON.parse(readFileSync(env.TEST_CAPTURE, "utf8")) : null;
    assert.equal(r.status, 0, "advisory request must not fail deployment");
    assert.ok(!`${r.stdout}${r.stderr}${summary}`.includes(token), "token must never be output");
    if (captured) assert.ok(!captured.args.some((a) => a.includes(token) || a.includes("Authorization")), "auth must not be an argument");
    return { stdout: r.stdout, stderr: r.stderr, summary, captured };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("post-deploy composite takes client data but never a secret input", () => {
  assert.match(action, /using: composite/); assert.match(action, /shell: bash/);
  assert.match(action, /run: bash "\$GITHUB_ACTION_PATH\/run.sh"/);
  assert.ok(!/ADMIN_RUN_TOKEN|inputs\.token|secrets\./.test(action));
  execFileSync("bash", ["-n", script]);
});
test("missing token is a visible advisory skip with no request", () => {
  const r = request({ ADMIN_RUN_TOKEN: "" }); assert.equal(r.captured, null); assert.match(r.stdout, /::warning/);
});
test("actual script posts one bound JSON request and summarises inline/queued checks", () => {
  const r = request({ CHECK: 'check"; echo never', response: { runs: [{ checkId: "http", how: "inline", status: "pass", code: 200, url: "https://example.invalid/http" }, { checkId: "form", how: "queued", url: "https://example.invalid/form" }], dashboard: "https://example.invalid/dashboard", privateField: token } });
  assert.equal(r.captured.stdin, `header = "Authorization: Bearer ${token}"\n`);
  assert.deepEqual(JSON.parse(r.captured.args[r.captured.args.indexOf("--data") + 1]), { client: "fixture-client", check: 'check"; echo never' });
  assert.equal(r.captured.args.at(-1), "https://checks.domandigital.co.uk/run");
  assert.match(r.summary, /http.*pass \(200\)/); assert.match(r.summary, /form.*queued/);
});
test("failed inline check warns but does not fail the deployment", () => {
  assert.match(request({ response: { runs: [{ checkId: "http", how: "inline", status: "fail", url: "https://example.invalid" }] } }).stdout, /1 check\(s\) failed/);
});
for (const [name, options] of [["refused response", { status: "403", response: { error: token } }], ["unreachable endpoint", { curlExit: 7 }], ["malformed response", { response: "not JSON" }]]) {
  test(`${name} warns without exposing the response or failing deploy`, () => { assert.match(request(options).stdout, /::warning/); });
}
for (const [name, options] of [["unsafe client", { CLIENT: 'bad;touch /tmp/not-a-command' }], ["unbounded delay", { DELAY: "999999999999999999" }], ["negative delay", { DELAY: "-1" }], ["header injection", { ADMIN_RUN_TOKEN: token + "\nBad: value" }]]) {
  test(`${name} is rejected before any network request`, () => { const r = request(options); assert.equal(r.captured, null); assert.match(r.stdout, /::warning/); });
}
