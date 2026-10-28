import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grantsByProject } from "../lib/doppler-grants.mjs";

// DOM-1498: Doppler replaces a member's environment list on each grant, so two
// configs in one project must go in one grant or the first is lost.

test("configs in one project are granted together", () => {
  assert.deepEqual(
    grantsByProject(["dd-deploy/meridian-api", "dd-deploy/meridian-web", "meridian-api/prd", "meridian-web/prd"]),
    [
      { project: "dd-deploy", environments: ["meridian-api", "meridian-web"] },
      { project: "meridian-api", environments: ["prd"] },
      { project: "meridian-web", environments: ["prd"] },
    ],
  );
});

test("every row's reads survive grouping", () => {
  const { identities } = JSON.parse(readFileSync(new URL("../doppler-identities.json", import.meta.url), "utf8"));
  for (const row of identities) {
    const granted = grantsByProject(row.reads).flatMap(({ project, environments }) => environments.map((e) => `${project}/${e}`));
    assert.deepEqual(granted.sort(), [...new Set(row.reads)].sort(), row.repo);
  }
});

test("the script grants through grantsByProject", () => {
  const script = readFileSync(new URL("../bin/doppler-identity.mjs", import.meta.url), "utf8");
  assert.match(script, /for \(const \{ project, environments \} of grantsByProject\(row\.reads\)\)/);
  assert.doesNotMatch(script, /environments: \[config\]/);
});
