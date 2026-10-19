import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { craftVersions, catalogueInTarball, catalogueOf, compareCatalogue, craftContext, craftFloor } from "../lib/craft.mjs";
import { runDoctor } from "../lib/engine.mjs";

const view = (files) => ({ workflows: [], vercel: [], files });

const PNPM_WORKSPACE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.9.0
        version: 5.9.3

  apps/portal:
    dependencies:
      '@domandigital/craft':
        specifier: 0.20.2
        version: 0.20.2(playwright@1.62.1)

  packages/ui:
    dependencies:
      '@domandigital/craft':
        specifier: ^0.5.0
        version: 0.5.0

  packages/linked:
    dependencies:
      '@domandigital/craft':
        specifier: workspace:^
        version: link:../craft

packages:

  '@domandigital/craft@0.9.0':
    resolution: {integrity: sha512-x}

snapshots:

  '@domandigital/sanity-copy@0.2.1(playwright@1.62.1)':
    dependencies:
      '@domandigital/craft': 0.9.0(playwright@1.62.1)
`;

const PNPM_SINGLE = `lockfileVersion: '6.0'

dependencies:
  '@domandigital/craft':
    specifier: ^0.6.0
    version: 0.6.0

packages:

  /@domandigital/craft@0.6.0:
    resolution: {integrity: sha512-x}
`;

const NPM = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "site" },
    "node_modules/@domandigital/craft": { version: "0.20.4" },
    "node_modules/@domandigital/sanity-copy/node_modules/@domandigital/craft": { version: "0.9.0" },
  },
});

test("craftVersions reads the craft each importer depends on, and only that", () => {
  assert.deepEqual(craftVersions(view({ "pnpm-lock.yaml": PNPM_WORKSPACE })), [
    { version: "0.20.2", lockfile: "pnpm-lock.yaml", importer: "apps/portal" },
    { version: "0.5.0", lockfile: "pnpm-lock.yaml", importer: "packages/ui" },
  ]);
  assert.deepEqual(craftVersions(view({ "pnpm-lock.yaml": PNPM_SINGLE })), [{ version: "0.6.0", lockfile: "pnpm-lock.yaml", importer: "." }]);
  assert.deepEqual(craftVersions(view({ "package-lock.json": NPM })), [{ version: "0.20.4", lockfile: "package-lock.json", importer: "." }]);
  assert.deepEqual(craftVersions(view({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      zod:\n        specifier: ^4\n        version: 4.1.0\n" })), []);
});

/** A one-file tar.gz, as npm publishes. */
function tgz(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("catalogueInTarball finds CATALOGUE_VERSION in dist/, or null before there was one", () => {
  const tarball = tgz({ "package/README.md": 'CATALOGUE_VERSION = "1999.01.1"', "package/dist/chunk-A.js": 'var x = 1;\nvar CATALOGUE_VERSION = "2026.10.3";\n' });
  assert.equal(catalogueInTarball(tarball), "2026.10.3");
  assert.equal(catalogueInTarball(tgz({ "package/dist/index.js": "export {}" })), null);
});

test("catalogueOf downloads once per version, then answers from the cache", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(url, "https://registry.npmjs.org/@domandigital/craft/-/craft-0.20.5.tgz");
    const body = tgz({ "package/dist/a.js": 'const CATALOGUE_VERSION = "2026.10.3";' });
    return { ok: true, arrayBuffer: async () => body };
  };
  const cache = {};
  assert.equal(await catalogueOf("0.20.5", { fetchImpl, cache }), "2026.10.3");
  assert.equal(await catalogueOf("0.20.5", { fetchImpl, cache }), "2026.10.3");
  assert.equal(calls, 1);
  const none = async () => ({ ok: true, arrayBuffer: async () => tgz({ "package/dist/a.js": "" }) });
  assert.equal(await catalogueOf("0.5.0", { fetchImpl: none, cache: {} }), "none");
});

test("catalogues compare as numbers", () => {
  assert.ok(compareCatalogue("2026.10.10", "2026.10.3") > 0);
  assert.ok(compareCatalogue("2026.09.12", "2026.10.3") < 0);
  assert.equal(compareCatalogue("2026.10.3", "2026.10.3"), 0);
});

test("floors.json carries the craft floor", () => {
  const floor = craftFloor(readFileSync(new URL("../floors.json", import.meta.url), "utf8"));
  assert.match(floor.minCatalogue, /^\d{4}\.\d{2}\.\d+$/);
});

test("npm unreachable: PKG-001 is not checked, and the doctor says so", async () => {
  const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
  const failing = async () => ({ ok: false, status: 503 });
  const craft = await craftContext(view({ "pnpm-lock.yaml": PNPM_SINGLE }), '{"@domandigital/craft":{"minCatalogue":"2026.10.3"}}', { fetchImpl: failing, cache: {} });
  assert.match(craft.error, /HTTP 503/);
  const r = runDoctor(view({}), rulebook, { today: "2027-01-15", kind: "dd-tooling", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, craft });
  assert.ok(!r.findings.some((f) => f.rule === "PKG-001"));
  assert.ok(r.notes.some((n) => /PKG-001 was not checked/.test(n)));
  assert.equal(await craftContext(view({}), "{}"), null);
});
