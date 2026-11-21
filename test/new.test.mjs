import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planNew, createSiteEnv, governedNextStep, addToRegistry, registryEntry, cleanVerdict, ruleset, POLICY_CHECK } from "../lib/new.mjs";
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

test("a client repo has a governed route: create-site with --programme, then adopt and doctor, then the founder pushes", () => {
  for (const kind of ["client-site", "client-app"]) {
    const plan = planNew({ ...client, kind }, taxonomy, rulebook);
    assert.equal(plan.error, undefined, kind);
    assert.equal(plan.governed, true);
    assert.equal(plan.local, true, "dd new never creates a client repo: its owner does");
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

test("the next step for a client repo is only what is true: the owner makes the repo, the founder pushes under their own gh login", () => {
  const plan = planNew(client, taxonomy, rulebook);
  const text = governedNextStep(plan, "/tmp/acme-plumbing", "node /x/dd.mjs").join("\n");
  assert.match(text, /not created here/);
  assert.match(text, /invites the founder as a collaborator with Write/);
  assert.match(text, /gh auth status && test "\$\(gh api repos\/acme-plumbing-ltd\/acme-plumbing --jq \.permissions\.push\)" = true/);
  assert.match(text, /accepts the invitation[^\n]*gh api user\/repository_invitations[^\n]*acme-plumbing-ltd\/acme-plumbing[^\n]*-X PATCH/);
  assert.match(text, /a 404 usually means the invitation is not accepted yet/);
  assert.match(text, /stop here if either fails \(do not start a login flow; a 404/);
  assert.match(text, /git -C '\/tmp\/acme-plumbing' -c credential\.helper= -c 'credential\.helper=!gh auth git-credential' push -u origin main/);
  assert.match(text, /for checks and workflow dispatch only, not for this push/);
  assert.match(text, /remote add origin https:\/\/github.com\/acme-plumbing-ltd\/acme-plumbing.git/);
  assert.match(text, /client-site, in-development, doman-digital/);
  assert.match(text, /- remote: github.com\/acme-plumbing-ltd\/acme-plumbing/);
  assert.match(text, /Programme DOM-18200\. Then run: node \/x\/dd.mjs doctor /);
  assert.ok(!/gh repo create|GH_TOKEN|gh auth (login|refresh|token|setup-git)/.test(text), "no repo creation, no token and no login flow in the printed commands");
  const order = ["repository_invitations", "gh auth status", "init -q -b main", "remote add origin", "push -u origin main"].map((t) => text.indexOf(t));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "the login check comes before the commit, the remote and the push");
});

// DOM-18155: the guard. A client repo's push path must not ask for a GitHub App installation token.
test("the client-repo push path never asks for an App installation token", () => {
  const FORBIDDEN = /dd-gh-app|--perms\b|installation[ -]token|app[ -]token|create-github-app-token|GH_TOKEN|GITHUB_TOKEN|gh auth (login|refresh|token|setup-git)/i;
  for (const kind of ["client-site", "client-app"]) {
    const plan = planNew({ ...client, kind }, taxonomy, rulebook);
    const printed = governedNextStep(plan, "/tmp/acme-plumbing", "node /x/dd.mjs").join("\n");
    // The printed lines say what the route does not use ("needs no GitHub App token"), so the one allowed phrase is removed first.
    const asked = printed.replace(/It needs no GitHub App token\./, "");
    assert.ok(!FORBIDDEN.test(asked), `${kind}: ${asked.match(FORBIDDEN)?.[0]}`);
    // The App is only ever named for checks and workflow dispatch.
    for (const line of printed.split("\n").filter((l) => /GitHub App/.test(l))) assert.match(line, /checks and workflow dispatch|needs no GitHub App token/, line);
  }
  // The code that builds and prints the route does not call dd-gh-app or mint a token either.
  const src = readFileSync(new URL("../lib/new.mjs", import.meta.url), "utf8");
  const route = src.slice(src.indexOf("export function governedNextStep"), src.indexOf("// The check run the policy caller produces"));
  assert.ok(!/dd-gh-app|--perms\b|create-github-app-token|installation[ -]token/i.test(route), "governedNextStep builds no App-token command");
});

test("without a programme dd new stops before anything is made, unless a --local starter skips the gate", () => {
  const was = process.env.DD_CREATE_SITE_NO_GATE;
  delete process.env.DD_CREATE_SITE_NO_GATE; // set in some test and starter environments; create-site honours "1" only
  const bare = { ...ok, programme: undefined };
  assert.match(planNew(bare, taxonomy, rulebook).error, /start in a site programme: pass --programme DOM-123/);
  assert.match(planNew({ ...bare, local: true }, taxonomy, rulebook).error, /start in a site programme/);
  assert.equal(planNew({ ...bare, local: true, noGate: true }, taxonomy, rulebook).error, undefined);
  try {
    process.env.DD_CREATE_SITE_NO_GATE = "true"; // not "1": create-site would still refuse
    assert.match(planNew({ ...bare, local: true }, taxonomy, rulebook).error, /start in a site programme/);
    process.env.DD_CREATE_SITE_NO_GATE = "1";
    assert.equal(planNew({ ...bare, local: true }, taxonomy, rulebook).error, undefined);
    assert.match(planNew(bare, taxonomy, rulebook).error, /start in a site programme/); // a repo that will be pushed still needs one
  } finally {
    if (was === undefined) delete process.env.DD_CREATE_SITE_NO_GATE;
    else process.env.DD_CREATE_SITE_NO_GATE = was;
  }
});

test("the no-gate variable reaches create-site only for a --local starter", () => {
  const local = planNew({ ...ok, programme: undefined, local: true, noGate: true }, taxonomy, rulebook);
  assert.deepEqual(createSiteEnv(local), {});
  assert.ok("DD_CREATE_SITE_NO_GATE" in createSiteEnv(planNew(ok, taxonomy, rulebook)), "a repo that will be pushed");
  assert.equal(createSiteEnv(planNew(ok, taxonomy, rulebook)).DD_CREATE_SITE_NO_GATE, undefined);
  const client = planNew({ ...ok, kind: "client-site", owner: "acme-ltd", local: true }, taxonomy, rulebook);
  assert.ok("DD_CREATE_SITE_NO_GATE" in createSiteEnv(client), "a client repo, even though it is built locally");
});
