// Playwright's Docker image and its npm packages move in one PR (17 November 2026). dd-trawl#48 moved
// playwright to 1.65.1 in the lock file while the CI image tag stayed v1.65.0-noble, and dd-trawl's
// test that compares the two went red. The image's update also sat held: Renovate reads release
// timestamps from Docker Hub only, so the release-age wait never cleared for mcr.microsoft.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const rules = preset.packageRules;
const IMAGE = "mcr.microsoft.com/playwright";

// What applies to a dependency, read the way Renovate does: matching rules in order, later ones win.
// Only the name matchers used in this preset are modelled; a rule with any other matcher is skipped.
function settingsFor(depName, updateType) {
  const out = {};
  for (const r of rules) {
    if (r.matchRepositories || r.matchManagers || r.matchDepTypes || r.matchDatasources) continue;
    if (r.matchUpdateTypes && !r.matchUpdateTypes.includes(updateType)) continue;
    if (r.matchDepNames && !r.matchDepNames.includes(depName)) continue;
    if (r.matchPackageNames && !r.matchPackageNames.some((n) => n === depName || (n.endsWith("/**") && depName.startsWith(n.slice(0, -2))))) continue;
    Object.assign(out, r);
  }
  return out;
}

test("the image and both npm packages land in one group, for patch, minor and major", () => {
  for (const type of ["patch", "minor", "major"]) {
    for (const dep of [IMAGE, "playwright", "@playwright/test"]) {
      assert.equal(settingsFor(dep, type).groupName, "playwright", `${dep} ${type}`);
    }
  }
});

test("the group is matched by dependency name only, so no manager or datasource narrows it", () => {
  const r = rules.filter((x) => x.groupName === "playwright");
  assert.equal(r.length, 1);
  assert.deepEqual([...r[0].matchDepNames].sort(), ["@playwright/test", IMAGE, "playwright"].sort());
  for (const key of ["matchManagers", "matchDatasources", "matchPackageNames", "matchUpdateTypes", "matchFileNames"]) {
    assert.equal(r[0][key], undefined, `${key} would leave a place Renovate reads the image ungrouped`);
  }
});

test("packages that only share the name are left in their usual groups", () => {
  assert.equal(settingsFor("@axe-core/playwright", "minor").groupName, "all non-major dependencies");
  assert.equal(settingsFor("playwright-core", "minor").groupName, "all non-major dependencies");
});

test("only the image skips the release-age wait; the npm packages keep it", () => {
  assert.equal(settingsFor(IMAGE, "patch").minimumReleaseAge, null);
  assert.equal(settingsFor("playwright", "patch").minimumReleaseAge, undefined);
  assert.equal(settingsFor("@playwright/test", "patch").minimumReleaseAge, undefined);
  const lift = rules.filter((x) => x.minimumReleaseAge === null && x.matchDepNames);
  assert.deepEqual(lift.map((x) => x.matchDepNames), [[IMAGE]]);
});

test("the group sits after the generic grouping rules, so it wins", () => {
  const group = rules.findIndex((x) => x.groupName === "playwright");
  assert.ok(group > rules.findIndex((x) => x.groupName === "all non-major dependencies"));
  assert.ok(group > rules.findIndex((x) => x.groupName === "{{manager}} major dependencies"));
});
