// The pull request's issue reference in a job of its own (DOM-17635).
//
// LIN-001 and LIN-002 read the pull request's title, description, labels and branch. In the policy
// check they read the event the run started with, so a fixed description needed a new commit, and
// in the monorepo a commit is a full CI run. The issue-ref workflow (.github/workflows/issue-ref.yml)
// runs only those two rules, reads the pull request live through the API (it has pull-requests:
// read, which the policy check cannot ask for: a called workflow cannot exceed its caller's
// permissions), and takes seconds, so the fix is a re-run of that one job.
//
// Where an org ruleset runs issue-ref.yml on the branch, the policy check's own ruleset run leaves
// LIN-001 and LIN-002 to it, so a pull request is told once. A caller's run (client repos, public
// repos) keeps them: nothing else checks them there.
import { POLICY_RULESET } from "./rules.mjs";

/** The rulebook with only the named rules (only), or without them (skip). Unknown ids are an error. */
export function selectRules(rulebook, { only = null, skip = [] } = {}) {
  const known = new Set(rulebook.rules.map((r) => r.id));
  const unknown = [...(only ?? []), ...skip].filter((id) => !known.has(id));
  if (unknown.length) return { error: `no such rule: ${unknown.join(", ")}` };
  const rules = rulebook.rules.filter((r) => (!only || only.includes(r.id)) && !skip.includes(r.id));
  return { rulebook: { ...rulebook, rules } };
}

/**
 * True when this run is the org ruleset's run of policy.yml and an org ruleset also runs
 * issue-ref.yml on the branch: then LIN-001 and LIN-002 are that job's. `workflowRef` is
 * GITHUB_WORKFLOW_REF: the file that started the run, the caller's own file in a called run.
 */
export function issueRefElsewhere(view, workflowRef) {
  if (view.orgIssueRef !== true) return false;
  return String(workflowRef || "").toLowerCase().startsWith(`${POLICY_RULESET.repo}/${POLICY_RULESET.path}@`.toLowerCase());
}

/** The pull request as GET /repos/{repo}/pulls/{n} returns it, in the shape the rules read, marked live. */
export function livePullRequest(pr) {
  return {
    title: pr.title || "",
    body: pr.body || "",
    branch: pr.head?.ref || "",
    labels: (pr.labels || []).map((l) => l.name),
    base: pr.base?.sha || null,
    head: pr.head?.sha || null,
    number: pr.number ?? null,
    live: true,
  };
}
