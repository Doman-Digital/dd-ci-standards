# Disposable public runner profile

Public pull-request code may use the dedicated untrusted VM pool once its backend and host qualification has passed. CI-002 recognises a permanent profile with an initial repository set of `Doman-Digital/dd-ci-standards`. Adding a repository requires a reviewed source change and matching runner-group selection. There is no per-repository exemption or founder attestation.

Each ordinary `pull_request` job uses this canonical shape:

```yaml
permissions:
  contents: read
jobs:
  self-check:
    runs-on:
      group: dd-public-untrusted
      labels: dd-public-ephemeral
    timeout-minutes: 15
    steps:
      - run: npm test
```

The rule accepts empty workflow permissions too. It rejects private or dynamic selection, ambiguous mapping shapes, inherited permissions, secret contexts, environments, write or OIDC permissions, aliases and timeouts above 15 minutes. Public-profile workflows use ordinary pull requests alone. `pull_request_target`, `workflow_run`, push, manual, release and publish jobs remain outside this profile. Generic `workflow_call` definitions remain caller-scoped; this first profile uses direct jobs so no unreviewed caller-supplied runner expression is admitted.

The implementation scans a deliberately narrow YAML shape. It is structural lint, and does not provide an independent runner sandbox or certify backend state. Untrusted code may change the workflow, fetch arbitrary code and run as root inside its guest. The administrative boundary must therefore work even when a PR bypasses or changes its lint.

GitHub's dedicated runner group uses selected repository access, allows public repositories and initially selects standards alone. Default and every private group exclude public repositories. A public PR can request a private group in YAML; GitHub must refuse that repository's access to it. The repository uses native `all_external_contributors` approval and read token defaults with review approval disabled. Native public-fork restrictions withhold secrets and clamp write tokens. Privileged release workflows never use this pool. Approval applies to a workflow run; it does not freeze every source that arbitrary steps may fetch. Verify a changed head SHA requires its own native admission during qualification.

Each job gets a fresh Incus VM, a filtered public bridge NIC and a private 20 GiB root disk. No host mounts, management socket, estate credentials, private runner state or other job disk is supplied. Guest root is expected. An early host-input guard permits only DHCP/DNS and the exact instance-authenticated GARM bootstrap proxy. The network blocks private, tailnet, link-local, peer and host-management routes and IPv6. A host-owned lifetime bound and teardown checks prevent guest-controlled runner termination from leaving an unbounded VM. GARM bootstrap uses a narrow instance JWT/JIT capability; it is separate from controller credentials and GitHub job permissions.

The public scale set has one runner maximum and zero idle runners in the existing shared `dd-runners` project. Preserve its six-VM and 38 GiB aggregate caps. Add the actual new public scope to monitoring alongside scopes 1 through 11; scope 11 stays private. Backend, host and runtime qualification evidence belongs with the netcup deployment review. No group, host, workflow or scale-set activation is performed by this source patch.

GitHub Team supports repository-restricted runner groups. Workflow-restricted groups are an Enterprise feature, so this profile relies on untrusted execution containment and native fork admission. The required `self-check` retains GitHub Actions App 15368 as issuer. Existing hosted-only release workflows need their own reviewed permanent execution path before running under the zero hosted-compute plan.

References: [GitHub runner-group access](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access), [native fork admission](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks), [workflow token permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [GARM scale sets](https://github.com/cloudbase/garm/blob/v0.2.1/doc/scale-sets.md).
