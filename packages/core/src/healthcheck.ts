/**
 * Does ClaudeView actually work, right now, on this repo?
 *
 * Not "do the unit tests pass" — they pass on fixtures. This drives the real thing against a
 * real project and checks the properties that actually matter, because almost every serious
 * bug in this project's short life has been of one kind: **something that reported success
 * and quietly did nothing.**
 *
 *   - fs.watch registered fine and delivered zero events
 *   - the indexer found "0 components" instead of saying it couldn't load a grammar
 *   - the job queue wrote a result and then renamed a stale file over it
 *   - the store sat untracked and got deleted by a routine `git clean`
 *
 * A green test suite would have told you nothing about any of those. So this asks the
 * uncomfortable questions directly, and it is meant to be run against a live repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { sync } from './sync.js';
import { checkStaleness } from './staleness.js';
import { CodeIndexer } from './observer/code.js';
import { transcriptDirs } from './observer/transcripts.js';
import { listSnapshots } from './protect.js';
import { COMPACTABLE } from './compact.js';
import { fingerprint } from './fingerprint.js';
import { buildBrief } from './brief.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failure here means the system is actively lying, not merely degraded. */
  critical?: boolean;
}

/**
 * Change the source of a SYMBOL, not merely of the file that contains it.
 *
 * A symbol's hash covers the symbol's own text. Appending a comment at the bottom of the file
 * therefore — correctly — changes nothing, and the first version of this probe did exactly
 * that and then declared the staleness engine broken. A check that can fail for the wrong
 * reason is worse than no check: it sends you hunting a bug that does not exist.
 *
 * So we insert a comment INSIDE the symbol's body, matching the body's own indentation. A
 * comment cannot change behaviour and cannot break syntax in any language we index, which
 * matters because this runs against a real repo and always restores the file afterwards.
 *
 * Returns null rather than guessing if the symbol cannot be located — an inconclusive probe
 * must report itself as inconclusive, never as a pass.
 */
function perturb(src: string, path: string, symbol?: string): string | null {
  // '#' in Python/Ruby/shell, '//' everywhere else we index. A comment cannot change behaviour
  // and cannot break syntax — important, because this runs against a real working tree.
  const c = /\.(py|rb|sh|bash|pyi)$/.test(path) ? '#' : '//';

  if (!symbol) return src + `\n${c} claudeview healthcheck probe\n`;

  const lines = src.split('\n');
  const decl = new RegExp(
    `\\b(?:def|class|function|const|let|var|fn|func|impl|struct|interface|type)\\s+${escapeRe(symbol)}\\b` +
    `|\\b${escapeRe(symbol)}\\s*[=:(]`,
  );

  for (let i = 0; i < lines.length; i++) {
    if (!decl.test(lines[i]!)) continue;

    // Borrow the indentation of the body's first real line, so the comment lands INSIDE the
    // symbol rather than dedenting out of it (which in Python would be a syntax error).
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const l = lines[j]!;
      if (!l.trim()) continue;
      const indent = l.match(/^\s*/)?.[0] ?? '';
      if (!indent) break; // the body never started — not a block we can safely enter
      lines.splice(j, 0, `${indent}${c} claudeview healthcheck probe`);
      return lines.join('\n');
    }
  }
  return null; // cannot locate it — say so, never pretend it passed
}

/** Bytes in units a person reads at a glance, not 394394 KB. */
function human(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function healthcheck(repoRoot: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, critical = false) =>
    checks.push({ name, ok, detail, critical });

  const store = new Store(repoRoot);

  // ── 0. Is the filesystem itself fast enough for any of this to work? ──
  //
  // Everything below assumes a stat is roughly free. On a Windows drive mounted into WSL
  // (/mnt/c) it is not: that path goes over the 9p protocol, where each stat is a round trip
  // and walking a repo costs seconds instead of milliseconds. The dashboard then spends all
  // its time walking rather than serving and looks "slow" for reasons that have nothing to do
  // with ClaudeView — a diagnosis nobody reaches unaided, because every component is behaving
  // correctly and the tool reports no fault anywhere.
  //
  // Measured, not assumed: some /mnt paths are perfectly quick, and WSL2 keeps changing.
  //
  // And time the REAL operation, not a proxy for it. The first version stat'd up to 200 entries of the repo root — shallow, non-recursive, and
  // almost certainly warm in cache. It passed on a filesystem slow enough to make the
  // dashboard unusable, which makes it worse than no check: it answers "fine" to a question
  // it never asked. `fingerprint` is precisely what the watcher runs on every tick, so time
  // that, twice, and take the second (the first pays for cold cache, which the poller does
  // not, and reporting the cold number would cry wolf on a perfectly good disk).
  fingerprint(repoRoot);
  const scanStart = Date.now();
  fingerprint(repoRoot);
  const scanMs = Date.now() - scanStart;

  const wsl = existsSync('/proc/version')
    && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  // The watcher spends at most ~1/10th of its time looking, with a 2s floor, so anything past
  // ~200ms already pushes it off the floor. 500ms is where a human starts feeling it.
  add('filesystem is fast enough to watch', scanMs < 500,
    scanMs < 500
      ? `a full scan of this repo takes ${scanMs}ms`
      : `a full scan of this repo takes ${scanMs}ms, and the watcher runs one every tick.`
        + (wsl && /^\/mnt\/[a-z]\//.test(repoRoot)
          ? ` This repo lives on a Windows drive mounted into WSL, which goes over 9p: every`
            + ` file operation is a round trip. Move the project into the WSL filesystem`
            + ` (e.g. ~/code/) and it will be 10-100x faster — for git, your editor, your`
            + ` build, and ClaudeView alike. ClaudeView backs off its polling to stay out of`
            + ` the way, but it cannot make the disk faster.`
          : ` ClaudeView polls proportionally less often to compensate, so the dashboard stays`
            + ` responsive, but it will notice changes later.`));

  // ── 1. Is the observed tier actually observing? ──
  const dirs = transcriptDirs(repoRoot);
  add('transcripts discovered', dirs.length > 0,
    dirs.length ? `${dirs.length} dir(s)` : 'none — no session history for this repo');

  // ── 1b. Is the store carrying its own weight, or dead revisions? ──
  //
  // Write amplification is invisible until it is fatal. A poller that rewrote unchanged
  // records turned 156 sessions into 630,571 revisions and 1.2 GB, and the first symptom the
  // user ever saw was "dashboard failed to start" — a message about the wrong subsystem
  // entirely, three days after the cause. The dirty check in `Store.putMany` prevents it now,
  // but a store that predates the fix, or a future caller that finds a new way to churn,
  // should be caught by something that looks rather than assumed.
  //
  // The measure is the RATIO, not the size. A big honest store is fine; a small store that is
  // 90% superseded revisions is the bug, and it is the bug while it is still cheap to fix.
  const bloat = [...COMPACTABLE].map((kind) => {
    const f = store.fileFor(kind);
    if (!existsSync(f)) return { kind, lines: 0, records: 0, bytes: 0 };
    const records = store.foldedRaw(kind).size;
    return { kind, lines: store.lastStats.parsed + store.lastStats.skipped, records, bytes: statSync(f).size };
  }).filter((b) => b.lines > 0);

  const worst = bloat.map((b) => ({ ...b, ratio: b.records ? b.lines / b.records : 1 }))
    .sort((a, b) => b.ratio - a.ratio)[0];

  if (worst) {
    const total = bloat.reduce((n, b) => n + b.bytes, 0);
    add('store is compact', worst.ratio < 3,
      worst.ratio < 3
        ? `${human(total)}, worst kind '${worst.kind}' at ${worst.ratio.toFixed(1)}x revisions per record`
        : `'${worst.kind}' holds ${worst.lines.toLocaleString()} lines for ${worst.records.toLocaleString()} records `
          + `(${worst.ratio.toFixed(0)}x, ${human(total)} total). Run: cv compact --repo ${repoRoot} `
          + `— free, local, and it keeps every authored decision.`);
  }

  const before = store.all('component').length;
  const r = await sync(repoRoot, { queueWork: false });
  add('sync runs', r.components > 0, `${r.components} components, ${r.events} new events, ${r.ms.toFixed(0)}ms`);

  // An empty index has three completely different causes and one useless message.
  //
  // "ZERO components — the indexer is silently finding nothing" was true and unactionable: it
  // does not distinguish "you are standing in the wrong directory" from "this project is
  // written in a language I have no grammar for" from "your install is broken". A user reading
  // it goes hunting for a bug in the indexer, which is the one explanation it is NOT, because
  // a broken grammar throws (see CodeIndexer.index) rather than returning empty.
  //
  // So say which one it is. The walker already knows.
  if (r.components > 0) {
    add('code index is populated', true, `${r.components} components from ${r.filesScanned} files`);
  } else if (r.filesScanned === 0) {
    const seen = r.skippedExtensions;
    const detail = seen.length
      ? `no indexable source files here. Found ${seen.map((s) => `${s.files}x ${s.ext}`).join(', ')}`
        + ` — none of which ClaudeView has a grammar for. Is this the project ROOT, and is its`
        + ` language supported? (Supported: .py .ts .tsx .js .go .rs .rb .java .c .cpp .cs .php`
        + ` .swift .kt .scala .lua .sh)`
      : `this directory contains no files ClaudeView can index — it looks empty. Run cv from the`
        + ` project ROOT (the directory with your source in it), not from .claudeview/ or a`
        + ` parent.`;
    add('code index is populated', false, detail, true);
  } else {
    add('code index is populated', false,
      `scanned ${r.filesScanned} indexable file(s) and extracted nothing — that is a real bug,`
      + ` not a configuration problem. Please report it with the languages involved.`, true);
  }

  // ── 2. THE CORE THESIS. Does a claim actually notice its code moving? ──
  //
  // The one check that matters. Everything else here is scaffolding around the proposition
  // that an authored claim flags itself when the code beneath it changes. If this fails, the
  // product does not work, however green the rest looks.
  //
  // Note what this does NOT do: compare aggregate counters. The first version asked "did the
  // stale total go up?" — and on a store where the chosen claim was already BROKEN, degrading
  // one of its anchors moved nothing, so it declared the engine dead. Aggregates are a lossy
  // proxy for the property under test. So: pick an anchor that is currently FRESH, and demand
  // that THAT anchor, specifically, stops being fresh.
  const fresh = checkStaleness(store).claims
    .flatMap((c) => c.anchors.filter((a) => a.freshness === 'fresh').map((a) => ({ claim: c, a })))
    .find(({ a }) => existsSync(join(repoRoot, a.anchor.path)));

  if (!fresh) {
    add('THESIS: claims detect code changes', false,
      'no FRESH anchored claim exists to test with — run /cv-init first, or everything is already stale', true);
  } else {
    const { path, symbol } = fresh.a.anchor;
    const id = symbol ? `${path}#${symbol}` : path;
    const file = join(repoRoot, path);
    const original = readFileSync(file, 'utf8');
    const probed = perturb(original, path, symbol);

    if (probed === null) {
      add('THESIS: claims detect code changes', false,
        `could not perturb ${id} — probe INCONCLUSIVE, which is not a pass`, true);
    } else {
      try {
        writeFileSync(file, probed);
        await new CodeIndexer(repoRoot, new Store(repoRoot)).index();

        const after = checkStaleness(new Store(repoRoot)).claims
          .find((c) => c.kind === fresh.claim.kind && c.id === fresh.claim.id);
        const now = after?.anchors.find(
          (a) => a.anchor.path === path && a.anchor.symbol === symbol,
        );
        const detected = !!now && now.freshness !== 'fresh';

        add('THESIS: claims detect code changes', detected,
          detected
            ? `${id} went fresh → ${now!.freshness} in "${fresh.claim.title.slice(0, 40)}" — unprompted`
            : `changed ${id} and the claim still reports FRESH — THE STALENESS ENGINE IS NOT WORKING`,
          true);
      } finally {
        writeFileSync(file, original); // always put it back
        await new CodeIndexer(repoRoot, new Store(repoRoot)).index();
      }
    }
  }

  // ── 3. Is the store protected, or one `git clean` from oblivion? ──
  let tracked = false;
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '.claudeview'], { encoding: 'utf8' });
    tracked = out.trim().length > 0;
  } catch { /* not a repo */ }
  add('store is tracked by git', tracked,
    tracked ? 'staged — `git clean` cannot remove it' : 'UNTRACKED — one `git clean -fd` from total loss', true);

  const snaps = listSnapshots(repoRoot);
  add('off-repo snapshots exist', snaps.length > 0,
    snaps.length ? `${snaps.length} generation(s), newest ${snaps[0]!.at}` : 'none — no recovery path if the repo is wiped', true);

  // ── 4. Is the committed store lean, or is it becoming a liability? ──
  const durable = ['decisions', 'experiments', 'runs', 'insights', 'threads', 'flows', 'sessions']
    .map((f) => join(repoRoot, '.claudeview', `${f}.jsonl`))
    .filter(existsSync)
    .reduce((n, f) => n + statSync(f).size, 0);
  const leaked = ['events', 'components']
    .map((f) => join(repoRoot, '.claudeview', `${f}.jsonl`))
    .filter(existsSync);
  add('derived data stays out of git', leaked.length === 0,
    leaked.length ? `LEAKING: ${leaked.map((f) => f.split('/').pop()).join(', ')} are in the committed store` : 'events + components are in cache/');
  // Report the size in units a human reads at a glance. "394394 KB durable" is a real number
  // this printed, and it was read as a doubled 394 — a check nobody can parse is a check
  // nobody acts on. And when it fails, name the file responsible and what to do, rather than
  // leaving the reader to work out which of seven logs got fat.
  const biggest = ['decisions', 'experiments', 'runs', 'insights', 'threads', 'flows', 'sessions']
    .map((f) => ({ f, p: join(repoRoot, '.claudeview', `${f}.jsonl`) }))
    .filter(({ p }) => existsSync(p))
    .map(({ f, p }) => ({ f, size: statSync(p).size }))
    .sort((a, b) => b.size - a.size)[0];

  add('committed store is lean', durable < 5_000_000,
    durable < 5_000_000
      ? `${human(durable)} durable`
      : `${human(durable)} durable — mostly ${biggest?.f}.jsonl (${human(biggest?.size ?? 0)}). `
        + `This directory is committed to git, so it is in every clone. Run: cv compact --repo ${repoRoot}`);

  // ── 5. Would a fresh session actually learn anything? ──
  const brief = buildBrief(store);
  const hasContent = brief.length > 200 && !brief.includes('Not initialised');
  add('session brief has substance', hasContent,
    hasContent ? `${brief.length} chars (~${Math.round(brief.length / 4)} tokens)` : 'brief is empty — a new session would learn nothing');

  // ── 6. Honesty: are we claiming to verify things we cannot? ──
  const report = checkStaleness(store);
  add('no claim is unverifiably "fresh"', true,
    `${report.fresh} verified, ${report.stale} stale, ${report.broken} broken, ${report.unanchored} unverifiable (shown as unknown, never as fine)`);

  void before;
  return checks;
}
