import type { CardData } from '@commander/engine';
import type { DeckEntry, ImportedDeck } from '@commander/deck-import';

/**
 * The subset of `CardDb` (from @commander/cards) the server relies on.
 * Declared locally so the server can be tested against any lookup table.
 */
export interface CardDbLike {
  byName(name: string): CardData | undefined;
  byOracleId(id: string): CardData | undefined;
  search(q: string, limit?: number): CardData[];
  all(): Iterable<CardData>;
  readonly size: number;
}

export const FIXTURE_WARNING = 'The server is running on the small fixture card database; run `pnpm cards:fetch` on the server for the full card pool.';

/** Look a card up by exact name, falling back to the front-face name of a split/DFC entry. */
export function lookupCard(db: CardDbLike, name: string): CardData | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const hit = db.byName(trimmed);
  if (hit) return hit;
  const front = trimmed.split(/\s*\/\/\s*/)[0];
  if (front && front !== trimmed) return db.byName(front);
  return undefined;
}

/** Re-validate a client-supplied card against the DB (by oracleId, then name); keep the client copy if unknown. */
export function canonicalize(db: CardDbLike, card: CardData): CardData {
  if (card.oracleId) {
    const byId = db.byOracleId(card.oracleId);
    if (byId) return byId;
  }
  return lookupCard(db, card.name) ?? card;
}

export interface ResolvedDeck {
  name: string;
  commanders: CardData[];
  mainboard: CardData[];
  missing: string[];
  warnings: string[];
}

/** Expand a parsed decklist into concrete CardData, one entry per copy. */
export function resolveDeck(db: CardDbLike, deck: ImportedDeck, extraWarnings: string[] = []): ResolvedDeck {
  const missing = new Set<string>();
  const expand = (entries: DeckEntry[]): CardData[] => {
    const out: CardData[] = [];
    for (const e of entries) {
      const card = lookupCard(db, e.name);
      if (!card) {
        missing.add(e.name);
        continue;
      }
      for (let i = 0; i < Math.max(1, e.quantity); i++) out.push(card);
    }
    return out;
  };
  // Entries flagged as commanders inside the mainboard move to the command zone.
  const commanderEntries = [...deck.commanders, ...deck.mainboard.filter((e) => e.isCommander)];
  const mainEntries = deck.mainboard.filter((e) => !e.isCommander);
  return {
    name: deck.name,
    commanders: expand(commanderEntries),
    mainboard: expand(mainEntries),
    missing: [...missing],
    warnings: [...deck.warnings, ...extraWarnings],
  };
}

/** Basic land used for dummy seats when the host has no deck yet. */
export function fallbackForest(db: CardDbLike): CardData {
  return (
    db.byName('Forest') ?? {
      oracleId: 'server:forest',
      name: 'Forest',
      layout: 'normal',
      manaCost: '',
      cmc: 0,
      typeLine: 'Basic Land — Forest',
      oracleText: '({T}: Add {G}.)',
      colors: [],
      colorIdentity: ['G'],
      keywords: [],
      producedMana: ['G'],
    }
  );
}
