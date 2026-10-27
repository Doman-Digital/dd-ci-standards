import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor, levelOn, exemptionState } from "../lib/engine.mjs";
import { scheduleCrons, issueKeysOf } from "../lib/rules.mjs";
import { FIXTURES } from "./fixtures.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const TODAY = "2027-01-15"; // every rule past its enforce date
const base = { today: TODAY, kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };
const ids = (r) => r.findings.map((f) => f.rule);

test("every rule has a failing and a passing example", () => {
  const missing = rulebook.rules.map((r) => r.id).filter((id) => !FIXTURES[id]?.fail || !FIXTURES[id]?.pass);
  assert.deepEqual(missing, [], `rules with no fixture pair in test/fixtures.mjs: ${missing.join(", ")}`);
});

test("enforce_from is at most 90 days after warn_from, so nothing warns forever", () => {
  for (const r of rulebook.rules) {
    const days = (Date.parse(r.enforce_from) - Date.parse(r.warn_from)) / 864e5;
    assert.ok(days >= 0 && days <= 90, `${r.id}: ${days} days between warn_from and enforce_from`);
  }
});

for (const rule of rulebook.rules) {
  const fx = FIXTURES[rule.id];
  if (!fx) continue;
  test(`${rule.id} catches its failing example`, () => {
    const r = runDoctor(fx.fail, rulebook, { ...base, ...(fx.ctx || {}) });
    assert.ok(ids(r).includes(rule.id), `${rule.id} did not fire; got ${ids(r).join(", ") || "nothing"}`);
  });
  test(`${rule.id} passes its passing example`, () => {
    const r = runDoctor(fx.pass, rulebook, { ...base, ...(fx.ctx || {}), ...(fx.passCtx || {}) });
    assert.ok(!ids(r).includes(rule.id), `${rule.id} fired on the passing example: ${r.findings.filter((f) => f.rule === rule.id).map((f) => f.message).join(" | ")}`);
  });
}

test("a rule warns before its enforce date and fails after it", () => {
  const ci001 = rulebook.rules.find((r) => r.id === "CI-001");
  assert.equal(levelOn(ci001, "2026-10-02"), "off");
  assert.equal(levelOn(ci001, "2026-10-18"), "warn");
  assert.equal(levelOn(ci001, "2026-10-19"), "enforce");
});

test("an exemption with a date and a reason exempts; expired, undated or too long does not", () => {
  const today = "2026-11-01";
  assert.equal(exemptionState({ rule: "CI-005", reason: "backstop", until: "2027-01-31" }, today).state, "valid");
  assert.equal(exemptionState({ rule: "CI-005", reason: "backstop", until: "2026-10-31" }, today).state, "expired");
  assert.equal(exemptionState({ rule: "CI-005", reason: "", until: "2027-01-31" }, today).state, "invalid");
  assert.equal(exemptionState({ rule: "CI-005", reason: "x", until: "2027-06-01" }, today).state, "invalid");
  const r = runDoctor(FIXTURES["FW-002"].pass, rulebook, { ...base, today });
  assert.ok(!ids(r).includes("CI-005") && r.exempted.some((f) => f.rule === "CI-005"));
});

test("the legacy allow-double-run comment still exempts CI-005, and is reported as undated", () => {
  const v = { workflows: [{ path: ".github/workflows/scan.yml", text: "# ci-standards: allow-double-run backstop on main\non:\n  push:\n  pull_request:\njobs: {}\n" }], vercel: [], files: {} };
  const r = runDoctor(v, rulebook, base);
  assert.ok(!ids(r).includes("CI-005"));
  assert.ok(r.findings.some((f) => f.rule === "FW-002" && /legacy/.test(f.message)));
});

test("out-of-scope kinds are not checked; sales-demo gets the light profile", () => {
  const fail = FIXTURES["CI-005"].fail;
  assert.deepEqual(runDoctor(fail, rulebook, { ...base, kind: "it-portfolio" }).findings, []);
  assert.ok(!ids(runDoctor(fail, rulebook, { ...base, kind: "sales-demo" })).includes("CI-005"));
  assert.ok(ids(runDoctor(FIXTURES["CI-003"].fail, rulebook, { ...base, kind: "sales-demo" })).includes("CI-003"));
});

test("scheduleCrons reads every cron, past comments (the 2026-10-03 fix)", () => {
  const text = 'on:\n  schedule:\n    - cron: "0 3 * * *"\n    # and weekly\n    - cron: "0 6 * * 1"\n  push:\n';
  assert.deepEqual(scheduleCrons(text).map((c) => c.cron), ["0 3 * * *", "0 6 * * 1"]);
});

test("REG-004 says nothing when the token cannot read the merge settings", () => {
  const unread = { ...base, meta: { full_name: "Doman-Digital/demo" } };
  assert.ok(!ids(runDoctor(FIXTURES["REG-004"].fail, rulebook, unread)).includes("REG-004"));
  assert.ok(!ids(runDoctor(FIXTURES["REG-004"].fail, rulebook, base)).includes("REG-004"), "no settings read at all");
  const both = runDoctor(FIXTURES["REG-004"].fail, rulebook, { ...base, meta: { full_name: "x/y", allow_auto_merge: false, delete_branch_on_merge: false } });
  assert.match(both.findings.find((f) => f.rule === "REG-004").message, /^auto-merge and delete branch on merge are off/);
});

test("REG-004 does not require auto-merge on a private personal-account repo, but still wants delete-on-merge", () => {
  const fail = FIXTURES["REG-004"].fail;
  const m = (over) => ({ ...base, meta: { full_name: "sensphere/x", private: true, owner: { type: "User" }, allow_auto_merge: false, delete_branch_on_merge: true, ...over } });
  assert.ok(!ids(runDoctor(fail, rulebook, m({}))).includes("REG-004"));
  assert.match(runDoctor(fail, rulebook, m({ delete_branch_on_merge: false })).findings.find((f) => f.rule === "REG-004").message, /^delete branch on merge is off/);
  assert.ok(ids(runDoctor(fail, rulebook, m({ owner: { type: "Organization" } }))).includes("REG-004"), "org repos still need it");
  assert.ok(ids(runDoctor(fail, rulebook, m({ private: false }))).includes("REG-004"), "public repos still need it");
});

test("LIN-001 reads Closes, Part of and the branch, exempts dependency bots and the no-issue label, and is silent outside a pull request", () => {
  const run = (pr) => ids(runDoctor(FIXTURES["LIN-001"].fail, rulebook, { ...base, pr })).includes("LIN-001");
  assert.equal(run({ title: "Fix the form", body: "Closes DOM-12", branch: "x" }), false);
  assert.equal(run({ title: "Part of DOM-1363: the check", body: "", branch: "x" }), false, "the title counts");
  assert.equal(run({ title: "Fix the form", body: "", branch: "dom-1100-fix-form" }), false, "Linear's branch names are lower case");
  assert.equal(run({ title: "Fix the form", body: "Part of CRO-7", branch: "x" }), false);
  assert.equal(run({ title: "Update dependency sharp", body: "", branch: "renovate/npm-sharp" }), false);
  assert.equal(run({ title: "Bump x", body: "", branch: "dependabot/npm_and_yarn/x" }), false);
  assert.equal(run({ title: "Tidy", body: "", branch: "tidy", labels: ["No-Issue"] }), false, "the label, whatever its case");
  assert.equal(run({ title: "Tidy", body: "", branch: "tidy", labels: ["dependencies"] }), true, "another label does not count");
  assert.equal(run({ title: "Mention ADOM-12 or DOM-", body: "", branch: "x" }), true, "only a whole key counts");
  assert.equal(run({ title: "Fix the form (DOM-12)", body: "see DOM-12", branch: "x" }), true, "a key in passing is not a Closes or Part of line: the relay ignores it");
  assert.equal(run({ title: "Closes ABC-12", body: "Part of #12", branch: "x" }), true);
  assert.equal(run({ title: "x", body: null, branch: "x" }), true);
  assert.equal(run(undefined), false, "no pull request: not checked");
});

// Cases from dd-relay's own issueKeys tests (src/github-webhook/webhook.test.ts): what the relay
// counts as naming an issue, LIN-001 counts too.
test("issueKeysOf reads keys the way dd-relay does", () => {
  const named = (title, body, branch) => issueKeysOf({ title, body, branch }).named.sort();
  assert.deepEqual(named("t", "Closes DOM-1054\n\nPart of cro-12. Fixed: DOM-7 too.", "dom-1060-x"), ["CRO-12", "DOM-1054", "DOM-1060", "DOM-7"]);
  assert.deepEqual(named("x", "Part of DOM-5. closes DOM-5", "dom-5-thing"), ["DOM-5"]);
  assert.deepEqual(named("x", "", "dom-1054-foo"), ["DOM-1054"]);
  assert.deepEqual(named("x", "", "feature/random"), []);
  assert.deepEqual(named("x", "discloses DOM-9, prefix DOM-10", "main"), []);
  assert.deepEqual(named("x", "", "worktree/dom-77.fix"), ["DOM-77"]);
});

// 26 October 2026: dd-claude-kit#178 quoted another PR's closing line and Linear closed DOM-1014.
test("LIN-002 flags a closing word in a quote beside a key the pull request does not own", () => {
  const foreign = (body, branch = "dom-1363-x", title = "x") => issueKeysOf({ title, body, branch }).foreign;
  for (const body of [
    "Part of DOM-1363\n\nThe other PR said `Closes DOM-1014`.",
    "Part of DOM-1363\n\n> Closes DOM-1014",
    'Part of DOM-1363\n\nIt wrote "Closes DOM-1014" in its body.',
    "Part of DOM-1363\n\n```\nCloses DOM-1014\n```",
    "Part of DOM-1363\n\nIt wrote “Fixes DOM-1014” in its body.",
    "Part of DOM-1363\n\nIt is `closing DOM-1014` in a quote.",
  ]) assert.deepEqual(foreign(body), ["DOM-1014"], body);
  assert.deepEqual(foreign("Closes DOM-5\nCloses DOM-6\nSee `Closes DOM-5`", ""), [], "its own key, quoted");
  assert.deepEqual(foreign("see `Closes DOM-5`", "dom-5-x"), [], "the branch's key");
  assert.deepEqual(foreign("The word `closes` and then DOM-1014 outside the quote"), []);
  assert.deepEqual(foreign("Part of DOM-1363 names DOM-1014"), [], "names is the safe word");
  assert.deepEqual(foreign("see `Closes DOM-1014`", "tidy"), ["DOM-1014"], "a quoted key is all it names: LIN-001 passes, LIN-002 warns");
  assert.deepEqual(issueKeysOf({ title: "x", body: "see `Closes DOM-1014`", branch: "tidy" }).named, ["DOM-1014"]);
  const run = (pr, today) => runDoctor(FIXTURES["LIN-002"].fail, rulebook, { ...base, today, pr }).findings.filter((f) => f.rule === "LIN-002");
  const pr = { title: "x", body: "Part of DOM-1363\n`Closes DOM-1014`", branch: "tidy" };
  assert.equal(run(pr, "2026-10-27")[0].level, "warn");
  assert.equal(run(pr, "2026-10-26").length, 0, "off before its warn date");
  assert.equal(run({ ...pr, branch: "renovate/x" }, "2026-10-27").length, 0, "bots are exempt");
});

test("CI-001 checks only repos the organisation owns, since only they can use its runners", () => {
  const fail = FIXTURES["CI-001"].fail;
  const owned = (login) => ({ ...base, meta: { owner: { login } } });
  assert.ok(ids(runDoctor(fail, rulebook, owned("Doman-Digital"))).includes("CI-001"));
  assert.ok(ids(runDoctor(fail, rulebook, base)).includes("CI-001"), "owner unknown: still checked");
  assert.ok(!ids(runDoctor(fail, rulebook, owned("sensphere"))).includes("CI-001"), "client account: nowhere else to run");
  assert.ok(!ids(runDoctor(fail, rulebook, { ...owned("dmitridoman"), kind: "dd-site" })).includes("CI-001"), "personal account");
});

test("SEC-007 catches the shapes in the estate and leaves non-deploys alone", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/deploy-astro.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "SEC-007");
  // RMP: the token set in the workflow env, the deploy further down.
  assert.deepEqual(run("env:\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\njobs:\n  deploy:\n    steps:\n      - run: pnpm exec wrangler deploy\n"), ["SEC-007"]);
  // The wrangler action takes it as an input.
  assert.deepEqual(run("jobs:\n  deploy:\n    steps:\n      - uses: cloudflare/wrangler-action@0000000000000000000000000000000000000000\n        with:\n          apiToken: ${{ secrets.CF_TOKEN }}\n"), ["SEC-007"]);
  // A dry run does not need the token, so a secret passed to it is still flagged.
  assert.deepEqual(run("jobs:\n  check:\n    steps:\n      - run: npx wrangler deploy --dry-run\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n"), ["SEC-007"]);
  // Doppler run with the token from Doppler: no Cloudflare secret in GitHub.
  assert.deepEqual(run("jobs:\n  deploy:\n    steps:\n      - run: doppler run -- pnpm exec wrangler deploy\n        env:\n          DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}\n"), []);
  // A token secret in a workflow that never deploys to Cloudflare.
  assert.deepEqual(run("jobs:\n  dns:\n    steps:\n      - run: node scripts/dns.mjs\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n"), []);
});

test("CI-012 looks only at runs a push to main starts, and lets a per-run group cancel", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/ci.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "CI-012");
  const conc = (group, cancel) => `concurrency:\n  group: ${group}\n  cancel-in-progress: ${cancel}\njobs: {}\n`;
  assert.deepEqual(run("on:\n  pull_request:\n" + conc("ci-${{ github.ref }}", "true")), [], "pull requests only");
  assert.deepEqual(run("on:\n  push:\n    tags: ['v*']\n" + conc("rel", "true")), [], "tags only");
  assert.deepEqual(run("on:\n  push:\n    branches: [develop]\n" + conc("ci", "true")), [], "not main");
  assert.deepEqual(run("on:\n  push:\n" + conc("ci-${{ github.head_ref || github.run_id }}", "true")), [], "a group per run never cancels another");
  assert.deepEqual(run("on: [push, pull_request]\n" + conc("ci-${{ github.ref }}", "true")), ["CI-012"], "list form, no branch filter");
  assert.deepEqual(run("on:\n  push:\n    branches:\n      - main\njobs:\n  test:\n    concurrency:\n      group: t-${{ github.ref }}\n      cancel-in-progress: true\n"), ["CI-012"], "job-level group");
});

test("CI-014 wants the tip guard on push deploys too, and the tested commit after workflow_run", () => {
  const run = (text) => runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base).findings.filter((f) => f.rule === "CI-014");
  const push = "on:\n  push:\n    branches: [main]\nconcurrency:\n  group: d\n  cancel-in-progress: false\njobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n";
  assert.equal(run(push).length, 1);
  assert.match(run(push)[0].message, /tip of main/);
  const wr = "on:\n  workflow_run:\n    workflows: [CI]\njobs:\n  d:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npx wrangler deploy\n";
  assert.equal(run(wr).length, 2, "untested commit and no guard");
  // A manual run deploys the branch it is started on: limited to main, it is fine; unguarded, any branch ships.
  assert.equal(run("on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  d:\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - run: npx wrangler deploy\n").length, 0);
  assert.match(run("on:\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - run: npx wrangler deploy\n")[0].message, /any branch/);
  // The CI run a deploy follows must exist for every push to main.
  const deployAfterCi = { path: ".github/workflows/deploy.yml", text: "on:\n  workflow_run:\n    workflows:\n      - CI\n    types: [completed]\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n" };
  const ci = (push) => ({ path: ".github/workflows/ci.yml", text: `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\n${push}jobs: {}\n` });
  const both = (push) => runDoctor({ workflows: [deployAfterCi, ci(push)], vercel: [], files: {} }, rulebook, base).findings.filter((f) => f.rule === "CI-014");
  assert.deepEqual(both("    paths: ['src/**']\n").map((f) => f.file), [".github/workflows/ci.yml"]);
  assert.equal(both("").length, 0);
  // The shared deploy workflow has the guard inside it, so a caller has nothing to flag.
  assert.equal(run("on:\n  workflow_run:\n    workflows: [CI]\n  workflow_dispatch:\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n").length, 0);
  // A commented-out deploy is not a deploy.
  assert.equal(run("on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      # - run: npx wrangler deploy\n      - run: echo\n").length, 0);
});

test("deploys.json lists each Worker once per account, with a known path", () => {
  const reg = JSON.parse(readFileSync(new URL("../deploys.json", import.meta.url), "utf8"));
  const paths = new Set(["actions", "workers-builds", "manual", "retired", "not-deployed"]);
  const seen = new Set();
  for (const w of reg.workers) {
    assert.ok(w.worker && typeof w.repo === "string", `entry without a worker or repo: ${JSON.stringify(w)}`);
    assert.ok(paths.has(w.path), `${w.worker}: unknown path ${w.path}`);
    if (w.target) assert.ok(paths.has(w.target) && w.path === "manual", `${w.worker}: target is only for manual Workers`);
    if (w.workflow) assert.ok(/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(w.workflow), `${w.worker}: workflow must be a .github/workflows/ path`);
    const key = `${w.account}/${w.worker}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
  }
});

test("tokens.json records names and scopes, never a value", () => {
  const text = readFileSync(new URL("../tokens.json", import.meta.url), "utf8");
  const reg = JSON.parse(text);
  for (const tk of reg.tokens) assert.ok(tk.name && tk.observed_scope && tk.verdict, `incomplete entry: ${tk.name}`);
  // A Cloudflare API token is 40 URL-safe characters; nothing that long may appear.
  assert.ok(!/[A-Za-z0-9_-]{40}/.test(text), "tokens.json holds something shaped like a token value");
});

test("CF-001 ignores registry entries with no repo", () => {
  const ctx = { repo: "Doman-Digital/demo", deploys: { workers: [{ worker: "orphan", repo: "", path: "retired" }, { worker: "demo-site", repo: "Doman-Digital/demo", path: "manual" }] } };
  const r = runDoctor({ workflows: [], vercel: [], files: {}, wrangler: [{ path: "wrangler.jsonc", name: "demo-site" }] }, rulebook, { ...base, ...ctx });
  assert.ok(!ids(r).includes("CF-001"));
});

test("FW-002 reports an exemption that exempts nothing, and one for a rule that does not exist", () => {
  const text = "on:\n  pull_request:\n# dd: allow CI-005 until=2027-03-01 backstop\n# dd: allow CI-099 until=2027-03-01 typo\njobs: {}\n";
  const r = runDoctor({ workflows: [{ path: ".github/workflows/ci.yml", text }], vercel: [], files: {} }, rulebook, base);
  const fw = r.findings.filter((f) => f.rule === "FW-002").map((f) => f.message);
  assert.ok(fw.some((m) => /CI-005 exempts nothing/.test(m)), fw.join(" | "));
  assert.ok(fw.some((m) => /CI-099, which is not a rule/.test(m)), fw.join(" | "));
  // One that still exempts a finding is not reported as stale.
  const live = runDoctor(FIXTURES["FW-002"].pass, rulebook, base);
  assert.ok(!live.findings.some((f) => f.rule === "FW-002" && /exempts nothing/.test(f.message)));
});

test("FW-002 does not call an exemption stale when its check could not run", () => {
  const v = { workflows: [], vercel: [], files: { ".github/dd.json": JSON.stringify({ exempt: [{ rule: "REG-004", until: "2027-03-01", reason: "settings owned by the client" }] }) } };
  const r = runDoctor(v, rulebook, { ...base, meta: null });
  assert.ok(!r.findings.some((f) => f.rule === "FW-002" && /exempts nothing/.test(f.message)));
});

test("CI-005 accepts push and pull_request on a CI that a workflow_run deploy waits for", () => {
  const ci = { path: ".github/workflows/ci.yml", text: "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs: {}\n" };
  const deploy = { path: ".github/workflows/deploy.yml", text: "on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n" };
  assert.ok(!ids(runDoctor({ workflows: [ci, deploy], vercel: [], files: {} }, rulebook, base)).includes("CI-005"));
  assert.ok(ids(runDoctor({ workflows: [ci], vercel: [], files: {} }, rulebook, base)).includes("CI-005"));
});

test("CF-001 accepts an Actions deploy that runs wrangler inside a script, when deploys.json names its workflow", () => {
  const deploys = { workers: [{ worker: "demo-site", repo: "Doman-Digital/demo", path: "actions", workflow: ".github/workflows/deploy-sites.yml" }] };
  const wf = { path: ".github/workflows/deploy-sites.yml", text: "on:\n  workflow_dispatch:\njobs:\n  deploy:\n    steps:\n      - run: node tools/deploy.mjs\n" };
  const v = (workflows) => ({ workflows, vercel: [], files: {}, wrangler: [{ path: "wrangler.jsonc", name: "demo-site" }] });
  assert.ok(!ids(runDoctor(v([wf]), rulebook, { ...base, repo: "Doman-Digital/demo", deploys })).includes("CF-001"));
  assert.ok(ids(runDoctor(v([]), rulebook, { ...base, repo: "Doman-Digital/demo", deploys })).includes("CF-001"));
});

test("an OpenNext deploy counts as a production deploy (CI-013, SEC-007)", () => {
  const text = "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: pnpm exec opennextjs-cloudflare deploy\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n";
  const r = runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base);
  assert.ok(ids(r).includes("CI-013") && ids(r).includes("SEC-007"), ids(r).join(", "));
});

test("CI-017 leaves a job alone when its if: keeps it off pull requests", () => {
  assert.ok(!ids(runDoctor(FIXTURES["CI-017"].passAlso, rulebook, base)).includes("CI-017"));
});

test("CI-021 reports only the reusable post-deploy job, not comments or composite steps", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "CI-021");
  assert.deepEqual(run("jobs:\n  checks:\n    uses: ./.github/workflows/post-deploy-checks.yml\n"), ["CI-021"]);
  assert.deepEqual(run("jobs:\n  deploy:\n    steps:\n      # uses: Doman-Digital/dd-ci-standards/.github/workflows/post-deploy-checks.yml@v1\n      - uses: Doman-Digital/dd-ci-standards/.github/actions/post-deploy-checks@v1\n"), []);
});

test("SEC-008 requires workflow-level permissions, accepting empty and block maps", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/ci.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "SEC-008");
  assert.deepEqual(run("# permissions: {}\njobs:\n  check:\n    permissions:\n      contents: read\n"), ["SEC-008"]);
  assert.deepEqual(run("permissions: {}\njobs: {}\n"), []);
  assert.deepEqual(run("permissions:\n  contents: read\njobs: {}\n"), []);
});

test("SEC-008 lets a reusable workflow inherit its caller's permissions only where each job says so", () => {
  const run = (text) => ids(runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base)).filter((id) => id === "SEC-008");
  const head = "on:\n  workflow_call:\njobs:\n";
  const explicit = "  deploy:\n    permissions:\n      contents: read\n    steps:\n      - run: x\n";
  const marked = "  superseded:\n    # dd: inherit-permissions the caller's actions: write is all it needs\n    steps:\n      - run: x\n";
  const bare = "  superseded:\n    steps:\n      - run: x\n";
  assert.deepEqual(run(head + explicit + marked), []);
  assert.deepEqual(run(head + explicit + bare), ["SEC-008"]);
  assert.deepEqual(run(head + "  superseded:\n    # dd: inherit-permissions\n    steps:\n      - run: x\n"), ["SEC-008"], "a marker with no reason does not count");
  // Only a reusable workflow may: the same jobs in a workflow a push starts still need the block.
  assert.deepEqual(run("on:\n  push:\njobs:\n" + explicit + marked), ["SEC-008"]);
});

test("CI-030 reads the permissions of the job that calls the shared deploy, or the workflow's when the job has none", () => {
  const call = (perms, top = "permissions:\n  contents: read\n") => `on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n${top}jobs:\n  deploy:\n${perms}    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n    with:\n      doppler-config: relay\n`;
  const run = (text) => runDoctor({ workflows: [{ path: ".github/workflows/deploy.yml", text }], vercel: [], files: {} }, rulebook, base).findings.filter((f) => f.rule === "CI-030");
  assert.equal(run(call("    permissions:\n      contents: read\n      id-token: write\n")).length, 1);
  assert.equal(run(call("    permissions:\n      contents: read\n      id-token: write\n      actions: write\n")).length, 0);
  assert.equal(run(call("    permissions:\n      actions: read\n      id-token: write\n")).length, 1, "actions: read cannot cancel");
  assert.equal(run(call("", "permissions:\n  contents: read\n  actions: write\n")).length, 0, "no job block: the workflow's applies");
  assert.equal(run(call("", "permissions:\n  contents: read\n")).length, 1);
  assert.equal(run(call("    permissions: write-all\n")).length, 0);
  // The shared workflow itself is not a caller.
  assert.equal(run("on:\n  workflow_call:\njobs:\n  deploy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/cloudflare-deploy.yml@v1\n").length, 0);
});

test("CI-022 puts a job on a pool from its own timeout, and names the expression to use", () => {
  const job = (runsOn, extra = "    timeout-minutes: 5\n") => ({ workflows: [{ path: ".github/workflows/ci.yml", text: `on:\n  pull_request:\njobs:\n  a:\n    runs-on: ${runsOn}\n${extra}    steps:\n      - run: x\n        timeout-minutes: 1\n` }], vercel: [], files: {} });
  const ci022 = (v, over = {}) => runDoctor(v, rulebook, { ...base, ...over }).findings.filter((f) => f.rule === "CI-022");
  const LIGHT = "${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}";
  const STANDARD = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
  // 5 minutes or less: light, from any pool the organisation runs, hosted or self-hosted.
  for (const from of [STANDARD, "ubuntu-latest", "dd-ci-ephemeral", "dd-ci-light", "${{ vars.CI_RUNNER_LIGHT || 'ubuntu-latest' }}"]) {
    const f = ci022(job(from));
    assert.equal(f.length, 1, from);
    assert.equal(f[0].runsOn, LIGHT);
  }
  // Quote style and spacing do not matter.
  assert.equal(ci022(job('${{vars.CI_RUNNER_LIGHT||vars.CI_RUNNER||"ubuntu-latest"}}')).length, 0);
  // A step's timeout is not the job's: no job timeout, or one from an expression, is standard.
  for (const extra of ["", "    timeout-minutes: ${{ github.ref_name == 'main' && 45 || 15 }}\n", "    timeout-minutes: 6\n"]) {
    assert.equal(ci022(job(STANDARD, extra)).length, 0);
    const f = ci022(job(LIGHT, extra));
    assert.equal(f.length, 1);
    assert.equal(f[0].runsOn, STANDARD);
  }
  // An expression the rulebook did not write is left alone.
  assert.equal(ci022(job("${{ matrix.os }}")).length, 0);
  // Not the organisation's runners: another owner's repo, or a reusable workflow's jobs.
  assert.equal(ci022(job(STANDARD), { meta: { owner: { login: "Tardi-Group" } } }).length, 0);
  const reusable = job(STANDARD);
  reusable.workflows[0].text = reusable.workflows[0].text.replace("  pull_request:", "  workflow_call:");
  assert.equal(ci022(reusable).length, 0);
});

test("a public repo stays off the light runners: CI-002 catches the light expression, CI-022 does not ask for it", () => {
  const v = { workflows: [{ path: ".github/workflows/ci.yml", text: "on:\n  pull_request:\njobs:\n  a:\n    runs-on: ${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}\n    timeout-minutes: 2\n    steps:\n      - run: x\n" }], vercel: [], files: {} };
  const pub = ids(runDoctor(v, rulebook, { ...base, visibility: "public" }));
  assert.ok(pub.includes("CI-002"));
  assert.ok(!pub.includes("CI-022"));
  const hosted = { ...v, workflows: [{ ...v.workflows[0], text: v.workflows[0].text.replace(/runs-on: .*/, "runs-on: dd-ci-light") }] };
  assert.ok(ids(runDoctor(hosted, rulebook, { ...base, visibility: "public" })).includes("CI-002"));
  // and in a private repo the light expression satisfies CI-001 as well
  const priv = ids(runDoctor(v, rulebook, base));
  assert.ok(!priv.includes("CI-001") && !priv.includes("CI-022"));
});

test("CI-002 skips a job that never runs in this repo: policy.yml on its own pull requests (DOM-1084)", () => {
  const text = (cond) => `on:\n  workflow_call:\n  pull_request:\njobs:\n  check:\n${cond}    runs-on: \${{ vars.CI_RUNNER_LIGHT || inputs.runner }}\n    timeout-minutes: 2\n    steps:\n      - run: x\n`;
  const run = (cond, repoName = "dd-ci-standards") =>
    ids(runDoctor({ workflows: [{ path: ".github/workflows/policy.yml", text: text(cond) }], vercel: [], files: {} }, rulebook, { ...base, visibility: "public", repoName }));
  assert.ok(run("").includes("CI-002"));
  assert.ok(!run("    if: ${{ github.repository != 'Doman-Digital/dd-ci-standards' }}\n").includes("CI-002"));
  assert.ok(!run("    if: ${{ false }}\n").includes("CI-002"));
  // another repo's name, or an escape hatch in the condition, still runs here
  assert.ok(run("    if: ${{ github.repository != 'Doman-Digital/other' }}\n").includes("CI-002"));
  assert.ok(run("    if: ${{ github.repository != 'Doman-Digital/dd-ci-standards' || github.event_name == 'push' }}\n").includes("CI-002"));
});

test("CI-005 leaves the policy caller's push-to-main scan alone", () => {
  const v = { workflows: [{ path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\n  push:\n    branches: [main]\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" }], vercel: [], files: {} };
  const r = runDoctor(v, rulebook, base);
  assert.ok(!ids(r).includes("CI-005") && !ids(r).includes("CI-012") && !ids(r).includes("CI-004"), ids(r).join(", "));
});

test("FW-004 names the branch and leaves major tags, releases and SHAs alone", () => {
  const r = runDoctor(FIXTURES["FW-004"].fail, rulebook, base);
  assert.match(r.findings.find((f) => f.rule === "FW-004").message, /policy\.yml@dom-776-ci-deploy-standards/);
});

test("CI-023, CI-024 and FW-004 read the repo's composite actions too", () => {
  const v = { workflows: [], actions: [{ path: ".github/actions/handoff/action.yml", text: "runs:\n  using: composite\n  steps:\n    - if: runner.name == 'dd-ci-01-b'\n      run: echo $VERCEL_TOKEN\n    - uses: Doman-Digital/dd-photo-pack/grade@main\n" }], vercel: [], files: {} };
  const found = ids(runDoctor(v, rulebook, base));
  for (const id of ["CI-023", "CI-024", "FW-004"]) assert.ok(found.includes(id), id);
});

test("CI-015 lets the estate sweep, the one central scanner, run gitleaks", () => {
  const v = FIXTURES["CI-015"].fail;
  assert.ok(ids(runDoctor(v, rulebook, base)).includes("CI-015"));
  assert.ok(!ids(runDoctor(v, rulebook, { ...base, repo: "Doman-Digital/dd-repo-registry" })).includes("CI-015"));
});

test("CI-015 reads a scan being run, not a gitleaks binary being fetched for a hook test (DOM-1264)", () => {
  const caller = { path: ".github/workflows/ci-standards-policy.yml", text: "on:\n  pull_request:\njobs:\n  policy:\n    uses: Doman-Digital/dd-ci-standards/.github/workflows/policy.yml@v1\n" };
  const run = (step) => ids(runDoctor({ workflows: [caller, { path: ".github/workflows/x.yml", text: `on:\n  pull_request:\njobs:\n  j:\n    steps:\n      - run: ${step}\n` }], vercel: [], files: {} }, rulebook, base));
  for (const scan of ["gitleaks detect --source .", "gitleaks git -v", "gitleaks --verbose dir .", "semgrep --config auto"]) {
    assert.ok(run(scan).includes("CI-015"), scan);
  }
  assert.ok(!run("tar xzf gitleaks.tar.gz gitleaks").includes("CI-015"));
  assert.ok(!run("curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8/gitleaks_8_linux_x64.tar.gz -o g.tgz").includes("CI-015"));
});

test("REG-008 needs a merge queue: without one, or when the rules could not be read, it is not judged", () => {
  const fail = FIXTURES["REG-008"].fail;
  assert.ok(ids(runDoctor(fail, rulebook, base)).includes("REG-008"));
  assert.ok(!ids(runDoctor({ ...fail, mergeQueue: false }, rulebook, base)).includes("REG-008"));
  assert.ok(!ids(runDoctor({ ...fail, mergeQueue: null, required: null }, rulebook, base)).includes("REG-008"));
  // The caller already runs on merge_group, so only ci.yml is named.
  const found = runDoctor(fail, rulebook, base).findings.filter((f) => f.rule === "REG-008");
  assert.deepEqual(found.map((f) => f.file), [".github/workflows/ci.yml"]);
});

test("REG-007 and REG-008 read a job name chosen by an expression (dd-claude-kit's Git hook fixtures)", () => {
  const text = "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  hook-tests:\n    name: ${{ github.event_name == 'push' && 'Git hook fixtures on main' || 'Git hook fixtures' }}\n    steps:\n      - run: x\n";
  const v = { workflows: [{ path: ".github/workflows/git-hooks.yml", text }], vercel: [], files: {}, required: ["Git hook fixtures"], mergeQueue: true };
  const found = ids(runDoctor(v, rulebook, base));
  assert.ok(!found.includes("REG-007"));
  assert.ok(found.includes("REG-008"));
});

test("REG-007 is not judged when the rules could not be read", () => {
  const v = { ...FIXTURES["REG-007"].fail, required: null };
  assert.ok(!ids(runDoctor(v, rulebook, base)).includes("REG-007"));
});

test("CI-028 reports a registered job that left CI_RUNNER_HOSTED, and a registered job with its own runs-on", () => {
  const ctx = { today: "2026-11-25", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, hostedJobs: { jobs: [{ repo: "demo", workflow: "ci.yml", job: "test" }] } };
  const own = runDoctor(FIXTURES["CI-001"].pass, rulebook, ctx);
  assert.ok(own.findings.some((f) => f.rule === "CI-028" && /does not run on CI_RUNNER_HOSTED/.test(f.message)));
  const bare = runDoctor({ workflows: [{ path: ".github/workflows/ci.yml", text: FIXTURES["CI-028"].pass.workflows[0].text.replace(/runs-on: .*/, "runs-on: ${{ vars.CI_RUNNER_HOSTED }}") }], vercel: [], files: {} }, rulebook, ctx);
  assert.ok(bare.findings.some((f) => f.rule === "CI-028" && /valve can send it back/.test(f.message)));
});

test("CI-029 puts a deploy job on the deploy slot, and CI-022 leaves it alone", () => {
  const wfOf = (on, key, runsOn, timeout = 3) => ({ workflows: [{ path: ".github/workflows/deploy.yml", text: `on:\n  ${on}:\njobs:\n  ${key}:\n    runs-on: ${runsOn}\n    timeout-minutes: ${timeout}\n    steps:\n      - run: x\n` }], vercel: [], files: {} });
  const rules = (v, over = {}) => runDoctor(v, rulebook, { ...base, ...over }).findings.map((f) => f.rule);
  const STANDARD = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
  const DEPLOY = "${{ vars.CI_RUNNER_DEPLOY || vars.CI_RUNNER || 'ubuntu-latest' }}";
  // A short deploy is a deploy, not a light job.
  const f = runDoctor(wfOf("push", "deploy", STANDARD), rulebook, base).findings.filter((x) => x.rule === "CI-029");
  assert.equal(f.length, 1);
  assert.equal(f[0].runsOn, DEPLOY);
  assert.ok(!rules(wfOf("push", "deploy", STANDARD)).includes("CI-022"));
  assert.ok(!rules(wfOf("push", "deploy", DEPLOY)).includes("CI-029"));
  // In a pull request workflow, or a dry run or preview, it is CI.
  assert.ok(!rules(wfOf("pull_request", "deploy", STANDARD)).includes("CI-029"));
  assert.ok(!rules(wfOf("push", "dry-run-deploy", STANDARD)).includes("CI-029"));
  assert.ok(!rules(wfOf("push", "deploy-preview", STANDARD)).includes("CI-029"));
  // Client accounts and public repos are not on the org's pools.
  assert.ok(!rules(wfOf("push", "deploy", STANDARD), { visibility: "public" }).includes("CI-029"));
  // A deploy job on GitHub's included minutes is CI-028's.
  assert.ok(!rules(wfOf("push", "deploy", "${{ vars.CI_RUNNER_HOSTED }}")).includes("CI-029"));
});

test("SEC-009: registration, the variable and drift (DOM-1265)", () => {
  const deploy = { workflows: [{ path: ".github/workflows/deploy.yml", text: "on:\n  workflow_dispatch:\njobs:\n  d:\n    steps:\n      - uses: dopplerhq/secrets-fetch-action@451892f16195f9ac360e1a5bcbf0b5fd0e957534\n        with:\n          doppler-identity-id: ${{ vars.DOPPLER_IDENTITY_ID }}\n" }], vercel: [], files: {} };
  const table = { identities: [{ repo: "Doman-Digital/demo", branch: "main", reads: ["dd-deploy/demo"], identity: "11111111-1111-4111-8111-111111111111" }] };
  const run = (v, ctx) => runDoctor(v, rulebook, { ...base, dopplerIdentities: table, ...ctx }).findings.filter((f) => f.rule === "SEC-009").map((f) => f.message);
  // A house repo with no row fails even where the variables cannot be read.
  assert.match(run(deploy, { repo: "Doman-Digital/other", vars: null })[0], /no row/);
  // A client repo signs in to its own Doppler: no row needed, the variable still is.
  assert.deepEqual(run(deploy, { repo: "rmp474/RMP-Electrical", vars: null }), []);
  assert.match(run(deploy, { repo: "rmp474/RMP-Electrical", vars: { DOPPLER_IDENTITY_ID: "" } })[0], /no such variable/);
  assert.match(run(deploy, { repo: "Doman-Digital/demo", vars: { DOPPLER_IDENTITY_ID: "22222222-2222-4222-8222-222222222222" } })[0], /doppler-identities.json says 1111/);
  assert.deepEqual(run(deploy, { repo: "Doman-Digital/demo", vars: { DOPPLER_IDENTITY_ID: "11111111-1111-4111-8111-111111111111" } }), []);
  // A commented-out sign-in, and the reusable workflow itself, do not count.
  const quiet = { workflows: [{ path: ".github/workflows/a.yml", text: "on: [push]\n# doppler-identity-id: ${{ vars.DOPPLER_IDENTITY_ID }}\njobs: {}\n" }, { path: ".github/workflows/policy.yml", text: "on:\n  pull_request:\njobs:\n  c:\n    env:\n      DD_DOPPLER_IDENTITY_ID: ${{ vars.DOPPLER_IDENTITY_ID }}\n" }, { path: ".github/workflows/cloudflare-deploy.yml", text: "on:\n  workflow_call:\njobs:\n  d:\n    steps:\n      - with:\n          doppler-identity-id: ${{ vars.DOPPLER_IDENTITY_ID }}\n" }], vercel: [], files: {} };
  assert.deepEqual(run(quiet, { repo: "Doman-Digital/other", vars: {} }), []);
});

test("doppler-identities.json: one row per repo, each well formed, every house Actions deploy registered", () => {
  const table = JSON.parse(readFileSync(new URL("../doppler-identities.json", import.meta.url), "utf8"));
  const deploys = JSON.parse(readFileSync(new URL("../deploys.json", import.meta.url), "utf8"));
  const repos = table.identities.map((r) => r.repo.toLowerCase());
  assert.equal(new Set(repos).size, repos.length, "a repo appears twice");
  for (const r of table.identities) {
    assert.match(r.repo, /^[^/\s]+\/[^/\s]+$/, `${r.repo}: owner/name`);
    assert.match(r.branch, /^[\w./-]+$/, `${r.repo}: branch`);
    assert.ok(Array.isArray(r.reads) && r.reads.length && r.reads.every((c) => /^[\w-]+\/[\w-]+$/.test(c)), `${r.repo}: reads lists project/config`);
    assert.ok(r.identity === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.identity), `${r.repo}: identity is a UUID or null`);
  }
  const missing = [...new Set(deploys.workers.filter((w) => w.path === "actions" && /^doman-digital\//i.test(w.repo || "")).map((w) => w.repo))].filter((r) => !repos.includes(r.toLowerCase()));
  assert.deepEqual(missing, [], `Actions deploys with no Doppler identity row: ${missing.join(", ")}`);
});

// The acceptance for DOM-1363, end to end: the doctor as the policy workflow runs it, reading the
// pull request event file. A PR with no issue is refused, Part of passes, the no-issue label passes.
test("dd doctor refuses a pull request event with no issue, passes Part of and the no-issue label", () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-lin-"));
  const doctor = (pull_request, today = "2026-10-28") => {
    const file = join(dir, "event.json");
    writeFileSync(file, JSON.stringify({ pull_request }));
    const r = spawnSync(process.execPath, [new URL("../bin/dd.mjs", import.meta.url).pathname, "doctor", new URL("..", import.meta.url).pathname, "--today", today, "--format", "json"], {
      encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: file },
    });
    return { code: r.status, out: r.stdout };
  };
  const pr = (over) => ({ title: "Tidy the README", body: "", head: { ref: "tidy" }, labels: [], ...over });
  const bad = doctor(pr({}));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /LIN-001/);
  assert.equal(doctor(pr({}), "2026-10-27").code, 0, "before its enforce date it only warns");
  for (const ok of [pr({ title: "Part of DOM-1363: the check" }), pr({ body: "Closes DOM-1363" }), pr({ head: { ref: "dom-1363-check" } }), pr({ labels: [{ name: "no-issue" }] })]) {
    assert.doesNotMatch(doctor(ok).out, /LIN-001/, JSON.stringify(ok));
  }
});
