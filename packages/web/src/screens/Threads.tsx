import { useLive } from '../lib/api';

interface Thread {
  id: string; title: string; detail: string;
  status: 'open' | 'exploring' | 'done' | 'abandoned';
  abandonReason?: string;
  origin: { sessionId?: string; ts?: string; quote?: string };
}
interface Decision {
  id: string; title: string; choice: string; rationale: string;
  alternatives: string[]; status: 'active' | 'superseded'; supersedes?: string;
}
interface Session {
  id: string; sessionId: string; startedAt: string; summary?: string;
  gitBranch?: string; events: number;
  stats: { prompts: number; edits: number; bash: number };
}

/**
 * Threads & Journal — the idea graveyard, exhumed.
 *
 * Mid-session, someone says "we should try X sometime". It is a good idea. It is never
 * written down, the session ends, and it is gone — not rejected, just *lost*. Multiply by a
 * project a week and the compounding loss is enormous.
 *
 * These are mined out of the transcripts and resurfaced at the start of every future session,
 * so a good idea has to be *decided against* rather than merely forgotten. Note that an
 * abandoned thread must carry a reason: an idea killed without a recorded reason gets
 * re-proposed forever.
 */
export function Threads({ revision }: { revision: number }) {
  const { data: threads } = useLive<Thread[]>('/api/threads', revision);
  const { data: decisions } = useLive<Decision[]>('/api/decisions', revision);
  const { data: sessions } = useLive<Session[]>('/api/journal', revision);

  const open = (threads ?? []).filter((t) => t.status === 'open' || t.status === 'exploring');
  const dead = (threads ?? []).filter((t) => t.status === 'done' || t.status === 'abandoned');
  const active = (decisions ?? []).filter((d) => d.status === 'active');
  const superseded = (decisions ?? []).filter((d) => d.status === 'superseded');

  return (
    <>
      <header>
        <h2>Threads &amp; Journal</h2>
        <p>Ideas raised and never pursued, decisions in force, and the running record of what happened.</p>
      </header>

      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Open threads — raised, never explored</h3>
        {open.length === 0 ? (
          <div className="faint" style={{ padding: '10px 0' }}>
            Nothing outstanding. (Ideas get mined out of your transcripts automatically at session end.)
          </div>
        ) : (
          open.map((t) => (
            <div key={t.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b style={{ color: 'var(--ink-bright)', fontWeight: 500 }}>{t.title}</b>
                <span className="badge" data-k={t.status === 'exploring' ? 'medium' : 'low'} style={{ marginLeft: 'auto' }}>{t.status}</span>
              </div>
              <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>{t.detail}</div>
              {t.origin.quote && (
                <div className="faint" style={{ fontSize: 10, marginTop: 5, borderLeft: '2px solid var(--line-bright)', paddingLeft: 8, fontStyle: 'italic' }}>
                  “{t.origin.quote}”{t.origin.ts ? ` — ${t.origin.ts.slice(0, 10)}` : ''}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="grid g2" style={{ marginBottom: 12 }}>
        <div className="card">
          <h3>Decisions in force</h3>
          {active.length === 0 ? (
            <div className="faint" style={{ padding: '10px 0' }}>none recorded</div>
          ) : (
            active.map((d) => (
              <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <b style={{ color: 'var(--ink-bright)', fontWeight: 500 }}>{d.title}</b>
                <div style={{ fontSize: 11, marginTop: 3 }}>
                  <span style={{ color: 'var(--acc)' }}>{d.choice}</span>
                </div>
                <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>{d.rationale}</div>
                {d.alternatives.length > 0 && (
                  <div className="faint" style={{ fontSize: 10, marginTop: 4 }}>
                    rejected: {d.alternatives.join(' · ')}
                  </div>
                )}
              </div>
            ))
          )}
          {/* Superseded decisions are kept, not deleted — knowing what we USED to believe, and
              that we changed our minds, is exactly the context that gets lost otherwise. */}
          {superseded.length > 0 && (
            <div className="faint" style={{ fontSize: 10, marginTop: 8 }}>
              {superseded.length} superseded and no longer in force (kept for history).
            </div>
          )}
        </div>

        <div className="card">
          <h3>Settled &amp; abandoned</h3>
          {dead.length === 0 ? (
            <div className="faint" style={{ padding: '10px 0' }}>nothing yet</div>
          ) : (
            dead.map((t) => (
              <div key={t.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <span className="dim">{t.title}</span>
                <span className="badge" data-k={t.status === 'done' ? 'fresh' : 'low'} style={{ marginLeft: 8 }}>{t.status}</span>
                {t.abandonReason && <div className="faint" style={{ fontSize: 10, marginTop: 2 }}>{t.abandonReason}</div>}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <h3>Journal — {sessions?.length ?? 0} sessions</h3>
        {!sessions || sessions.length === 0 ? (
          <div className="faint" style={{ padding: '10px 0' }}>
            No session summaries written yet. These are generated at session end — run <code>/cv-drain</code> to
            process the queue.
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>when</th><th>branch</th><th style={{ textAlign: 'right' }}>events</th><th>summary</th></tr>
            </thead>
            <tbody>
              {sessions.slice(0, 25).map((s) => (
                <tr key={s.id}>
                  <td className="faint">{s.startedAt?.slice(0, 16).replace('T', ' ')}</td>
                  <td className="dim">{s.gitBranch ?? '—'}</td>
                  <td className="num dim">{s.events}</td>
                  <td className={s.summary ? 'dim' : 'faint'}>{s.summary ?? <i>not summarised yet</i>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
