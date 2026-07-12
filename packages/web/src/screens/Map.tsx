import { useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, BackgroundVariant } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLive, post, type Freshness } from '../lib/api';

interface Anchor { path: string; symbol?: string; hash: string }
interface Step { id: string; label: string; description: string; anchors: Anchor[]; next: string[]; freshness: Freshness }
interface Flow { id: string; name: string; summary: string; steps: Step[]; freshness: Freshness }
interface Component { id: string; path: string; language: string; loc: number; purpose?: string }

/**
 * The Map.
 *
 * Two layers, and the top one is the point:
 *
 *   STRUCTURAL — every module, derived from the AST. True, complete, and almost unreadable.
 *                Nobody wants to look at 400 nodes of utils importing config.
 *
 *   FLOW       — the conceptual pipeline a human actually thinks in:
 *                query → preprocess → embed → BM25 → rerank → LLM.
 *                Authored by Claude, but every box is ANCHORED to the real code beneath it.
 *
 * The anchoring is what makes this different from every architecture diagram ever drawn. A
 * hand-made diagram is a snapshot of an intention, and it starts lying the moment someone
 * touches the code — silently, for months. This one carries the content hash of the code
 * each box describes, so when that code moves, the box turns amber and says so.
 *
 * The hash chip on each node is that mechanism, made literal and visible.
 */
export function Map({ revision }: { revision: number }) {
  const { data: flows } = useLive<Flow[]>('/api/flows', revision);
  const { data: comps } = useLive<Component[]>('/api/components', revision);
  const [queued, setQueued] = useState(false);

  if (!flows) return <div className="empty">loading…</div>;

  return (
    <>
      <header>
        <h2>Map</h2>
        <p>
          Pipelines authored by Claude, with every step pinned to the code that implements it. A step whose code has
          changed flags itself — this diagram cannot rot silently the way a hand-drawn one does.
        </p>
      </header>

      {flows.length === 0 ? (
        <div className="empty">
          <b>No flows authored yet.</b>
          The structural graph exists ({comps?.length ?? 0} modules indexed), but nobody has explained what any of it
          <i> does</i> — and only a model can do that.
          <div style={{ marginTop: 14 }}>
            <button
              className="act"
              disabled={queued}
              onClick={async () => { await post('/api/jobs', { type: 'author-flows' }); setQueued(true); }}
            >
              {queued ? 'queued — run /cv-drain in Claude' : 'queue flow authoring'}
            </button>
          </div>
          <div className="faint" style={{ marginTop: 10, fontSize: 10, maxWidth: '48ch', margin: '10px auto 0' }}>
            The dashboard holds no API key and cannot run a model. It can only ask — the work runs on your own Claude
            subscription, inside your session.
          </div>
        </div>
      ) : (
        flows.map((f) => <FlowCanvas key={f.id} flow={f} />)
      )}

      {comps && comps.length > 0 && (
        <div className="card">
          <h3>Structural index — {comps.length} modules</h3>
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>module</th><th>lang</th><th style={{ textAlign: 'right' }}>loc</th><th>purpose</th></tr>
              </thead>
              <tbody>
                {comps.slice(0, 40).map((c) => (
                  <tr key={c.id}>
                    <td className="path">{c.path}</td>
                    <td className="faint">{c.language}</td>
                    <td className="num dim">{c.loc}</td>
                    <td className={c.purpose ? 'dim' : 'faint'}>
                      {c.purpose ?? <i>not yet explained — queue an annotate job</i>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function FlowCanvas({ flow }: { flow: Flow }) {
  const [expanded, setExpanded] = useState(false);
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = flow.steps.map((s, i) => ({
      id: s.id,
      position: { x: i * 300, y: 0 },
      data: { step: s },
      type: 'cv',
      draggable: true,
    }));
    const edges: Edge[] = flow.steps.flatMap((s) =>
      s.next.map((n) => ({
        id: `${s.id}->${n}`,
        source: s.id,
        target: n,
        animated: s.freshness !== 'fresh',
      })),
    );
    return { nodes, edges };
  }, [flow]);

  const bad = flow.steps.filter((s) => s.freshness !== 'fresh');

  return (
    <div className="card" style={{ padding: 0, borderColor: flow.freshness !== 'fresh' ? 'var(--warn)' : undefined }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 14, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-bright)' }}>
            {flow.name}
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>{flow.summary}</div>
        </div>
        <span className="badge" data-k={flow.freshness} style={{ marginLeft: 'auto' }}>{flow.freshness}</span>
        <button className="act" onClick={() => setExpanded((v) => !v)} title="give this map the whole window">
          {expanded ? 'collapse' : 'expand'}
        </button>
      </div>

      {/* When a step is stale we say exactly WHICH one and why. "Something in this diagram is
          wrong" is anxiety; "the BM25 box no longer matches its code" is a next action. */}
      {bad.length > 0 && (
        <div style={{ padding: '9px 14px', background: 'rgba(246,167,35,.07)', borderBottom: '1px solid var(--warn)', fontSize: 11, color: 'var(--warn)' }}>
          {bad.length} step{bad.length > 1 ? 's have' : ' has'} drifted from the code:{' '}
          <b>{bad.map((s) => s.label).join(', ')}</b> — the diagram may no longer be telling you the truth here.
        </div>
      )}

      {/* Remounting on expand re-runs fitView against the new height — otherwise the graph
          stays at its old zoom and the extra space is just empty background. */}
      <div className="flowmap" data-expanded={expanded ? '1' : '0'}>
        <ReactFlow
          key={expanded ? 'wide' : 'normal'}
          nodes={nodes}
          edges={edges}
          nodeTypes={{ cv: StepNode }}
          fitView
          /* A wide, short pipeline is width-bound: fitView shrinks it to squeeze every step in,
             and a taller canvas alone can't undo that. maxZoom 1 stops a short flow from being
             blown up absurdly; the controls let you go past it and read one step at 100%. */
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#1c2530" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

function StepNode({ data }: { data: { step: Step } }) {
  const s = data.step;
  return (
    <div className="flownode" data-k={s.freshness}>
      <Handle type="target" position={Position.Left} />
      <div className="lbl">{s.label}</div>
      <div className="desc">{s.description}</div>
      <div className="anchors">
        {s.anchors.map((a) => (
          <span
            key={a.path + a.symbol}
            className="hash"
            data-k={s.freshness}
            title={`${a.path}${a.symbol ? `#${a.symbol}` : ''}\npinned hash: ${a.hash}`}
          >
            {a.symbol ?? a.path.split('/').pop()} · {a.hash.slice(0, 6)}
          </span>
        ))}
        {s.anchors.length === 0 && <span className="hash" title="cites no code — this step can never be verified">unanchored</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
