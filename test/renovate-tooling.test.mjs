// The tooling automerge rule in default.json (founder, 17 November 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { presetProblems, driftProblems, toolingRules } from "../lib/renovate-tooling.mjs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const cfg = JSON.parse(readFileSync(new URL("../renovate-tooling.json", import.meta.url), "utf8"));
const clone = () => JSON.parse(JSON.stringify(preset));

test("the shipped preset holds: one scoped tooling rule, client repos untouched", () => {
  assert.deepEqual(presetProblems(preset, cfg), []);
});

test("every exclusion carries a reason", () => {
  for (const [name, reason] of Object.entries(cfg.excluded)) assert.ok(reason.length > 20, name);
});

test("a rule with no repo list is refused, because it would reach client sites", () => {
  const p = clone();
  delete toolingRules(p)[0].matchRepositories;
  assert.match(presetProblems(p, cfg).join("\n"), /every repo, client sites included/);
});

test("an excluded or wildcard repo is refused", () => {
  const p = clone();
  toolingRules(p)[0].matchRepositories.push("Doman-Digital/client-previews", "Doman-Digital/*");
  const out = presetProblems(p, cfg).join("\n");
  assert.match(out, /client-previews is excluded/);
  assert.match(out, /Doman-Digital\/\* is not one exact/);
});

test("majors and platform automerge are refused", () => {
  const p = clone();
  const r = toolingRules(p)[0];
  r.matchUpdateTypes = ["major", "minor", "patch", "lockFileMaintenance"];
  r.platformAutomerge = true;
  const out = presetProblems(p, cfg).join("\n");
  assert.match(out, /never major/);
  assert.match(out, /platformAutomerge false/);
});

test("an estate-wide minor or lock file automerge is refused", () => {
  const p = clone();
  p.lockFileMaintenance.automerge = true;
  p.packageRules.push({ description: "everything", matchUpdateTypes: ["minor"], automerge: true });
  const out = presetProblems(p, cfg).join("\n");
  assert.match(out, /top level/);
  assert.match(out, /automerges minor for every repo/);
});

test("drift against the topics is reported both ways", () => {
  const named = toolingRules(preset)[0].matchRepositories.map((r) => ({ name: r.split("/")[1], isArchived: false }));
  assert.deepEqual(driftProblems(preset, cfg, [...named, { name: "client-previews", isArchived: false }]), [], "exclusions are not drift");
  const out = driftProblems(preset, cfg, [...named.slice(1), { name: "dd-new-tool", isArchived: false }]).join("\n");
  assert.match(out, /dd-new-tool carries dd-tooling/);
  assert.match(out, new RegExp(`${named[0].name} is named in default.json`));
  assert.match(driftProblems(preset, cfg, named.map((r, i) => ({ ...r, isArchived: i === 0 }))).join("\n"), /is not an unarchived/);
});
