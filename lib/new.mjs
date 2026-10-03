// dd new: a repo that starts compliant.
//
//   1. create-next-app (or create-astro), then @domandigital/create-site,
//      in a new local folder;
//   2. dd adopt, then dd doctor, which must be clean: nothing failing,
//      nothing warning, nothing exempt. A starter that needs an exemption on
//      its first day is a bug in the starter, so dd new stops there;
//   3. only then the GitHub repo: created in the organisation with its
//      description and tags, and the first commit pushed;
//   4. a ruleset on main: changes arrive by pull request and the policy check
//      must pass, so a PR that breaks a rule past its enforce date is
//      blocked, not merely red;
//   5. a pull request on Doman-Digital/dd-repo-registry adding the entry, so
//      the next estate sweep knows the repo instead of reporting it.
//
// The local steps come first so a failure leaves a folder to look at, not an
// empty repo on GitHub. This file is pure: the plan, the registry edit and the
// checks. bin/dd.mjs runs the commands and calls the API.

export const ORG = "Doman-Digital";
export const REGISTRY_REPO = "Doman-Digital/dd-repo-registry";
export const CREATE_NEXT_APP = "create-next-app@16";
export const CREATE_ASTRO = "create-astro@4";
export const CREATE_SITE = "@domandigital/create-site@latest";

// Client repos are pushed and merged by the Doman Digital GitHub App, from
// the client work's own tooling, never by a person running dd new.
export const CLIENT_KINDS = ["client-site", "client-app"];

const NAME = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/;

/**
 * Checks the request and returns the plan, or { error } naming what is wrong.
 * opts: { kind, name, description, owner, visibility, framework, dir, today,
 *         createSite, siteArgs, local }
 */
export function planNew(opts, taxonomy, rulebook) {
  const { kind, name } = opts;
  const owner = opts.owner || ORG;
  const visibility = opts.visibility || "private";
  const framework = opts.framework || "next";
  if (!kind) return { error: "--kind is required: one of " + taxonomy.kind.join(", ") };
  if (!taxonomy.kind.includes(kind)) return { error: `unknown kind "${kind}": one of ${taxonomy.kind.join(", ")}` };
  if (CLIENT_KINDS.includes(kind)) {
    return { error: `${kind} repos are created and pushed by the Doman Digital GitHub App, never by dd new. Use the client work's own tooling.` };
  }
  const inScope = [...rulebook.kinds.full, ...rulebook.kinds.light].includes(kind);
  if (!inScope) return { error: `${kind} repos are outside the framework, so dd new does not make them.` };
  if (!name || !NAME.test(name)) return { error: "a repo name is required: lowercase letters, digits and hyphens, e.g. dd-starter" };
  if (owner !== ORG) return { error: `dd new creates repos in ${ORG} only. Personal-account repos cannot run Actions, so their checks never run.` };
  if (!["private", "public"].includes(visibility)) return { error: "--visibility is private or public" };
  if (!["next", "astro"].includes(framework)) return { error: "--framework is next or astro" };
  const description = (opts.description || "").trim();
  if (!description) return { error: '--description is required: what the repo is, in a sentence (REG-002)' };
  if (description.length > 350) return { error: `--description is ${description.length} characters; 350 at most (REG-002)` };
  if (/[–—]/.test(description)) return { error: "--description has an em or en dash (REG-002)" };

  const dir = opts.dir || name;
  const scaffold =
    framework === "next"
      ? { cmd: "npx", args: ["--yes", CREATE_NEXT_APP, dir, "--ts", "--app", "--eslint", "--tailwind", "--no-src-dir", "--import-alias", "@/*", "--use-pnpm", "--yes", "--disable-git", "--skip-install"] }
      : { cmd: "npx", args: ["--yes", CREATE_ASTRO, dir, "--template", "minimal", "--no-install", "--no-git", "--yes"] };
  // Astro's starter has no lockfile manager of its own: install with pnpm first,
  // so create-site sees a pnpm project and SEC-002's protections apply.
  const install = { cmd: "pnpm", args: ["install"] };
  const createSite = opts.createSite
    ? { cmd: process.execPath, args: [opts.createSite, "--yes", "--visibility", visibility, ...(opts.siteArgs || [])] }
    : { cmd: "npx", args: ["--yes", CREATE_SITE, "--yes", "--visibility", visibility, ...(opts.siteArgs || [])] };

  const topics = [kind, "in-development", "doman-digital", ...(framework === "next" ? ["nextjs"] : []), "typescript"];
  return {
    owner,
    name,
    repo: `${owner}/${name}`,
    kind,
    visibility,
    framework,
    description,
    dir,
    topics,
    local: Boolean(opts.local),
    steps: [scaffold, install, createSite],
    commitMessage: `feat: start ${name} with dd new\n\nKind ${kind}. Made by create-${framework === "next" ? "next-app" : "astro"}, @domandigital/create-site and dd adopt; dd doctor clean.`,
    registry: registryEntry({ owner, name, kind, today: opts.today }),
  };
}

// The check run the policy caller produces: caller job / called job.
export const POLICY_CHECK = "ci-standards-policy / check";

/** The ruleset dd new puts on main. GitHub's Free plan refuses it on a private repo. */
export function ruleset() {
  return {
    name: "DD Framework",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: POLICY_CHECK }] } },
    ],
  };
}

/** The registry.yaml entry, as text in the file's own two-space list style. */
export function registryEntry({ owner, name, kind, today }) {
  return [
    `  - remote: github.com/${owner}/${name}`,
    `    kind: ${kind}`,
    `    scope: in`,
    `    github:`,
    `      owner: ${owner}`,
    `    notes: Created ${today} by dd new. No provider linkage yet.`,
    "",
  ].join("\n");
}

/**
 * registry.yaml with the entry appended to `repos:`, or { error }. Refuses
 * when the repo is already registered, and when `repos:` is not the last
 * top-level key (appending would then land in the wrong section).
 */
export function addToRegistry(text, { owner, name, kind, today }) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^repos:\s*$/.test(l));
  if (at < 0) return { error: "registry.yaml has no top-level repos: list" };
  if (lines.slice(at + 1).some((l) => /^[^\s#-]/.test(l))) return { error: "repos: is not the last top-level key in registry.yaml; add the entry by hand" };
  const remote = `github.com/${owner}/${name}`.toLowerCase();
  if (lines.some((l) => l.trim().toLowerCase() === `- remote: ${remote}`)) return { error: `${owner}/${name} is already in registry.yaml` };
  return { text: `${text.replace(/\n*$/, "\n")}${registryEntry({ owner, name, kind, today })}` };
}

/** dd doctor's verdict on a new repo: clean means nothing failing, warning or exempt. */
export function cleanVerdict(result) {
  const counted = result.findings.filter((f) => f.level !== "report");
  return { clean: counted.length === 0 && result.exempted.length === 0, counted, exempted: result.exempted };
}

export const PR_BODY = (plan) => `Registers \`${plan.repo}\`, created by \`dd new\` (Doman-Digital/dd-ci-standards).

- kind: \`${plan.kind}\`, scope: \`in\`
- ${plan.visibility}, ${plan.framework === "next" ? "Next.js" : "Astro"} starter from @domandigital/create-site, adopted, \`dd doctor\` clean at creation

Until this merges the estate sweep reports the repo as REG-001 (not in the register).
`;
