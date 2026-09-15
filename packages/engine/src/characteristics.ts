import type { Game } from './game.js';
import type { CardType, Color, ContinuousEffect, GameObject, Modification, ObjectId, RuleModification, Supertype } from './types.js';
import { parseTypeLine } from './typeline.js';
import { manaValue as costManaValue } from './mana.js';
import { matchesFilter } from './filters.js';
import type { StaticAbilitySpec } from './script.js';

/** Fully computed characteristics of an object after applying all continuous effects. */
export interface Characteristics {
  name: string;
  manaCost: string;
  manaValue: number;
  types: string[];
  supertypes: Supertype[];
  subtypes: string[];
  colors: Color[];
  keywords: Set<string>;
  /** "Protection from X" qualities. */
  protections: string[];
  hexproofFrom: string[];
  power: number | null;
  toughness: number | null;
  loyalty: number | null;
  oracleText: string;
  rules: RuleModification[];
  lostAllAbilities: boolean;
  controller: string;
  /** Keyword parameters like Ward {2} */
  wardCost?: string;
}

function parsePT(v: string | undefined, obj: GameObject, g: Game): number | null {
  if (v === undefined || v === '') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  // "*" and "1+*" style characteristic-defining abilities — evaluated via scripts if present; default 0.
  const m = v.match(/^(-?\d+)?\+?\*$/);
  if (m) {
    const base = m[1] ? parseInt(m[1], 10) : 0;
    return base + (g.evaluateStarPT(obj) ?? 0);
  }
  return 0;
}

function layerOrder(m: Modification): number {
  switch (m.layer) {
    case 'copy':
      return 1;
    case 'control':
      return 2;
    case 4:
      return 4;
    case 5:
      return 5;
    case 6:
      return 6;
    case '7b':
      return 72;
    case '7c':
      return 73;
    case '7d':
      return 74;
    case 'rule':
      return 99;
  }
}

/**
 * Compute characteristics. Continuous effects come from two sources:
 * 1. Static abilities of permanents on the battlefield (recomputed each time).
 * 2. Stored ContinuousEffect entries created by resolved spells/abilities.
 */
export function computeCharacteristics(g: Game, id: ObjectId): Characteristics {
  const obj = g.state.objects[id];
  const effects: { mod: Modification; ts: number; sourceId: ObjectId | null }[] = [];

  // Stored effects
  for (const ce of g.state.continuousEffects) {
    if (affects(g, ce, obj)) effects.push({ mod: ce.modification, ts: ce.timestamp, sourceId: ce.sourceId });
  }
  // Static abilities from battlefield permanents (and a few from other zones)
  for (const src of Object.values(g.state.objects)) {
    if (src.zone !== 'battlefield' && src.zone !== 'command') continue;
    if (src.phasedOut) continue;
    const script = g.scriptFor(src);
    for (const ab of script.abilities) {
      if (ab.kind !== 'static') continue;
      if ((ab.zone ?? 'battlefield') !== src.zone) continue;
      if (!ab.modification && !ab.rule) continue;
      if (ab.condition && !g.checkCondition(ab.condition, { sourceId: src.id, controller: src.controller })) continue;
      if (!staticAffects(g, ab, src, obj)) continue;
      if (ab.modification) effects.push({ mod: ab.modification, ts: src.timestamp, sourceId: src.id });
      if (ab.rule) effects.push({ mod: { layer: 'rule', rule: ab.rule }, ts: src.timestamp, sourceId: src.id });
    }
  }
  effects.sort((a, b) => layerOrder(a.mod) - layerOrder(b.mod) || a.ts - b.ts);

  // Base characteristics (layer 0 + copy in layer 1)
  let card = obj.copyOf ?? obj.card;
  for (const e of effects) if (e.mod.layer === 'copy') card = e.mod.card;
  const face = obj.faceIndex > 0 && card.faces?.[obj.faceIndex] ? card.faces[obj.faceIndex] : card;
  const parsed = parseTypeLine(face.typeLine);
  const ch: Characteristics = {
    name: face.name,
    manaCost: face.manaCost,
    manaValue: costManaValue(face.manaCost, obj.xValue ?? 0),
    types: [...parsed.types],
    supertypes: [...parsed.supertypes],
    subtypes: [...parsed.subtypes],
    colors: [...face.colors],
    keywords: new Set<string>(),
    protections: [],
    hexproofFrom: [],
    power: parsePT(face.power, obj, g),
    toughness: parsePT(face.toughness, obj, g),
    loyalty: face.loyalty ? parseInt(face.loyalty, 10) || 0 : null,
    oracleText: face.oracleText,
    rules: [],
    lostAllAbilities: false,
    controller: obj.controller,
  };
  if (obj.faceDown) {
    ch.name = '';
    ch.types = ['Creature'];
    ch.supertypes = [];
    ch.subtypes = [];
    ch.colors = [];
    ch.power = 2;
    ch.toughness = 2;
    ch.oracleText = '';
    ch.manaCost = '';
    ch.manaValue = 0;
  } else {
    // Keywords printed on the card
    for (const k of card.keywords ?? []) ch.keywords.add(k);
    if (obj.faceIndex > 0) {
      ch.keywords = new Set(g.keywordsFromText(face.oracleText));
    }
    for (const k of g.keywordsFromText(face.oracleText)) ch.keywords.add(k);
    for (const p of g.protectionsFromText(face.oracleText)) ch.protections.push(p);
    for (const p of g.hexproofFromText(face.oracleText)) ch.hexproofFrom.push(p);
    const ward = face.oracleText.match(/Ward (\{[^\n]*?\}|—[^\n]*)/);
    if (ward) ch.wardCost = ward[1].trim();
  }
  // Layer 2: control
  for (const e of effects) if (e.mod.layer === 'control') ch.controller = e.mod.controller;
  // Layer 4: types
  for (const e of effects) {
    if (e.mod.layer !== 4) continue;
    if (e.mod.setTypes) ch.types = [...e.mod.setTypes];
    if (e.mod.addTypes) for (const t of e.mod.addTypes) if (!ch.types.includes(t)) ch.types.push(t);
    const rm = e.mod.removeTypes;
    if (rm) ch.types = ch.types.filter((t) => !rm.includes(t));
    if (e.mod.addSubtypes) for (const t of e.mod.addSubtypes) if (!ch.subtypes.includes(t)) ch.subtypes.push(t);
  }
  // Layer 5: colors
  for (const e of effects) {
    if (e.mod.layer !== 5) continue;
    if (e.mod.setColors) ch.colors = [...e.mod.setColors];
    if (e.mod.addColors) for (const c of e.mod.addColors) if (!ch.colors.includes(c)) ch.colors.push(c);
  }
  // Layer 6: abilities
  for (const e of effects) {
    if (e.mod.layer !== 6) continue;
    if (e.mod.loseAllAbilities) {
      ch.keywords.clear();
      ch.protections = [];
      ch.hexproofFrom = [];
      ch.lostAllAbilities = true;
    }
    if (e.mod.addKeywords) {
      for (const k of e.mod.addKeywords) {
        const prot = k.match(/^Protection from (.+)$/i);
        const hex = k.match(/^Hexproof from (.+)$/i);
        if (prot) ch.protections.push(prot[1]);
        else if (hex) ch.hexproofFrom.push(hex[1]);
        else ch.keywords.add(k);
      }
    }
    if (e.mod.removeKeywords) for (const k of e.mod.removeKeywords) ch.keywords.delete(k);
  }
  // Layer 7b: set P/T
  for (const e of effects) {
    if (e.mod.layer !== '7b') continue;
    if (e.mod.setPower !== undefined) ch.power = e.mod.setPower;
    if (e.mod.setToughness !== undefined) ch.toughness = e.mod.setToughness;
  }
  // Layer 7c: modify P/T (effects + counters)
  if (ch.types.includes('Creature') || ch.power !== null) {
    let dp = 0;
    let dt = 0;
    for (const e of effects) {
      if (e.mod.layer !== '7c') continue;
      dp += e.mod.power;
      dt += e.mod.toughness;
    }
    dp += (obj.counters['+1/+1'] ?? 0) - (obj.counters['-1/-1'] ?? 0);
    dt += (obj.counters['+1/+1'] ?? 0) - (obj.counters['-1/-1'] ?? 0);
    for (const [k, n] of Object.entries(obj.counters)) {
      const m = k.match(/^([+-]\d+)\/([+-]\d+)$/);
      if (m && k !== '+1/+1' && k !== '-1/-1') {
        dp += parseInt(m[1], 10) * n;
        dt += parseInt(m[2], 10) * n;
      }
    }
    if (ch.power !== null) ch.power += dp;
    if (ch.toughness !== null) ch.toughness += dt;
  }
  // Layer 7d: switch
  for (const e of effects) {
    if (e.mod.layer !== '7d') continue;
    const p = ch.power;
    ch.power = ch.toughness;
    ch.toughness = p;
  }
  // Rules
  for (const e of effects) if (e.mod.layer === 'rule') ch.rules.push(e.mod.rule);
  // Loyalty counters define current loyalty on battlefield
  if (obj.zone === 'battlefield' && ch.types.includes('Planeswalker')) ch.loyalty = obj.counters['loyalty'] ?? 0;
  return ch;
}

function affects(g: Game, ce: ContinuousEffect, obj: GameObject): boolean {
  if (ce.affected.kind === 'fixed') return ce.affected.ids.includes(obj.id);
  return matchesFilter(g, obj, ce.affected.filter, { sourceId: ce.sourceId, controller: ce.controller });
}

function staticAffects(g: Game, ab: StaticAbilitySpec, src: GameObject, obj: GameObject): boolean {
  const target = ab.affects ?? (ab.rule ? ab.ruleAffects : undefined);
  if (target === undefined) return false;
  if (target === 'self') return obj.id === src.id;
  if (target === 'attachedTo') return src.attachedTo === obj.id;
  if (target === 'controller' || target === 'opponents' || target === 'allPlayers' || target === 'attachedToController') return false; // player-level rules handled elsewhere
  if (obj.zone !== 'battlefield' && !(target as { zone?: unknown }).zone) return false;
  return matchesFilter(g, obj, target, { sourceId: src.id, controller: src.controller });
}

export function isCreature(ch: Characteristics): boolean {
  return ch.types.includes('Creature');
}
export function isType(ch: Characteristics, t: CardType): boolean {
  return ch.types.includes(t);
}
