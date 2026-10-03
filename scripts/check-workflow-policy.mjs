#!/usr/bin/env node
// Deprecated entry point, kept so an old checkout that calls it still works.
// The checks moved to lib/rules.mjs and run through `dd doctor` (bin/dd.mjs),
// with ids, dates and exemptions from rules.json. This runs the doctor on the
// given repo; the budget path argument is ignored (budget.yml beside bin/).
//
// Usage: node scripts/check-workflow-policy.mjs <path-to-checked-out-repo> [<budget.yml>]

import { main } from "../bin/dd.mjs";

const [, , repoRoot] = process.argv;
if (!repoRoot) {
  console.error("usage: check-workflow-policy.mjs <repo-root>");
  process.exit(2);
}
process.exit(await main(["doctor", repoRoot, "--format", "github"]));
