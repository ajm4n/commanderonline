/** One line of a decklist: a card name and how many copies. */
export interface DeckEntry {
  name: string;
  quantity: number;
  /** Set code as printed in the list, lower-cased (e.g. "c21"). */
  set?: string;
  collectorNumber?: string;
  isCommander?: boolean;
  /** Free-form categories / tags carried over from the source (Archidekt categories, bracket tags). */
  categories?: string[];
}

export type DeckSource = 'moxfield' | 'archidekt' | 'text' | 'tappedout' | 'unknown';

export interface ImportedDeck {
  name: string;
  source: DeckSource;
  commanders: DeckEntry[];
  mainboard: DeckEntry[];
  sideboard: DeckEntry[];
  url?: string;
  warnings: string[];
}

export function emptyDeck(source: DeckSource, name = 'Imported deck'): ImportedDeck {
  return { name, source, commanders: [], mainboard: [], sideboard: [], warnings: [] };
}

/** Normalise a card name for storage: collapse whitespace, unify split-card separators. */
export function normalizeCardName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*\/{1,2}\s*/g, ' // ')
    .trim();
}

/** Add an entry to a board, merging with an existing entry of the same name. */
export function addEntry(board: DeckEntry[], entry: DeckEntry): void {
  const key = entry.name.toLowerCase();
  const existing = board.find((e) => e.name.toLowerCase() === key);
  if (existing) {
    existing.quantity += entry.quantity;
    if (!existing.set && entry.set) existing.set = entry.set;
    if (!existing.collectorNumber && entry.collectorNumber) existing.collectorNumber = entry.collectorNumber;
    if (entry.isCommander) existing.isCommander = true;
    if (entry.categories?.length) {
      existing.categories = Array.from(new Set([...(existing.categories ?? []), ...entry.categories]));
    }
    return;
  }
  board.push(entry);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function asQuantity(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return Math.max(1, parseInt(v, 10));
  return 1;
}
