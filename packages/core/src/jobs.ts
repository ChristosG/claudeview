import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

/**
 * The job queue.
 *
 * ClaudeView runs its analysis on Claude Code subagents — on the subscription the user
 * already pays for — which means the Docker dashboard holds no API key and, crucially,
 * **cannot run a model itself**. That is a deliberate constraint, not a limitation: it is
 * what lets someone install this and have it work with zero configuration and zero billing.
 *
 * The consequence is that the dashboard cannot *do* the work; it can only *ask* for it.
 * So every expensive request — "explain this pipeline", "reconcile that teammate's push",
 * "red-team the auth module" — becomes a job on disk. The plugin drains the queue: either
 * at the start of your next session, or via a headless `claude -p` runner with no session
 * open at all.
 *
 * Jobs are plain files rather than rows in the store because two different processes (a
 * server and a hook, possibly concurrent) need to claim them without stepping on each
 * other, and a rename is atomic on every filesystem we care about.
 */

export type JobType =
  | 'reconcile'         // foreign commits appeared; go read the diff and infer intent
  | 'summarize-session' // write the journal entry for a finished session
  | 'extract-threads'   // mine "we should try X" out of the transcript
  | 'annotate'          // give Components their purpose
  | 'author-flows'      // build the conceptual pipeline diagrams
  | 'red-team'          // adversarial pass: produce Insights
  | 'verify'            // a claim went stale: is it merely changed, or actually contradicted?
  | 'ask';              // a deep question from the dashboard's search box

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Which model tier this job deserves. The router reads this, not the job's name. */
  tier: 'haiku' | 'sonnet' | 'opus';
  payload: Record<string, unknown>;
  result?: string;
  error?: string;
  /** Output tokens actually spent. This is how cold-start measures its own cost. */
  tokens?: number;
}

/**
 * Default model routing.
 *
 * Cheap, mechanical, high-volume work goes to Haiku; work that needs judgement goes to
 * Sonnet; work where being wrong is expensive and the reasoning is genuinely hard goes to
 * Opus. Overriding is per-job, so a caller who knows better can say so.
 */
const TIER: Record<JobType, Job['tier']> = {
  'extract-threads': 'haiku',
  'summarize-session': 'haiku',
  reconcile: 'sonnet',
  annotate: 'sonnet',
  verify: 'sonnet',
  ask: 'sonnet',
  'author-flows': 'opus',
  'red-team': 'opus',
};

export class JobQueue {
  private dir: string;

  constructor(store: Store) {
    this.dir = join(store.dir, 'jobs');
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  enqueue(type: JobType, payload: Record<string, unknown> = {}, tier?: Job['tier']): Job {
    const job: Job = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      type,
      status: 'queued',
      createdAt: new Date().toISOString(),
      tier: tier ?? TIER[type],
      payload,
    };
    writeFileSync(this.path(job.id), JSON.stringify(job, null, 2));
    return job;
  }

  list(status?: JobStatus): Job[] {
    if (!existsSync(this.dir)) return [];
    const out: Job[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j: Job = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
        if (!status || j.status === status) out.push(j);
      } catch {
        // A half-written job file is not worth crashing the queue over.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Atomically take the next queued job.
   *
   * The claim is a `rename`, not a write: two drainers racing for the same job will have
   * exactly one `rename` succeed. Read-then-write would let both believe they won and run
   * the same expensive Opus pass twice.
   */
  claim(): Job | undefined {
    for (const job of this.list('queued')) {
      const from = this.path(job.id);
      const to = join(this.dir, `${job.id}.running`);
      try {
        renameSync(from, to);
      } catch {
        continue; // someone else got it first
      }
      const claimed: Job = { ...job, status: 'running', startedAt: new Date().toISOString() };
      writeFileSync(to, JSON.stringify(claimed, null, 2));
      return claimed;
    }
    return undefined;
  }

  finish(id: string, result: string, tokens?: number): void {
    this.write(id, { status: 'done', result, tokens, finishedAt: new Date().toISOString() });
  }

  fail(id: string, error: string): void {
    this.write(id, { status: 'failed', error, finishedAt: new Date().toISOString() });
  }

  private write(id: string, patch: Partial<Job>): void {
    const running = join(this.dir, `${id}.running`);
    const src = existsSync(running) ? running : this.path(id);
    if (!existsSync(src)) return;
    const job: Job = { ...JSON.parse(readFileSync(src, 'utf8')), ...patch };
    writeFileSync(this.path(id), JSON.stringify(job, null, 2));
    if (src === running) renameSync(running, this.path(id));
  }

  /** Total output tokens spent across all finished jobs — the live cost meter. */
  spent(): number {
    return this.list().reduce((n, j) => n + (j.tokens ?? 0), 0);
  }
}
