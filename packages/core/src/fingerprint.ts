import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { transcriptDirs } from './observer/transcripts.js';

/**
 * A cheap "has anything actually changed?" probe.
 *
 * This exists because `fs.watch(dir, { recursive: true })` on Linux is a trap: it registers
 * successfully, throws nothing, warns nothing — and then delivers no events at all. A
 * try/catch fallback never fires, because nothing ever failed. The dashboard therefore sat
 * there looking healthy while being completely blind to code changes, which is the exact
 * class of bug ClaudeView exists to catch: an API that reports success and quietly does
 * nothing.
 *
 * So we do not trust the OS to tell us. We look.
 *
 * Cost is stat-only — no file is opened, nothing is parsed. On a 30k-LOC repo with ~10k
 * directories this is tens of milliseconds, which is cheap enough to run every couple of
 * seconds and vastly more reliable than an event we might silently never receive.
 */

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv',
  '__pycache__', 'target', 'vendor', 'coverage', '.pytest_cache', '.ruff_cache',
  '.mypy_cache', '.pnpm-store',
]);

const SOURCE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|c|h|cpp|hpp|cs|php|swift|kt|scala|lua|sh|bash)$/;

export interface Fingerprint {
  /** Changes if any source file is added, removed, or modified. */
  code: string;
  /** Changes if Claude writes to a transcript (i.e. a session is doing something). */
  transcripts: string;
  /** Changes if anything writes to the store (a hook, the CLI, a drain runner). */
  store: string;
}

/** Rolled-up (count, newest mtime, total size) over a tree. Stat-only. */
function scan(root: string, match: (name: string) => boolean, maxDepth = 12): string {
  let n = 0;
  let newest = 0;
  let bytes = 0;
  const stack: Array<[string, number]> = [[root, 0]];

  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED.has(e.name)) continue;
        stack.push([join(dir, e.name), depth + 1]);
      } else if (match(e.name)) {
        try {
          const st = statSync(join(dir, e.name));
          n++;
          bytes += st.size;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* vanished mid-scan; the next tick will see it */ }
      }
    }
  }
  // count + newest + total size. A pure mtime max would miss a deletion; a pure count would
  // miss an edit. Together they catch add, remove, and modify.
  return `${n}:${Math.round(newest)}:${bytes}`;
}

export function fingerprint(repoRoot: string, claudeHome = join(homedir(), '.claude')): Fingerprint {
  const storeDir = join(repoRoot, '.claudeview');

  return {
    code: scan(repoRoot, (f) => SOURCE.test(f)),

    transcripts: transcriptDirs(repoRoot, claudeHome)
      .map((d) => scan(d, (f) => f.endsWith('.jsonl')))
      .join('|'),

    // cache/ is excluded: it is derived, and it changes as a RESULT of a sync — watching it
    // would make every sync trigger another one.
    store: existsSync(storeDir)
      ? scan(storeDir, (f) => f.endsWith('.jsonl') || f.endsWith('.json'), 1)
      : '',
  };
}

/** What changed since the last look, if anything. */
export function changed(a: Fingerprint | undefined, b: Fingerprint): string[] {
  if (!a) return [];
  return (['code', 'transcripts', 'store'] as const).filter((k) => a[k] !== b[k]);
}
