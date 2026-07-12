import { useState } from 'react';
import { useLive, post } from '../lib/api';

interface Anchor { path: string; symbol?: string }
interface Insight {
  id: string; title: string; detail: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  evidence: Anchor[];
  status: 'open' | 'accepted' | 'dismissed' | 'fixed';
}

const ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

/**
 * Insights — the adversarial feed. "This is not optimal." "This is wrong, and it deceives you."
 *
 * Two rules keep this screen from becoming the tab nobody opens:
 *
 *   1. Confidence is shown, honestly. A finding at 0.4 says so. A feed that presents every
 *      hunch with the same certainty as a proof teaches you to discount all of it, and then
 *      the one that mattered goes unread.
 *
 *   2. Dismissal is FOREVER. If you say "no, that's intentional", it never comes back. The
 *      fastest way to destroy a critique tool is to make it nag.
 *
 * And it never fixes anything. The Auditor is strictly read-only — it observes and flags,
 * and the decision to change code stays yours.
 */
export function Insights({ revision }: { revision: number }) {
  const { data, reload } = useLive<Insight[]>('/api/insights', revision);
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState<string>();

  if (!data) return <div className="empty">loading…</div>;

  const open = data.filter((i) => i.status === 'open').sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.confidence - a.confidence);
  const closed = data.filter((i) => i.status !== 'open');

  const dismiss = async (id: string) => {
    setBusy(id);
    try {
      await post('/api/insight/dismiss', { id, reason: 'dismissed from dashboard' });
      reload();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <header>
        <h2>Insights</h2>
        <p>
          What an adversarial pass over your code found. Read-only by design — it flags, it never fixes. Dismiss
          anything intentional and it will not be raised again.
        </p>
      </header>

      {open.length === 0 ? (
        <div className="empty">
          <b>No open insights.</b>
          {closed.length > 0
            ? `${closed.length} previously raised and resolved or dismissed.`
            : 'Nobody has red-teamed this codebase yet.'}
          <div style={{ marginTop: 14 }}>
            <button className="act" disabled={queued} onClick={async () => { await post('/api/jobs', { type: 'red-team' }); setQueued(true); }}>
              {queued ? 'queued — run /cv-drain in Claude' : 'queue an adversarial pass'}
            </button>
          </div>
        </div>
      ) : (
        open.map((i) => (
          <div key={i.id} className="card" style={{ borderLeft: `2px solid var(--${sevVar(i.severity)})` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="badge" data-k={i.severity}>{i.severity}</span>
              <b style={{ color: 'var(--ink-bright)', fontWeight: 500 }}>{i.title}</b>
              <span className="faint" style={{ marginLeft: 'auto', fontSize: 10 }} title="the model's own confidence in this finding">
                confidence {Math.round(i.confidence * 100)}%
              </span>
              <button className="act" disabled={busy === i.id} onClick={() => dismiss(i.id)} title="permanent — this will never be raised again">
                dismiss
              </button>
            </div>
            <div className="dim" style={{ fontSize: 12, marginBottom: 8, maxWidth: '90ch' }}>{i.detail}</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {i.evidence.map((e) => (
                <span key={e.path + e.symbol} className="hash">
                  {e.path}{e.symbol ? `#${e.symbol}` : ''}
                </span>
              ))}
            </div>
          </div>
        ))
      )}

      {closed.length > 0 && (
        <div className="card">
          <h3>Resolved &amp; dismissed — {closed.length}</h3>
          <table>
            <tbody>
              {closed.map((i) => (
                <tr key={i.id}>
                  <td><span className="badge" data-k={i.severity}>{i.severity}</span></td>
                  <td className="dim">{i.title}</td>
                  <td className="faint" style={{ width: 90 }}>{i.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const sevVar = (s: string) => (s === 'critical' ? 'crit' : s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'line-bright');
