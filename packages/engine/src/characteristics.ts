import type { Game } from './game.js';
import type { CardType, Color, ContinuousEffect, GameObject, Modification, ObjectFilter, ObjectId, RuleModification, Supertype } from './types.js';
import { parseTypeLine } from './typeline.js';
import { manaValue as costManaValue } from './mana.js';
import { objectsMatching, matchesFilter } from './filters.js';
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
  /** `applies` re-evaluates the effect's filter against a working set of characteristics (for dependency ordering). */
  const effects: { mod: Modification; ts: number; sourceId: ObjectId | null; applies?: (ch: Characteristics) => boolean }[] = [];

  // Stored effects
  for (const ce of g.state.continuousEffects) {
    if (affects(g, ce, obj)) effects.push({ mod: ce.modification, ts: ce.timestamp, sourceId: ce.sourceId, applies: ce.affected.kind === 'filter' ? (ch) => matchesFilter(g, obj, (ce.affected as { filter: ObjectFilter }).filter, { sourceId: ce.sourceId, controller: ce.controller, chOverride: ch }) : undefined });
  }
  // Static abilities from battlefield permanents (and a few from other zones)
  for (const src of Object.values(g.state.objects)) {
    if (src.zone !== 'battlefield' && src.zone !== 'command') continue;
    if (src.phasedOut) continue;
    // A source that has lost all abilities (Humility, Blood Moon on Urborg) grants nothing (rule 613.8 dependency).
    if (src.id !== id && g.characteristics(src.id).lostAllAbilities) continue;
    const script = g.scriptFor(src);
    for (const ab of script.abilities) {
      if (ab.kind !== 'static') continue;
      if ((ab.zone ?? 'battlefield') !== src.zone) continue;
      if (!ab.modification && !ab.rule) continue;
      if (ab.condition && !g.checkCondition(ab.condition, { sourceId: src.id, controller: src.controller })) continue;
      if (!staticAffects(g, ab, src, obj)) continue;
      const target = ab.affects ?? ab.ruleAffects;
      const applies = target && typeof target === 'object' ? (ch: Characteristics) => matchesFilter(g, obj, target as ObjectFilter, { sourceId: src.id, controller: src.controller, chOverride: ch }) : undefined;
      if (ab.modification) effects.push({ mod: ab.modification, ts: src.timestamp, sourceId: src.id, applies });
      if (ab.rule) {
        // "is goaded" from a static: goaded by the source's controller.
        const rule = ab.rule.kind === 'custom' && ab.rule.tag === 'goaded' && ab.rule.data === '__controller__' ? { ...ab.rule, data: src.controller } : ab.rule;
        effects.push({ mod: { layer: 'rule', rule }, ts: src.timestamp, sourceId: src.id, applies });
      }
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
    // Disguise / cloak: the face-down creature has ward.
    const ward = obj.memory['faceDownWard'];
    if (typeof ward === 'string') {
      ch.keywords.add('Ward');
      ch.oracleText = `Ward ${ward}`;
    }
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
  ch.controller = obj.baseController ?? obj.controller;
  for (const e of effects) {
    if (e.mod.layer !== 'control') continue;
    if (e.mod.controller === 'sourceController') {
      const src = e.sourceId !== null ? g.state.objects[e.sourceId] : undefined;
      if (src && src.zone === 'battlefield') ch.controller = src.controller;
    } else ch.controller = e.mod.controller;
  }
  /**
   * Rule 613.8: within a layer, an effect that changes whether another applies is applied first.
   * We detect that by re-evaluating each filter-based effect against the characteristics with
   * and without the other effect applied; ties and cycles fall back to timestamp order.
   */
  const orderLayer = (layer: Modification['layer'], apply: (ch: Characteristics, m: Modification) => void) => {
    const list = effects.filter((e) => e.mod.layer === layer);
    if (list.length < 2) return list;
    const depends = (a: typeof list[number], b: typeof list[number]) => {
      // does b depend on a? (applying a changes whether b applies)
      if (!b.applies) return false;
      const before = b.applies(ch);
      const trial = cloneCh(ch);
      apply(trial, a.mod);
      return b.applies(trial) !== before;
    };
    const ordered: typeof list = [];
    const remaining = [...list];
    while (remaining.length) {
      // pick the earliest remaining effect that no other remaining effect must precede
      let pick = remaining.find((b) => !remaining.some((a) => a !== b && depends(a, b) && !depends(b, a)));
      if (!pick) pick = remaining[0];
      ordered.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }
    return ordered;
  };
  const applyTypes = (c: Characteristics, m: Modification) => {
    if (m.layer !== 4) return;
    if (m.setTypes) c.types = [...m.setTypes];
    if (m.addTypes) for (const t of m.addTypes) if (!c.types.includes(t)) c.types.push(t);
    const rm = m.removeTypes;
    if (rm) c.types = c.types.filter((t) => !rm.includes(t));
    if (m.setSubtypes) c.subtypes = [...m.setSubtypes];
    if (m.addSubtypes) for (const t of m.addSubtypes) if (!c.subtypes.includes(t)) c.subtypes.push(t);
    if (m.addSupertypes) for (const t of m.addSupertypes) if (!c.supertypes.includes(t)) c.supertypes.push(t);
  };
  const applyColors = (c: Characteristics, m: Modification) => {
    if (m.layer !== 5) return;
    if (m.setColors) c.colors = [...m.setColors];
    if (m.addColors) for (const col of m.addColors) if (!c.colors.includes(col)) c.colors.push(col);
  };
  // Layer 4: types
  for (const e of orderLayer(4, applyTypes)) {
    let mod = e.mod;
    if (mod.layer === 4 && mod.addSubtypesFromMemory) {
      const src = e.sourceId !== null && e.sourceId !== undefined ? g.state.objects[e.sourceId] : undefined;
      const v = src?.memory[mod.addSubtypesFromMemory];
      mod = { ...mod, addSubtypes: [...(mod.addSubtypes ?? []), ...(typeof v === 'string' ? [v] : [])] };
    }
    applyTypes(ch, mod);
  }
  // The Ring-bearer is legendary (level 1).
  if (effects.some((e) => e.mod.layer === 'rule' && e.mod.rule.kind === 'custom' && e.mod.rule.tag === 'ringBearer') && !ch.supertypes.includes('Legendary')) ch.supertypes.push('Legendary');
  // Layer 5: colors
  for (const e of orderLayer(5, applyColors)) applyColors(ch, e.mod);
  // Layer 6: abilities
  for (const e of orderLayer(6, (c, m) => applyAbilities(c, m))) applyAbilities(ch, e.mod);
  // Layer 7b: set P/T
  for (const e of effects) {
    if (e.mod.layer !== '7b') continue;
    if (e.mod.setPower !== undefined) ch.power = e.mod.setPower;
    if (e.mod.setToughness !== undefined) ch.toughness = e.mod.setToughness;
    const src = e.sourceId !== null ? g.state.objects[e.sourceId] : undefined;
    const actx = { sourceId: e.sourceId, controller: src?.controller ?? obj.controller, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} };
    if (e.mod.powerAmount !== undefined) ch.power = g.resolveAmount(e.mod.powerAmount, actx);
    if (e.mod.toughnessAmount !== undefined) ch.toughness = g.resolveAmount(e.mod.toughnessAmount, actx);
  }
  // Layer 7c: modify P/T (effects + counters)
  if (ch.types.includes('Creature') || ch.power !== null) {
    let dp = 0;
    let dt = 0;
    for (const e of effects) {
      if (e.mod.layer !== '7c') continue;
      let times = 1;
      if (e.mod.perCount) {
        const src = e.sourceId !== null ? g.state.objects[e.sourceId] : undefined;
        times = objectsMatching(g, e.mod.perCount, { sourceId: e.sourceId, controller: src?.controller ?? obj.controller }).length;
      } else if (e.mod.perAmount !== undefined) {
        const src = e.sourceId !== null ? g.state.objects[e.sourceId] : undefined;
        times = g.resolveAmount(e.mod.perAmount, { sourceId: e.sourceId, controller: src?.controller ?? obj.controller, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} });
      }
      dp += e.mod.power * times;
      dt += e.mod.toughness * times;
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

function applyAbilities(c: Characteristics, m: Modification) {
  if (m.layer !== 6) return;
  if (m.loseAllAbilities) {
    c.keywords.clear();
    c.protections = [];
    c.hexproofFrom = [];
    c.lostAllAbilities = true;
  }
  if (m.addKeywords) {
    for (const k of m.addKeywords) {
      const prot = k.match(/^Protection from (.+)$/i);
      const hex = k.match(/^Hexproof from (.+)$/i);
      if (prot) c.protections.push(prot[1]);
      else if (hex) c.hexproofFrom.push(hex[1]);
      else c.keywords.add(k);
    }
  }
  if (m.removeKeywords) for (const k of m.removeKeywords) c.keywords.delete(k);
}

function cloneCh(c: Characteristics): Characteristics {
  return { ...c, types: [...c.types], supertypes: [...c.supertypes], subtypes: [...c.subtypes], colors: [...c.colors], keywords: new Set(c.keywords), protections: [...c.protections], hexproofFrom: [...c.hexproofFrom], rules: [...c.rules] };
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
