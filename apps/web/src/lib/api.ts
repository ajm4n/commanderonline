/** Thin client for the game server's HTTP API. Every call tolerates the server being offline. */
import type { CardData } from '@commander/engine';

export interface RoomSummary {
  roomId: string;
  players: number;
  names: string[];
  started: boolean;
}

export interface ServerDeckImport {
  name: string;
  commanders: CardData[];
  mainboard: CardData[];
  missing: string[];
  warnings: string[];
}

const TIMEOUT_MS = 6000;

async function request<T>(path: string, init?: RequestInit, timeout = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        msg = body.error ?? body.message ?? msg;
      } catch {
        /* keep status text */
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRooms(): Promise<RoomSummary[]> {
  const rooms = await request<RoomSummary[] | { rooms: RoomSummary[] }>('/api/rooms', undefined, 3000);
  return Array.isArray(rooms) ? rooms : rooms.rooms ?? [];
}

export async function importDeckFromServer(body: { url: string } | { text: string }): Promise<ServerDeckImport> {
  return request<ServerDeckImport>('/api/deck/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 30000);
}

export async function resolveNamesOnServer(names: string[]): Promise<{ cards: Record<string, CardData>; missing: string[] }> {
  return request('/api/cards/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) }, 15000);
}

export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed|ECONNREFUSED|502|503|504/.test(e.message);
}
