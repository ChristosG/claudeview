import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Keep the store out of `git clean`'s way.
 *
 * ClaudeView's whole durability story is "the knowledge lives in the repo and travels with
 * it". But an UNTRACKED file is not carried by anything — it is exactly what `git clean -fd`
 * and `git stash -u` are designed to delete, and agents running with skipped permissions
 * tidy their worktrees all the time.
 *
 * This is not hypothetical. On 2026-07-12 a session doing exactly that wiped
 * `/mnt/nvme2TB/gdpr/.claudeview/` — 43 decisions, 28 experiments, 25 insights, 18 recovered
 * ideas, 1.3M tokens of analysis — because it had never been staged. The design said
 * "committed to git" and the implementation left it lying on the floor.
 *
 * So: STAGE the store on every meaningful write. `git add` puts it in the index, and a file
 * in the index is tracked — `git clean` will not remove it. This deliberately does NOT
 * commit: the design promise is that pushing is on-demand and the user decides when history
 * gets written. Staging is protection, not a commit you didn't ask for.
 *
 * Best-effort and silent. A repo with no git, a detached HEAD, a locked index — none of that
 * is a reason to fail a write. The store is still on disk; it is just less protected.
 */
export function protectStore(repoRoot: string): { staged: boolean; snapshot: boolean } {
  const dir = join(repoRoot, '.claudeview');
  if (!existsSync(dir)) return { staged: false, snapshot: false };

  return { staged: stage(repoRoot), snapshot: snapshot(repoRoot, dir) };
}

/** Put the durable store in git's index. A tracked file is one `git clean` will not remove. */
function stage(repoRoot: string): boolean {
  try {
    execFileSync(
      'git',
      [
        '-C', repoRoot, 'add', '-f', '--',
        '.claudeview',
        // NEVER stage cache/. It is derived — a pure function of the .jsonl files, rebuilt in
        // seconds — and putting derived state in git is the exact thing this design refused
        // to do. `add -f` overrides .gitignore, so the exclusion has to be explicit here or
        // the protection would quietly reintroduce the problem it was arguing against.
        ':!:.claudeview/cache',
      ],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return true;
  } catch {
    return false; // no git, locked index, detached weirdness — never fail the caller's write
  }
}

/**
 * A copy OUTSIDE the repo, where no git command can reach it.
 *
 * Staging defends against `git clean`. It does NOT defend against `git checkout .`, `git
 * reset --hard`, `rm -rf`, or a botched merge — and the whole reason we are here is that an
 * autonomous agent with skipped permissions did something to a working tree that nobody
 * predicted.
 *
 * So the store also lives at ~/.claude/claudeview-snapshots/<repo-hash>/, which is not in the
 * repo, not in git, and not in any agent's line of fire. Rolling, so a corrupted store cannot
 * silently overwrite every good copy: the last few generations survive.
 *
 * This is cheap insurance for a file that costs 1.3M tokens to regenerate.
 */
function snapshot(repoRoot: string, dir: string): boolean {
  try {
    const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
    const root = join(homedir(), '.claude', 'claudeview-snapshots', `${basename(repoRoot)}-${key}`);
    const gen = join(root, String(Date.now()));
    mkdirSync(gen, { recursive: true });

    let copied = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue; // the durable tier only; cache/ is derived
      copyFileSync(join(dir, f), join(gen, f));
      copied++;
    }
    if (copied === 0) {
      rmSync(gen, { recursive: true, force: true });
      return false;
    }

    // Keep the last 10 generations. A wipe followed by ten writes must not be able to push
    // the last good copy out of the window.
    const gens = readdirSync(root)
      .filter((g) => /^\d+$/.test(g))
      .sort((a, b) => Number(b) - Number(a));
    for (const old of gens.slice(10)) rmSync(join(root, old), { recursive: true, force: true });

    return true;
  } catch {
    return false;
  }
}

/** Every snapshot generation of this repo's store, newest first. The recovery path. */
export function listSnapshots(repoRoot: string): Array<{ at: string; dir: string; records: number }> {
  try {
    const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
    const root = join(homedir(), '.claude', 'claudeview-snapshots', `${basename(repoRoot)}-${key}`);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((g) => /^\d+$/.test(g))
      .sort((a, b) => Number(b) - Number(a))
      .map((g) => {
        const d = join(root, g);
        let bytes = 0;
        for (const f of readdirSync(d)) bytes += statSync(join(d, f)).size;
        return { at: new Date(Number(g)).toISOString(), dir: d, records: bytes };
      });
  } catch {
    return [];
  }
}
