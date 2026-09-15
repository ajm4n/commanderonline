import { useState } from 'react';
import type { Color, GameView, ManualAction, ManaColor, ObjectView } from '@commander/engine';
import { Modal } from './Modal.js';
import { useUi, type DialogState } from '../state/ui.js';
import { MANA_COLORS, MANA_NAMES } from '../lib/format.js';
import { cachedCard } from '../lib/scryfall.js';

const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];

export function Dialogs({ view, manual, onCast, onPlayLand, onConcede }: { view: GameView; manual: (a: ManualAction) => void; onCast: (obj: ObjectView, faceIndex: number) => void; onPlayLand: (obj: ObjectView) => void; onConcede: () => void }) {
  const dialog = useUi((s) => s.dialog);
  const setDialog = useUi((s) => s.setDialog);
  const close = () => setDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'token':
      return <TokenDialog onClose={close} manual={manual} />;
    case 'mana':
      return <ManaDialog onClose={close} manual={manual} />;
    case 'number':
      return <NumberDialog d={dialog} onClose={close} />;
    case 'counter': {
      const o = view.objects[dialog.objectId];
      return <CounterDialog name={o?.name ?? `#${dialog.objectId}`} onClose={close} onSubmit={(type, delta) => manual({ kind: 'addCounters', objectId: dialog.objectId, counterType: type, delta })} />;
    }
    case 'face': {
      const o = view.objects[dialog.objectId];
      if (!o) return null;
      return <FaceDialog obj={o} onClose={close} onCast={(i) => onCast(o, i)} onPlayLand={() => onPlayLand(o)} />;
    }
    case 'confirmConcede':
      return (
        <Modal
          title="Concede the game?"
          onClose={close}
          actions={
            <>
              <button onClick={close}>Keep playing</button>
              <button
                className="danger"
                onClick={() => {
                  onConcede();
                  close();
                }}
              >
                Concede
              </button>
            </>
          }
        >
          <p className="muted">You will lose the game. Other players keep playing.</p>
        </Modal>
      );
    default:
      return null;
  }
}

function TokenDialog({ onClose, manual }: { onClose: () => void; manual: (a: ManualAction) => void }) {
  const [name, setName] = useState('Soldier');
  const [typeLine, setTypeLine] = useState('Creature — Soldier');
  const [power, setPower] = useState('1');
  const [toughness, setToughness] = useState('1');
  const [colors, setColors] = useState<Color[]>(['W']);
  const [oracle, setOracle] = useState('');
  const [count, setCount] = useState(1);
  const [tapped, setTapped] = useState(false);
  const isCreature = /Creature/i.test(typeLine);
  const presets: { label: string; v: Partial<{ name: string; typeLine: string; power: string; toughness: string; colors: Color[]; oracle: string }> }[] = [
    { label: 'Treasure', v: { name: 'Treasure', typeLine: 'Artifact — Treasure', power: '', toughness: '', colors: [], oracle: '{T}, Sacrifice this artifact: Add one mana of any color.' } },
    { label: 'Clue', v: { name: 'Clue', typeLine: 'Artifact — Clue', power: '', toughness: '', colors: [], oracle: '{2}, Sacrifice this artifact: Draw a card.' } },
    { label: 'Food', v: { name: 'Food', typeLine: 'Artifact — Food', power: '', toughness: '', colors: [], oracle: '{2}, {T}, Sacrifice this artifact: You gain 3 life.' } },
    { label: '1/1 Soldier', v: { name: 'Soldier', typeLine: 'Creature — Soldier', power: '1', toughness: '1', colors: ['W'], oracle: '' } },
    { label: '2/2 Zombie', v: { name: 'Zombie', typeLine: 'Creature — Zombie', power: '2', toughness: '2', colors: ['B'], oracle: '' } },
    { label: '1/1 Spirit flying', v: { name: 'Spirit', typeLine: 'Creature — Spirit', power: '1', toughness: '1', colors: ['W'], oracle: 'Flying' } },
    { label: '3/3 Beast', v: { name: 'Beast', typeLine: 'Creature — Beast', power: '3', toughness: '3', colors: ['G'], oracle: '' } },
    { label: '1/1 Thopter', v: { name: 'Thopter', typeLine: 'Artifact Creature — Thopter', power: '1', toughness: '1', colors: [], oracle: 'Flying' } },
  ];
  const apply = (v: (typeof presets)[number]['v']) => {
    if (v.name !== undefined) setName(v.name);
    if (v.typeLine !== undefined) setTypeLine(v.typeLine);
    if (v.power !== undefined) setPower(v.power);
    if (v.toughness !== undefined) setToughness(v.toughness);
    if (v.colors !== undefined) setColors(v.colors);
    if (v.oracle !== undefined) setOracle(v.oracle);
  };
  return (
    <Modal
      title="Create token"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!name.trim()}
            onClick={() => {
              manual({ kind: 'createToken', name: name.trim(), typeLine: typeLine.trim() || undefined, power: isCreature ? power : undefined, toughness: isCreature ? toughness : undefined, colors, oracleText: oracle.trim() || undefined, count: Math.max(1, count), tapped });
              onClose();
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="row wrap" style={{ marginBottom: 10 }}>
        {presets.map((p) => (
          <button key={p.label} className="xs" onClick={() => apply(p.v)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        <label>Type line</label>
        <input type="text" value={typeLine} onChange={(e) => setTypeLine(e.target.value)} />
        {isCreature && (
          <>
            <label>P/T</label>
            <div className="row">
              <input type="text" value={power} style={{ width: 60 }} onChange={(e) => setPower(e.target.value)} />/
              <input type="text" value={toughness} style={{ width: 60 }} onChange={(e) => setToughness(e.target.value)} />
            </div>
          </>
        )}
        <label>Colors</label>
        <div className="row">
          {COLORS.map((c) => (
            <label key={c} className="row" style={{ gap: 3 }}>
              <input type="checkbox" checked={colors.includes(c)} onChange={(e) => setColors((cs) => (e.target.checked ? [...cs, c] : cs.filter((x) => x !== c)))} />
              {c}
            </label>
          ))}
        </div>
        <label>Text</label>
        <input type="text" value={oracle} onChange={(e) => setOracle(e.target.value)} placeholder="Flying, haste…" />
        <label>Count</label>
        <div className="row">
          <input type="number" min={1} max={50} value={count} style={{ width: 70 }} onChange={(e) => setCount(Number(e.target.value) || 1)} />
          <label className="row" style={{ gap: 3 }}>
            <input type="checkbox" checked={tapped} onChange={(e) => setTapped(e.target.checked)} /> tapped
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ManaDialog({ onClose, manual }: { onClose: () => void; manual: (a: ManualAction) => void }) {
  const [amount, setAmount] = useState(1);
  return (
    <Modal title="Add mana to your pool" onClose={onClose} actions={<button onClick={onClose}>Done</button>}>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="muted">Amount</label>
        <input type="number" min={1} max={99} value={amount} style={{ width: 70 }} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))} />
      </div>
      <div className="row wrap">
        {MANA_COLORS.map((c: ManaColor) => (
          <button key={c} onClick={() => manual({ kind: 'addMana', color: c, amount })} className="row">
            <span className="mana">
              <span className={`sym ${c}`}>{c}</span>
            </span>
            {MANA_NAMES[c]}
          </button>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Mana empties between steps as usual.
      </p>
    </Modal>
  );
}

function NumberDialog({ d, onClose }: { d: Extract<NonNullable<DialogState>, { kind: 'number' }>; onClose: () => void }) {
  const [v, setV] = useState(d.initial);
  const submit = () => {
    d.onSubmit(v);
    onClose();
  };
  return (
    <Modal
      title={d.title}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            OK
          </button>
        </>
      }
    >
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="muted">{d.label}</label>
        <input type="number" value={v} autoFocus style={{ width: 100 }} onChange={(e) => setV(Number(e.target.value) || 0)} />
      </form>
    </Modal>
  );
}

function CounterDialog({ name, onClose, onSubmit }: { name: string; onClose: () => void; onSubmit: (type: string, delta: number) => void }) {
  const [type, setType] = useState('charge');
  const [delta, setDelta] = useState(1);
  const common = ['charge', 'loyalty', '+1/+1', '-1/-1', 'lore', 'oil', 'stun', 'shield', 'time', 'flying', 'deathtouch', 'quest', 'age', 'fade'];
  return (
    <Modal
      title={`Counters on ${name}`}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!type.trim() || !delta}
            onClick={() => {
              onSubmit(type.trim(), delta);
              onClose();
            }}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {common.map((c) => (
          <button key={c} className={`xs ${type === c ? 'primary' : ''}`} onClick={() => setType(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>Counter type</label>
        <input type="text" value={type} onChange={(e) => setType(e.target.value)} />
        <label>Change</label>
        <input type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value) || 0)} />
      </div>
    </Modal>
  );
}

function FaceDialog({ obj, onClose, onCast, onPlayLand }: { obj: ObjectView; onClose: () => void; onCast: (faceIndex: number) => void; onPlayLand: () => void }) {
  const card = cachedCard(obj.name);
  const faces = card?.faces ?? [];
  const front = { name: faces[0]?.name ?? obj.name, typeLine: faces[0]?.typeLine ?? obj.typeLine, manaCost: faces[0]?.manaCost ?? obj.manaCost, img: obj.imageUri };
  const back = { name: faces[1]?.name ?? 'Back face', typeLine: faces[1]?.typeLine ?? '', manaCost: faces[1]?.manaCost ?? '', img: obj.backImageUri ?? faces[1]?.imageUri };
  const backIsLand = /\bLand\b/.test(back.typeLine);
  const frontIsLand = /\bLand\b/.test(front.typeLine);
  const layoutLabel = obj.layout === 'adventure' ? 'Adventure' : obj.layout === 'split' ? 'Split card' : obj.layout === 'modal_dfc' ? 'Modal double-faced card' : 'Two-faced card';
  const pick = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <Modal title={`${layoutLabel}: how do you want to play ${obj.name}?`} onClose={onClose} actions={<button onClick={onClose}>Cancel</button>}>
      <div className="faces">
        {frontIsLand ? (
          <button onClick={pick(onPlayLand)}>
            {front.img && <img src={front.img} alt="" />}
            <b>Play {front.name} as a land</b>
            <span className="muted small">{front.typeLine}</span>
          </button>
        ) : (
          <button onClick={pick(() => onCast(0))}>
            {front.img && <img src={front.img} alt="" />}
            <b>Cast {front.name}</b>
            <span className="muted small">
              {front.typeLine} {front.manaCost}
            </span>
          </button>
        )}
        {backIsLand ? (
          <button onClick={pick(onPlayLand)}>
            {back.img && back.img !== front.img && <img src={back.img} alt="" />}
            <b>Play {back.name} as a land</b>
            <span className="muted small">{back.typeLine}</span>
          </button>
        ) : (
          <button onClick={pick(() => onCast(1))}>
            {back.img && back.img !== front.img && <img src={back.img} alt="" />}
            <b>Cast {back.name}</b>
            <span className="muted small">
              {back.typeLine} {back.manaCost}
            </span>
          </button>
        )}
      </div>
    </Modal>
  );
}
