import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkRepoMetadata } from "./repo-metadata-rules.mjs";

const taxonomy = JSON.parse(readFileSync(new URL("../repo-topics.json", import.meta.url), "utf8"));
const ok = { description: "The website for a client.", topics: ["client-site", "live", "client-acme", "doman-digital", "nextjs"] };
const check = (over) => checkRepoMetadata({ ...ok, ...over }, taxonomy);

test("a compliant repo passes", () => assert.deepEqual(check({}), []));
test("a personal repo passes without doman-digital", () =>
  assert.deepEqual(check({ topics: ["personal", "in-use", "python"] }), []));

// Each rule proved able to fail on a deliberate violation.
const cases = [
  ["no description", { description: "" }, /no description/],
  ["em dash", { description: "A site — for a client." }, /dash/],
  ["too long", { description: "x".repeat(351) }, /limit is 350/],
  ["no tags", { topics: [] }, /no tags/],
  ["no kind", { topics: ["live", "client-acme", "doman-digital"] }, /exactly one kind/],
  ["two kinds", { topics: ["client-site", "sales-demo", "live", "client-acme", "doman-digital"] }, /exactly one kind/],
  ["no status", { topics: ["client-site", "client-acme", "doman-digital"] }, /exactly one status/],
  ["unknown tag", { topics: [...ok.topics, "wordpress"] }, /not in repo-topics.json/],
  ["bad format", { topics: [...ok.topics, "Next.js"] }, /lowercase/],
  ["client kind without client tag", { topics: ["client-site", "live", "doman-digital"] }, /client-<name>/],
  ["business repo without doman-digital", { topics: ["client-site", "live", "client-acme"] }, /needs the doman-digital/],
  ["personal repo with doman-digital", { topics: ["personal", "in-use", "doman-digital"] }, /must not carry/],
  ["duplicates", { topics: [...ok.topics, "nextjs"] }, /duplicate/],
];
for (const [name, over, re] of cases) {
  test(`fails: ${name}`, () => {
    const problems = check(over);
    assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);
  });
}
