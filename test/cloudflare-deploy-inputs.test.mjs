import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// DOM-1490: the site's production Worker is `env.production` of a config that also holds a preview, and it checks
// the live site after the deploy. Both need an input of the shared workflow; if one goes, the site deploys the
// preview over its own name or stops checking what it shipped.

const WORKFLOW = readFileSync(new URL("../.github/workflows/cloudflare-deploy.yml", import.meta.url), "utf8");

test("wrangler-env reaches the deploy and the secret sync as CLOUDFLARE_ENV, and only when set", () => {
  assert.match(WORKFLOW, /\n {6}wrangler-env:\n/);
  assert.equal(WORKFLOW.match(/WRANGLER_ENV: \$\{\{ inputs\.wrangler-env \}\}/g)?.length, 2, "the sync step and the deploy step");
  assert.equal(WORKFLOW.match(/if \[ -n "\$WRANGLER_ENV" \]; then export CLOUDFLARE_ENV="\$WRANGLER_ENV"; fi/g)?.length, 2);
  // An empty CLOUDFLARE_ENV would be an environment named "", so it is never set to the empty string.
  assert.doesNotMatch(WORKFLOW, /CLOUDFLARE_ENV: \$\{\{/);
});

test("post-deploy runs after the last deploy, on a deploying run only, with the commit", () => {
  assert.match(WORKFLOW, /\n {6}post-deploy:\n/);
  const deploy = WORKFLOW.indexOf("      - name: Deploy\n");
  const post = WORKFLOW.indexOf("      - name: Post-deploy check\n");
  assert.ok(deploy > 0 && post > deploy, "after the deploy step");
  const step = WORKFLOW.slice(post, WORKFLOW.indexOf("\n  # The deploy job's tip guard"));
  assert.match(step, /steps\.tip\.outputs\.deploy == 'true' && inputs\.post-deploy != ''/);
  assert.match(step, /DEPLOY_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
});
