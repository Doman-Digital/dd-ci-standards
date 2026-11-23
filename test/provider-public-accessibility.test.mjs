import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/provider-public-accessibility.yml', import.meta.url), 'utf8');
const source = workflow.match(/        run: \|\n([\s\S]*?)\n\n      - name:/)[1].replace(/^          /gm, '');
const provider = { app: { slug: 'cloudflare-workers-and-pages' }, head_branch: 'master', head_sha: 'a'.repeat(40) };

for (const [name, overrides, expected] of [
  ['current production provider suite', {}, true],
  ['another provider', { app: { slug: 'github-actions' } }, false],
  ['a preview branch', { head_branch: 'preview' }, false],
  ['a different provider revision', { head_sha: 'b'.repeat(40) }, false],
]) {
  test(name, (context) => {
    const folder = mkdtempSync(path.join(tmpdir(), 'dd-provider-public-'));
    context.after(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(path.join(folder, 'gh'), '#!/bin/sh\ncat "$MOCK_SUITE"\n', { mode: 0o755 });
    writeFileSync(path.join(folder, 'suite'), JSON.stringify({ ...provider, ...overrides }));
    const output = path.join(folder, 'output');
    writeFileSync(output, '');
    execFileSync('bash', ['-c', source], { env: {
      ...process.env, PATH: folder + ':' + process.env.PATH, GITHUB_OUTPUT: output,
      MOCK_SUITE: path.join(folder, 'suite'), SUITE: '123', GITHUB_REPOSITORY: 'example/public',
      BRANCH: 'master', RELEASE: provider.head_sha,
    } });
    assert.equal(readFileSync(output, 'utf8').trim(), expected ? 'production=true' : '');
  });
}

test('only a named successful production event or a default-branch manual release can request the scoped task', () => {
  for (const guard of [
    "github.event.check_run.name == inputs.worker-check",
    "github.event.check_run.conclusion == 'success'",
    "github.ref_name == github.event.repository.default_branch",
    "inputs.healthy-release != ''",
    "if: github.event_name == 'workflow_dispatch' || steps.provider.outputs.production == 'true'",
    "vars.DD_RUNNER || 'dd-client'",
    "actions/deploy-tip@v1",
    "github.event_name == 'check_run' && github.event.check_run.head_sha || inputs.healthy-release",
    "if: steps.tip.outputs.deploy == 'true'",
    "secrets.client-run-token",
    "format('{0}:public-accessibility', inputs.client)",
  ]) assert.ok(workflow.includes(guard), guard);
  assert.doesNotMatch(workflow, /permissions: write-all|actions\/checkout|secrets: inherit/);
});
