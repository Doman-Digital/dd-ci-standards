// CI-046: a page that loads Square's card form must be served a policy that lets the bank's 3-D Secure frame and form post through (DOM-930).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runDoctor } from "../lib/engine.mjs";
import { cspDirectives, stackedHeaderBlocks } from "../lib/rules.mjs";
import { loadFsView } from "../lib/view.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const base = { today: "2027-01-15", kind: "client-site", visibility: "private", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null };
const found = (view) => runDoctor({ workflows: [], vercel: [], files: {}, ...view }, rulebook, base).findings.filter((f) => f.rule === "CI-046");
const LOADER = { path: "src/booking.ts", text: "load('https://web.squarecdn.com/v1/square.js')\n" };
const withPolicy = (path, text) => ({ csp: [LOADER, { path, text }] });

test("a repo that does not load the SDK is never read", () => {
  assert.deepEqual(found({ csp: [{ path: "csp.ts", text: "frame-src 'self'; form-action 'self'" }] }), []);
  assert.deepEqual(found({}), []);
});

test("a repo that loads the SDK but defines no policy has nothing blocking it", () => {
  assert.deepEqual(found({ csp: [LOADER] }), []);
});

test("a one-line generated string, with https: in both directives, passes; without it, fails", () => {
  const ok = `export const mainCsp = "default-src 'self'; frame-src 'self' https://a.test https:; form-action 'self' https:; media-src 'self';";`;
  const bad = `export const mainCsp = "default-src 'self'; frame-src 'self' https://*.squareup.com; form-action 'self' https://a.test;";`;
  assert.equal(found(withPolicy("csp-generated.mjs", ok)).length, 0);
  assert.equal(found(withPolicy("csp-generated.mjs", bad)).length, 1);
});

test("a template literal with the value on the next lines is read to its semicolon", () => {
  const ok = "return `\n  frame-src\n    'self'\n    https://x.test\n    https:;\n  form-action\n    'self'\n    https:;\n`;";
  const bad = "return `\n  frame-src\n    'self'\n    https://x.test;\n  form-action\n    'self'\n    https:;\n`;";
  assert.equal(found(withPolicy("csp.ts", ok)).length, 0);
  assert.equal(found(withPolicy("csp.ts", bad)).length, 1);
});

test("https://host is not the bare https: source", () => {
  assert.equal(found(withPolicy("csp.mjs", `const c = "frame-src 'self' https://a.test; form-action 'self' https://a.test";`)).length, 1);
  assert.equal(found(withPolicy("csp.json", `{"c":"frame-src 'self' https:\\/\\/a.test; form-action 'self'"}`)).length, 1);
});

test("an absent form-action restricts nothing; an absent frame-src falls back to default-src", () => {
  assert.equal(found(withPolicy("csp.mjs", `const c = "frame-src 'self' https:";`)).length, 0);
  assert.equal(found(withPolicy("csp.mjs", `const c = "default-src 'self'; form-action 'self' https:";`)).length, 1);
  assert.equal(found(withPolicy("csp.mjs", `const c = "default-src 'self' https:; form-action 'self' https:";`)).length, 0);
});

test("the flag-variable shape: a directive ending in a variable that holds https:", () => {
  const ok = `const challenge = on ? " https:" : "";\nconst a = ["frame-src 'self'" + challenge, "form-action 'self'" + challenge];`;
  const tpl = "const c = on ? ' https:' : '';\nconst a = `frame-src 'self'${c}; form-action 'self'${c}`;";
  const bad = `const challenge = on ? " x" : "";\nconst a = ["frame-src 'self'" + challenge, "form-action 'self'" + challenge];`;
  assert.equal(found(withPolicy("p.mjs", ok)).length, 0);
  assert.equal(found(withPolicy("p.mjs", tpl)).length, 0);
  assert.equal(found(withPolicy("p.mjs", bad)).length, 1);
});

test("comments, docs and tests are not policies and not loaders", () => {
  assert.equal(found(withPolicy("p.mjs", `// frame-src 'self' https:\nconst c = "frame-src 'self'; form-action 'self' https://a.test";`)).length, 1);
  assert.deepEqual(found({ csp: [{ path: "src/a.test.ts", text: LOADER.text }, { path: "p.mjs", text: `const c = "frame-src 'self'";` }] }), []);
  assert.equal(found(withPolicy("docs/csp.md", `frame-src 'self' https:; form-action https:`)).length, 1 - 1 + 0);
  assert.equal(found(withPolicy("tests/p.mjs", `const c = "frame-src 'self' https:; form-action 'self' https:";`)).length, 0);
});

const HEADERS_STACKED = "/*\n  Content-Security-Policy: default-src 'self'\n  X-Frame-Options: DENY\n\n/book\n  Content-Security-Policy: frame-src https:; form-action https:\n";
const HEADERS_DETACHED = "/*\n  Content-Security-Policy: default-src 'self'\n\n/book\n  ! Content-Security-Policy\n  Content-Security-Policy: frame-src https:; form-action https:\n";

test("a _headers file with a second policy on /book needs the detach", () => {
  assert.deepEqual(stackedHeaderBlocks(HEADERS_STACKED), ["/book"]);
  assert.deepEqual(stackedHeaderBlocks(HEADERS_DETACHED), []);
  assert.deepEqual(stackedHeaderBlocks("/a\n  Content-Security-Policy: x\n\n/b\n  Content-Security-Policy: y\n"), []);
  assert.deepEqual(stackedHeaderBlocks("/app/*\n  Content-Security-Policy: x\n\n/app/pay\n  Content-Security-Policy: y\n"), ["/app/pay"]);
  assert.equal(found(withPolicy("public/_headers", HEADERS_STACKED)).length, 1);
  assert.equal(found(withPolicy("public/_headers", HEADERS_DETACHED)).length, 0);
});

test("a script that writes _headers: two policies need one detach", () => {
  const two = `headers += block("/*", { "Content-Security-Policy": a });\nheaders += \`/book\\n  Content-Security-Policy: \${b}\\n\`;\nwriteFileSync("_headers", headers);`;
  const detached = `headers += block("/*", { "Content-Security-Policy": a });\nheaders += \`/book\\n  ! Content-Security-Policy\\n  Content-Security-Policy: \${b}\\n\`;\nwriteFileSync("_headers", headers);`;
  const policy = { path: "p.mjs", text: `const challenge = " https:"; const c = ["frame-src 'self'" + challenge, "form-action 'self'" + challenge];` };
  assert.equal(found({ csp: [LOADER, policy, { path: "scripts/postbuild.mjs", text: two }] }).length, 1);
  assert.equal(found({ csp: [LOADER, policy, { path: "scripts/postbuild.mjs", text: detached }] }).length, 0);
});

test("cspDirectives gives each directive its own value", () => {
  const d = cspDirectives(`"frame-src 'self' https://a.test",\n"form-action 'self'",`);
  assert.deepEqual(d.map((x) => x.name), ["frame-src", "form-action"]);
  assert.match(d[0].text, /a\.test/);
  assert.doesNotMatch(d[0].text, /form-action/);
});

test("loadFsView reads a real checkout, and the rule fails then passes on the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci046-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "book.ts"), LOADER.text);
  writeFileSync(join(dir, "src", "csp.mjs"), `export const csp = "frame-src 'self' https://a.test; form-action 'self'";\n`);
  git("add", "-A");
  assert.equal(found(loadFsView(dir)).length, 1);
  writeFileSync(join(dir, "src", "csp.mjs"), `export const csp = "frame-src 'self' https:; form-action 'self' https:";\n`);
  git("add", "-A");
  assert.equal(found(loadFsView(dir)).length, 0);
});
