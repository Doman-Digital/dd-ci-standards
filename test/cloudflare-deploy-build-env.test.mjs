import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// DOM-1644: a site that bakes secrets into its pages at build time (a shop build: the Shopify store domain
// and storefront token, analytics tags) lists their names in build-env-names. They come from the same Doppler config as
// the deploy token, and only those names reach the build. Run the real step script, not a copy of it.

const WORKFLOW = readFileSync(new URL("../.github/workflows/cloudflare-deploy.yml", import.meta.url), "utf8");
const STEP = WORKFLOW.slice(WORKFLOW.indexOf("      - name: Export the build environment\n"), WORKFLOW.indexOf("      - name: Build\n"));
const SCRIPT = STEP.split("run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n").trim();

function run(names, fetched) {
  const dir = mkdtempSync(join(tmpdir(), "build-env-"));
  try {
    const out = join(dir, "github_env");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", SCRIPT], {
      env: { ...process.env, NAMES: names, FETCHED: JSON.stringify(fetched), GITHUB_ENV: out },
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, env: readFileSync(out, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The file-command format GitHub reads: NAME<<delimiter, the value, the delimiter.
const parse = (text) => {
  const found = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Z][A-Z0-9_]*)<<(\S+)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (i++; lines[i] !== m[2]; i++) body.push(lines[i]);
    found[m[1]] = body.join("\n");
  }
  return found;
};

test("only the listed names are exported, values intact, and the rest of the config is not", () => {
  const r = run("SHOPIFY_STORE_DOMAIN\n  NEXT_PUBLIC_GA_MEASUREMENT_ID \n\n", {
    SHOPIFY_STORE_DOMAIN: "shop.myshopify.com",
    NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-TEST123456",
    CLOUDFLARE_DEPLOY_VALUE: "must-not-reach-the-build",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(r.env), { SHOPIFY_STORE_DOMAIN: "shop.myshopify.com", NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-TEST123456" });
  assert.doesNotMatch(r.env, /CLOUDFLARE_DEPLOY_VALUE|must-not-reach/);
  assert.match(r.stdout, /::add-mask::shop\.myshopify\.com/);
  assert.doesNotMatch(r.stdout, /must-not-reach/);
});

test("a multi-line value cannot start a second variable in the job environment", () => {
  const r = run("SHOPIFY_STORE_DOMAIN", { SHOPIFY_STORE_DOMAIN: "a.myshopify.com\nEVIL=1" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(r.env), { SHOPIFY_STORE_DOMAIN: "a.myshopify.com\nEVIL=1" });
});

test("a name the config does not hold, or holds empty, fails the run and exports nothing", () => {
  for (const fetched of [{ A_B: "x" }, { A_B: "x", C_D: "" }]) {
    const r = run("A_B\nC_D", fetched);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Doppler has no value for build-env-names: C_D/);
    assert.equal(r.env, "");
  }
});

test("a name that is not UPPER_SNAKE_CASE is refused, so a name cannot smuggle in a variable such as PATH=", () => {
  for (const name of ["lower", "A-B", "A=1", "1A"]) {
    const r = run(name, { [name]: "x" });
    assert.notEqual(r.status, 0, name);
    assert.equal(r.env, "");
  }
});

test("the build environment is fetched and exported after pre-deploy and before the build, on a deploying run only", () => {
  assert.match(WORKFLOW, /\n {6}build-env-names:\n/);
  assert.doesNotMatch(WORKFLOW, /build-env-(project|config)/, "one config: the one the deploy token is in");
  const pre = WORKFLOW.indexOf("      - name: Pre-deploy check\n");
  const fetch = WORKFLOW.indexOf("      - name: Fetch the build environment from Doppler\n");
  const exp = WORKFLOW.indexOf("      - name: Export the build environment\n");
  const build = WORKFLOW.indexOf("      - name: Build\n");
  assert.ok(pre > 0 && fetch > pre && exp > fetch && build > exp);
  for (const part of [WORKFLOW.slice(fetch, exp), WORKFLOW.slice(exp, build)]) {
    assert.match(part, /steps\.tip\.outputs\.deploy == 'true' && inputs\.build-env-names != ''/);
  }
  assert.match(WORKFLOW.slice(fetch, exp), /doppler-project: \$\{\{ inputs\.doppler-project \}\}\n\s+doppler-config: \$\{\{ inputs\.doppler-config \}\}/);
});
