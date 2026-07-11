import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { GitWatcher } from './git.js';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cv-git-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 'dev@example.com');
  g('config', 'user.name', 'Dev');
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function commit(root: string, file: string, content: string, msg: string) {
  writeFileSync(join(root, file), content);
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', msg], { stdio: 'ignore' });
}

test('ingests commits — git author time carries a TZ offset, not UTC', () => {
  const root = repo();
  commit(root, 'src/a.ts', 'export const a = 1;\n', 'add a');

  const store = new Store(root);
  const res = new GitWatcher(root, store).scan();

  // This is the regression that took down a live sync: `git log --pretty=%aI` emits
  // ISO-8601 WITH a zone offset (…+03:00), and a naive `z.string().datetime()` accepts only
  // UTC 'Z' and rejects every commit — failing validation for the entire batch.
  assert.equal(res.absent, false);
  assert.equal(res.commits.length, 1);
  assert.equal(res.commits[0]!.summary, 'add a');
  assert.ok(res.commits[0]!.ts.endsWith('Z'), 'timestamps must be normalised to UTC in the store');

  rmSync(root, { recursive: true, force: true });
});

test('classifies a commit we never watched as FOREIGN', () => {
  const root = repo();
  commit(root, 'src/a.ts', 'export const a = 1;\n', 'someone else did this');

  const store = new Store(root);
  const res = new GitWatcher(root, store).scan();

  // No session events touch src/a.ts, so nothing in our history explains this change. That
  // is the whole signal: the code moved and we do not know why.
  assert.equal(res.foreign.length, 1);
  assert.equal(res.commits[0]!.commit!.origin, 'foreign');

  rmSync(root, { recursive: true, force: true });
});

test('classifies a commit we DID watch as explained', () => {
  const root = repo();
  const store = new Store(root);

  // Pretend Claude edited this file during a session.
  store.put('event', {
    id: 'e1', sessionId: 's1', provenance: 'observed', type: 'tool', tool: 'Edit',
    paths: ['src/a.ts'], agent: { type: 'main' },
  });

  commit(root, 'src/a.ts', 'export const a = 1;\n', 'claude wrote this');
  const res = new GitWatcher(root, store).scan();

  // NOTE: this commit also contains `.claudeview/*.jsonl` — the store commits itself. If
  // those counted as unexplained paths, EVERY commit would be flagged foreign and would
  // queue a pointless (and billable) reconcile job. The tool must not mistake its own
  // bookkeeping for a stranger's edits.
  assert.ok(res.commits[0]!.paths.some((p) => p.startsWith('.claudeview/')), 'the store really is in this commit');
  assert.equal(res.commits[0]!.commit!.origin, 'explained');
  assert.equal(res.foreign.length, 0);

  rmSync(root, { recursive: true, force: true });
});

test('a commit made DURING an observed session is explained, whatever tool wrote the files', () => {
  const root = repo();
  const store = new Store(root);

  // A session in progress. Note it touches src/other.ts — NOT the file about to be committed.
  const now = Date.now();
  store.put('event', {
    id: 'e1', sessionId: 's1', provenance: 'observed', type: 'tool', tool: 'Bash',
    ts: new Date(now - 60_000).toISOString(), paths: [], agent: { type: 'main' },
  });
  store.put('event', {
    id: 'e2', sessionId: 's1', provenance: 'observed', type: 'tool', tool: 'Edit',
    ts: new Date(now).toISOString(), paths: ['src/other.ts'], agent: { type: 'main' },
  });

  // Claude ran a script that generated this file. No Edit/Write ever named it, so pure path
  // attribution calls it a stranger's work — on a real project that mislabelled 45% of all
  // commits and would have queued ~90 needless model runs on the first sync.
  commit(root, 'src/generated.ts', 'export const g = 1;\n', 'chore: regenerate artifacts');

  const res = new GitWatcher(root, store).scan();
  assert.equal(res.commits[0]!.commit!.origin, 'explained', 'a commit inside a session window is one we witnessed');

  rmSync(root, { recursive: true, force: true });
});

test('a merge commit touches no files and needs no explanation', () => {
  const root = repo();
  const g = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });

  commit(root, 'src/a.ts', 'a', 'base');
  g('checkout', '-q', '-b', 'feature');
  commit(root, 'src/b.ts', 'b', 'feature work');
  g('checkout', '-q', '-');
  commit(root, 'src/c.ts', 'c', 'main work');
  g('merge', '--no-ff', '-q', '-m', 'Merge branch feature', 'feature');

  const store = new Store(root);
  const merge = new GitWatcher(root, store).scan().commits.find((e) => e.summary?.startsWith('Merge'));

  // A merge has no --name-only output at all. There is no content change to explain, so
  // sending a model to explain it is pure waste.
  assert.ok(merge, 'the merge commit should be ingested');
  assert.equal(merge!.paths.length, 0);
  assert.equal(merge!.commit!.origin, 'explained');

  rmSync(root, { recursive: true, force: true });
});

test('a commit made long after any session really is foreign', () => {
  const root = repo();
  const store = new Store(root);

  // An old session, far in the past. Nothing about it accounts for what happens today.
  store.put('event', {
    id: 'e1', sessionId: 's1', provenance: 'observed', type: 'tool', tool: 'Edit',
    ts: new Date(Date.now() - 30 * 864e5).toISOString(), paths: ['src/old.ts'], agent: { type: 'main' },
  });

  commit(root, 'src/teammate.ts', 'export const t = 1;\n', 'feat: something we never saw');

  const res = new GitWatcher(root, store).scan();

  // The window rule must not become a rubber stamp: a change we genuinely did not witness
  // has to still be caught, or Reconciliation never fires and the whole point is lost.
  assert.equal(res.commits[0]!.commit!.origin, 'foreign');
  assert.equal(res.foreign.length, 1);

  rmSync(root, { recursive: true, force: true });
});

test('is incremental: a second scan sees no new commits', () => {
  const root = repo();
  commit(root, 'src/a.ts', 'a', 'one');

  const store = new Store(root);
  const w = new GitWatcher(root, store);
  assert.equal(w.scan().commits.length, 1);
  assert.equal(w.scan().commits.length, 0, 'already-seen commits must not be re-ingested');

  commit(root, 'src/b.ts', 'b', 'two');
  assert.equal(w.scan().commits.length, 1);

  rmSync(root, { recursive: true, force: true });
});

test('a commit subject containing newlines and quotes does not corrupt the parse', () => {
  const root = repo();
  // Commit subjects contain anything. A line-based parse works for months and then mangles
  // one commit and silently corrupts the history — hence the control-char field separators.
  commit(root, 'src/a.ts', 'a', 'fix: handle "quoted" | piped \x1f weirdness');

  const store = new Store(root);
  const res = new GitWatcher(root, store).scan();
  assert.equal(res.commits.length, 1);
  assert.ok(res.commits[0]!.summary?.startsWith('fix: handle "quoted"'));

  rmSync(root, { recursive: true, force: true });
});

test('a non-git directory reports absent, not an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'cv-nogit-'));
  const res = new GitWatcher(root, new Store(root)).scan();

  // Plenty of real projects aren't repos. That is a normal state to report, not a crash.
  assert.equal(res.absent, true);
  assert.equal(res.commits.length, 0);

  rmSync(root, { recursive: true, force: true });
});
