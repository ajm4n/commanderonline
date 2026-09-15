import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadFixtureDb } from '@commander/cards/node';
import type { CardData, GameView } from '@commander/engine';
import { WS_PATH, type ClientMessage, type DeckPayload, type ServerMessage } from '@commander/protocol';
import { createServer, type RunningServer } from '../src/server.js';
import { RoomManager } from '../src/rooms.js';

const db = loadFixtureDb();
let server: RunningServer;
let base: string;
let wsUrl: string;

beforeAll(async () => {
  server = await createServer({ cardDb: db, port: 0, staticDir: null, fixture: true });
  base = `http://127.0.0.1:${server.port}`;
  wsUrl = `ws://127.0.0.1:${server.port}${WS_PATH}`;
});

afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function must(card: CardData | undefined, name: string): CardData {
  if (!card) throw new Error(`fixture is missing ${name}`);
  return card;
}

function forestDeck(commanderName = 'Ezuri, Renegade Leader'): DeckPayload {
  const forest = must(db.byName('Forest'), 'Forest');
  return {
    name: 'Forests',
    commanders: [must(db.byName(commanderName), commanderName)],
    mainboard: Array.from({ length: 40 }, () => forest),
  };
}

/** A tiny test client that records every server message and lets tests await specific ones. */
class Client {
  ws!: WebSocket;
  messages: ServerMessage[] = [];
  playerId = '';
  token = '';
  roomId = '';
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  static async connect(): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(wsUrl);
    c.ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMessage;
      c.messages.push(m);
      if (m.type === 'welcome') {
        c.playerId = m.playerId;
        c.token = m.token;
        c.roomId = m.roomId;
      }
      for (const w of [...c.waiters]) {
        if (w.pred(m)) {
          c.waiters.splice(c.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', () => resolve());
      c.ws.once('error', reject);
    });
    return c;
  }

  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Resolve with the next message matching `pred` (including ones already received when `includePast`). */
  next<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 5000): Promise<Extract<ServerMessage, { type: T }>> {
    const full = (m: ServerMessage): boolean => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}; got ${this.messages.map((m) => m.type).join(',')}`)), timeoutMs);
      this.waiters.push({
        pred: full,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  /** Send and await a reply of the given type. */
  async request<T extends ServerMessage['type']>(m: ClientMessage, type: T, pred?: (m: Extract<ServerMessage, { type: T }>) => boolean): Promise<Extract<ServerMessage, { type: T }>> {
    const p = this.next(type, pred);
    this.send(m);
    return p;
  }

  lastView(): GameView | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.type === 'view') return m.view;
    }
    return undefined;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

describe('http api', () => {
  it('reports health with card and room counts', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cards).toBe(db.size);
    expect(typeof body.rooms).toBe('number');
  });

  it('imports a text decklist, expands quantities and reports missing cards', async () => {
    const text = ['Commander', '1 Krenko, Mob Boss', '', 'Deck', '3 Mountain', '2 Sol Ring', '1 Totally Made Up Card'].join('\n');
    const res = await fetch(`${base}/api/deck/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commanders.map((c: CardData) => c.name)).toEqual(['Krenko, Mob Boss']);
    expect(body.mainboard.filter((c: CardData) => c.name === 'Mountain')).toHaveLength(3);
    expect(body.missing).toContain('Totally Made Up Card');
    // Running on the fixture DB adds a warning telling the user to fetch the full pool.
    expect(body.warnings.some((w: string) => w.includes('pnpm cards:fetch'))).toBe(true);
  });

  it('rejects an import with neither url nor text', async () => {
    const res = await fetch(`${base}/api/deck/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/url|text/);
  });

  it('searches and resolves cards', async () => {
    const search = await (await fetch(`${base}/api/cards/search?q=kren`)).json();
    expect(search.cards.map((c: CardData) => c.name)).toContain('Krenko, Mob Boss');

    const res = await fetch(`${base}/api/cards/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: ['Forest', 'Nope Nope Nope'] }) });
    const body = await res.json();
    expect(body.cards.Forest.name).toBe('Forest');
    expect(body.missing).toEqual(['Nope Nope Nope']);
  });

  it('serves 404 JSON for unknown routes and handles CORS preflight', async () => {
    const opt = await fetch(`${base}/api/health`, { method: 'OPTIONS' });
    expect(opt.status).toBe(204);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Rooms over WebSocket
// ---------------------------------------------------------------------------

describe('rooms', () => {
  it('answers ping with pong', async () => {
    const c = await Client.connect();
    const pong = await c.request({ type: 'ping' }, 'pong');
    expect(pong.type).toBe('pong');
    await c.close();
  });

  it('runs a two-human lobby through to a started game with private views', async () => {
    const host = await Client.connect();
    const guest = await Client.connect();

    await host.request({ type: 'createRoom', playerName: 'Alice' }, 'welcome');
    expect(host.roomId).toMatch(/^[A-Z0-9]{6}$/);

    const lobby1 = await guest.request({ type: 'joinRoom', roomId: host.roomId, playerName: 'Bob' }, 'lobby');
    expect(lobby1.lobby.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(lobby1.lobby.players[0].isHost).toBe(true);

    // Rooms are listed over HTTP.
    const rooms = await (await fetch(`${base}/api/rooms`)).json();
    expect(rooms).toContainEqual({ roomId: host.roomId, players: 2, names: ['Alice', 'Bob'], started: false });

    // Ready without a deck is refused.
    const err = await guest.request({ type: 'setReady', ready: true }, 'error');
    expect(err.code).toBe('NO_DECK');

    const hostLobby = await host.request({ type: 'setDeck', deck: forestDeck('Ezuri, Renegade Leader') }, 'lobby', (m) => m.lobby.players[0].deckSize === 40);
    expect(hostLobby.lobby.players[0].commanders).toEqual(['Ezuri, Renegade Leader']);
    await guest.request({ type: 'setDeck', deck: forestDeck('Krenko, Mob Boss') }, 'lobby', (m) => m.lobby.players[1].deckSize === 40);
    await host.request({ type: 'setReady', ready: true }, 'lobby', (m) => m.lobby.players[0].ready);
    await guest.request({ type: 'setReady', ready: true }, 'lobby', (m) => m.lobby.players[1].ready);

    // Only the host may start.
    const notHost = await guest.request({ type: 'startGame' }, 'error');
    expect(notHost.code).toBe('NOT_HOST');

    const [hostView, guestView] = await Promise.all([host.next('view'), guest.next('view'), host.request({ type: 'startGame' }, 'lobby', (m) => m.lobby.started)]);
    expect(hostView.view.you).toBe(host.playerId);
    expect(guestView.view.you).toBe(guest.playerId);

    // Exactly one player holds the first (mulligan) decision; the other sees null and waitingOn.
    const first = hostView.view.waitingOn;
    expect(first).toBeTruthy();
    const [chooser, other] = first === host.playerId ? [host, guest] : [guest, host];
    const chooserView = chooser.lastView()!;
    const otherView = other.lastView()!;
    expect(chooserView.decision?.type).toBe('mulligan');
    expect(chooserView.decision?.player).toBe(chooser.playerId);
    expect(otherView.decision).toBeNull();
    expect(otherView.waitingOn).toBe(chooser.playerId);

    // Hidden information: each player sees their own hand but only the count of the opponent's.
    const me = chooserView.players.find((p) => p.id === chooser.playerId)!;
    expect(me.hand).toHaveLength(7);
    for (const id of me.hand!) expect(chooserView.objects[id]?.name).toBeTruthy();
    const hidden = chooserView.players.find((p) => p.id === other.playerId)!;
    expect(hidden.hand).toBeNull();
    expect(hidden.handCount).toBe(7);
    const otherMe = otherView.players.find((p) => p.id === other.playerId)!;
    expect(otherMe.hand).toHaveLength(7);
    expect(otherView.players.find((p) => p.id === chooser.playerId)!.hand).toBeNull();

    // A decision sent by the wrong player is rejected.
    const wrong = await other.request({ type: 'decision', decisionId: chooserView.decision!.id, response: { type: 'mulligan', keep: true } }, 'error');
    expect(wrong.code).toBe('NOT_YOUR_DECISION');

    // Answer the mulligan; the next view moves the decision to the other player.
    const [v1, v2] = await Promise.all([chooser.next('view'), other.next('view'), chooser.send({ type: 'decision', decisionId: chooserView.decision!.id, response: { type: 'mulligan', keep: true } })]);
    expect(v1.view.decision).toBeNull();
    expect(v2.view.decision?.type).toBe('mulligan');
    expect(v2.view.decision?.player).toBe(other.playerId);
    expect(v1.view.log.some((e) => /keeps 7 cards/.test(e.text))).toBe(true);

    // A stale decision id is refused.
    const stale = await other.request({ type: 'decision', decisionId: chooserView.decision!.id, response: { type: 'mulligan', keep: true } }, 'error');
    expect(stale.code).toBe('STALE_DECISION');

    // Chat is relayed to everyone.
    const [chat] = await Promise.all([other.next('chat'), chooser.send({ type: 'chat', text: 'gl hf' })]);
    expect(chat).toMatchObject({ from: chooser.playerId, text: 'gl hf' });

    await Promise.all([host.close(), guest.close()]);
  });

  it('reconnects a player by playerId + token and resends lobby and view', async () => {
    const host = await Client.connect();
    await host.request({ type: 'createRoom', playerName: 'Solo' }, 'welcome');
    await host.request({ type: 'setDeck', deck: forestDeck() }, 'lobby');
    await host.request({ type: 'addDummy' }, 'lobby', (m) => m.lobby.players.length === 2);
    await Promise.all([host.next('view'), host.request({ type: 'startGame' }, 'lobby', (m) => m.lobby.started)]);
    const { roomId, playerId, token } = host;
    await host.close();

    // The seat is kept while disconnected, and the game cannot be joined fresh.
    const stranger = await Client.connect();
    const refused = await stranger.request({ type: 'joinRoom', roomId, playerName: 'Eve' }, 'error');
    expect(refused.code).toBe('GAME_STARTED');
    const badToken = await stranger.request({ type: 'joinRoom', roomId, playerName: 'Eve', playerId, token: 'nope' }, 'error');
    expect(badToken.code).toBe('RECONNECT_FAILED');
    await stranger.close();

    const again = await Client.connect();
    const [welcome, lobby, view] = await Promise.all([again.next('welcome'), again.next('lobby'), again.next('view'), again.send({ type: 'joinRoom', roomId, playerName: 'Solo', playerId, token })]);
    expect(welcome.playerId).toBe(playerId);
    expect(welcome.token).toBe(token);
    expect(lobby.lobby.started).toBe(true);
    expect(lobby.lobby.players.find((p) => p.id === playerId)?.connected).toBe(true);
    expect(view.view.you).toBe(playerId);
    await again.close();
  });

  it('plays a human against a dummy: bots auto-answer and the game advances to the human', async () => {
    const host = await Client.connect();
    await host.request({ type: 'createRoom', playerName: 'Goldfish' }, 'welcome');
    await host.request({ type: 'setDeck', deck: forestDeck() }, 'lobby');
    const lobby = await host.request({ type: 'addDummy', name: 'Robot' }, 'lobby', (m) => m.lobby.players.length === 2);
    const bot = lobby.lobby.players[1];
    expect(bot.name).toBe('Robot');
    expect(bot.ready).toBe(true);
    expect(bot.deckSize).toBe(40); // copy of the host's deck
    expect(bot.commanders).toEqual(['Ezuri, Renegade Leader']);

    host.send({ type: 'startGame' });
    // Whatever the turn order, the bot answers its own mulligan and the human ends up with the decision.
    const mine = await host.next('view', (m) => m.view.decision?.type === 'mulligan' && m.view.decision.player === host.playerId);
    expect(mine.view.waitingOn).toBe(host.playerId);

    // Keep; the bot then handles anything of its own until the human has priority.
    host.send({ type: 'decision', decisionId: mine.view.decision!.id, response: { type: 'mulligan', keep: true } });
    const prio = await host.next('view', (m) => m.view.decision?.type === 'priority' && m.view.decision.player === host.playerId);
    expect(prio.view.turn.number).toBeGreaterThanOrEqual(1);
    const botView = prio.view.players.find((p) => p.id === bot.id)!;
    expect(botView.hand).toBeNull();
    expect(botView.handCount).toBe(7);

    // Manual actions and concede work; conceding ends the game and the bot wins.
    const [afterLife] = await Promise.all([host.next('view', (m) => m.view.players.find((p) => p.id === host.playerId)?.life === 30), host.send({ type: 'manual', action: { kind: 'setLife', playerId: host.playerId, life: 30 } })]);
    expect(afterLife.view.players.find((p) => p.id === host.playerId)?.life).toBe(30);

    const [over] = await Promise.all([host.next('gameOver'), host.send({ type: 'concede' })]);
    expect(over.winner).toBe(bot.id);
    await host.close();
  });

  it('enforces lobby rules: bad decks, room limits, unknown rooms and non-members', async () => {
    const c = await Client.connect();
    const notInRoom = await c.request({ type: 'setReady', ready: true }, 'error');
    expect(notInRoom.code).toBe('NOT_IN_ROOM');
    const missing = await c.request({ type: 'joinRoom', roomId: 'ZZZZZZ', playerName: 'x' }, 'error');
    expect(missing.code).toBe('ROOM_NOT_FOUND');

    await c.request({ type: 'createRoom', playerName: 'Host', config: { startingLife: 20 } }, 'welcome');
    const noCommander = await c.request({ type: 'setDeck', deck: { name: 'x', commanders: [], mainboard: [db.byName('Forest')!] } }, 'error');
    expect(noCommander.code).toBe('BAD_DECK');
    const noMain = await c.request({ type: 'setDeck', deck: { name: 'x', commanders: [db.byName('Krenko, Mob Boss')!], mainboard: [] } }, 'error');
    expect(noMain.code).toBe('BAD_DECK');

    const cfg = await c.request({ type: 'updateConfig', config: { startingHandSize: 5 } }, 'lobby');
    expect(cfg.lobby.config).toEqual({ startingLife: 20, startingHandSize: 5 });

    // Start without a deck is refused; fill the room with dummies up to the cap.
    const noDeck = await c.request({ type: 'startGame' }, 'error');
    expect(noDeck.code).toBe('NO_DECK');
    for (let i = 0; i < 5; i++) await c.request({ type: 'addDummy' }, 'lobby', (m) => m.lobby.players.length === i + 2);
    const full = await c.request({ type: 'addDummy' }, 'error');
    expect(full.code).toBe('ROOM_FULL');
    const guest = await Client.connect();
    const fullJoin = await guest.request({ type: 'joinRoom', roomId: c.roomId, playerName: 'Late' }, 'error');
    expect(fullJoin.code).toBe('ROOM_FULL');

    // Leaving deletes the room once no humans remain.
    c.send({ type: 'leaveRoom' });
    await sleep(50);
    expect(server.rooms.rooms.has(c.roomId)).toBe(false);
    await Promise.all([c.close(), guest.close()]);
  });

  it('cleans up rooms that have had no connected humans for the TTL', async () => {
    let now = 1_000_000;
    const rm = new RoomManager({ cardDb: db, emptyRoomTtlMs: 1000, now: () => now });
    // Drive the manager directly with a fake socket.
    const sent: ServerMessage[] = [];
    const fake = { readyState: 1, OPEN: 1, send: (s: string) => sent.push(JSON.parse(s)), close() {} } as unknown as WebSocket;
    rm.handleMessage(fake, { type: 'createRoom', playerName: 'Ghost' });
    const roomId = (sent.find((m) => m.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>).roomId;
    expect(rm.sweep()).toEqual([]);
    rm.handleClose(fake);
    now += 500;
    expect(rm.sweep()).toEqual([]);
    now += 600;
    expect(rm.sweep()).toEqual([roomId]);
    expect(rm.rooms.size).toBe(0);
    rm.close();
  });
});
