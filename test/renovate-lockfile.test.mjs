// Renovate PRs arrived with a lock that pnpm refused (18 November 2026, DOM-18090). With rangeStrategy
// auto, Renovate keeps an in-range update in the lock alone and runs
// `pnpm update --no-save <every pick> --lockfile-only --recursive`. In a workspace that gives one package's
// pick to every package listing the same dependency: our own monorepo site pinned @sanity/client 8.16.0
// and got 7.28.0, picked for its studio on ^7, and `pnpm install --frozen-lockfile` failed with
// ERR_PNPM_OUTDATED_LOCKFILE. Bump moves the range in package.json and rebuilds the lock with
// `pnpm install --lockfile-only`, which keeps each package's own range. Reproduced and verified by hand
// on the PR's manifests before this rule shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const rules = preset.packageRules;

// The rangeStrategy a dependency gets, read the way Renovate does: matching rules in order, later ones
// win. Repository-scoped rules are skipped, so this reads a client repo.
function rangeStrategyFor(manager, depType, depName = "some-package") {
  let out;
  for (const r of rules) {
    if (r.matchRepositories) continue;
    if (r.matchManagers && !r.matchManagers.includes(manager)) continue;
    if (r.matchDepTypes && !r.matchDepTypes.includes(depType)) continue;
    if (r.matchUpdateTypes || r.matchDepNames || r.matchDatasources) continue;
    if (r.matchPackageNames && !r.matchPackageNames.some((n) => n === depName || (n.endsWith("/**") && depName.startsWith(n.slice(0, -2))))) continue;
    if ("rangeStrategy" in r) out = r.rangeStrategy;
  }
  return out ?? preset.rangeStrategy ?? "auto";
}

test("npm dependencies, devDependencies and optionalDependencies bump their range", () => {
  for (const depType of ["dependencies", "devDependencies", "optionalDependencies"]) {
    assert.equal(rangeStrategyFor("npm", depType), "bump", depType);
  }
});

test("peer dependencies keep the default, so a shared package does not narrow what it accepts", () => {
  assert.equal(rangeStrategyFor("npm", "peerDependencies"), "auto");
});

test("the bump is scoped to the npm manager and is not set estate-wide", () => {
  assert.equal(preset.rangeStrategy, undefined, "a top-level rangeStrategy would reach composer, pep621 and peer dependencies");
  for (const manager of ["composer", "pep621", "github-actions"]) {
    assert.equal(rangeStrategyFor(manager, "dependencies"), "auto", manager);
  }
  const r = rules.filter((x) => x.rangeStrategy === "bump" && !x.matchPackageNames);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].matchManagers, ["npm"]);
  assert.ok(r[0].description.includes("DOM-18090"));
});

// Renovate 44 applies vulnerabilityAlerts with force over packageRules
// (lib/workers/repository/process/vulnerabilities.ts) and its default rangeStrategy there is
// update-lockfile (lib/config/options/index.ts), so a security PR ignores the rule above unless the
// preset sets it here. A client repo's zod security PR failed this way on 17 November 2026.
test("security branches bump too, set where Renovate reads it for them", () => {
  assert.equal(preset.vulnerabilityAlerts.rangeStrategy, "bump");
});

test("house packages keep bump", () => {
  assert.equal(rangeStrategyFor("npm", "dependencies", "@domandigital/craft"), "bump");
});
