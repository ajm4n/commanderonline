import type { CardData } from '@commander/engine';
import type { DeckPayload } from '@commander/protocol';
import { parseDeckText, detectSource, type ImportedDeck, type DeckEntry } from '@commander/deck-import';
import { scriptFor } from '@commander/cards';
import { resolveCards, rememberCard, type ResolveProgress } from './scryfall.js';
import { importDeckFromServer, isNetworkError, resolveNamesOnServer } from './api.js';
import { loadJson, saveJson } from './storage.js';
import { localDb } from './localdb.js';

export interface CoverageStats {
  full: number;
  partial: number;
  none: number;
  /** Names of cards that are not fully automated, with their coverage. */
  manual: { name: string; coverage: 'partial' | 'none'; unhandled: string[] }[];
}

export interface PreparedDeck {
  payload: DeckPayload;
  missing: string[];
  warnings: string[];
  coverage: CoverageStats;
  source: 'text' | 'url' | 'recent';
}

export function isDeckUrl(text: string): boolean {
  const t = text.trim();
  if (/\n/.test(t)) return false;
  return /^https?:\/\//i.test(t) || detectSource(t) !== 'unknown';
}

export function computeCoverage(cards: CardData[]): CoverageStats {
  const stats: CoverageStats = { full: 0, partial: 0, none: 0, manual: [] };
  const seen = new Set<string>();
  for (const c of cards) {
    let cov: 'full' | 'partial' | 'none' = 'none';
    let unhandled: string[] = [];
    try {
      const s = scriptFor(c);
      cov = s.coverage;
      unhandled = s.unhandledText ?? [];
    } catch {
      cov = 'none';
      unhandled = c.oracleText ? [c.oracleText] : [];
    }
    stats[cov]++;
    if (cov !== 'full' && !seen.has(c.name)) {
      seen.add(c.name);
      stats.manual.push({ name: c.name, coverage: cov, unhandled });
    }
  }
  stats.manual.sort((a, b) => (a.coverage === b.coverage ? a.name.localeCompare(b.name) : a.coverage === 'none' ? -1 : 1));
  return stats;
}

function expand(entries: DeckEntry[], cards: Map<string, CardData>, missing: Set<string>): CardData[] {
  const out: CardData[] = [];
  for (const e of entries) {
    const card = cards.get(e.name.trim());
    if (!card) {
      missing.add(e.name);
      continue;
    }
    for (let i = 0; i < Math.max(1, e.quantity); i++) out.push(card);
  }
  return out;
}

/** Parse a pasted decklist client-side and resolve every card through Scryfall. */
export async function prepareDeckFromText(text: string, onProgress?: (p: ResolveProgress) => void): Promise<PreparedDeck> {
  const parsed: ImportedDeck = parseDeckText(text);
  const warnings = [...parsed.warnings];
  if (parsed.commanders.length === 0 && parsed.mainboard.length === 0) throw new Error('No cards found in that text.');
  const names = [...parsed.commanders, ...parsed.mainboard].map((e) => e.name.trim());
  let resolved: { cards: Map<string, CardData>; missing: string[] };
  // A bundled database (offline builds) answers first; anything it lacks goes to Scryfall.
  const local = await localDb();
  const localHits = new Map<string, CardData>();
  let remaining = names;
  if (local) {
    remaining = [];
    for (const n of new Set(names)) {
      const c = local.byName(n);
      if (c) localHits.set(n, c);
      else remaining.push(n);
    }
  }
  try {
    resolved = remaining.length ? await resolveCards(remaining, onProgress) : { cards: new Map(), missing: [] };
    for (const [n, c] of localHits) resolved.cards.set(n, c);
  } catch (e) {
    // Scryfall unreachable (offline, blocked, rate limited): fall back to the game server's card database.
    resolved = { cards: new Map(localHits), missing: [...new Set(remaining)] };
    warnings.push(`Scryfall was unreachable (${e instanceof Error ? e.message : 'network error'}); resolving through the game server instead.`);
  }
  if (resolved.missing.length) {
    try {
      const fromServer = await resolveNamesOnServer([...new Set(resolved.missing)]);
      for (const [name, card] of Object.entries(fromServer.cards)) {
        resolved.cards.set(name, card);
        rememberCard(card);
      }
      resolved.missing = fromServer.missing ?? [];
    } catch {
      /* server offline too; the names stay missing */
    }
  }
  const missing = new Set<string>(resolved.missing);
  let commanders = expand(parsed.commanders, resolved.cards, missing);
  let mainboard = expand(parsed.mainboard, resolved.cards, missing);
  if (commanders.length > 2) {
    // A "Commander" header with no following "Deck" header swallows the whole list. The card
    // listed first is the commander; a second one only if the two are partners / a background.
    const first = commanders.find((c) => isCommanderCandidate(c)) ?? commanders[0];
    const picked = [first];
    const idx = commanders.indexOf(first);
    const second = commanders[idx + 1];
    const pairs = (a: CardData, b: CardData) => (/\bPartner\b/.test(a.oracleText) && /\bPartner\b/.test(b.oracleText)) || (/Choose a Background/.test(a.oracleText) && /\bBackground\b/.test(b.typeLine)) || (/Choose a Background/.test(b.oracleText) && /\bBackground\b/.test(a.typeLine));
    if (second && isCommanderCandidate(second) && pairs(first, second)) picked.push(second);
    let rest = commanders;
    for (const c of picked) rest = removeOne(rest, c);
    commanders = picked;
    mainboard = [...rest, ...mainboard];
    warnings.push(`The commander section listed ${rest.length + picked.length} cards; using ${picked.map((c) => c.name).join(' & ')} and moving the rest to the deck.`);
  }
  if (commanders.length === 0) {
    const guess = guessCommander(mainboard);
    if (guess) {
      commanders = [guess];
      mainboard = removeOne(mainboard, guess);
      warnings.push(`No commander section found; using ${guess.name} as the commander. Change it below if that is wrong.`);
    }
  }
  const payload: DeckPayload = { name: parsed.name || deckNameFrom(commanders), commanders, mainboard };
  return { payload, missing: Array.from(missing), warnings, coverage: computeCoverage([...commanders, ...mainboard]), source: 'text' };
}

/** Import a Moxfield / Archidekt URL via the server (CORS). Throws a friendly error if the server is unreachable. */
export async function prepareDeckFromUrl(url: string): Promise<PreparedDeck> {
  let res;
  try {
    res = await importDeckFromServer({ url: url.trim() });
  } catch (e) {
    if (detectSource(url) === 'moxfield') throw new Error('Moxfield blocks automated downloads (they only allow approved apps). In Moxfield open your deck → More → Export → copy the text, then paste it here.');
    if (isNetworkError(e)) throw new Error('The game server is not reachable, so URL import is unavailable. Export your deck as text and paste it instead.');
    throw e;
  }
  // importDeckFromUrl never throws for a remote failure: it returns an empty deck and explains
  // itself in `warnings`. Without this the picker would happily "prepare" a deck of nothing.
  if (res.commanders.length === 0 && res.mainboard.length === 0) {
    const why = (res.warnings ?? []).find((w) => w.trim()) ?? `No cards were found at ${url.trim()}.`;
    // The server's warning usually ends with its own paste hint; only add ours when it does not.
    throw new Error(detectSource(url) === 'moxfield' && !/paste/i.test(why) ? `${why} In Moxfield open your deck → More → Export → copy the text, then paste it here.` : why);
  }
  for (const c of [...res.commanders, ...res.mainboard]) rememberCard(c);
  const payload: DeckPayload = { name: res.name || deckNameFrom(res.commanders), commanders: res.commanders, mainboard: res.mainboard };
  return { payload, missing: res.missing ?? [], warnings: res.warnings ?? [], coverage: computeCoverage([...payload.commanders, ...payload.mainboard]), source: 'url' };
}

export function isCommanderCandidate(c: CardData): boolean {
  return (/Legendary/.test(c.typeLine) && /Creature/.test(c.typeLine)) || /can be your commander/i.test(c.oracleText);
}

export function guessCommander(cards: CardData[]): CardData | undefined {
  return cards.find((c) => /Legendary/.test(c.typeLine) && /Creature/.test(c.typeLine)) ?? cards.find((c) => /can be your commander/i.test(c.oracleText));
}

export function removeOne(cards: CardData[], card: CardData): CardData[] {
  const idx = cards.findIndex((c) => c.oracleId === card.oracleId && c.name === card.name);
  if (idx < 0) return cards;
  return [...cards.slice(0, idx), ...cards.slice(idx + 1)];
}

export function deckNameFrom(commanders: CardData[]): string {
  if (commanders.length === 0) return 'Untitled deck';
  return commanders.map((c) => c.name.split('//')[0].trim()).join(' & ');
}

// ---------------------------------------------------------------------------
// Recent decks
// ---------------------------------------------------------------------------

export interface RecentDeck {
  id: string;
  savedAt: number;
  payload: DeckPayload;
}

const RECENT_KEY = 'co:recentDecks:v1';
const RECENT_LIMIT = 6;

export function loadRecentDecks(): RecentDeck[] {
  return loadJson<RecentDeck[]>(RECENT_KEY, []).filter((d) => d && d.payload && Array.isArray(d.payload.mainboard));
}

export function saveRecentDeck(payload: DeckPayload): void {
  const list = loadRecentDecks().filter((d) => d.payload.name !== payload.name);
  list.unshift({ id: `${Date.now()}`, savedAt: Date.now(), payload });
  // Trim until it fits; localStorage quota is ~5MB and CardData is chunky.
  let trimmed = list.slice(0, RECENT_LIMIT);
  while (trimmed.length > 0 && !saveJson(RECENT_KEY, trimmed)) trimmed = trimmed.slice(0, -1);
}

export function deleteRecentDeck(id: string): void {
  saveJson(RECENT_KEY, loadRecentDecks().filter((d) => d.id !== id));
}

// ---------------------------------------------------------------------------
// Fallback bot deck: basic lands (works with no network at all)
// ---------------------------------------------------------------------------

const BASICS: { name: string; color: 'W' | 'U' | 'B' | 'R' | 'G'; type: string }[] = [
  { name: 'Plains', color: 'W', type: 'Plains' },
  { name: 'Island', color: 'U', type: 'Island' },
  { name: 'Swamp', color: 'B', type: 'Swamp' },
  { name: 'Mountain', color: 'R', type: 'Mountain' },
  { name: 'Forest', color: 'G', type: 'Forest' },
];

export function basicLand(name: string): CardData {
  const b = BASICS.find((x) => x.name === name) ?? BASICS[4];
  return {
    oracleId: `basic:${b.name}`,
    name: b.name,
    layout: 'normal',
    manaCost: '',
    cmc: 0,
    typeLine: `Basic Land — ${b.type}`,
    oracleText: `({T}: Add {${b.color}}.)`,
    colors: [],
    colorIdentity: [],
    keywords: [],
    producedMana: [b.color],
  };
}

export function basicLandDeck(count = 99): DeckPayload {
  const mainboard: CardData[] = [];
  for (let i = 0; i < count; i++) mainboard.push(basicLand(BASICS[i % BASICS.length].name));
  return { name: 'Basic lands', commanders: [], mainboard };
}

export function cloneDeck(d: DeckPayload, name?: string): DeckPayload {
  return { name: name ?? d.name, commanders: [...d.commanders], mainboard: [...d.mainboard] };
}

export function deckSize(d: DeckPayload | null | undefined): number {
  return d ? d.commanders.length + d.mainboard.length : 0;
}
