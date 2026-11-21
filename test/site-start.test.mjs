// PKG-003: the site was started with create-site and its start check passes (DOM-18123).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, levelOn } from "../lib/engine.mjs";
import { labelProblems, checkCommand, runSiteCheck, siteStartContext, LABEL_PATH } from "../lib/site-start.mjs";
import { LABEL } from "./fixtures.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const rule = rulebook.rules.find((r) => r.id === "PKG-003");
const base = { today: "2026-11-20", kind: "client-site", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy: null };
const view = (label) => ({ workflows: [], vercel: [], files: label === undefined ? {} : { [LABEL_PATH]: label } });
const found = (r) => r.findings.filter((f) => f.rule === "PKG-003");
const check = (exit, over = {}) => ({ siteStart: { check: { ran: true, exit, command: "create-site --check --yes", output: "", ...over } } });
const label = (over) => JSON.stringify({ ...JSON.parse(LABEL), ...over });

test("PKG-003 is in the rulebook for client-site and dd-site, warning today and not enforcing yet", () => {
  assert.deepEqual(rule.applies, ["client-site", "dd-site"]);
  assert.equal(levelOn(rule, "2026-11-17"), "off");
  assert.equal(levelOn(rule, "2026-11-18"), "warn");
  assert.equal(levelOn(rule, "2026-12-31"), "warn", "a placeholder far enough out that nothing fails yet");
});

test("PKG-003 does not apply to other kinds, light kinds or tooling", () => {
  for (const kind of ["dd-tooling", "dd-product", "client-app", "sales-demo"]) {
    assert.deepEqual(found(runDoctor(view(), rulebook, { ...base, kind })), [], kind);
  }
  assert.equal(found(runDoctor(view(), rulebook, { ...base, kind: "dd-site" })).length, 1);
});

test("a missing label warns and says how to start the site", () => {
  const f = found(runDoctor(view(), rulebook, base));
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "warn");
  assert.equal(f[0].file, LABEL_PATH);
  assert.match(f[0].message, /^The start label is missing/);
  assert.match(f[0].message, /create-site --handover --reason/);
});

test("the label contract: tool, version, mode, programme, reason for a handover, startedAt", () => {
  assert.deepEqual(labelProblems(LABEL), []);
  assert.deepEqual(labelProblems(label({ mode: "handover", reason: "Live Astro site copied in from the previous agency" })), []);
  for (const [over, why] of [
    [{ tool: "somebody-else" }, /names tool/],
    [{ version: "latest" }, /no version/],
    [{ mode: "adopted" }, /not programme or handover/],
    [{ programme: null }, /programme issue/],
    [{ programme: "not-an-issue" }, /programme issue/],
    [{ mode: "handover" }, /no reason/],
    [{ mode: "handover", reason: "short" }, /no reason/],
    [{ startedAt: "yesterday" }, /startedAt/],
  ]) {
    assert.match(labelProblems(label(over)).join(" | "), why, JSON.stringify(over));
  }
  // --no-gate (the nightly starter) skips the programme gate and may have no programme; the sweep, not PKG-003, counts it as not started.
  assert.deepEqual(labelProblems(label({ programme: null, stage05Gate: false })), []);
  assert.deepEqual(labelProblems(label({ programme: null, mode: "handover", handoverGate: false, reason: "Copied in from the old agency" })), []);
  assert.match(labelProblems(label({ programme: null }))[0], /programme issue/, "no programme and no skipped gate is not a start");
  assert.match(labelProblems("{nope")[0], /not valid JSON/);
  assert.match(labelProblems("[]")[0], /not a JSON object/);
});

test("an invalid label is a finding, one per problem", () => {
  const r = runDoctor(view(label({ tool: "x", programme: null })), rulebook, base);
  assert.equal(found(r).length, 2);
  assert.match(found(r)[0].message, /^The start label /);
});

test("a valid label with a passing check is clean", () => {
  assert.deepEqual(found(runDoctor(view(LABEL), rulebook, { ...base, ...check(0) })), []);
});

test("a hand-written label does not prove anything: create-site --check exiting 3 (drift) is a finding", () => {
  const f = found(runDoctor(view(LABEL), rulebook, { ...base, ...check(3) }));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /found work to do/);
  assert.match(f[0].message, /A label alone proves nothing/);
});

test("create-site refusing the folder is a verdict (a label with no site behind it); npx failing is not", () => {
  const refused = runSiteCheck("/r", { env: { DD_CREATE_SITE: "/x/cli.js" } }, () => ({ status: 1, stdout: "", stderr: "create-site: no package.json in /r. Create the site first\n" }));
  assert.equal(refused.ran, true);
  assert.equal(refused.exit, 1);
  const f = found(runDoctor(view(LABEL), rulebook, { ...base, siteStart: { check: refused } }));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /refused this folder \(create-site: no package.json in \/r/);
  const npx = runSiteCheck("/r", { env: {} }, () => ({ status: 1, stdout: "", stderr: "npm error 404 Not Found - @domandigital/create-site\n" }));
  assert.equal(npx.ran, false);
});

test("a check that gave no verdict is a note, not a finding, and an exemption is not called unused", () => {
  const ctx = { ...base, siteStart: { check: { ran: false, command: "npx create-site --check", error: "spawn npx ENOENT" } } };
  const r = runDoctor(view(LABEL), rulebook, ctx);
  assert.deepEqual(found(r), []);
  assert.ok(r.notes.some((n) => /gave no verdict \(spawn npx ENOENT\): PKG-003 judged the start label only.*--site-answers/.test(n)));
  // No siteStart at all (a run of named rules): nothing to judge beyond the label.
  assert.deepEqual(found(runDoctor(view(LABEL), rulebook, base)), []);
});

test("the check command: DD_CREATE_SITE, then the repo's own install, then the published package", () => {
  assert.deepEqual(checkCommand("/r", { env: { DD_CREATE_SITE: "/x/cli.js" }, exists: () => true }).args, ["/x/cli.js", "--check", "--yes"]);
  assert.equal(checkCommand("/r", { env: {}, exists: (p) => p === "/r/node_modules/.bin/create-site" }).cmd, "/r/node_modules/.bin/create-site");
  const pub = checkCommand("/r", { env: {}, exists: () => false, visibility: "public", answers: "/a.json", extra: ["--programme", "DOM-1"] });
  assert.equal(pub.cmd, "npx");
  assert.deepEqual(pub.args, ["--yes", "@domandigital/create-site@latest", "--check", "--yes", "--visibility", "public", "--answers", "/a.json", "--programme", "DOM-1"]);
});

test("runSiteCheck: exit 0 and 3 are verdicts; exit 2 (it needs the answers) is not", () => {
  const r = runSiteCheck("/r", { env: { DD_CREATE_SITE: "/x/cli.js" } }, () => ({ status: 2, stdout: "", stderr: "create-site: missing --client\n" }));
  assert.equal(r.ran, false);
  assert.equal(r.error, "exit 2: create-site: missing --client");
});

test("runSiteCheck reports the exit status, and no verdict when the command will not start", () => {
  const spawn = (status) => () => ({ status, stdout: "create-site --check: up to date.\n", stderr: "create-site --check: 2 thing(s) to do.\n  a\n" });
  assert.deepEqual(runSiteCheck("/r", { env: { DD_CREATE_SITE: "/x/cli.js" } }, spawn(0)), { ran: true, command: "node /x/cli.js --check --yes", exit: 0, output: "create-site --check: up to date." });
  const drift = runSiteCheck("/r", { env: { DD_CREATE_SITE: "/x/cli.js" } }, spawn(3));
  assert.equal(drift.exit, 3);
  assert.equal(drift.output, "create-site --check: 2 thing(s) to do.");
  const missing = runSiteCheck("/r", { env: {} }, () => ({ error: new Error("spawn npx ENOENT"), status: null }));
  assert.equal(missing.ran, false);
  assert.match(missing.error, /ENOENT/);
  assert.equal(runSiteCheck("/r", { env: {} }, () => ({ status: null, signal: "SIGTERM" })).ran, false);
});

test("siteStartContext runs nothing when there is no valid label (PKG-003 reports that on its own)", () => {
  let ran = 0;
  const run = () => (ran++, { status: 0, stdout: "", stderr: "" });
  assert.equal(siteStartContext("/r", view(), {}, run), null);
  assert.equal(siteStartContext("/r", view("{bad"), {}, run), null);
  assert.equal(ran, 0);
  assert.equal(siteStartContext("/r", view(LABEL), { env: {} }, run).check.exit, 0);
  assert.equal(ran, 1);
});

test("end to end on a real folder with a fake create-site: the label and the check both count", () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-site-start-"));
  mkdirSync(join(dir, ".dd"));
  writeFileSync(join(dir, LABEL_PATH), LABEL);
  const cli = (code) => {
    const f = join(dir, `fake-${code}.mjs`);
    writeFileSync(f, `console.error("create-site --check: 1 thing(s) to do."); process.exit(${code});`);
    return f;
  };
  for (const [code, level] of [[0, undefined], [3, "warn"], [2, undefined]]) {
    const v = { workflows: [], vercel: [], files: { [LABEL_PATH]: readFileSync(join(dir, LABEL_PATH), "utf8") } };
    const siteStart = siteStartContext(dir, v, { env: { DD_CREATE_SITE: cli(code) } });
    assert.equal(siteStart.check.ran, code !== 2);
    assert.equal(found(runDoctor(v, rulebook, { ...base, siteStart }))[0]?.level, level);
  }
});
