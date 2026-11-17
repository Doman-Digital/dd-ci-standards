// Version caps in default.json (founder, 17 November 2026): stay on Node 24, pnpm 10 and phpunit
// below 13, and never bump requires-python. Move each ceiling together, by editing it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const rule = (pred) => preset.packageRules.filter(pred);

test("Node is capped below 25, by package name so every manager that reads it is held", () => {
  const r = rule((x) => x.matchPackageNames?.includes("node"));
  assert.equal(r.length, 1);
  assert.equal(r[0].allowedVersions, "<25");
  assert.equal(r[0].matchManagers, undefined, "a manager list would leave setup-node or nvm uncapped");
});

test("pnpm is capped below 11 and the pnpm/action-setup action itself is not capped", () => {
  const r = rule((x) => x.matchPackageNames?.includes("pnpm"));
  assert.equal(r.length, 1);
  assert.equal(r[0].allowedVersions, "<11");
  assert.ok(!r[0].matchPackageNames.some((n) => n.includes("action-setup")));
});

test("phpunit is capped below 13 for composer", () => {
  const r = rule((x) => x.matchPackageNames?.includes("phpunit/phpunit"));
  assert.equal(r.length, 1);
  assert.equal(r[0].allowedVersions, "<13");
  assert.deepEqual(r[0].matchManagers, ["composer"]);
});

test("requires-python is never bumped", () => {
  const r = rule((x) => x.matchDepTypes?.includes("requires-python"));
  assert.equal(r.length, 1);
  assert.equal(r[0].enabled, false);
  assert.deepEqual(r[0].matchManagers, ["pep621"]);
});

test("every cap carries a reason and none turns on automerge", () => {
  for (const r of rule((x) => x.allowedVersions || x.matchDepTypes?.includes("requires-python"))) {
    assert.ok(r.description.length > 40);
    assert.notEqual(r.automerge, true);
  }
});
