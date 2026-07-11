import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store.js';
import type { Event } from '../schema.js';

/**
 * The git watcher.
 *
 * Its real job is not "record commits" — it is to answer one uncomfortable question:
 * **did the code change without us watching?**
 *
 * Everything ClaudeView believes about a project is anchored to code it observed being
 * written. But code moves in ways we never see: a teammate pushes, you rebase, you fix a
 * typo in vim, you work on the laptop instead of the server. Those changes are invisible
 * to the transcripts and they are exactly the ones that rot our claims, because nothing
 * in our history explains them.
 *
 * So every commit is classified:
 *
 *   explained — we have session events touching these files. We were there. We know why.
 *   foreign   — the code moved and we have no idea why.
 *
 * Foreign commits are the input to Reconciliation: the structural graph will re-derive
 * itself for free (the AST does not care who wrote it), but INTENT cannot be recovered
 * mechanically, so a model has to go read the diff and infer it — and whatever it writes
 * is marked `inferred`, never `authored`. We reconstruct; we do not pretend to remember.
 */

export interface GitCommit {
  sha: string;
  author: string;
  email: string;
  ts: string;
  subject: string;
  paths: string[];
}

export interface GitResult {
  commits: Event[];
  foreign: Event[];
  branch: string | null;
  /** True when this isn't a git repo at all — a perfectly normal state, not an error. */
  absent: boolean;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function isRepo(repoRoot: string): boolean {
  try {
    return git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/**
 * Parse `git log` into commits.
 *
 * Uses NUL-delimited records and a control-char field separator rather than newlines,
 * because commit subjects contain absolutely anything — newlines, quotes, emoji, `|`. A
 * naive line-based parse works for months and then mangles one commit and corrupts the
 * history silently.
 */
function readCommits(repoRoot: string, since: string | null): GitCommit[] {
  const SEP = '\x1f';
  const REC = '\x1e';
  const range = since ? [`${since}..HEAD`] : ['-n', '200']; // first run: recent history, not all of it
  let raw: string;
  try {
    raw = git(repoRoot, [
      'log',
      ...range,
      // The record separator must LEAD each record, not trail it. `--name-only` prints the
      // changed files AFTER the pretty-format, so a trailing separator pushes them into the
      // next chunk — where they get parsed as a commit, and every commit spawns a phantom
      // sibling named after its own file. Leading it keeps each commit and its files together.
      `--pretty=format:${REC}%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`,
      '--name-only',
    ]);
  } catch {
    // `since` may name a commit that no longer exists (a rebase, a force-push, a reset).
    // Fall back to recent history rather than losing the watcher entirely.
    if (!since) return [];
    return readCommits(repoRoot, null);
  }
  if (!raw) return [];

  const out: GitCommit[] = [];
  for (const chunk of raw.split(REC)) {
    const t = chunk.trim();
    if (!t) continue;
    const nl = t.indexOf('\n');
    const head = nl === -1 ? t : t.slice(0, nl);
    const paths = nl === -1 ? [] : t.slice(nl + 1).split('\n').map((s) => s.trim()).filter(Boolean);
    const [sha, author, email, ts, subject] = head.split(SEP);
    if (!sha) continue;
    out.push({ sha, author: author ?? '', email: email ?? '', ts: ts ?? '', subject: subject ?? '', paths });
  }
  return out;
}

export class GitWatcher {
  private markFile: string;

  constructor(private repoRoot: string, private store: Store) {
    this.markFile = join(store.dir, 'cache', 'git-head');
  }

  private lastSeen(): string | null {
    return existsSync(this.markFile) ? readFileSync(this.markFile, 'utf8').trim() || null : null;
  }

  /**
   * Ingest commits since the last check and classify each as explained or foreign.
   */
  scan(): GitResult {
    if (!isRepo(this.repoRoot)) {
      return { commits: [], foreign: [], branch: null, absent: true };
    }

    const branch = (() => {
      try {
        return git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      } catch {
        return null; // a repo with no commits yet has no HEAD to name
      }
    })();

    const commits = readCommits(this.repoRoot, this.lastSeen());

    const events = this.store.all('event');

    // Which files has Claude touched via a file tool (Edit/Write/…)?
    const ourFiles = new Set(
      events.filter((e) => e.type === 'tool' && e.paths.length).flatMap((e) => e.paths),
    );

    // When were we actually AT the keyboard? One window per observed session.
    //
    // This is the better signal, and the reason is empirical: on a real project, 45% of
    // commits looked "foreign" under pure path attribution — because a huge amount of what
    // Claude does never appears as a file-tool path at all. Eval artifacts get written by a
    // script Claude ran through Bash. Generated files come out of a build. Merge commits touch
    // no files whatsoever. None of that is a stranger's work; it is simply invisible to
    // `Edit.file_path`.
    //
    // A commit landing inside a session we recorded is a commit we witnessed, whatever tool
    // produced the bytes. Getting this wrong is expensive in the most literal sense: every
    // false "foreign" queues a model to go and explain a change that needs no explaining.
    const windows: Array<[number, number]> = [];
    const bySession = new Map<string, { min: number; max: number }>();
    for (const e of events) {
      if (e.sessionId === 'git') continue;
      const t = Date.parse(e.ts);
      if (Number.isNaN(t)) continue;
      const w = bySession.get(e.sessionId);
      if (!w) bySession.set(e.sessionId, { min: t, max: t });
      else {
        w.min = Math.min(w.min, t);
        w.max = Math.max(w.max, t);
      }
    }
    // Grace period: a commit is usually made moments AFTER the work that produced it, often
    // as the very last act of a session — sometimes just past the final recorded event.
    const GRACE = 10 * 60_000;
    for (const w of bySession.values()) windows.push([w.min - GRACE, w.max + GRACE]);

    const witnessed = (ts: string) => {
      const t = Date.parse(ts);
      return !Number.isNaN(t) && windows.some(([a, b]) => t >= a && t <= b);
    };

    const out = commits.map((c) => {
      // ClaudeView's own store is committed alongside the code, so nearly every commit also
      // contains `.claudeview/*.jsonl` — files no tool call ever "edited". Counting those
      // would make EVERY commit look unexplained and queue a pointless reconcile job on each
      // one. The tool's own footprint must be invisible to the tool's own classifier.
      const codePaths = c.paths.filter((p) => !p.startsWith('.claudeview/'));

      // A commit is ours if our history accounts for it. Attribution by AUTHOR would be
      // useless here: Claude's commits are authored as YOU, and your hand-edits in vim are
      // also authored as you — identical on paper, opposite in meaning.
      //
      // Three ways to account for a commit, in descending order of strength:
      const explained =
        // 1. It happened while we were watching. The strongest signal, and the one that
        //    catches everything Bash/scripts/builds produce without a file-tool path.
        witnessed(c.ts) ||
        // 2. Every file in it is one we saw edited.
        (codePaths.length > 0 && codePaths.every((p) => ourFiles.has(p))) ||
        // 3. It touches no files at all (a merge). There is no content change to explain, so
        //    sending a model to explain it would be pure waste.
        c.paths.length === 0;

      // Normalise to UTC. Git reports author time in the committer's LOCAL zone with an
      // offset (`…T19:12:00+03:00`); storing those verbatim would make every chronological
      // sort in the store quietly wrong the moment a teammate in another timezone pushes.
      const ts = (() => {
        const d = new Date(c.ts);
        return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      })();

      return {
        id: `commit:${c.sha}`,
        sessionId: 'git',
        provenance: 'observed' as const,
        ts,
        type: 'commit' as const,
        agent: { type: 'main' as const },
        paths: c.paths,
        summary: c.subject,
        commit: {
          sha: c.sha,
          author: c.author,
          email: c.email,
          origin: explained ? ('explained' as const) : ('foreign' as const),
        },
      };
    });

    const written = this.store.putMany('event', out as any);

    // Only advance the mark AFTER a successful write. If we crash mid-ingest, the next run
    // re-reads the same commits — which is harmless (the store folds them by sha) and far
    // better than skipping them forever.
    if (commits[0]) writeFileSync(this.markFile, commits[0].sha);

    return {
      commits: written,
      foreign: written.filter((e) => e.commit?.origin === 'foreign'),
      branch,
      absent: false,
    };
  }
}
