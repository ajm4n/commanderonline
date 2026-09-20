import type { GameView } from '@commander/engine';
import { playerName, targetLabel } from '../lib/format.js';
import type { Highlights } from '../state/ui.js';
import { avatarColor } from './PlayerPanel.js';

export function StackPanel({ view, highlights, selected, onSelect }: { view: GameView; highlights: Highlights; selected: number | null; onSelect: (id: number) => void }) {
  const items = view.stack;
  return (
    <div className="side-section stack">
      <h3>
        <span>Stack</span>
        <span className="muted">{items.length}</span>
      </h3>
      <div className="scroll">
        {items.length === 0 && <div className="muted small">Empty</div>}
        <div className="stack-list">
          {items.map((s, i) => {
            const src = view.objects[s.sourceId];
            const isTop = i === items.length - 1;
            const cls = ['stack-item', isTop ? 'top' : '', highlights.legalStack.has(s.id) ? 'legal' : '', highlights.selectedStack.has(s.id) || selected === s.id ? 'selected' : ''].filter(Boolean).join(' ');
            return (
              <div key={s.id} className={cls} onClick={() => onSelect(s.id)} title={s.text}>
                {src?.imageUri ? <img className="thumb" src={src.imageUri} alt="" /> : <div className="thumb" />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {s.sourceName}
                    {s.kind === 'triggered' ? ' (trigger)' : s.kind === 'ability' ? ' (ability)' : ''}
                  </div>
                  <div className="who">{playerName(view, s.controller)}</div>
                  <div style={{ opacity: 0.9 }}>{s.text}</div>
                  {s.targets.length > 0 && (
                    <div className="targets" title={s.targets.map((t) => targetLabel(view, t)).join(', ')}>
                      <span className="arrow">→</span>
                      {s.targets.map((t, ti) => {
                        if (t.kind === 'player') {
                          const p = view.players.find((x) => x.id === t.id);
                          return (
                            <span key={ti} className="tgt-avatar" style={{ background: avatarColor(view, t.id) }}>
                              {(p?.name ?? '?').slice(0, 1).toUpperCase()}
                            </span>
                          );
                        }
                        const o = t.kind === 'object' ? view.objects[t.id] : undefined;
                        if (o?.imageUri && !o.hidden) return <img key={ti} className="thumb sm" src={o.imageUri} alt="" />;
                        return (
                          <span key={ti} className="tgt-chip">
                            {targetLabel(view, t)}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {s.countered && <div className="error">countered</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
