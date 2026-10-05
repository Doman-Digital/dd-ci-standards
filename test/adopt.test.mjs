import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planAdopt, POLICY_CALLER } from "../lib/adopt.mjs";
import { runDoctor } from "../lib/engine.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const ctx = { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };

// A repo with debt: no timeout, a hosted runner, no policy caller, an old Renovate preset name.
const messy = {
  workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\nconcurrency:\n  group: g\n  cancel-in-progress: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n" }],
  vercel: [],
  files: { "renovate.json": '{ "extends": ["github>Doman-Digital/ci-standards//default.json#v1"] }' },
};

test("adopt writes the owned files and leaves nothing failing", () => {
  const { writes, before, after } = planAdopt(messy, rulebook, ctx);
  assert.ok(before.findings.some((f) => f.level === "enforce"), "the example should start with a failure");
  assert.equal(writes[".github/workflows/ci-standards-policy.yml"], POLICY_CALLER);
  assert.match(writes["renovate.json"], /dd-ci-standards/);
  assert.match(writes[".gitignore"], /^\.doppler-token$/m);
  assert.deepEqual(after.findings.filter((f) => f.level !== "report"), []);
});

test("the debt it cannot fix is dated, not hidden: exemptions expire in 60 days", () => {
  const { writes } = planAdopt(messy, rulebook, ctx);
  const dd = JSON.parse(writes[".github/dd.json"]);
  const rules = dd.exempt.map((e) => e.rule).sort();
  assert.deepEqual(rules, ["CI-001", "CI-003"]);
  assert.ok(dd.exempt.every((e) => e.until === "2027-03-16" && /Baseline at adoption/.test(e.reason)));
  // the day after they expire, the findings come back
  const adopted = {
    workflows: [...messy.workflows, { path: ".github/workflows/ci-standards-policy.yml", text: POLICY_CALLER }],
    vercel: [],
    files: { ...messy.files, "renovate.json": writes["renovate.json"], ".github/dd.json": writes[".github/dd.json"], ".gitignore": writes[".gitignore"] },
  };
  const later = runDoctor(adopted, rulebook, { ...ctx, today: "2027-03-17" });
  assert.ok(later.findings.some((f) => f.rule === "CI-003" && f.level === "enforce"));
});

test("adopt is idempotent: a second run changes nothing", () => {
  const { writes } = planAdopt(messy, rulebook, ctx);
  const adopted = {
    workflows: [...messy.workflows, { path: ".github/workflows/ci-standards-policy.yml", text: POLICY_CALLER }],
    vercel: [],
    files: { ...messy.files, "renovate.json": writes["renovate.json"], ".github/dd.json": writes[".github/dd.json"], ".gitignore": writes[".gitignore"] },
  };
  assert.deepEqual(planAdopt(adopted, rulebook, ctx).writes, {});
});
