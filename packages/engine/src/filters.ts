import type { Game } from './game.js';
import type { GameObject, ObjectFilter, ObjectId, PlayerId, Target } from './types.js';
import type { TargetSpec } from './script.js';
import type { Characteristics } from './characteristics.js';

export interface FilterContext {
  /** The object whose ability is evaluating the filter (for "other", "you control"). */
  sourceId: ObjectId | null;
  /** The player evaluating ("you"). */
  controller: PlayerId;
  x?: number;
  /** Last-known characteristics to use instead of live ones (dies / leaves triggers). */
  chOverride?: Characteristics;
  /** Zone to treat the object as being in (for look-back). */
  zoneOverride?: GameObject['zone'];
}

/** Does `obj` match `filter` from the viewpoint of `ctx`? Uses computed characteristics. */
export function matchesFilter(g: Game, obj: GameObject, filter: ObjectFilter | undefined, ctx: FilterContext): boolean {
  if (!filter) return true;
  const ch = ctx.chOverride ?? g.characteristics(obj.id);
  const zone = ctx.zoneOverride ?? obj.zone;
  if (filter.zone) {
    const zones = Array.isArray(filter.zone) ? filter.zone : [filter.zone];
    if (!zones.includes(zone)) return false;
  }
  if (filter.self && obj.id !== ctx.sourceId) return false;
  if (filter.other && obj.id === ctx.sourceId) return false;
  if (filter.types && !filter.types.some((t) => ch.types.includes(t))) return false;
  if (filter.notTypes && filter.notTypes.some((t) => ch.types.includes(t))) return false;
  if (filter.nonland && ch.types.includes('Land')) return false;
  if (filter.subtypes && !filter.subtypes.some((t) => ch.subtypes.includes(t) || (ch.keywords.has('Changeling') && ch.types.includes('Creature')))) return false;
  if (filter.notSubtypes && filter.notSubtypes.some((t) => ch.subtypes.includes(t))) return false;
  if (filter.supertypes && !filter.supertypes.some((t) => ch.supertypes.includes(t))) return false;
  if (filter.legendary !== undefined && ch.supertypes.includes('Legendary') !== filter.legendary) return false;
  if (filter.colors && !filter.colors.some((c) => ch.colors.includes(c))) return false;
  if (filter.colorless && ch.colors.length > 0) return false;
  if (filter.monocolored && ch.colors.length !== 1) return false;
  if (filter.multicolored && ch.colors.length < 2) return false;
  if (filter.controller) {
    if (filter.controller === 'you' && obj.controller !== ctx.controller) return false;
    if (filter.controller === 'opponent' && obj.controller === ctx.controller) return false;
    if (filter.controller !== 'you' && filter.controller !== 'opponent' && filter.controller !== 'any' && obj.controller !== filter.controller) return false;
  }
  if (filter.owner) {
    if (filter.owner === 'you' && obj.owner !== ctx.controller) return false;
    if (filter.owner === 'opponent' && obj.owner === ctx.controller) return false;
  }
  if (filter.tapped && !obj.tapped) return false;
  if (filter.untapped && obj.tapped) return false;
  if (filter.isToken && !obj.card.isToken) return false;
  if (filter.nonToken && obj.card.isToken) return false;
  if (filter.attacking && obj.attacking === null) return false;
  if (filter.blocking && obj.blocking.length === 0) return false;
  if (filter.attackingOrBlocking && obj.attacking === null && obj.blocking.length === 0) return false;
  if (filter.custom === 'nonbasic' && ch.supertypes.includes('Basic')) return false;
  if (filter.custom === 'colored' && ch.colors.length === 0) return false;
  if (filter.custom === 'hasAnyCounter' && !Object.values(obj.counters ?? {}).some((v) => (v ?? 0) > 0)) return false;
  if (filter.exiledWithSource) {
    const holder = ctx.sourceId !== null && ctx.sourceId !== undefined ? g.state.objects[ctx.sourceId] : null;
    const ids = (holder?.memory['exiled'] as ObjectId[] | undefined) ?? [];
    if (!ids.includes(obj.id)) return false;
  }
  if (filter.custom === 'hasX' && !/\{X\}/.test(obj.card.manaCost ?? '')) return false;
  if (filter.custom && /^non(white|blue|black|red|green)$/.test(filter.custom) && ch.colors.includes(({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[filter.custom.slice(3) as 'white'])) return false;
  if (filter.keywords && !filter.keywords.some((k) => ch.keywords.has(k))) return false;
  if (filter.withoutKeywords && filter.withoutKeywords.some((k) => ch.keywords.has(k))) return false;
  const x = ctx.x ?? 0;
  const num = (v: number | 'X') => (v === 'X' ? x : v);
  if (filter.powerLE !== undefined && !(ch.power !== null && ch.power <= num(filter.powerLE))) return false;
  if (filter.powerGE !== undefined && !(ch.power !== null && ch.power >= num(filter.powerGE))) return false;
  if (filter.toughnessLE !== undefined && !(ch.toughness !== null && ch.toughness <= filter.toughnessLE)) return false;
  if (filter.toughnessGE !== undefined && !(ch.toughness !== null && ch.toughness >= filter.toughnessGE)) return false;
  if (filter.cmcLE !== undefined && !(ch.manaValue <= num(filter.cmcLE))) return false;
  if (filter.cmcLEAmount !== undefined && !(ch.manaValue <= g.resolveAmount(filter.cmcLEAmount, { sourceId: ctx.sourceId, controller: ctx.controller, targets: [], triggerContext: {}, x: ctx.x ?? 0, modes: [], memory: {} }))) return false;
  if (filter.damaged !== undefined && (obj.damage > 0) !== filter.damaged) return false;
  if (filter.cmcEQAmount !== undefined && ch.manaValue !== g.resolveAmount(filter.cmcEQAmount, { sourceId: ctx.sourceId, controller: ctx.controller, targets: [], triggerContext: {}, x: ctx.x ?? 0, modes: [], memory: {} })) return false;
  if (filter.spellTargets !== undefined) {
    const item = g.state.stack.find((s) => s.sourceId === obj.id);
    if (!item) return false;
    const st = filter.spellTargets;
    const ok = item.targets.some((t) => {
      if (st === 'you') return t.kind === 'player' && t.id === ctx.controller;
      if (st === 'opponent') return t.kind === 'player' && t.id !== ctx.controller;
      return t.kind === 'object' && !!g.state.objects[t.id] && matchesFilter(g, g.state.objects[t.id], { ...st, zone: undefined }, ctx);
    });
    if (!ok) return false;
  }
  if (filter.hasAttachment) {
    const has = Object.values(g.state.objects).some((a) => a.attachedTo === obj.id && (filter.hasAttachment === 'any' || g.characteristics(a.id).subtypes.includes(filter.hasAttachment!)));
    if (!has) return false;
  }
  if (filter.monstrous !== undefined && !!obj.memory['monstrous'] !== filter.monstrous) return false;
  if (filter.attached !== undefined && (obj.attachedTo !== null) !== filter.attached) return false;
  if (filter.cmcGE !== undefined && !(ch.manaValue >= filter.cmcGE)) return false;
  if (filter.cmcEQ !== undefined && ch.manaValue !== filter.cmcEQ) return false;
  if (filter.isCommander !== undefined && obj.isCommander !== filter.isCommander) return false;
  if (filter.hasCounter && !(obj.counters[filter.hasCounter] > 0)) return false;
  if (filter.hasAnyCounter && !Object.values(obj.counters).some((n) => n > 0)) return false;
  if (filter.fromLibraryThisTurn && !(obj.lastZoneChange?.from === 'library' && obj.lastZoneChange.turn === g.state.turn.number)) return false;
  if (filter.enteredZoneThisTurn && obj.lastZoneChange?.turn !== g.state.turn.number) return false;
  if (filter.custom === 'ringBearer' && !ch.rules.some((r) => r.kind === 'custom' && r.tag === 'ringBearer')) return false;
  if (filter.nameIs) {
    const want = filter.nameIs === '~' ? (ctx.sourceId !== null ? g.state.objects[ctx.sourceId]?.card.name : undefined) : filter.nameIs;
    if (want !== undefined && ch.name !== want && !ch.name.startsWith(`${want} //`)) return false;
  }
  if (filter.typeIsChosen) {
    const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : undefined;
    const want = src?.chosen[filter.typeIsChosen];
    if (typeof want !== 'string' || !(ch.types.includes(want) || ch.subtypes.includes(want))) return false;
  }
  if (filter.nameIsChosen) {
    const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : undefined;
    const want = src?.chosen[filter.nameIsChosen];
    if (typeof want !== 'string' || (ch.name !== want && !ch.name.startsWith(`${want} //`))) return false;
  }
  if (filter.historic && !(ch.types.includes('Artifact') || ch.supertypes.includes('Legendary') || ch.subtypes.includes('Saga'))) return false;
  if (filter.enteredThisTurn !== undefined && obj.enteredThisTurn !== filter.enteredThisTurn) return false;
  if (filter.attachedToSource && obj.attachedTo !== ctx.sourceId) return false;
  if (filter.attachedToRef) {
    const hosts = g.resolveObjects(filter.attachedToRef, { sourceId: ctx.sourceId ?? null, controller: ctx.controller, targets: [], triggerContext: {}, x: ctx.x ?? 0, modes: [], memory: {} }).map((o) => o.id);
    if (obj.attachedTo === null || !hosts.includes(obj.attachedTo)) return false;
  }
  if (filter.attachedToFilter) {
    const host = obj.attachedTo !== null ? g.state.objects[obj.attachedTo] : undefined;
    if (!host || !matchesFilter(g, host, { ...filter.attachedToFilter, zone: 'battlefield' }, ctx)) return false;
  }
  if (filter.anyOf && !filter.anyOf.some((f) => matchesFilter(g, obj, f, ctx))) return false;
  if (filter.notZone && zone === filter.notZone) return false;
  if (filter.zoneIn && !filter.zoneIn.includes(zone)) return false;
  if (filter.toughnessGreaterThanPower && !((ch.toughness ?? 0) > (ch.power ?? 0))) return false;
  if (filter.sharesCreatureTypeWithSource) {
    const src = ctx.sourceId !== null && ctx.sourceId !== undefined ? g.state.objects[ctx.sourceId] : undefined;
    const sch = src ? g.characteristics(src.id) : undefined;
    if (!sch || !(ch.keywords.has('Changeling') || sch.keywords.has('Changeling') || ch.subtypes.some((t) => sch.subtypes.includes(t)))) return false;
  }
  if (filter.hasAdventure && !(obj.card.layout === 'adventure' || obj.card.faces?.some((f) => /Adventure/.test(f.typeLine)))) return false;
  if (filter.permanentCard && !ch.types.some((t) => ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(t))) return false;
  if (filter.modified && !(Object.values(obj.counters).some((n) => n > 0) || g.state.battlefield.some((id) => { const a = g.state.objects[id]; return !!a && a.attachedTo === obj.id && a.controller === obj.controller && ['Equipment', 'Aura'].some((t) => g.characteristics(a.id).subtypes.includes(t)); }))) return false;
  if (filter.customRule && !ch.rules.some((r) => r.kind === 'custom' && r.tag === filter.customRule)) return false;
  if (filter.faceDown !== undefined && obj.faceDown !== filter.faceDown) return false;
  if (filter.counterAtLeast && (obj.counters[filter.counterAtLeast.counter] ?? 0) < filter.counterAtLeast.n) return false;
  if (filter.withoutCounter && (obj.counters[filter.withoutCounter] ?? 0) > 0) return false;
  if (filter.sameNameAs) {
    const others = g.resolveRef(filter.sameNameAs, { sourceId: ctx.sourceId ?? null, controller: ctx.controller, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} });
    const names = new Set(others.map((t) => (t.kind === 'object' ? g.characteristics(t.id).name : t.kind === 'stackItem' ? g.state.stack.find((si) => si.id === t.id)?.text ?? '' : '')).filter(Boolean));
    if (!names.size || ![...names].some((n) => ch.name === n)) return false;
  }
  if (filter.pairedWithSource) {
    const src = ctx.sourceId !== null && ctx.sourceId !== undefined ? g.state.objects[ctx.sourceId] : undefined;
    if (!src || src.pairedWith !== obj.id) return false;
  }
  if (filter.blockingSource && (ctx.sourceId === null || ctx.sourceId === undefined || !obj.blocking.includes(ctx.sourceId))) return false;
  if (filter.chosenColor) {
    const src = ctx.sourceId !== null && ctx.sourceId !== undefined ? g.state.objects[ctx.sourceId] : undefined;
    const c = src?.memory['color'] ?? src?.chosen['color'];
    if (typeof c !== 'string' || !ch.colors.includes(c as (typeof ch.colors)[number])) return false;
  }
  if (filter.damagedBySource && (ctx.sourceId === null || ctx.sourceId === undefined || !(g.state.damagedBy[obj.id] ?? []).includes(ctx.sourceId))) return false;
  if (filter.attackedThisTurn && !obj.memory['attackedThisTurn']) return false;
  if (filter.ownerRef) {
    const owners = g.resolvePlayers(filter.ownerRef, { sourceId: ctx.sourceId ?? null, controller: ctx.controller, targets: [], triggerContext: {}, x: ctx.x ?? 0, modes: [], memory: {} });
    if (!owners.includes(obj.owner)) return false;
  }
  if (filter.dealtDamageToYouThisTurn && !(g.state.turnStats[`damagedPlayer:${obj.id}:${ctx.controller}`] ?? 0)) return false;
  if (filter.ptSumLE !== undefined && !(ch.power !== null && ch.toughness !== null && ch.power + ch.toughness <= filter.ptSumLE)) return false;
  if (filter.chosenSubtypeKey) {
    const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : undefined;
    const t = src?.memory[filter.chosenSubtypeKey];
    // "the chosen type" may be a creature type or, on cards that choose a card type, a card type.
    const ct = src?.memory['cardType'];
    if (typeof t !== 'string' && typeof ct === 'string') {
      if (!ch.types.includes(ct as (typeof ch.types)[number])) return false;
    } else if (typeof t !== 'string' || !(ch.subtypes.includes(t) || (ch.keywords.has('Changeling') && ch.types.includes('Creature')))) return false;
  }
  if (filter.lowestToughness) {
    const rest: ObjectFilter = { ...filter, lowestToughness: undefined, controller: undefined };
    let best = Infinity;
    for (const other of Object.values(g.state.objects)) {
      if (other.zone !== zone || other.controller !== obj.controller) continue;
      if (!matchesFilter(g, other, rest, ctx)) continue;
      const t = g.characteristics(other.id).toughness;
      if (t !== null && t < best) best = t;
    }
    if (ch.toughness === null || ch.toughness > best) return false;
  }
  if (filter.highestPower) {
    const rest: ObjectFilter = { ...filter, highestPower: undefined, controller: undefined };
    let best = -Infinity;
    for (const other of Object.values(g.state.objects)) {
      if (other.zone !== zone || other.controller !== obj.controller) continue;
      if (!matchesFilter(g, other, rest, ctx)) continue;
      const p = g.characteristics(other.id).power;
      if (p !== null && p > best) best = p;
    }
    if (ch.power === null || ch.power < best) return false;
  }
  return true;
}

export function objectsMatching(g: Game, filter: ObjectFilter | undefined, ctx: FilterContext, zones?: GameObject['zone'][]): GameObject[] {
  const out: GameObject[] = [];
  for (const obj of Object.values(g.state.objects)) {
    if (zones && !zones.includes(obj.zone)) continue;
    if (!filter?.zone && !zones && obj.zone !== 'battlefield') continue; // default battlefield
    if (matchesFilter(g, obj, filter, ctx)) out.push(obj);
  }
  return out;
}

/**
 * Can `source` (controlled by `controller`) target `target`? Enforces
 * hexproof, shroud, protection, ward (cost handled elsewhere) and
 * "can't be targeted" rules.
 */
export function canTarget(g: Game, target: Target, sourceId: ObjectId | null, controller: PlayerId): boolean {
  if (target.kind === 'player') {
    const p = g.state.players[target.id];
    if (!p || p.lost) return false;
    // Player hexproof (e.g. Leyline of Sanctity / Aegis of the Gods)
    const prules = g.playerRules(target.id);
    if ((p.flags['hexproof'] || prules.some((r) => r.kind === 'custom' && r.tag === 'hexproof')) && target.id !== controller) return false;
    if (p.flags['shroud'] || prules.some((r) => r.kind === 'custom' && r.tag === 'shroud')) return false;
    return true;
  }
  if (target.kind === 'stackItem') {
    return g.state.stack.some((s) => s.id === target.id);
  }
  if (target.kind === 'none') return true;
  const obj = g.state.objects[target.id];
  if (!obj) return false;
  const ch = g.characteristics(obj.id);
  if (ch.keywords.has('Shroud')) return false;
  if (ch.keywords.has('Hexproof') && obj.controller !== controller) return false;
  // "Cards in graveyards can't be the targets of spells or abilities."
  if (obj.zone === 'graveyard' && g.playerRules(obj.owner).some((r) => r.kind === 'custom' && r.tag === 'graveyardsUntargetable')) return false;
  if (sourceId !== null) {
    const src = g.state.objects[sourceId];
    if (src) {
      const sch = g.characteristics(sourceId);
      // Protection from color / type
      for (const prot of ch.protections) {
        if (protectionApplies(prot, sch.colors, sch.types, sch.subtypes, src.controller !== obj.controller)) return false;
      }
      // "Hexproof from X"
      for (const hp of ch.hexproofFrom) {
        if (obj.controller !== controller && protectionApplies(hp, sch.colors, sch.types, sch.subtypes, true)) return false;
      }
    }
  }
  for (const rule of ch.rules) {
    if (rule.kind === 'cantBeTargeted') {
      if (!rule.by) return false;
      if (rule.by === 'opponents' && obj.controller !== controller) return false;
      if (sourceId !== null) {
        const src = g.state.objects[sourceId];
        const isSpell = src?.zone === 'stack';
        const matchesSrc = !rule.filter || (src ? matchesFilter(g, src, { ...rule.filter, zone: undefined }, { sourceId, controller }) : false);
        if (rule.by === 'spells' && isSpell && matchesSrc) return false;
        if (rule.by === 'abilities' && !isSpell && matchesSrc) return false;
      }
    }
  }
  return true;
}

/** Protection quality strings: "white", "red", "creatures", "artifacts", "everything", "each color", "instants" ... */
export function protectionApplies(quality: string, colors: string[], types: string[], subtypes: string[], fromOpponent: boolean): boolean {
  const q = quality.toLowerCase();
  const colorMap: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
  if (q === 'everything' || q === 'all') return true;
  if (q === 'each color' || q === 'all colors') return colors.length > 0;
  if (q === 'multicolored') return colors.length > 1;
  if (q === 'monocolored') return colors.length === 1;
  if (q === 'colorless') return colors.length === 0;
  if (q === 'opponents' || q === 'your opponents') return fromOpponent;
  if (colorMap[q]) return colors.includes(colorMap[q]);
  const typeNames: Record<string, string> = { creatures: 'Creature', artifacts: 'Artifact', enchantments: 'Enchantment', instants: 'Instant', sorceries: 'Sorcery', planeswalkers: 'Planeswalker', lands: 'Land' };
  if (typeNames[q]) return types.includes(typeNames[q]);
  // Creature type e.g. "Dragons"
  const single = q.endsWith('s') ? q.slice(0, -1) : q;
  return subtypes.some((s) => s.toLowerCase() === single);
}

/** Enumerate all legal targets for a target spec. */
export function legalTargets(g: Game, spec: TargetSpec, sourceId: ObjectId | null, controller: PlayerId, x?: number): Target[] {
  const out: Target[] = [];
  const ctx: FilterContext = { sourceId, controller, x };
  const addPlayers = (pf: TargetSpec['playerFilter']) => {
    for (const p of Object.values(g.state.players)) {
      if (p.lost) continue;
      if (pf === 'opponent' && p.id === controller) continue;
      if (pf === 'you' && p.id !== controller) continue;
      if (pf === 'notController' && p.id === controller) continue;
      const t: Target = { kind: 'player', id: p.id };
      if (canTarget(g, t, sourceId, controller)) out.push(t);
    }
  };
  switch (spec.kind) {
    case 'player':
      addPlayers(spec.playerFilter ?? 'any');
      break;
    case 'any': {
      addPlayers('any');
      for (const obj of Object.values(g.state.objects)) {
        if (obj.zone !== 'battlefield') continue;
        const ch = g.characteristics(obj.id);
        if (ch.types.includes('Creature') || ch.types.includes('Planeswalker') || ch.types.includes('Battle')) {
          if (matchesFilter(g, obj, spec.filter, ctx)) {
            const t: Target = { kind: 'object', id: obj.id };
            if (canTarget(g, t, sourceId, controller)) out.push(t);
          }
        }
      }
      break;
    }
    case 'objectOrPlayer':
      addPlayers(spec.playerFilter ?? 'any');
    // fallthrough
    case 'object': {
      const zones = spec.filter?.zone ? (Array.isArray(spec.filter.zone) ? spec.filter.zone : [spec.filter.zone]) : ['battlefield'];
      for (const obj of Object.values(g.state.objects)) {
        if (!zones.includes(obj.zone)) continue;
        if (obj.id === sourceId && obj.zone === 'stack') continue; // a spell can't target itself
        if (!matchesFilter(g, obj, spec.filter, ctx)) continue;
        const t: Target = { kind: 'object', id: obj.id };
        if (canTarget(g, t, sourceId, controller)) out.push(t);
      }
      break;
    }
    case 'spell': {
      for (const item of g.state.stack) {
        if (item.kind !== 'spell') continue;
        if (item.sourceId === sourceId) continue;
        const obj = g.state.objects[item.sourceId];
        if (!obj) continue;
        if (spec.filter && !matchesFilter(g, obj, { ...spec.filter, zone: 'stack' }, ctx)) continue;
        if (spec.filter?.controller === 'opponent' && item.controller === controller) continue;
        out.push({ kind: 'stackItem', id: item.id });
      }
      break;
    }
    case 'spellOrAbility': {
      for (const item of g.state.stack) {
        if (item.kind === 'spell') {
          const obj = g.state.objects[item.sourceId];
          if (!obj || item.sourceId === sourceId) continue;
          if (spec.filter && !matchesFilter(g, obj, { ...spec.filter, zone: 'stack' }, ctx)) continue;
        }
        out.push({ kind: 'stackItem', id: item.id });
      }
      break;
    }
    case 'objectOrSpell': {
      for (const o of objectsMatching(g, { ...spec.filter, zone: spec.filter?.zone ?? 'battlefield' }, ctx)) out.push({ kind: 'object', id: o.id });
      for (const item of g.state.stack) {
        if (item.kind !== 'spell' || item.sourceId === sourceId) continue;
        out.push({ kind: 'stackItem', id: item.id });
      }
      break;
    }
    case 'activatedOrTriggered': {
      for (const item of g.state.stack) {
        if (item.kind === 'spell') continue;
        if (spec.playerFilter === 'you' && item.controller !== controller) continue;
        if ((spec.playerFilter === 'opponent' || spec.playerFilter === 'notController') && item.controller === controller) continue;
        if (spec.filter) {
          const src = g.state.objects[item.sourceId];
          if (!src || !matchesFilter(g, src, { ...spec.filter, zone: undefined }, ctx)) continue;
        }
        out.push({ kind: 'stackItem', id: item.id });
      }
      break;
    }
  }
  return out;
}

export function sameTarget(a: Target, b: Target): boolean {
  return a.kind === b.kind && (a as { id?: unknown }).id === (b as { id?: unknown }).id;
}
