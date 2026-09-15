/**
 * WebSocket protocol between the game server and browser clients.
 * All messages are JSON. The server is authoritative; clients only ever
 * send decisions, manual actions and lobby commands.
 */
import type { GameView, Response, ManualAction, PlayerId, GameConfig, CardData, LogEntry } from '@commander/engine';

export interface DeckPayload {
  name: string;
  /** Resolved cards. The server re-validates against its card database by oracleId/name. */
  commanders: CardData[];
  mainboard: CardData[];
}

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  ready: boolean;
  deckName: string | null;
  deckSize: number;
  commanders: string[];
  connected: boolean;
  isHost: boolean;
}

export interface LobbyState {
  roomId: string;
  players: LobbyPlayer[];
  config: Partial<GameConfig>;
  started: boolean;
  /** Human-readable join code / URL fragment. */
  joinCode: string;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** Create a new room; server replies with `lobby`. */
  | { type: 'createRoom'; playerName: string; config?: Partial<GameConfig> }
  /** Join an existing room. `playerId` lets a reconnecting client reclaim their seat. */
  | { type: 'joinRoom'; roomId: string; playerName: string; playerId?: PlayerId; token?: string }
  | { type: 'leaveRoom' }
  | { type: 'setDeck'; deck: DeckPayload }
  | { type: 'setReady'; ready: boolean }
  | { type: 'updateConfig'; config: Partial<GameConfig> }
  /** Host only. */
  | { type: 'startGame' }
  /** Answer the pending decision. */
  | { type: 'decision'; decisionId: number; response: Response }
  /** Untap-style manual edit, allowed any time. */
  | { type: 'manual'; action: ManualAction }
  | { type: 'chat'; text: string }
  /** Concede. */
  | { type: 'concede' }
  /** Ask the server to resend the full view. */
  | { type: 'sync' }
  /** Add an AI/goldfish dummy seat (solo testing). */
  | { type: 'addDummy'; name?: string }
  | { type: 'ping' };

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'welcome'; playerId: PlayerId; token: string; roomId: string }
  | { type: 'lobby'; lobby: LobbyState }
  /** Full per-player view. Sent after every state change. */
  | { type: 'view'; view: GameView }
  /** Incremental log lines (also included in view; this is for toasts). */
  | { type: 'log'; entries: LogEntry[] }
  | { type: 'chat'; from: PlayerId; name: string; text: string; at: number }
  | { type: 'error'; message: string; code?: string }
  | { type: 'gameOver'; winner: PlayerId | null }
  | { type: 'pong' };

export function encode(m: ClientMessage | ServerMessage): string {
  return JSON.stringify(m);
}
export function decodeClient(s: string): ClientMessage {
  return JSON.parse(s) as ClientMessage;
}
export function decodeServer(s: string): ServerMessage {
  return JSON.parse(s) as ServerMessage;
}

/** Default port for the dev server. */
export const DEFAULT_PORT = 8787;
/** WS path. */
export const WS_PATH = '/ws';
