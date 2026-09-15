/**
 * Optional bundled card database for fully offline / sandboxed builds (set VITE_LOCAL_CARDS to a
 * comma-separated list of URLs of CardData[] JSON files, optionally gzipped). When present it is
 * consulted before Scryfall.
 */
import type { CardData } from '@commander/engine';
import { CardDb } from '@commander/cards';

const url = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_LOCAL_CARDS;
let pending: Promise<CardDb | null> | null = null;

export function hasLocalDb(): boolean {
  return !!url;
}

export function localDb(): Promise<CardDb | null> {
  if (!url) return Promise.resolve(null);
  pending ??= (async () => {
    try {
      const parts = await Promise.all(
        url.split(',').map(async (u) => {
          const res = await fetch(u.trim());
          if (!res.ok || !res.body) throw new Error(`${u}: ${res.status}`);
          const stream = u.trim().endsWith('.gz') ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
          return JSON.parse(await new Response(stream).text()) as CardData[];
        }),
      );
      return new CardDb(parts.flat());
    } catch {
      return null;
    }
  })();
  return pending;
}
