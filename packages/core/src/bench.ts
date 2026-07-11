/**
 * Ingest a real repo's transcripts and report what came out. This is the Phase-1
 * verification gate: the Observer must chew through a 24MB session fast, incrementally,
 * and without crashing on a single unfamiliar record.
 *
 *   tsx src/bench.ts <repoRoot>
 */
import { rmSync } from 'node:fs';
import { Store } from './store.js';
import { TranscriptTailer, transcriptDirs } from './observer/transcripts.js';
import { CodeIndexer } from './observer/code.js';

const repo = process.argv[2];
// Write the store somewhere scratch, NOT into the repo being measured. Benchmarking
// must never leave a footprint in someone else's working tree.
const storeDir = process.argv[3];
if (!repo || !storeDir) {
  console.error('usage: tsx src/bench.ts <repoRoot> <scratchStoreDir>');
  process.exit(1);
}

// Start clean so the numbers describe a cold ingest, not a resumed one.
rmSync(storeDir, { recursive: true, force: true });

const dirs = transcriptDirs(repo);
console.log(`transcript dirs: ${dirs.length}`);
for (const d of dirs) console.log(`  ${d}`);

const store = new Store(repo, storeDir);
const tailer = new TranscriptTailer(repo, store);

const t0 = performance.now();
const cold = tailer.tail();
const coldMs = performance.now() - t0;

const t1 = performance.now();
const warm = tailer.tail();
const warmMs = performance.now() - t1;

const events = store.all('event');
const by = (f: (e: (typeof events)[number]) => boolean) => events.filter(f).length;
const tools = new Map<string, number>();
for (const e of events) if (e.tool) tools.set(e.tool, (tools.get(e.tool) ?? 0) + 1);

const churn = events.reduce(
  (a, e) => ({ added: a.added + (e.churn?.added ?? 0), removed: a.removed + (e.churn?.removed ?? 0) }),
  { added: 0, removed: 0 },
);
const files = new Set(events.flatMap((e) => e.paths));

console.log(`
COLD INGEST
  ${(cold.bytesRead / 1e6).toFixed(1)} MB across ${cold.filesRead} files in ${coldMs.toFixed(0)}ms  (${(cold.bytesRead / 1e6 / (coldMs / 1000)).toFixed(1)} MB/s)
  records: ${cold.recordsSeen} seen, ${cold.recordsSkipped} skipped (${((cold.recordsSkipped / Math.max(1, cold.recordsSeen)) * 100).toFixed(1)}%)

WARM RE-TAIL (must be ~zero — this is what makes it live-updatable)
  ${warm.bytesRead} bytes, ${warm.recordsSeen} records, ${warmMs.toFixed(1)}ms

EXTRACTED
  events        ${events.length}
  prompts       ${by((e) => e.type === 'prompt')}
  slash cmds    ${by((e) => e.type === 'command')}
  compactions   ${by((e) => e.type === 'compact')}
  sessions      ${new Set(events.map((e) => e.sessionId)).size}
  files touched ${files.size}
  churn         +${churn.added} / -${churn.removed} lines
  human-corrected-after-Claude   ${by((e) => e.userModified === true)}
  failed tool calls (inferred)   ${by((e) => e.ok === false)}

AGENT ATTRIBUTION  (a flat scan of the project dir sees none of this)
  main-thread events   ${by((e) => e.agent.type === 'main')}
  subagent events      ${by((e) => e.agent.type === 'subagent')}
  distinct subagents   ${new Set(events.filter((e) => e.agent.id).map((e) => e.agent.id)).size}
  workflows            ${new Set(events.filter((e) => e.agent.workflow).map((e) => e.agent.workflow)).size}

TOP TOOLS
${[...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `  ${String(n).padStart(5)}  ${t}`).join('\n')}
`);

// ── The structural map, derived from the AST. Zero tokens, cannot be wrong. ──
const idx = await new CodeIndexer(repo, store).index();
const comps = store.all('component');
const byLang = new Map<string, number>();
for (const c of comps) byLang.set(c.language, (byLang.get(c.language) ?? 0) + 1);

// Which components does the session history actually touch? This is the join that makes
// the map *live*: architecture on one axis, what we've been doing on the other.
const touched = new Set(events.flatMap((e) => e.paths));
const hot = comps
  .filter((c) => !c.symbol && touched.has(c.path))
  .map((c) => ({ path: c.path, edits: events.filter((e) => e.paths.includes(c.path) && e.tool === 'Edit').length }))
  .sort((a, b) => b.edits - a.edits)
  .slice(0, 8);

console.log(`CODE INDEX
  ${idx.filesScanned} files scanned in ${idx.ms.toFixed(0)}ms  (${idx.filesFailed} failed${idx.grammarsFailed.length ? `, no grammar for: ${idx.grammarsFailed.join(', ')}` : ''})
  components    ${comps.length}  (${comps.filter((c) => c.symbol).length} symbols, ${comps.filter((c) => !c.symbol).length} files)
  languages     ${[...byLang.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}:${n}`).join('  ')}

HOTTEST FILES  (structural map × session history — the join neither source can make alone)
${hot.map((h) => `  ${String(h.edits).padStart(4)} edits  ${h.path}`).join('\n')}
`);
