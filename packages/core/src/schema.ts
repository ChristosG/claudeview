import { z } from 'zod';

/**
 * The ontology. Nine objects; everything else in ClaudeView — every screen, every MCP
 * tool, every hook — is a function of these.
 */

/**
 * How much we trust a record.
 *
 *  observed — derived mechanically from transcripts, git, or the AST. Cannot lie.
 *  authored — Claude lived the session that produced it. High confidence.
 *  inferred — reconstructed after the fact (e.g. from a teammate's diff, with no
 *             session context to explain intent). Treat with suspicion.
 *
 * No record is ever allowed to present itself as more certain than its provenance.
 */
export const Provenance = z.enum(['observed', 'authored', 'inferred']);
export type Provenance = z.infer<typeof Provenance>;

/**
 * A hash-pinned reference from a claim to the code it describes. This is the entire
 * anti-staleness engine: a claim carries the hash of the source it was written about,
 * so when that source changes the claim can be mechanically flagged as no longer
 * trustworthy. A hand-drawn diagram rots silently; an anchored one cannot.
 */
export const Anchor = z.object({
  /** Repo-relative path. Absolute paths would break the moment the repo is cloned elsewhere. */
  path: z.string(),
  /** Symbol within the file (function/class). Absent means the anchor covers the whole file. */
  symbol: z.string().optional(),
  /** sha256 of the anchored source text at the time the claim was made. */
  hash: z.string(),
});
export type Anchor = z.infer<typeof Anchor>;

/**
 * Mechanical freshness. Note what is NOT here: "contradicted". That verdict requires
 * reading the new code and judging it against the claim, which only a model can do —
 * so the Auditor sets it, not the indexer. These three are computable for free.
 */
export const Freshness = z.enum([
  'fresh', // anchored hashes all still match
  'stale', // anchored source changed — the claim may no longer hold
  'broken', // anchored file or symbol no longer exists at all
  'contradicted', // Auditor read the new code and found it refutes the claim
]);
export type Freshness = z.infer<typeof Freshness>;

/** Fields carried by every record in the store. */
const Base = {
  id: z.string(),
  /**
   * Monotonic per-id revision. The store is append-only, so an "update" is a new record
   * with the same id and a higher rev; readers fold by id and keep the winner. This is
   * what lets two machines write the same object and still merge cleanly in git.
   */
  rev: z.number().int().nonnegative().default(0),
  ts: z.string().datetime(),
  /** Stable id of the machine/session that wrote this. Breaks ties when revs collide. */
  actor: z.string(),
  provenance: Provenance,
  /** Tombstone. Deletion is an append, never a rewrite — history is never destroyed. */
  deleted: z.boolean().optional(),
};

// ─── 1. Component ────────────────────────────────────────────────────────────────
// A real code entity, derived from the AST. `purpose` is the one authored field: the
// machine knows the shape, only a model knows the meaning.
export const Component = z.object({
  ...Base,
  kind: z.literal('component'),
  name: z.string(),
  path: z.string(),
  symbol: z.string().optional(),
  language: z.string(),
  /** sha256 of current source. The value every Anchor is compared against. */
  hash: z.string(),
  /** Structural edges, derived. `imports`/`calls` are ids of other Components. */
  imports: z.array(z.string()).default([]),
  calls: z.array(z.string()).default([]),
  loc: z.number().int().nonnegative().default(0),
  /** Authored by the Interpreter. Empty until a model has looked at it. */
  purpose: z.string().optional(),
});
export type Component = z.infer<typeof Component>;

// ─── 2. Flow ─────────────────────────────────────────────────────────────────────
// The conceptual pipeline a human actually wants to look at:
//   query → preprocess → embed → BM25 → rerank → LLM
// Authored, but every step is anchored to real Components — so the pretty diagram is
// audited by the ugly structural graph underneath it.
export const FlowStep = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** Ids of Components implementing this step. This is what makes the box honest. */
  components: z.array(z.string()).default([]),
  anchors: z.array(Anchor).default([]),
  next: z.array(z.string()).default([]),
});
export type FlowStep = z.infer<typeof FlowStep>;

export const Flow = z.object({
  ...Base,
  kind: z.literal('flow'),
  name: z.string(),
  summary: z.string(),
  steps: z.array(FlowStep).default([]),
});
export type Flow = z.infer<typeof Flow>;

// ─── 3. Decision ─────────────────────────────────────────────────────────────────
export const Decision = z.object({
  ...Base,
  kind: z.literal('decision'),
  title: z.string(),
  /** What we chose. */
  choice: z.string(),
  /** Why — the thing that is nowhere in the code and dies with the session. */
  rationale: z.string(),
  /** What we considered and rejected, so we don't re-litigate it in three weeks. */
  alternatives: z.array(z.string()).default([]),
  /** Id of a Decision this replaces. The chain is how we answer "is this still true?". */
  supersedes: z.string().optional(),
  anchors: z.array(Anchor).default([]),
  status: z.enum(['active', 'superseded']).default('active'),
});
export type Decision = z.infer<typeof Decision>;

// ─── 4. Experiment + Run ─────────────────────────────────────────────────────────
// The loop Chris already runs by hand ("try it, judge it, act, loop again, keep a CSV"),
// made durable and queryable. The payoff is negative results: knowing that run 4 lost
// 4 points is what stops us from cheerfully re-running run 4 next month.
export const Run = z.object({
  ...Base,
  kind: z.literal('run'),
  experimentId: z.string(),
  index: z.number().int().nonnegative(),
  params: z.record(z.unknown()).default({}),
  metrics: z.record(z.number()).default({}),
  notes: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
});
export type Run = z.infer<typeof Run>;

export const Experiment = z.object({
  ...Base,
  kind: z.literal('experiment'),
  title: z.string(),
  hypothesis: z.string(),
  /** The metric that decides it. Named up front, so the verdict can't be moved later. */
  metric: z.string(),
  verdict: z.enum(['open', 'win', 'loss', 'inconclusive']).default('open'),
  /** The judge's reasoning over all runs. */
  judgement: z.string().optional(),
  /** What we actually did about it. An experiment with no action was a waste. */
  action: z.string().optional(),
  anchors: z.array(Anchor).default([]),
});
export type Experiment = z.infer<typeof Experiment>;

// ─── 5. Insight ──────────────────────────────────────────────────────────────────
// The adversarial feed: "this is suboptimal", "this is wrong, it deceives you".
// Read-only by construction — the Auditor never edits the implementation it critiques.
export const Insight = z.object({
  ...Base,
  kind: z.literal('insight'),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  /** The Auditor's own confidence. A screen that cries wolf gets ignored. */
  confidence: z.number().min(0).max(1),
  evidence: z.array(Anchor).default([]),
  /** 'dismissed' is permanent and must never be re-raised. Nagging destroys trust. */
  status: z.enum(['open', 'accepted', 'dismissed', 'fixed']).default('open'),
  dismissReason: z.string().optional(),
});
export type Insight = z.infer<typeof Insight>;

// ─── 6. Thread ───────────────────────────────────────────────────────────────────
// "We should try X sometime" — said mid-session, never done, gone forever. Harvested
// from transcripts and resurfaced at session start. This is the idea graveyard,
// exhumed.
export const Thread = z.object({
  ...Base,
  kind: z.literal('thread'),
  title: z.string(),
  detail: z.string(),
  /** Verbatim quote from the transcript, so it's obvious this was really said. */
  origin: z.object({
    sessionId: z.string().optional(),
    ts: z.string().optional(),
    quote: z.string().optional(),
  }).default({}),
  status: z.enum(['open', 'exploring', 'done', 'abandoned']).default('open'),
  /** Why it was abandoned. An abandoned idea with no reason gets re-proposed forever. */
  abandonReason: z.string().optional(),
});
export type Thread = z.infer<typeof Thread>;

// ─── 7. Session ──────────────────────────────────────────────────────────────────
export const Session = z.object({
  ...Base,
  kind: z.literal('session'),
  sessionId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  gitBranch: z.string().optional(),
  /** Observed counts — free, exact, and they never need a model. */
  stats: z.object({
    prompts: z.number().int().default(0),
    edits: z.number().int().default(0),
    writes: z.number().int().default(0),
    bash: z.number().int().default(0),
    filesTouched: z.array(z.string()).default([]),
  }).default({}),
  /** Authored narrative. Absent until the Interpreter has run. */
  summary: z.string().optional(),
});
export type Session = z.infer<typeof Session>;

// ─── 8. Panel ────────────────────────────────────────────────────────────────────
// A project-local custom visualization Claude authors on demand. Lives in this project
// and nowhere else — the token-cost barplots you need this week and never again.
export const Panel = z.object({
  ...Base,
  kind: z.literal('panel'),
  title: z.string(),
  screen: z.string().default('pulse'),
  /**
   * 'vega' — a declarative Vega-Lite spec. Safe, instant, no build step; covers ~90%.
   * 'html' — raw HTML/JS, rendered sandboxed. The escape hatch for the other 10%.
   */
  render: z.enum(['vega', 'html']),
  /** Vega-Lite spec, or a path under .claudeview/panels/ for html panels. */
  spec: z.unknown(),
  /** SQL against the derived index. The panel is a view, never a copy, of the store. */
  query: z.string().optional(),
});
export type Panel = z.infer<typeof Panel>;

// ─── 9. Event ────────────────────────────────────────────────────────────────────
// The raw observed stream distilled from transcripts. Pure Tier-1 fact: zero tokens,
// zero interpretation, cannot be wrong.
export const Event = z.object({
  ...Base,
  kind: z.literal('event'),
  sessionId: z.string(),
  type: z.enum(['prompt', 'command', 'tool', 'compact', 'error', 'commit']),
  tool: z.string().optional(),
  /** Commit metadata. Present only on `type: 'commit'`. */
  commit: z.object({
    sha: z.string(),
    author: z.string(),
    email: z.string().optional(),
    /**
     * Whether we can account for this commit from our own session history.
     *
     * A commit we watched being written is `explained`. A commit that appeared out of
     * nowhere — a teammate's push, a rebase, work done on another machine, an edit made
     * in an IDE — is `foreign`: the code moved and we have NO record of why. Those are
     * precisely the commits that silently invalidate everything we believe, so they are
     * the ones the Reconciliation pass has to go read.
     */
    origin: z.enum(['explained', 'foreign']).default('foreign'),
  }).optional(),
  /**
   * Who did this: the main session, or a subagent.
   *
   * Claude Code gives every subagent and every multi-agent workflow its own transcript
   * under <session>/subagents/. On a workflow-heavy project that is the majority of the
   * work by volume, and a flat scan misses all of it. Keeping the attribution lets us
   * answer "which agent, in which workflow, found this?" instead of "an agent did stuff".
   */
  agent: z.object({
    type: z.enum(['main', 'subagent']).default('main'),
    /** Workflow run id (wf_*), when this agent was part of an orchestrated run. */
    workflow: z.string().optional(),
    /** The subagent's own id. */
    id: z.string().optional(),
  }).default({ type: 'main' }),
  /** Repo-relative paths touched, if any. */
  paths: z.array(z.string()).default([]),
  /**
   * Whether the tool call appears to have succeeded.
   *
   * Deliberately `ok` and not `exitCode`: Claude Code's Bash results carry only
   * {stdout, stderr, interrupted} — there is no exit code in the transcript. So this is
   * INFERRED from stderr/interrupted, not read. Naming it `exitCode` would dress a
   * heuristic up as a fact, and the whole point of the observed tier is that it never
   * does that.
   */
  ok: z.boolean().optional(),
  /**
   * True when the human hand-edited a file after Claude wrote it (Claude Code records
   * `userModified` on Edit results). A direct, free signal of where Claude got it wrong.
   */
  userModified: z.boolean().optional(),
  /** Lines added/removed, from the structuredPatch that Edit results carry for free. */
  churn: z.object({ added: z.number().int(), removed: z.number().int() }).optional(),
  summary: z.string().optional(),
});
export type Event = z.infer<typeof Event>;

// ─── The union ───────────────────────────────────────────────────────────────────

export const Record = z.discriminatedUnion('kind', [
  Component, Flow, Decision, Experiment, Run, Insight, Thread, Session, Panel, Event,
]);
export type Record = z.infer<typeof Record>;

export type Kind = Record['kind'];

/** One append-only file per kind. Text, greppable, hand-editable, mergeable. */
export const FILES: Record_KindMap = {
  component: 'components.jsonl',
  flow: 'flows.jsonl',
  decision: 'decisions.jsonl',
  experiment: 'experiments.jsonl',
  run: 'runs.jsonl',
  insight: 'insights.jsonl',
  thread: 'threads.jsonl',
  session: 'sessions.jsonl',
  panel: 'panels.jsonl',
  event: 'events.jsonl',
};
type Record_KindMap = { [K in Kind]: string };

/** Objects that make claims about code, and can therefore go stale. */
export const ANCHORED_KINDS = ['flow', 'decision', 'experiment', 'insight'] as const;
