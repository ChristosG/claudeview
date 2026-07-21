#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, JobQueue, sync, buildBrief, checkStaleness, needsAttention, MODEL_FOR_TIER, protectStore, listSnapshots, healthcheck, compactStore } from '@claudeview/core';

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

  /**
   * Close the loop on a stale claim.
   *
   * When a session FIXES something, the store had no way to hear about it: the insight sat
   * there `open` and amber forever, indistinguishable from one nobody had bothered with.
   * "Found and fixed" and "found and ignored" are completely different facts, and a trust
   * panel that cannot tell them apart is a trust panel that stays permanently alarmed —
   * which is the same as being permanently ignored.
   *
   * Three honest outcomes, and only three:
   *
   *   fixed     — the problem is gone. Re-anchor to the NEW code so the panel goes green,
   *               and keep the record forever as history: this was found, then addressed.
   *   reaffirm  — the code moved but the claim still holds. Re-pin it. (This is the common
   *               case for a Flow or a Decision after a refactor.)
   *   contradict— the code now REFUTES the claim. This is the strongest verdict in the
   *               system and the only one a mechanical check can never reach.
   *
   * Note what is deliberately absent: there is no way to mark something resolved WITHOUT
   * re-reading the code, because the whole point is that the anchor is re-taken from reality.
   * You cannot assert your way to green.
   */
  resolve() {
    const s = store();
    const items = [payload<any>()].flat();
    const now = new Date().toISOString();
    let n = 0;

    for (const p of items) {
      const kind = p.kind as 'insight' | 'decision' | 'flow' | 'experiment';
      const rec = s.get(kind, p.id) as any;
      if (!rec) {
        console.error(`  skip (no such ${kind}): ${p.id}`);
        continue;
      }

      // Re-anchor from the CURRENT code. This is the load-bearing step: it is what actually
      // moves the trust panel, and it is impossible to fake, because the hash is read from
      // the index, never supplied by the caller.
      const reanchor = (as: any[]) =>
        as.map((a: any) => {
          const id = a.symbol ? `${a.path}#${a.symbol}` : a.path;
          const c = s.all('component').find((x) => x.id === id);
          if (!c) die(`cannot re-anchor "${id}" — it no longer exists. If the code is gone, the claim is BROKEN, not fixed.`);
          return { path: a.path, ...(a.symbol ? { symbol: a.symbol } : {}), hash: c.hash };
        });

      if (p.action === 'contradict') {
        s.put(kind, { ...rec, contradicted: { reason: p.note ?? 'refuted by the current code', ts: now } });
      } else if (p.action === 'fixed' && kind === 'insight') {
        s.put('insight', {
          ...rec,
          status: 'fixed',
          resolution: { note: p.note ?? 'fixed', ts: now },
          evidence: reanchor(rec.evidence ?? []),
          contradicted: undefined,
        });
      } else if (p.action === 'reaffirm') {
        const patch: any = { ...rec, contradicted: undefined };
        if (kind === 'flow') {
          patch.steps = (rec.steps ?? []).map((st: any) => ({ ...st, anchors: reanchor(st.anchors ?? []) }));
        } else if (kind === 'insight') {
          patch.evidence = reanchor(rec.evidence ?? []);
        } else {
          patch.anchors = reanchor(rec.anchors ?? []);
        }
        s.put(kind, patch);
      } else {
        die(`unknown action "${p.action}" for ${kind} — use fixed | reaffirm | contradict`);
      }
      n++;
    }
    console.log(`resolved ${n} claim(s)`);
  },

  /**
   * The recovery path, made visible.
   *
   * A backup nobody knows how to restore is not a backup. On 2026-07-12 an agent wiped a real
   * store; recovery was only possible because the raw payloads happened to still be lying in a
   * scratch directory. That was luck, and luck is not a design.
   */
  snapshots() {
    const snaps = listSnapshots(repo);
    if (!snaps.length) {
      console.log('No snapshots yet. They are written on every store mutation, to ~/.claude/claudeview-snapshots/');
      return;
    }
    console.log(`${snaps.length} snapshot(s) of ${repo}, newest first:\n`);
    for (const s of snaps) {
      console.log(`  ${s.at}   ${(s.records / 1024).toFixed(0).padStart(6)} KB   ${s.dir}`);
    }
    console.log(`\nTo restore:  cp <dir>/*.jsonl ${repo}/.claudeview/`);
  },

  /** Does it actually work, right now, on this repo? Drives the real thing and asks. */
  async doctor() {
    const checks = await healthcheck(repo);
    const bad = checks.filter((c) => !c.ok);
    console.log(`ClaudeView health — ${repo}\n`);
    for (const c of checks) {
      const mark = c.ok ? ' ok ' : (c.critical ? 'FAIL' : 'warn');
      console.log(`  [${mark}] ${c.name}`);
      console.log(`         ${c.detail}`);
    }
    const criticals = bad.filter((c) => c.critical);
    console.log(
      criticals.length
        ? `\n${criticals.length} CRITICAL failure(s). The tool is not trustworthy in this state.`
        : bad.length
          ? `\n${bad.length} warning(s), nothing critical.`
          : `\nAll ${checks.length} checks pass.`,
    );
    if (criticals.length) process.exitCode = 1;
  },

  /**
   * Repair a store bloated by pre-dirty-check write amplification. Free — pure file I/O.
   *
   * Prints rather than emitting JSON, because unlike every other command here this one is run
   * by a human deciding whether to trust a destructive operation. It reports what it kept, not
   * just what it saved: "156 records" next to "630,571 lines" is the number that shows nothing
   * was thrown away, and it is the only reassurance that matters before rewriting a store.
   */
  compact() {
    const res = compactStore(repo, { force: argv.includes('--force') });
    const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

    if (res.kinds.length === 0) {
      console.log(`ClaudeView store is already compact — ${repo}\n  nothing to do. (--force folds the last few revisions anyway.)`);
      return;
    }

    console.log(`ClaudeView compaction — ${repo}\n`);
    for (const k of res.kinds) {
      console.log(`  ${k.kind.padEnd(10)} ${k.before.toLocaleString()} lines → ${k.after.toLocaleString()} records`);
      console.log(`  ${''.padEnd(10)} ${mb(k.bytesBefore)} → ${mb(k.bytesAfter)}`);
    }
    console.log(`\n  reclaimed ${mb(res.bytesSaved)} in ${res.ms}ms, zero tokens.`);
    console.log(`  originals kept at ${res.backupDir}`);
    console.log(`\n  Authored history (decisions, insights, experiments, threads) was not touched.`);
  },

  jobs() {
    out(new JobQueue(store()).list(flag('status') as any));
  },

  /**
   * The cold-start fan-out plan, with a model assigned to every agent.
   *
   * This exists so the routing is DATA, not a paragraph of prose in a slash-command that
   * Claude may or may not follow. `/cv-init` reads this and dispatches exactly these agents
   * at exactly these models — which is the difference between a `tier` field that documents
   * an intention and one that actually spends less money.
   *
   * The fleet is sized from the repo: a project with no evals gets no experiment miner, and
   * a project with 40 files does not need its periphery split from its core.
   */
  plan() {
    const s = store();
    const comps = s.all('component').filter((c) => !c.symbol);
    const paths = comps.map((c) => c.path);
    const has = (re: RegExp) => paths.some((p) => re.test(p));
    const loc = comps.reduce((n, c) => n + c.loc, 0);

    const agents: Array<{ agent: string; model: string; why: string }> = [
      { agent: 'annotate', model: MODEL_FOR_TIER.haiku, why: 'pure volume: read a file, write one concrete sentence. Measured 213k tokens on gdpr — the single biggest saving, and no judgement is involved.' },
      { agent: 'author-flows', model: MODEL_FOR_TIER.opus, why: 'the diagram the human actually looks at. Tracing a real execution path across 19 stages is the hardest reasoning in the run.' },
      { agent: 'recover-decisions', model: MODEL_FOR_TIER.sonnet, why: 'must reconstruct WHY from docs/git/transcripts and must refuse to invent a rationale it cannot support.' },
      { agent: 'mine-threads', model: MODEL_FOR_TIER.sonnet, why: 'the value is in the KILLING (106 candidates -> 18). A cheaper model returns a longer, worse list.' },
      { agent: 'red-team-core', model: MODEL_FOR_TIER.opus, why: 'produced every critical finding. A plausible-but-wrong insight is worse than none.' },
    ];

    // Only fan out further where the repo actually justifies it.
    if (has(/eval|bench|experiment/i)) {
      agents.push({ agent: 'mine-experiments', model: MODEL_FOR_TIER.sonnet, why: 'this repo has an evals tree. Recovering DEAD ENDS is the highest-value artifact there is — but every number must be read, never invented.' });
    }
    if (loc > 15_000) {
      agents.push({ agent: 'red-team-periphery', model: MODEL_FOR_TIER.opus, why: 'repo is large enough that one reviewer would skim. Splitting core/periphery also gives two independent looks — on gdpr they converged on the same root cause from opposite ends, which is the strongest signal a review can produce.' });
    }

    out({
      repo,
      loc,
      files: comps.length,
      agents,
      note: 'Dispatch these in PARALLEL, each with its stated model. Cheapen volume, never cheapen judgement.',
    });
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

// Protect the store after ANY command that could have written to it.
//
// Centralised here rather than sprinkled through each command, because the failure this
// guards against was caused by exactly the kind of gap that "remember to call it" produces:
// a store nobody had staged, deleted by an agent tidying its worktree.
const MUTATES = new Set(['sync', 'flow', 'decide', 'thread', 'insight', 'experiment', 'annotate', 'resolve']);
if (MUTATES.has(cmd ?? '')) protectStore(repo);
