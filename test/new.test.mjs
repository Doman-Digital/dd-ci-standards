import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planNew, addToRegistry, registryEntry, cleanVerdict, ruleset, POLICY_CHECK } from "../lib/new.mjs";
import { POLICY_CALLER } from "../lib/adopt.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const ok = { kind: "dd-site", name: "dd-scratch", description: "A scratch site.", today: "2026-10-03", dir: "/tmp/dd-scratch" };

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

test("dd new refuses client repos, out-of-scope kinds, other owners and a description REG-002 would fail", () => {
  for (const [over, why] of [
    [{ kind: "client-site" }, /GitHub App/],
    [{ kind: "client-app" }, /GitHub App/],
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
