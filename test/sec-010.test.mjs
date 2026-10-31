// SEC-010: a pull request into a public org repo adds a name on the private list (DOM-1643).
// public-names.json holds salted hashes only, so this file names nobody either: the canary is
// built at run time, and the git fixtures use made-up names (test/fixtures.mjs TEST_NAMES).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../lib/engine.mjs";
import { nameFormsOfLine, nameHash, addedLinesOf, pullRequestAdditions } from "../lib/rules.mjs";
import { TEST_NAMES } from "./fixtures.mjs";

const rulebook = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const LIST = JSON.parse(readFileSync(new URL("../public-names.json", import.meta.url), "utf8"));
const view = { workflows: [], vercel: [], files: {} };
const base = { today: "2026-11-01", kind: "dd-tooling", visibility: "public", repo: "Doman-Digital/demo", repoName: "demo", budget: { ghCrons: [], vercelCrons: [] }, meta: null, taxonomy };
const sec010 = (ctx) => runDoctor(view, rulebook, { ...base, ...ctx }).findings.filter((f) => f.rule === "SEC-010");

// Built at run time, so no file holds the canary as a word.
const CANARY = "yieckilotehrphdyxc".split("").reverse().join("");

test("public-names.json is hashes and allow entries with reasons, nothing else, and goes red on the canary", () => {
  assert.deepEqual(Object.keys(LIST).sort(), ["$comment", "allow", "canary", "hashes", "recipe", "salt"]);
  assert.ok(LIST.hashes.length > 20);
  for (const h of LIST.hashes) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(nameHash(LIST.salt, CANARY), LIST.canary);
  assert.ok(LIST.hashes.includes(LIST.canary));
  for (const a of LIST.allow) assert.ok(a.reason && a.repo && (a.path || a.line), JSON.stringify(a));
  const found = sec010({ added: [{ file: "docs/notes.md", line: 4, text: `A line that names ${CANARY.toUpperCase()} once.` }] });
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 4);
  assert.deepEqual(sec010({ added: [{ file: "docs/notes.md", line: 4, text: "A two-chair studio above the bakery, and a plumber on call until 10pm." }] }), []);
});

test("the forms: spaced, hyphenated, run together, possessive, and \"and\" dropped before pairing", () => {
  for (const s of ["Quillon Plumbing", "quillon-plumbing", "QuillonPlumbing", "Quillon Plumbing's van", "quillon and plumbing"]) {
    assert.ok(nameFormsOfLine(s).some((f) => TEST_NAMES.hashes.includes(nameHash(TEST_NAMES.salt, f))), s);
  }
  assert.ok(!nameFormsOfLine("quillons plumb").some((f) => TEST_NAMES.hashes.includes(nameHash(TEST_NAMES.salt, f))));
});

test("SEC-010 checks public Doman-Digital repos only, and an allow entry covers only its repo, path and line", () => {
  const added = [{ file: "owners.yml", line: 2, text: "  - zedora" }];
  const ctx = { publicNames: TEST_NAMES, added };
  assert.deepEqual(sec010(ctx), [], "the allowlisted data key");
  assert.equal(sec010({ ...ctx, repo: "Doman-Digital/other" }).length, 1, "the same line in another repo");
  assert.equal(sec010({ ...ctx, added: [{ file: "owners.yml", line: 2, text: "# zedora runs this" }] }).length, 1, "prose in the same file");
  assert.deepEqual(sec010({ ...ctx, repo: "someclient/site", added: [{ file: "README.md", line: 1, text: "Zedora" }] }), [], "a client's own repo: PUB-002 in the registry");
  assert.deepEqual(sec010({ ...ctx, visibility: "private", added: [{ file: "README.md", line: 1, text: "Zedora" }] }), [], "private repos are not in scope");
});

function prRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sec-010-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir, encoding: "utf8" });
  const commit = (path, text, msg) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q", "-b", "main");
  const baseSha = commit("README.md", "# Demo\n", "start");
  git("checkout", "-qb", "topic");
  return { dir, git, commit, baseSha };
}

test("from the checkout: a name in an added line, an added path or a commit message fails; the base's own lines do not count", () => {
  const { dir, git, commit, baseSha } = prRepo();
  commit("notes.md", "first\nBuilt for Quillon Plumbing.\n", "notes");
  commit("calibration/zedora/home.html", "<p>home</p>\n", "capture");
  const head = commit("plain.md", "plain\n", "tidy for zedora");
  const found = sec010({ publicNames: TEST_NAMES, dir, pr: { title: "Notes", body: "Part of DOM-1", branch: "topic", base: baseSha, head } });
  const where = found.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}`).sort();
  assert.equal(where.length, 3, where.join(", "));
  assert.ok(where.includes("notes.md:2"));
  assert.ok(where.includes("calibration/zedora/home.html"));
  assert.ok(where.some((w) => /^\(commit [0-9a-f]+ message\):1$/.test(w)));
  // The title counts too; a clean pull request passes.
  assert.equal(sec010({ publicNames: TEST_NAMES, added: pullRequestAdditions({ dir, pr: { title: "For Zedora", body: "", base: head, head } }) }).length, 1);
  git("checkout", "-q", "main");
  git("checkout", "-qb", "clean");
  const clean = commit("ok.md", "a plumber in Acton\n", "add a page");
  assert.deepEqual(sec010({ publicNames: TEST_NAMES, dir, pr: { title: "A page", body: "", base: baseSha, head: clean } }), []);
});

test("a diff it cannot read fails the check: unverified is not a pass; outside a pull request it is silent", () => {
  const { dir, baseSha } = prRepo();
  const found = sec010({ publicNames: TEST_NAMES, dir, pr: { title: "x", body: "", base: baseSha, head: "f".repeat(40) } });
  assert.equal(found.length, 1);
  assert.match(found[0].message, /could not read what this pull request adds/);
  assert.deepEqual(sec010({ publicNames: TEST_NAMES, dir, pr: null }), []);
});

test("addedLinesOf reads --unified=0 hunks and new paths, and skips deletions", () => {
  const diff = "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1,2 @@\n-old\n+one\n+two\ndiff --git a/gone.md b/gone.md\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
  assert.deepEqual(addedLinesOf(diff), [{ file: "x.md", line: null, text: "x.md" }, { file: "x.md", line: 1, text: "one" }, { file: "x.md", line: 2, text: "two" }]);
});
