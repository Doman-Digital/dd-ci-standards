import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = new URL("../.github/workflows/post-deploy-checks.yml", import.meta.url);
const text = readFileSync(file, "utf8");
const script = text.split("        run: |\n")[1] ?? "";

test("post-deploy-checks: the script is found", () => {
  assert.ok(script.includes("/run"), "run script missing");
});

test("post-deploy-checks: no expression is spliced into the shell script", () => {
  assert.equal(/\$\{\{/.test(script), false);
});

test("post-deploy-checks: the token never reaches an argument, trace or echo", () => {
  assert.equal(/set -x|set -o xtrace/.test(script), false);
  assert.equal(/--header\s+['"]?Authorization/i.test(script), false, "token must go through --config stdin");
  assert.equal(/echo[^\n]*ADMIN_RUN_TOKEN/.test(script), false);
  assert.equal(/\bcat\b[^\n]*"\$out"/.test(script), false, "the response body must not be printed");
});

test("post-deploy-checks: the secret is optional and the job cannot fail the deploy", () => {
  assert.match(text, /ADMIN_RUN_TOKEN:\n\s+description:[^\n]*\n\s+required: false/);
  assert.match(text, /timeout-minutes: \d+/);
  assert.equal(/continue-on-error/.test(text), false);
  assert.ok(script.trimEnd().endsWith("exit 0"));
  assert.equal(/\bexit [1-9]/.test(script), false);
});
