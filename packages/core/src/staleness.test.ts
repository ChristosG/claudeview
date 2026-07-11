import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { CodeIndexer } from './observer/code.js';
import { checkStaleness, needsAttention } from './staleness.js';

/**
 * THE CORE THESIS TEST.
 *
 * The entire premise of ClaudeView is that an authored diagram can be made incapable of
 * rotting silently — that if the code behind a box changes, the box says so, with nobody
 * telling it to. If this test fails, the idea does not work and the project should stop.
 *
 * So this test builds a real retrieval pipeline, has Claude "author" a Flow over it,
 * changes a function, and asserts the diagram notices by itself.
 */

const RETRIEVER = `
def preprocess(query):
    return query.strip().lower()

def embed(text):
    return model.encode(text)

def bm25_search(query, k=10):
    return index.search(query, k)

def rerank(candidates):
    return sorted(candidates, key=lambda c: c.score, reverse=True)
`;

function repoWithPipeline() {
  const root = mkdtempSync(join(tmpdir(), 'cv-thesis-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'retriever.py'), RETRIEVER);
  return root;
}

/** Author the Flow Chris actually asked for: query → preprocess → embed → bm25 → rerank. */
async function authorFlow(root: string, store: Store) {
  const components = store.all('component');
  const anchorFor = (symbol: string) => {
    const c = components.find((x) => x.symbol === symbol);
    assert.ok(c, `indexer should have found ${symbol}`);
    return { path: c.path, symbol, hash: c.hash };
  };

  store.put('flow', {
    id: 'retrieval',
    provenance: 'authored',
    name: 'Retrieval pipeline',
    summary: 'How a query becomes an answer',
    steps: [
      { id: 's1', label: 'Preprocess', description: 'normalise the query', components: [], anchors: [anchorFor('preprocess')], next: ['s2'] },
      { id: 's2', label: 'Embed', description: 'dense vector', components: [], anchors: [anchorFor('embed')], next: ['s3'] },
      { id: 's3', label: 'BM25', description: 'lexical search', components: [], anchors: [anchorFor('bm25_search')], next: ['s4'] },
      { id: 's4', label: 'Rerank', description: 'cross-encoder rerank', components: [], anchors: [anchorFor('rerank')], next: [] },
    ],
  });
}

test('THESIS: an authored flow detects that the code beneath it changed', async () => {
  const root = repoWithPipeline();
  const store = new Store(root);
  const indexer = new CodeIndexer(root, store);

  await indexer.index();
  await authorFlow(root, store);

  // Nothing has changed yet: the diagram describes reality.
  assert.equal(checkStaleness(store).stale, 0, 'a freshly authored flow must be fresh');

  // Now do the thing that silently invalidates every hand-drawn architecture diagram in
  // the world: quietly change how one step works. Nobody updates the docs. Nobody
  // remembers. Three weeks pass.
  writeFileSync(
    join(root, 'src', 'retriever.py'),
    RETRIEVER.replace('return index.search(query, k)', 'return hybrid_index.search(query, k, alpha=0.7)'),
  );
  await indexer.index();

  const report = checkStaleness(store);

  // The diagram must now be flagged — without a model, without a prompt, without anyone
  // noticing the code had changed.
  assert.equal(report.stale, 1, 'the flow must flag itself as stale');
  assert.equal(report.fresh, 0);

  const flagged = needsAttention(report);
  assert.equal(flagged[0]!.id, 'retrieval');

  // And it must be precise about WHICH box went stale. "Something in here is wrong" is
  // not useful; "the BM25 step is wrong" is.
  const bad = flagged[0]!.anchors.filter((a) => a.freshness !== 'fresh');
  assert.equal(bad.length, 1, 'exactly one step should be implicated');
  assert.equal(bad[0]!.anchor.symbol, 'bm25_search');

  rmSync(root, { recursive: true, force: true });
});

test('a change to one function does not falsely implicate its neighbours', async () => {
  const root = repoWithPipeline();
  const store = new Store(root);
  const indexer = new CodeIndexer(root, store);
  await indexer.index();
  await authorFlow(root, store);

  // Edit `rerank` only. The other three steps live in the SAME FILE — if we hashed files
  // instead of symbols, all four boxes would light up and the trust panel would instantly
  // become the noise that everybody learns to ignore.
  writeFileSync(
    join(root, 'src', 'retriever.py'),
    RETRIEVER.replace('key=lambda c: c.score', 'key=lambda c: c.score * c.recency'),
  );
  await indexer.index();

  const bad = needsAttention(checkStaleness(store))[0]!.anchors.filter((a) => a.freshness !== 'fresh');
  assert.equal(bad.length, 1, 'only the edited symbol may be flagged');
  assert.equal(bad[0]!.anchor.symbol, 'rerank');

  rmSync(root, { recursive: true, force: true });
});

test('deleting the code a claim describes marks it broken, not merely stale', async () => {
  const root = repoWithPipeline();
  const store = new Store(root);
  const indexer = new CodeIndexer(root, store);
  await indexer.index();
  await authorFlow(root, store);

  // The step's implementation is gone entirely. That is worse than "changed": the claim
  // now describes code that does not exist, and must be ranked above merely-stale ones.
  writeFileSync(
    join(root, 'src', 'retriever.py'),
    RETRIEVER.replace(/def bm25_search[\s\S]*?return index\.search\(query, k\)\n/, ''),
  );
  await indexer.index();

  const report = checkStaleness(store);
  assert.equal(report.broken, 1);
  assert.equal(report.stale, 0);
  assert.equal(needsAttention(report)[0]!.freshness, 'broken');

  rmSync(root, { recursive: true, force: true });
});

test('an unanchored claim is counted as unverifiable, never as fresh', () => {
  const root = mkdtempSync(join(tmpdir(), 'cv-unanchored-'));
  const store = new Store(root);

  // A decision that cites no code cannot be checked. Reporting it as 'fresh' would be a
  // lie of omission — the most dangerous kind here, because it looks like verification.
  store.put('decision', {
    id: 'd1', provenance: 'authored',
    title: 'Use hybrid retrieval', choice: 'BM25 + dense',
    rationale: 'better recall', alternatives: [], anchors: [], status: 'active',
  });

  const report = checkStaleness(store);
  assert.equal(report.unanchored, 1);
  assert.equal(report.fresh, 0);
  assert.equal(report.claims.length, 0);

  rmSync(root, { recursive: true, force: true });
});
