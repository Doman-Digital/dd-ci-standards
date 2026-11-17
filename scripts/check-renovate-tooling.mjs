#!/usr/bin/env node
// Daily from renovate.yml: the repos the tooling automerge rule in default.json names must match
// the unarchived Doman-Digital repos tagged dd-tooling, minus renovate-tooling.json's exclusions.
// A new tooling repo, a retag or an archive turns this red instead of drifting quietly.
// Needs GH_TOKEN that can list the org's private repos.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { presetProblems, driftProblems } from "../lib/renovate-tooling.mjs";

const preset = JSON.parse(readFileSync(new URL("../default.json", import.meta.url), "utf8"));
const cfg = JSON.parse(readFileSync(new URL("../renovate-tooling.json", import.meta.url), "utf8"));

const out = execFileSync(
  "gh",
  ["search", "repos", "--owner", cfg.owner, "--topic", cfg.topic, "--limit", "200", "--json", "name,isArchived"],
  { encoding: "utf8" },
);
const topicRepos = JSON.parse(out);
if (topicRepos.length === 0) {
  console.error(`No ${cfg.owner} repo carries ${cfg.topic}; the token probably cannot see private repos.`);
  process.exit(1);
}

const problems = [...presetProblems(preset, cfg), ...driftProblems(preset, cfg, topicRepos)];
for (const p of problems) console.error(`::error::${p}`);
if (problems.length) {
  console.error("Fix default.json's tooling rule (or renovate-tooling.json's exclusions) so they match the topics.");
  process.exit(1);
}
console.log(`Tooling automerge rule matches ${topicRepos.length} ${cfg.topic} repos.`);
