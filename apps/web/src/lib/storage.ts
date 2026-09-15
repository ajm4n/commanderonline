/** Tiny localStorage wrapper that never throws (private mode, quota, SSR). */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface RoomCredentials {
  roomId: string;
  playerId: string;
  token: string;
  name: string;
  savedAt: number;
}

const ROOM_PREFIX = 'co:room:';

export function saveRoomCredentials(c: RoomCredentials): void {
  saveJson(ROOM_PREFIX + c.roomId.toUpperCase(), c);
}
export function loadRoomCredentials(roomId: string): RoomCredentials | null {
  return loadJson<RoomCredentials | null>(ROOM_PREFIX + roomId.toUpperCase(), null);
}
export function clearRoomCredentials(roomId: string): void {
  removeKey(ROOM_PREFIX + roomId.toUpperCase());
}

export function loadPlayerName(): string {
  return loadJson<string>('co:name', '');
}
export function savePlayerName(name: string): void {
  saveJson('co:name', name);
}
