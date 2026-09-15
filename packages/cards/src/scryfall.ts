import type { CardData, CardFace, Color, Layout, ManaColor } from '@commander/engine';

/** Minimal typing of a Scryfall card object (https://scryfall.com/docs/api/cards). */
export interface ScryfallImageUris {
  small?: string;
  normal?: string;
  large?: string;
  art_crop?: string;
  png?: string;
  border_crop?: string;
}

export interface ScryfallCardFace {
  object?: 'card_face';
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors?: string[];
  color_indicator?: string[];
  image_uris?: ScryfallImageUris;
  oracle_id?: string;
  flavor_name?: string;
}

export type ScryfallLegality = 'legal' | 'not_legal' | 'restricted' | 'banned';

export interface ScryfallCard {
  object?: 'card';
  id: string;
  oracle_id?: string;
  name: string;
  lang?: string;
  layout: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors?: string[];
  color_identity?: string[];
  color_indicator?: string[];
  keywords?: string[];
  card_faces?: ScryfallCardFace[];
  image_uris?: ScryfallImageUris;
  legalities?: Record<string, ScryfallLegality | string>;
  produced_mana?: string[];
  set?: string;
  set_name?: string;
  set_type?: string;
  collector_number?: string;
  rarity?: string;
  games?: string[];
  digital?: boolean;
  reserved?: boolean;
  oversized?: boolean;
  released_at?: string;
}

const COLOR_SET = new Set<string>(['W', 'U', 'B', 'R', 'G']);
const MANA_COLOR_SET = new Set<string>(['W', 'U', 'B', 'R', 'G', 'C']);
const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

/** Layouts that are never real cards in a deck. */
const UNPLAYABLE_LAYOUTS = new Set<string>([
  'token',
  'double_faced_token',
  'art_series',
  'emblem',
  'vanguard',
  'scheme',
  'planar',
]);

const KNOWN_LAYOUTS = new Set<Layout>([
  'normal', 'split', 'flip', 'transform', 'modal_dfc', 'meld', 'leveler', 'class', 'saga', 'adventure', 'mutate',
  'prototype', 'battle', 'planar', 'scheme', 'vanguard', 'token', 'double_faced_token', 'emblem', 'augment', 'host',
  'art_series', 'reversible_card', 'case',
]);

/** Layouts where the card is printed with more than one face we should expose to the engine. */
export const MULTI_FACE_LAYOUTS = new Set<string>(['transform', 'modal_dfc', 'adventure', 'split', 'flip', 'meld', 'reversible_card']);

function toColors(raw: string[] | undefined): Color[] {
  if (!raw) return [];
  return COLOR_ORDER.filter((c) => raw.includes(c));
}

function unionColors(lists: Color[][]): Color[] {
  const set = new Set<Color>();
  for (const l of lists) for (const c of l) set.add(c);
  return COLOR_ORDER.filter((c) => set.has(c));
}

/** Derive colors from mana symbols, used when Scryfall omits per-face colors (split / adventure faces). */
export function colorsFromManaCost(manaCost: string | undefined): Color[] {
  if (!manaCost) return [];
  const found = new Set<Color>();
  for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
    for (const ch of m[1].split('/')) if (COLOR_SET.has(ch)) found.add(ch as Color);
  }
  return COLOR_ORDER.filter((c) => found.has(c));
}

function toLayout(layout: string): Layout {
  return KNOWN_LAYOUTS.has(layout as Layout) ? (layout as Layout) : 'normal';
}

function faceFromScryfall(f: ScryfallCardFace, fallbackImage: string | undefined): CardFace {
  const colors = f.colors ? toColors(f.colors) : f.color_indicator ? toColors(f.color_indicator) : colorsFromManaCost(f.mana_cost);
  const face: CardFace = {
    name: f.name,
    manaCost: f.mana_cost ?? '',
    typeLine: f.type_line ?? '',
    oracleText: f.oracle_text ?? '',
    colors,
  };
  if (f.power !== undefined) face.power = f.power;
  if (f.toughness !== undefined) face.toughness = f.toughness;
  if (f.loyalty !== undefined) face.loyalty = f.loyalty;
  if (f.defense !== undefined) face.defense = f.defense;
  const img = f.image_uris?.normal ?? fallbackImage;
  if (img) face.imageUri = img;
  return face;
}

/** Convert a Scryfall card into the engine's CardData. */
export function toCardData(c: ScryfallCard): CardData {
  const layout = toLayout(c.layout);
  const topImage = c.image_uris?.normal;
  const scryfallFaces = c.card_faces && c.card_faces.length > 0 ? c.card_faces : undefined;
  const faces = scryfallFaces?.map((f) => faceFromScryfall(f, topImage));
  const front = faces?.[0];

  // Top-level characteristics come from the front face when the card has faces.
  const manaCost = front ? front.manaCost : (c.mana_cost ?? '');
  const typeLine = front ? front.typeLine : (c.type_line ?? '');
  const oracleText = front ? front.oracleText : (c.oracle_text ?? '');

  let colors: Color[];
  if (layout === 'split' && faces) {
    colors = c.colors ? toColors(c.colors) : unionColors(faces.map((f) => f.colors));
  } else if (front) {
    colors = front.colors.length > 0 || !c.colors ? front.colors : toColors(c.colors);
  } else {
    colors = c.colors ? toColors(c.colors) : colorsFromManaCost(c.mana_cost);
  }

  const card: CardData = {
    name: c.name,
    manaCost,
    typeLine,
    oracleText,
    colors,
    oracleId: c.oracle_id ?? front?.name ?? c.id,
    scryfallId: c.id,
    layout,
    cmc: typeof c.cmc === 'number' ? c.cmc : 0,
    colorIdentity: toColors(c.color_identity),
    keywords: Array.isArray(c.keywords) ? [...c.keywords] : [],
  };

  const power = front ? front.power : c.power;
  const toughness = front ? front.toughness : c.toughness;
  const loyalty = front ? front.loyalty : c.loyalty;
  const defense = front ? front.defense : c.defense;
  if (power !== undefined) card.power = power;
  if (toughness !== undefined) card.toughness = toughness;
  if (loyalty !== undefined) card.loyalty = loyalty;
  if (defense !== undefined) card.defense = defense;

  const imageUri = topImage ?? front?.imageUri;
  if (imageUri) card.imageUri = imageUri;

  if (faces && (MULTI_FACE_LAYOUTS.has(layout) || faces.length > 1)) card.faces = faces;

  if (c.produced_mana && c.produced_mana.length > 0) {
    const produced = c.produced_mana.filter((m) => MANA_COLOR_SET.has(m)) as ManaColor[];
    if (produced.length > 0) card.producedMana = produced;
  }
  if (layout === 'token' || layout === 'double_faced_token') card.isToken = true;
  return card;
}

/** Whether a Scryfall card is a real, paper-playable card (not a token, emblem, art card, digital-only card ...). */
export function isPlayableCard(c: ScryfallCard): boolean {
  if (!c || typeof c.name !== 'string') return false;
  if (UNPLAYABLE_LAYOUTS.has(c.layout)) return false;
  if (!Array.isArray(c.games) || !c.games.includes('paper')) return false;
  if (c.set_type === 'memorabilia' || c.set_type === 'token' || c.set_type === 'minigame') return false;
  if (c.type_line && /^(Token|Card|Emblem|Stickers?|Attraction|Hero|Conspiracy|Dungeon|Phenomenon|Plane|Scheme|Vanguard)\b/.test(c.type_line)) return false;
  return true;
}

/** Commander legality: banned cards are still importable, but should be flagged by the caller. */
export function isCommanderLegal(c: ScryfallCard): boolean {
  const legality = c.legalities?.commander;
  return legality !== undefined && legality !== 'not_legal';
}

export function isCommanderBanned(c: ScryfallCard): boolean {
  return c.legalities?.commander === 'banned';
}
