import { useEffect, useState } from 'react';
import type { Decision, GameView, ObjectView, Response, Target, ObjectId } from '@commander/engine';
import { useUi } from '../state/ui.js';
import { playerName, targetLabel, objectName } from '../lib/format.js';
import { Card } from './Card.js';
import { ManaCost } from './ManaCost.js';
import type { CardHandlers } from './Battlefield.js';

interface Props {
  view: GameView;
  decision: Decision | null;
  respond: (r: Response) => void;
  handlers: CardHandlers;
}

type AnyDecision = Decision & { error?: string };

/** Floating bar above the hand: the prompt plus the primary buttons for the current decision. */
export function DecisionBar({ view, decision, respond }: Omit<Props, 'handlers'>) {
  const ui = useUi();
  const d = decision as AnyDecision | null;
  const waiting = !d && view.waitingOn;
  const mine = !!d;

  // Space = pass / confirm the primary action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !d) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      if (d.type === 'priority') respond({ type: 'pass' });
      else if (d.type === 'declareAttackers') respond({ type: 'attackers', attacks: Object.entries(ui.attacks).map(([a, t]) => ({ attacker: Number(a), target: t })) });
      else if (d.type === 'declareBlockers') respond({ type: 'blockers', blocks: ui.blocks });
      else if (d.type === 'mulligan') respond({ type: 'mulligan', keep: true });
      else if (d.type === 'payMana') respond({ type: 'payMana', tap: [], auto: true });
      else if (d.type === 'yesNo') respond({ type: 'yesNo', value: true });
      else if (d.type === 'manualTrigger') respond({ type: 'manualDone' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d, ui.attacks, ui.blocks, respond]);

  if (view.over) return null;

  const body = (() => {
    if (!d) {
      return (
        <>
          <span className="prompt muted">{waiting ? `Waiting on ${playerName(view, view.waitingOn)}…` : 'Waiting…'}</span>
        </>
      );
    }
    switch (d.type) {
      case 'priority':
        return (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="prompt">{d.prompt}</div>
              <div className="sub">
                {d.playableCards.length} playable · {d.activatableAbilities.length} abilit{d.activatableAbilities.length === 1 ? 'y' : 'ies'}
                {d.canPlayLand ? ' · land drop available' : ''}
              </div>
            </div>
            <button className="pass gold pulse" onClick={() => respond({ type: 'pass' })} title="Pass priority (Space)">
              {view.stack.length ? 'Pass (resolve)' : 'Pass'} <span className="kbd">␣</span>
            </button>
          </>
        );
      case 'chooseTargets': {
        const ok = d.slots.every((s, i) => (ui.targets[i]?.length ?? 0) >= s.min && (ui.targets[i]?.length ?? 0) <= s.max);
        return (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="prompt">{d.prompt}</div>
              <div className="row wrap" style={{ gap: 4 }}>
                {d.slots.map((s, i) => (
                  <button key={i} className={`xs ${i === ui.slot ? 'primary' : ''}`} onClick={() => ui.setSlot(i)} title={s.legal.map((t) => targetLabel(view, t)).join(', ')}>
                    {s.description || `Target ${i + 1}`} {ui.targets[i]?.length ?? 0}/{s.max}
                    {ui.targets[i]?.length ? `: ${ui.targets[i].map((t) => targetLabel(view, t)).join(', ')}` : ''}
                  </button>
                ))}
              </div>
            </div>
            <button className="primary" disabled={!ok} onClick={() => respond({ type: 'targets', targets: d.slots.map((_, i) => ui.targets[i] ?? []) })}>
              Confirm
            </button>
            <button onClick={() => respond({ type: 'cancel' })}>Cancel</button>
          </>
        );
      }
      case 'declareAttackers': {
        const n = Object.keys(ui.attacks).length;
        const defenders = Array.from(new Set(d.candidates.flatMap((c) => c.canAttack)));
        const attackAll = () => {
          for (const c of d.candidates) {
            const target = ui.defender && c.canAttack.includes(ui.defender) ? ui.defender : c.canAttack[0];
            if (target !== undefined && ui.attacks[c.id] === undefined) ui.toggleAttacker(c.id, target);
          }
        };
        return (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="prompt">Declare attackers — {n} selected</div>
              <div className="row wrap" style={{ gap: 4 }}>
                <span className="sub">Attack:</span>
                {defenders.map((t) => (
                  <button key={String(t)} className={`xs ${ui.defender === t ? 'primary' : ''}`} onClick={() => ui.setDefender(t)}>
                    {typeof t === 'string' ? playerName(view, t) : objectName(view, t)}
                  </button>
                ))}
                {defenders.length > 1 && <span className="sub">(or click an opponent)</span>}
              </div>
            </div>
            <button onClick={attackAll} disabled={d.candidates.length === 0}>
              All
            </button>
            <button className="primary" onClick={() => respond({ type: 'attackers', attacks: Object.entries(ui.attacks).map(([a, t]) => ({ attacker: Number(a), target: t })) })}>
              {n ? `Attack with ${n}` : 'No attacks'} <span className="kbd">␣</span>
            </button>
          </>
        );
      }
      case 'declareBlockers':
        return (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="prompt">Declare blockers — {ui.blocker !== null ? `now click an attacker for ${objectName(view, ui.blocker)}` : 'click a blocker, then an attacker'}</div>
              <div className="row wrap" style={{ gap: 4 }}>
                {ui.blocks.map((b) => (
                  <button key={b.blocker} className="xs" onClick={() => ui.removeBlock(b.blocker)} title="Remove block">
                    {objectName(view, b.blocker)} ⟶ {objectName(view, b.attacker)} ✕
                  </button>
                ))}
                {ui.blocks.length === 0 && <span className="sub">{d.candidates.length} potential blocker(s), {d.attackers.length} attacker(s)</span>}
              </div>
            </div>
            <button className="primary" onClick={() => respond({ type: 'blockers', blocks: ui.blocks })}>
              {ui.blocks.length ? `Block with ${ui.blocks.length}` : 'No blocks'} <span className="kbd">␣</span>
            </button>
          </>
        );
      case 'mulligan':
        return (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="prompt">{d.prompt}</div>
              <div className="sub">Mulligans taken: {d.mulligansTaken}. Your hand is shown below.</div>
            </div>
            <button className="primary" onClick={() => respond({ type: 'mulligan', keep: true })}>
              Keep <span className="kbd">␣</span>
            </button>
            <button onClick={() => respond({ type: 'mulligan', keep: false })}>Mulligan</button>
          </>
        );
      case 'yesNo':
        return (
          <>
            <div className="prompt">{d.prompt}</div>
            <button className="primary" onClick={() => respond({ type: 'yesNo', value: true })}>
              {d.yesLabel ?? 'Yes'}
            </button>
            <button onClick={() => respond({ type: 'yesNo', value: false })}>{d.noLabel ?? 'No'}</button>
          </>
        );
      case 'payMana':
        return <PayManaBar view={view} d={d} respond={respond} />;
      case 'chooseNumber':
        return <NumberBar d={d} respond={respond} />;
      case 'manualTrigger':
        return (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="prompt">Manual trigger: {objectName(view, d.objectId)}</div>
              <div className="sub">Resolve it by hand, then press Done.</div>
            </div>
            <button className="primary" onClick={() => respond({ type: 'manualDone' })}>
              Done <span className="kbd">␣</span>
            </button>
          </>
        );
      default:
        return <div className="prompt">{(d as { prompt?: string }).prompt ?? 'Your decision'}</div>;
    }
  })();

  return (
    <div className={`decision-bar ${mine ? 'mine' : ''}`}>
      {body}
      {d?.error && <span className="error">{d.error}</span>}
    </div>
  );
}

function PayManaBar({ view, d, respond }: { view: GameView; d: Extract<Decision, { type: 'payMana' }>; respond: (r: Response) => void }) {
  const [tap, setTap] = useState<ObjectId[]>(d.suggestion?.tap ?? []);
  useEffect(() => setTap(d.suggestion?.tap ?? []), [d.id, d.suggestion]);
  return (
    <>
      <div style={{ minWidth: 0 }}>
        <div className="prompt">
          Pay <ManaCost cost={d.cost} /> <span className="muted small">{d.cost}</span>
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          {d.sources.slice(0, 12).map((s) => (
            <button key={s.id} className={`xs ${tap.includes(s.id) ? 'primary' : ''}`} onClick={() => setTap((t) => (t.includes(s.id) ? t.filter((x) => x !== s.id) : [...t, s.id]))} title={s.produces.map((p) => p.join('/')).join(', ')}>
              {objectName(view, s.id)}
            </button>
          ))}
          {d.sources.length > 12 && <span className="sub">+{d.sources.length - 12} more</span>}
        </div>
      </div>
      <button className="primary gold" onClick={() => respond({ type: 'payMana', tap: [], auto: true })}>
        Auto-pay <span className="kbd">␣</span>
      </button>
      <button disabled={!tap.length} onClick={() => respond({ type: 'payMana', tap, auto: false })}>
        Pay with selected
      </button>
      <button onClick={() => respond({ type: 'cancel' })}>Cancel</button>
    </>
  );
}

function NumberBar({ d, respond }: { d: Extract<Decision, { type: 'chooseNumber' }>; respond: (r: Response) => void }) {
  const [v, setV] = useState(d.min);
  useEffect(() => setV(Math.min(d.max, Math.max(d.min, 0))), [d.id, d.min, d.max]);
  return (
    <>
      <div className="prompt">{d.prompt}</div>
      <input type="number" min={d.min} max={d.max} value={v} style={{ width: 80 }} onChange={(e) => setV(Number(e.target.value))} autoFocus />
      <span className="sub">
        {d.min}–{d.max}
      </span>
      <button className="primary" disabled={v < d.min || v > d.max || !Number.isInteger(v)} onClick={() => respond({ type: 'number', value: v })}>
        OK
      </button>
    </>
  );
}

/** Decisions that need more room than the bar: rendered as a dialog (pass-through backdrop for object choices). */
export function DecisionModal({ view, decision, respond, handlers }: Props) {
  const ui = useUi();
  const d = decision as AnyDecision | null;
  if (!d) return null;
  switch (d.type) {
    case 'chooseOption':
      return <ChooseOptionModal d={d} respond={respond} />;
    case 'chooseObjects': {
      const ok = ui.objects.length >= d.min && ui.objects.length <= d.max;
      return (
        <div className="overlay transparent">
          <div className="modal" style={{ position: 'absolute', top: 60, right: 312 }}>
            <h2>{d.prompt}</h2>
            <div className="muted small">
              Choose {d.min === d.max ? d.min : `${d.min}–${d.max}`} · {ui.objects.length} selected
            </div>
            <div className="card-grid small">
              {d.candidates.map((id) => {
                const o = view.objects[id];
                if (!o) return <span key={id} className="badge">{`#${id}`}</span>;
                return (
                  <div key={id} className="card-wrap">
                    <Card obj={o} legal={!ui.objects.includes(id)} selected={ui.objects.includes(id)} noRotate onClick={() => ui.toggleObject(id, d.max)} onHover={handlers.onHover} onContextMenu={handlers.onContextMenu} />
                  </div>
                );
              })}
            </div>
            <div className="actions">
              {d.min === 0 && <button onClick={() => respond({ type: 'objects', ids: [] })}>None</button>}
              <button className="primary" disabled={!ok} onClick={() => respond({ type: 'objects', ids: ui.objects })}>
                Confirm
              </button>
            </div>
            {d.error && <div className="error">{d.error}</div>}
          </div>
        </div>
      );
    }
    case 'orderObjects':
      return <OrderModal view={view} d={d} respond={respond} handlers={handlers} />;
    case 'distribute':
      return <DistributeModal view={view} d={d} respond={respond} />;
    case 'manualTrigger': {
      const o = view.objects[d.objectId];
      return (
        <div className="overlay transparent">
          <div className="modal" style={{ position: 'absolute', top: 60, right: 312, maxWidth: 380 }}>
            <h2>Manual trigger</h2>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              {o && (
                <div className="card-wrap" style={{ ['--cw' as string]: '110px' }}>
                  <Card obj={o} noRotate onHover={handlers.onHover} />
                </div>
              )}
              <div>
                <div style={{ fontWeight: 600 }}>{o?.name ?? `#${d.objectId}`}</div>
                <p style={{ margin: '6px 0' }}>{d.text}</p>
                <p className="muted small">The engine could not automate this trigger. Use the manual tools (right-click cards and players) to apply it, then press Done.</p>
              </div>
            </div>
            <div className="actions">
              <button className="primary" onClick={() => respond({ type: 'manualDone' })}>
                Done
              </button>
            </div>
          </div>
        </div>
      );
    }
    case 'priority':
    case 'chooseTargets':
    case 'yesNo':
    case 'declareAttackers':
    case 'declareBlockers':
    case 'payMana':
    case 'chooseNumber':
    case 'mulligan':
      return null;
    default:
      return <UnknownDecisionModal d={d} respond={respond} />;
  }
}

function ChooseOptionModal({ d, respond }: { d: Extract<Decision, { type: 'chooseOption' }> & { error?: string }; respond: (r: Response) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => setSel([]), [d.id]);
  const single = d.max === 1;
  const toggle = (id: string) => {
    if (single) return respond({ type: 'options', ids: [id] });
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= d.max ? s : [...s, id]));
  };
  return (
    <div className="overlay">
      <div className="modal">
        <h2>{d.prompt}</h2>
        {!single && (
          <div className="muted small" style={{ marginBottom: 8 }}>
            Choose {d.min === d.max ? d.min : `${d.min}–${d.max}`}
          </div>
        )}
        <div className="option-list">
          {d.options.map((o) => (
            <button key={o.id} className={`option ${sel.includes(o.id) ? 'selected' : ''}`} disabled={o.disabled} onClick={() => toggle(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        {!single && (
          <div className="actions">
            <button className="primary" disabled={sel.length < d.min || sel.length > d.max} onClick={() => respond({ type: 'options', ids: sel })}>
              Confirm
            </button>
          </div>
        )}
        {d.error && <div className="error">{d.error}</div>}
      </div>
    </div>
  );
}

function OrderModal({ view, d, respond, handlers }: { view: GameView; d: Extract<Decision, { type: 'orderObjects' }> & { error?: string }; respond: (r: Response) => void; handlers: CardHandlers }) {
  const initial = d.items ? d.items.map((i) => i.id) : d.objectIds;
  const [order, setOrder] = useState<number[]>(initial);
  useEffect(() => setOrder(d.items ? d.items.map((i) => i.id) : d.objectIds), [d.id, d.items, d.objectIds]);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  const label = (id: number) => {
    if (d.items) return d.items.find((x) => x.id === id)?.text ?? `#${id}`;
    return objectName(view, id);
  };
  const hint: Record<string, string> = {
    triggers: 'First in the list resolves last (it goes on the stack first).',
    libraryTop: 'First in the list ends up on top of the library.',
    graveyard: 'Order for the graveyard.',
    blockers: 'Damage assignment order among blockers.',
    damageAssignment: 'Damage assignment order.',
  };
  return (
    <div className="overlay">
      <div className="modal">
        <h2>{d.prompt}</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>
          {hint[d.context] ?? ''}
        </div>
        <div className="order-list">
          {order.map((id, i) => {
            const o = !d.items ? view.objects[id] : undefined;
            return (
              <div key={id} className="order-item">
                <span className="idx">{i + 1}.</span>
                {o && (
                  <div className="card-wrap" style={{ ['--cw' as string]: '44px' }}>
                    <Card obj={o} noRotate onHover={handlers.onHover} />
                  </div>
                )}
                <span className="grow">{label(id)}</span>
                <button className="xs" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button className="xs" onClick={() => move(i, 1)} disabled={i === order.length - 1}>
                  ↓
                </button>
              </div>
            );
          })}
        </div>
        <div className="actions">
          <button className="primary" onClick={() => respond({ type: 'order', ids: order })}>
            Confirm order
          </button>
        </div>
        {d.error && <div className="error">{d.error}</div>}
      </div>
    </div>
  );
}

function DistributeModal({ view, d, respond }: { view: GameView; d: Extract<Decision, { type: 'distribute' }> & { error?: string }; respond: (r: Response) => void }) {
  const init = () => {
    const amounts = d.targets.map(() => d.minPer);
    if (amounts.length) amounts[0] += Math.max(0, d.amount - amounts.reduce((a, b) => a + b, 0));
    return amounts;
  };
  const [amounts, setAmounts] = useState<number[]>(init);
  useEffect(() => setAmounts(init()), [d.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = amounts.reduce((a, b) => a + b, 0);
  const ok = total === d.amount && amounts.every((a) => a >= d.minPer);
  return (
    <div className="overlay">
      <div className="modal">
        <h2>{d.prompt}</h2>
        <div className="muted small">
          Distribute {d.amount} (at least {d.minPer} each). Assigned: {total}/{d.amount}
        </div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          {d.targets.map((t: Target, i) => (
            <TargetRow key={i} label={targetLabel(view, t)} value={amounts[i]} min={d.minPer} onChange={(v) => setAmounts((a) => a.map((x, j) => (j === i ? v : x)))} />
          ))}
        </div>
        <div className="actions">
          <button className="primary" disabled={!ok} onClick={() => respond({ type: 'distribute', amounts })}>
            Confirm
          </button>
        </div>
        {d.error && <div className="error">{d.error}</div>}
      </div>
    </div>
  );
}

function TargetRow({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (v: number) => void }) {
  return (
    <>
      <label>{label}</label>
      <div className="row">
        <button className="xs" onClick={() => onChange(Math.max(min, value - 1))}>
          −
        </button>
        <input type="number" value={value} min={min} style={{ width: 70 }} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} />
        <button className="xs" onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </>
  );
}

function UnknownDecisionModal({ d, respond }: { d: AnyDecision; respond: (r: Response) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="overlay">
      <div className="modal">
        <h2>Unsupported decision: {(d as { type: string }).type}</h2>
        <p className="muted small">This client does not know how to render this decision yet. The raw decision is shown below; you can send a raw JSON response.</p>
        <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, background: 'var(--bg-2)', padding: 8, borderRadius: 6 }}>{JSON.stringify(d, null, 2)}</pre>
        <textarea style={{ width: '100%', minHeight: 60 }} placeholder='{"type":"pass"}' value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions">
          <button onClick={() => respond({ type: 'cancel' })}>Cancel</button>
          <button onClick={() => respond({ type: 'pass' })}>Pass</button>
          <button
            className="primary"
            onClick={() => {
              try {
                respond(JSON.parse(text) as Response);
              } catch {
                /* ignore malformed */
              }
            }}
          >
            Send JSON
          </button>
        </div>
      </div>
    </div>
  );
}

export function isModalDecision(d: Decision | null): boolean {
  if (!d) return false;
  return d.type === 'chooseOption' || d.type === 'orderObjects' || d.type === 'distribute';
}

export type { ObjectView };
