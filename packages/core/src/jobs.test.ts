import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { JobQueue } from './jobs.js';

const repo = () => mkdtempSync(join(tmpdir(), 'cv-jobs-'));

test('volume work is cheap, judgement work is not', () => {
  const root = repo();
  const q = new JobQueue(new Store(root));

  // Calibrated against E-001 (a real 1.32M-token cold-start on a 30k-LOC repo).
  //
  // The rule this test defends: CHEAPEN VOLUME, NEVER CHEAPEN JUDGEMENT.
  //
  // Annotation is reading a file and writing one sentence — 213k tokens of pure volume, and
  // the safe saving. But red-teaming and flow-authoring produced every critical finding in
  // that run, and a *plausible, confident, wrong* insight is worse than no insight at all:
  // it gets believed, and it poisons the store that both the human and future Claude read.
  //
  // A token saved on a job whose entire output is a judgement call is not a saving. It is a
  // defect you paid less for. If a future optimisation pass downgrades these, it should have
  // to delete this test and explain itself.
  assert.equal(q.enqueue('annotate').tier, 'haiku');
  assert.equal(q.enqueue('summarize-session').tier, 'haiku');

  assert.equal(q.enqueue('red-team').tier, 'opus');
  assert.equal(q.enqueue('author-flows').tier, 'opus');

  // extract-threads was Haiku until the real run disproved it: the value was in KILLING 88 of
  // 106 candidates, which needs cross-referencing and judgement. A cheaper model returns a
  // longer, worse list — and a threads screen full of chaff is one the user stops opening.
  assert.equal(q.enqueue('extract-threads').tier, 'sonnet');

  rmSync(root, { recursive: true, force: true });
});

test('a claimed job cannot be claimed twice', () => {
  const root = repo();
  const q = new JobQueue(new Store(root));
  q.enqueue('annotate', { n: 1 });

  const a = q.claim();
  const b = q.claim();

  // The claim is an atomic rename, not a read-then-write. Two drainers racing (a session
  // hook and the headless runner, say) must not both win and run the same expensive pass.
  assert.ok(a);
  assert.equal(b, undefined, 'a second drainer must not be able to claim the same job');
  assert.equal(a!.status, 'running');

  rmSync(root, { recursive: true, force: true });
});

test('finishing a job records what it cost', () => {
  const root = repo();
  const q = new JobQueue(new Store(root));
  const j = q.enqueue('annotate');
  q.claim();
  q.finish(j.id, 'done', 213_668);

  // The cost meter is the whole reason cold-start defaults can be measured rather than
  // guessed. A job that finishes without reporting its cost makes the meter a lie.
  assert.equal(q.spent(), 213_668);
  assert.equal(q.list('done')[0]!.result, 'done');

  rmSync(root, { recursive: true, force: true });
});
