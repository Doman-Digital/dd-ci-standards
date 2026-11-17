// The tooling automerge rule in default.json (founder, 17 November 2026): green robot PRs on our
// own tooling merge themselves, client sites never. Shared by test/renovate-tooling.test.mjs and
// scripts/check-renovate-tooling.mjs so the rule is described in one place.

export const TOOLING_UPDATE_TYPES = ["minor", "patch", "lockFileMaintenance"];

// The one packageRule that automerges minor bumps and lock file maintenance.
export function toolingRules(preset) {
  return (preset.packageRules ?? []).filter(
    (r) => r.automerge === true && (r.matchUpdateTypes ?? []).includes("lockFileMaintenance"),
  );
}

// The repos the rule should name: every unarchived repo with the topic, minus the exclusions.
export function expectedRepos(topicRepos, cfg) {
  return topicRepos
    .filter((r) => !r.isArchived && !(r.name in cfg.excluded))
    .map((r) => `${cfg.owner}/${r.name}`)
    .sort();
}

// Problems with the preset on its own, no network. An empty list means it holds.
export function presetProblems(preset, cfg) {
  const problems = [];
  const rules = toolingRules(preset);
  if (rules.length !== 1) return [`expected exactly one tooling automerge rule, found ${rules.length}`];
  const rule = rules[0];
  const repos = rule.matchRepositories ?? [];
  if (repos.length === 0) problems.push("the tooling rule names no repos, so it would apply to every repo, client sites included");
  for (const r of repos) {
    if (!r.startsWith(`${cfg.owner}/`) || /[*?{}]/.test(r)) problems.push(`${r} is not one exact ${cfg.owner} repo`);
    const name = r.split("/")[1];
    if (name in cfg.excluded) problems.push(`${r} is excluded in renovate-tooling.json: ${cfg.excluded[name]}`);
  }
  if (JSON.stringify(rule.matchUpdateTypes) !== JSON.stringify(TOOLING_UPDATE_TYPES))
    problems.push(`the tooling rule must match exactly ${TOOLING_UPDATE_TYPES.join(", ")}, never major`);
  if (rule.platformAutomerge !== false)
    problems.push("the tooling rule must set platformAutomerge false, so Renovate reads the checks itself");
  if (rule.ignoreTests) problems.push("the tooling rule must not ignore tests");
  const houseAt = preset.packageRules.findIndex((r) => r.groupName === "house packages");
  if (houseAt !== -1 && preset.packageRules.indexOf(rule) > houseAt)
    problems.push("the tooling rule must sit before the house packages rule");
  // Nowhere else may minor bumps or lock file maintenance be automerged estate-wide.
  if (preset.lockFileMaintenance?.automerge) problems.push("lockFileMaintenance.automerge must stay off at the top level");
  for (const r of preset.packageRules) {
    if (r === rule || r.automerge !== true || r.matchRepositories || r.matchPackageNames || r.matchDepTypes) continue;
    const types = r.matchUpdateTypes ?? [];
    if (types.includes("minor") || types.includes("lockFileMaintenance") || types.length === 0)
      problems.push(`a rule automerges ${types.join(", ") || "every update"} for every repo: ${r.description ?? "(no description)"}`);
  }
  return problems;
}

// Difference between what the rule names and what the topics say.
export function driftProblems(preset, cfg, topicRepos) {
  const rule = toolingRules(preset)[0];
  const named = new Set(rule?.matchRepositories ?? []);
  const want = new Set(expectedRepos(topicRepos, cfg));
  const problems = [];
  for (const r of want) if (!named.has(r)) problems.push(`${r} carries ${cfg.topic} but default.json does not name it`);
  for (const r of named) if (!want.has(r)) problems.push(`${r} is named in default.json but is not an unarchived ${cfg.topic} repo`);
  return problems;
}
