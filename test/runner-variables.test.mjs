import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS } from '../lib/rules.mjs';

// DOM-17636, 14 November 2026: the 9 November retirement was reversed. In the org's private repos a job
// reaches the pools through the runner variables, so the whole route can finish on either side.
const context = { visibility: 'private', meta: { owner: { login: 'Doman-Digital' } } };
const view = (runner) => ({ workflows: [{ path: '.github/workflows/ci.yml', text: `on: pull_request\njobs:\n  check:\n    runs-on: ${runner}\n    timeout-minutes: 3\n    steps:\n      - run: echo test\n` }] });

test('a literal GitHub-hosted label in an org private repo fails CI-001', () => {
  const findings = CHECKS['CI-001'](view('ubuntu-latest'), context);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /vars\.CI_RUNNER/);
});

test('the runner variables, with a hosted fallback, pass CI-001', () => {
  for (const runner of [
    "${{ vars.CI_RUNNER || 'ubuntu-latest' }}",
    "${{ vars.CI_RUNNER_LIGHT || vars.CI_RUNNER || 'ubuntu-latest' }}",
    "${{ vars.CI_RUNNER_DEPLOY || vars.CI_RUNNER || 'ubuntu-latest' }}",
  ]) {
    assert.deepEqual(CHECKS['CI-001'](view(runner), context), []);
  }
});

test('public repos and client accounts are not held to the org runners', () => {
  assert.deepEqual(CHECKS['CI-001'](view('ubuntu-latest'), { ...context, visibility: 'public' }), []);
  assert.deepEqual(CHECKS['CI-001'](view('ubuntu-latest'), { ...context, meta: { owner: { login: 'client' } } }), []);
});
