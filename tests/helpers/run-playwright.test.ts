import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRun } from '../../scripts/run-playwright';

const EXCLUSION_SPEC = 'tests/pipeline/stage-inbox-exclusion.spec.ts';

test('--only appends the required cleanup spec to the selected set', () => {
  const { playwrightArgs, keep } = buildRun(['--only', 'tests/pipeline/stage-archive.spec.ts']);
  assert.deepEqual(playwrightArgs, ['tests/pipeline/stage-archive.spec.ts', EXCLUSION_SPEC]);
  assert.equal(keep, false);
});

test('--only --keep skips the cleanup spec and sets keep', () => {
  const { playwrightArgs, keep } = buildRun(['--only', '--keep', 'tests/pipeline/stage-archive.spec.ts']);
  assert.deepEqual(playwrightArgs, ['tests/pipeline/stage-archive.spec.ts']);
  assert.equal(keep, true);
});

test('without --only, args pass through untouched (minus --keep)', () => {
  const { playwrightArgs, keep } = buildRun(['tests/pipeline', '--grep-invert', '@slow-agent', '--keep']);
  assert.deepEqual(playwrightArgs, ['tests/pipeline', '--grep-invert', '@slow-agent']);
  assert.equal(keep, true);
});
