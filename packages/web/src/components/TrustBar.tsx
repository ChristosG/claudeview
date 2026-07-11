export interface Trust {
  fresh: number;
  stale: number;
  broken: number;
  contradicted: number;
  unanchored: number;
}

/**
 * The Trust Bar.
 *
 * This is the whole product in one strip of pixels, and it is on every screen for a reason:
 * the failure this tool exists to prevent is *being told something confidently that stopped
 * being true weeks ago*. A "Trust" tab you have to remember to click would not prevent that,
 * because the moment you needed it is the moment you didn't think to look.
 *
 * So the state of the project's honesty is ambient. It is in the chrome. If anything in here
 * is lying to you, the entire window glows amber and this bar pulses — and you find out
 * before you read a single claim, not after you've acted on one.
 *
 * The hatched segment matters too: claims that cite no code at all can never be verified, so
 * they are shown as *unknown*, never as fine. Silence about a gap is how a tool starts lying.
 */
export function TrustBar({ trust, connected, onSync, syncing }: {
  trust?: Trust;
  connected: boolean;
  onSync: () => void;
  syncing: boolean;
}) {
  const t = trust ?? { fresh: 0, stale: 0, broken: 0, contradicted: 0, unanchored: 0 };
  const total = t.fresh + t.stale + t.broken + t.contradicted + t.unanchored;

  const segs: Array<[keyof Trust, number, string]> = [
    ['fresh', t.fresh, 'verified against the code'],
    ['stale', t.stale, 'the code beneath it changed'],
    ['broken', t.broken, 'the code it describes is gone'],
    ['contradicted', t.contradicted, 'the code now refutes it'],
    ['unanchored', t.unanchored, 'cites no code — unverifiable'],
  ];

  return (
    <div className="trustbar">
      <span className="label">Trust</span>

      <div className="segments" role="img" aria-label="project trust state">
        {total === 0 ? (
          <i data-k="unanchored" style={{ flex: 1 }} title="nothing has been claimed yet" />
        ) : (
          segs.filter(([, n]) => n > 0).map(([k, n, why]) => (
            <i key={k} data-k={k} style={{ flex: n }} title={`${n} ${k} — ${why}`} />
          ))
        )}
      </div>

      <div className="tallies">
        {segs.filter(([, n]) => n > 0).map(([k, n]) => (
          <span className="tally" key={k} title={String(k)}>
            <span className="dot" style={{ background: `var(--${dotVar(k)})` }} />
            <b>{n}</b> {k}
          </span>
        ))}
        {total === 0 && <span className="tally faint">no claims recorded yet</span>}
      </div>

      <button className="act" onClick={onSync} disabled={syncing}>
        {syncing ? 'syncing…' : 'sync'}
      </button>

      <span className="live" data-stale={connected ? '0' : '1'} title={connected ? 'watching transcripts live' : 'not connected'}>
        <span className="pip" />
        {connected ? 'LIVE' : 'OFFLINE'}
      </span>
    </div>
  );
}

function dotVar(k: keyof Trust): string {
  return k === 'unanchored' ? 'unknown' : k === 'fresh' ? 'ok' : k === 'stale' ? 'warn' : k === 'broken' ? 'bad' : 'crit';
}

/** The worst thing currently true about the project — drives the whole-window edge glow. */
export function worstOf(t?: Trust): string {
  if (!t) return 'ok';
  if (t.contradicted) return 'contradicted';
  if (t.broken) return 'broken';
  if (t.stale) return 'stale';
  return 'ok';
}
