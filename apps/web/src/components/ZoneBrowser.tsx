import type { GameView, ObjectView } from '@commander/engine';
import { Modal } from './Modal.js';
import { Card } from './Card.js';
import { flagsFor, type CardHandlers } from './Battlefield.js';
import type { Highlights } from '../state/ui.js';
import { playerName } from '../lib/format.js';

const ZONE_LABEL = { graveyard: 'graveyard', exile: 'exile', command: 'command zone', hand: 'hand' } as const;

export function ZoneBrowser({ view, player, zone, highlights, decisionActive, handlers, onClose }: { view: GameView; player: string; zone: keyof typeof ZONE_LABEL; highlights: Highlights; decisionActive: boolean; handlers: CardHandlers; onClose: () => void }) {
  const p = view.players.find((x) => x.id === player);
  if (!p) return null;
  const ids = zone === 'hand' ? p.hand ?? [] : p[zone];
  const cards = ids.map((id) => view.objects[id]).filter((o): o is ObjectView => !!o);
  const title = `${playerName(view, player)}'s ${ZONE_LABEL[zone]} (${zone === 'hand' ? p.handCount : ids.length})`;
  return (
    <Modal title={title} onClose={onClose} wide actions={<button onClick={onClose}>Close</button>}>
      {zone === 'hand' && p.hand === null && <p className="muted">Hidden: {p.handCount} card(s).</p>}
      {cards.length === 0 && zone !== 'hand' && <p className="muted">Empty.</p>}
      <div className="card-grid">
        {[...cards].reverse().map((o) => (
          <div key={o.id} className="card-wrap">
            <Card obj={o} noRotate {...flagsFor(o.id, highlights, decisionActive)} onClick={handlers.onClick} onContextMenu={handlers.onContextMenu} onHover={handlers.onHover} showCoverage />
          </div>
        ))}
      </div>
      {zone === 'graveyard' && cards.length > 0 && <p className="muted small">Top of graveyard is first. Right-click a card for manual moves.</p>}
    </Modal>
  );
}
