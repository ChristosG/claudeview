import { useLive } from '../lib/api';

interface Run { id: string; index: number; params: Record<string, unknown>; metrics: Record<string, number>; notes?: string }
interface Experiment {
  id: string; title: string; hypothesis: string; metric: string;
  verdict: 'open' | 'win' | 'loss' | 'inconclusive';
  judgement?: string; action?: string; runs: Run[];
}

/**
 * The Lab — the results CSV, except it is alive, historical, and queryable by Claude.
 *
 * The most valuable rows in here are the LOSSES. A recorded win tells you what to keep; a
 * recorded loss is the only thing standing between you and cheerfully re-running the same
 * dead end in three weeks, having completely forgotten you already paid for that answer.
 *
 * That is why losses are rendered as loudly as wins, and why the brief injected at session
 * start leads with "already tried, did NOT work". Negative results are the expensive ones.
 */
export function Lab({ revision }: { revision: number }) {
  const { data } = useLive<Experiment[]>('/api/experiments', revision);
  if (!data) return <div className="empty">loading…</div>;

  if (data.length === 0) {
    return (
      <>
        <Head />
        <div className="empty">
          <b>No experiments recorded yet.</b>
          When you loop on something — try a config, judge the result, adjust, repeat — ask Claude to record it with{' '}
          <code>cv_experiment</code> and <code>cv_run</code>. Every iteration lands here, and the losses come back to
          warn you later.
        </div>
      </>
    );
  }

  const losses = data.filter((e) => e.verdict === 'loss');

  return (
    <>
      <Head />

      {/* Dead ends, first and loudest. This is the section that saves real money. */}
      {losses.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--bad)' }}>
          <h3 style={{ color: 'var(--bad)' }}>Dead ends — do not re-run these</h3>
          {losses.map((e) => (
            <div key={e.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <b style={{ color: 'var(--ink-bright)', fontWeight: 500 }}>{e.title}</b>
              {e.judgement && <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{e.judgement}</div>}
            </div>
          ))}
        </div>
      )}

      {data.map((e) => <ExperimentCard key={e.id} e={e} />)}
    </>
  );
}

function Head() {
  return (
    <header>
      <h2>Lab</h2>
      <p>
        Hypothesis → runs → verdict. Every iteration you and Claude ran, with what was varied and what came out — kept
        so that a question already answered stays answered.
      </p>
    </header>
  );
}

function ExperimentCard({ e }: { e: Experiment }) {
  const paramKeys = [...new Set(e.runs.flatMap((r) => Object.keys(r.params)))];
  const metricKeys = [...new Set(e.runs.flatMap((r) => Object.keys(r.metrics)))];
  const series = e.runs.map((r) => r.metrics[e.metric]).filter((v): v is number => typeof v === 'number');
  const best = series.length ? Math.max(...series) : undefined;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--display)', fontSize: 13, letterSpacing: '.06em', color: 'var(--ink-bright)', textTransform: 'uppercase' }}>
          {e.title}
        </span>
        <span className="faint" style={{ fontSize: 10 }}>{e.id}</span>
        <span className="badge" data-k={verdictKey(e.verdict)} style={{ marginLeft: 'auto' }}>{e.verdict}</span>
      </div>

      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        <b className="faint">hypothesis</b> {e.hypothesis} · <b className="faint">metric</b>{' '}
        <span style={{ color: 'var(--acc)' }}>{e.metric}</span>
      </div>

      {series.length > 1 && (
        <div className="spark" style={{ marginBottom: 10, height: 34 }}>
          {series.map((v, i) => (
            <i
              key={i}
              style={{ height: `${(v / Math.max(...series)) * 100}%`, background: v === best ? 'var(--ok)' : 'var(--acc)' }}
              title={`run ${i}: ${e.metric} = ${v}`}
            />
          ))}
        </div>
      )}

      {e.runs.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {paramKeys.map((k) => <th key={k}>{k}</th>)}
                {metricKeys.map((k) => <th key={k} style={{ textAlign: 'right', color: k === e.metric ? 'var(--acc)' : undefined }}>{k}</th>)}
                <th>notes</th>
              </tr>
            </thead>
            <tbody>
              {e.runs.map((r) => (
                <tr key={r.id}>
                  <td className="faint">{r.index}</td>
                  {paramKeys.map((k) => <td key={k} className="dim">{fmt(r.params[k])}</td>)}
                  {metricKeys.map((k) => (
                    <td key={k} className="num" style={{ color: k === e.metric && r.metrics[k] === best ? 'var(--ok)' : undefined }}>
                      {r.metrics[k] ?? '—'}
                    </td>
                  ))}
                  <td className="faint" style={{ fontSize: 11 }}>{r.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {e.judgement && (
        <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--line)', fontSize: 11 }}>
          <b className="faint">judgement</b> <span className="dim">{e.judgement}</span>
          {e.action && <div style={{ marginTop: 4 }}><b className="faint">action</b> <span className="dim">{e.action}</span></div>}
        </div>
      )}

      {e.verdict === 'open' && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--warn)' }}>
          Still open after {e.runs.length} run{e.runs.length === 1 ? '' : 's'} — no verdict was ever recorded. This is
          the state in which experiments quietly get abandoned and then repeated.
        </div>
      )}
    </div>
  );
}

const verdictKey = (v: string) => (v === 'win' ? 'fresh' : v === 'loss' ? 'broken' : v === 'open' ? 'medium' : 'low');
const fmt = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—'));
