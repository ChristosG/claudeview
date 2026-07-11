import type { Store } from './store.js';
import { checkStaleness, needsAttention } from './staleness.js';
import { JobQueue } from './jobs.js';

/**
 * The session brief.
 *
 * This is the payload injected into Claude's context at SessionStart, and it is the
 * feature that pays for the entire project.
 *
 * Today, every session begins amnesiac. Claude re-reads files, re-derives the
 * architecture, re-discovers what was tried, and confidently repeats an experiment that
 * failed three weeks ago — because nothing carried forward except whatever the human
 * happened to remember to say. The brief ends that: a few hundred tokens that make the
 * next session start *oriented* instead of blank.
 *
 * Three rules govern what goes in it, and they are all about resisting the temptation to
 * put more in:
 *
 *   1. ONLY what changes behaviour. A fact that wouldn't alter what Claude does next is
 *      just tokens. The architecture is NOT here — it's queryable on demand via cv_ask.
 *      What's here is what Claude would otherwise get WRONG.
 *   2. Loudest first. Broken claims outrank stale ones; a dangling experiment outranks a
 *      tidy one. If it gets truncated, it must degrade from the bottom.
 *   3. Never assert more than we can prove. Everything carries its provenance, and
 *      anything unverifiable says so. A brief that bluffs is worse than no brief.
 */

export interface BriefOptions {
  /** Rough ceiling. The brief must never grow into a second CLAUDE.md. */
  maxChars?: number;
}

export function buildBrief(store: Store, opts: BriefOptions = {}): string {
  const max = opts.maxChars ?? 3000;
  const lines: string[] = [];

  const threads = store.all('thread').filter((t) => t.status === 'open');
  const insights = store.all('insight').filter((i) => i.status === 'open');
  const experiments = store.all('experiment');
  const decisions = store.all('decision').filter((d) => d.status === 'active');
  const report = checkStaleness(store);
  const attention = needsAttention(report);
  const jobs = new JobQueue(store).list('queued');

  const components = store.all('component');
  const events = store.all('event');

  // Nothing has been analysed yet: say so plainly rather than emitting a confident,
  // empty-looking brief that reads as "this project has no history".
  if (components.length === 0 && events.length === 0) {
    return '## ClaudeView\n\nNot initialised for this project yet. Run `/cv init` to have ClaudeView read the session history, index the code, and build the project map.';
  }

  lines.push('## ClaudeView — project state');
  lines.push('');

  // ── 1. Things that are actively WRONG. Loudest first. ──
  if (attention.length) {
    const broken = attention.filter((c) => c.freshness === 'broken');
    const contra = attention.filter((c) => c.freshness === 'contradicted');
    const stale = attention.filter((c) => c.freshness === 'stale');

    lines.push(`### ⚠ ${attention.length} claim(s) no longer match the code`);
    for (const c of [...contra, ...broken, ...stale].slice(0, 6)) {
      const why =
        c.freshness === 'broken' ? 'the code it describes is GONE'
        : c.freshness === 'contradicted' ? 'the code now CONTRADICTS it'
        : 'the code beneath it changed';
      const where = c.anchors.filter((a) => a.freshness !== 'fresh').map((a) => a.anchor.symbol ?? a.anchor.path).slice(0, 3);
      lines.push(`- **${c.kind}** "${c.title}" — ${why}${where.length ? ` (${where.join(', ')})` : ''}`);
    }
    lines.push('');
    lines.push('_Do not repeat these claims to the user as current. Re-verify against the code first._');
    lines.push('');
  }

  // ── 2. Unfinished business. The thing Claude would otherwise silently abandon. ──
  const dangling = experiments.filter((e) => e.verdict === 'open');
  if (dangling.length) {
    lines.push('### Experiments left open');
    for (const e of dangling.slice(0, 4)) {
      const runs = store.all('run').filter((r) => r.experimentId === e.id).length;
      lines.push(`- **${e.id}** "${e.title}" — ${runs} run(s), no verdict yet. Metric: ${e.metric}.`);
    }
    lines.push('');
  }

  // ── 3. Dead ends. The highest-value lines in the whole brief. ──
  // Knowing what FAILED is what stops us cheerfully re-running a losing experiment. This
  // is knowledge that exists nowhere in the code and dies with the session that learned it.
  const losses = experiments.filter((e) => e.verdict === 'loss').slice(0, 5);
  if (losses.length) {
    lines.push('### Already tried and it did NOT work — do not redo these');
    for (const e of losses) lines.push(`- ${e.title}${e.judgement ? ` — ${e.judgement}` : ''}`);
    lines.push('');
  }

  // ── 4. Ideas we said we'd explore and never did. ──
  if (threads.length) {
    lines.push(`### ${threads.length} open thread(s) — raised, never explored`);
    for (const t of threads.slice(0, 5)) lines.push(`- ${t.title}`);
    lines.push('');
  }

  // ── 5. Standing decisions, so we don't quietly contradict ourselves. ──
  if (decisions.length) {
    lines.push('### Decisions in force');
    for (const d of decisions.slice(0, 6)) lines.push(`- **${d.title}**: ${d.choice}`);
    lines.push('');
  }

  // ── 6. Open critique. ──
  const critical = insights.filter((i) => i.severity === 'critical' || i.severity === 'high');
  if (critical.length) {
    lines.push(`### ${critical.length} open insight(s) at high/critical severity`);
    for (const i of critical.slice(0, 4)) lines.push(`- [${i.severity}] ${i.title}`);
    lines.push('');
  }

  if (jobs.length) {
    lines.push(`_${jobs.length} analysis job(s) queued from the dashboard. Run \`/cv drain\` to process them._`);
    lines.push('');
  }

  lines.push(`_${components.length} components indexed · ${report.fresh} claims verified fresh · ask me anything with \`cv_ask\`._`);

  const out = lines.join('\n');
  // Truncating from the bottom is safe by construction: the sections are ordered loudest
  // first, so what gets cut is always the least consequential thing in the brief.
  return out.length <= max ? out : out.slice(0, max) + '\n…(truncated)';
}
