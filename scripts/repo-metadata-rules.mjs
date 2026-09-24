// The rules every repo's GitHub description and tags must meet. Pure: takes
// the repo's metadata and repo-topics.json, returns a list of problems. An
// empty list means compliant. Shared by the PR check here and, through the
// same repo-topics.json, by claude-kit's daily estate audit.

const DASHES = /[–—]/;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;

export function checkRepoMetadata({ description, topics }, taxonomy) {
  const problems = [];
  const desc = (description || "").trim();
  if (!desc) problems.push("no description");
  if (desc.length > 350) problems.push(`description is ${desc.length} characters; the limit is 350`);
  if (DASHES.test(desc)) problems.push("description contains an em or en dash");

  const tags = topics || [];
  if (tags.length === 0) problems.push("no tags");
  if (tags.length > 20) problems.push(`${tags.length} tags; GitHub allows 20`);
  if (new Set(tags).size !== tags.length) problems.push("duplicate tags");

  const clientRe = new RegExp(taxonomy.clientPattern);
  const known = new Set([...taxonomy.kind, ...taxonomy.status, ...taxonomy.business, ...taxonomy.stack]);
  for (const t of tags) {
    if (!TOPIC.test(t)) problems.push(`tag "${t}" is not lowercase letters, digits and hyphens`);
    else if (!known.has(t) && !clientRe.test(t)) problems.push(`tag "${t}" is not in repo-topics.json`);
  }

  const kinds = tags.filter((t) => taxonomy.kind.includes(t));
  const statuses = tags.filter((t) => taxonomy.status.includes(t));
  const clients = tags.filter((t) => clientRe.test(t) && !taxonomy.kind.includes(t));
  if (kinds.length !== 1) problems.push(`needs exactly one kind tag (${taxonomy.kind.join(", ")}); has ${kinds.length}`);
  if (statuses.length !== 1) problems.push(`needs exactly one status tag (${taxonomy.status.join(", ")}); has ${statuses.length}`);

  const kind = kinds[0];
  if (kind && taxonomy.clientKinds.includes(kind) && clients.length !== 1) {
    problems.push(`a ${kind} needs exactly one client-<name> tag; has ${clients.length}`);
  }
  const needsBusiness = kind && !taxonomy.noBusinessKinds.includes(kind);
  for (const b of taxonomy.business) {
    if (needsBusiness && !tags.includes(b)) problems.push(`a ${kind} needs the ${b} tag`);
    if (kind && !needsBusiness && tags.includes(b)) problems.push(`a ${kind} must not carry the ${b} tag`);
  }
  return problems;
}
