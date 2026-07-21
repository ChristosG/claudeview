import { Store } from './store.js';
import { TranscriptTailer } from './observer/transcripts.js';
import { GitWatcher } from './observer/git.js';
import { CodeIndexer } from './observer/code.js';
import { JobQueue } from './jobs.js';
import { checkStaleness } from './staleness.js';

/**
 * One pass of the Observer: read everything that happened, update the map, notice what
 * broke, and queue the thinking that needs a model.
 *
 * This is the whole zero-token tier in one call. It runs on session start, on session
 * end, and whenever the dashboard asks — and it never consults a model, never needs a key,
 * and cannot be wrong about what it reports, because everything it says is derived from
 * bytes on disk rather than from anyone's memory.
 *
 * What it *can't* do is explain anything. That's the point of the queue: the Observer
 * establishes the facts and then hands the interesting questions to an agent that runs on
 * the user's own subscription.
 */

export interface SyncResult {
  events: number;
  commits: number;
  foreignCommits: number;
  components: number;
  filesScanned: number;
  filesReused: number;
  /** Extensions present but unindexable — why an empty index is empty. See CodeIndexer.walk. */
  skippedExtensions: { ext: string; files: number }[];
  stale: number;
  broken: number;
  queued: string[];
  ms: number;
}

export interface SyncOptions {
  /** Queue model work for what changed. Off when we only want the facts refreshed. */
  queueWork?: boolean;
}

export async function sync(repoRoot: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const t0 = performance.now();
  const store = new Store(repoRoot);
  const jobs = new JobQueue(store);
  const queued: string[] = [];

  const tail = new TranscriptTailer(repoRoot, store).tail();
  const git = new GitWatcher(repoRoot, store).scan();
  const index = await new CodeIndexer(repoRoot, store).index();
  const staleness = checkStaleness(store);

  if (opts.queueWork) {
    // Someone changed the code and we have no record of why: a teammate's push, a rebase,
    // an edit made outside Claude. The structural map has already healed itself for free —
    // but INTENT can't be re-derived from an AST, so a model has to go read the diff.
    if (git.foreign.length) {
      const j = jobs.enqueue('reconcile', { shas: git.foreign.map((e) => e.commit!.sha) });
      queued.push(`reconcile ${git.foreign.length} foreign commit(s) [${j.tier}]`);
    }

    // A claim's code moved. The mechanical check can only say "the bytes are different";
    // deciding whether the claim is now merely OUT OF DATE or actually WRONG requires
    // reading the new code, which is a model's job — and only ever for the handful of
    // claims already flagged, never for the whole store.
    if (staleness.stale + staleness.broken > 0) {
      const j = jobs.enqueue('verify', {
        claims: staleness.claims.filter((c) => c.freshness !== 'fresh').map((c) => ({ kind: c.kind, id: c.id })),
      });
      queued.push(`verify ${staleness.stale + staleness.broken} stale claim(s) [${j.tier}]`);
    }

    // Components nobody has explained yet. Purpose is the one thing the AST cannot tell us.
    const unannotated = store.all('component').filter((c) => !c.symbol && !c.purpose);
    if (unannotated.length) {
      const j = jobs.enqueue('annotate', { paths: unannotated.map((c) => c.path).slice(0, 200) });
      queued.push(`annotate ${unannotated.length} component(s) [${j.tier}]`);
    }
  }

  return {
    events: tail.events.length,
    commits: git.commits.length,
    foreignCommits: git.foreign.length,
    components: store.all('component').length,
    filesScanned: index.filesScanned,
    skippedExtensions: index.skippedExtensions,
    filesReused: index.filesReused,
    stale: staleness.stale,
    broken: staleness.broken,
    queued,
    ms: performance.now() - t0,
  };
}
