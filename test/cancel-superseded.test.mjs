import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";

// DOM-1422: a deploy the tip guard skips must not end as a success. These run the real
// cancel.sh against a fake GitHub API, and read cloudflare-deploy.yml for the shape that
// makes the cancel possible (a job that inherits the caller's permissions).

const SCRIPT = new URL("../.github/actions/cancel-superseded/cancel.sh", import.meta.url).pathname;
const WORKFLOW = readFileSync(new URL("../.github/workflows/cloudflare-deploy.yml", import.meta.url), "utf8");
const haveTools = spawnSync("sh", ["-c", "command -v curl && command -v jq"]).status === 0;

async function run({ jobs, jobsStatus = 200, cancelStatus = 202 }) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    if (req.method === "GET") {
      res.writeHead(jobsStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ jobs }));
    } else {
      res.writeHead(cancelStatus);
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GH_TOKEN: "fixture", REPO: "o/r", RUN_ID: "7", WAIT_SECONDS: "0", GITHUB_STEP_SUMMARY: "/dev/null" };
  const child = spawn("bash", [SCRIPT], { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const status = await new Promise((r) => child.on("close", r));
  server.close();
  return { status, out, seen, cancelled: seen.includes("POST /repos/o/r/actions/runs/7/cancel") };
}

const job = (name, status) => ({ name, status, conclusion: status === "completed" ? "success" : null });

test("cancels the run when nothing else in it is running", { skip: !haveTools }, async () => {
  const r = await run({ jobs: [job("deploy / deploy", "completed"), job("deploy / superseded", "in_progress")] });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.cancelled, r.seen.join(", "));
});

test("does not cancel while another call of the run is still deploying", { skip: !haveTools }, async () => {
  const r = await run({ jobs: [job("deploy / deploy", "completed"), job("deploy / superseded", "in_progress"), job("ops / deploy", "in_progress")] });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.cancelled);
  assert.match(r.out, /ops \/ deploy is still running/);
});

test("does not cancel while another call is queued behind the deploy lane", { skip: !haveTools }, async () => {
  const r = await run({ jobs: [job("deploy / superseded", "in_progress"), job("ops / deploy", "queued")] });
  assert.ok(!r.cancelled);
});

test("another call's own superseded job does not hold the cancel back", { skip: !haveTools }, async () => {
  const r = await run({ jobs: [job("deploy / deploy", "completed"), job("deploy / superseded", "in_progress"), job("ops / deploy", "completed"), job("ops / superseded", "in_progress")] });
  assert.ok(r.cancelled);
});

test("a caller that never granted actions: write ends in success with a warning", { skip: !haveTools }, async () => {
  const refusedCancel = await run({ jobs: [job("deploy / superseded", "in_progress")], cancelStatus: 403 });
  assert.equal(refusedCancel.status, 0, refusedCancel.out);
  assert.match(refusedCancel.out, /::warning::Not allowed to cancel/);
  const refusedRead = await run({ jobs: [], jobsStatus: 403 });
  assert.equal(refusedRead.status, 0, refusedRead.out);
  assert.ok(!refusedRead.cancelled);
  assert.match(refusedRead.out, /::warning::Could not read this run's jobs/);
});

test("a run that is already ending is not an error", { skip: !haveTools }, async () => {
  const r = await run({ jobs: [job("deploy / superseded", "in_progress")], cancelStatus: 409 });
  assert.equal(r.status, 0, r.out);
});

test("a cancel that does not land is a warning, not a failure", { skip: !haveTools }, async () => {
  const r = await run({ jobs: [job("deploy / superseded", "in_progress")] });
  assert.equal(r.status, 0);
  assert.match(r.out, /still running after 0s/);
});

// The shape that makes it work, found by probing GitHub on 27 October 2026 (DOM-1422):
//  - a job-level `if` leaves the run a success, so the run has to be cancelled;
//  - a called workflow that asks for `actions: write` when its caller has not granted it does not start;
//  - a top-level `permissions:` becomes the default of a job with none, which then cannot cancel.
test("cloudflare-deploy.yml: the cancelling job inherits the caller's permissions, and nothing else widens", () => {
  assert.ok(!/^permissions:/m.test(WORKFLOW), "a top-level permissions block would stop the superseded job inheriting actions: write");
  assert.ok(!/actions:\s*write/.test(WORKFLOW.replace(/^\s*#.*$/gm, "")), "the called workflow must not ask for actions: write, or it fails to start for callers that have not granted it");
  const superseded = WORKFLOW.split(/^ {2}superseded:\s*$/m)[1];
  assert.ok(superseded, "no superseded job");
  assert.match(superseded, /^ {4}needs: deploy$/m);
  assert.match(superseded, /^ {4}if: needs\.deploy\.outputs\.deploy == 'false'$/m);
  assert.ok(!/^ {4}permissions:/m.test(superseded), "a permissions block on this job is its own ceiling");
  assert.match(superseded, /^ {4}# dd: inherit-permissions \S/m);
  assert.match(superseded, /uses: Doman-Digital\/dd-ci-standards\/\.github\/actions\/cancel-superseded@v1/);
  // It runs only on the skip: the deploy job must say whether it deployed.
  const deploy = WORKFLOW.split(/^ {2}deploy:\s*$/m)[1].split(/^ {2}superseded:\s*$/m)[0];
  assert.match(deploy, /^ {4}outputs:\n {6}deploy: \$\{\{ steps\.tip\.outputs\.deploy \}\}$/m);
  assert.match(deploy, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write$/m, "the deploy job, which holds the Cloudflare token, keeps exactly these two");
});
