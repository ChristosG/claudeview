import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';

const repo = () => mkdtempSync(join(tmpdir(), 'cv-store-'));
const lines = (root: string, f: string) =>
  readFileSync(join(root, '.claudeview', f), 'utf8').trim().split('\n').filter(Boolean).length;

/**
 * A re-put of unchanged content must not append.
 *
 * This is the bug that killed a real store. `rollUpSessions` recomputes a rollup for EVERY
 * session on every observer tick and writes them all back; the poller ticks every 2s. Each
 * tick therefore appended one full copy of every session that had ever existed, whether or
 * not anything about it had changed. On a real project that turned 156 sessions into 630,571
 * revisions — one of them at rev:1774 — and grew sessions.jsonl to 537,008,888 bytes.
 *
 * That number matters: V8's maximum string length is 536,870,888. The store reads a log with
 * readFileSync(f, 'utf8'), which builds ONE string, so at 6,196 bytes past the limit the file
 * stopped being readable at all. Every API route that touched sessions returned HTTP 500, and
 * because the launcher probed liveness with `curl -sf`, a perfectly healthy server that simply
 * could not read its own store was reported as "dashboard failed to start" — forever, on every
 * restart, with the port blamed for it.
 *
 * The guarantee is enforced HERE, at the store, rather than at the one caller that happened to
 * trigger it. A no-op revision carries no information by definition: same id, same payload,
 * differing only in the bookkeeping the store stamps itself. Any caller can now recompute and
 * write back freely — which is exactly the ergonomic that made rollUpSessions read so
 * innocently — without the log growing in proportion to uptime instead of to activity.
 */
test('rewriting a record with identical content appends nothing', () => {
  const root = repo();
  const s = new Store(root);

  const row = {
    id: 'session:abc',
    sessionId: 'abc',
    provenance: 'observed' as const,
    startedAt: '2026-07-01T00:00:00.000Z',
    endedAt: '2026-07-01T01:00:00.000Z',
    stats: { prompts: 3, edits: 2, writes: 0, bash: 1, filesTouched: ['a.ts'] },
  };

  const first = s.put('session', row);
  assert.equal(first.rev, 0);
  assert.equal(lines(root, 'sessions.jsonl'), 1);

  // The rollup recomputes and writes back, 500 times, changing nothing. This is the exact
  // shape of the real failure — same content, over and over, from a poller.
  for (let i = 0; i < 500; i++) s.put('session', row);

  assert.equal(lines(root, 'sessions.jsonl'), 1, 'unchanged rewrites must not append');
  assert.equal(s.get('session', 'session:abc')!.rev, 0, 'and must not burn revisions');

  rmSync(root, { recursive: true, force: true });
});

/**
 * ...but a real change still appends. The dirty check must compare the PAYLOAD, not identity.
 *
 * The failure mode to guard against is over-correcting: a store that dedupes too eagerly
 * silently drops edits, which is far worse than bloat. A session that is still running grows
 * its endedAt and its counts on every tick, and every one of those is a genuine revision that
 * the trust model depends on — the git watcher uses a session's time window to decide whether
 * a commit was witnessed or is foreign.
 */
test('a changed record still appends a new revision', () => {
  const root = repo();
  const s = new Store(root);
  const base = {
    id: 'session:abc',
    sessionId: 'abc',
    provenance: 'observed' as const,
    startedAt: '2026-07-01T00:00:00.000Z',
    stats: { prompts: 1, edits: 0, writes: 0, bash: 0, filesTouched: [] },
  };

  s.put('session', base);
  s.put('session', { ...base, endedAt: '2026-07-01T02:00:00.000Z' }); // session grew
  s.put('session', { ...base, endedAt: '2026-07-01T02:00:00.000Z', stats: { ...base.stats, edits: 4 } });

  assert.equal(lines(root, 'sessions.jsonl'), 3);
  assert.equal(s.get('session', 'session:abc')!.rev, 2);
  assert.equal(s.get('session', 'session:abc')!.stats.edits, 4);

  // An authored summary arriving later is a change like any other, and must not be swallowed.
  s.put('session', { ...base, endedAt: '2026-07-01T02:00:00.000Z', stats: { ...base.stats, edits: 4 }, summary: 'fixed the parser' });
  assert.equal(s.get('session', 'session:abc')!.summary, 'fixed the parser');
  assert.equal(lines(root, 'sessions.jsonl'), 4);

  rmSync(root, { recursive: true, force: true });
});

/**
 * The log is read in chunks, so no single string bounds the store — and records that straddle
 * a chunk boundary survive it.
 *
 * The dirty check above stops this store from ever reaching 512 MiB again, but it does not
 * help the stores that are already there, and it does not help a genuinely enormous event
 * cache on a long-lived project. Reading line-wise rather than as one string turns a hard
 * cliff into a gentle slope: a big store gets slower, which you can see and act on, and never
 * becomes unreadable, which looks like a dead dashboard.
 *
 * Building a real 512 MiB file here would make the suite unusable, so this tests the property
 * at the scale where a chunked reader actually breaks. Two real hazards, both invisible at
 * 512 MiB and both reproducible at 64 bytes:
 *
 *   - a JSON line split across two reads, which a naive reader silently truncates into
 *     garbage, skipping a record while reporting success;
 *   - a multi-byte UTF-8 character split across two reads, which decodes to U+FFFD and
 *     corrupts a path or a summary rather than failing loudly.
 *
 * Both are exactly the "reports success, quietly does nothing" class this project exists to
 * catch, so they get pinned rather than trusted.
 */
test('records survive chunk boundaries, in bytes and in characters', () => {
  const root = repo();
  const s = new Store(root);
  const f = join(root, '.claudeview', 'sessions.jsonl');

  const rows: string[] = [];
  for (let i = 0; i < 500; i++) {
    rows.push(JSON.stringify({
      id: `session:${i}`, kind: 'session', rev: 0, actor: 'test', ts: '2026-07-01T00:00:00.000Z',
      sessionId: String(i), provenance: 'observed', startedAt: '2026-07-01T00:00:00.000Z',
      // Non-ASCII on purpose: 'ή' and 'ό' are two bytes each, so at a small chunk size some
      // record is guaranteed to have a character bisected by a read.
      summary: `διόρθωσα τη ρύθμιση #${i} — καθαρή`,
      stats: { prompts: 0, edits: 0, writes: 0, bash: 0, filesTouched: [`src/αρχείο${i}.ts`] },
    }));
  }
  writeFileSync(f, rows.join('\n') + '\n');

  // A chunk far smaller than one record forces every hazard above on every line.
  for (const chunk of [16, 64, 997, 1 << 22]) {
    const st = new Store(root, undefined, { chunkSize: chunk });
    const all = st.all('session');
    assert.equal(all.length, 500, `all records read at chunkSize=${chunk}`);
    assert.equal(st.lastStats.skipped, 0, `nothing skipped at chunkSize=${chunk}`);
    const one = st.get('session', 'session:499')!;
    assert.equal(one.summary, 'διόρθωσα τη ρύθμιση #499 — καθαρή', `text intact at chunkSize=${chunk}`);
    assert.equal(one.stats.filesTouched[0], 'src/αρχείο499.ts', `paths intact at chunkSize=${chunk}`);
  }

  // Fail-soft is not negotiable: a half-written line from a crash mid-append, or a botched
  // git merge, must cost one record and not the whole dashboard. Note the truncated line has
  // no trailing newline — the last line of a file is still a line.
  writeFileSync(f, rows.join('\n') + '\n{"id":"session:trunc","kind":"sess');
  const st = new Store(root, undefined, { chunkSize: 64 });
  assert.equal(st.all('session').length, 500);
  assert.equal(st.lastStats.skipped, 1);

  rmSync(root, { recursive: true, force: true });
});
