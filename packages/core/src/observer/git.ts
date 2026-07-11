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
      'log', ...range, `--pretty=format:%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s${REC}`, '--name-only',
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

    // Which files has Claude actually touched, per our own transcripts? This is what makes
    // "we were there" a checkable claim rather than an assumption.
    const ourFiles = new Set(
      this.store.all('event').filter((e) => e.type === 'tool' && e.paths.length).flatMap((e) => e.paths),
    );

    const events = commits.map((c) => {
      // A commit is ours if we watched its files being edited. Attribution by author name
      // would be wrong here: Claude's commits are authored as YOU, and your hand-edits in
      // vim are also authored as you — identical on paper, opposite in meaning. What
      // actually distinguishes them is whether our session history explains the change.
      const explained = c.paths.length > 0 && c.paths.every((p) => ourFiles.has(p));
      return {
        id: `commit:${c.sha}`,
        sessionId: 'git',
        provenance: 'observed' as const,
        ts: c.ts || new Date().toISOString(),
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

    const written = this.store.putMany('event', events as any);

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
