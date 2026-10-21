#!/usr/bin/env node
// Owner-run. Gives one repo in doppler-identities.json its Doppler sign-in: a read-only
// service account, viewer on each config the row `reads`, and a GitHub OIDC identity that
// trusts only the row's branch. Then sets the repo variables DOPPLER_IDENTITY_ID (and
// CLOUDFLARE_ACCOUNT_ID when the row has `cloudflare_account`) and writes the identity id
// back into the row, so the change is committed with the table (SEC-009, DOM-1265).
//
//   node bin/doppler-identity.mjs Doman-Digital/redacted-electrical
//
// Needs a Doppler sign-in that can manage service accounts (the owner's `doppler login`,
// or DOPPLER_TOKEN in the environment) and gh signed in as a repo admin. Prints ids only,
// never a token. Safe to run twice: what exists is reused, the identity is updated in place.
// It replaces ~/security-review/doppler-ci-identities.py, which only knew main.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TABLE = new URL("../doppler-identities.json", import.meta.url);
const repo = process.argv[2];
if (!repo) {
  console.error("usage: node bin/doppler-identity.mjs <owner/repo>");
  process.exit(2);
}
const table = JSON.parse(readFileSync(TABLE, "utf8"));
const row = table.identities.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
if (!row) {
  console.error(`${repo} has no row in doppler-identities.json. Add one (branch, reads) first.`);
  process.exit(2);
}

const token = process.env.DOPPLER_TOKEN || execFileSync("doppler", ["configure", "get", "token", "--plain"], { encoding: "utf8" }).trim();
async function call(method, path, body) {
  const res = await fetch(`https://api.doppler.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return res.ok ? json : { failed: res.status, messages: json.messages || [text.slice(0, 200)] };
}
const fail = (what, r) => {
  console.error(`${what} failed (${r.failed}): ${r.messages.join("; ")}`);
  process.exit(1);
};

const [owner, name] = row.repo.split("/");
const saName = row.service_account || `ci-${name}`;

// The configs it reads. A root config shares its environment's slug, so a
// dd-deploy/<name> environment is created when it is missing.
for (const ref of row.reads) {
  const [project, config] = ref.split("/");
  if (project !== "dd-deploy") continue;
  const envs = await call("GET", `/v3/environments?project=${project}`);
  if (envs.failed) fail("listing dd-deploy environments", envs);
  if (!envs.environments.some((e) => e.slug === config)) {
    const made = await call("POST", `/v3/environments?project=${project}`, { name: config, slug: config });
    if (made.failed) fail(`creating environment ${ref}`, made);
    console.log(`environment ${ref} created`);
  }
}

const accounts = await call("GET", "/v3/workplace/service_accounts?per_page=100");
if (accounts.failed) fail("listing service accounts", accounts);
let sa = accounts.service_accounts.find((a) => a.name === saName)?.slug;
if (!sa) {
  const made = await call("POST", "/v3/workplace/service_accounts", { name: saName });
  if (made.failed) fail(`creating service account ${saName}`, made);
  sa = made.service_account.slug;
  console.log(`service account ${saName} created`);
} else {
  console.log(`service account ${saName} exists`);
}

for (const ref of row.reads) {
  const [project, config] = ref.split("/");
  const m = await call("POST", `/v3/projects/project/members?project=${project}`, { type: "service_account", slug: sa, role: "viewer", environments: [config] });
  // An existing member is reported as a conflict; update its environments instead.
  if (m.failed === 409 || (m.failed && /already/i.test(m.messages.join(" ")))) {
    const u = await call("PATCH", `/v3/projects/project/members/member/service_account/${sa}?project=${project}`, { role: "viewer", environments: [config] });
    if (u.failed) fail(`updating access to ${ref}`, u);
  } else if (m.failed) fail(`granting access to ${ref}`, m);
  console.log(`  reads ${ref}`);
}

// GitHub may put the owner and repo ids in the subject, so ask it for the prefix.
let prefix = `repo:${row.repo}`;
try {
  const sub = JSON.parse(execFileSync("gh", ["api", `repos/${row.repo}/actions/oidc/customization/sub`], { encoding: "utf8" }));
  if (sub.sub_claim_prefix) prefix = sub.sub_claim_prefix;
} catch {
  // Not customised: the default subject.
}
const identityName = `github-${row.branch}`;
const body = {
  name: identityName,
  method: "oidc",
  ttl_seconds: 600,
  config: {
    discovery_url: "https://token.actions.githubusercontent.com",
    claims_type: "exact",
    claims: { aud: [`https://github.com/${owner}`], sub: [`${prefix}:ref:refs/heads/${row.branch}`] },
  },
};
const base = `/v3/workplace/service_accounts/service_account/${sa}/identities`;
const list = await call("GET", base);
if (list.failed) fail("listing identities", list);
const existing = list.identities.find((i) => i.name === identityName)?.slug;
const saved = existing ? await call("PUT", `${base}/identity/${existing}`, body) : await call("POST", base, body);
if (saved.failed) fail("saving the identity", saved);
const id = saved.identity.slug;
console.log(`  identity ${identityName} ${id}, trusts ${body.config.claims.sub[0]}`);

execFileSync("gh", ["variable", "set", "DOPPLER_IDENTITY_ID", "-R", row.repo, "--body", id], { stdio: "inherit" });
if (row.cloudflare_account) execFileSync("gh", ["variable", "set", "CLOUDFLARE_ACCOUNT_ID", "-R", row.repo, "--body", row.cloudflare_account], { stdio: "inherit" });
console.log(`  repo variables set on ${row.repo}`);

row.identity = id;
writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`);
console.log("doppler-identities.json updated: commit it so SEC-009 checks the new value.");
