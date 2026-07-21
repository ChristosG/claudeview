import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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

/**
 * Kinds that live in `cache/` — gitignored, and rebuildable from scratch at any time.
 *
 * A derived record in git is pure liability: it bloats every clone, churns every diff, and
 * merge-conflicts for no gain, all to store something a five-second command can regenerate.
 */
const DERIVED = new Set<Kind>(['event', 'component']);

/**
 * Do these two revisions say the same thing?
 *
 * `rev` and `actor` are bookkeeping the store stamps itself and are excluded by definition.
 * `ts` is the subtle one: it is DATA when the caller supplies it (an event's timestamp is the
 * event) and bookkeeping when the store stamps it (a rollup recomputed at 12:00:02 describes
 * the same session it described at 12:00:00). Comparing a stamped `ts` would make every
 * record differ from itself and defeat the check entirely — which is the whole bug.
 */
function unchanged(a: CVRecord, b: CVRecord, tsIsData: boolean): boolean {
  const strip = ({ rev, actor, ts, ...rest }: CVRecord) =>
    tsIsData ? { ...rest, ts } : rest;
  return canonical(strip(a)) === canonical(strip(b));
}

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

/**
 * Feed a file's lines to `fn` without ever holding the file as one string.
 *
 * `readFileSync(f, 'utf8')` is the obvious way to do this and it has a hard ceiling: V8
 * refuses to build a string longer than 0x1fffffe8 (536,870,888) bytes and throws
 * RangeError. A store that crosses that line does not get slow, it becomes unreadable — and
 * since every read path goes through here, the whole dashboard 500s at once, which reads
 * from the outside like a server that failed to start. A real store hit 537,008,888 bytes.
 *
 * Two details are load-bearing and both are silent when wrong:
 *
 *   StringDecoder, not buf.toString(). A read boundary lands mid-character eventually, and
 *   toString() on a partial UTF-8 sequence yields U+FFFD instead of failing — corrupting a
 *   path or a summary while reporting success. The decoder holds the incomplete bytes back
 *   until the next chunk completes them.
 *
 *   The carry. A read boundary lands mid-LINE far more often, and a reader that treats each
 *   chunk independently truncates one record and invents another, both of which then fail to
 *   parse and get counted as "skipped" — a corruption that looks like tolerated garbage.
 */
function eachLine(file: string, chunkSize: number, fn: (line: string) => void): void {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    const dec = new StringDecoder('utf8');
    let carry = '';
    let n: number;
    while ((n = readSync(fd, buf, 0, chunkSize, null)) > 0) {
      const parts = (carry + dec.write(buf.subarray(0, n))).split('\n');
      carry = parts.pop()!; // last element is a partial line, or '' if the chunk ended cleanly
      for (const p of parts) fn(p);
    }
    carry += dec.end();
    if (carry) fn(carry); // a final line with no trailing newline is still a line
  } finally {
    closeSync(fd);
  }
}

/**
 * Order-independent equality of two records' payloads.
 *
 * Key order in the serialised form is an artifact of how the object was built, not of what it
 * means: a caller that spreads `{...existing, endedAt}` produces different key order than one
 * that builds the row literally, and comparing raw JSON.stringify output would call those two
 * different and append a duplicate. Sorting makes the comparison about content only.
 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
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
  /** Bytes per read in `eachLine`. Overridable only so tests can force chunk boundaries. */
  private readonly chunkSize: number;

  constructor(repoRoot: string, storeDir?: string, opts?: { chunkSize?: number }) {
    this.chunkSize = opts?.chunkSize ?? 1 << 22; // 4 MiB
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

  /**
   * Where a kind's log lives — and this is the line that decides what enters git.
   *
   * The test is not "is it big?", it is **"can it be rebuilt?"**
   *
   *   component — a pure function of the code. Re-indexing produces byte-identical hashes, so
   *     anchors still resolve after a fresh clone. Derived. Cache.
   *   event — a pure function of the transcripts, which live in ~/.claude on ONE machine.
   *     Rebuildable locally, NOT portably... so it is distilled into Session rollups (which
   *     are committed) and the raw stream stays local. Cache.
   *
   * Everything else — decisions, experiments, runs, insights, threads, flows, sessions,
   * panels — is authored knowledge that exists nowhere else on earth. Committed.
   *
   * Measured on a real project: this takes the committed store from 22 MB (92% of it raw
   * events, heading for ~82 MB/year) down to ~350 KB, and loses nothing that cannot be
   * regenerated in five seconds.
   */
  private file(kind: Kind): string {
    return DERIVED.has(kind)
      ? join(this.dir, 'cache', FILES[kind])
      : join(this.dir, FILES[kind]);
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
    eachLine(f, this.chunkSize, (line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      try {
        const parsed = CVRecord.safeParse(JSON.parse(t));
        if (parsed.success) out.push(parsed.data);
        else skipped++;
      } catch {
        skipped++;
      }
    });
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

  /** Where a kind's log lives on disk. For tools that operate on the file itself. */
  fileFor(kind: Kind): string {
    return this.file(kind);
  }

  /**
   * Fold straight from disk, tombstones INCLUDED, bypassing the cache.
   *
   * `all()` is the wrong primitive for anything that rewrites the log: it hides deleted
   * records, so a compactor built on it would drop every tombstone and silently resurrect
   * everything the user had removed. Reads fresh, so `lastStats` afterwards describes the
   * file as it is right now.
   */
  foldedRaw(kind: Kind): Map<string, CVRecord> {
    const m = new Map<string, CVRecord>();
    for (const r of this.readRaw(kind)) {
      const prev = m.get(r.id);
      m.set(r.id, prev ? wins(prev, r) : r);
    }
    return m;
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

      // Validate at the CURRENT revision first, so the candidate can be compared against what
      // is already stored without a revision bump prejudging the answer. Zod runs here rather
      // than after the comparison because it applies defaults, and a caller that omits a
      // defaulted field must compare equal to a stored record that has it filled in.
      const candidate = CVRecord.parse({
        ...rec,
        kind,
        rev: existing ? existing.rev : 0,
        ts: rec.ts ?? new Date().toISOString(),
        actor: this.actor,
      }) as Extract<CVRecord, { kind: K }>;

      // Writing back an unchanged record must cost nothing.
      //
      // Callers recompute and re-put freely — rollUpSessions rebuilds every session's rollup
      // on every observer tick, and the poller ticks every 2s — which is a good ergonomic and
      // was a catastrophic one: 156 sessions became 630,571 revisions and the log passed the
      // 512 MiB string ceiling, at which point NOTHING in the store could be read. Growth
      // must track activity, not uptime, and the guarantee belongs here rather than in each
      // caller, because the next caller to recompute-and-write will not remember this either.
      if (existing && !existing.deleted && unchanged(existing, candidate, rec.ts !== undefined)) {
        out.push(existing as Extract<CVRecord, { kind: K }>);
        continue;
      }

      const validated = existing ? { ...candidate, rev: existing.rev + 1 } : candidate;
      folded.set(validated.id, validated);
      lines.push(JSON.stringify(validated));
      out.push(validated);
    }

    if (lines.length === 0) return out; // every record was a no-op; touch nothing
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
