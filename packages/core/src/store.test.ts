import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
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

/**
 * A long-lived Store re-reads when the file changes underneath it — and not otherwise.
 *
 * The dashboard server built a NEW Store for every HTTP request (`const store = () => new
 * Store(REPO)`), so every API call re-parsed the entire log from disk. At 36 MB that is 0.39s
 * and merely wasteful; at 513 MB it was minutes, and the dashboard was unreachable.
 *
 * The obvious fix — one Store, held forever — is wrong, and quietly so. This store is written
 * by processes we are not: another Claude session's MCP writes, the plugin's hooks, a headless
 * drain runner, `git pull`. A cached instance would serve confidently stale data, which for a
 * tool whose entire purpose is telling you when something is out of date would be a
 * particularly humiliating bug.
 *
 * So the cache validates itself against the file's size and mtime before every use. Cheap
 * (one stat), and it trusts nothing: not a watcher, not a notification, not our own assumption
 * that we are the only writer. The same reasoning as `watchEverything` polling a fingerprint
 * rather than believing fs.watch — look, don't trust.
 */
test('a held Store sees other writers, without re-reading on every call', () => {
  const root = repo();
  const held = new Store(root);
  const rec = (id: string, title: string) => ({
    id, provenance: 'authored' as const, title, detail: 'd',
    severity: 'low' as const, confidence: 0.5, status: 'open' as const,
  });

  held.put('insight', rec('i1', 'first') as any);
  assert.equal(held.all('insight').length, 1);

  // Reading repeatedly must not re-parse the log repeatedly. This is the whole point.
  const afterFirstRead = held.reloads;
  for (let i = 0; i < 50; i++) held.all('insight');
  assert.equal(held.reloads, afterFirstRead, '50 reads, zero re-parses');

  // Nor must our OWN writes force a re-parse — that would restore the O(n^2) bulk ingest the
  // fold cache exists to prevent (measured: 59 MB of transcripts took 123 seconds).
  for (let i = 0; i < 50; i++) held.put('insight', rec(`own${i}`, `t${i}`) as any);
  assert.equal(held.reloads, afterFirstRead, '50 writes, still zero re-parses');
  assert.equal(held.all('insight').length, 51);

  // But a DIFFERENT process appending must be seen, on the very next read.
  const other = new Store(root);
  other.put('insight', rec('i2', 'from another session') as any);

  assert.equal(held.all('insight').length, 52, 'another writer is visible immediately');
  assert.equal(held.get('insight', 'i2')!.title, 'from another session');
  // Seen without re-reading history: the log only grew, so only the growth was read. See
  // 'growth is read incrementally; replacement is not' for the safety conditions on that.
  assert.equal(held.reloads, afterFirstRead, 'and it cost no full re-parse');

  // Including a wholesale rewrite of the log under us — what compaction and `git pull` do.
  const folded = other.foldedRaw('insight');
  writeFileSync(join(root, '.claudeview', 'insights.jsonl'),
    [...folded.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(held.all('insight').length, 52, 'a rewritten log is re-read, not assumed stale-free');

  rmSync(root, { recursive: true, force: true });
});

/**
 * An interleaved write by another process is never mistaken for our own.
 *
 * After appending, the store records the file's new size so its own write does not invalidate
 * its own cache. The hazard: if someone else appended between our write and that stat, we
 * would record THEIR bytes as ours and never re-read — silently losing their records until
 * something else happened to invalidate. Rare, but it is a lost-write bug, and those do not
 * announce themselves.
 *
 * So the size is checked, not assumed: we know exactly how many bytes we wrote, and if the
 * file did not grow by precisely that much, someone else was here and the cache is dropped.
 */
test('a concurrent appender is not swallowed by our own write', () => {
  const root = repo();
  const held = new Store(root);
  const rec = (id: string) => ({
    id, provenance: 'authored' as const, title: id, detail: 'd',
    severity: 'low' as const, confidence: 0.5, status: 'open' as const,
  });

  held.put('insight', rec('mine1') as any);
  held.all('insight');

  // Another process appends, and THEN we append — without us ever reading in between.
  appendFileSync(
    join(root, '.claudeview', 'insights.jsonl'),
    JSON.stringify({
      id: 'theirs', kind: 'insight', rev: 0, actor: 'other-machine',
      ts: '2026-07-21T00:00:00.000Z', provenance: 'authored', title: 'theirs',
      detail: 'd', severity: 'low', confidence: 0.5, evidence: [], status: 'open',
    }) + '\n',
  );
  held.put('insight', rec('mine2') as any);

  const ids = held.all('insight').map((r) => r.id).sort();
  assert.deepEqual(ids, ['mine1', 'mine2', 'theirs'], 'nobody lost a record');

  rmSync(root, { recursive: true, force: true });
});

/**
 * An append-only log should only ever cost what was appended.
 *
 * The cache validates itself against the file, which is correct but was all-or-nothing: any
 * change meant re-parsing the whole log. That is fine when the store is idle and catastrophic
 * when it is not — and it is never idle during a live session, because the observer appends
 * events every couple of seconds. So the dashboard re-parsed every megabyte of history to
 * answer every request, and refreshing it "took ages" precisely while you were working, which
 * is the only time anyone looks at it.
 *
 * The log is APPEND-ONLY. That is the whole design. So when it has only grown, read the new
 * bytes and fold them into what we already have: cost proportional to what happened, not to
 * everything that has ever happened.
 *
 * Safety is by inode plus a boundary hash, not by size alone:
 *
 *   - inode catches wholesale replacement — `cv compact` writes a temp file and renames, and
 *     `git pull`/`git checkout` do the same, so the inode changes and we re-read in full;
 *   - the boundary hash (the bytes immediately before where we stopped) catches an IN-PLACE
 *     rewrite that happens to leave the file longer, which keeps the inode and would
 *     otherwise have us tailing from an offset into content that no longer means what it did.
 *
 * Get either wrong and the store silently answers from a mixture of two different files.
 */
test('growth is read incrementally; replacement is not', () => {
  const root = repo();
  const held = new Store(root);
  const f = join(root, '.claudeview', 'insights.jsonl');
  const rec = (id: string, title: string) => ({
    id, provenance: 'authored' as const, title, detail: 'd',
    severity: 'low' as const, confidence: 0.5, status: 'open' as const,
  });
  const raw = (id: string, title: string) => JSON.stringify({
    id, kind: 'insight', rev: 0, actor: 'someone-else', ts: '2026-07-21T00:00:00.000Z',
    provenance: 'authored', title, detail: 'd', severity: 'low', confidence: 0.5,
    evidence: [], status: 'open',
  }) + '\n';

  for (let i = 0; i < 200; i++) held.put('insight', rec(`i${i}`, `t${i}`) as any);
  assert.equal(held.all('insight').length, 200);
  const fullReads = held.reloads;
  const tails = held.tails;

  // Another process appends — the live-session case, over and over.
  for (let n = 0; n < 5; n++) {
    appendFileSync(f, raw(`other${n}`, `from elsewhere ${n}`));
    assert.equal(held.all('insight').length, 201 + n, 'the new record is visible');
  }
  assert.equal(held.reloads, fullReads, 'growth never triggered a full re-parse');
  assert.equal(held.tails, tails + 5, 'it was read incrementally, five times');
  assert.equal(held.get('insight', 'other4')!.title, 'from elsewhere 4');

  // Compaction: temp file, then rename. New inode — this MUST be read in full, because the
  // bytes we already hold have been replaced rather than added to.
  const folded = held.foldedRaw('insight');
  writeFileSync(`${f}.tmp`, [...folded.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  renameSync(`${f}.tmp`, f);
  assert.equal(held.all('insight').length, 205, 'still correct after replacement');
  assert.ok(held.reloads > fullReads, 'and it was a full re-parse, not a tail');

  // An in-place rewrite that leaves the file LONGER keeps the inode, so only the boundary
  // hash can catch it. Without that check this returns a blend of two different files.
  const beforeInPlace = held.reloads;
  writeFileSync(f, [raw('rewritten', 'in place'), raw('rewritten2', 'in place too'),
    ...[...folded.values()].map((r) => JSON.stringify(r) + '\n')].join(''));
  const after = held.all('insight');
  assert.ok(after.some((r) => r.id === 'rewritten'), 'in-place rewrite is not missed');
  assert.equal(after.length, 207);
  assert.ok(held.reloads > beforeInPlace, 'the boundary hash forced a full re-parse');

  rmSync(root, { recursive: true, force: true });
});
