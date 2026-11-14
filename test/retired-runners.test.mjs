import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECKS } from '../lib/rules.mjs';

// The dd-ci pools were retired on 9 Nov 2026 and brought back on 14 Nov 2026 (dd-ci-01 online again).
const context = { selfHostedRetired: undefined, visibility: 'private', meta: { owner: { login: 'Doman-Digital' } } };
const view = (runner) => ({ workflows: [{ path: '.github/workflows/ci.yml', text: `on: pull_request\njobs:\n  check:\n    runs-on: ${runner}\n    timeout-minutes: 3\n    steps:\n      - run: echo test\n` }] });

test('the shipped config does not mark the dd-ci pools retired', () => {
  const cfg = JSON.parse(readFileSync(new URL('../hosted-jobs.json', import.meta.url), 'utf8'));
  assert.notEqual(cfg.self_hosted_retired, true);
});

test('a dd-ci pool label passes CI-001 in an org private repo', () => {
  for (const runner of ['dd-ci-ephemeral', 'dd-ci-light', 'dd-ci-deploy']) {
    assert.deepEqual(CHECKS['CI-001'](view(runner), context), [], runner);
  }
});
