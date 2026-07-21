import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { compactStore, COMPACTABLE } from './compact.js';

const repo = () => mkdtempSync(join(tmpdir(), 'cv-compact-'));
const lines = (root: string, f: string) =>
  readFileSync(join(root, '.claudeview', f), 'utf8').trim().split('\n').filter(Boolean).length;

/** Append a raw line, bypassing the store's dirty check — this is how the damage was done. */
function appendRaw(root: string, f: string, rec: object) {
  const p = join(root, '.claudeview', f);
  mkdirSync(join(root, '.claudeview'), { recursive: true });
  writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + JSON.stringify(rec) + '\n');
}

const session = (rev: number, over: object = {}) => ({
  id: 'session:abc', kind: 'session', rev, actor: 'test',
  ts: `2026-07-17T00:00:${String(rev % 60).padStart(2, '0')}.000Z`,
  sessionId: 'abc', provenance: 'observed', startedAt: '2026-07-15T00:00:00.000Z',
  stats: { prompts: 1, edits: 0, writes: 0, bash: 0, filesTouched: [] },
  ...over,
});

/**
 * Compaction folds a log to one line per record, and that line is the winning revision.
 *
 * This repairs stores damaged before the dirty check existed. A real one reached 630,571
 * revisions of 156 sessions (513 MB) and 573,227 revisions of 19,270 events — 30x and 4000x
 * write amplification from a poller that rewrote unchanged records every tick.
 *
 * The invariant that matters is not "smaller". It is that the folded log answers every query
 * identically to the log it replaced: same records, same current values, same tombstones.
 * A compactor that shrinks a file but changes an answer has destroyed data, and it has done
 * so in the one store the user cannot reconstruct.
 */
test('compaction folds to the winning revision and changes no answer', () => {
  const root = repo();

  for (let rev = 0; rev < 300; rev++) appendRaw(root, 'sessions.jsonl', session(rev));
  appendRaw(root, 'sessions.jsonl', session(300, { summary: 'the real one', stats: { prompts: 9, edits: 4, writes: 0, bash: 0, filesTouched: ['x.ts'] } }));

  const before = new Store(root).all('session');
  assert.equal(lines(root, 'sessions.jsonl'), 301);

  const res = compactStore(root);

  assert.equal(lines(root, 'sessions.jsonl'), 1, 'one line per record');
  const after = new Store(root).all('session');
  assert.deepEqual(after, before, 'every query answers identically');
  assert.equal(after[0]!.summary, 'the real one');
  assert.equal(after[0]!.rev, 300, 'the winning revision keeps its rev, so later writes still order correctly');
  assert.equal(res.kinds.find((k) => k.kind === 'session')!.before, 301);
  assert.equal(res.kinds.find((k) => k.kind === 'session')!.after, 1);

  rmSync(root, { recursive: true, force: true });
});

/**
 * A tombstone must survive compaction.
 *
 * `remove()` appends a deleted:true revision rather than erasing anything, and readers filter
 * it out. Folding with the naive "keep what all() returns" would drop the tombstone entirely
 * — resurrecting every deleted record on the next read. Deleting a decision and having it
 * silently reappear a week later is precisely the kind of quiet wrongness this tool exists to
 * catch, so it gets a test rather than a comment.
 */
test('deleted records stay deleted', () => {
  const root = repo();
  const s = new Store(root);
  const ins = (id: string, title: string) => ({
    id, provenance: 'authored' as const, title, detail: 'd', severity: 'low' as const,
    confidence: 0.9, status: 'open' as const,
  });
  s.put('insight', ins('i1', 'keep me') as any);
  s.put('insight', ins('i2', 'kill me') as any);
  s.remove('insight', 'i2');

  compactStore(root, { kinds: ['insight'] as any });

  const after = new Store(root);
  assert.equal(after.all('insight').length, 1);
  assert.equal(after.get('insight', 'i2'), undefined, 'the tombstone must not be folded away');
  assert.equal(after.get('insight', 'i1')!.title, 'keep me');

  rmSync(root, { recursive: true, force: true });
});

/**
 * Authored kinds are never compacted by default.
 *
 * The whole point of this store is that months later you can ask "why did we decide that, and
 * what did we think before?" Every revision of a decision, insight, experiment or thread is a
 * real change of mind that a human or a model made deliberately — unlike a session rollup,
 * which a poller recomputed. Those kinds also do not churn, so they have nothing to gain and
 * everything to lose.
 *
 * This is enforced by KIND, deliberately, and not by a size threshold. A threshold would
 * eventually grow past some project's decision log and eat exactly the history it was meant
 * to protect, on the one project big enough to care.
 */
test('authored history is never folded', () => {
  const root = repo();
  const s = new Store(root);

  // A decision genuinely revised three times: this is knowledge, not churn.
  const dec = (choice: string) => ({
    id: 'd1', provenance: 'authored' as const, title: 'auth order',
    choice, rationale: 'r', status: 'active' as const,
  });
  s.put('decision', dec('use X') as any);
  s.put('decision', dec('actually Y') as any);
  s.put('decision', dec('back to X, see E-001') as any);
  assert.equal(lines(root, 'decisions.jsonl'), 3);

  const res = compactStore(root);

  assert.equal(lines(root, 'decisions.jsonl'), 3, 'decision revisions are untouched');
  assert.equal(new Store(root).history('decision', 'd1').length, 3, 'and remain walkable');
  assert.ok(!res.kinds.some((k) => k.kind === 'decision'), 'not even reported as compactable');

  assert.deepEqual(
    [...COMPACTABLE].sort(),
    ['component', 'event', 'session'],
    'only machine-regenerated kinds are compactable; adding to this set discards authored history',
  );

  rmSync(root, { recursive: true, force: true });
});

/**
 * The original file is backed up before it is replaced, and the replacement is atomic.
 *
 * Compaction rewrites the only copy of something the user cares about. Two independent
 * protections, because a repair tool that eats a store is worse than the bloat it fixes:
 * a backup means a wrong fold is recoverable, and writing to a temp file then renaming means
 * a crash or a full disk mid-write leaves the original intact rather than truncated.
 */
test('the original is preserved and the swap is atomic', () => {
  const root = repo();
  for (let rev = 0; rev < 50; rev++) appendRaw(root, 'sessions.jsonl', session(rev));
  const original = readFileSync(join(root, '.claudeview', 'sessions.jsonl'), 'utf8');

  const res = compactStore(root);

  const backups = readdirSync(join(root, '.claudeview', 'backup'));
  assert.equal(backups.length, 1, 'exactly one backup for the one file changed');
  assert.match(backups[0]!, /^sessions\.jsonl\./);
  assert.equal(readFileSync(join(root, '.claudeview', 'backup', backups[0]!), 'utf8'), original,
    'the backup is the original, byte for byte');

  assert.ok(!existsSync(join(root, '.claudeview', 'sessions.jsonl.tmp')), 'no temp file left behind');
  assert.ok(res.bytesBefore > res.bytesAfter);

  rmSync(root, { recursive: true, force: true });
});

/**
 * A store with a little honest churn is left alone; --force overrides.
 *
 * A live store is never perfectly folded — a running session gains a revision whenever its
 * counts move — so "fold unless already one line per record" would rewrite the log and cut a
 * new backup on every single run. On the 1.2 GB store that meant copying half a gigabyte to
 * backup/ to reclaim a few kilobytes, and the repair would have become a slow-motion version
 * of the bug it fixes. Damaged stores sit at 2,464x, so the threshold never has to be close.
 */
test('a lightly-churned store is not worth rewriting', () => {
  const root = repo();
  // 256 records carrying 264 lines: 1.03x, exactly what a healthy live store looks like.
  for (let i = 0; i < 256; i++) appendRaw(root, 'sessions.jsonl', { ...session(0), id: `session:${i}`, sessionId: String(i) });
  for (let i = 0; i < 8; i++) appendRaw(root, 'sessions.jsonl', { ...session(1), id: `session:${i}`, sessionId: String(i) });
  const untouched = readFileSync(join(root, '.claudeview', 'sessions.jsonl'), 'utf8');

  assert.equal(compactStore(root).kinds.length, 0, 'declines below the waste threshold');
  assert.equal(readFileSync(join(root, '.claudeview', 'sessions.jsonl'), 'utf8'), untouched);
  assert.ok(!existsSync(join(root, '.claudeview', 'backup')), 'and cuts no backup');

  // The escape hatch still works, for anyone who wants the last few kilobytes.
  const forced = compactStore(root, { force: true });
  assert.equal(forced.kinds[0]!.after, 256);
  assert.equal(lines(root, 'sessions.jsonl'), 256);

  rmSync(root, { recursive: true, force: true });
});

/**
 * Compaction on an already-healthy store is a no-op that touches nothing.
 *
 * If it rewrote regardless it would create a backup every run, and the "repair" would become
 * its own source of bloat — which would be a genuinely embarrassing way to reintroduce the
 * bug. It also makes the command safe to run speculatively, which is the only way anyone will
 * actually run it.
 */
test('a healthy store is left completely alone', () => {
  const root = repo();
  const s = new Store(root);
  s.put('session', { id: 'session:a', sessionId: 'a', provenance: 'observed', startedAt: '2026-07-01T00:00:00.000Z' } as any);
  const before = readFileSync(join(root, '.claudeview', 'sessions.jsonl'), 'utf8');

  const res = compactStore(root);

  assert.equal(readFileSync(join(root, '.claudeview', 'sessions.jsonl'), 'utf8'), before);
  assert.ok(!existsSync(join(root, '.claudeview', 'backup')), 'nothing to back up, so no backup');
  assert.equal(res.kinds.length, 0);
  assert.equal(res.bytesSaved, 0);

  rmSync(root, { recursive: true, force: true });
});
