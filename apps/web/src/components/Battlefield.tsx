import type { MouseEvent } from 'react';
import type { GameView, ObjectView, ObjectId } from '@commander/engine';
import { Card, type CardFlags, type HoverRect } from './Card.js';
import type { Highlights } from '../state/ui.js';

export interface CardHandlers {
  onClick: (obj: ObjectView, e: MouseEvent) => void;
  onContextMenu: (obj: ObjectView, e: MouseEvent) => void;
  onHover: (obj: ObjectView | null, rect?: HoverRect) => void;
}

export function flagsFor(id: ObjectId, h: Highlights, decisionActive: boolean): CardFlags {
  const any = h.legalObjects.size > 0 || h.selectedObjects.size > 0;
  return {
    playable: h.playable.has(id),
    activatable: h.activatable.has(id),
    legal: h.legalObjects.has(id) && !h.selectedObjects.has(id),
    selected: h.selectedObjects.has(id),
    dim: decisionActive && any && !h.legalObjects.has(id) && !h.selectedObjects.has(id) && !h.playable.has(id),
  };
}

interface Pile {
  key: string;
  top: ObjectView;
  ids: ObjectId[];
  tapped: number;
}

function pileLands(lands: ObjectView[]): Pile[] {
  const map = new Map<string, Pile>();
  for (const l of lands) {
    // Only stack plain, unmodified lands; anything with counters/attachments stands alone.
    const plain = !l.attachments.length && !Object.keys(l.counters).length && !l.damage && !l.isCommander;
    const key = plain ? `${l.name}|${l.faceIndex}|${l.controller}` : `#${l.id}`;
    const p = map.get(key);
    if (p) {
      p.ids.push(l.id);
      if (l.tapped) p.tapped++;
      // Show an untapped copy on top so the pile reads as "some untapped".
      if (p.top.tapped && !l.tapped) p.top = l;
    } else map.set(key, { key, top: l, ids: [l.id], tapped: l.tapped ? 1 : 0 });
  }
  return Array.from(map.values());
}

export function Battlefield({ view, controller, highlights, decisionActive, handlers }: { view: GameView; controller: string; highlights: Highlights; decisionActive: boolean; handlers: CardHandlers }) {
  const all = view.battlefield.map((id) => view.objects[id]).filter((o): o is ObjectView => !!o && o.controller === controller && !o.phasedOut);
  const attached = new Set<ObjectId>();
  for (const o of all) if (o.attachedTo !== null && view.objects[o.attachedTo]?.zone === 'battlefield') attached.add(o.id);
  const top = all.filter((o) => !attached.has(o.id));
  const lands = top.filter((o) => o.types.includes('Land') && !o.types.includes('Creature'));
  const creatures = top.filter((o) => o.types.includes('Creature'));
  const others = top.filter((o) => !lands.includes(o) && !creatures.includes(o));
  const piles = pileLands(lands);

  const renderCard = (o: ObjectView, extra?: { count: number; tapped: number }) => {
    const atts = o.attachments.map((id) => view.objects[id]).filter((a): a is ObjectView => !!a && a.zone === 'battlefield');
    return (
      <div key={o.id} className={`card-wrap ${atts.length ? 'has-attachments' : ''}`}>
        {atts.length > 0 && (
          <div className="attachments">
            {atts.map((a, i) => (
              <div key={a.id} className="card-wrap" style={{ left: `${(i + 1) * 22}%`, top: `-${(i + 1) * 14}%` }}>
                <Card obj={a} {...flagsFor(a.id, highlights, decisionActive)} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
              </div>
            ))}
          </div>
        )}
        <Card obj={o} count={extra?.count} tappedCount={extra?.tapped} {...flagsFor(o.id, highlights, decisionActive)} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
      </div>
    );
  };

  // Spells on the stack keep a presence on their controller's battlefield, so a card
  // being cast is visible both here and in the stack panel.
  const casting = view.stack
    .filter((s) => s.kind === 'spell')
    .map((s) => view.objects[s.sourceId])
    .filter((o): o is ObjectView => !!o && o.zone === 'stack' && o.controller === controller);

  const commandIds = view.players.find((p) => p.id === controller)?.command ?? [];
  const commandCards = commandIds.map((id) => view.objects[id]).filter((o): o is ObjectView => !!o);
  return (
    <div className="bf">
      {commandCards.length > 0 && (
        <div className="bf-row command" title="Command zone">
          <span className="bf-label">Command zone</span>
          {commandCards.map((o) => (
            <div key={o.id} className="card-wrap">
              <Card obj={o} noRotate {...flagsFor(o.id, highlights, decisionActive)} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
            </div>
          ))}
        </div>
      )}
      {casting.length > 0 && (
        <div className="bf-row casting" title="On the stack">
          <span className="bf-label">On the stack</span>
          {casting.map((o) => (
            <div key={o.id} className="card-wrap">
              <Card obj={o} noRotate {...flagsFor(o.id, highlights, decisionActive)} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
            </div>
          ))}
        </div>
      )}
      <div className={`bf-row creatures ${creatures.length ? '' : 'empty'}`}>{creatures.map((o) => renderCard(o))}</div>
      <div className={`bf-row others ${others.length ? '' : 'empty'}`}>{others.map((o) => renderCard(o))}</div>
      <div className={`bf-row lands ${piles.length ? '' : 'empty'}`}>
        {piles.map((p) => {
          // For a pile, a click on an untapped copy is what the player almost always wants.
          const pileFlags = p.ids.reduce<Record<string, boolean>>((acc, id) => {
            const f = flagsFor(id, highlights, decisionActive);
            for (const [k, v] of Object.entries(f)) acc[k] = k === 'dim' ? (acc[k] ?? true) && !!v : (acc[k] ?? false) || !!v;
            return acc;
          }, {});
          return (
            <div key={p.key} className="card-wrap">
              <Card obj={p.top} count={p.ids.length} tappedCount={p.tapped} {...pileFlags} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
            </div>
          );
        })}
      </div>
    </div>
  );
}
