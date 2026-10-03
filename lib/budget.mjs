// Minimal reader for budget.yml's own fixed shape (repos: <name>:
// github_actions_crons: [{workflow, cron}], vercel_crons: [{app, path,
// schedule}]). Moved unchanged from scripts/check-workflow-policy.mjs.

export function budgetForRepo(raw, name) {
  const lines = raw.split("\n");
  let inRepos = false;
  let currentRepo = null;
  let section = null; // 'ga' | 'vercel'
  const ghCrons = [];
  const vercelCrons = [];
  let cur = null;
  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    const repoMatch = line.match(/^  (\S+):\s*$/);
    if (repoMatch) {
      currentRepo = repoMatch[1];
      section = null;
      continue;
    }
    if (currentRepo !== name) continue;
    if (/^\s{4}github_actions_crons:/.test(line)) {
      section = "ga";
      continue;
    }
    if (/^\s{4}vercel_crons:/.test(line)) {
      section = "vercel";
      continue;
    }
    const itemStart = line.match(/^\s{6}-\s*(\w+):\s*(.*)$/);
    if (itemStart) {
      cur = {};
      cur[itemStart[1]] = itemStart[2].replace(/^["']|["']$/g, "");
      if (section === "ga") ghCrons.push(cur);
      if (section === "vercel") vercelCrons.push(cur);
      continue;
    }
    const itemCont = line.match(/^\s{8}(\w+):\s*(.*)$/);
    if (itemCont && cur) {
      cur[itemCont[1]] = itemCont[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ghCrons, vercelCrons };
}
