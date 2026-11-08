import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";

// 8 November 2026: the gitleaks release download answered 504 three times in a morning and every open pull request
// went red, as `gitleaks: command not found`. These run the real gitleaks/install.sh against a local stand-in for
// GitHub releases and ghcr.io, and against a port nothing listens on.

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "gitleaks/install.sh");
const action = readFileSync(join(ROOT, "gitleaks/action.yml"), "utf8");
const policy = readFileSync(join(ROOT, ".github/workflows/policy.yml"), "utf8");
const pin = (name) => action.match(new RegExp(`^ +${name}: "?([^"\\n]+)"?$`, "m"))[1];
const VERSION = pin("GITLEAKS_VERSION");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const run = (args, env) => new Promise((resolve) => {
  const p = spawn("bash", args, { env }); let out = "";
  p.stdout.on("data", (x) => { out += x; }); p.stderr.on("data", (x) => { out += x; });
  p.on("close", (code) => resolve({ code, out }));
});

// A fake gitleaks in each of the two shapes: the release tarball (gitleaks at the root) and the image layer
// (usr/bin/gitleaks). Different contents, as the two real builds are.
function fixtures(dir) {
  const make = (root, rel, says) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `#!/bin/sh\necho "${says}"\n`); chmodSync(join(root, rel), 0o755);
  };
  make(join(dir, "rel"), "gitleaks", "release build");
  make(join(dir, "img"), "usr/bin/gitleaks", "image build");
  execFileSync("tar", ["-czf", join(dir, "release.tgz"), "-C", join(dir, "rel"), "gitleaks"]);
  execFileSync("tar", ["-czf", join(dir, "layer.tgz"), "-C", join(dir, "img"), "usr/bin/gitleaks"]);
  const release = readFileSync(join(dir, "release.tgz")), layer = readFileSync(join(dir, "layer.tgz"));
  return { release, layer, releaseSha: sha(release), layerDigest: `sha256:${sha(layer)}`, binarySha: sha(readFileSync(join(dir, "img/usr/bin/gitleaks"))) };
}

async function withServer(handler, fn) {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); handler(req, res, hits); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, hits); } finally { await new Promise((r) => server.close(r)); }
}
async function deadUrl() {
  // A port that was free a moment ago: connection refused, as an unreachable host is.
  const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port; await new Promise((r) => s.close(r)); return `http://127.0.0.1:${port}`;
}

async function install({ release, registry, cache, fx, dir, image = `ghcr.io/gitleaks/gitleaks:v${VERSION}` }) {
  const out = join(dir, "github-output"), path = join(dir, "github-path");
  writeFileSync(out, ""); writeFileSync(path, "");
  const cacheDir = join(dir, "cache"), dest = join(dir, "dest");
  mkdirSync(cacheDir, { recursive: true });
  if (cache) writeFileSync(join(cacheDir, "gitleaks.tgz"), cache);
  const r = await run([SCRIPT], {
    PATH: process.env.PATH, HOME: process.env.HOME,
    GITLEAKS_VERSION: VERSION, GITLEAKS_SHA256: fx.releaseSha, GITLEAKS_IMAGE: image,
    GITLEAKS_IMAGE_LAYER: fx.layerDigest, GITLEAKS_IMAGE_BINARY_SHA256: fx.binarySha,
    GITLEAKS_CACHE_DIR: cacheDir, GITLEAKS_DEST: dest,
    GITLEAKS_RELEASE_BASE: release, GITLEAKS_REGISTRY: registry, GITLEAKS_RETRIES: "1",
    GITHUB_OUTPUT: out, GITHUB_PATH: path,
  });
  const bin = join(dest, "gitleaks");
  return {
    ...r, output: readFileSync(out, "utf8"), path: readFileSync(path, "utf8"),
    says: existsSync(bin) ? execFileSync(bin, { encoding: "utf8" }).trim() : null,
    cached: existsSync(join(cacheDir, "gitleaks.tgz")) ? readFileSync(join(cacheDir, "gitleaks.tgz")) : null,
  };
}

// GitHub releases and ghcr.io in one stand-in. `release` decides what the release URL answers per request.
const upstream = (fx, { release = () => [200, fx.release] } = {}) => (req, res, hits) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === `/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz`) {
    const [status, body] = release(hits.filter((h) => h.startsWith(`/v${VERSION}/`)).length);
    res.writeHead(status); res.end(body); return;
  }
  if (url.pathname === "/token") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"token":"fixture-token"}'); return; }
  if (url.pathname === `/v2/gitleaks/gitleaks/blobs/${fx.layerDigest}` && req.headers.authorization === "Bearer fixture-token") { res.writeHead(200); res.end(fx.layer); return; }
  res.writeHead(404); res.end();
};

const scratch = () => mkdtempSync(join(tmpdir(), "dd-gitleaks-"));

test("cache warm, both sources unreachable: installs from the cache and downloads nothing", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    const r = await install({ release: dead, registry: dead, cache: fx.release, fx, dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.output, /^source=cache$/m);
    assert.equal(r.says, "release build");
    assert.equal(r.path.trim(), join(dir, "dest"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cache cold, both sources unreachable: fails naming the outage and both URLs, and installs nothing", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    const r = await install({ release: dead, registry: dead, fx, dir });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /::error title=gitleaks download outage::gitleaks [\d.]+ could not be downloaded, so this pull request was not scanned for secrets/);
    assert.ok(r.out.includes(`${dead}/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz`), "names the release URL");
    assert.ok(r.out.includes(`The gitleaks image on ${dead}`), "names the registry");
    assert.ok(!/command not found/.test(r.out));
    assert.equal(r.says, null); assert.equal(r.path, ""); assert.equal(r.output, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cache cold, the release answers 504 once: the retry installs it and leaves it for the cache", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    await withServer(upstream(fx, { release: (n) => (n === 1 ? [504, "Gateway Timeout"] : [200, fx.release]) }), async (base, hits) => {
      const r = await install({ release: base, registry: dead, fx, dir });
      assert.equal(r.code, 0, r.out);
      assert.match(r.output, /^source=release$/m);
      assert.equal(hits.filter((h) => h.endsWith(".tar.gz")).length, 2, "one 504, one retry");
      assert.equal(r.says, "release build");
      assert.ok(r.cached?.equals(fx.release), "the verified tarball is where the cache saves from");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cache cold, releases unreachable: installs the pinned image build from the registry", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    await withServer(upstream(fx), async (base) => {
      const r = await install({ release: dead, registry: base, fx, dir });
      assert.equal(r.code, 0, r.out);
      assert.match(r.output, /^source=ghcr\.io image$/m);
      assert.match(r.out, /::warning title=gitleaks release download failed::/);
      assert.equal(r.says, "image build");
      assert.equal(r.cached, null, "an image build is never cached as the release tarball");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a cached tarball that is not the pinned one is thrown away and downloaded again", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    await withServer(upstream(fx), async (base) => {
      const r = await install({ release: base, registry: dead, cache: Buffer.from("not gitleaks"), fx, dir });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /::warning title=gitleaks cache discarded::/);
      assert.match(r.output, /^source=release$/m);
      assert.ok(r.cached.equals(fx.release));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a download that is not the pinned file stops: a mismatch is not an outage, so the fallback is not tried", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir);
    await withServer(upstream(fx, { release: () => [200, "tampered"] }), async (base, hits) => {
      const r = await install({ release: base, registry: base, fx, dir });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /::error title=gitleaks checksum mismatch::/);
      assert.ok(!hits.some((h) => h.startsWith("/token") || h.startsWith("/v2/")), "the registry was not asked");
      assert.equal(r.says, null); assert.equal(r.cached, null);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an image layer that is not the pinned digest stops before anything is installed", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    await withServer(upstream({ ...fx, layer: Buffer.from("tampered") }), async (base) => {
      const r = await install({ release: dead, registry: base, fx, dir });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /::error title=gitleaks checksum mismatch::/);
      assert.equal(r.says, null);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an image pin left at another version stops before any download", async () => {
  const dir = scratch();
  try {
    const fx = fixtures(dir), dead = await deadUrl();
    const r = await install({ release: dead, registry: dead, fx, dir, image: "ghcr.io/gitleaks/gitleaks:v8.0.0" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /::error title=gitleaks pins disagree::/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the action's pins agree: the cache key and the image name the installed version and sha256", () => {
  const key = action.match(/key: (gitleaks-\S+)/)[1];
  assert.equal(key, `gitleaks-${VERSION}-linux-x64-${pin("GITLEAKS_SHA256")}`);
  assert.equal(pin("GITLEAKS_IMAGE"), `ghcr.io/gitleaks/gitleaks:v${VERSION}`);
  assert.match(pin("GITLEAKS_IMAGE_LAYER"), /^sha256:[0-9a-f]{64}$/);
  assert.match(pin("GITLEAKS_IMAGE_BINARY_SHA256"), /^[0-9a-f]{64}$/);
  const caches = [...action.matchAll(/uses: (actions\/cache\/(?:restore|save))@([0-9a-f]{40}) # (v[\d.]+)/g)];
  assert.deepEqual(caches.map((m) => m[1]), ["actions/cache/restore", "actions/cache/save"]);
  assert.equal(new Set(caches.map((m) => m[2])).size, 1, "restore and save at one commit");
  assert.match(action, /if: \$\{\{ steps\.restore\.outputs\.cache-hit != 'true' && steps\.install\.outputs\.source == 'release' \}\}/);
});

test("the policy check installs through the action and scans only once gitleaks is installed", () => {
  assert.match(policy, /- name: Install gitleaks\n\s+id: gitleaks\n\s+if: \$\{\{ !cancelled\(\) \}\}\n\s+uses: Doman-Digital\/dd-ci-standards\/gitleaks@v1\n/);
  assert.match(policy, /- name: Scan the commits this pull request adds\n\s+if: \$\{\{ !cancelled\(\) && steps\.gitleaks\.outcome == 'success' \}\}\n/);
  assert.ok(!/releases\/download|GITLEAKS_SHA256/.test(policy), "one home for the pins: gitleaks/action.yml");
});
