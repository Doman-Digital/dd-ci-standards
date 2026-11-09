import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../.github/workflows/playwright-journeys.yml", import.meta.url), "utf8");
/** Every `run: |` block, so a test can read the shell the runner executes. */
const scripts = text.split(/\n\s+run: \|\n/).slice(1).map((block) => block.split(/\n\s{6}- /)[0]);

test("playwright-journeys: no expression is spliced into a shell script", () => {
  assert.ok(scripts.length >= 5, "run blocks missing");
  for (const s of scripts) assert.equal(/\$\{\{/.test(s), false, s.slice(0, 80));
});

test("playwright-journeys: the secrets are optional, never echoed or traced", () => {
  for (const name of ["ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET", "API_KEY"])
    assert.match(text, new RegExp(`\\n      ${name}:\\n\\s+description:[^\\n]*\\n\\s+required: false`));
  for (const s of scripts) {
    assert.equal(/set -x|set -o xtrace/.test(s), false);
    // A value is printed only by expanding its variable; naming the secret in a message is fine.
    assert.equal(/(echo|printf)[^\n]*\$\{?(JOURNEY_)?(ACCESS_CLIENT_(ID|SECRET)|API_KEY)\b/.test(s), false);
  }
});

test("playwright-journeys: a gated run without its token stops before the suite", () => {
  const order = ["Refuse a gated run without its Access token", "Walk the journeys"].map((n) => text.indexOf(`name: ${n}`));
  assert.ok(order[0] > 0 && order[0] < order[1]);
  assert.match(text, /A login page is not a capture/);
});

test("playwright-journeys: the plain env lines cannot set the secret variables", () => {
  assert.match(text, /JOURNEY_ACCESS_\*\|JOURNEY_API_KEY/);
});

test("playwright-journeys: missing captures fail, and the artefact is kept on failure", () => {
  assert.match(text, /name: Fail when the captures are missing\n\s+if: always\(\)/);
  assert.match(text, /"\$count" -lt "\$MIN"[\s\S]*exit 1/);
  assert.match(text, /upload-artifact@[0-9a-f]{40}[^\n]*\n\s+with:[\s\S]*if-no-files-found: error/);
  assert.match(text, /name: Keep the captures, including a failed run's\n\s+if: always\(\)/);
});

test("playwright-journeys: a newer run never cancels one mid-booking", () => {
  assert.match(text, /cancel-in-progress: false/);
  assert.equal(/cancel-in-progress: true/.test(text), false);
});
