import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planNew, governedNextStep, addToRegistry, registryEntry, cleanVerdict, ruleset, POLICY_CHECK } from "../lib/new.mjs";
import { POLICY_CALLER } from "../lib/adopt.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const ok = { kind: "dd-site", name: "dd-scratch", description: "A scratch site.", today: "2026-10-03", dir: "/tmp/dd-scratch", programme: "DOM-1" };

test("dd new plans the starter, the adoption and the repo, in that order", () => {
  const plan = planNew(ok, taxonomy, rulebook);
  assert.equal(plan.error, undefined);
  assert.equal(plan.repo, "Doman-Digital/dd-scratch");
  assert.match(plan.steps[0].args.join(" "), /^--yes create-next-app@\d+ \/tmp\/dd-scratch .*--use-pnpm .*--disable-git/);
  assert.deepEqual(plan.steps[1], { cmd: "pnpm", args: ["install"] });
  assert.ok(plan.steps[2].args.includes("--visibility") && plan.steps[2].args.includes("private"));
  // The tags make REG-002 pass: one kind, one status, the business tag.
  assert.deepEqual(plan.topics.slice(0, 3), ["dd-site", "in-development", "doman-digital"]);
});

test("dd new refuses out-of-scope kinds, other owners and a description REG-002 would fail", () => {
  for (const [over, why] of [
    [{ kind: "personal" }, /outside the framework/],
    [{ kind: "it-portfolio" }, /outside the framework/],
    [{ kind: "made-up" }, /unknown kind/],
    [{ kind: undefined }, /--kind is required/],
    [{ owner: "dmitridoman" }, /cannot run Actions/],
    [{ name: "Bad_Name" }, /lowercase/],
    [{ description: "" }, /--description is required/],
    [{ description: "a — b" }, /dash/],
    [{ description: "x".repeat(351) }, /350/],
    [{ visibility: "internal" }, /private or public/],
  ]) {
    assert.match(planNew({ ...ok, ...over }, taxonomy, rulebook).error || "", why, JSON.stringify(over));
  }
});

test("the registry entry is appended to repos:, and a second one for the same repo is refused", () => {
  const registry = "version: 1\naccounts:\n  github: {}\nrepos:\n  - remote: github.com/Doman-Digital/one\n    kind: dd-tooling\n    scope: in\n";
  const first = addToRegistry(registry, { owner: "Doman-Digital", name: "dd-scratch", kind: "dd-site", today: "2026-10-03" });
  assert.equal(first.text, registry + registryEntry({ owner: "Doman-Digital", name: "dd-scratch", kind: "dd-site", today: "2026-10-03" }));
  assert.match(first.text, /- remote: github.com\/Doman-Digital\/dd-scratch\n    kind: dd-site\n    scope: in\n/);
  assert.match(addToRegistry(first.text, { owner: "Doman-Digital", name: "DD-Scratch", kind: "dd-site", today: "x" }).error, /already in registry.yaml/);
  assert.match(addToRegistry("repos:\n  - remote: x\nlater: 1\n", { owner: "o", name: "n", kind: "dd-site" }).error, /not the last top-level key/);
});

test("the real registry.yaml takes an entry, if a checkout sits beside this one", (t) => {
  let text;
  try {
    text = readFileSync(new URL("../../dd-repo-registry/registry.yaml", import.meta.url), "utf8");
  } catch {
    t.skip("no dd-repo-registry checkout beside this one");
    return;
  }
  assert.ok(addToRegistry(text, { owner: "Doman-Digital", name: "dd-scratch-never-real", kind: "dd-site", today: "2026-10-03" }).text);
});

test("clean means nothing failing, nothing warning and nothing exempt", () => {
  assert.equal(cleanVerdict({ findings: [], exempted: [] }).clean, true);
  assert.equal(cleanVerdict({ findings: [{ rule: "FW-002", level: "report" }], exempted: [] }).clean, true);
  assert.equal(cleanVerdict({ findings: [{ rule: "SEC-001", level: "warn" }], exempted: [] }).clean, false);
  assert.equal(cleanVerdict({ findings: [], exempted: [{ rule: "CI-003" }] }).clean, false);
});

test("the ruleset requires the check the policy caller actually produces", () => {
  // caller job id / called job id: ci-standards-policy (POLICY_CALLER) / check (policy.yml)
  const callerJob = /^jobs:\n  ([\w-]+):/m.exec(POLICY_CALLER)[1];
  const calledJob = /^jobs:\n  ([\w-]+):/m.exec(readFileSync(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8"))[1];
  assert.equal(POLICY_CHECK, `${callerJob} / ${calledJob}`);
  const checks = ruleset().rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks;
  assert.deepEqual(checks, [{ context: POLICY_CHECK }]);
  assert.ok(ruleset().rules.some((r) => r.type === "pull_request"));
});

test("a repo with no caller (covered by the org ruleset) gets no required check that would never report", () => {
  const rs = ruleset({ caller: false });
  assert.ok(!rs.rules.some((r) => r.type === "required_status_checks"));
  assert.ok(rs.rules.some((r) => r.type === "pull_request"), "pull requests are still required");
});

const client = { ...ok, kind: "client-site", name: "acme-plumbing", owner: "acme-plumbing-ltd", programme: "DOM-18200", dir: "/tmp/acme-plumbing" };

test("a client repo has a governed route: create-site with --programme, then adopt and doctor, then the GitHub App", () => {
  for (const kind of ["client-site", "client-app"]) {
    const plan = planNew({ ...client, kind }, taxonomy, rulebook);
    assert.equal(plan.error, undefined, kind);
    assert.equal(plan.governed, true);
    assert.equal(plan.local, true, "dd new never creates a client repo: the App does");
    assert.equal(plan.repo, "acme-plumbing-ltd/acme-plumbing");
    const site = plan.steps[2].args;
    assert.equal(site[site.indexOf("--programme") + 1], "DOM-18200");
    assert.ok(site.includes("--yes"));
    assert.equal(plan.topics[0], kind);
  }
});

test("a client repo needs its programme issue, and a real account name", () => {
  for (const [over, why] of [
    [{ programme: undefined }, /--programme DOM-123/],
    [{ programme: "18200" }, /--programme DOM-123/],
    [{ owner: "not an account" }, /not a GitHub account name/],
    [{ name: "Bad_Name" }, /lowercase/],
  ]) {
    assert.match(planNew({ ...client, ...over }, taxonomy, rulebook).error || "", why, JSON.stringify(over));
  }
});

test("a programme is forwarded for every kind; --no-gate is for a --local starter only", () => {
  const forwarded = planNew(ok, taxonomy, rulebook);
  assert.equal(forwarded.governed, false);
  assert.equal(forwarded.local, false);
  assert.deepEqual(forwarded.steps[2].args.slice(forwarded.steps[2].args.indexOf("--programme")), ["--programme", "DOM-1"]);
  const nightly = planNew({ ...ok, programme: undefined, local: true, noGate: true }, taxonomy, rulebook);
  assert.ok(!nightly.steps[2].args.includes("--programme"));
  assert.ok(nightly.steps[2].args.includes("--no-gate"));
  assert.match(planNew({ ...ok, noGate: true }, taxonomy, rulebook).error, /--local starter only/);
  assert.match(planNew({ ...client, local: true, noGate: true }, taxonomy, rulebook).error, /--local starter only/);
  assert.match(planNew({ ...ok, owner: "somebody" }, taxonomy, rulebook).error, /cannot run Actions/);
});

test("the next step for a client repo is only what is true: the owner makes the repo, the App pushes", () => {
  const plan = planNew(client, taxonomy, rulebook);
  const text = governedNextStep(plan, "/tmp/acme-plumbing", "node /x/dd.mjs").join("\n");
  assert.match(text, /not created here/);
  assert.match(text, /does not let an App create a repository in a personal account/);
  assert.match(text, /dd-gh-app run --app dd-bot --owner acme-plumbing-ltd --perms contents=write -- git -C '\/tmp\/acme-plumbing' push -u origin main/);
  assert.match(text, /remote add origin https:\/\/github.com\/acme-plumbing-ltd\/acme-plumbing.git/);
  assert.match(text, /client-site, in-development, doman-digital/);
  assert.match(text, /- remote: github.com\/acme-plumbing-ltd\/acme-plumbing/);
  assert.match(text, /Programme DOM-18200\. Then run: node \/x\/dd.mjs doctor /);
  assert.ok(!/gh repo create|GH_TOKEN|gh auth/.test(text), "no repo creation and no token or login in the printed commands");
});

test("without a programme dd new stops before anything is made, unless a --local starter skips the gate", () => {
  const bare = { ...ok, programme: undefined };
  assert.match(planNew(bare, taxonomy, rulebook).error, /start in a site programme: pass --programme DOM-123/);
  assert.match(planNew({ ...bare, local: true }, taxonomy, rulebook).error, /start in a site programme/);
  assert.equal(planNew({ ...bare, local: true, noGate: true }, taxonomy, rulebook).error, undefined);
  const was = process.env.DD_CREATE_SITE_NO_GATE;
  process.env.DD_CREATE_SITE_NO_GATE = "1";
  try {
    assert.equal(planNew({ ...bare, local: true }, taxonomy, rulebook).error, undefined);
    assert.match(planNew(bare, taxonomy, rulebook).error, /start in a site programme/); // a repo that will be pushed still needs one
  } finally {
    if (was === undefined) delete process.env.DD_CREATE_SITE_NO_GATE;
    else process.env.DD_CREATE_SITE_NO_GATE = was;
  }
});
