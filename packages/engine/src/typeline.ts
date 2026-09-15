import type { CardType, Supertype } from './types.js';

const CARD_TYPES: CardType[] = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery'];
const SUPERTYPES: Supertype[] = ['Basic', 'Legendary', 'Snow', 'World'];

export interface ParsedTypeLine {
  supertypes: Supertype[];
  types: CardType[];
  subtypes: string[];
}

/** Parse "Legendary Creature — Elf Druid" into its parts. */
export function parseTypeLine(typeLine: string): ParsedTypeLine {
  const [left, right] = typeLine.split(/\s[—-]\s/);
  const words = (left ?? '').trim().split(/\s+/).filter(Boolean);
  const supertypes: Supertype[] = [];
  const types: CardType[] = [];
  for (const w of words) {
    if ((SUPERTYPES as string[]).includes(w)) supertypes.push(w as Supertype);
    else if ((CARD_TYPES as string[]).includes(w)) types.push(w as CardType);
    else if (w === 'Tribal') types.push('Kindred');
  }
  const subtypes = (right ?? '').trim().split(/\s+/).filter(Boolean);
  return { supertypes, types, subtypes };
}

export function buildTypeLine(p: ParsedTypeLine): string {
  const left = [...p.supertypes, ...p.types].join(' ');
  return p.subtypes.length ? `${left} — ${p.subtypes.join(' ')}` : left;
}

export const BASIC_LAND_TYPES: Record<string, 'W' | 'U' | 'B' | 'R' | 'G'> = {
  Plains: 'W',
  Island: 'U',
  Swamp: 'B',
  Mountain: 'R',
  Forest: 'G',
};
