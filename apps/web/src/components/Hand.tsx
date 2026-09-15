import type { GameView, ObjectView } from '@commander/engine';
import { Card } from './Card.js';
import { flagsFor, type CardHandlers } from './Battlefield.js';
import type { Highlights } from '../state/ui.js';

export function Hand({ view, highlights, decisionActive, handlers }: { view: GameView; highlights: Highlights; decisionActive: boolean; handlers: CardHandlers }) {
  const me = view.players.find((p) => p.id === view.you);
  const ids = me?.hand ?? [];
  const cards = ids.map((id) => view.objects[id]).filter((o): o is ObjectView => !!o);
  return (
    <div className="hand-wrap">
      <div className={`hand ${cards.length > 9 ? 'many' : ''}`}>
        {cards.map((o) => (
          <div key={o.id} className="card-wrap">
            <Card obj={o} {...flagsFor(o.id, highlights, decisionActive)} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
          </div>
        ))}
      </div>
      <div className="hand-count">
        Hand: {cards.length} · Library: {me?.libraryCount ?? 0}
      </div>
    </div>
  );
}
