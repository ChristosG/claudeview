import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { TranscriptTailer, slugFor } from './transcripts.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cv-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'cv-home-'));
  const dir = join(home, 'projects', slugFor(root));
  mkdirSync(dir, { recursive: true });
  return { root, home, transcript: join(dir, 'session.jsonl') };
}

const line = (o: unknown) => JSON.stringify(o) + '\n';

test('extracts prompts, tools and churn from a transcript', () => {
  const { root, home, transcript } = fixture();
  writeFileSync(
    transcript,
    line({ type: 'user', sessionId: 's1', uuid: 'u1', cwd: root, timestamp: '2026-01-01T00:00:00Z', message: { content: 'add retries' } }) +
      line({ type: 'user', sessionId: 's1', uuid: 'u2', cwd: root, timestamp: '2026-01-01T00:00:01Z', message: { content: '<command-name>/model</command-name>' } }) +
      line({ type: 'assistant', sessionId: 's1', uuid: 'a1', cwd: root, timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(root, 'src/api.ts') } }] } }) +
      line({ type: 'user', sessionId: 's1', uuid: 'u3', cwd: root, timestamp: '2026-01-01T00:00:03Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { filePath: join(root, 'src/api.ts'), userModified: true, structuredPatch: [{ lines: ['+a', '+b', '-c'] }] } }),
  );

  const store = new Store(root);
  const res = new TranscriptTailer(root, store, home).tail();

  const events = store.all('event');
  const prompts = events.filter((e) => e.type === 'prompt');
  const commands = events.filter((e) => e.type === 'command');

  // A slash command is not a prompt. Counting /model as "something Chris asked for"
  // would quietly inflate every statistic in the app.
  assert.equal(prompts.length, 1);
  assert.equal(commands.length, 1);
  assert.equal(prompts[0]!.summary, 'add retries');

  const edit = events.find((e) => e.churn);
  assert.deepEqual(edit!.churn, { added: 2, removed: 1 });
  assert.equal(edit!.userModified, true);
  assert.deepEqual(edit!.paths, ['src/api.ts']);
  assert.equal(res.recordsSkipped, 0);
});

test('is incremental: a second tail reads only the new bytes', () => {
  const { root, home, transcript } = fixture();
  writeFileSync(transcript, line({ type: 'user', sessionId: 's1', uuid: 'u1', cwd: root, timestamp: '2026-01-01T00:00:00Z', message: { content: 'first' } }));

  const store = new Store(root);
  const tailer = new TranscriptTailer(root, store, home);

  const a = tailer.tail();
  assert.equal(a.recordsSeen, 1);

  // Nothing new on disk: a re-tail must read zero bytes, not re-scan 24MB.
  const b = tailer.tail();
  assert.equal(b.bytesRead, 0);
  assert.equal(b.recordsSeen, 0);

  appendFileSync(transcript, line({ type: 'user', sessionId: 's1', uuid: 'u2', cwd: root, timestamp: '2026-01-01T00:00:05Z', message: { content: 'second' } }));
  const c = tailer.tail();
  assert.equal(c.recordsSeen, 1);
  assert.equal(store.all('event').filter((e) => e.type === 'prompt').length, 2);
});

test('survives garbage without throwing', () => {
  const { root, home, transcript } = fixture();
  writeFileSync(
    transcript,
    'not json at all\n' +
      line({ type: 'wat', totally: 'unknown shape from a future Claude Code release' }) +
      line({ type: 'user', sessionId: 's1', uuid: 'u1', cwd: root, timestamp: '2026-01-01T00:00:00Z', message: { content: 'still works' } }),
  );

  const store = new Store(root);
  const res = new TranscriptTailer(root, store, home).tail();

  // The transcript format is Claude Code's private, unversioned internal format. It will
  // change under us. Degrading past the bits we don't understand is the whole contract.
  assert.equal(res.recordsSkipped, 1);
  assert.equal(store.all('event').filter((e) => e.type === 'prompt').length, 1);
});

test('ignores a half-written trailing line', () => {
  const { root, home, transcript } = fixture();
  writeFileSync(
    transcript,
    line({ type: 'user', sessionId: 's1', uuid: 'u1', cwd: root, timestamp: '2026-01-01T00:00:00Z', message: { content: 'complete' } }) +
      '{"type":"user","sessionId":"s1","message":{"content":"half writ',
  );

  const store = new Store(root);
  const tailer = new TranscriptTailer(root, store, home);
  tailer.tail();
  assert.equal(store.all('event').length, 1);

  // Completing the line later must yield the record — we must not have checkpointed past it.
  appendFileSync(transcript, 'ten"}}\n');
  tailer.tail();
  assert.equal(store.all('event').filter((e) => e.type === 'prompt').length, 2);
});

test('excludes sessions whose cwd is a different repo', () => {
  const { root, home, transcript } = fixture();
  writeFileSync(
    transcript,
    line({ type: 'user', sessionId: 's1', uuid: 'u1', cwd: '/some/other/repo', timestamp: '2026-01-01T00:00:00Z', message: { content: 'not ours' } }) +
      line({ type: 'user', sessionId: 's1', uuid: 'u2', cwd: root, timestamp: '2026-01-01T00:00:01Z', message: { content: 'ours' } }),
  );

  const store = new Store(root);
  new TranscriptTailer(root, store, home).tail();

  // The directory slug is lossy ('/' and '_' both become '-'), so it can collide across
  // projects. cwd is authoritative.
  const prompts = store.all('event').filter((e) => e.type === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.summary, 'ours');
});
