import { create } from 'zustand';
import type { GameView, GameConfig, ManualAction, Response, PlayerId, LogEntry } from '@commander/engine';
import type { ClientMessage, ServerMessage, LobbyState, DeckPayload } from '@commander/protocol';
import { Game, viewFor, type PlayerSetup } from '@commander/engine';
import { scriptFor } from '@commander/cards';
import { LocalConnection, WebSocketConnection, type GameConnection, type ConnectionStatus } from '../lib/connection.js';
import { loadPlayerName, savePlayerName, saveRoomCredentials, loadRoomCredentials, clearRoomCredentials } from '../lib/storage.js';
import { saveRecentDeck } from '../lib/deck.js';
import { rememberCard } from '../lib/scryfall.js';

export type Screen = 'home' | 'deck' | 'lobby' | 'game';
export type Mode = 'solo' | 'online';

export interface Toast {
  id: number;
  kind: 'info' | 'trigger' | 'turn' | 'error' | 'success';
  text: string;
  at: number;
}

export interface ChatMessage {
  from: PlayerId;
  name: string;
  text: string;
  at: number;
}

interface AppState {
  screen: Screen;
  mode: Mode | null;
  playerName: string;
  connection: GameConnection | null;
  connStatus: ConnectionStatus | 'idle';
  roomId: string | null;
  playerId: PlayerId | null;
  token: string | null;
  lobby: LobbyState | null;
  view: GameView | null;
  deck: DeckPayload | null;
  toasts: Toast[];
  chat: ChatMessage[];
  gameOver: { winner: PlayerId | null } | null;
  /** Where to return after picking a deck. */
  deckReturnTo: Screen;
  lastLogSeq: number;
  lastDecisionError: string | null;

  setPlayerName(name: string): void;
  goHome(): void;
  openDeckPicker(returnTo?: Screen): void;
  startSolo(): void;
  createRoom(): void;
  joinRoom(code: string, spectator?: boolean): void;
  /** Replay viewer state: rebuilt locally from the decision history. */
  replay: { setups: PlayerSetup[]; config: Partial<GameConfig>; history: { player: PlayerId; response: Response }[]; index: number; playing: boolean } | null;
  startReplay(): void;
  replaySeek(index: number): void;
  replayPlay(playing: boolean): void;
  exitReplay(): void;
  leave(): void;
  chooseDeck(deck: DeckPayload): void;
  setReady(ready: boolean): void;
  startGame(): void;
  addBot(name?: string): void;
  updateConfig(config: Partial<GameConfig>): void;
  respond(response: Response): void;
  manual(action: ManualAction): void;
  concede(): void;
  sendChat(text: string): void;
  sync(): void;
  addToast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  send(msg: ClientMessage): void;
}

let toastSeq = 1;
const TOAST_LIMIT = 6;

function deriveToasts(prev: GameView | null, next: GameView, lastSeq: number): { toasts: Omit<Toast, 'id' | 'at'>[]; seq: number } {
  const out: Omit<Toast, 'id' | 'at'>[] = [];
  let seq = lastSeq;
  const fresh = next.log.filter((l) => l.seq > lastSeq);
  for (const l of fresh) seq = Math.max(seq, l.seq);
  if (!prev) return { toasts: out, seq };
  for (const l of fresh) {
    if (l.kind === 'trigger') out.push({ kind: 'trigger', text: l.text });
    else if (l.kind === 'turn' && (l.data as { player?: string } | undefined)?.player === next.you) out.push({ kind: 'turn', text: 'Your turn' });
    else if (l.kind === 'win' || l.kind === 'loss') out.push({ kind: 'info', text: l.text });
  }
  return { toasts: out.slice(-4), seq };
}

function decisionError(view: GameView): string | null {
  const d = view.decision as (typeof view.decision & { error?: string }) | null;
  return d?.error ?? null;
}

export const useStore = create<AppState>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  function teardown() {
    unsubscribe?.();
    unsubscribe = null;
    get().connection?.close();
  }

  function attach(conn: GameConnection, mode: Mode) {
    teardown();
    unsubscribe = conn.subscribe(handle);
    set({ connection: conn, mode, connStatus: mode === 'solo' ? 'open' : 'connecting', lobby: null, view: null, gameOver: null, chat: [], lastLogSeq: -1, lastDecisionError: null });
  }

  function handle(msg: ServerMessage) {
    const s = get();
    switch (msg.type) {
      case 'welcome': {
        set({ playerId: msg.playerId, token: msg.token, roomId: msg.roomId });
        if (s.mode === 'online') {
          saveRoomCredentials({ roomId: msg.roomId, playerId: msg.playerId, token: msg.token, name: s.playerName, savedAt: Date.now() });
          try {
            const url = new URL(location.href);
            url.searchParams.set('room', msg.roomId);
            history.replaceState(null, '', url.toString());
          } catch {
            /* ignore */
          }
        }
        return;
      }
      case 'lobby': {
        const patch: Partial<AppState> = { lobby: msg.lobby, roomId: msg.lobby.roomId };
        if (s.screen === 'home' || (s.screen === 'game' && !msg.lobby.started && !s.view)) patch.screen = 'lobby';
        set(patch);
        return;
      }
      case 'view': {
        if (s.replay) return; // replay viewer owns the view until exited
        const { toasts, seq } = deriveToasts(s.view, msg.view, s.lastLogSeq);
        const err = decisionError(msg.view);
        const patch: Partial<AppState> = { view: msg.view, lastLogSeq: seq, screen: 'game' };
        if (err && err !== s.lastDecisionError) toasts.push({ kind: 'error', text: err });
        patch.lastDecisionError = err;
        if (toasts.length) {
          // A new "Your turn" replaces the previous one: in a quick game they piled up down the side.
          const kept = toasts.some((t) => t.kind === 'turn') ? s.toasts.filter((t) => t.kind !== 'turn') : s.toasts;
          patch.toasts = [...kept, ...toasts.map((t) => ({ ...t, id: toastSeq++, at: Date.now() }))].slice(-TOAST_LIMIT);
        }
        // Learn card data for previews / printed P/T comparisons.
        set(patch);
        return;
      }
      case 'error':
        get().addToast('error', msg.message);
        return;
      case 'gameOver':
        set({ gameOver: { winner: msg.winner } });
        return;
      case 'history': {
        const index = msg.history.length;
        set({ replay: { setups: msg.setups, config: msg.config, history: msg.history, index, playing: false }, view: replayView(msg.setups, msg.config, msg.history, index), screen: 'game' });
        return;
      }
      case 'chat':
        set({ chat: [...s.chat, { from: msg.from, name: msg.name, text: msg.text, at: msg.at }].slice(-200) });
        return;
      case 'log':
      case 'pong':
      default:
        return;
    }
  }

  /** Rebuild the game up to `index` decisions and return the public (spectator) view. */
function replayView(setups: PlayerSetup[], config: Partial<GameConfig>, history: { player: PlayerId; response: Response }[], index: number): GameView {
  const g = Game.replay(setups, config, history.slice(0, index), scriptFor);
  return viewFor(g, null);
}

function connectOnline(onOpen: () => void): WebSocketConnection {
    const conn = new WebSocketConnection({
      onStatus: (status) => set({ connStatus: status }),
      onOpen: (reconnect) => {
        if (!reconnect) return onOpen();
        // Reclaim our seat after a drop.
        const s = get();
        if (s.roomId && s.playerId) {
          conn.send({ type: 'joinRoom', roomId: s.roomId, playerName: s.playerName, playerId: s.playerId, token: s.token ?? undefined });
          conn.send({ type: 'sync' });
          get().addToast('info', 'Reconnected');
        }
      },
    });
    return conn;
  }

  return {
    screen: 'home',
    mode: null,
    playerName: loadPlayerName(),
    connection: null,
    connStatus: 'idle',
    roomId: null,
    playerId: null,
    token: null,
    lobby: null,
    view: null,
    deck: null,
    toasts: [],
    chat: [],
    gameOver: null,
    replay: null,
    deckReturnTo: 'lobby',
    lastLogSeq: -1,
    lastDecisionError: null,

    setPlayerName(name) {
      savePlayerName(name);
      set({ playerName: name });
    },
    goHome() {
      teardown();
      set({ screen: 'home', connection: null, mode: null, connStatus: 'idle', lobby: null, view: null, roomId: null, playerId: null, token: null, gameOver: null });
      try {
        const url = new URL(location.href);
        url.searchParams.delete('room');
        history.replaceState(null, '', url.toString());
      } catch {
        /* ignore */
      }
    },
    openDeckPicker(returnTo) {
      set({ screen: 'deck', deckReturnTo: returnTo ?? (get().lobby ? 'lobby' : 'home') });
    },
    startSolo() {
      const s = get();
      const params = new URLSearchParams(location.search);
      const seed = params.get('seed');
      const botDelay = params.get('botDelay');
      const conn = new LocalConnection({ seed: seed ? Number(seed) : undefined, botDelayMs: botDelay ? Number(botDelay) : undefined });
      attach(conn, 'solo');
      set({ screen: 'lobby' });
      conn.send({ type: 'createRoom', playerName: s.playerName || 'You' });
      if (s.deck) conn.send({ type: 'setDeck', deck: s.deck });
      conn.send({ type: 'addDummy' });
    },
    createRoom() {
      const s = get();
      const conn = connectOnline(() => {
        conn.send({ type: 'createRoom', playerName: s.playerName || 'Player' });
        const d = get().deck;
        if (d) conn.send({ type: 'setDeck', deck: d });
      });
      attach(conn, 'online');
      set({ screen: 'lobby' });
    },
    joinRoom(code, spectator = false) {
      const s = get();
      const roomId = code.trim().toUpperCase();
      if (!roomId) return;
      const creds = spectator ? null : loadRoomCredentials(roomId);
      const conn = connectOnline(() => {
        conn.send({ type: 'joinRoom', roomId, playerName: s.playerName || creds?.name || 'Player', playerId: creds?.playerId, token: creds?.token, spectator: spectator || undefined });
        const d = get().deck;
        if (d && !spectator) conn.send({ type: 'setDeck', deck: d });
      });
      attach(conn, 'online');
      set({ screen: 'lobby', roomId });
    },
    startReplay() {
      get().connection?.send({ type: 'getHistory' });
    },
    replaySeek(index) {
      const r = get().replay;
      if (!r) return;
      const i = Math.max(0, Math.min(r.history.length, index));
      set({ replay: { ...r, index: i }, view: replayView(r.setups, r.config, r.history, i) });
    },
    replayPlay(playing) {
      const r = get().replay;
      if (!r) return;
      set({ replay: { ...r, playing } });
      if (playing) {
        const tick = () => {
          const cur = get().replay;
          if (!cur || !cur.playing) return;
          if (cur.index >= cur.history.length) {
            set({ replay: { ...cur, playing: false } });
            return;
          }
          get().replaySeek(cur.index + 1);
          setTimeout(tick, 350);
        };
        setTimeout(tick, 350);
      }
    },
    exitReplay() {
      set({ replay: null });
      get().sync();
    },
    leave() {
      const s = get();
      s.connection?.send({ type: 'leaveRoom' });
      if (s.roomId && s.mode === 'online') clearRoomCredentials(s.roomId);
      get().goHome();
    },
    chooseDeck(deck) {
      for (const c of [...deck.commanders, ...deck.mainboard]) rememberCard(c);
      saveRecentDeck(deck);
      const s = get();
      set({ deck, screen: s.connection ? 'lobby' : s.deckReturnTo === 'deck' ? 'home' : s.deckReturnTo });
      s.connection?.send({ type: 'setDeck', deck });
    },
    setReady(ready) {
      get().connection?.send({ type: 'setReady', ready });
    },
    startGame() {
      get().connection?.send({ type: 'startGame' });
    },
    addBot(name) {
      get().connection?.send({ type: 'addDummy', name });
    },
    updateConfig(config) {
      get().connection?.send({ type: 'updateConfig', config });
    },
    respond(response) {
      const s = get();
      const d = s.view?.decision;
      if (!d || !s.connection) return;
      s.connection.send({ type: 'decision', decisionId: d.id, response });
    },
    manual(action) {
      get().connection?.send({ type: 'manual', action });
    },
    concede() {
      get().connection?.send({ type: 'concede' });
    },
    sendChat(text) {
      if (text.trim()) get().connection?.send({ type: 'chat', text: text.trim() });
    },
    sync() {
      get().connection?.send({ type: 'sync' });
    },
    addToast(kind, text) {
      set((s) => ({ toasts: [...s.toasts, { id: toastSeq++, kind, text, at: Date.now() }].slice(-TOAST_LIMIT) }));
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    send(msg) {
      get().connection?.send(msg);
    },
  };
});

/** Log entries the current viewer has not seen yet (used by the log panel to mark new lines). */
export function newLogEntries(view: GameView, since: number): LogEntry[] {
  return view.log.filter((l) => l.seq > since);
}
