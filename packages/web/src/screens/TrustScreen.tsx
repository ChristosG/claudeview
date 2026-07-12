import { useState } from 'react';
import { useLive, post, type Freshness } from '../lib/api';

interface AnchorStatus {
  anchor: { path: string; symbol?: string; hash: string };
  freshness: 'fresh' | 'stale' | 'broken';
  actual?: string;
}
interface Claim { kind: string; id: string; title: string; freshness: Freshness; anchors: AnchorStatus[] }
interface TrustData {
  report: { claims: Claim[]; fresh: number; stale: number; broken: number; contradicted: number; unanchored: number };
  attention: Claim[];
}

const WHY: Record<Freshness, string> = {
  fresh: 'still matches the code',
  stale: 'the code beneath it changed — this claim may no longer be true',
  broken: 'the code it describes no longer exists',
  contradicted: 'a model read the new code and found it refutes this claim',
};

/**
 * Trust — the screen that decides whether any of the others are worth reading.
 *
 * The mechanical verdicts here (fresh / stale / broken) cost nothing and involve no model.
 * They answer a narrow question precisely: *is this claim still ABOUT anything?* They do not
 * answer "is it true" — that needs someone to read the new code, which is what queueing a
 * verify job does.
 *
 * The distinction is the point. `stale` means "the ground moved, be careful". `contradicted`
 * means "we checked, and it's wrong". Collapsing those two into one scary colour would be
 * easier and would make this screen useless.
 */
export function TrustScreen({ revision }: { revision: number }) {
  const { data } = useLive<TrustData>('/api/trust', revision);
  const [queued, setQueued] = useState(false);
  if (!data) return <div className="empty">loading…</div>;

  const { report, attention } = data;
  const total = report.fresh + attention.length;

  return (
    <>
      <header>
        <h2>Trust</h2>
        <p>
          Every claim in this project carries the content hash of the code it describes. When that code moves, the claim
          is flagged automatically — no model, no prompt, no one having to remember. This is what stops the project
          telling you something that stopped being true three weeks ago.
        </p>
      </header>

      {/* These count CLAIMS, not anchors. A flow with four steps is one claim, and it is only
          "verified" if every step still matches — one drifted step makes the whole diagram
          untrustworthy. Saying "3 of 4 anchors fine" would be technically true and
          practically misleading: you cannot half-trust a diagram. */}
      <div className="grid g4">
        <Tile n={report.fresh} label="claims verified" sub="every anchor still matches" color="ok" />
        <Tile n={report.stale} label="claims stale" sub="code changed underneath" color="warn" />
        <Tile n={report.broken} label="claims broken" sub="the code is gone" color="bad" />
        <Tile n={report.unanchored} label="unverifiable" sub="cites no code at all" color="unknown" />
      </div>

      {attention.length === 0 ? (
        <div className="empty">
          <b style={{ color: 'var(--ok)' }}>Everything checks out.</b>
          {total > 0
            ? `All ${report.fresh} anchored claims still match the code they describe.`
            : 'No claims have been recorded yet — there is nothing to verify.'}
          {report.unanchored > 0 && (
            <div style={{ marginTop: 10, color: 'var(--unknown)' }}>
              …except {report.unanchored} claim{report.unanchored > 1 ? 's' : ''} that cite no code, and therefore can
              never be checked at all. Those are shown as unknown, never as fine.
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="dim" style={{ fontSize: 12 }}>
              {attention.length} claim{attention.length > 1 ? 's' : ''} no longer match the code.
            </span>
            <button
              className="act"
              disabled={queued}
              style={{ marginLeft: 'auto' }}
              onClick={async () => {
                await post('/api/jobs', { type: 'verify', payload: { claims: attention.map((c) => ({ kind: c.kind, id: c.id })) } });
                setQueued(true);
              }}
            >
              {queued ? 'queued — run /cv-drain in Claude' : 'queue re-verification'}
            </button>
          </div>

          {attention.map((c) => (
            <div key={c.kind + c.id} className="card" style={{ borderLeft: `2px solid var(--${cvar(c.freshness)})` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className="badge" data-k={c.freshness}>{c.freshness}</span>
                <span className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.1em' }}>{c.kind}</span>
                <b style={{ color: 'var(--ink-bright)', fontWeight: 500 }}>{c.title}</b>
              </div>
              <div style={{ fontSize: 11, color: `var(--${cvar(c.freshness)})`, marginBottom: 8 }}>{WHY[c.freshness]}</div>

              <table>
                <thead>
                  <tr><th>anchored to</th><th>pinned</th><th>now</th><th style={{ width: 80 }}>state</th></tr>
                </thead>
                <tbody>
                  {c.anchors.map((a) => (
                    <tr key={a.anchor.path + a.anchor.symbol}>
                      <td className="path">
                        {a.anchor.path}
                        {a.anchor.symbol && <span style={{ color: 'var(--acc)' }}>#{a.anchor.symbol}</span>}
                      </td>
                      <td><span className="hash">{a.anchor.hash.slice(0, 8)}</span></td>
                      <td>
                        <span className="hash" data-k={a.freshness}>
                          {a.actual ? a.actual.slice(0, 8) : '— gone —'}
                        </span>
                      </td>
                      <td>
                        <span className="badge" data-k={a.freshness}>{a.freshness}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function Tile({ n, label, sub, color }: { n: number; label: string; sub: string; color: string }) {
  return (
    <div className="card">
      <h3>{label}</h3>
      <div className="stat" style={{ color: n > 0 ? `var(--${color})` : 'var(--ink-faint)' }}>{n}</div>
      <div className="faint" style={{ fontSize: 10, marginTop: 6 }}>{sub}</div>
    </div>
  );
}

const cvar = (f: Freshness) => (f === 'stale' ? 'warn' : f === 'broken' ? 'bad' : f === 'contradicted' ? 'crit' : 'ok');
