/**
 * Resolve card names to engine CardData straight from Scryfall, from the browser.
 * https://scryfall.com/docs/api/cards/collection — POST, up to 75 identifiers per call,
 * and Scryfall asks for <= 10 requests/second.
 */
import type { CardData } from '@commander/engine';
import { toCardData, type ScryfallCard } from '@commander/cards';
import { loadJson, saveJson } from './storage.js';

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const BATCH = 75;
const MIN_INTERVAL_MS = 120;
const CACHE_KEY = 'co:cardcache:v1';
const CACHE_LIMIT = 1500;

export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*\/{1,2}\s*/g, ' // ')
    .trim();
}

/** Front-face name of a "Front // Back" name. */
function frontName(name: string): string {
  return name.split('//')[0].trim();
}

const memory = new Map<string, CardData>();
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const stored = loadJson<Record<string, CardData>>(CACHE_KEY, {});
  for (const [k, v] of Object.entries(stored)) memory.set(k, v);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries = Array.from(memory.entries());
    const keep = entries.length > CACHE_LIMIT ? entries.slice(entries.length - CACHE_LIMIT) : entries;
    saveJson(CACHE_KEY, Object.fromEntries(keep));
  }, 500);
}

/** Remember a CardData (e.g. one that arrived from the server) under all of its names. */
export function rememberCard(card: CardData): void {
  hydrate();
  memory.set(normalizeName(card.name), card);
  const front = frontName(card.name);
  if (front !== card.name) memory.set(normalizeName(front), card);
  for (const f of card.faces ?? []) memory.set(normalizeName(f.name), card);
  persistSoon();
}

export function cachedCard(name: string): CardData | undefined {
  hydrate();
  return memory.get(normalizeName(name)) ?? memory.get(normalizeName(frontName(name)));
}

let lastRequest = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequest + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
}

interface CollectionResponse {
  object: string;
  data?: ScryfallCard[];
  not_found?: { name?: string }[];
}

export interface ResolveResult {
  /** Keyed by the exact name that was asked for. */
  cards: Map<string, CardData>;
  missing: string[];
}

export interface ResolveProgress {
  done: number;
  total: number;
}

/**
 * Resolve many names. Uses the cache first, then batches the rest through Scryfall.
 * Never throws for individual misses: they land in `missing`.
 */
export async function resolveCards(names: string[], onProgress?: (p: ResolveProgress) => void): Promise<ResolveResult> {
  hydrate();
  const result: ResolveResult = { cards: new Map(), missing: [] };
  const unique = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));
  const pending: string[] = [];
  for (const n of unique) {
    const hit = cachedCard(n);
    if (hit) result.cards.set(n, hit);
    else pending.push(n);
  }
  let done = unique.length - pending.length;
  onProgress?.({ done, total: unique.length });

  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    await throttle();
    let res: Response;
    try {
      res = await fetch(COLLECTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((name) => ({ name: frontName(name) })) }),
      });
    } catch (e) {
      throw new Error(`Could not reach Scryfall: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Scryfall returned ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as CollectionResponse;
    const byNorm = new Map<string, CardData>();
    for (const raw of json.data ?? []) {
      const card = toCardData(raw);
      rememberCard(card);
      byNorm.set(normalizeName(card.name), card);
      byNorm.set(normalizeName(frontName(card.name)), card);
      for (const f of card.faces ?? []) byNorm.set(normalizeName(f.name), card);
    }
    for (const name of chunk) {
      const card = byNorm.get(normalizeName(name)) ?? byNorm.get(normalizeName(frontName(name)));
      if (card) result.cards.set(name, card);
      else result.missing.push(name);
    }
    done += chunk.length;
    onProgress?.({ done, total: unique.length });
  }
  return result;
}

/** Resolve a single name (cache-first). Returns undefined if unknown. */
export async function resolveCard(name: string): Promise<CardData | undefined> {
  const r = await resolveCards([name]);
  return r.cards.get(name.trim());
}
