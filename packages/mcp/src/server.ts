#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  Store, JobQueue, sync, buildBrief, checkStaleness, needsAttention,
} from '@claudeview/core';

/**
 * The MCP server — ClaudeView's face to Claude.
 *
 * The dashboard is the human's view of the substrate; this is mine. Same store, same
 * truth, two readers. That symmetry is the point: the knowledge Chris looks at and the
 * knowledge I act on cannot drift apart, because there is only one of them.
 *
 * The READ tools exist so I stop rebuilding my understanding of a project from scratch
 * every session. The WRITE tools exist so that what I learn in this session survives into
 * the next one without anyone having to remember to write it down.
 *
 * Every write records provenance honestly: what I lived through is `authored`, what I
 * reconstruct after the fact is `inferred`. I am never allowed to launder the second as
 * the first.
 */

// The repo we're serving. Claude Code sets CLAUDE_PROJECT_DIR for plugin processes.
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const server = new McpServer({ name: 'claudeview', version: '0.1.0' });

// One Store for the life of the process, same as the dashboard server. The fold validates
// itself against each file's size and mtime, so holding it stays correct even though other
// sessions, the hooks and the drain runner all write this same store — and every tool call
// stops re-parsing the whole log to answer a question about an unchanged file.
const shared = new Store(REPO);
const store = () => shared;
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

// ─────────────────────────── READ ───────────────────────────

server.registerTool(
  'cv_state',
  {
    title: 'Project state',
    description:
      'The current state of this project: what is stale, what experiments are open, what failed before, what ideas were never explored, what decisions stand. READ THIS BEFORE ANSWERING QUESTIONS ABOUT HOW THE PROJECT WORKS — it is cheaper and more current than re-reading the code, and it knows what it does NOT know.',
    inputSchema: {},
  },
  async () => text(buildBrief(store(), { maxChars: 6000 })),
);

server.registerTool(
  'cv_ask',
  {
    title: 'Search the project knowledge',
    description:
      'Search everything ClaudeView knows — decisions, experiments, insights, threads, components, journal — by keyword. Use this before assuming; it will tell you if we already tried something.',
    inputSchema: { query: z.string().describe('keywords, e.g. "retrieval reranker chunk size"') },
  },
  async ({ query }) => {
    const s = store();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (o: unknown) => {
      const hay = JSON.stringify(o).toLowerCase();
      return terms.filter((t) => hay.includes(t)).length;
    };

    const results = (['decision', 'experiment', 'insight', 'thread', 'flow', 'component'] as const)
      .flatMap((kind) => s.all(kind).map((r) => ({ kind, r, score: hit(r) })))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ kind, r }) => ({ kind, id: r.id, ...summarise(kind, r) }));

    if (!results.length) {
      // Say nothing was found rather than inventing an answer. A knowledge store that
      // bluffs is worse than one that admits a gap.
      return text(`No stored knowledge matches "${query}". Nothing has been recorded about this yet — you'll have to read the code, and you should record what you learn with cv_decide / cv_thread.`);
    }
    return json(results);
  },
);

server.registerTool(
  'cv_stale',
  {
    title: 'What is no longer true',
    description:
      'Claims (decisions, flows, insights) whose underlying code has changed or vanished. If a user asks about something on this list, VERIFY IT AGAINST THE CODE before answering — the stored claim may be out of date.',
    inputSchema: {},
  },
  async () => {
    const report = checkStaleness(store());
    const bad = needsAttention(report);
    if (!bad.length) return text(`All ${report.fresh} anchored claims still match the code. ${report.unanchored} claim(s) cite no code and cannot be verified.`);
    return json(
      bad.map((c) => ({
        kind: c.kind, id: c.id, title: c.title, status: c.freshness,
        implicated: c.anchors.filter((a) => a.freshness !== 'fresh').map((a) => `${a.anchor.path}${a.anchor.symbol ? '#' + a.anchor.symbol : ''} (${a.freshness})`),
      })),
    );
  },
);

server.registerTool(
  'cv_sync',
  {
    title: 'Refresh the observed tier',
    description: 'Re-read transcripts, git, and the code index. Zero tokens. Call after significant changes.',
    inputSchema: { queueWork: z.boolean().optional().describe('also queue model work for what changed') },
  },
  async ({ queueWork }) => json(await sync(REPO, { queueWork: queueWork ?? false })),
);

// ─────────────────────────── WRITE ───────────────────────────

const AnchorIn = z.object({
  path: z.string().describe('repo-relative file path'),
  symbol: z.string().optional().describe('function/class name; omit to anchor the whole file'),
});

/**
 * Resolve authored anchors against the live index.
 *
 * The caller names code; we look up its CURRENT hash. This is the only place a claim
 * acquires its pin, and it is deliberately not something the caller can fake: you cannot
 * assert a hash, you can only cite code that exists. An anchor to code that isn't there
 * is rejected loudly rather than stored as a claim nobody can ever verify.
 */
function resolveAnchors(s: Store, anchors: z.infer<typeof AnchorIn>[]) {
  const comps = s.all('component');
  return anchors.map((a) => {
    const id = a.symbol ? `${a.path}#${a.symbol}` : a.path;
    const c = comps.find((x) => x.id === id);
    if (!c) {
      throw new Error(
        `cv: cannot anchor to "${id}" — no such component is indexed. Anchor to code that exists, or run cv_sync if you just created it. An unanchored claim can never be verified, so it will never be trusted.`,
      );
    }
    return { path: a.path, ...(a.symbol ? { symbol: a.symbol } : {}), hash: c.hash };
  });
}

server.registerTool(
  'cv_decide',
  {
    title: 'Record a decision',
    description:
      'Record an architectural or design decision, WHY it was made, and what was rejected. Anchor it to the code it governs so it flags itself when that code changes. Do this whenever a real choice is made — the rationale is the part that exists nowhere in the code and dies with this session.',
    inputSchema: {
      id: z.string().describe('stable slug, e.g. "hybrid-retrieval"'),
      title: z.string(),
      choice: z.string().describe('what we chose'),
      rationale: z.string().describe('WHY — the part that is not recoverable from the code'),
      alternatives: z.array(z.string()).optional().describe('what we rejected, so we do not relitigate it'),
      supersedes: z.string().optional().describe('id of a decision this replaces'),
      anchors: z.array(AnchorIn).optional(),
    },
  },
  async ({ id, title, choice, rationale, alternatives, supersedes, anchors }) => {
    const s = store();
    const d = s.put('decision', {
      id, provenance: 'authored', title, choice, rationale,
      alternatives: alternatives ?? [],
      ...(supersedes ? { supersedes } : {}),
      anchors: resolveAnchors(s, anchors ?? []),
      status: 'active',
    });
    // Supersession is what keeps the brief honest: the old decision stops being reported
    // as current the moment it is replaced, which is the exact failure Chris described.
    if (supersedes) {
      const old = s.get('decision', supersedes);
      if (old) s.put('decision', { ...old, status: 'superseded' });
    }
    return text(`Recorded decision "${d.id}"${anchors?.length ? `, anchored to ${anchors.length} component(s) — it will flag itself if they change.` : ' (UNANCHORED — it cannot be verified; anchor it to code if you can).'}`);
  },
);

server.registerTool(
  'cv_thread',
  {
    title: 'Record an idea we did not pursue',
    description:
      'Capture an idea, TODO, or "we should try X sometime" that is NOT being done now. These are resurfaced at the start of future sessions. Use it liberally — this is the graveyard where good ideas normally die.',
    inputSchema: {
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      status: z.enum(['open', 'exploring', 'done', 'abandoned']).optional(),
      abandonReason: z.string().optional().describe('if abandoned, WHY — or it will be re-proposed forever'),
    },
  },
  async ({ id, title, detail, status, abandonReason }) => {
    store().put('thread', {
      id, provenance: 'authored', title, detail, origin: {},
      status: status ?? 'open',
      ...(abandonReason ? { abandonReason } : {}),
    });
    return text(`Thread "${id}" recorded (${status ?? 'open'}).`);
  },
);

server.registerTool(
  'cv_experiment',
  {
    title: 'Start or conclude an experiment',
    description:
      'Record a hypothesis being tested, or deliver the verdict on one. Losses matter MORE than wins: a recorded loss is what stops us cheerfully re-running a failed experiment in three weeks.',
    inputSchema: {
      id: z.string(),
      title: z.string(),
      hypothesis: z.string(),
      metric: z.string().describe('the metric that decides it — name it BEFORE running, so the verdict cannot be moved afterwards'),
      verdict: z.enum(['open', 'win', 'loss', 'inconclusive']).optional(),
      judgement: z.string().optional().describe('the reasoning over the runs'),
      action: z.string().optional().describe('what we actually did about it'),
    },
  },
  async ({ id, title, hypothesis, metric, verdict, judgement, action }) => {
    store().put('experiment', {
      id, provenance: 'authored', title, hypothesis, metric,
      verdict: verdict ?? 'open',
      ...(judgement ? { judgement } : {}),
      ...(action ? { action } : {}),
      anchors: [],
    });
    return text(`Experiment "${id}" recorded — verdict: ${verdict ?? 'open'}.`);
  },
);

server.registerTool(
  'cv_run',
  {
    title: 'Log an experiment run',
    description: 'Append one iteration of an experiment: the params tried and the metrics obtained. This is the live, queryable version of the results CSV.',
    inputSchema: {
      experimentId: z.string(),
      index: z.number().int().describe('iteration number'),
      params: z.record(z.unknown()).describe('what was varied'),
      metrics: z.record(z.number()).describe('what came out'),
      notes: z.string().optional(),
    },
  },
  async ({ experimentId, index, params, metrics, notes }) => {
    store().put('run', {
      id: `${experimentId}#${index}`,
      provenance: 'observed', experimentId, index, params, metrics,
      ...(notes ? { notes } : {}),
      artifacts: [],
    });
    return text(`Run ${index} of "${experimentId}" logged: ${Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  },
);

server.registerTool(
  'cv_insight',
  {
    title: 'Record a critique',
    description:
      'Record something wrong, risky, or suboptimal about the code — with evidence. Read-only: never fix it here, just flag it. Include your genuine confidence; an insights feed that cries wolf is one nobody reads.',
    inputSchema: {
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
      confidence: z.number().min(0).max(1).describe('be honest — low confidence is fine, false confidence is not'),
      evidence: z.array(AnchorIn).describe('the code this is about'),
    },
  },
  async ({ id, title, detail, severity, confidence, evidence }) => {
    const s = store();
    s.put('insight', {
      id, provenance: 'inferred', title, detail, severity, confidence,
      evidence: resolveAnchors(s, evidence), status: 'open',
    });
    return text(`Insight "${id}" recorded [${severity}, confidence ${confidence}].`);
  },
);

server.registerTool(
  'cv_flow',
  {
    title: 'Author a pipeline diagram',
    description:
      'Describe a conceptual pipeline as ordered steps (e.g. query → preprocess → embed → BM25 → rerank → LLM). Anchor each step to the code that implements it. This is what the human actually looks at — and because it is anchored, it flags itself as stale when the code beneath a step changes, instead of quietly lying for months.',
    inputSchema: {
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      steps: z.array(
        z.object({
          id: z.string(),
          label: z.string().describe('short box label, e.g. "Rerank"'),
          description: z.string().describe('what this step actually does'),
          anchors: z.array(AnchorIn).describe('the code implementing this step — REQUIRED for the step to be verifiable'),
          next: z.array(z.string()).describe('ids of the next step(s)'),
        }),
      ),
    },
  },
  async ({ id, name, summary, steps }) => {
    const s = store();
    s.put('flow', {
      id, provenance: 'authored', name, summary,
      steps: steps.map((st) => ({
        id: st.id, label: st.label, description: st.description,
        components: st.anchors.map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)),
        anchors: resolveAnchors(s, st.anchors),
        next: st.next,
      })),
    });
    return text(`Flow "${name}" authored with ${steps.length} anchored steps. It will now detect its own staleness.`);
  },
);

server.registerTool(
  'cv_jobs',
  {
    title: 'Pending analysis jobs',
    description: 'Work the dashboard (or the Observer) has queued for an agent to do. Call cv_jobs, then actually do the work, then record the results with the write tools.',
    inputSchema: {},
  },
  async () => {
    const jobs = new JobQueue(store()).list('queued');
    if (!jobs.length) return text('No queued jobs.');
    return json(jobs.map((j) => ({ id: j.id, type: j.type, tier: j.tier, payload: j.payload })));
  },
);

function summarise(kind: string, r: any) {
  switch (kind) {
    case 'decision': return { title: r.title, choice: r.choice, rationale: r.rationale, status: r.status };
    case 'experiment': return { title: r.title, hypothesis: r.hypothesis, verdict: r.verdict, judgement: r.judgement };
    case 'insight': return { title: r.title, severity: r.severity, status: r.status, detail: r.detail };
    case 'thread': return { title: r.title, status: r.status, detail: r.detail };
    case 'flow': return { name: r.name, summary: r.summary, steps: r.steps?.map((s: any) => s.label) };
    case 'component': return { path: r.path, symbol: r.symbol, purpose: r.purpose };
    default: return {};
  }
}

await server.connect(new StdioServerTransport());
