// CI-032: how a SHA pin is resolved against the pinned repo, with GitHub faked
// from what it answered on 8 November 2026 (Doman-Digital/dd-relay#350).

import { test } from "node:test";
import assert from "node:assert/strict";
import { shaPins, resolvePins, MAX_COMPARES } from "../lib/pins.mjs";

const REPO = "Doman-Digital/dd-ci-standards";
const ORPHAN = "50504488e5f46eed1ec97ca47cdff80364e24949";
const ON_MAIN = "bc7f755aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ON_BRANCH = "feedfacefeedfacefeedfacefeedfacefeedface";

/** A fake api.github.com: answers is a map of path prefix to [status, json]; every call is recorded. */
function fake(answers) {
  const calls = [];
  const fetchFn = async (url) => {
    const path = url.replace("https://api.github.com", "");
    calls.push(path);
    const hit = Object.entries(answers).find(([p]) => path.startsWith(p));
    const [status, json] = hit ? hit[1] : [404, { message: "Not Found" }];
    return { status, json: async () => json };
  };
  return { fetchFn, calls };
}

const repoAnswers = (extra = {}) => ({
  [`/repos/${REPO}/compare/main...${ON_MAIN}`]: [200, { status: "behind" }],
  // What GitHub answers for a commit left behind by the rewrite.
  [`/repos/${REPO}/compare/main...${ORPHAN}`]: [404, { message: `No common ancestor between main and ${ORPHAN}.` }],
  [`/repos/${REPO}/compare/main...${ON_BRANCH}`]: [200, { status: "diverged" }],
  [`/repos/${REPO}/compare/b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1...${ON_BRANCH}`]: [200, { status: "identical" }],
  [`/repos/${REPO}/compare/`]: [404, { message: "No common ancestor" }],
  [`/repos/${REPO}/branches`]: [200, [{ name: "main", commit: { sha: "a0a0" } }, { name: "feature", commit: { sha: "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1" } }]],
  [`/repos/${REPO}/tags`]: [200, [{ name: "v1", commit: { sha: "a0a0" } }, { name: "v1.0.1", commit: { sha: "c2c2" } }]],
  ...extra,
  [`/repos/${REPO}`]: [200, { default_branch: "main" }],
});

const wf = (ref) => ({ workflows: [{ path: ".github/workflows/deploy.yml", text: `jobs:\n  deploy:\n    uses: ${REPO}/.github/workflows/cloudflare-deploy.yml@${ref}\n` }] });

test("shaPins reads full-SHA house pins only, from code, not comments", () => {
  const text = `jobs:\n  a:\n    uses: ${REPO}/.github/workflows/x.yml@${ORPHAN}\n  b:\n    uses: ${REPO}/.github/workflows/x.yml@v1\n  # uses: Doman-Digital/other/.github/workflows/y.yml@${ON_MAIN}\n  c:\n    steps:\n      - uses: actions/checkout@${ON_MAIN}\n`;
  assert.deepEqual(shaPins([text]), [`${REPO}@${ORPHAN}`]);
});

test("a commit no branch or tag holds is orphaned, after the branches and tags were asked", async () => {
  const { fetchFn, calls } = fake(repoAnswers());
  const pins = await resolvePins(wf(ORPHAN), { token: "t", fetchFn });
  assert.equal(pins[`${REPO}@${ORPHAN}`], "orphaned");
  assert.ok(calls.some((c) => c.includes("/compare/b1b1")), "asked the other branch");
  assert.ok(calls.some((c) => c.includes("/compare/c2c2")), "asked the tag");
});

test("a commit on the default branch is ok with one compare", async () => {
  const { fetchFn, calls } = fake(repoAnswers());
  const pins = await resolvePins(wf(ON_MAIN), { token: "t", fetchFn });
  assert.equal(pins[`${REPO}@${ON_MAIN}`], "ok");
  assert.equal(calls.filter((c) => c.includes("/compare/")).length, 1);
});

test("a commit only another branch holds is ok", async () => {
  const { fetchFn } = fake(repoAnswers());
  assert.equal((await resolvePins(wf(ON_BRANCH), { token: "t", fetchFn }))[`${REPO}@${ON_BRANCH}`], "ok");
});

test("a repo the token cannot read, or an unclear answer, is unknown, never orphaned", async () => {
  const unreadable = fake({});
  assert.equal((await resolvePins(wf(ORPHAN), { token: "t", fetchFn: unreadable.fetchFn }))[`${REPO}@${ORPHAN}`], "unknown");
  const flaky = fake(repoAnswers({ [`/repos/${REPO}/compare/main...${ORPHAN}`]: [502, null] }));
  assert.equal((await resolvePins(wf(ORPHAN), { token: "t", fetchFn: flaky.fetchFn }))[`${REPO}@${ORPHAN}`], "unknown");
  const tags = Array.from({ length: MAX_COMPARES + 5 }, (_, i) => ({ name: `v1.0.${i}`, commit: { sha: `t${i}` } }));
  const many = fake(repoAnswers({ [`/repos/${REPO}/tags`]: [200, tags] }));
  assert.equal((await resolvePins(wf(ORPHAN), { token: "t", fetchFn: many.fetchFn }))[`${REPO}@${ORPHAN}`], "unknown");
});

test("a tag pin is not asked about, and no token leaves the rule unjudged", async () => {
  const { fetchFn, calls } = fake(repoAnswers());
  assert.deepEqual(await resolvePins(wf("v1"), { token: "t", fetchFn }), {});
  assert.equal(calls.length, 0);
  assert.equal(await resolvePins(wf(ORPHAN), { token: null, fetchFn }), null);
});

test("each pin is asked once per run", async () => {
  const { fetchFn, calls } = fake(repoAnswers());
  const cache = new Map();
  await resolvePins(wf(ORPHAN), { token: "t", fetchFn, cache });
  const n = calls.length;
  await resolvePins(wf(ORPHAN), { token: "t", fetchFn, cache });
  assert.equal(calls.length, n);
});
