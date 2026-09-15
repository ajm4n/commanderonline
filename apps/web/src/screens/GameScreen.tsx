import { useCallback, useEffect, useMemo, type MouseEvent } from 'react';
import type { ObjectView, ObjectId, PlayerId, Target } from '@commander/engine';
import { useStore } from '../state/store.js';
import { useUi, computeHighlights } from '../state/ui.js';
import { PhaseTracker } from '../components/PhaseTracker.js';
import { PlayerPanel } from '../components/PlayerPanel.js';
import { Battlefield, type CardHandlers } from '../components/Battlefield.js';
import { Hand } from '../components/Hand.js';
import { StackPanel } from '../components/StackPanel.js';
import { LogPanel } from '../components/LogPanel.js';
import { DecisionBar, DecisionModal } from '../components/Decisions.js';
import { ObjectMenu, PlayerMenu } from '../components/Menus.js';
import { Dialogs } from '../components/Dialogs.js';
import { ZoneBrowser } from '../components/ZoneBrowser.js';
import { CardPreview } from '../components/CardPreview.js';
import { playerName } from '../lib/format.js';

const FACE_CHOICE_LAYOUTS = new Set(['modal_dfc', 'adventure', 'split']);

function rotateOrder(order: PlayerId[], me: PlayerId): PlayerId[] {
  const i = order.indexOf(me);
  if (i < 0) return order;
  return [...order.slice(i), ...order.slice(0, i)];
}

export function GameScreen() {
  const view = useStore((s) => s.view);
  const respond = useStore((s) => s.respond);
  const manual = useStore((s) => s.manual);
  const concede = useStore((s) => s.concede);
  const goHome = useStore((s) => s.goHome);
  const chat = useStore((s) => s.chat);
  const sendChat = useStore((s) => s.sendChat);
  const connStatus = useStore((s) => s.connStatus);
  const mode = useStore((s) => s.mode);
  const gameOver = useStore((s) => s.gameOver);
  const sync = useStore((s) => s.sync);

  const ui = useUi();
  const decision = view?.decision ?? null;
  const decisionId = decision?.id ?? null;
  useEffect(() => {
    useUi.getState().syncDecision(decision);
  }, [decisionId, decision]);

  const highlights = useMemo(() => {
    const h = computeHighlights(decision, ui);
    if (view && ui.selectedStackItem !== null) {
      const item = view.stack.find((s) => s.id === ui.selectedStackItem);
      for (const t of item?.targets ?? []) {
        if (t.kind === 'object') h.legalObjects.add(t.id);
        else if (t.kind === 'player') h.legalPlayers.add(t.id);
      }
    }
    return h;
  }, [decision, ui.slot, ui.targets, ui.attacks, ui.blocker, ui.blocks, ui.objects, ui.defender, ui.selectedStackItem, view]);

  const decisionActive = !!decision && decision.type !== 'priority';

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const cast = useCallback(
    (obj: ObjectView, faceIndex?: number) => {
      if (faceIndex === undefined && obj.hasBackFace && FACE_CHOICE_LAYOUTS.has(obj.layout)) {
        useUi.getState().setDialog({ kind: 'face', objectId: obj.id });
        return;
      }
      respond({ type: 'cast', objectId: obj.id, faceIndex: faceIndex && faceIndex > 0 ? faceIndex : undefined });
    },
    [respond],
  );
  const playLand = useCallback((obj: ObjectView) => respond({ type: 'playLand', objectId: obj.id }), [respond]);
  const activate = useCallback((obj: ObjectView, abilityIndex: number) => respond({ type: 'activate', objectId: obj.id, abilityIndex }), [respond]);

  const openMenu = (obj: ObjectView, e: MouseEvent) => ui.setMenu({ kind: 'object', id: obj.id, x: e.clientX, y: e.clientY });

  const onCardClick = (obj: ObjectView, e: MouseEvent) => {
    if (!view) return;
    const d = decision;
    if (!d) return openMenu(obj, e);
    switch (d.type) {
      case 'priority': {
        if (d.playableCards.includes(obj.id)) {
          const isLand = obj.types.includes('Land');
          if (isLand && !obj.hasBackFace) return playLand(obj);
          if (isLand && obj.layout !== 'modal_dfc') return playLand(obj);
          return cast(obj);
        }
        return openMenu(obj, e);
      }
      case 'chooseTargets': {
        const t: Target = { kind: 'object', id: obj.id };
        const legal = d.slots.some((s) => s.legal.some((l) => l.kind === 'object' && l.id === obj.id));
        if (legal) return ui.toggleTarget(t, d);
        return openMenu(obj, e);
      }
      case 'chooseObjects':
        if (d.candidates.includes(obj.id)) return ui.toggleObject(obj.id, d.max);
        return openMenu(obj, e);
      case 'declareAttackers': {
        const c = d.candidates.find((x) => x.id === obj.id);
        if (!c) return openMenu(obj, e);
        const target = ui.defender !== null && c.canAttack.includes(ui.defender) ? ui.defender : c.canAttack.find((x) => typeof x === 'string') ?? c.canAttack[0];
        if (target === undefined) return;
        return ui.toggleAttacker(obj.id, target);
      }
      case 'declareBlockers': {
        const cand = d.candidates.find((x) => x.id === obj.id);
        if (ui.blocker === null) {
          if (cand) return ui.setBlocker(obj.id);
          return openMenu(obj, e);
        }
        if (d.attackers.includes(obj.id)) {
          const b = d.candidates.find((x) => x.id === ui.blocker);
          if (b && b.canBlock.includes(obj.id)) return ui.addBlock(ui.blocker, obj.id);
          return;
        }
        if (cand) return ui.setBlocker(obj.id === ui.blocker ? null : obj.id);
        return ui.setBlocker(null);
      }
      default:
        return openMenu(obj, e);
    }
  };

  const handlers: CardHandlers = useMemo(
    () => ({
      onClick: onCardClick,
      onContextMenu: (obj, e) => ui.setMenu({ kind: 'object', id: obj.id, x: e.clientX, y: e.clientY }),
      onHover: (obj) => ui.setHover(obj),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [decision, ui.slot, ui.targets, ui.attacks, ui.blocker, ui.blocks, ui.objects, ui.defender, view],
  );

  const onAvatarClick = (id: PlayerId, e: MouseEvent) => {
    const d = decision;
    if (d?.type === 'chooseTargets') {
      const t: Target = { kind: 'player', id };
      if (d.slots.some((s) => s.legal.some((l) => l.kind === 'player' && l.id === id))) return ui.toggleTarget(t, d);
    }
    if (d?.type === 'declareAttackers' && d.candidates.some((c) => c.canAttack.includes(id))) {
      ui.setDefender(id);
      // Re-point already-selected attackers at the new defender where legal.
      for (const [a, t] of Object.entries(ui.attacks)) {
        const c = d.candidates.find((x) => x.id === Number(a));
        if (c && t !== id && c.canAttack.includes(id)) {
          ui.toggleAttacker(Number(a), t);
          ui.toggleAttacker(Number(a), id);
        }
      }
      return;
    }
    ui.setMenu({ kind: 'player', id, x: e.clientX, y: e.clientY });
  };
  const onAvatarContext = (id: PlayerId, e: MouseEvent) => ui.setMenu({ kind: 'player', id, x: e.clientX, y: e.clientY });

  const onStackSelect = (id: number) => {
    const d = decision;
    if (d?.type === 'chooseTargets' && d.slots.some((s) => s.legal.some((l) => l.kind === 'stackItem' && l.id === id))) return ui.toggleTarget({ kind: 'stackItem', id }, d);
    ui.setSelectedStackItem(ui.selectedStackItem === id ? null : id);
  };

  if (!view) {
    return (
      <div className="page">
        <div className="page-inner">
          <h2>Starting game…</h2>
          <p className="muted">Waiting for the first game state.</p>
          <button onClick={sync}>Request sync</button> <button className="ghost" onClick={goHome}>Leave</button>
        </div>
      </div>
    );
  }

  const order = rotateOrder(view.playerOrder, view.you);
  const me = view.players.find((p) => p.id === view.you);
  const opponents = order.slice(1).map((id) => view.players.find((p) => p.id === id)!).filter(Boolean);
  const menuObj = ui.menu?.kind === 'object' ? view.objects[ui.menu.id] : null;
  const compactPhases = typeof window !== 'undefined' && window.innerWidth < 1250;

  return (
    <div className="game" onClick={() => ui.selectedStackItem !== null && ui.setSelectedStackItem(null)}>
      <header className="topbar">
        <button className="ghost sm" onClick={goHome} title="Back to the menu (the game keeps running on the server)">
          ◀ Menu
        </button>
        <span className="turn-info">
          Turn {view.turn.number} · {view.turn.activePlayer === view.you ? 'Your turn' : `${playerName(view, view.turn.activePlayer)}'s turn`}
        </span>
        <PhaseTracker view={view} compact={compactPhases} />
        {mode === 'online' && <span className={`conn-pill ${connStatus}`}>{connStatus}</span>}
        {mode === 'solo' && <span className="conn-pill open">solo</span>}
        <button className="sm" onClick={() => ui.setDialog({ kind: 'token' })} title="Create a token (manual)">
          Token
        </button>
        <button className="sm" onClick={() => ui.setDialog({ kind: 'mana' })} title="Add mana to your pool (manual)">
          Mana
        </button>
        <button className="sm" onClick={() => ui.setDialog({ kind: 'number', title: 'Draw cards', label: 'Count', initial: 1, onSubmit: (n) => manual({ kind: 'draw', count: n }) })} title="Draw cards (manual)">
          Draw
        </button>
        <button className="sm" onClick={() => ui.setDialog({ kind: 'number', title: 'Mill cards', label: 'Count', initial: 1, onSubmit: (n) => manual({ kind: 'mill', count: n }) })} title="Mill cards (manual)">
          Mill
        </button>
        <button className="sm" onClick={() => manual({ kind: 'shuffle' })} title="Shuffle your library (manual)">
          Shuffle
        </button>
        {!me?.lost && !view.over && (
          <button className="sm danger" onClick={() => ui.setDialog({ kind: 'confirmConcede' })}>
            Concede
          </button>
        )}
      </header>

      <main className="table">
        <div className="opponents">
          {opponents.map((p) => (
            <section key={p.id} className={`seat opp ${p.isActive ? 'active' : ''} ${p.lost ? 'lost' : ''}`}>
              <PlayerPanel view={view} player={p} compact legal={highlights.legalPlayers.has(p.id)} selected={highlights.selectedPlayers.has(p.id)} onAvatarClick={onAvatarClick} onAvatarContext={onAvatarContext} onLife={(id, d) => manual({ kind: 'adjustLife', playerId: id, delta: d })} onBrowse={(id, zone) => ui.setBrowse({ player: id, zone })} />
              <Battlefield view={view} controller={p.id} highlights={highlights} decisionActive={decisionActive} handlers={handlers} />
            </section>
          ))}
          {opponents.length === 0 && <div className="muted" style={{ padding: 12 }}>No opponents yet.</div>}
        </div>
        {me && (
          <section className={`seat me ${me.isActive ? 'active' : ''} ${me.lost ? 'lost' : ''}`}>
            <PlayerPanel view={view} player={me} compact={false} legal={highlights.legalPlayers.has(me.id)} selected={highlights.selectedPlayers.has(me.id)} onAvatarClick={onAvatarClick} onAvatarContext={onAvatarContext} onLife={(id, d) => manual({ kind: 'adjustLife', playerId: id, delta: d })} onBrowse={(id, zone) => ui.setBrowse({ player: id, zone })} />
            <Battlefield view={view} controller={me.id} highlights={highlights} decisionActive={decisionActive} handlers={handlers} />
          </section>
        )}
        <Hand view={view} highlights={highlights} decisionActive={decisionActive} handlers={handlers} />
        <DecisionBar view={view} decision={decision} respond={respond} />
        {view.over && (
          <div className="game-over">
            <div className="modal">
              <h2>Game over</h2>
              <p>{view.winner ? `${playerName(view, view.winner)} wins!` : gameOver ? 'Draw.' : 'The game has ended.'}</p>
              <button className="primary" onClick={goHome}>
                Back to menu
              </button>
            </div>
          </div>
        )}
      </main>

      <aside className="sidebar">
        <div className="side-section decision-side">
          <h3>Decision</h3>
          {decision ? (
            <>
              <div className="prompt">{decision.prompt}</div>
              <div className="muted small">{decision.type}</div>
              {(decision as { error?: string }).error && <div className="err">{(decision as { error?: string }).error}</div>}
            </>
          ) : (
            <div className="muted">{view.waitingOn ? `Waiting on ${playerName(view, view.waitingOn)}…` : view.over ? 'Game over' : 'Waiting…'}</div>
          )}
        </div>
        <StackPanel view={view} highlights={highlights} selected={ui.selectedStackItem} onSelect={onStackSelect} />
        <LogPanel view={view} chat={chat} onChat={sendChat} />
      </aside>

      <DecisionModal view={view} decision={decision} respond={respond} handlers={handlers} />
      <CardPreview obj={ui.hover} />
      {ui.menu?.kind === 'object' && menuObj && <ObjectMenu view={view} obj={menuObj} at={ui.menu} decision={decision} onClose={() => ui.setMenu(null)} manual={manual} onCast={(o) => cast(o)} onPlayLand={playLand} onActivate={activate} />}
      {ui.menu?.kind === 'player' && <PlayerMenu view={view} playerId={ui.menu.id} at={ui.menu} onClose={() => ui.setMenu(null)} manual={manual} />}
      {ui.browse && <ZoneBrowser view={view} player={ui.browse.player} zone={ui.browse.zone} highlights={highlights} decisionActive={decisionActive} handlers={handlers} onClose={() => ui.setBrowse(null)} />}
      <Dialogs view={view} manual={manual} onCast={(o, i) => cast(o, i)} onPlayLand={playLand} onConcede={concede} />
    </div>
  );
}

export type { ObjectId };
