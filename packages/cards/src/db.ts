import type { CardData } from '@commander/engine';

/**
 * Normalize a card name for lookup: lower-case, diacritics stripped, whitespace
 * collapsed, trailing punctuation removed. "Lim-Dûl's Vault" and "lim-dul's vault "
 * normalize to the same key.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?'"]+$/g, '')
    .trim();
}

/** Split "Front // Back" into its face names. */
function splitFullName(name: string): string[] {
  return name.split('//').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * In-memory card database. Pure data structure with no I/O so it can be
 * bundled for the browser; see `db-node.ts` for the loaders.
 */
export class CardDb {
  private readonly cards: CardData[];
  /** normalized name -> card. Full names and front-face names win over back-face names. */
  private readonly byNameIndex = new Map<string, CardData>();
  private readonly byOracleIdIndex = new Map<string, CardData>();
  /** Every (normalized) name a card can be found under, for search. */
  private readonly searchKeys: { key: string; card: CardData }[] = [];

  constructor(cards: CardData[]) {
    this.cards = [...cards];

    // First pass: primary names (full name, front face). These must never be
    // shadowed by another card's back face.
    for (const card of this.cards) {
      if (card.oracleId && !this.byOracleIdIndex.has(card.oracleId)) this.byOracleIdIndex.set(card.oracleId, card);
      const primaries = new Set<string>([normalizeName(card.name)]);
      const parts = splitFullName(card.name);
      if (parts.length > 1) primaries.add(normalizeName(parts[0]));
      const front = card.faces?.[0];
      if (front) primaries.add(normalizeName(front.name));
      for (const key of primaries) {
        if (key && !this.byNameIndex.has(key)) this.byNameIndex.set(key, card);
      }
    }

    // Second pass: secondary face names (back / adventure / right half), only
    // when they do not collide with a primary name.
    for (const card of this.cards) {
      const secondaries = new Set<string>();
      const parts = splitFullName(card.name);
      for (const p of parts.slice(1)) secondaries.add(normalizeName(p));
      for (const f of card.faces?.slice(1) ?? []) secondaries.add(normalizeName(f.name));
      for (const key of secondaries) {
        if (key && !this.byNameIndex.has(key)) this.byNameIndex.set(key, card);
      }
    }

    // Search keys: every distinct name a card is known under.
    for (const card of this.cards) {
      const keys = new Set<string>([normalizeName(card.name)]);
      for (const p of splitFullName(card.name)) keys.add(normalizeName(p));
      for (const f of card.faces ?? []) keys.add(normalizeName(f.name));
      for (const key of keys) if (key) this.searchKeys.push({ key, card });
    }
    this.searchKeys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Look up a card by name. Case-insensitive; accepts the front-face name, the
   * full "Front // Back" name, or a back-face name; ignores diacritics, extra
   * whitespace and trailing punctuation.
   */
  byName(name: string): CardData | undefined {
    if (typeof name !== 'string') return undefined;
    const key = normalizeName(name);
    if (!key) return undefined;
    const hit = this.byNameIndex.get(key);
    if (hit) return hit;
    // "Front / Back" or "Front//Back" spellings.
    if (key.includes('/')) {
      const parts = key.split(/\s*\/+\s*/).filter(Boolean);
      const joined = parts.join(' // ');
      return this.byNameIndex.get(joined) ?? (parts[0] ? this.byNameIndex.get(parts[0]) : undefined);
    }
    return undefined;
  }

  byOracleId(id: string): CardData | undefined {
    return this.byOracleIdIndex.get(id);
  }

  /**
   * Search by name: cards whose name (or a face name) starts with the query
   * come first, then cards where it appears anywhere. Each card appears once.
   */
  search(query: string, limit = 20): CardData[] {
    const q = normalizeName(query);
    if (!q || limit <= 0) return [];
    const seen = new Set<CardData>();
    const prefix: CardData[] = [];
    const substring: CardData[] = [];
    for (const { key, card } of this.searchKeys) {
      if (seen.has(card)) continue;
      if (key.startsWith(q)) {
        seen.add(card);
        prefix.push(card);
        if (prefix.length >= limit) break;
      }
    }
    if (prefix.length < limit) {
      for (const { key, card } of this.searchKeys) {
        if (seen.has(card)) continue;
        if (key.includes(q)) {
          seen.add(card);
          substring.push(card);
          if (prefix.length + substring.length >= limit) break;
        }
      }
    }
    return [...prefix, ...substring].slice(0, limit);
  }

  all(): CardData[] {
    return [...this.cards];
  }

  get size(): number {
    return this.cards.length;
  }
}
