// Which @domandigital/craft catalogue a repo runs, for PKG-001.
//
// Rules never touch the network (lib/view.mjs), so this runs before them and
// its answer goes in the context as ctx.craft, as the repo settings go in as
// ctx.meta. Three steps:
//
//   1. craftVersions(view): the craft versions the lockfile resolves for the
//      repo's own package.json files (pnpm importers, npm workspaces). A craft
//      that another package pulls in is not the one copy-check runs, so it is
//      left out.
//   2. catalogueOf(version): the catalogue that release carries. A published
//      tarball never changes, so the answer is cached for good. craft writes
//      it as `CATALOGUE_VERSION = "2026.10.3"` in dist/; a release older than
//      the catalogue (before 0.6.0) has none.
//   3. the floor: floors.json in this repo, the oldest catalogue copy-check
//      trusts.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

export const CRAFT = "@domandigital/craft";
const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** `2026.10.10` sorts after `2026.10.3`: compare as numbers, as copy-check does. */
export function compareCatalogue(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** [{ version, lockfile, importer }] for every direct dependency on craft. */
export function craftVersions(view) {
  const out = [];
  const pnpm = view.files["pnpm-lock.yaml"];
  if (pnpm) out.push(...fromPnpm(pnpm));
  const npm = view.files["package-lock.json"];
  if (npm) out.push(...fromNpm(npm));
  return out;
}

function fromPnpm(text) {
  // importers:            (pnpm 7+; a single project has none, and its
  //   apps/portal:         dependencies sit at the top level instead)
  //     dependencies:
  //       '@domandigital/craft':
  //         specifier: 0.20.2
  //         version: 0.20.2(playwright@1.62.1)
  const lines = text.split("\n");
  const found = [];
  const hasImporters = lines.some((l) => /^importers:\s*$/.test(l));
  let section = null;
  let importer = hasImporters ? null : ".";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const top = /^(\S[^:]*):/.exec(l);
    if (top) {
      section = top[1];
      continue;
    }
    if (hasImporters && section === "importers") {
      const imp = /^ {2}(\S[^:]*):\s*$/.exec(l);
      if (imp) importer = imp[1].replace(/^['"]|['"]$/g, "");
    } else if (hasImporters || !/^(dependencies|devDependencies|optionalDependencies)$/.test(section || "")) {
      continue;
    }
    const indent = hasImporters ? 6 : 2;
    const key = new RegExp(`^ {${indent}}['"]?${CRAFT.replace("/", "\\/")}['"]?:\\s*(\\S.*)?$`).exec(l);
    if (!key) continue;
    let version = key[1] || null;
    for (let j = i + 1; !version && j < lines.length && lines[j].startsWith(" ".repeat(indent + 2)); j++) {
      const v = /^\s+version:\s*['"]?([^'"\s]+)/.exec(lines[j]);
      if (v) version = v[1];
    }
    version = (version || "").replace(/\(.*$/, "").replace(/^['"]|['"]$/g, "");
    if (SEMVER.test(version)) found.push({ version, lockfile: "pnpm-lock.yaml", importer });
  }
  return found;
}

function fromNpm(text) {
  // "packages": { "node_modules/@domandigital/craft": { "version": ... },
  //               "apps/portal/node_modules/@domandigital/craft": ... }
  // A craft nested under another package's node_modules is that package's.
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return [];
  }
  const found = [];
  for (const [path, pkg] of Object.entries(lock.packages || {})) {
    const m = new RegExp(`^(?:(.*)/)?node_modules/${CRAFT}$`).exec(path);
    if (!m || (m[1] && m[1].includes("node_modules")) || !SEMVER.test(pkg?.version || "")) continue;
    found.push({ version: pkg.version, lockfile: "package-lock.json", importer: m[1] || "." });
  }
  if (!found.length && lock.dependencies?.[CRAFT]?.version && SEMVER.test(lock.dependencies[CRAFT].version)) {
    found.push({ version: lock.dependencies[CRAFT].version, lockfile: "package-lock.json", importer: "." });
  }
  return found;
}

/** The catalogue in a craft tarball's dist/, or null when it carries none. */
export function catalogueInTarball(tgz) {
  const tar = gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const body = off + 512;
    if (/^package\/dist\/.*\.(c|m)?js$/.test(name)) {
      const m = /CATALOGUE_VERSION\s*=\s*["'](\d{4}\.\d{2}\.\d+)["']/.exec(tar.subarray(body, body + size).toString("utf8"));
      if (m) return m[1];
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

const cacheFile = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "dd-ci-standards", "craft-catalogues.json");

function readCache() {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    mkdirSync(join(cacheFile(), ".."), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // A cache that cannot be written costs one download next time, nothing else.
  }
}

/** The catalogue a craft release carries ("none" before there was one). Throws when npm cannot be read. */
export async function catalogueOf(version, { fetchImpl = fetch, cache = readCache() } = {}) {
  if (cache[version]) return cache[version];
  const url = `https://registry.npmjs.org/${CRAFT}/-/craft-${version}.tgz`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const catalogue = catalogueInTarball(Buffer.from(await res.arrayBuffer())) || "none";
  cache[version] = catalogue;
  writeCache(cache);
  return catalogue;
}

/** The floor from floors.json: { minCatalogue, source }. */
export function craftFloor(floorsText) {
  const entry = JSON.parse(floorsText)[CRAFT];
  if (!entry?.minCatalogue) throw new Error(`floors.json has no ${CRAFT} minCatalogue`);
  return entry;
}

/**
 * ctx.craft for runDoctor: { floor, versions: [{ version, catalogue, lockfile, importer }] },
 * or { error } when a catalogue could not be read. null when the repo does not depend on craft.
 */
export async function craftContext(view, floorsText, opts = {}) {
  const deps = craftVersions(view);
  if (!deps.length) return null;
  try {
    const floor = craftFloor(floorsText).minCatalogue;
    const versions = [];
    for (const d of deps) versions.push({ ...d, catalogue: await catalogueOf(d.version, opts) });
    return { floor, versions };
  } catch (err) {
    return { error: err.message };
  }
}
