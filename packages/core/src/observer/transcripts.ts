import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { Store } from '../store.js';
import type { Event } from '../schema.js';

/**
 * The transcript tailer — the reason this project exists.
 *
 * Claude Code already writes a complete black-box recording of every session to
 * ~/.claude/projects/<slug>/*.jsonl: every prompt, every edit, every command and its
 * output, every file snapshot. One real session measured 24MB / 12,350 records. Nobody
 * has ever read it. We do.
 *
 * Two properties this module must never violate:
 *
 *   1. INCREMENTAL. At 24MB a session, re-reading from byte zero on every tick is not
 *      an option. We checkpoint a byte offset per file and only ever read forward.
 *
 *   2. FAIL-SOFT. This JSONL is Claude Code's private internal format. It is unversioned
 *      and it WILL change under us on some future release. A parser that throws on an
 *      unexpected record would take the whole dashboard down on upgrade day. So every
 *      record is best-effort: understand what we can, silently skip what we can't, and
 *      never let a surprise become an exception.
 */

export interface TailResult {
  events: Event[];
  filesRead: number;
  bytesRead: number;
  recordsSeen: number;
  recordsSkipped: number;
}

type Offsets = Record<string, { offset: number; size: number }>;

/**
 * Claude Code derives its transcript directory name by flattening the project path —
 * both '/' and '_' collapse to '-', so `/mnt/nvme2TB/vee/microservices_agents` becomes
 * `-mnt-nvme2TB-vee-microservices-agents`.
 *
 * That mapping is LOSSY and therefore not safe to trust on its own: `/a/b_c` and
 * `/a-b/c` produce the same slug. We use it only as a cheap prefilter and then confirm
 * against the `cwd` recorded inside the transcript itself, which is unambiguous.
 */
export function slugFor(repoRoot: string): string {
  return repoRoot.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Every transcript directory that could plausibly belong to this repo. */
export function transcriptDirs(repoRoot: string, claudeHome = join(homedir(), '.claude')): string[] {
  const projects = join(claudeHome, 'projects');
  if (!existsSync(projects)) return [];
  const want = slugFor(repoRoot);
  return readdirSync(projects)
    // A subdirectory of the repo (e.g. a monorepo package Claude was invoked inside)
    // records its own transcripts under its own slug. Those sessions are still ours.
    .filter((d) => d === want || d.startsWith(want + '-'))
    .map((d) => join(projects, d));
}

/**
 * Every transcript file under a project dir, including nested ones.
 *
 * Subagents and multi-agent workflows do NOT write into the session's own transcript —
 * each gets its own file under `<session-id>/subagents/[workflows/<wf-id>/]agent-*.jsonl`.
 * On a workflow-heavy project that is the bulk of the work: one measured repo had 64
 * top-level transcripts and 282 nested ones. A flat readdir sees none of it.
 */
function walkTranscripts(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // an unreadable directory is not a reason to abandon the whole ingest
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

/**
 * Recover attribution from where Claude Code chose to put the file.
 *
 * Layout: <project>/<session-id>.jsonl for the main thread, and
 *         <project>/<session-id>/subagents/[workflows/<wf-id>/]agent-<id>.jsonl for agents.
 * So the path alone tells us the agent, its workflow, and the session it served.
 */
export function contextFor(file: string): FileContext {
  const sub = /\/([0-9a-f-]{36})\/subagents\//i.exec(file);
  if (!sub) return { agent: { type: 'main' } };
  const wf = /\/workflows\/(wf_[^/]+)\//.exec(file)?.[1];
  const id = /\/(agent-[^/]+)\.jsonl$/.exec(file)?.[1];
  return {
    sessionId: sub[1]!,
    agent: { type: 'subagent', ...(wf ? { workflow: wf } : {}), ...(id ? { id } : {}) },
  };
}

/** Read only the bytes we have not read before. Returns whole lines; keeps the remainder. */
function readForward(file: string, from: number): { text: string; to: number } {
  const size = statSync(file).size;
  if (size <= from) return { text: '', to: size };
  const fd = openSync(file, 'r');
  try {
    const len = size - from;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf8');
    // A session being written right now will leave us a half-written final line. Stop at
    // the last newline and leave the tail for the next tick, or we'd parse a truncated
    // record and (worse) checkpoint past it.
    const cut = text.lastIndexOf('\n');
    if (cut === -1) return { text: '', to: from };
    return { text: text.slice(0, cut + 1), to: from + Buffer.byteLength(text.slice(0, cut + 1), 'utf8') };
  } finally {
    closeSync(fd);
  }
}

function toRepoRelative(p: unknown, repoRoot: string): string[] {
  if (typeof p !== 'string' || !p) return [];
  if (!isAbsolute(p)) return [p];
  const rel = relative(repoRoot, p);
  // Absolute paths outside the repo (a temp file, another project) are not this
  // project's business and must not be recorded — they would also break the moment the
  // repo is cloned to a machine with a different layout.
  if (rel.startsWith('..')) return [];
  return [rel];
}

/** An Event before the store stamps it with rev/actor. */
type RawEvent = Omit<Event, 'kind' | 'rev' | 'actor'>;

/** What we know about a transcript file from its location alone, before parsing a byte. */
interface FileContext {
  agent: Event['agent'];
  /** Owning session, recovered from the directory for nested subagent transcripts. */
  sessionId?: string;
}

/**
 * Fold a tool result into the tool call it belongs to.
 *
 * The call record carries identity (which tool, which arguments, which file); the result
 * record carries outcome (did it work, what changed). Neither is complete alone, and the
 * result must never clobber the call — so later fields only win where they actually say
 * something.
 */
function mergeEvents(a: RawEvent, b: RawEvent): RawEvent {
  const merged: RawEvent = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue; // an empty path list is "I don't know", not "none"
    (merged as any)[k] = v;
  }
  // Union of paths: the call names the file it targeted, the result confirms the file it
  // actually wrote. They are usually the same, but when they differ we want both.
  merged.paths = [...new Set([...(a.paths ?? []), ...(b.paths ?? [])])];
  return merged;
}

/**
 * Turn one transcript record into zero or more Events.
 *
 * Everything here is Tier-1: mechanically observed, zero tokens, no interpretation.
 * Where the transcript does not tell us something (a Bash exit code, for instance) we
 * say so rather than guessing — see `ok` in the schema.
 */
function extract(rec: any, repoRoot: string, ctx: FileContext): RawEvent[] {
  const out: RawEvent[] = [];
  // Subagent transcripts don't always carry a sessionId of their own; they belong to the
  // session whose directory they live under, so fall back to that rather than to
  // 'unknown' — otherwise every workflow's work would detach from the session that ran it.
  const sessionId: string = rec?.sessionId ?? ctx.sessionId ?? 'unknown';
  const ts: string = rec?.timestamp ?? new Date().toISOString();
  const base = { sessionId, ts, provenance: 'observed' as const, paths: [] as string[], agent: ctx.agent };

  const msg = rec?.message;
  const content = msg?.content;

  // A human prompt. Slash commands arrive as <command-name>/foo</command-name> wrappers
  // and are NOT prompts — counting them as such would inflate every "you asked me N
  // things" statistic with /model and /clear.
  if (rec?.type === 'user' && typeof content === 'string' && !rec?.isMeta) {
    const isCommand = content.trimStart().startsWith('<command-name>');
    out.push({
      ...base,
      id: `${sessionId}:${rec.uuid ?? ts}:prompt`,
      type: isCommand ? 'command' : 'prompt',
      summary: content.slice(0, 500),
    });
  }

  // Tool calls made by Claude.
  if (rec?.type === 'assistant' && Array.isArray(content)) {
    for (const blk of content) {
      if (blk?.type !== 'tool_use') continue;
      const input = blk.input ?? {};
      const paths = [
        ...toRepoRelative(input.file_path, repoRoot),
        ...toRepoRelative(input.path, repoRoot),
        ...toRepoRelative(input.notebook_path, repoRoot),
      ];
      out.push({
        ...base,
        id: `${blk.id ?? rec.uuid}:tool`,
        type: 'tool',
        tool: blk.name,
        paths,
        summary: typeof input.command === 'string' ? input.command.slice(0, 300) : undefined,
      });
    }
  }

  // Tool results come back on the *following* user record. We attach the outcome to the
  // event we already emitted for the call, keyed by tool_use id.
  const tur = rec?.toolUseResult;
  if (tur && typeof tur === 'object' && rec?.type === 'user' && Array.isArray(content)) {
    for (const blk of content) {
      if (blk?.type !== 'tool_result') continue;
      const id = `${blk.tool_use_id}:tool`;

      // Bash: there is no exit code in the transcript, so success is inferred.
      let ok: boolean | undefined;
      if ('stdout' in tur || 'stderr' in tur) {
        ok = !tur.interrupted && !(typeof tur.stderr === 'string' && tur.stderr.trim().length > 0);
      }
      if (blk.is_error) ok = false;

      // Edit results carry a structuredPatch — real churn numbers, for free.
      let churn: { added: number; removed: number } | undefined;
      if (Array.isArray(tur.structuredPatch)) {
        let added = 0, removed = 0;
        for (const h of tur.structuredPatch) {
          for (const l of h?.lines ?? []) {
            if (typeof l === 'string' && l.startsWith('+')) added++;
            else if (typeof l === 'string' && l.startsWith('-')) removed++;
          }
        }
        churn = { added, removed };
      }

      out.push({
        ...base,
        id,
        type: 'tool',
        paths: toRepoRelative(tur.filePath, repoRoot),
        ok,
        // The human corrected a file after Claude wrote it. A free, precise signal of
        // where Claude got it wrong — worth more than most things a model could infer.
        userModified: tur.userModified === true ? true : undefined,
        churn,
      });
    }
  }

  // Context was compacted: everything before this point left Claude's head. Knowing
  // exactly where that happened is what makes a "we lost this" gap explainable later.
  if (rec?.isCompactSummary || rec?.compactMetadata) {
    out.push({ ...base, id: `${sessionId}:${rec.uuid ?? ts}:compact`, type: 'compact', summary: 'context compacted' });
  }

  return out;
}

export class TranscriptTailer {
  private offsetsFile: string;

  constructor(
    private repoRoot: string,
    private store: Store,
    private claudeHome = join(homedir(), '.claude'),
  ) {
    this.offsetsFile = join(store.dir, 'cache', 'offsets.json');
  }

  private loadOffsets(): Offsets {
    if (!existsSync(this.offsetsFile)) return {};
    try {
      return JSON.parse(readFileSync(this.offsetsFile, 'utf8'));
    } catch {
      return {}; // A corrupt checkpoint costs one full re-read. It must never be fatal.
    }
  }

  private saveOffsets(o: Offsets): void {
    writeFileSync(this.offsetsFile, JSON.stringify(o, null, 2));
  }

  /** Read everything new since the last tick and write the resulting Events to the store. */
  tail(): TailResult {
    const offsets = this.loadOffsets();
    const res: TailResult = { events: [], filesRead: 0, bytesRead: 0, recordsSeen: 0, recordsSkipped: 0 };
    /** Events built up across this tail, merged by id before a single batched write. */
    const pending = new Map<string, RawEvent>();

    for (const dir of transcriptDirs(this.repoRoot, this.claudeHome)) {
      for (const file of walkTranscripts(dir)) {
        const ctx = contextFor(file);
        const prev = offsets[file];
        const size = statSync(file).size;

        // File shrank: it was rotated or rewritten, and our offset now points into the
        // middle of a different file. Start over rather than emit garbage.
        const from = prev && prev.size <= size ? prev.offset : 0;

        const { text, to } = readForward(file, from);
        if (!text) {
          offsets[file] = { offset: to, size };
          continue;
        }
        res.filesRead++;
        res.bytesRead += Buffer.byteLength(text, 'utf8');

        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          res.recordsSeen++;
          let rec: unknown;
          try {
            rec = JSON.parse(t);
          } catch {
            res.recordsSkipped++;
            continue;
          }
          try {
            // Only records from THIS repo. A transcript dir can legitimately contain
            // sessions whose cwd moved elsewhere; the slug is lossy, cwd is not.
            const cwd = (rec as any)?.cwd;
            if (typeof cwd === 'string' && !cwd.startsWith(this.repoRoot)) continue;
            for (const ev of extract(rec, this.repoRoot, ctx)) {
              // A tool CALL and its RESULT are the same event seen twice: the call knows
              // the tool name and arguments, the result knows the outcome. They share an
              // id, so merge them. Appending the result as its own revision would fold it
              // OVER the call and erase the tool name — which is exactly the bug that
              // made a 417-Edit session report 36 Edits.
              const prev = pending.get(ev.id);
              pending.set(ev.id, prev ? mergeEvents(prev, ev) : ev);
            }
          } catch {
            // An unrecognised record shape is expected, not exceptional. Skip it and
            // keep going — degrading is always better than crashing.
            res.recordsSkipped++;
          }
        }
        offsets[file] = { offset: to, size };
      }
    }

    // One batched write for the whole tail. Writing per-event would re-fold the log on
    // every append and turn a bulk ingest quadratic.
    res.events = this.store.putMany('event', [...pending.values()] as any);
    this.saveOffsets(offsets);
    return res;
  }
}
