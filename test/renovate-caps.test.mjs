// Version caps in default.json (founder, 17 November 2026): stay on Node 24, pnpm 10 and phpunit
// below 13, and never bump requires-python. Move each ceiling together, by editing it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const rule = (pred) => preset.packageRules.filter(pred);

test("Node is capped below 25, by dependency name so every manager that reads it is held", () => {
  const r = rule((x) => x.matchDepNames?.includes("node"));
  assert.equal(r.length, 1);
  assert.equal(r[0].allowedVersions, "<25");
  assert.equal(r[0].matchManagers, undefined, "a manager list would leave setup-node or nvm uncapped");
});

// 17 November 2026: the cap first matched matchPackageNames ["node"]. In a workflow, Renovate reads
// setup-node's node-version as depName "node" with packageName "actions/node-versions", so the
// rule never matched: dd-ci-standards#131, dd-repo-registry#337 and the same PR on three more of
// our repos and one client site all still moved node-version to 26.
test("the Node cap does not depend on the package name, which differs in workflow files", () => {
  const r = rule((x) => x.matchDepNames?.includes("node"))[0];
  assert.equal(r.matchPackageNames, undefined, "matchers are ANDed: a package-name match beside it would uncap workflows again");
  assert.equal(r.matchDatasources, undefined, "a datasource list would leave one of the four places uncapped");
  const byPackageOnly = rule((x) => x.matchPackageNames?.includes("node") && !x.matchDepNames);
  assert.equal(byPackageOnly.length, 0, "a second Node rule matched by package name alone hides the gap");
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
