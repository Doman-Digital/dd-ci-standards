// Structural lint only. GitHub runner-group selection and host isolation are
// separate administrative controls; PR-controlled YAML cannot establish them.
export const PUBLIC_RUNNER_PROFILE = Object.freeze({
  repositories: Object.freeze(["Doman-Digital/dd-ci-standards"]),
  group: "dd-public-untrusted",
  label: "dd-public-ephemeral",
  maxJobMinutes: 15,
});

export function publicRunnerProblems(text, job, repo, events) {
  const p = PUBLIC_RUNNER_PROFILE;
  const problems = [];
  if (!p.repositories.includes(repo)) problems.push("repository is outside the public profile's initial admission set");
  // Exact canonical mapping prevents expressions, fallback labels and private
  // group names from being mistaken for this dedicated public pool.
  const selection = `group: ${p.group}, labels: ${p.label}`;
  if (job.runsOn !== selection) problems.push("use the explicit public group and label mapping");
  if (events.length !== 1 || events[0] !== "pull_request") problems.push("the public profile accepts ordinary pull_request workflows only");
  if (!/^permissions:[ \t]*(?:\{\}[ \t]*$|\n {2}contents: read[ \t]*$)/m.test(text)) problems.push("set workflow permissions to contents: read or an empty map");
  // Conservatively inspect the entire workflow, including inherited settings.
  // This accepts a small documented YAML shape; it is not a YAML security parser.
  if (/\bwrite(?:-all)?\b|\bid-token\s*:|\bsecrets\b|\benvironment\s*:|\bpermissions\s*:\s*read-all|[&*][A-Za-z_]|<<\s*:/.test(text)) {
    problems.push("public workflows cannot request secrets, environments, write or OIDC authority, or YAML aliases");
  }
  const timeout = job.block.match(/^ {4}timeout-minutes:[ \t]*(\d+)[ \t]*$/m);
  if (!timeout || [...job.block.matchAll(/^ {4}timeout-minutes:/gm)].length !== 1 || Number(timeout[1]) < 1 || Number(timeout[1]) > p.maxJobMinutes) problems.push(`set a fixed job timeout between 1 and ${p.maxJobMinutes} minutes`);
  return problems;
}
