import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { FILES, Record as CVRecord, type Kind } from './schema.js';

/**
 * The store. Append-only JSONL, one file per kind, living inside the repo at
 * `.claudeview/` and committed to git.
 *
 * Why append-only rather than a database:
 *
 *   - It merges. Two machines (or a laptop and a server) both writing decisions
 *     produce two appended lines, not a conflicting edit to line 47. Git resolves it
 *     without a human. A SQLite blob would conflict on every single pull.
 *   - It is readable. You can grep it, hand-edit it, and review it in a PR — the diff
 *     reads like a changelog of thinking.
 *   - It is total. An "update" appends a new revision and a "delete" appends a
 *     tombstone, so nothing is ever destroyed. The full history is always recoverable.
 *
 * The SQLite index built on top of this is a pure function of these files and can be
 * deleted at any time. These files are the only truth.
 */

/** An update to record `id` appends a new revision; readers keep the winner. */
function wins(a: CVRecord, b: CVRecord): CVRecord {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  // Same rev and same timestamp: two machines wrote concurrently. Break the tie on
  // actor id so that every machine folds the log to the SAME answer. An arbitrary but
  // deterministic winner beats a merge conflict.
  return a.actor > b.actor ? a : b;
}

export interface StoreStats {
  parsed: number;
  skipped: number;
}

/** What a caller supplies: the payload, minus the bookkeeping the store stamps itself. */
export type PutInput<K extends Kind> = Omit<
  Extract<CVRecord, { kind: K }>,
  'kind' | 'rev' | 'actor' | 'ts'
> & { ts?: string };

export class Store {
  readonly dir: string;
  readonly actor: string;
  /** Malformed lines encountered. Surfaced, never thrown — see `readRaw`. */
  lastStats: StoreStats = { parsed: 0, skipped: 0 };

  /**
   * Folded state, per kind, built once and maintained on write.
   *
   * Without this, `put` would re-read and re-parse the whole log to find the current
   * revision of one id — turning a bulk ingest into an O(n²) crawl. Measured: 59MB of
   * transcripts took 123 seconds before this cache existed.
   */
  private cache = new Map<Kind, Map<string, CVRecord>>();

  /**
   * `storeDir` defaults to `<repoRoot>/.claudeview` and should stay that way in real use —
   * the whole design rests on the knowledge living inside the repo and travelling with it.
   * The override exists so tools can analyse a repo read-only, without writing a single
   * byte into someone's working tree.
   */
  constructor(repoRoot: string, storeDir?: string) {
    this.dir = storeDir ?? join(repoRoot, '.claudeview');
    mkdirSync(join(this.dir, 'cache'), { recursive: true });
    mkdirSync(join(this.dir, 'panels'), { recursive: true });
    mkdirSync(join(this.dir, 'jobs'), { recursive: true });
    mkdirSync(join(this.dir, 'journal'), { recursive: true });
    this.actor = this.loadActor();
  }

  /**
   * A stable id for this machine. Lives in cache/ (gitignored) precisely because it
   * must NOT travel with the repo — a cloned checkout is a different actor, and if two
   * machines shared an actor id the tie-break above would be meaningless.
   */
  private loadActor(): string {
    const f = join(this.dir, 'cache', 'actor');
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    const id = `${hostname()}-${randomUUID().slice(0, 8)}`;
    writeFileSync(f, id);
    return id;
  }

  private file(kind: Kind): string {
    return join(this.dir, FILES[kind]);
  }

  /**
   * Read every line of a kind's log, tolerating garbage.
   *
   * This is deliberately fail-soft. The store may be hand-edited, half-merged by git, or
   * truncated by a crash mid-append. A parser that throws on the first bad line would
   * take down the whole dashboard over one stray comma. We skip and count instead.
   */
  private readRaw(kind: Kind): CVRecord[] {
    const f = this.file(kind);
    if (!existsSync(f)) {
      this.lastStats = { parsed: 0, skipped: 0 };
      return [];
    }
    const out: CVRecord[] = [];
    let skipped = 0;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      try {
        const parsed = CVRecord.safeParse(JSON.parse(t));
        if (parsed.success) out.push(parsed.data);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    this.lastStats = { parsed: out.length, skipped };
    return out;
  }

  /** Fold the log by id, keeping the winning revision of each. Cached after first build. */
  private folded(kind: Kind): Map<string, CVRecord> {
    let m = this.cache.get(kind);
    if (m) return m;
    m = new Map<string, CVRecord>();
    for (const r of this.readRaw(kind)) {
      const prev = m.get(r.id);
      m.set(r.id, prev ? wins(prev, r) : r);
    }
    this.cache.set(kind, m);
    return m;
  }

  /** Latest surviving revision of each id, tombstones removed. */
  all<K extends Kind>(kind: K): Extract<CVRecord, { kind: K }>[] {
    return [...this.folded(kind).values()].filter((r) => !r.deleted) as Extract<CVRecord, { kind: K }>[];
  }

  get<K extends Kind>(kind: K, id: string): Extract<CVRecord, { kind: K }> | undefined {
    const r = this.folded(kind).get(id);
    return r && !r.deleted ? (r as Extract<CVRecord, { kind: K }>) : undefined;
  }

  /** Drop the in-memory fold — e.g. after git rewrites the log under us on a pull. */
  invalidate(kind?: Kind): void {
    if (kind) this.cache.delete(kind);
    else this.cache.clear();
  }

  /** Every revision of an id, oldest first. The audit trail — "when did this change?" */
  history(kind: Kind, id: string): CVRecord[] {
    return this.readRaw(kind).filter((r) => r.id === id).sort((a, b) => a.rev - b.rev);
  }

  /**
   * Append a record. If `id` already exists, this becomes its next revision.
   *
   * A single `appendFileSync` opens with O_APPEND and issues one write, so concurrent
   * writers (an MCP tool and a PostToolUse hook firing at once) interleave whole lines
   * rather than corrupting each other's bytes.
   */
  put<K extends Kind>(kind: K, rec: PutInput<K>): Extract<CVRecord, { kind: K }> {
    return this.putMany(kind, [rec])[0]!;
  }

  /**
   * Append a batch in a single write.
   *
   * Bulk ingest goes through here, not through N calls to `put`: one `appendFileSync`
   * instead of thousands, and one cache update instead of thousands of full-log re-reads.
   */
  putMany<K extends Kind>(kind: K, recs: PutInput<K>[]): Extract<CVRecord, { kind: K }>[] {
    if (recs.length === 0) return [];
    const folded = this.folded(kind);
    const out: Extract<CVRecord, { kind: K }>[] = [];
    const lines: string[] = [];

    for (const rec of recs) {
      const existing = folded.get(rec.id as string);
      const full = {
        ...rec,
        kind,
        rev: existing ? existing.rev + 1 : 0,
        ts: rec.ts ?? new Date().toISOString(),
        actor: this.actor,
      };
      const validated = CVRecord.parse(full) as Extract<CVRecord, { kind: K }>;
      folded.set(validated.id, validated);
      lines.push(JSON.stringify(validated));
      out.push(validated);
    }

    appendFileSync(this.file(kind), lines.join('\n') + '\n');
    return out;
  }

  /** Tombstone. The prior revisions stay on disk — we hide it, we never destroy it. */
  remove(kind: Kind, id: string): void {
    const existing = this.get(kind, id);
    if (!existing) return;
    const tomb = { ...existing, rev: existing.rev + 1, ts: new Date().toISOString(), actor: this.actor, deleted: true };
    this.folded(kind).set(id, tomb as CVRecord);
    appendFileSync(this.file(kind), JSON.stringify(tomb) + '\n');
  }
}

/** sha256 of source text — the value an Anchor pins and the staleness check compares. */
export function hashSource(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
