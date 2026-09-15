/**
 * The board never knows whether it is talking to a server or to an engine
 * running in this tab: both implement GameConnection.
 */
import { Game, viewFor, type Decision, type GameConfig, type GameView, type PlayerId, type PlayerSetup, type Response } from '@commander/engine';
import { scriptFor } from '@commander/cards';
import type { ClientMessage, ServerMessage, LobbyState, LobbyPlayer, DeckPayload } from '@commander/protocol';
import { WS_PATH } from '@commander/protocol';
import { botAnswer, seededRng } from './bots.js';
import { basicLandDeck, cloneDeck, deckSize } from './deck.js';

export interface GameConnection {
  subscribe(cb: (msg: ServerMessage) => void): () => void;
  send(msg: ClientMessage): void;
  close(): void;
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export interface WebSocketConnectionOptions {
  url?: string;
  onStatus?: (status: ConnectionStatus, attempt: number) => void;
  /** Called on every successful (re)connect; `reconnect` is false for the first open. */
  onOpen?: (reconnect: boolean) => void;
}

export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${WS_PATH}`;
}

export class WebSocketConnection implements GameConnection {
  private ws: WebSocket | null = null;
  private subs = new Set<(msg: ServerMessage) => void>();
  private queue: string[] = [];
  private closed = false;
  private attempt = 0;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  readonly url: string;

  constructor(private opts: WebSocketConnectionOptions = {}) {
    this.url = opts.url ?? defaultWsUrl();
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.opts.onStatus?.(this.attempt === 0 ? 'connecting' : 'reconnecting', this.attempt);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      const reconnect = this.opened;
      this.opened = true;
      this.attempt = 0;
      this.opts.onStatus?.('open', 0);
      for (const m of this.queue) ws.send(m);
      this.queue = [];
      this.opts.onOpen?.(reconnect);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      this.emit(msg);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (this.closed) {
        this.opts.onStatus?.('closed', 0);
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (this.closed || this.timer) return;
    this.attempt++;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempt, 5));
    this.opts.onStatus?.('reconnecting', this.attempt);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private emit(msg: ServerMessage) {
    for (const cb of Array.from(this.subs)) {
      try {
        cb(msg);
      } catch (e) {
        console.error('subscriber failed', e);
      }
    }
  }

  subscribe(cb: (msg: ServerMessage) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (msg.type !== 'ping') this.queue.push(data);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.timer = null;
    this.pingTimer = null;
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    this.opts.onStatus?.('closed', 0);
  }
}

// ---------------------------------------------------------------------------
// Local (solo / goldfish): the engine runs in this tab, bots answer on a timer.
// ---------------------------------------------------------------------------

interface LocalSeat {
  id: PlayerId;
  name: string;
  deck: DeckPayload | null;
  ready: boolean;
  isBot: boolean;
}

const BOT_NAMES = ['Goldfish', 'Sparky', 'Rakdos Bot', 'Bot Simic', 'Iron Golem', 'Merfolk Trickster'];

export interface LocalConnectionOptions {
  /** Delay before a bot answers a decision, so the board visibly changes. */
  botDelayMs?: number;
  seed?: number;
}

export class LocalConnection implements GameConnection {
  private subs = new Set<(msg: ServerMessage) => void>();
  private seats: LocalSeat[] = [];
  private humanId: PlayerId = 'you';
  private roomId = 'SOLO';
  private config: Partial<GameConfig> = { startingLife: 40 };
  private started = false;
  private game: Game | null = null;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledFor: number | null = null;
  private attempts = new Map<number, number>();
  private botIds = new Set<PlayerId>();
  private rng: () => number;
  private closed = false;
  private gameOverSent = false;
  private viewQueued = false;

  constructor(private opts: LocalConnectionOptions = {}) {
    this.rng = seededRng(opts.seed ?? (Date.now() & 0xffffffff));
  }

  subscribe(cb: (msg: ServerMessage) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(msg: ServerMessage) {
    if (this.closed) return;
    for (const cb of Array.from(this.subs)) {
      try {
        cb(msg);
      } catch (e) {
        console.error('subscriber failed', e);
      }
    }
  }

  private error(message: string, code?: string) {
    this.emit({ type: 'error', message, code });
  }

  private lobbyState(): LobbyState {
    const players: LobbyPlayer[] = this.seats.map((s, i) => ({
      id: s.id,
      name: s.name,
      ready: s.isBot ? true : s.ready,
      deckName: s.deck?.name ?? (s.isBot ? 'Copy of your deck' : null),
      deckSize: s.deck ? deckSize(s.deck) : 0,
      commanders: s.deck?.commanders.map((c) => c.name) ?? [],
      connected: true,
      isHost: i === 0,
    }));
    return { roomId: this.roomId, players, config: { ...this.config }, started: this.started, joinCode: this.roomId };
  }

  private emitLobby() {
    this.emit({ type: 'lobby', lobby: this.lobbyState() });
  }

  private emitView() {
    if (!this.game || this.viewQueued) return;
    this.viewQueued = true;
    queueMicrotask(() => {
      this.viewQueued = false;
      if (!this.game || this.closed) return;
      let view: GameView;
      try {
        view = viewFor(this.game, this.humanId);
      } catch (e) {
        this.error(`Could not build view: ${(e as Error).message}`);
        return;
      }
      this.emit({ type: 'view', view });
      if (view.over && !this.gameOverSent) {
        this.gameOverSent = true;
        this.emit({ type: 'gameOver', winner: view.winner });
      }
      this.scheduleBots();
    });
  }

  private scheduleBots() {
    const g = this.game;
    if (!g || !g.pending || g.state.over) return;
    const d = g.pending;
    if (!this.botIds.has(d.player)) return;
    if (this.botTimer && this.scheduledFor === d.id) return;
    if (this.botTimer) clearTimeout(this.botTimer);
    this.scheduledFor = d.id;
    const attempts = this.attempts.get(d.id) ?? 0;
    // First answer waits a beat so humans see what happened; retries are immediate.
    const delay = attempts === 0 ? this.opts.botDelayMs ?? 350 : 0;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.scheduledFor = null;
      this.answerBot(d);
    }, delay);
  }

  private answerBot(d: Decision) {
    const g = this.game;
    if (!g || g.pending !== d || g.state.over) return;
    const attempts = this.attempts.get(d.id) ?? 0;
    this.attempts.set(d.id, attempts + 1);
    if (attempts > 6) {
      // Something is badly wrong; concede this seat rather than spin forever.
      try {
        g.manual(d.player, { kind: 'concede' });
      } catch (e) {
        this.error(`Bot ${d.player} is stuck: ${(e as Error).message}`);
      }
      return;
    }
    let response: Response;
    try {
      response = botAnswer(d, { view: viewFor(g, d.player), botIds: this.botIds, attempts, rng: this.rng });
    } catch {
      response = { type: 'pass' };
    }
    try {
      g.submit(d.player, response);
    } catch (e) {
      this.error(`Bot error: ${(e as Error).message}`);
    }
    // If the engine re-asked the same decision (invalid answer), onChange already re-scheduled us.
    if (this.attempts.size > 500) {
      for (const k of Array.from(this.attempts.keys()).slice(0, 250)) this.attempts.delete(k);
    }
  }

  private humanSeat(): LocalSeat | undefined {
    return this.seats.find((s) => s.id === this.humanId);
  }

  private startGame() {
    if (this.started) return this.error('Game already started');
    const human = this.humanSeat();
    if (!human?.deck || human.deck.mainboard.length === 0) return this.error('Pick a deck before starting.', 'noDeck');
    const setups: PlayerSetup[] = this.seats.map((s) => {
      const deck = s.deck ?? (s.isBot ? cloneDeck(human.deck!, `${s.name}'s copy`) : basicLandDeck());
      return { id: s.id, name: s.name, deck: { commanders: deck.commanders, mainboard: deck.mainboard } };
    });
    const seed = this.config.seed ?? Math.floor(this.rng() * 2 ** 31);
    let game: Game;
    try {
      game = new Game(setups, { ...this.config, seed }, scriptFor);
    } catch (e) {
      return this.error(`Could not create game: ${(e as Error).message}`);
    }
    this.game = game;
    this.started = true;
    game.onChange = () => this.emitView();
    this.emitLobby();
    try {
      game.start();
    } catch (e) {
      this.error(`Engine error on start: ${(e as Error).message}`);
    }
    this.emitView();
  }

  send(msg: ClientMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'createRoom':
      case 'joinRoom': {
        if (this.seats.length === 0) {
          this.humanId = 'you';
          this.seats.push({ id: this.humanId, name: msg.playerName || 'You', deck: null, ready: false, isBot: false });
        } else {
          const h = this.humanSeat();
          if (h && msg.playerName) h.name = msg.playerName;
        }
        if (msg.type === 'createRoom' && msg.config) this.config = { ...this.config, ...msg.config };
        this.emit({ type: 'welcome', playerId: this.humanId, token: 'local', roomId: this.roomId });
        this.emitLobby();
        if (this.game) this.emitView();
        return;
      }
      case 'leaveRoom':
        this.close();
        return;
      case 'setDeck': {
        const h = this.humanSeat();
        if (!h) return this.error('Join first');
        h.deck = msg.deck;
        this.emitLobby();
        return;
      }
      case 'setReady': {
        const h = this.humanSeat();
        if (h) h.ready = msg.ready;
        this.emitLobby();
        return;
      }
      case 'updateConfig':
        this.config = { ...this.config, ...msg.config };
        this.emitLobby();
        return;
      case 'addDummy': {
        if (this.started) return this.error('Game already started');
        if (this.seats.length >= 6) return this.error('Room is full (6 seats)');
        const n = this.seats.filter((s) => s.isBot).length;
        const id = `bot${n + 1}`;
        this.seats.push({ id, name: msg.name || BOT_NAMES[n % BOT_NAMES.length], deck: null, ready: true, isBot: true });
        this.botIds.add(id);
        this.emitLobby();
        return;
      }
      case 'startGame':
        this.startGame();
        return;
      case 'decision': {
        const g = this.game;
        if (!g) return this.error('No game in progress');
        if (!g.pending) return this.error('Nothing to decide right now');
        if (g.pending.player !== this.humanId) return this.error(`Waiting on ${g.pending.player}`);
        if (msg.decisionId !== g.pending.id) {
          // Stale response from a previous render; resend the view so the client catches up.
          this.emitView();
          return;
        }
        try {
          g.submit(this.humanId, msg.response);
        } catch (e) {
          this.error(`Engine error: ${(e as Error).message}`, 'engine');
          this.emitView();
        }
        return;
      }
      case 'manual': {
        const g = this.game;
        if (!g) return this.error('No game in progress');
        try {
          g.manual(this.humanId, msg.action);
        } catch (e) {
          this.error(`Engine error: ${(e as Error).message}`, 'engine');
          this.emitView();
        }
        return;
      }
      case 'concede': {
        const g = this.game;
        if (!g) return;
        try {
          g.manual(this.humanId, { kind: 'concede' });
        } catch (e) {
          this.error(`Engine error: ${(e as Error).message}`);
        }
        return;
      }
      case 'sync':
        this.emitLobby();
        this.emitView();
        return;
      case 'chat':
        this.emit({ type: 'chat', from: this.humanId, name: this.humanSeat()?.name ?? 'You', text: msg.text, at: Date.now() });
        return;
      case 'ping':
        this.emit({ type: 'pong' });
        return;
      default:
        return;
    }
  }

  close(): void {
    this.closed = true;
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.game) this.game.onChange = null;
    this.game = null;
    this.subs.clear();
  }
}
