#!/usr/bin/env node
// Fails the PR when the repo's own GitHub description or tags break the
// rules in repo-topics.json. Reads the live settings through the API, so a
// repo cannot pass by being quiet: the moment anyone opens a PR, a repo with
// no description or no kind/status tag goes red.
//
// Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/name \
//   node scripts/check-repo-metadata.mjs <path-to-repo-topics.json>

import { readFileSync } from "node:fs";
import { checkRepoMetadata } from "./repo-metadata-rules.mjs";

const [, , taxonomyPath] = process.argv;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!taxonomyPath || !repo || !token) {
  console.error("usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/name check-repo-metadata.mjs <repo-topics.json>");
  process.exit(2);
}

const taxonomy = JSON.parse(readFileSync(taxonomyPath, "utf8"));
const res = await fetch(`https://api.github.com/repos/${repo}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ci-standards" },
});
if (!res.ok) {
  // Unverified is never a pass: a repo whose settings cannot be read fails.
  console.error(`::error::could not read ${repo} settings (HTTP ${res.status}); the metadata rule is unverified`);
  process.exit(1);
}
const meta = await res.json();
const problems = checkRepoMetadata({ description: meta.description, topics: meta.topics }, taxonomy);

if (problems.length) {
  for (const p of problems) console.log(`::error title=repo metadata::${repo}: ${p}`);
  console.log(`\n${problems.length} problem(s). Fix them in the repo's About settings, or in claude-kit's repos/metadata.json and apply it.`);
  process.exit(1);
}
console.log(`${repo}: description and tags meet repo-topics.json (${meta.topics.join(", ")})`);
