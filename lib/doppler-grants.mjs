// Doppler keeps one membership per service account per project, and a grant's
// `environments` replaces the whole list. So the configs a row reads are granted
// one project at a time, with every config in that project together: granting
// them one by one leaves only the last (DOM-1498, where dd-deploy/meridian-web
// replaced dd-deploy/meridian-api).
export function grantsByProject(reads) {
  const grants = new Map();
  for (const ref of reads) {
    const [project, config] = ref.split("/");
    if (!grants.has(project)) grants.set(project, []);
    if (!grants.get(project).includes(config)) grants.get(project).push(config);
  }
  return [...grants].map(([project, environments]) => ({ project, environments }));
}
