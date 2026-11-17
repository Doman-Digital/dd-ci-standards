// Override majors in default.json (DOM-17884, 17 November 2026): Renovate never raises an
// override to a new major, security updates included. An override forces its version onto every
// package that asked for the older range, and two such forced majors broke a client build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const OVERRIDE_TYPES = ["pnpm.overrides", "pnpm-workspace.overrides", "overrides", "resolutions"];
const overrideRules = preset.packageRules.filter(
  (x) => x.enabled === false && x.matchDepTypes?.some((t) => OVERRIDE_TYPES.includes(t)),
);

test("exactly one rule disables majors on overrides", () => {
  assert.equal(overrideRules.length, 1);
  assert.deepEqual(overrideRules[0].matchUpdateTypes, ["major"]);
  assert.ok(overrideRules[0].description.length > 40);
});

test("it covers overrides in package.json and in pnpm-workspace.yaml", () => {
  const types = overrideRules[0].matchDepTypes;
  assert.ok(types.includes("pnpm.overrides"), "package.json pnpm.overrides");
  assert.ok(types.includes("pnpm-workspace.overrides"), "pnpm-workspace.yaml overrides; the per-repo rule missed it");
  assert.ok(types.includes("overrides"), "npm overrides");
  assert.ok(types.includes("resolutions"), "yarn resolutions");
});

test("it is not narrowed by a package, manager or datasource matcher", () => {
  const r = overrideRules[0];
  assert.equal(r.matchPackageNames, undefined, "matchers are ANDed: a package list would narrow the rule");
  assert.equal(r.matchManagers, undefined, "matchers are ANDed: a manager list would narrow the rule");
  assert.equal(r.matchDatasources, undefined, "matchers are ANDed: a datasource list would narrow the rule");
  assert.equal(r.matchDepNames, undefined, "matchers are ANDed: a dependency-name list would narrow the rule");
});

test("minor and patch updates to overrides stay enabled", () => {
  for (const r of overrideRules) {
    assert.ok(!r.matchUpdateTypes.includes("minor"));
    assert.ok(!r.matchUpdateTypes.includes("patch"));
  }
});

test("it sits before the rule that turns off updates to this preset", () => {
  const i = preset.packageRules.indexOf(overrideRules[0]);
  const self = preset.packageRules.findIndex((x) => x.matchPackageNames?.includes("Doman-Digital/dd-ci-standards"));
  assert.ok(i >= 0 && i < self);
});
