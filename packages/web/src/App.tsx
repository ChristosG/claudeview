import { useEffect, useState } from 'react';
import { useLive, useStream, post } from './lib/api';
import { TrustBar, worstOf, type Trust } from './components/TrustBar';
import { Pulse } from './screens/Pulse';
import { Map as MapScreen } from './screens/Map';
import { Lab } from './screens/Lab';
import { Insights } from './screens/Insights';
import { Threads } from './screens/Threads';
import { TrustScreen } from './screens/TrustScreen';

interface PulseData {
  repo: string;
  trust: Trust;
  counts: Record<string, number>;
  [k: string]: unknown;
}

const SCREENS = [
  { id: 'pulse', label: 'Pulse', hint: 'what changed' },
  { id: 'map', label: 'Map', hint: 'flows & structure' },
  { id: 'lab', label: 'Lab', hint: 'experiments' },
  { id: 'insights', label: 'Insights', hint: 'critique' },
  { id: 'threads', label: 'Threads', hint: 'ideas & journal' },
  { id: 'trust', label: 'Trust', hint: 'what is no longer true' },
] as const;

type ScreenId = (typeof SCREENS)[number]['id'];

export default function App() {
  const { revision, connected } = useStream();
  const { data } = useLive<PulseData>('/api/pulse', revision);
  const [screen, setScreen] = useState<ScreenId>('pulse');
  const [syncing, setSyncing] = useState(false);

  const trust = data?.trust;
  const worst = worstOf(trust);

  // The window itself carries the verdict. You cannot read a claim in this app without
  // first having seen whether the app currently trusts itself.
  useEffect(() => {
    document.getElementById('root')?.setAttribute('data-trust', worst);
  }, [worst]);

  const sync = async () => {
    setSyncing(true);
    try {
      await post('/api/sync');
    } finally {
      setSyncing(false);
    }
  };

  const badge: Record<ScreenId, number | undefined> = {
    pulse: undefined,
    map: undefined,
    lab: data?.counts.openExperiments,
    insights: data?.counts.openInsights,
    threads: data?.counts.openThreads,
    trust: (trust?.stale ?? 0) + (trust?.broken ?? 0) + (trust?.contradicted ?? 0),
  };

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <h1>ClaudeView</h1>
          <div className="repo" title={data?.repo}>{data?.repo ?? '…'}</div>
        </div>
        <nav>
          {SCREENS.map((s) => (
            <button
              key={s.id}
              data-on={screen === s.id ? '1' : '0'}
              data-alert={s.id === 'trust' && (badge.trust ?? 0) > 0 ? '1' : '0'}
              onClick={() => setScreen(s.id)}
              title={s.hint}
            >
              {s.label}
              {badge[s.id] ? <span className="n">{badge[s.id]}</span> : null}
            </button>
          ))}
        </nav>
      </aside>

      <div className="main">
        <TrustBar trust={trust} connected={connected} onSync={sync} syncing={syncing} />
        <div className="content" key={screen}>
          {screen === 'pulse' && <Pulse revision={revision} />}
          {screen === 'map' && <MapScreen revision={revision} />}
          {screen === 'lab' && <Lab revision={revision} />}
          {screen === 'insights' && <Insights revision={revision} />}
          {screen === 'threads' && <Threads revision={revision} />}
          {screen === 'trust' && <TrustScreen revision={revision} />}
        </div>
      </div>
    </div>
  );
}
