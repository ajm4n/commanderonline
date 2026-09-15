import { type DeckEntry, type ImportedDeck, addEntry, asQuantity, asString, emptyDeck, isRecord, normalizeCardName } from './types.js';

interface CategoryDef {
  name: string;
  isPremier: boolean;
  includedInDeck: boolean;
}

function readCategories(raw: unknown): Map<string, CategoryDef> {
  const map = new Map<string, CategoryDef>();
  if (!Array.isArray(raw)) return map;
  for (const c of raw) {
    if (!isRecord(c)) continue;
    const name = asString(c.name);
    if (!name) continue;
    map.set(name.toLowerCase(), {
      name,
      isPremier: c.isPremier === true,
      includedInDeck: c.includedInDeck !== false,
    });
  }
  return map;
}

function isCommanderCategory(name: string, defs: Map<string, CategoryDef>): boolean {
  if (/^commanders?$/i.test(name)) return true;
  return defs.get(name.toLowerCase())?.isPremier === true;
}

/**
 * Parse an Archidekt deck JSON document (`https://archidekt.com/api/decks/{id}/`).
 * Shape: `{ name, cards: [{ quantity, card: { oracleCard: { name }, edition: { editioncode }, collectorNumber }, categories: [...] }],
 *           categories: [{ name, isPremier, includedInDeck }] }`
 */
export function parseArchidektJson(json: unknown): ImportedDeck {
  const deck = emptyDeck('archidekt');
  if (!isRecord(json)) {
    deck.warnings.push('Archidekt response was not a JSON object.');
    return deck;
  }
  deck.name = asString(json.name) ?? deck.name;
  if (typeof json.id === 'number' || asString(json.id)) deck.url = `https://archidekt.com/decks/${json.id}`;

  const defs = readCategories(json.categories);
  const cards = Array.isArray(json.cards) ? json.cards : [];
  if (!Array.isArray(json.cards)) deck.warnings.push('Archidekt JSON has no "cards" array.');

  for (const raw of cards) {
    if (!isRecord(raw)) continue;
    const card = isRecord(raw.card) ? raw.card : {};
    const oracle = isRecord(card.oracleCard) ? card.oracleCard : {};
    const name = asString(oracle.name) ?? asString(card.name) ?? asString(raw.name);
    if (!name) {
      deck.warnings.push('Skipped an Archidekt card with no name.');
      continue;
    }
    const entry: DeckEntry = { name: normalizeCardName(name), quantity: asQuantity(raw.quantity) };
    const edition = isRecord(card.edition) ? card.edition : undefined;
    const set = asString(edition?.editioncode) ?? asString(edition?.editionCode);
    if (set) entry.set = set.toLowerCase();
    const cn = asString(card.collectorNumber) ?? (typeof card.collectorNumber === 'number' ? String(card.collectorNumber) : undefined);
    if (cn) entry.collectorNumber = cn;

    const categories = Array.isArray(raw.categories) ? raw.categories.filter((c): c is string => typeof c === 'string') : [];
    if (categories.length) entry.categories = categories;

    const isCommander = categories.some((c) => isCommanderCategory(c, defs));
    // Archidekt treats the first category as the card's primary category for inclusion purposes.
    const primary = categories[0];
    const primaryDef = primary ? defs.get(primary.toLowerCase()) : undefined;
    const excluded = primaryDef
      ? !primaryDef.includedInDeck
      : primary !== undefined && /^(maybeboard|sideboard|considering|wishlist)$/i.test(primary);

    if (isCommander) {
      entry.isCommander = true;
      addEntry(deck.commanders, entry);
    } else if (excluded) {
      addEntry(deck.sideboard, entry);
    } else {
      addEntry(deck.mainboard, entry);
    }
  }

  if (deck.commanders.length === 0 && deck.mainboard.length > 0) {
    deck.warnings.push('Archidekt deck has no card in a Commander category.');
  }
  return deck;
}
