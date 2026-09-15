import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Game, viewFor, type CardData, type Decision, type GameConfig, type LogEntry, type PlayerId, type PlayerSetup } from '@commander/engine';
import { scriptFor } from '@commander/cards';
import { encode, type ClientMessage, type DeckPayload, type LobbyPlayer, type LobbyState, type ServerMessage } from '@commander/protocol';
import { canonicalize, fallbackForest, type CardDbLike } from './cards.js';
import { defaultResponse } from './bot.js';
import * as log from './log.js';

export const MAX_SEATS = 6;
export const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
/** Bot decisions answered per event-loop tick before yielding. */
export const BOT_BATCH = 200;
const MAX_CHAT_LENGTH = 500;
const MAX_NAME_LENGTH = 40;
/** Room codes avoid 0/O and 1/I so they can be read out loud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface Seat {
  playerId: PlayerId;
  name: string;
  token: string;
  deck: DeckPayload | null;
  ready: boolean;
  socket: WebSocket | null;
  isBot: boolean;
}

export interface Room {
  id: string;
  hostId: PlayerId;
  seats: Seat[];
  config: Partial<GameConfig>;
  game: Game | null;
  started: boolean;
  createdAt: number;
  /** When the last connected human left; null while any human is connected. */
  emptySince: number | null;
  /** Highest log seq already pushed as an incremental `log` message. */
  lastLogSeq: number;
  botScheduled: boolean;
  gameOverSent: boolean;
  /** Connected spectators (no seat, public view only). */
  spectators: WebSocket[];
  /** Inputs kept for replay. */
  setups: PlayerSetup[] | null;
  /** Repeat detection so a bot cannot spin on a decision the engine keeps re-asking. */
  botLastDecisionId: number;
  botRepeats: number;
}

export interface RoomSummary {
  roomId: string;
  players: number;
  names: string[];
  started: boolean;
}

export interface RoomManagerOptions {
  cardDb: CardDbLike;
  emptyRoomTtlMs?: number;
  botBatch?: number;
  now?: () => number;
}

interface Binding {
  roomId: string;
  playerId: PlayerId;
  spectator?: boolean;
}

class ClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

function send(socket: WebSocket | null, msg: ServerMessage): void {
  if (!socket || socket.readyState !== socket.OPEN) return;
  try {
    socket.send(encode(msg));
  } catch (err) {
    log.error('send failed', err);
  }
}

function cleanName(name: unknown, fallback: string): string {
  const s = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
  return s || fallback;
}

function isCardLike(c: unknown): c is CardData {
  return typeof c === 'object' && c !== null && typeof (c as CardData).name === 'string' && (c as CardData).name.trim().length > 0;
}

/**
 * In-memory room registry. One instance per server; every WebSocket message
 * funnels through `handleMessage`, and `handleClose` detaches sockets while
 * keeping the seat so the player can reconnect with their playerId + token.
 */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly bindings = new Map<WebSocket, Binding>();
  private readonly cardDb: CardDbLike;
  private readonly emptyRoomTtlMs: number;
  private readonly botBatch: number;
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | null;

  constructor(opts: RoomManagerOptions) {
    this.cardDb = opts.cardDb;
    this.emptyRoomTtlMs = opts.emptyRoomTtlMs ?? EMPTY_ROOM_TTL_MS;
    this.botBatch = opts.botBatch ?? BOT_BATCH;
    this.now = opts.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const socket of this.bindings.keys()) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.bindings.clear();
    this.rooms.clear();
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => ({
      roomId: r.id,
      players: r.seats.length,
      names: r.seats.map((s) => s.name),
      started: r.started,
    }));
  }

  /** Delete rooms that have had no connected human for longer than the TTL. */
  sweep(now: number = this.now()): string[] {
    const removed: string[] = [];
    for (const room of this.rooms.values()) {
      const humans = room.seats.filter((s) => !s.isBot);
      const expired = room.emptySince !== null && now - room.emptySince >= this.emptyRoomTtlMs;
      if (humans.length === 0 || expired) {
        this.rooms.delete(room.id);
        removed.push(room.id);
        log.info(`room ${room.id} removed (${humans.length === 0 ? 'no humans' : 'idle'})`);
      }
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  handleMessage(socket: WebSocket, msg: ClientMessage): void {
    try {
      this.dispatch(socket, msg);
    } catch (err) {
      if (err instanceof ClientError) {
        send(socket, { type: 'error', message: err.message, code: err.code });
      } else {
        log.error(`handling ${msg?.type ?? 'message'}`, err);
        send(socket, { type: 'error', message: err instanceof Error ? err.message : String(err), code: 'INTERNAL' });
      }
    }
  }

  handleClose(socket: WebSocket): void {
    const b = this.bindings.get(socket);
    this.bindings.delete(socket);
    if (!b) return;
    const room = this.rooms.get(b.roomId);
    if (!room) return;
    if (b.spectator) {
      room.spectators = room.spectators.filter((w) => w !== socket);
      this.broadcastLobby(room);
      return;
    }
    const seat = room.seats.find((s) => s.playerId === b.playerId);
    if (seat && seat.socket === socket) seat.socket = null;
    this.updateEmptySince(room);
    this.broadcastLobby(room);
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private dispatch(socket: WebSocket, msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') throw new ClientError('Malformed message', 'BAD_MESSAGE');
    switch (msg.type) {
      case 'ping':
        send(socket, { type: 'pong' });
        return;
      case 'createRoom':
        this.createRoom(socket, msg.playerName, msg.config);
        return;
      case 'joinRoom':
        if (msg.spectator) this.spectate(socket, msg.roomId);
        else this.joinRoom(socket, msg.roomId, msg.playerName, msg.playerId, msg.token);
        return;
    }
    // Spectators may only sync, chat or fetch history.
    const b = this.bindings.get(socket);
    if (b?.spectator) {
      const room = this.rooms.get(b.roomId);
      if (!room) throw new ClientError('Room not found', 'ROOM_NOT_FOUND');
      if (msg.type === 'sync') {
        send(socket, { type: 'lobby', lobby: this.lobbyState(room) });
        if (room.game) send(socket, { type: 'view', view: viewFor(room.game, null) });
      } else if (msg.type === 'getHistory') this.sendHistory(socket, room);
      else if (msg.type === 'leaveRoom') {
        room.spectators = room.spectators.filter((w) => w !== socket);
        this.bindings.delete(socket);
        this.broadcastLobby(room);
      } else if (msg.type === 'chat') {
        const text = String(msg.text ?? '').trim().slice(0, 500);
        if (text) for (const w of [...room.seats.map((x) => x.socket), ...room.spectators]) send(w, { type: 'chat', from: 'spectator', name: 'Spectator', text, at: Date.now() });
      }
      return;
    }

    const { room, seat } = this.seatFor(socket);
    switch (msg.type) {
      case 'leaveRoom':
        this.leaveRoom(socket, room, seat);
        return;
      case 'setDeck':
        this.setDeck(room, seat, msg.deck);
        return;
      case 'setReady':
        if (room.started) throw new ClientError('The game has already started', 'GAME_STARTED');
        if (msg.ready && !seat.deck) throw new ClientError('Choose a deck before readying up', 'NO_DECK');
        seat.ready = !!msg.ready;
        this.broadcastLobby(room);
        return;
      case 'updateConfig':
        this.requireHost(room, seat);
        if (room.started) throw new ClientError('The game has already started', 'GAME_STARTED');
        if (!msg.config || typeof msg.config !== 'object') throw new ClientError('Missing config', 'BAD_MESSAGE');
        room.config = { ...room.config, ...msg.config };
        this.broadcastLobby(room);
        return;
      case 'addDummy':
        this.addDummy(room, seat, msg.name);
        return;
      case 'startGame':
        this.startGame(room, seat);
        return;
      case 'decision':
        this.decision(room, seat, msg.decisionId, msg.response);
        return;
      case 'manual': {
        const game = this.requireGame(room);
        if (!msg.action || typeof msg.action !== 'object') throw new ClientError('Missing action', 'BAD_MESSAGE');
        try {
          game.manual(seat.playerId, msg.action);
        } catch (err) {
          throw new ClientError(err instanceof Error ? err.message : String(err), 'MANUAL_FAILED');
        }
        this.broadcastGame(room);
        return;
      }
      case 'concede': {
        const game = this.requireGame(room);
        if (game.state.over) throw new ClientError('The game is over', 'GAME_OVER');
        game.manual(seat.playerId, { kind: 'concede' });
        this.broadcastGame(room);
        return;
      }
      case 'chat': {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, MAX_CHAT_LENGTH) : '';
        if (!text) return;
        const out: ServerMessage = { type: 'chat', from: seat.playerId, name: seat.name, text, at: this.now() };
        for (const s of room.seats) send(s.socket, out);
        return;
      }
      case 'getHistory':
        this.sendHistory(socket, room);
        return;
      case 'sync':
        send(socket, { type: 'lobby', lobby: this.lobbyState(room) });
        if (room.game) send(socket, { type: 'view', view: viewFor(room.game, seat.playerId) });
        return;
      default:
        throw new ClientError(`Unknown message type ${(msg as { type: string }).type}`, 'BAD_MESSAGE');
    }
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  private createRoom(socket: WebSocket, playerName: string, config?: Partial<GameConfig>): void {
    this.detach(socket);
    let id = this.newCode();
    while (this.rooms.has(id)) id = this.newCode();
    const seat = this.newSeat(cleanName(playerName, 'Player 1'), socket, false);
    const room: Room = {
      id,
      hostId: seat.playerId,
      seats: [seat],
      config: config && typeof config === 'object' ? { ...config } : {},
      game: null,
      started: false,
      createdAt: this.now(),
      emptySince: null,
      lastLogSeq: 0,
      botScheduled: false,
      gameOverSent: false,
      botLastDecisionId: -1,
      botRepeats: 0,
      spectators: [],
      setups: null,
    };
    this.rooms.set(id, room);
    this.bindings.set(socket, { roomId: id, playerId: seat.playerId });
    log.info(`room ${id} created by ${seat.name}`);
    send(socket, { type: 'welcome', playerId: seat.playerId, token: seat.token, roomId: id });
    this.broadcastLobby(room);
  }

  private spectate(socket: WebSocket, roomId: string): void {
    const room = this.rooms.get(String(roomId ?? '').trim().toUpperCase());
    if (!room) throw new ClientError('Room not found', 'ROOM_NOT_FOUND');
    this.detach(socket);
    room.spectators.push(socket);
    this.bindings.set(socket, { roomId: room.id, playerId: '', spectator: true });
    send(socket, { type: 'welcome', playerId: '', token: '', roomId: room.id });
    this.broadcastLobby(room);
    if (room.game) send(socket, { type: 'view', view: viewFor(room.game, null) });
    log.info(`room ${room.id}: spectator joined`);
  }

  private sendHistory(socket: WebSocket, room: Room): void {
    if (!room.game || !room.setups) throw new ClientError('No game to replay yet', 'NO_GAME');
    send(socket, { type: 'history', setups: room.setups, config: room.game.config, history: room.game.history });
  }

  private joinRoom(socket: WebSocket, roomId: string, playerName: string, playerId?: PlayerId, token?: string): void {
    const room = this.rooms.get(String(roomId ?? '').trim().toUpperCase());
    if (!room) throw new ClientError('Room not found', 'ROOM_NOT_FOUND');
    this.detach(socket);

    // Reconnect: reclaim the seat and resend everything the client needs.
    if (playerId && token) {
      const seat = room.seats.find((s) => s.playerId === playerId && s.token === token && !s.isBot);
      if (seat) {
        if (seat.socket && seat.socket !== socket) {
          this.bindings.delete(seat.socket);
          try {
            seat.socket.close(4000, 'replaced by a new connection');
          } catch {
            /* ignore */
          }
        }
        seat.socket = socket;
        if (typeof playerName === 'string' && playerName.trim() && !room.started) seat.name = cleanName(playerName, seat.name);
        this.bindings.set(socket, { roomId: room.id, playerId: seat.playerId });
        room.emptySince = null;
        send(socket, { type: 'welcome', playerId: seat.playerId, token: seat.token, roomId: room.id });
        this.broadcastLobby(room);
        if (room.game) send(socket, { type: 'view', view: viewFor(room.game, seat.playerId) });
        log.info(`room ${room.id}: ${seat.name} reconnected`);
        return;
      }
      if (room.started) throw new ClientError('Could not reclaim your seat in a game that has already started', 'RECONNECT_FAILED');
    }

    if (room.started) throw new ClientError('The game has already started', 'GAME_STARTED');
    if (room.seats.length >= MAX_SEATS) throw new ClientError(`Room is full (${MAX_SEATS} seats)`, 'ROOM_FULL');
    const seat = this.newSeat(cleanName(playerName, `Player ${room.seats.length + 1}`), socket, false);
    room.seats.push(seat);
    room.emptySince = null;
    this.bindings.set(socket, { roomId: room.id, playerId: seat.playerId });
    log.info(`room ${room.id}: ${seat.name} joined`);
    send(socket, { type: 'welcome', playerId: seat.playerId, token: seat.token, roomId: room.id });
    this.broadcastLobby(room);
  }

  private leaveRoom(socket: WebSocket, room: Room, seat: Seat): void {
    this.bindings.delete(socket);
    seat.socket = null;
    if (room.game && !room.game.state.over && !room.game.state.players[seat.playerId]?.lost) {
      // Leaving a running game is a concession; the seat stays so the view can still show them.
      room.game.manual(seat.playerId, { kind: 'concede' });
    }
    if (!room.started) {
      room.seats = room.seats.filter((s) => s !== seat);
      if (room.hostId === seat.playerId) {
        const nextHost = room.seats.find((s) => !s.isBot);
        if (nextHost) room.hostId = nextHost.playerId;
      }
    }
    if (room.seats.every((s) => s.isBot)) {
      this.rooms.delete(room.id);
      log.info(`room ${room.id} closed (last human left)`);
      return;
    }
    this.updateEmptySince(room);
    this.broadcastLobby(room);
    if (room.game) this.broadcastGame(room);
  }

  private setDeck(room: Room, seat: Seat, deck: DeckPayload): void {
    if (room.started) throw new ClientError('The game has already started', 'GAME_STARTED');
    if (!deck || typeof deck !== 'object' || !Array.isArray(deck.commanders) || !Array.isArray(deck.mainboard)) {
      throw new ClientError('Deck must have `commanders` and `mainboard` arrays', 'BAD_DECK');
    }
    if (!deck.commanders.every(isCardLike) || !deck.mainboard.every(isCardLike)) throw new ClientError('Every deck entry must be a card with a name', 'BAD_DECK');
    if (deck.commanders.length < 1) throw new ClientError('A deck needs at least one commander', 'BAD_DECK');
    if (deck.mainboard.length < 1) throw new ClientError('A deck needs at least one card in the mainboard', 'BAD_DECK');
    seat.deck = {
      name: cleanName(deck.name, 'Untitled deck'),
      commanders: deck.commanders.map((c) => canonicalize(this.cardDb, c)),
      mainboard: deck.mainboard.map((c) => canonicalize(this.cardDb, c)),
    };
    seat.ready = false;
    this.broadcastLobby(room);
  }

  private addDummy(room: Room, seat: Seat, name?: string): void {
    this.requireHost(room, seat);
    if (room.started) throw new ClientError('The game has already started', 'GAME_STARTED');
    if (room.seats.length >= MAX_SEATS) throw new ClientError(`Room is full (${MAX_SEATS} seats)`, 'ROOM_FULL');
    const bots = room.seats.filter((s) => s.isBot).length;
    const bot = this.newSeat(cleanName(name, `Dummy ${bots + 1}`), null, true);
    const host = room.seats.find((s) => s.playerId === room.hostId);
    bot.deck = host?.deck
      ? { name: host.deck.name, commanders: [...host.deck.commanders], mainboard: [...host.deck.mainboard] }
      : { name: 'Forests', commanders: [], mainboard: Array.from({ length: 40 }, () => fallbackForest(this.cardDb)) };
    bot.ready = true;
    room.seats.push(bot);
    this.broadcastLobby(room);
  }

  private startGame(room: Room, seat: Seat): void {
    this.requireHost(room, seat);
    if (room.started) throw new ClientError('The game has already started', 'GAME_STARTED');
    const missing = room.seats.filter((s) => !s.deck);
    if (missing.length) throw new ClientError(`Waiting on decks from: ${missing.map((s) => s.name).join(', ')}`, 'NO_DECK');
    const setups: PlayerSetup[] = room.seats.map((s) => ({
      id: s.playerId,
      name: s.name,
      deck: { commanders: s.deck!.commanders, mainboard: s.deck!.mainboard },
    }));
    const game = new Game(setups, { seed: randomInt(1, 2 ** 31 - 1), ...room.config }, scriptFor);
    game.start();
    room.game = game;
    room.setups = setups;
    room.started = true;
    room.lastLogSeq = 0;
    room.gameOverSent = false;
    log.info(`room ${room.id}: game started with ${setups.length} players (seed ${game.config.seed})`);
    this.broadcastLobby(room);
    this.broadcastGame(room);
  }

  private decision(room: Room, seat: Seat, decisionId: number, response: unknown): void {
    const game = this.requireGame(room);
    const pending = game.pending;
    if (!pending || pending.id !== decisionId) throw new ClientError('That decision is no longer pending', 'STALE_DECISION');
    if (pending.player !== seat.playerId) throw new ClientError('It is not your decision', 'NOT_YOUR_DECISION');
    if (!response || typeof response !== 'object' || typeof (response as { type?: unknown }).type !== 'string') throw new ClientError('Malformed response', 'BAD_MESSAGE');
    try {
      game.submit(seat.playerId, response as Parameters<Game['submit']>[1]);
    } catch (err) {
      throw new ClientError(err instanceof Error ? err.message : String(err), 'DECISION_FAILED');
    }
    this.broadcastGame(room);
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  lobbyState(room: Room): LobbyState {
    const players: LobbyPlayer[] = room.seats.map((s) => ({
      id: s.playerId,
      name: s.name,
      ready: s.ready,
      deckName: s.deck?.name ?? null,
      deckSize: s.deck ? s.deck.mainboard.length : 0,
      commanders: s.deck ? s.deck.commanders.map((c) => c.name) : [],
      connected: s.isBot || (s.socket !== null && s.socket.readyState === s.socket.OPEN),
      isHost: s.playerId === room.hostId,
    }));
    return { roomId: room.id, players, config: room.config, started: room.started, joinCode: room.id, spectators: room.spectators.filter((w) => w.readyState === w.OPEN).length };
  }

  private broadcastLobby(room: Room): void {
    const msg: ServerMessage = { type: 'lobby', lobby: this.lobbyState(room) };
    for (const s of room.seats) send(s.socket, msg);
    for (const w of room.spectators) send(w, msg);
  }

  /** Push each connected human their own redacted view (never anyone else's), then let bots act. */
  private broadcastGame(room: Room): void {
    const game = room.game;
    if (!game) return;
    const newLog = game.state.log.filter((e) => e.seq > room.lastLogSeq);
    if (newLog.length) room.lastLogSeq = newLog[newLog.length - 1].seq;
    const over = game.state.over && !room.gameOverSent;
    for (const s of room.seats) {
      if (s.isBot || !s.socket) continue;
      send(s.socket, { type: 'view', view: viewFor(game, s.playerId) });
      const visible = newLog.filter((e: LogEntry) => !e.visibleTo || e.visibleTo.includes(s.playerId));
      if (visible.length) send(s.socket, { type: 'log', entries: visible });
      if (over) send(s.socket, { type: 'gameOver', winner: game.state.winner });
    }
    room.spectators = room.spectators.filter((w) => w.readyState === w.OPEN);
    for (const w of room.spectators) {
      send(w, { type: 'view', view: viewFor(game, null) });
      const publicLog = newLog.filter((e: LogEntry) => !e.visibleTo);
      if (publicLog.length) send(w, { type: 'log', entries: publicLog });
      if (over) send(w, { type: 'gameOver', winner: game.state.winner });
    }
    if (over) room.gameOverSent = true;
    this.scheduleBots(room);
  }

  // -------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------

  private botFor(room: Room, d: Decision | null): Seat | null {
    if (!d) return null;
    const s = room.seats.find((x) => x.playerId === d.player);
    return s?.isBot ? s : null;
  }

  private scheduleBots(room: Room): void {
    const game = room.game;
    if (!game || game.state.over || room.botScheduled) return;
    if (!this.botFor(room, game.pending)) return;
    // No point goldfishing for nobody: stop once every player still in the game is a bot.
    const humansAlive = room.seats.some((s) => !s.isBot && !game.state.players[s.playerId]?.lost);
    if (!humansAlive) return;
    room.botScheduled = true;
    setImmediate(() => {
      room.botScheduled = false;
      if (room.game !== game || !this.rooms.has(room.id)) return;
      this.runBots(room, game);
      this.broadcastGame(room);
    });
  }

  private runBots(room: Room, game: Game): void {
    for (let n = 0; n < this.botBatch && !game.state.over; n++) {
      const d = game.pending;
      const bot = this.botFor(room, d);
      if (!d || !bot) return;
      if (d.id === room.botLastDecisionId) room.botRepeats++;
      else {
        room.botLastDecisionId = d.id;
        room.botRepeats = 0;
      }
      try {
        if (room.botRepeats >= 8) {
          // The engine keeps re-asking; the default answer is not acceptable here. Give up on this seat.
          log.warn(`room ${room.id}: bot ${bot.name} stuck on ${d.type} decision ${d.id}; conceding`);
          game.manual(bot.playerId, { kind: 'concede' });
        } else if (room.botRepeats >= 4) {
          game.submit(bot.playerId, { type: 'cancel' });
        } else {
          game.submit(bot.playerId, defaultResponse(d));
        }
      } catch (err) {
        log.error(`room ${room.id}: bot ${bot.name} failed to answer ${d.type}`, err);
        game.manual(bot.playerId, { kind: 'concede' });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private seatFor(socket: WebSocket): { room: Room; seat: Seat } {
    const b = this.bindings.get(socket);
    const room = b && this.rooms.get(b.roomId);
    const seat = room?.seats.find((s) => s.playerId === b!.playerId);
    if (!b || !room || !seat) throw new ClientError('Join a room first', 'NOT_IN_ROOM');
    return { room, seat };
  }

  private requireHost(room: Room, seat: Seat): void {
    if (room.hostId !== seat.playerId) throw new ClientError('Only the host can do that', 'NOT_HOST');
  }

  private requireGame(room: Room): Game {
    if (!room.game) throw new ClientError('The game has not started', 'NOT_STARTED');
    return room.game;
  }

  /** Remove any existing binding for this socket (used when a socket creates/joins another room). */
  private detach(socket: WebSocket): void {
    if (this.bindings.has(socket)) this.handleClose(socket);
  }

  private updateEmptySince(room: Room): void {
    const anyHuman = room.seats.some((s) => !s.isBot && s.socket && s.socket.readyState === s.socket.OPEN);
    room.emptySince = anyHuman ? null : room.emptySince ?? this.now();
  }

  private newSeat(name: string, socket: WebSocket | null, isBot: boolean): Seat {
    return { playerId: randomUUID(), name, token: randomBytes(16).toString('hex'), deck: null, ready: false, socket, isBot };
  }

  private newCode(): string {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return code;
  }
}
