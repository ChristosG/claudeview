#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  Store, JobQueue, sync, checkStaleness, needsAttention, transcriptDirs,
  fingerprint, changed, type Fingerprint, type JobType,
} from '@claudeview/core';

/**
 * The dashboard server.
 *
 * Two things it is NOT, both deliberate:
 *
 *   1. It is not a source of truth. Everything it serves is read from `.claudeview/` in the
 *      repo, which is a pure function of the transcripts, git, and the AST. Delete this
 *      server, delete its container, delete the whole machine — nothing is lost. It renders;
 *      it does not remember.
 *
 *   2. It cannot run a model. It holds no API key and never will, because the analysis runs
 *      on the user's own Claude subscription via the plugin. So when the UI wants thinking
 *      done, it does the only honest thing available to it: it writes a job and waits for an
 *      agent to pick it up. The button says "queue", not "run", because that is the truth.
 *
 * Liveness comes from POLLING a cheap fingerprint of the code, the transcripts, and the store
 * — not from fs.watch, which on Linux silently delivers nothing (see watchEverything). There
 * is still no hook and no overhead on the session being observed: Claude Code writes every
 * tool call to disk anyway, so we just notice.
 */

const REPO = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const PORT = Number(process.env.CV_PORT || 7777);
const WEB = join(import.meta.dirname, '../../web/dist');

const store = () => new Store(REPO);

// ─────────────────────────── API ───────────────────────────

const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
  /** Everything the Pulse screen needs, in one round trip. */
  'GET /api/pulse': async () => {
    const s = store();
    const events = s.all('event');
    const report = checkStaleness(s);
    const since = Date.now() - 7 * 864e5;
    const recent = events.filter((e) => Date.parse(e.ts) > since);

    const byDay = new Map<string, number>();
    for (const e of recent) {
      const d = e.ts.slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }

    const churn = events.reduce(
      (a, e) => ({ added: a.added + (e.churn?.added ?? 0), removed: a.removed + (e.churn?.removed ?? 0) }),
      { added: 0, removed: 0 },
    );

    const hot = [...recent.filter((e) => e.tool === 'Edit').flatMap((e) => e.paths)
      .reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([path, edits]) => ({ path, edits }));

    return {
      repo: REPO,
      trust: { fresh: report.fresh, stale: report.stale, broken: report.broken, contradicted: report.contradicted, unanchored: report.unanchored },
      counts: {
        components: s.all('component').length,
        events: events.length,
        sessions: new Set(events.map((e) => e.sessionId)).size,
        subagents: new Set(events.filter((e) => e.agent?.id).map((e) => e.agent!.id)).size,
        prompts: events.filter((e) => e.type === 'prompt').length,
        decisions: s.all('decision').filter((d) => d.status === 'active').length,
        openThreads: s.all('thread').filter((t) => t.status === 'open').length,
        openInsights: s.all('insight').filter((i) => i.status === 'open').length,
        openExperiments: s.all('experiment').filter((e) => e.verdict === 'open').length,
        queuedJobs: new JobQueue(s).list('queued').length,
      },
      churn,
      activity: [...byDay.entries()].sort().map(([day, n]) => ({ day, n })),
      hot,
      // Commits we cannot account for. The single most useful "something happened while you
      // weren't looking" signal there is.
      foreign: events.filter((e) => e.type === 'commit' && e.commit?.origin === 'foreign')
        .slice(-5).map((e) => ({ sha: e.commit!.sha.slice(0, 8), author: e.commit!.author, subject: e.summary })),
    };
  },

  'GET /api/trust': async () => {
    const report = checkStaleness(store());
    return { report, attention: needsAttention(report) };
  },

  'GET /api/flows': async () => {
    const s = store();
    const report = checkStaleness(s);
    const byId = new Map(report.claims.map((c) => [c.id, c]));
    // Attach freshness per STEP, not just per flow. "Something in this diagram is wrong" is
    // useless; "the reranker box is wrong" is actionable.
    return s.all('flow').map((f) => {
      const claim = byId.get(f.id);
      const badAnchors = new Set(
        (claim?.anchors ?? []).filter((a) => a.freshness !== 'fresh')
          .map((a) => `${a.anchor.path}#${a.anchor.symbol ?? ''}`),
      );
      return {
        ...f,
        freshness: claim?.freshness ?? 'fresh',
        steps: f.steps.map((st) => ({
          ...st,
          freshness: st.anchors.some((a) => badAnchors.has(`${a.path}#${a.symbol ?? ''}`)) ? 'stale' : 'fresh',
        })),
      };
    });
  },

  'GET /api/components': async (_r, url) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return store().all('component')
      .filter((c) => !c.symbol && (!q || c.path.toLowerCase().includes(q)))
      .sort((a, b) => b.loc - a.loc).slice(0, 400);
  },

  'GET /api/experiments': async () => {
    const s = store();
    const runs = s.all('run');
    return s.all('experiment').map((e) => ({
      ...e,
      runs: runs.filter((r) => r.experimentId === e.id).sort((a, b) => a.index - b.index),
    }));
  },

  'GET /api/insights': async () => store().all('insight'),
  'GET /api/threads': async () => store().all('thread'),
  'GET /api/decisions': async () => store().all('decision'),
  'GET /api/panels': async () => store().all('panel'),
  'GET /api/jobs': async () => new JobQueue(store()).list(),

  'GET /api/journal': async () => {
    const s = store();
    const events = s.all('event');
    return s.all('session').map((sess) => ({
      ...sess,
      events: events.filter((e) => e.sessionId === sess.sessionId).length,
    })).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  },

  /** Refresh the observed tier on demand. Free — no model, no tokens. */
  'POST /api/sync': async () => sync(REPO, { queueWork: true }),

  /**
   * The UI cannot run a model, so it queues. Everything expensive goes through here, which
   * also means every expensive thing is visible and attributable before it costs anything.
   */
  'POST /api/jobs': async (req) => {
    const body = await readBody(req);
    const type = body.type as JobType;
    if (!type) throw new Error('job type required');
    return new JobQueue(store()).enqueue(type, (body.payload as Record<string, unknown>) ?? {});
  },

  /** Dismissing an insight is permanent. A feed that re-nags is a feed nobody reads. */
  'POST /api/insight/dismiss': async (req) => {
    const body = await readBody(req);
    const s = store();
    const i = s.get('insight', String(body.id));
    if (!i) throw new Error('no such insight');
    return s.put('insight', { ...i, status: 'dismissed', dismissReason: String(body.reason ?? 'dismissed by user') });
  },
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}

// ───────────────────── live updates ─────────────────────

const clients = new Set<ServerResponse>();

function broadcast(reason: string) {
  for (const res of clients) {
    try {
      res.write(`data: ${JSON.stringify({ reason, at: Date.now() })}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Notice when anything changes: the code, the transcripts, or the store.
 *
 * This POLLS a cheap stat-only fingerprint rather than using `fs.watch`, and that is a
 * deliberate, hard-won choice.
 *
 * `fs.watch(dir, { recursive: true })` on Linux registers successfully, throws nothing,
 * warns nothing — and then delivers ZERO events. A try/catch fallback never fires, because
 * nothing ever fails. The dashboard sat there looking perfectly healthy while being totally
 * blind to code changes; it only *seemed* live because syncs were being triggered by hand.
 *
 * That is precisely the failure this whole project exists to catch: an API that reports
 * success and quietly does nothing. Having built a tool to find exactly that class of bug, I
 * then shipped one. So: do not trust the OS to tell us. Look.
 *
 * The probe is stat-only — nothing is opened, nothing is parsed — so it costs tens of
 * milliseconds, and the expensive sync runs only when the fingerprint actually moves.
 */
function watchEverything() {
  let last: Fingerprint | undefined;
  let running = false;

  const tick = async () => {
    if (running) return; // a slow sync must not stack up behind itself
    running = true;
    try {
      const now = fingerprint(REPO, join(homedir(), '.claude'));
      const diff = changed(last, now);
      const first = last === undefined;
      last = now;

      if (first || diff.length === 0) return;

      await sync(REPO, { queueWork: false });
      // Re-fingerprint AFTER the sync: it writes to the store, and we must not treat our own
      // write as a change and loop forever.
      last = fingerprint(REPO, join(homedir(), '.claude'));
      broadcast(diff.join('+'));
    } catch {
      // A failed tick must never kill the poller. The next one retries.
    } finally {
      running = false;
    }
  };

  void tick(); // establish the baseline immediately
  setInterval(tick, 2000).unref();
}

// ───────────────────── static + http ─────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

function serveStatic(url: URL, res: ServerResponse): boolean {
  if (!existsSync(WEB)) return false;
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = join(WEB, p);
  if (!file.startsWith(WEB)) return false; // path traversal
  if (!existsSync(file) || !extname(file)) file = join(WEB, 'index.html'); // SPA fallback
  if (!existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('data: {"reason":"hello"}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const data = await handler(req, url);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e?.message ?? String(e) }));
    }
  }

  if (serveStatic(url, res)) return;
  res.writeHead(404).end('not found');
}).listen(PORT, async () => {
  console.log(`ClaudeView → http://localhost:${PORT}`);
  console.log(`  repo: ${REPO}`);
  console.log(`  web:  ${existsSync(WEB) ? WEB : 'NOT BUILT (run: pnpm --filter @claudeview/web build)'}`);
  const dirs = transcriptDirs(REPO, join(homedir(), '.claude'));
  console.log(`  transcripts: ${dirs.length} dir(s)${dirs.length ? '' : ' — no session history found for this repo'}`);

  // Sync ON BOOT, before serving anything.
  //
  // Without this the dashboard happily renders whatever was last written to disk, which may
  // be days old — and it would render it with total confidence. A trust panel that is itself
  // out of date is the exact failure this project exists to prevent, and it would be
  // especially galling to ship it *in the trust panel*.
  try {
    const r = await sync(REPO, { queueWork: false });
    console.log(`  synced: ${r.components} components, ${r.events} new events, ${r.stale} stale, ${r.broken} broken (${r.ms.toFixed(0)}ms)`);
  } catch (e: any) {
    console.error(`  sync failed: ${e?.message ?? e} — serving last known state`);
  }

  watchEverything();
  void readdirSync;
});
