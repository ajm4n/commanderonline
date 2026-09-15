import type { MouseEvent } from 'react';
import type { GameView, PlayerView } from '@commander/engine';
import { MANA_COLORS, objectName } from '../lib/format.js';

const AVATAR_COLORS = ['#7c5cff', '#2f9e8f', '#c0533f', '#3c78d8', '#b08a2e', '#8e44ad'];

export function avatarColor(view: GameView, id: string): string {
  const i = view.playerOrder.indexOf(id);
  return AVATAR_COLORS[(i < 0 ? 0 : i) % AVATAR_COLORS.length];
}

export interface PlayerPanelProps {
  view: GameView;
  player: PlayerView;
  compact: boolean;
  legal: boolean;
  selected: boolean;
  onAvatarClick: (id: string, e: MouseEvent) => void;
  onAvatarContext: (id: string, e: MouseEvent) => void;
  onLife: (id: string, delta: number) => void;
  onBrowse: (id: string, zone: 'graveyard' | 'exile' | 'command' | 'hand') => void;
}

export function PlayerPanel({ view, player: p, compact, legal, selected, onAvatarClick, onAvatarContext, onLife, onBrowse }: PlayerPanelProps) {
  const isYou = p.id === view.you;
  const pool = MANA_COLORS.filter((c) => p.manaPool[c] > 0);
  const cmdDmg = Object.entries(p.commanderDamage).filter(([, n]) => n > 0);
  const waiting = view.waitingOn === p.id;
  return (
    <div className="player-panel">
      <div className="pp-head">
        <div
          className={`avatar ${legal ? 'legal' : ''} ${selected ? 'selected' : ''} ${waiting ? 'priority' : ''}`}
          style={{ background: avatarColor(view, p.id) }}
          onClick={(e) => onAvatarClick(p.id, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            onAvatarContext(p.id, e);
          }}
          title={`${p.name}${waiting ? ' (deciding)' : ''} — click for options`}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="pp-name">
            {p.name}
            {isYou ? ' (you)' : ''} {p.isMonarch ? '👑' : ''}
            {p.lost && <span className="badge none" style={{ marginLeft: 4 }}>{p.lossReason ?? 'lost'}</span>}
          </div>
          {!compact && <div className="muted small">{p.isActive ? 'Active player' : waiting ? 'Deciding…' : ''}</div>}
        </div>
        <div className="life-ctl">
          {!compact && (
            <button className="xs ghost" onClick={() => onLife(p.id, -1)} title="Life -1 (manual)">
              −
            </button>
          )}
          <span className="life" style={{ color: p.life <= 10 ? '#ff9a9a' : undefined }} title="Life total (right-click avatar for manual changes)">
            {p.life}
          </span>
          {!compact && (
            <button className="xs ghost" onClick={() => onLife(p.id, 1)} title="Life +1 (manual)">
              +
            </button>
          )}
        </div>
      </div>
      <div className="pp-stats">
        <span className={`stat ${isYou ? '' : 'clickable'}`} title="Hand" onClick={() => !isYou && onBrowse(p.id, 'hand')}>
          ✋ {p.handCount}
        </span>
        <span className="stat" title="Library">
          📚 {p.libraryCount}
        </span>
        <span className="stat clickable" title="Graveyard — click to browse" onClick={() => onBrowse(p.id, 'graveyard')}>
          ⚰ {p.graveyard.length}
        </span>
        <span className="stat clickable" title="Exile — click to browse" onClick={() => onBrowse(p.id, 'exile')}>
          ✧ {p.exile.length}
        </span>
        <span className="stat clickable" title="Command zone — click to browse" onClick={() => onBrowse(p.id, 'command')}>
          ★ {p.command.length}
        </span>
        {p.poison > 0 && (
          <span className="stat" title="Poison counters" style={{ color: '#9fe870' }}>
            ☠ {p.poison}
          </span>
        )}
        {p.energy > 0 && <span className="stat">⚡ {p.energy}</span>}
        {p.experience > 0 && <span className="stat">XP {p.experience}</span>}
        {pool.length > 0 && (
          <span className="pool mana" title="Mana pool">
            {pool.map((c) => (
              <span key={c} className={`sym ${c}`}>
                {p.manaPool[c]}
              </span>
            ))}
          </span>
        )}
      </div>
      {cmdDmg.length > 0 && (
        <div className="cmd-dmg" title="Commander damage taken">
          {cmdDmg.map(([id, n]) => (
            <span key={id} style={{ marginRight: 6 }}>
              {objectName(view, Number(id))}: {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
