import { useLive } from '../lib/api';

interface PulseData {
  repo: string;
  counts: Record<string, number>;
  churn: { added: number; removed: number };
  activity: { day: string; n: number }[];
  hot: { path: string; edits: number }[];
  foreign: { sha: string; author: string; subject: string }[];
}

/**
 * Pulse — the ten-second answer to "what happened while I was gone?"
 *
 * Everything here is Tier-1: observed, mechanical, free. No model produced any of it, which
 * is why it can be trusted without qualification — and why it's the screen that still works
 * on day one, before a single token has been spent.
 */
export function Pulse({ revision }: { revision: number }) {
  const { data } = useLive<PulseData>('/api/pulse', revision);
  if (!data) return <div className="empty">reading session history…</div>;

  const c = data.counts;
  const peak = Math.max(1, ...data.activity.map((a) => a.n));

  return (
    <>
      <header>
        <h2>Pulse</h2>
        <p>Everything on this screen is observed directly from your session transcripts, git, and the AST. No model wrote any of it, so none of it can be wrong.</p>
      </header>

      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Stat n={c.components} label="components" sub="indexed from the AST" />
        <Stat n={c.sessions} label="sessions" sub={`${c.prompts} prompts`} />
        <Stat n={c.subagents} label="subagents" sub="incl. workflow runs" />
        <Stat n={c.events} label="events" sub="tool calls & commits" />
      </div>

      <div className="grid g2" style={{ marginBottom: 12 }}>
        <div className="card">
          <h3>Activity — last 7 days</h3>
          {data.activity.length === 0 ? (
            <div className="faint" style={{ padding: '12px 0' }}>no activity in the last week</div>
          ) : (
            <>
              <div className="spark">
                {data.activity.map((a) => (
                  <i key={a.day} style={{ height: `${(a.n / peak) * 100}%` }} title={`${a.day}: ${a.n} events`} />
                ))}
              </div>
              <div className="faint" style={{ marginTop: 8, fontSize: 10 }}>
                {data.activity[0]?.day} → {data.activity[data.activity.length - 1]?.day} ·{' '}
                <span style={{ color: 'var(--ok)' }}>+{data.churn.added}</span>{' '}
                <span style={{ color: 'var(--bad)' }}>−{data.churn.removed}</span> lines all-time
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3>Where the work went</h3>
          {data.hot.length === 0 ? (
            <div className="faint" style={{ padding: '12px 0' }}>no edits recorded this week</div>
          ) : (
            <table>
              <tbody>
                {data.hot.map((h) => (
                  <tr key={h.path}>
                    <td className="path">{h.path}</td>
                    <td className="num dim" style={{ width: 60 }}>{h.edits} ×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Changes nobody can account for. The AST heals itself for free, but nothing here
          knows WHY these happened — and that is exactly what makes them dangerous. */}
      {data.foreign.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 12 }}>
          <h3 style={{ color: 'var(--warn)' }}>Changed without us watching</h3>
          <p className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
            These commits are not explained by any session we recorded — a teammate's push, a rebase, or an edit made
            outside Claude. The structural map has already re-derived itself, but the <i>intent</i> behind these is unknown.
          </p>
          <table>
            <tbody>
              {data.foreign.map((f) => (
                <tr key={f.sha}>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}><span className="hash">{f.sha}</span></td>
                  <td className="dim" style={{ width: 1, whiteSpace: 'nowrap' }}>{f.author}</td>
                  <td className="path" style={{ width: '100%' }}>{f.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid g4">
        <Mini n={c.decisions} label="decisions in force" />
        <Mini n={c.openExperiments} label="experiments open" warn={c.openExperiments > 0} />
        <Mini n={c.openThreads} label="ideas never explored" warn={c.openThreads > 0} />
        <Mini n={c.queuedJobs} label="jobs queued for an agent" />
      </div>
    </>
  );
}

function Stat({ n, label, sub }: { n: number; label: string; sub: string }) {
  return (
    <div className="card">
      <h3>{label}</h3>
      <div className="stat">{n.toLocaleString()}</div>
      <div className="faint" style={{ fontSize: 10, marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function Mini({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <div className="card">
      <div className="stat" style={{ fontSize: 22, color: warn && n > 0 ? 'var(--warn)' : undefined }}>{n}</div>
      <div className="faint" style={{ fontSize: 10, marginTop: 4 }}>{label}</div>
    </div>
  );
}
