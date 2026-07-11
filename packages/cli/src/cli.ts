#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, JobQueue, sync, buildBrief, checkStaleness, needsAttention } from '@claudeview/core';

/**
 * The `cv` CLI — ClaudeView's write surface for agents that are not the main session.
 *
 * The MCP server binds to one repo (whatever CLAUDE_PROJECT_DIR says), which is right for an
 * interactive session but useless for the two cases that matter most:
 *
 *   - a cold-start, where a fleet of subagents analyses a DIFFERENT repo in parallel and must
 *     all write into that repo's store, not the one their session happens to sit in;
 *   - the headless drain runner, which processes queued jobs with no session at all.
 *
 * So: an explicit `--repo`, and payloads passed as `@file.json` rather than shell-quoted
 * argv. That second detail is not cosmetic — an agent emitting a JSON blob full of code
 * snippets, quotes and newlines through a shell will corrupt it eventually, and the failure
 * is silent and awful. A file has no quoting rules.
 */

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const repo = resolve(flag('repo') ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

/** Payload: inline JSON, or `@path/to/file.json` (strongly preferred — no quoting hazards). */
function payload<T = any>(): T {
  const raw = flag('json');
  if (!raw) die('missing --json <json|@file>');
  const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (e: any) {
    die(`--json is not valid JSON: ${e.message}`);
  }
}

function die(msg: string): never {
  console.error(`cv: ${msg}`);
  process.exit(1);
}

const store = () => new Store(repo);
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

/**
 * Resolve an authored anchor to the live code, capturing its CURRENT hash.
 *
 * You cannot assert a hash here — you can only cite code that exists. An anchor to something
 * that isn't indexed is rejected loudly, because a claim nobody can ever verify is worse than
 * no claim: it looks like knowledge and behaves like a rumour.
 */
function resolveAnchors(s: Store, anchors: { path: string; symbol?: string }[]) {
  const comps = s.all('component');
  return anchors.map((a) => {
    const id = a.symbol ? `${a.path}#${a.symbol}` : a.path;
    const c = comps.find((x) => x.id === id);
    if (!c) die(`cannot anchor to "${id}" — no such component is indexed. Cite code that exists (try: cv components --repo ${repo} | grep ...).`);
    return { path: a.path, ...(a.symbol ? { symbol: a.symbol } : {}), hash: c.hash };
  });
}

const commands: Record<string, () => Promise<void> | void> = {
  async sync() {
    out(await sync(repo, { queueWork: flag('queue') === 'true' }));
  },

  state() {
    console.log(buildBrief(store(), { maxChars: 8000 }));
  },

  stale() {
    const r = checkStaleness(store());
    out({ summary: { fresh: r.fresh, stale: r.stale, broken: r.broken, unanchored: r.unanchored }, attention: needsAttention(r) });
  },

  /** List indexed components so an agent can discover exactly what it is allowed to anchor to. */
  components() {
    const s = store();
    const q = flag('grep');
    const symbolsOnly = argv.includes('--symbols');
    let comps = s.all('component');
    if (symbolsOnly) comps = comps.filter((c) => c.symbol);
    if (q) comps = comps.filter((c) => c.id.toLowerCase().includes(q.toLowerCase()));
    comps.sort((a, b) => b.loc - a.loc);
    const limit = Number(flag('limit') ?? 200);
    out(comps.slice(0, limit).map((c) => ({ id: c.id, path: c.path, symbol: c.symbol, loc: c.loc, purpose: c.purpose })));
  },

  flow() {
    const s = store();
    const p = payload<{ id: string; name: string; summary: string; steps: any[] }>();
    s.put('flow', {
      id: p.id, provenance: 'authored', name: p.name, summary: p.summary,
      steps: p.steps.map((st) => ({
        id: st.id, label: st.label, description: st.description,
        components: (st.anchors ?? []).map((a: any) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)),
        anchors: resolveAnchors(s, st.anchors ?? []),
        next: st.next ?? [],
      })),
    });
    console.log(`flow "${p.name}" — ${p.steps.length} anchored steps`);
  },

  decide() {
    const s = store();
    const p = payload<any>();
    s.put('decision', {
      id: p.id, provenance: p.provenance ?? 'inferred', title: p.title, choice: p.choice,
      rationale: p.rationale, alternatives: p.alternatives ?? [],
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      anchors: resolveAnchors(s, p.anchors ?? []), status: 'active',
    });
    if (p.supersedes) {
      const old = s.get('decision', p.supersedes);
      if (old) s.put('decision', { ...old, status: 'superseded' });
    }
    console.log(`decision "${p.id}"`);
  },

  thread() {
    const s = store();
    for (const p of [payload<any>()].flat()) {
      s.put('thread', {
        id: p.id, provenance: p.provenance ?? 'observed', title: p.title, detail: p.detail,
        origin: p.origin ?? {}, status: p.status ?? 'open',
        ...(p.abandonReason ? { abandonReason: p.abandonReason } : {}),
      });
    }
    console.log('threads recorded');
  },

  insight() {
    const s = store();
    for (const p of [payload<any>()].flat()) {
      s.put('insight', {
        id: p.id, provenance: 'inferred', title: p.title, detail: p.detail,
        severity: p.severity, confidence: p.confidence,
        evidence: resolveAnchors(s, p.evidence ?? []), status: 'open',
      });
    }
    console.log('insights recorded');
  },

  experiment() {
    const s = store();
    const p = payload<any>();
    s.put('experiment', {
      id: p.id, provenance: p.provenance ?? 'inferred', title: p.title, hypothesis: p.hypothesis,
      metric: p.metric, verdict: p.verdict ?? 'open',
      ...(p.judgement ? { judgement: p.judgement } : {}),
      ...(p.action ? { action: p.action } : {}),
      anchors: resolveAnchors(s, p.anchors ?? []),
    });
    for (const r of p.runs ?? []) {
      s.put('run', {
        id: `${p.id}#${r.index}`, provenance: 'observed', experimentId: p.id, index: r.index,
        params: r.params ?? {}, metrics: r.metrics ?? {}, ...(r.notes ? { notes: r.notes } : {}), artifacts: [],
      });
    }
    console.log(`experiment "${p.id}" (${(p.runs ?? []).length} runs)`);
  },

  /** Give components their meaning. The one thing the AST cannot tell us. */
  annotate() {
    const s = store();
    let n = 0;
    for (const p of [payload<any>()].flat()) {
      const c = s.get('component', p.id);
      if (!c) {
        console.error(`  skip (not indexed): ${p.id}`);
        continue;
      }
      s.put('component', { ...c, purpose: p.purpose });
      n++;
    }
    console.log(`annotated ${n} components`);
  },

  jobs() {
    out(new JobQueue(store()).list(flag('status') as any));
  },

  /**
   * Find claims that are probably the same claim, discovered twice.
   *
   * A cold-start fans out agents across subsystems, and each one is blind to the others. So
   * the retrieval agent and the ingest agent both read `qdrant_store.py`, both notice that
   * Postgres is the source of truth, and both record it — under different ids, in different
   * words. (This is not hypothetical: it happened on the first real run.)
   *
   * Left alone, the store slowly fills with near-duplicates that each go stale independently
   * and each demand their own re-verification. So after every fan-out, something has to look
   * at the whole set at once.
   *
   * This command does the cheap, mechanical half — *candidate* detection — and leaves the
   * judgement to a model, because deciding whether two differently-worded claims are truly
   * the same claim is exactly the kind of thing a hash cannot do.
   */
  duplicates() {
    const s = store();
    const STOP = new Set(['the', 'a', 'an', 'is', 'of', 'to', 'and', 'not', 'as', 'by', 'in', 'for', 'with', 'on', 'its']);
    const words = (t: string) =>
      new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

    const jaccard = (a: Set<string>, b: Set<string>) => {
      const inter = [...a].filter((x) => b.has(x)).length;
      return inter / (a.size + b.size - inter || 1);
    };

    const groups: any[] = [];
    for (const kind of ['decision', 'insight', 'thread'] as const) {
      const recs = s.all(kind) as any[];
      const seen = new Set<string>();
      for (let i = 0; i < recs.length; i++) {
        const a = recs[i]!;
        if (seen.has(a.id)) continue;
        const aw = words(`${a.title} ${a.choice ?? a.detail ?? ''}`);
        const aAnchors = new Set((a.anchors ?? a.evidence ?? []).map((x: any) => `${x.path}#${x.symbol ?? ''}`));

        const dupes = recs.slice(i + 1).filter((b: any) => {
          if (seen.has(b.id)) return false;
          const bw = words(`${b.title} ${b.choice ?? b.detail ?? ''}`);
          const bAnchors = new Set((b.anchors ?? b.evidence ?? []).map((x: any) => `${x.path}#${x.symbol ?? ''}`));
          const sharedAnchor = [...aAnchors].some((x) => bAnchors.has(x as string));
          const sim = jaccard(aw, bw);
          // Either signal alone is weak; together they are a strong hint. Two claims about
          // the same code that also use the same vocabulary are very likely one claim.
          return sim > 0.55 || (sharedAnchor && sim > 0.3);
        });

        if (dupes.length) {
          dupes.forEach((d: any) => seen.add(d.id));
          seen.add(a.id);
          groups.push({
            kind,
            members: [a, ...dupes].map((r: any) => ({ id: r.id, title: r.title })),
            hint: 'likely the same claim recorded by different agents — merge into one, keep the clearest wording, delete the rest',
          });
        }
      }
    }
    out({ candidateGroups: groups.length, groups });
  },
};

const run = commands[cmd ?? ''];
if (!run) {
  console.error(`usage: cv <${Object.keys(commands).join('|')}> --repo <path> [--json @file]`);
  process.exit(1);
}
await run();
