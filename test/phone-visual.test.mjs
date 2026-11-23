// The phone screenshot check (.github/workflows/phone-visual.yml, visual/): what a caller relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(new URL("../.github/workflows/phone-visual.yml", import.meta.url), "utf8");
const spec = readFileSync(new URL("../visual/phone.spec.mjs", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../visual/package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../visual/package-lock.json", import.meta.url), "utf8"));

test("phone-visual builds the base and the pull request in one run, and keeps no baseline in the caller", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /VISUAL_PHASE=base[^\n]*--update-snapshots/);
  assert.match(workflow, /VISUAL_PHASE=head[^\n]*playwright test -c playwright\.config\.mjs \|\| status=\$\?/);
  // An intended change is approved by a label, and the run still reports it.
  assert.match(workflow, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'visual-change'\)/);
  // Its own tooling is pinned exactly and locked, so a caller's run cannot drift with a release of either.
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} is locked at ${version}`);
  }
});

test("phone-visual fails a new layout fault only, and measures with craft's own phone measure", () => {
  assert.match(spec, /from "@domandigital\/craft\/phone"/);
  assert.match(spec, /new Set\(\["scroll", "rowscroll"\]\)/);
  assert.match(spec, /!before\.has/);
});

test("serve.mjs answers a page as its file, as <path>.html and as <path>/index.html, and nothing outside the site", async () => {
  const dir = mkdtempSync(join(tmpdir(), "visual-serve-"));
  writeFileSync(join(dir, "index.html"), "home");
  writeFileSync(join(dir, "about.html"), "about");
  mkdirSync(join(dir, "journal"));
  writeFileSync(join(dir, "journal", "index.html"), "journal");
  const port = 4700 + Math.floor(Math.random() * 200);
  const server = spawn(process.execPath, [new URL("../visual/serve.mjs", import.meta.url).pathname, dir, String(port)], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 400));
    const get = async (p) => { const res = await fetch(`http://127.0.0.1:${port}${p}`); return `${res.status} ${await res.text()}`; };
    assert.equal(await get("/"), "200 home");
    assert.equal(await get("/about"), "200 about");
    assert.equal(await get("/journal"), "200 journal");
    assert.equal(await get("/missing"), "404 not found");
    assert.match(await get("/..%2f..%2fetc%2fpasswd"), /^40[34]/);
  } finally {
    server.kill();
  }
});
