import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS } from '../lib/rules.mjs';

const context = { visibility: 'private', meta: { owner: { login: 'Doman-Digital' } } };
const view = (runner) => ({ workflows: [{ path: '.github/workflows/ci.yml', text: `on: pull_request\njobs:\n  check:\n    runs-on: ${runner}\n    timeout-minutes: 3\n    steps:\n      - run: echo test\n` }] });

test('the shipped policy accepts hosted jobs without requiring retired pools', () => {
  for (const rule of ['CI-001', 'CI-022', 'CI-028', 'CI-029']) {
    assert.deepEqual(CHECKS[rule](view('ubuntu-latest'), context), []);
  }
});

test('all retired runner labels fail with a hosted replacement', () => {
  for (const runner of ['dd-ci', 'dd-ci-ephemeral', 'dd-ci-light', 'dd-ci-deploy', '[self-hosted, linux, dd-ci]']) {
    const findings = CHECKS['CI-001'](view(runner), context);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].runsOn, 'ubuntu-latest');
  }
});

test('client account runner policies are not changed by organization retirement', () => {
  assert.deepEqual(CHECKS['CI-001'](view('self-hosted'), { ...context, meta: { owner: { login: 'client' } } }), []);
});
