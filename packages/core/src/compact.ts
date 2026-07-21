import { existsSync, mkdirSync, copyFileSync, renameSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { FILES, type Kind } from './schema.js';

/**
 * Repair a store bloated by pre-dirty-check write amplification.
 *
 * The disease is fixed at the source (see `unchanged` in store.ts): a record whose content has
 * not changed no longer appends. But that does nothing for stores already on disk, and there
 * are real ones — a project reached 1.2 GB in 44 hours of dashboard uptime, with 630,571
 * revisions of 156 sessions and 573,227 revisions of 19,270 events. Past 536,870,888 bytes a
 * log could not be read at all, and the dashboard 500'd on every request while appearing,
 * from the launcher's point of view, to have failed to start.
 *
 * Compaction folds each log to one line per record — the winning revision, exactly what every
 * reader would have computed anyway. It is pure local file I/O: no model, no network, no
 * tokens. It is also a ONE-TIME repair, not maintenance; with the dirty check in place a store
 * grows with activity rather than with uptime, so there is nothing to schedule.
 */

/**
 * Kinds safe to fold — and the list is deliberately short.
 *
 * All three are machine-generated and regenerable: `event` and `component` are pure functions
 * of the transcripts and the code (they live in gitignored `cache/` for exactly that reason),
 * and `session` is a rollup the observer recomputes from the event log on every tick. Their
 * intermediate revisions are an artifact of how often a poller ran, not a record of anything
 * that happened.
 *
 * Everything else — decision, insight, experiment, run, thread, flow, panel — is authored, and
 * its revision history is the entire point of the project. Being able to ask in month seven
 * "what did we think before we changed our minds" is the feature. Those kinds are excluded by
 * NAME rather than by size, because a size threshold would eventually cross some project's
 * decision log and silently eat the history it exists to protect.
 */
export const COMPACTABLE: ReadonlySet<Kind> = new Set<Kind>(['session', 'event', 'component']);

export interface CompactedKind {
  kind: Kind;
  file: string;
  before: number;
  after: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface CompactResult {
  repo: string;
  kinds: CompactedKind[];
  bytesBefore: number;
  bytesAfter: number;
  bytesSaved: number;
  backupDir?: string;
  ms: number;
}

export function compactStore(
  repoRoot: string,
  opts: { kinds?: Kind[]; storeDir?: string } = {},
): CompactResult {
  const started = Date.now();
  const store = new Store(repoRoot, opts.storeDir);
  // `opts.kinds` is a deliberate override for tests and hand-driven repair. Every caller that
  // matters — the CLI, the doctor — takes the default, which cannot include an authored kind.
  const kinds = opts.kinds ?? [...COMPACTABLE];

  const backupDir = join(store.dir, 'backup');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const done: CompactedKind[] = [];
  let madeBackupDir = false;

  for (const kind of kinds) {
    const file = store.fileFor(kind);
    if (!existsSync(file)) continue;

    // Fold including tombstones. `all()` would drop them, and a dropped tombstone resurrects
    // every deleted record on the next read — a silent, delayed data corruption.
    const folded = store.foldedRaw(kind);
    const before = store.lastStats.parsed + store.lastStats.skipped;
    if (folded.size === before) continue; // already one line per record; touch nothing

    const bytesBefore = statSync(file).size;

    // Oldest first, so the compacted log still reads chronologically — it is meant to stay
    // greppable and reviewable by hand, which was the reason for JSONL in the first place.
    const rows = [...folded.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    if (!madeBackupDir) {
      mkdirSync(backupDir, { recursive: true });
      madeBackupDir = true;
    }
    copyFileSync(file, join(backupDir, `${FILES[kind]}.${stamp}`));

    // Temp-then-rename: a crash or a full disk mid-write leaves the original whole. Writing
    // in place would turn a repair into the truncation it was supposed to prevent.
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }

    done.push({
      kind, file, before, after: rows.length,
      bytesBefore, bytesAfter: statSync(file).size,
    });
  }

  const bytesBefore = done.reduce((n, k) => n + k.bytesBefore, 0);
  const bytesAfter = done.reduce((n, k) => n + k.bytesAfter, 0);
  return {
    repo: repoRoot,
    kinds: done,
    bytesBefore,
    bytesAfter,
    bytesSaved: bytesBefore - bytesAfter,
    ...(madeBackupDir ? { backupDir } : {}),
    ms: Date.now() - started,
  };
}
