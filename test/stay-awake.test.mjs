// CI-042 (DOM-17629): anything set to stay awake needs a dated reason on the same line or the line above.
// The case that started it: Meridian's keep-warm cron held an API container awake around the clock (DOM-17703).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDoctor } from "../lib/engine.mjs";
import { datedReason, AWAKE_CRON_MINUTES } from "../lib/rules.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", meta: null, budget: { ghCrons: [], vercelCrons: [] }, taxonomy };
const found = (view, ctx = base) => runDoctor({ workflows: [], vercel: [], files: {}, ...view }, rulebook, ctx).findings.filter((f) => f.rule === "CI-042");
const wf = (text, path = ".github/workflows/deploy.yml") => ({ workflows: [{ path, text }] });
const deploy = (envLines) => `on:\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: ./deploy.sh\n        env:\n${envLines}\n`;
const cron = (expr, comment = "") => `on:\n  schedule:\n    - cron: '${expr}'${comment}\njobs:\n  j:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n`;

test("a keep-warm switch set on with no reason is refused, as Meridian's deploy workflow was", () => {
  const f = found(wf(deploy('          KEEP_WARM: "1"')));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /keep-warm or keep-alive switch set on/);
  assert.match(f[0].message, /# YYYY-MM-DD <issue>: <why it must stay awake>/);
  assert.equal(f[0].level, "enforce", "from 1 December");
  assert.equal(found(wf(deploy('          KEEP_WARM: "1"')), { ...base, today: "2026-11-20" })[0].level, "warn", "a warning first");
  for (const on of ['KEEP_WARM: 1', "KEEP_WARM: '1'", "KEEP_ALIVE: true", "keep-warm: yes", "KEEP_WARM=1 ./deploy.sh"]) {
    assert.equal(found(wf(deploy(`          ${on}`))).length, 1, on);
  }
});

test("the switch is fine off, or with a dated reason on the same line or the line above", () => {
  for (const off of ['KEEP_WARM: "0"', "KEEP_WARM: false", "KEEP_ALIVE: 'no'", "KEEP_WARM: ${{ inputs.warm }}"]) assert.deepEqual(found(wf(deploy(`          ${off}`))), [], off);
  assert.deepEqual(found(wf(deploy('          KEEP_WARM: "1" # 2026-11-17 DOM-1: the sales demo must answer in under a second'))), []);
  assert.deepEqual(found(wf(deploy('          # 2026-11-17 DOM-1: the sales demo must answer in under a second\n          KEEP_WARM: "1"'))), []);
});

test("a date alone, a reason with no date, or a reason two lines up is not a dated reason", () => {
  assert.equal(found(wf(deploy('          KEEP_WARM: "1" # 2026-11-17'))).length, 1, "a date and no reason");
  assert.equal(found(wf(deploy('          KEEP_WARM: "1" # the demo must stay fast'))).length, 1, "a reason and no date");
  assert.equal(found(wf(deploy('          # 2026-11-17 DOM-1: the demo must stay fast\n          OTHER: x\n          KEEP_WARM: "1"'))).length, 1, "two lines up");
  assert.equal(found(wf(deploy('          # KEEP_WARM: "1"'))).length, 0, "a commented-out line is not a switch");
  const lines = ["a: 1 # 2026-11-17 because of the launch", "b: 2"];
  assert.equal(datedReason(lines, 0), true);
  assert.equal(datedReason(lines, 1), false, "a comment on a code line does not carry down");
});

test("a cron more often than every 30 minutes needs a reason; every 30 or less often does not", () => {
  const f = found(wf(cron("*/15 * * * *")));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /fires every 15 minutes, more often than every 30/);
  assert.equal(found(wf(cron("7,27,47 * * * *"))).length, 1, "every 20 minutes");
  assert.equal(AWAKE_CRON_MINUTES, 30);
  for (const ok of ["*/30 * * * *", "17 4 * * 1", "0 * * * *", "15,45 * * * *"]) assert.deepEqual(found(wf(cron(ok))), [], ok);
  assert.deepEqual(found(wf(cron("*/15 * * * *", "  # 2026-11-17 DOM-9: the queue must drain within a quarter of an hour"))), []);
});

test("a minimum instance count above zero needs a reason; zero does not", () => {
  const run = (flag) => `on:\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: gcloud run deploy api ${flag}\n`;
  assert.equal(found(wf(run("--min-instances=1"))).length, 1);
  assert.equal(found(wf(run("--min-instances 2"))).length, 1);
  assert.deepEqual(found(wf(run("--min-instances=0"))), []);
  const toml = (n, comment = "") => ({ wrangler: [{ path: "wrangler.toml", name: "api", text: `name = "api"\n[[containers]]\nmin_instances = ${n}${comment}\n`, crons: [] }] });
  assert.equal(found(toml(1)).length, 1);
  assert.deepEqual(found(toml(0)), []);
  assert.deepEqual(found(toml(1, " # 2026-11-17 DOM-3: a cold start breaks the payment webhook")), []);
});

test("a Wrangler cron is read only where the Worker fronts a container, with // comments for JSONC", () => {
  const jsonc = (body, comment = "") => ({ wrangler: [{ path: "wrangler.jsonc", name: "w", text: `{\n  "name": "w",\n${body}  "triggers": { "crons": ["*/5 * * * *"] }${comment}\n}\n` }] });
  const withContainer = '  "containers": [{ "class_name": "Api", "image": "./Dockerfile" }],\n';
  assert.equal(found(jsonc(withContainer)).length, 1, "a container with a cron every five minutes is the keep-warm ping");
  assert.deepEqual(found(jsonc("")), [], "a plain Worker poller is ordinary");
  assert.deepEqual(found({ wrangler: [{ path: "wrangler.jsonc", name: "w", text: `{\n  "containers": [{}],\n  // 2026-11-17 DOM-4: the poller must run every five minutes\n  "triggers": { "crons": ["*/5 * * * *"] }\n}\n` }] }), []);
  assert.deepEqual(found({ wrangler: [{ path: "wrangler.jsonc", name: "w", text: `{ "containers": [{}], "triggers": { "crons": ["0 3 * * *"] } }` }] }), []);
  const toml = `name = "w"\n[[containers]]\nclass_name = "Api"\n[triggers]\ncrons = ["*/15 * * * *"]\n`;
  assert.equal(found({ wrangler: [{ path: "wrangler.toml", name: "w", text: toml }] }).length, 1);
  assert.deepEqual(found({ wrangler: [{ path: "wrangler.jsonc", name: "w" }] }), [], "a view with no text (an older loader) is skipped, not an error");
});

test("a URL's double slash is not a comment, and a client's repo is read like any other", () => {
  const f = found(wf(deploy('          KEEP_WARM: "1"\n          URL: "https://example.com/x" # 2026-11-17 a note about the url here')));
  assert.equal(f.length, 1, "the reason belongs to the URL line, not to the switch");
  assert.equal(found(wf(deploy('          KEEP_WARM: "1"')), { ...base, meta: { owner: { login: "someclient" } } }).length, 1);
});
