import type { Decision, GameView, ObjectView, ManualAction, PlayerId, ZoneName } from '@commander/engine';
import { ContextMenu } from './ContextMenu.js';
import { useUi } from '../state/ui.js';
import { playerName, objectName } from '../lib/format.js';

interface ObjectMenuProps {
  view: GameView;
  obj: ObjectView;
  at: { x: number; y: number };
  decision: Decision | null;
  onClose: () => void;
  manual: (a: ManualAction) => void;
  onCast: (obj: ObjectView) => void;
  onPlayLand: (obj: ObjectView) => void;
  onActivate: (obj: ObjectView, abilityIndex: number) => void;
}

const ZONES: { zone: ZoneName; label: string; position?: 'top' | 'bottom' }[] = [
  { zone: 'battlefield', label: 'Battlefield' },
  { zone: 'hand', label: 'Hand' },
  { zone: 'graveyard', label: 'Graveyard' },
  { zone: 'exile', label: 'Exile' },
  { zone: 'library', label: 'Library (top)', position: 'top' },
  { zone: 'library', label: 'Library (bottom)', position: 'bottom' },
  { zone: 'command', label: 'Command zone' },
];

export function ObjectMenu({ view, obj, at, decision, onClose, manual, onCast, onPlayLand, onActivate }: ObjectMenuProps) {
  const setDialog = useUi((s) => s.setDialog);
  const prio = decision?.type === 'priority' ? decision : null;
  const abilities = prio?.activatableAbilities.filter((a) => a.objectId === obj.id) ?? [];
  const playable = prio?.playableCards.includes(obj.id) ?? false;
  const isLand = obj.types.includes('Land');
  const act = (a: ManualAction) => {
    manual(a);
    onClose();
  };
  const others = view.players.filter((p) => p.id !== obj.controller && !p.lost);
  const isMine = obj.controller === view.you;
  return (
    <ContextMenu at={at} title={obj.hidden ? 'Face-down card' : obj.name} onClose={onClose}>
      {playable && (
        <>
          {isLand && prio?.canPlayLand && (
            <button
              className="ability"
              onClick={() => {
                onPlayLand(obj);
                onClose();
              }}
            >
              Play land
            </button>
          )}
          {(!isLand || obj.hasBackFace) && (
            <button
              className="ability"
              onClick={() => {
                onCast(obj);
                onClose();
              }}
            >
              Cast {obj.isCommander ? '(commander)' : ''}
            </button>
          )}
        </>
      )}
      {abilities.map((a) => (
        <button
          key={a.abilityIndex}
          className="ability"
          onClick={() => {
            onActivate(obj, a.abilityIndex);
            onClose();
          }}
          title={a.text}
        >
          Activate: {a.text.length > 60 ? a.text.slice(0, 58) + '…' : a.text}
        </button>
      ))}
      {(playable || abilities.length > 0) && <div className="sep" />}
      {obj.zone === 'battlefield' && <button onClick={() => act({ kind: 'tap', objectId: obj.id, tapped: !obj.tapped })}>{obj.tapped ? 'Untap' : 'Tap'}</button>}
      {obj.hasBackFace && <button onClick={() => act({ kind: 'transform', objectId: obj.id })}>Transform / flip face</button>}
      <div className="ctx-title" style={{ borderBottom: 'none', marginTop: 4 }}>
        Move to
      </div>
      <div className="sub">
        {ZONES.filter((z) => !(z.zone === obj.zone && z.zone !== 'library')).map((z) => (
          <button key={z.label} onClick={() => act({ kind: 'moveObject', objectId: obj.id, toZone: z.zone, position: z.position })}>
            {z.label}
          </button>
        ))}
      </div>
      {(obj.zone === 'battlefield' || obj.zone === 'command') && (
        <>
          <div className="ctx-title" style={{ borderBottom: 'none', marginTop: 4 }}>
            Counters
          </div>
          <div className="sub">
            <button onClick={() => manual({ kind: 'addCounters', objectId: obj.id, counterType: '+1/+1', delta: 1 })}>+1/+1</button>
            <button onClick={() => manual({ kind: 'addCounters', objectId: obj.id, counterType: '+1/+1', delta: -1 })} disabled={!obj.counters['+1/+1']}>
              −(+1/+1)
            </button>
            <button onClick={() => manual({ kind: 'addCounters', objectId: obj.id, counterType: '-1/-1', delta: 1 })}>-1/-1</button>
            <button onClick={() => manual({ kind: 'addCounters', objectId: obj.id, counterType: '-1/-1', delta: -1 })} disabled={!obj.counters['-1/-1']}>
              −(-1/-1)
            </button>
            {(obj.types.includes('Planeswalker') || obj.counters['loyalty']) && (
              <>
                <button onClick={() => manual({ kind: 'addCounters', objectId: obj.id, counterType: 'loyalty', delta: 1 })}>Loyalty +1</button>
                <button onClick={() => manual({ kind: 'addCounters', objectId: obj.id, counterType: 'loyalty', delta: -1 })}>Loyalty −1</button>
              </>
            )}
            <button
              onClick={() => {
                setDialog({ kind: 'counter', objectId: obj.id });
                onClose();
              }}
            >
              Custom…
            </button>
          </div>
          <div className="ctx-title" style={{ borderBottom: 'none', marginTop: 4 }}>
            Damage
          </div>
          <div className="sub">
            <button onClick={() => manual({ kind: 'damage', objectId: obj.id, amount: 1 })}>+1</button>
            <button onClick={() => manual({ kind: 'damage', objectId: obj.id, amount: 3 })}>+3</button>
            <button onClick={() => manual({ kind: 'damage', objectId: obj.id, amount: -obj.damage })} disabled={!obj.damage}>
              Clear
            </button>
            <button
              onClick={() => {
                setDialog({ kind: 'number', title: `Damage to ${obj.name}`, label: 'Amount', initial: 1, onSubmit: (n) => manual({ kind: 'damage', objectId: obj.id, amount: n }) });
                onClose();
              }}
            >
              Custom…
            </button>
          </div>
          {others.length > 0 && (
            <>
              <div className="ctx-title" style={{ borderBottom: 'none', marginTop: 4 }}>
                Give control to
              </div>
              <div className="sub">
                {others.map((p) => (
                  <button key={p.id} onClick={() => act({ kind: 'setControl', objectId: obj.id, controller: p.id })}>
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {obj.attachedTo !== null && <button onClick={() => act({ kind: 'attach', objectId: obj.id, to: null })}>Unattach from {objectName(view, obj.attachedTo)}</button>}
        </>
      )}
      {obj.zone === 'hand' && isMine && <button onClick={() => act({ kind: 'reveal', objectId: obj.id })}>Reveal</button>}
      {!isMine && obj.zone === 'battlefield' && <button onClick={() => act({ kind: 'setControl', objectId: obj.id, controller: view.you })}>Take control</button>}
    </ContextMenu>
  );
}

export function PlayerMenu({ view, playerId, at, onClose, manual }: { view: GameView; playerId: PlayerId; at: { x: number; y: number }; onClose: () => void; manual: (a: ManualAction) => void }) {
  const setDialog = useUi((s) => s.setDialog);
  const p = view.players.find((x) => x.id === playerId);
  if (!p) return null;
  const commanders = Object.values(view.objects).filter((o) => o.isCommander && !o.hidden && o.controller !== playerId);
  return (
    <ContextMenu at={at} title={`${p.name} — ${p.life} life`} onClose={onClose}>
      <div className="ctx-title" style={{ borderBottom: 'none' }}>
        Life
      </div>
      <div className="sub">
        {[-5, -1, 1, 5].map((d) => (
          <button key={d} onClick={() => manual({ kind: 'adjustLife', playerId, delta: d })}>
            {d > 0 ? `+${d}` : d}
          </button>
        ))}
        <button
          onClick={() => {
            setDialog({ kind: 'number', title: `Set ${p.name}'s life`, label: 'Life', initial: p.life, onSubmit: (n) => manual({ kind: 'setLife', playerId, life: n }) });
            onClose();
          }}
        >
          Set…
        </button>
      </div>
      <div className="ctx-title" style={{ borderBottom: 'none', marginTop: 4 }}>
        Poison ({p.poison})
      </div>
      <div className="sub">
        <button onClick={() => manual({ kind: 'poison', playerId, delta: -1 })} disabled={p.poison === 0}>
          −1
        </button>
        <button onClick={() => manual({ kind: 'poison', playerId, delta: 1 })}>+1</button>
      </div>
      {commanders.length > 0 && (
        <>
          <div className="ctx-title" style={{ borderBottom: 'none', marginTop: 4 }}>
            Commander damage
          </div>
          {commanders.map((c) => (
            <div key={c.id} className="sub" style={{ alignItems: 'center' }}>
              <span className="small" style={{ flex: 1 }}>
                {c.name} ({playerName(view, c.controller)}): {p.commanderDamage[c.id] ?? 0}
              </span>
              <button onClick={() => manual({ kind: 'commanderDamage', playerId, commanderId: c.id, delta: -1 })} disabled={!(p.commanderDamage[c.id] ?? 0)}>
                −1
              </button>
              <button onClick={() => manual({ kind: 'commanderDamage', playerId, commanderId: c.id, delta: 1 })}>+1</button>
            </div>
          ))}
        </>
      )}
    </ContextMenu>
  );
}
