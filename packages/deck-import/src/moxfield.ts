import { type DeckEntry, type ImportedDeck, addEntry, asQuantity, asString, emptyDeck, isRecord, normalizeCardName } from './types.js';

/**
 * Convert one Moxfield board card record ({ quantity, card: { name, set, cn } }) to a DeckEntry.
 * The legacy shape keys the map by card name, so `fallbackName` is used when the record lacks one.
 */
function toEntry(record: unknown, fallbackName: string | undefined, isCommander: boolean): DeckEntry | undefined {
  if (!isRecord(record)) return undefined;
  const card = isRecord(record.card) ? record.card : undefined;
  const rawName = asString(card?.name) ?? asString(record.name) ?? fallbackName;
  if (!rawName) return undefined;
  const entry: DeckEntry = { name: normalizeCardName(rawName), quantity: asQuantity(record.quantity) };
  const set = asString(card?.set);
  if (set) entry.set = set.toLowerCase();
  const cn = asString(card?.cn) ?? asString(card?.collector_number) ?? asString(card?.collectorNumber);
  if (cn) entry.collectorNumber = cn;
  if (isCommander) entry.isCommander = true;
  return entry;
}

function readBoard(board: unknown, target: DeckEntry[], isCommander: boolean): number {
  let count = 0;
  if (!isRecord(board)) return 0;
  // v3: { count, cards: { [id]: record } }  — legacy: { [name]: record }
  const cards = isRecord(board.cards) ? board.cards : board;
  const entries: [string, unknown][] = Array.isArray(cards)
    ? cards.map((c, i) => [String(i), c] as [string, unknown])
    : Object.entries(cards);
  for (const [key, record] of entries) {
    if (key === 'count' || key === 'cards') continue;
    const entry = toEntry(record, /^\d+$/.test(key) ? undefined : key, isCommander);
    if (!entry) continue;
    addEntry(target, entry);
    count++;
  }
  return count;
}

/**
 * Parse a Moxfield deck JSON document (api2.moxfield.com v2 or v3).
 * v3: `{ name, boards: { commanders: { cards }, mainboard: { cards }, sideboard, maybeboard, companions } }`
 * v2/legacy: `{ name, commanders: {...}, mainboard: {...}, sideboard: {...} }`
 */
export function parseMoxfieldJson(json: unknown): ImportedDeck {
  const deck = emptyDeck('moxfield');
  if (!isRecord(json)) {
    deck.warnings.push('Moxfield response was not a JSON object.');
    return deck;
  }
  deck.name = asString(json.name) ?? deck.name;
  const publicUrl = asString(json.publicUrl);
  if (publicUrl) deck.url = publicUrl;
  else if (asString(json.publicId)) deck.url = `https://www.moxfield.com/decks/${json.publicId}`;

  const boards = isRecord(json.boards) ? json.boards : json;
  const usingV3 = isRecord(json.boards);

  readBoard(boards.commanders, deck.commanders, true);
  readBoard(boards.mainboard, deck.mainboard, false);
  readBoard(boards.sideboard, deck.sideboard, false);
  const companions: DeckEntry[] = [];
  readBoard(boards.companions, companions, false);
  for (const c of companions) addEntry(deck.sideboard, { ...c, categories: ['Companion'] });
  // Signature spells (Oathbreaker) live beside the commander; treat as mainboard cards.
  readBoard(boards.signatureSpells, deck.mainboard, false);

  if (deck.commanders.length === 0 && deck.mainboard.length === 0) {
    deck.warnings.push(
      usingV3 ? 'Moxfield deck has no cards in its commander or mainboard boards.' : 'Could not find any cards in the Moxfield JSON.',
    );
  }
  if (deck.commanders.length === 0 && deck.mainboard.length > 0) {
    deck.warnings.push('Moxfield deck has no commander set.');
  }
  const format = asString(json.format);
  if (format && !/commander|brawl|oathbreaker|duel|pauperEdh|predh|edh/i.test(format)) {
    deck.warnings.push(`Moxfield deck format is "${format}", not Commander.`);
  }
  return deck;
}
