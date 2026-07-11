import type { Store } from './store.js';
import { ANCHORED_KINDS, type Anchor, type Freshness } from './schema.js';
import { anchorId } from './observer/code.js';

/**
 * The trust machinery.
 *
 * Everything Claude authors — a Decision, a Flow diagram, an Insight — is a CLAIM about
 * code. Claims rot. The code moves on and the claim quietly keeps asserting something
 * that stopped being true three weeks ago, which is exactly how you end up being told,
 * confidently, about an implementation that no longer exists.
 *
 * The fix is to make claims verifiable rather than trustworthy. Every claim pins the
 * content hash of the code it was written about. The indexer knows the current hash. A
 * disagreement is not an opinion — it is arithmetic:
 *
 *     hash matches      → fresh    (the claim still describes reality)
 *     hash differs      → stale    (the ground moved; the claim MIGHT be wrong)
 *     component gone    → broken   (the claim describes code that no longer exists)
 *
 * This costs zero tokens and runs in milliseconds. No model is consulted and none is
 * needed: we are not asking "is this claim true?", only "is this claim still ABOUT
 * anything?". The stronger verdict — `contradicted`, meaning a model read the new code
 * and found it refutes the claim — is the Auditor's job, and it only ever has to look at
 * the handful of things this pass has already flagged.
 *
 * Notice the asymmetry that makes it safe: a stale claim is not necessarily wrong, but a
 * fresh claim is guaranteed to be about code that hasn't moved. We never assert more
 * than we can prove.
 */

export interface AnchorStatus {
  anchor: Anchor;
  freshness: Extract<Freshness, 'fresh' | 'stale' | 'broken'>;
  /** What the code hashes to now. Absent when the anchor is broken. */
  actual?: string;
}

export interface ClaimStatus {
  kind: string;
  id: string;
  title: string;
  freshness: Freshness;
  anchors: AnchorStatus[];
}

export interface StalenessReport {
  claims: ClaimStatus[];
  fresh: number;
  stale: number;
  broken: number;
  contradicted: number;
  /** Claims with no anchors at all: unverifiable by construction. */
  unanchored: number;
}

/** Worst wins: one broken anchor is enough to distrust the whole claim. */
function worst(statuses: AnchorStatus[]): Extract<Freshness, 'fresh' | 'stale' | 'broken'> {
  if (statuses.some((s) => s.freshness === 'broken')) return 'broken';
  if (statuses.some((s) => s.freshness === 'stale')) return 'stale';
  return 'fresh';
}

function titleOf(rec: any): string {
  return rec.title ?? rec.name ?? rec.id;
}

/**
 * Check every anchored claim in the store against the current code index.
 *
 * Pure and read-only: it derives a report, it does not write. Freshness is never stored,
 * because a stored freshness would itself go stale — the one bug this whole module exists
 * to prevent.
 */
export function checkStaleness(store: Store): StalenessReport {
  // The current truth, by Component id.
  const current = new Map(store.all('component').map((c) => [c.id, c.hash]));

  const claims: ClaimStatus[] = [];
  let unanchored = 0;

  for (const kind of ANCHORED_KINDS) {
    for (const rec of store.all(kind) as any[]) {
      // A Flow's anchors live on its steps; every other kind carries them directly.
      const anchors: Anchor[] =
        kind === 'flow'
          ? (rec.steps ?? []).flatMap((s: any) => s.anchors ?? [])
          : kind === 'insight'
            ? (rec.evidence ?? [])
            : (rec.anchors ?? []);

      if (anchors.length === 0) {
        unanchored++;
        continue;
      }

      const statuses: AnchorStatus[] = anchors.map((a) => {
        const actual = current.get(anchorId(a));
        if (actual === undefined) return { anchor: a, freshness: 'broken' as const };
        if (actual !== a.hash) return { anchor: a, freshness: 'stale' as const, actual };
        return { anchor: a, freshness: 'fresh' as const, actual };
      });

      // An Auditor verdict outranks the mechanical check: a model has actually read the new
      // code and found it refutes the claim. That is strictly more information than "the
      // bytes changed", so it must never be downgraded back to 'stale' on re-check.
      //
      // It is cleared only by RE-ANCHORING (cv resolve --reaffirm), i.e. by someone looking
      // at the new code and saying the claim holds after all. A contradiction is retired by
      // evidence, not by time passing.
      const freshness: Freshness = rec.contradicted ? 'contradicted' : worst(statuses);

      claims.push({ kind, id: rec.id, title: titleOf(rec), freshness, anchors: statuses });
    }
  }

  return {
    claims,
    fresh: claims.filter((c) => c.freshness === 'fresh').length,
    stale: claims.filter((c) => c.freshness === 'stale').length,
    broken: claims.filter((c) => c.freshness === 'broken').length,
    contradicted: claims.filter((c) => c.freshness === 'contradicted').length,
    unanchored,
  };
}

/** The claims that need a human's or the Auditor's attention, worst first. */
export function needsAttention(report: StalenessReport): ClaimStatus[] {
  const rank: Record<Freshness, number> = { broken: 0, contradicted: 1, stale: 2, fresh: 3 };
  return report.claims
    .filter((c) => c.freshness !== 'fresh')
    .sort((a, b) => rank[a.freshness] - rank[b.freshness]);
}
