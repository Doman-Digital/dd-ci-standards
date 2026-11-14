// The issue-ref job (DOM-17635): LIN-001 and LIN-002 in a cheap job of their own, reading the pull
// request live, so a fixed description needs a re-run of that job rather than a commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../lib/engine.mjs";
import { POLICY_RULESET } from "../lib/rules.mjs";
import { selectRules, issueRefElsewhere, livePullRequest } from "../lib/issue-ref.mjs";
import { branchRules } from "../lib/view-github.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const base = { selfHostedRetired: false, today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };
const empty = { workflows: [], vercel: [], files: {} };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const RULESET_RUN = `${POLICY_RULESET.repo}/${POLICY_RULESET.path}@refs/heads/main`;

test("selectRules keeps only the named rules, or drops them, and refuses an id that does not exist", () => {
  const only = selectRules(rulebook, { only: ["LIN-001", "LIN-002"] });
  assert.deepEqual(only.rulebook.rules.map((r) => r.id).sort(), ["LIN-001", "LIN-002"]);
  const skip = selectRules(rulebook, { skip: ["LIN-001"] });
  assert.equal(skip.rulebook.rules.length, rulebook.rules.length - 1);
  assert.match(selectRules(rulebook, { only: ["LIN-999"] }).error, /no such rule: LIN-999/);
});

test("the policy check's ruleset run hands LIN-001 and LIN-002 over only where a ruleset runs issue-ref.yml", () => {
  assert.equal(issueRefElsewhere({ orgIssueRef: true }, RULESET_RUN), true);
  assert.equal(issueRefElsewhere({ orgIssueRef: false }, RULESET_RUN), false, "no issue-ref ruleset: the policy check keeps them");
  assert.equal(issueRefElsewhere({ orgIssueRef: null }, RULESET_RUN), false, "rules unread: keeps them");
  assert.equal(issueRefElsewhere({ orgIssueRef: true }, "someclient/site/.github/workflows/ci-standards-policy.yml@refs/heads/main"), false, "a caller's run keeps them");
  assert.equal(issueRefElsewhere({ orgIssueRef: true }, undefined), false, "a local doctor keeps them");
});

test("LIN-001 read live tells the author to re-run the job; read from the event it still says push a commit", () => {
  const pr = { title: "Add the booking page", body: "", branch: "feat/booking", labels: [] };
  const msg = (p) => runDoctor(empty, rulebook, { ...base, pr: p }).findings.find((f) => f.rule === "LIN-001").message;
  assert.match(msg({ ...pr, live: true }), /re-run the failed issue-ref job/);
  assert.doesNotMatch(msg({ ...pr, live: true }), /allow-empty/);
  assert.match(msg(pr), /git commit --allow-empty/);
});

test("livePullRequest reads the API's shape into the rules' shape", () => {
  const got = livePullRequest({ number: 7, title: "T", body: null, head: { ref: "dom-1-x", sha: "h" }, base: { sha: "b" }, labels: [{ name: "no-issue" }] });
  assert.deepEqual(got, { title: "T", body: "", branch: "dom-1-x", labels: ["no-issue"], base: "b", head: "h", number: 7, live: true });
  const r = runDoctor(empty, rulebook, { ...base, pr: livePullRequest({ title: "Tidy", body: "", head: { ref: "tidy" }, labels: [{ name: "no-issue" }] }) });
  assert.ok(!r.findings.some((f) => f.rule === "LIN-001"), "a label added after the run began counts");
});

test("branchRules reports orgIssueRef from an active workflows rule running issue-ref.yml", async () => {
  const at = (workflows) => {
    const api = { "/repos/o/r/rules/branches/main": [{ type: "workflows", parameters: { workflows } }], "/repositories/7": { full_name: POLICY_RULESET.repo } };
    return async (p) => {
      if (!(p in api)) throw new Error("HTTP 404");
      return api[p];
    };
  };
  const both = await branchRules("o/r", "main", at([{ repository_id: 7, path: POLICY_RULESET.path }, { repository_id: 7, path: POLICY_RULESET.issueRefPath }]));
  assert.equal(both.orgPolicy, true);
  assert.equal(both.orgIssueRef, true);
  const policyOnly = await branchRules("o/r", "main", at([{ repository_id: 7, path: POLICY_RULESET.path }]));
  assert.equal(policyOnly.orgIssueRef, false);
});

test("issue-ref.yml: its own pull-requests read, the edit triggers, no checkout, only the two rules, read live", () => {
  const wf = read(".github/workflows/issue-ref.yml");
  assert.match(wf, /^permissions:\n  contents: read\n  pull-requests: read\n/m);
  assert.match(wf, /types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]/);
  assert.match(wf, /^  merge_group:$/m, "a merge queue's run starts it, and the job skips");
  assert.match(wf, /github\.event_name == 'pull_request'/);
  assert.match(wf, /timeout-minutes: 3\b/);
  assert.doesNotMatch(wf, /actions\/checkout/);
  assert.match(wf, /uses: Doman-Digital\/dd-ci-standards\/doctor@v1\n\s+with:\n\s+only: LIN-001,LIN-002\n\s+live-pr: "true"/);
  assert.equal(POLICY_RULESET.issueRefPath, ".github/workflows/issue-ref.yml");
});

test("policy.yml never asks for pull-requests: a caller grants contents: read only, and a called workflow cannot ask for more", () => {
  const top = /^permissions:\n((?:  .*\n)+)/m.exec(read(".github/workflows/policy.yml"))[1];
  assert.doesNotMatch(top, /pull-requests/);
});

test("dd doctor --only runs just those rules on an empty folder, and fails a pull request that names no issue", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-ref-"));
  const event = join(dir, "event.json");
  const run = (body) => {
    writeFileSync(event, JSON.stringify({ pull_request: { number: 1, title: "Tidy", body, head: { ref: "tidy", sha: "h" }, base: { sha: "b" }, labels: [] } }));
    const env = { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "", GH_TOKEN: "", GITHUB_TOKEN: "", DD_LIVE_PR: "true" };
    return spawnSync(process.execPath, [new URL("../bin/dd.mjs", import.meta.url).pathname, "doctor", dir, "--only", "LIN-001,LIN-002", "--kind", "dd-tooling", "--visibility", "private", "--today", "2027-01-15"], { encoding: "utf8", env, cwd: dir });
  };
  const bad = run("");
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /LIN-001/);
  const findings = bad.stdout.split("\n").filter((l) => /^(FAIL|warn|note) /.test(l));
  assert.deepEqual(findings.map((l) => l.split(/\s+/)[1]), ["LIN-001"], "nothing but the named rules");
  assert.match(bad.stdout, /only LIN-001, LIN-002 were checked/);
  const good = run("Part of DOM-123");
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const unknown = spawnSync(process.execPath, [new URL("../bin/dd.mjs", import.meta.url).pathname, "doctor", dir, "--only", "LIN-404"], { encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "" }, cwd: dir });
  assert.equal(unknown.status, 2);
});
