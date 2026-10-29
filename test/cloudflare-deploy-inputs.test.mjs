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
  // `:-` because the secret-filter test runs the sync script under `set -u` without the variable.
  assert.equal(WORKFLOW.match(/if \[ -n "\$\{WRANGLER_ENV:-\}" \]; then export CLOUDFLARE_ENV="\$WRANGLER_ENV"; fi/g)?.length, 2);
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

// DOM-1644: client sites move off Workers Builds. A Sanity publish reaches the deploy as a repository_dispatch from
// dd-rebuild-relay, so the guard admits it on the default branch only, and it runs the manual checks because the
// tip's own CI run may not have finished. The Sentry release the Workers Builds deploy set travels as release-var.
test("a content rebuild deploys from the default branch only, after the manual checks", () => {
  assert.match(
    WORKFLOW,
    /\(github\.event_name == 'repository_dispatch' && github\.ref_name == github\.event\.repository\.default_branch\)/,
  );
  const checks = WORKFLOW.slice(WORKFLOW.indexOf("      - name: Manual run checks"), WORKFLOW.indexOf("      - name: Pre-deploy check"));
  assert.match(checks, /github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'repository_dispatch'/);
});

test("release-var sets one Worker variable to the deployed commit, on every config, and only when set", () => {
  assert.match(WORKFLOW, /\n {6}release-var:\n/);
  const step = WORKFLOW.slice(WORKFLOW.indexOf("      - name: Deploy\n"), WORKFLOW.indexOf("      - name: Post-deploy check\n"));
  assert.match(step, /RELEASE_VAR: \$\{\{ inputs\.release-var \}\}/);
  assert.match(step, /DEPLOY_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.match(step, /if \[ -n "\$\{RELEASE_VAR:-\}" \]; then extra=\(--var "\$\{RELEASE_VAR\}:\$\{DEPLOY_SHA\}"\); fi/);
  assert.equal(step.match(/deploy[^\n]*"\$\{extra\[@\]\}"/g)?.length, 2, "both the default config and each listed config");
});
