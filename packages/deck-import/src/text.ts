import { type DeckEntry, type ImportedDeck, addEntry, emptyDeck, normalizeCardName } from './types.js';

type Board = 'commanders' | 'mainboard' | 'sideboard' | 'ignore';

/** Section headers (lower-cased, punctuation stripped) mapped to the board they introduce. */
const SECTION_HEADERS: Record<string, Board> = {
  commander: 'commanders',
  commanders: 'commanders',
  'commander zone': 'commanders',
  oathbreaker: 'commanders',
  deck: 'mainboard',
  main: 'mainboard',
  mainboard: 'mainboard',
  'main deck': 'mainboard',
  maindeck: 'mainboard',
  library: 'mainboard',
  creatures: 'mainboard',
  creature: 'mainboard',
  spells: 'mainboard',
  lands: 'mainboard',
  land: 'mainboard',
  artifacts: 'mainboard',
  enchantments: 'mainboard',
  instants: 'mainboard',
  sorceries: 'mainboard',
  planeswalkers: 'mainboard',
  battles: 'mainboard',
  sideboard: 'sideboard',
  side: 'sideboard',
  companion: 'sideboard',
  companions: 'sideboard',
  maybeboard: 'ignore',
  maybe: 'ignore',
  considering: 'ignore',
  wishlist: 'ignore',
  tokens: 'ignore',
  token: 'ignore',
  'signature spell': 'mainboard',
};

/** Strip comment / markdown / bracket decoration from a potential header line and look it up. */
function headerBoard(line: string): Board | undefined {
  let s = line.trim();
  // "// Commander", "# Deck", "## Sideboard", "[Sideboard]", "--- Lands ---", "Commander:"
  s = s.replace(/^(?:\/\/|#+|;|--+|\*\*|\[|<)\s*/, '').replace(/\s*(?:\]|>|--+|\*\*|:)\s*$/, '');
  // "Mainboard (99)", "Commander (1)", "Lands - 37", "Creatures: 25"
  s = s.replace(/\s*[(\-:–]\s*\d+\s*\)?\s*$/, '');
  const key = s.trim().toLowerCase();
  if (!key) return undefined;
  return SECTION_HEADERS[key];
}

const SB_PREFIX = /^SB:\s*/i;
const QUANTITY = /^(\d+)\s*[xX]?(?:\s+|$)/;
const LEADING_SET = /^\[([A-Za-z0-9]{2,6})\]\s+/;
const TRAILING_CATEGORIES = /\s*\[([^\]]*)\]\s*$/;
const TRAILING_SET = /\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([A-Za-z0-9★†-]+))?\s*$/;
const TRAILING_STAR_TAGS = /\s+\*([A-Za-z0-9!_-]+)\*(?=\s|$)/g;
const TRAILING_HASH_TAGS = /\s+#!?([A-Za-z0-9_-]+)/g;
const TRAILING_CARET_TAGS = /\s*\^[^^]*\^\s*$/;
const NAME_LINE = /^(?:\/\/\s*)?(?:deck\s*name|name|title)\s*:\s*(.+)$/i;

export interface ParsedLine {
  entry: DeckEntry;
  board?: Board;
}

/** Parse a single card line. Returns undefined if the line is not a card. */
export function parseCardLine(raw: string): ParsedLine | undefined {
  let line = raw.trim();
  if (!line) return undefined;
  let board: Board | undefined;
  let isCommander = false;
  const categories: string[] = [];

  if (SB_PREFIX.test(line)) {
    board = 'sideboard';
    line = line.replace(SB_PREFIX, '');
  }

  let quantity = 1;
  const q = QUANTITY.exec(line);
  if (q) {
    quantity = parseInt(q[1], 10);
    line = line.slice(q[0].length);
    if (!line) return undefined;
  }

  // Trailing marks: "*CMDR*", "*F*" (foil), "#!Commander", "^Have^"
  line = line.replace(TRAILING_STAR_TAGS, (_m, tag: string) => {
    if (/^cmdr$/i.test(tag)) isCommander = true;
    return '';
  });
  line = line.replace(TRAILING_CARET_TAGS, '');
  line = line.replace(TRAILING_HASH_TAGS, (_m, tag: string) => {
    if (/^commander$/i.test(tag)) isCommander = true;
    else categories.push(tag);
    return '';
  });

  // Archidekt-style "[Commander{top},Ramp]" categories
  const cats = TRAILING_CATEGORIES.exec(line);
  if (cats) {
    line = line.slice(0, cats.index);
    for (const c of cats[1].split(',')) {
      const name = c.replace(/\{[^}]*\}/g, '').trim();
      if (!name) continue;
      if (/^commanders?$/i.test(name)) isCommander = true;
      else if (/^(maybeboard|sideboard)$/i.test(name)) board = board ?? 'sideboard';
      categories.push(name);
    }
  }

  let set: string | undefined;
  let collectorNumber: string | undefined;
  const leading = LEADING_SET.exec(line);
  if (leading) {
    set = leading[1].toLowerCase();
    line = line.slice(leading[0].length);
  }
  const trailing = TRAILING_SET.exec(line);
  if (trailing) {
    set = trailing[1].toLowerCase();
    collectorNumber = trailing[2];
    line = line.slice(0, trailing.index);
  }

  const name = normalizeCardName(line);
  if (!name) return undefined;
  const entry: DeckEntry = { name, quantity };
  if (set) entry.set = set;
  if (collectorNumber) entry.collectorNumber = collectorNumber;
  if (isCommander) entry.isCommander = true;
  if (categories.length) entry.categories = categories;
  if (isCommander) board = 'commanders';
  return { entry, board };
}

/**
 * Parse a plain-text decklist (MTGO, Arena, Moxfield, Archidekt, TappedOut, Deckstats exports ...).
 */
export function parseDeckText(text: string): ImportedDeck {
  const deck = emptyDeck('text');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current: Board = 'mainboard';
  let sawExplicitCommanderSection = false;
  let sawAnyHeader = false;
  let unparsed = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      // Moxfield-style exports separate the commander block from the deck with a blank line and no "Deck" header.
      if (current === 'commanders' && deck.commanders.length > 0) current = 'mainboard';
      continue;
    }

    const nameMatch = NAME_LINE.exec(line);
    if (nameMatch) {
      deck.name = nameMatch[1].trim();
      continue;
    }

    const header = headerBoard(line);
    if (header !== undefined && !QUANTITY.test(line)) {
      current = header;
      sawAnyHeader = true;
      if (header === 'commanders') sawExplicitCommanderSection = true;
      continue;
    }

    // Other comment lines are ignored.
    if (/^(\/\/|#(?!!)|;)/.test(line)) continue;

    const parsed = parseCardLine(line);
    if (!parsed) {
      unparsed++;
      deck.warnings.push(`Could not parse line: "${line}"`);
      continue;
    }
    const board = parsed.board ?? current;
    if (board === 'ignore') continue;
    if (board === 'commanders') {
      parsed.entry.isCommander = true;
      addEntry(deck.commanders, parsed.entry);
    } else if (board === 'sideboard') {
      addEntry(deck.sideboard, parsed.entry);
    } else {
      addEntry(deck.mainboard, parsed.entry);
    }
  }

  const total = deck.mainboard.reduce((n, e) => n + e.quantity, 0) + deck.commanders.reduce((n, e) => n + e.quantity, 0);
  if (deck.commanders.length === 0 && total > 0) {
    deck.warnings.push(
      sawAnyHeader || sawExplicitCommanderSection
        ? 'No commander was found in the list; pick one from the mainboard.'
        : 'No commander section or *CMDR* marker found; pick a commander from the mainboard.',
    );
  }
  if (deck.commanders.length > 2) {
    deck.warnings.push(`Found ${deck.commanders.length} commanders; Commander decks have at most two.`);
  }
  if (total > 0 && total !== 100) {
    deck.warnings.push(`Deck has ${total} cards including commander(s); Commander decks have exactly 100.`);
  }
  if (unparsed > 0 && total === 0) {
    deck.warnings.push('No cards could be parsed from the text.');
  }
  return deck;
}
