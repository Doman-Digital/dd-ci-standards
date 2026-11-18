// CI-042 and CI-044 (DOM-17629). CI-042: a workflow cron more often than every 30 minutes needs a dated reason (warn first).
// CI-044, the founder's always-on ban of 17 November 2026: a keep-warm switch, a minimum instance count above zero, or a cron in
// front of a container is refused unless a founder approval is in the file and in the register, with no warn-first period.
// The case that started both: Meridian's keep-warm cron held an API container awake around the clock (DOM-17703).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor } from "../lib/engine.mjs";
import { datedReason, approvalAt, APPROVAL, AWAKE_CRON_MINUTES } from "../lib/rules.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", meta: null, budget: { ghCrons: [], vercelCrons: [] }, taxonomy };
const run = (view, ctx = base, id) => runDoctor({ workflows: [], vercel: [], files: {}, ...view }, rulebook, ctx).findings.filter((f) => f.rule === id);
const f42 = (view, ctx) => run(view, ctx, "CI-042");
const f44 = (view, ctx) => run(view, ctx, "CI-044");
const wf = (text, path = ".github/workflows/deploy.yml") => ({ workflows: [{ path, text }] });
const deploy = (envLines) => `on:\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: ./deploy.sh\n        env:\n${envLines}\n`;
const cron = (expr, comment = "") => `on:\n  schedule:\n    - cron: '${expr}'${comment}\njobs:\n  j:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n`;
const APPROVED = "# founder-approved 2026-11-18 cost GBP 45/month: the demo API must answer in under a second";
const REG = [{ repo: "Doman-Digital/demo", file: ".github/workflows/deploy.yml", date: "2026-11-18", cost_gbp_month: 45 }];

/* ---------- CI-042: workflow crons ---------- */

test("CI-042: a workflow cron more often than every 30 minutes needs a dated reason; every 30 or less often does not", () => {
  const f = f42(wf(cron("*/15 * * * *")));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /fires every 15 minutes, more often than every 30/);
  assert.equal(f[0].level, "enforce", "from 1 December");
  assert.equal(f42(wf(cron("*/15 * * * *")), { ...base, today: "2026-11-20" })[0].level, "warn", "a warning first");
  assert.equal(f42(wf(cron("7,27,47 * * * *"))).length, 1, "every 20 minutes");
  assert.equal(AWAKE_CRON_MINUTES, 30);
  for (const ok of ["*/30 * * * *", "17 4 * * 1", "0 * * * *", "15,45 * * * *"]) assert.deepEqual(f42(wf(cron(ok))), [], ok);
  assert.deepEqual(f42(wf(cron("*/15 * * * *", "  # 2026-11-17 DOM-9: the queue must drain within a quarter of an hour"))), []);
});

test("CI-042: a date alone, a reason with no date, or a reason two lines up is not a dated reason", () => {
  assert.equal(f42(wf(cron("*/15 * * * *", " # 2026-11-17"))).length, 1, "a date and no reason");
  assert.equal(f42(wf(cron("*/15 * * * *", " # the queue must drain quickly"))).length, 1, "a reason and no date");
  const lines = ["a: 1 # 2026-11-17 because of the launch", "b: 2"];
  assert.equal(datedReason(lines, 0), true);
  assert.equal(datedReason(lines, 1), false, "a comment on a code line does not carry down");
  const above = `on:\n  schedule:\n    # 2026-11-17 DOM-9: the queue must drain within a quarter of an hour\n    - cron: '*/15 * * * *'\njobs:\n  j:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n`;
  assert.deepEqual(f42(wf(above)), [], "the line above");
});

test("CI-042 leaves the container arms to CI-044, and a plain Worker cron alone", () => {
  assert.deepEqual(f42(wf(deploy('          KEEP_WARM: "1"'))), []);
  const plain = { wrangler: [{ path: "wrangler.jsonc", name: "w", text: `{ "triggers": { "crons": ["*/5 * * * *"] } }` }] };
  assert.deepEqual(f42(plain), []);
  assert.deepEqual(f44(plain), [], "a Worker with no container is out of scope of the ban");
});

/* ---------- CI-044: the always-on ban ---------- */

test("CI-044: a keep-warm switch set on with no approval is refused at once, naming the way through; the date is the day it was written", () => {
  const f = f44(wf(deploy('          KEEP_WARM: "1"')));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /keep-warm or keep-alive switch set on.*no founder approval/);
  assert.match(f[0].message, /# founder-approved YYYY-MM-DD cost GBP <amount>\/month: <reason>/);
  assert.match(f[0].message, /report it; do not turn anything off/);
  assert.equal(f[0].level, "enforce");
  assert.equal(f44(wf(deploy('          KEEP_WARM: "1"')), { ...base, today: "2026-11-18" })[0].level, "enforce", "enforced on the day it was written, no warn-first period");
  assert.deepEqual(f44(wf(deploy('          KEEP_WARM: "1"')), { ...base, today: "2026-11-17" }), [], "off before it exists");
  for (const on of ["KEEP_WARM: 1", "KEEP_WARM: '1'", "KEEP_ALIVE: true", "keep-warm: yes", "KEEP_WARM=1 ./deploy.sh"]) assert.equal(f44(wf(deploy(`          ${on}`))).length, 1, on);
});

test("CI-044: off, zero, an expression and a commented-out line are not read", () => {
  for (const off of ['KEEP_WARM: "0"', "KEEP_WARM: false", "KEEP_ALIVE: 'no'", "KEEP_WARM: ${{ inputs.warm }}", '# KEEP_WARM: "1"']) assert.deepEqual(f44(wf(deploy(`          ${off}`))), [], off);
});

test("CI-044: an approval line on the same line or the line above passes only when the register carries the same approval", () => {
  const above = wf(deploy(`          ${APPROVED}\n          KEEP_WARM: "1"`));
  const sameLine = wf(deploy(`          KEEP_WARM: "1" ${APPROVED}`));
  for (const v of [above, sameLine]) {
    assert.deepEqual(f44(v, { ...base, alwaysOn: REG }), []);
    const unregistered = f44(v);
    assert.equal(unregistered.length, 1, "in the file but not in the register");
    assert.match(unregistered[0].message, /founder approval of 2026-11-18 at GBP 45 a month, but dd-repo-registry costs\.yaml.*no matching row for demo/);
  }
  for (const wrong of [{ date: "2026-11-19" }, { cost_gbp_month: 90 }, { file: ".github/workflows/other.yml" }, { repo: "Doman-Digital/other" }]) {
    assert.equal(f44(above, { ...base, alwaysOn: [{ ...REG[0], ...wrong }] }).length, 1, `a register row that differs in ${Object.keys(wrong)}`);
  }
});

test("CI-044: the approval form is fixed: date, cost in pounds a month, a reason", () => {
  const ok = approvalAt([`# ${APPROVED.slice(2)}`], 0);
  assert.deepEqual(ok, { date: "2026-11-18", gbp: 45, reason: "the demo API must answer in under a second" });
  assert.equal(approvalAt(["# founder-approved 2026-11-18 cost GBP 45.50/month: a good reason here"], 0).gbp, 45.5);
  for (const bad of [
    "# founder-approved 2026-11-18 cost 45/month: a good reason here",
    "# founder-approved 2026-11-18 cost GBP 45: a good reason here",
    "# founder-approved cost GBP 45/month: a good reason here",
    "# founder-approved 2026-11-18 cost GBP 45/month: short",
    "# approved 2026-11-18 cost GBP 45/month: a good reason here",
    "# 2026-11-17 DOM-1: a dated reason is not an approval",
  ]) assert.equal(approvalAt([bad], 0), null, bad);
  assert.equal(approvalAt(["a: 1", "b: 2"], 1), null);
  assert.ok(APPROVAL.test("founder-approved 2026-11-18 cost GBP 45/month: a good reason here"));
});

test("CI-044: a minimum instance count above zero is refused; zero is not", () => {
  const run1 = (flag) => `on:\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: gcloud run deploy api ${flag}\n`;
  assert.equal(f44(wf(run1("--min-instances=1"))).length, 1);
  assert.equal(f44(wf(run1("--min-instances 2"))).length, 1);
  assert.deepEqual(f44(wf(run1("--min-instances=0"))), []);
  const toml = (n, comment = "") => ({ wrangler: [{ path: "wrangler.toml", name: "api", text: `name = "api"\n[[containers]]\nmin_instances = ${n}${comment}\n`, crons: [] }] });
  assert.equal(f44(toml(1)).length, 1);
  assert.deepEqual(f44(toml(0)), []);
  assert.deepEqual(f44(toml(1, " # founder-approved 2026-11-18 cost GBP 12/month: a cold start breaks the payment webhook"), { ...base, alwaysOn: [{ repo: "Doman-Digital/demo", file: "wrangler.toml", date: "2026-11-18", cost_gbp_month: 12 }] }), []);
});

test("CI-044: a Wrangler cron is read only where the Worker fronts a container, with // comments for JSONC", () => {
  const jsonc = (body, comment = "") => ({ wrangler: [{ path: "wrangler.jsonc", name: "w", text: `{\n  "name": "w",\n${body}  "triggers": { "crons": ["*/5 * * * *"] }${comment}\n}\n` }] });
  const withContainer = '  "containers": [{ "class_name": "Api", "image": "./Dockerfile" }],\n';
  const f = f44(jsonc(withContainer));
  assert.equal(f.length, 1, "a container with a cron every five minutes is the keep-warm ping");
  assert.match(f[0].message, /in front of a container fires every 5 minutes, which keeps it awake/);
  assert.deepEqual(f44(jsonc("")), [], "a plain Worker poller is ordinary");
  assert.deepEqual(f44({ wrangler: [{ path: "wrangler.jsonc", name: "w", text: `{ "containers": [{}], "triggers": { "crons": ["0 3 * * *"] } }` }] }), [], "a daily cron does not keep a container awake");
  const toml = `name = "w"\n[[containers]]\nclass_name = "Api"\n[triggers]\ncrons = ["*/15 * * * *"]\n`;
  assert.equal(f44({ wrangler: [{ path: "wrangler.toml", name: "w", text: toml }] }).length, 1);
  assert.deepEqual(f44({ wrangler: [{ path: "wrangler.jsonc", name: "w" }] }), [], "a view with no text (an older loader) is skipped, not an error");
});

test("CI-044 applies to every repo, a client's included, and always-on.json starts empty", () => {
  assert.equal(f44(wf(deploy('          KEEP_WARM: "1"')), { ...base, meta: { owner: { login: "someclient" } } }).length, 1);
  const projected = JSON.parse(readFileSync(new URL("../always-on.json", import.meta.url), "utf8"));
  assert.deepEqual(projected, { approvals: [] }, "no approval has been given; each one arrives with its costs.yaml row");
  const rule = rulebook.rules.find((r) => r.id === "CI-044");
  assert.equal(rule.warn_from, rule.enforce_from, "no warn-first period");
});

test("a URL's double slash is not a comment", () => {
  const f = f44(wf(deploy('          KEEP_WARM: "1"\n          URL: "https://example.com/x" # 2026-11-17 a note about the url here')));
  assert.equal(f.length, 1, "the note belongs to the URL line, not to the switch");
});
