/**
 * Casting spells, activating abilities, playing lands, and paying costs.
 */
import type { Game, Gen } from './game.js';
import type { GameObject, ObjectId, PlayerId, PriorityDecision, Response, StackItem, Target, ZoneName, ManaColor, ManaPool } from './types.js';
import { emptyPool } from './types.js';
import type { ActivatedAbilitySpec, AbilityCost, CardScript, TargetSpec, Effect } from './script.js';
import { type ManaCost, type ManaSourceOption, parseManaCost, solvePayment, adjustGeneric, maxX, expandRequirements, parseAddManaText, formatCost, adjustSymbols } from './mana.js';
import { BASIC_LAND_TYPES } from './typeline.js';
import { matchesFilter, objectsMatching } from './filters.js';
import { executeEffects, enterBattlefield, auraTargetSpec, type EffectContext } from './effects.js';

// ---------------------------------------------------------------------------
// Abilities of an object (scripted + synthesized from card data)
// ---------------------------------------------------------------------------

export interface ObjectAbility {
  index: number;
  spec: ActivatedAbilitySpec;
  /** Synthesized (not from script) e.g. basic land mana ability. */
  synthetic?: boolean;
}

export function abilitiesOf(g: Game, obj: GameObject): ObjectAbility[] {
  const out: ObjectAbility[] = [];
  const script = g.scriptFor(obj);
  const ch = g.characteristics(obj.id);
  if (obj.faceDown) {
    // A face-down permanent has no printed abilities — only its morph / disguise turn-up ability.
    script.abilities.forEach((ab, i) => {
      if (ab.kind === 'activated' && ab.faceDownOnly) out.push({ index: i, spec: ab });
    });
    return out;
  }
  if (ch.lostAllAbilities) {
    // Still gets basic-land mana abilities from land types (intrinsic to the type)
  } else {
    script.abilities.forEach((ab, i) => {
      if (ab.kind === 'activated' && !ab.faceDownOnly) out.push({ index: i, spec: ab });
    });
  }
  let idx = 1000;
  // Intrinsic mana abilities from basic land types.
  for (const [type, color] of Object.entries(BASIC_LAND_TYPES)) {
    if (ch.subtypes.includes(type) && ch.types.includes('Land')) {
      out.push({ index: idx++, synthetic: true, spec: { kind: 'activated', text: `{T}: Add {${color}}.`, cost: { tap: true }, effects: [{ kind: 'addMana', mana: [color] }], manaAbility: true } });
    }
  }
  // Unscripted mana abilities parsed from oracle text.
  if (script.origin !== 'hand' && !ch.lostAllAbilities && !script.abilities.some((a) => a.kind === 'activated' && a.manaAbility)) {
    for (const line of ch.oracleText.split('\n')) {
      const m = line.match(/^\{T\}: Add (.+?)\.?$/);
      if (!m) continue;
      const alts = parseAddManaText(line);
      if (!alts.length) continue;
      if (alts.length === 1) out.push({ index: idx++, synthetic: true, spec: { kind: 'activated', text: line, cost: { tap: true }, effects: [{ kind: 'addMana', mana: alts[0] }], manaAbility: true } });
      else if (/any color/i.test(line)) out.push({ index: idx++, synthetic: true, spec: { kind: 'activated', text: line, cost: { tap: true }, effects: [{ kind: 'addMana', mana: 'anyColor' }], manaAbility: true } });
      else for (const alt of alts) out.push({ index: idx++, synthetic: true, spec: { kind: 'activated', text: `{T}: Add ${alt.map((c) => `{${c}}`).join('')}.`, cost: { tap: true }, effects: [{ kind: 'addMana', mana: alt }], manaAbility: true } });
    }
  }
  // Equip
  if (ch.subtypes.includes('Equipment') && !ch.lostAllAbilities && !script.abilities.some((a) => a.kind === 'activated' && /^Equip/.test(a.text))) {
    const m = ch.oracleText.match(/Equip (\{[^\n]+?\}+|\d+)/);
    if (m) {
      const cost = /^\d+$/.test(m[1]) ? `{${m[1]}}` : m[1];
      out.push({ index: idx++, synthetic: true, spec: { kind: 'activated', text: `Equip ${cost}`, cost: { mana: cost }, sorcerySpeed: true, targets: [{ description: 'target creature you control', kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], controller: 'you' } }], effects: [{ kind: 'attach', what: { ref: 'self' }, to: { ref: 'target' } }] } });
    }
  }
  return out;
}

export function findAbility(g: Game, obj: GameObject, index: number): ObjectAbility | undefined {
  return abilitiesOf(g, obj).find((a) => a.index === index);
}

// ---------------------------------------------------------------------------
// Mana sources and payment
// ---------------------------------------------------------------------------

function isSummoningSick(g: Game, obj: GameObject): boolean {
  const ch = g.characteristics(obj.id);
  if (!ch.types.includes('Creature')) return false;
  if (ch.keywords.has('Haste')) return false;
  return obj.controlSinceTurn === g.state.turn.number && (obj.enteredThisTurn || obj.controlSinceTurn === g.state.turn.number) && !(obj.controlSinceTurn < g.state.turn.number);
}

export function summoningSick(g: Game, obj: GameObject): boolean {
  const ch = g.characteristics(obj.id);
  if (!ch.types.includes('Creature')) return false;
  if (ch.keywords.has('Haste') || ch.rules.some((r) => r.kind === 'hasteLike')) return false;
  // "You may activate abilities of creatures you control as though those creatures had haste."
  for (const r of g.playerRules(obj.controller)) {
    if (r.kind !== 'custom' || r.tag !== 'activateAsThoughHaste') continue;
    const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter;
    if (!f || matchesFilter(g, obj, { ...f, zone: 'battlefield' }, { sourceId: null, controller: obj.controller })) return false;
  }
  // A creature is sick unless controlled continuously since the start of its controller's most recent turn (CR 302.6).
  return obj.controlSinceTurn >= (g.player(obj.controller).lastTurnStarted ?? 0);
}

function canUseTapAbility(g: Game, obj: GameObject): boolean {
  if (obj.tapped) return false;
  return !summoningSick(g, obj);
}

/** Mana each ability could produce, as alternatives. */
function manaFromAbility(g: Game, obj: GameObject, ab: ActivatedAbilitySpec): ManaColor[][] {
  const alts: ManaColor[][] = [];
  const flat: Effect[] = [];
  for (const e of ab.effects) {
    if (e.kind === 'chooseMode') for (const o of e.options) flat.push(...o.effects);
    else flat.push(e);
  }
  for (const e of flat) {
    if (e.kind !== 'addMana') continue;
    const n = e.amount !== undefined ? g.resolveAmount(e.amount, { sourceId: obj.id, controller: obj.controller, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} }) : 1;
    if (n <= 0) continue;
    if (e.mana === 'anyColor' || e.mana === 'anyOneColor') for (const c of ['W', 'U', 'B', 'R', 'G'] as ManaColor[]) alts.push(new Array(n).fill(c));
    else if (e.mana === 'commanderColors') for (const c of g.colorsOfCommander(obj.controller)) alts.push(new Array(n).fill(c));
    else {
      const arr: ManaColor[] = [];
      for (let i = 0; i < n; i++) arr.push(...(e.mana as ManaColor[]));
      alts.push(arr);
    }
  }
  return alts;
}

export interface CastingKeywords {
  convoke?: boolean;
  improvise?: boolean;
  delve?: boolean;
}

export function castingKeywordsOf(g: Game, obj: GameObject): CastingKeywords {
  const ch = g.characteristics(obj.id);
  const text = obj.card.oracleText ?? '';
  // "Artifact spells you cast have convoke."
  const granted = new Set<string>();
  for (const r of g.playerRules(obj.controller)) {
    if (r.kind !== 'custom' || r.tag !== 'grantSpellKeyword') continue;
    const d = (r.data as { keyword?: string; filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
    if (!d.keyword) continue;
    if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: obj.controller })) continue;
    granted.add(d.keyword.toLowerCase());
  }
  return {
    convoke: granted.has('convoke') || ch.keywords.has('Convoke') || /^Convoke\b/m.test(text),
    improvise: granted.has('improvise') || ch.keywords.has('Improvise') || /^Improvise\b/m.test(text),
    delve: granted.has('delve') || ch.keywords.has('Delve') || /^Delve\b/m.test(text),
  };
}

export function manaSourcesFor(g: Game, p: PlayerId, extra: CastingKeywords = {}): ManaSourceOption[] {
  const out: ManaSourceOption[] = [];
  const virtual = (): void => {
    const used = new Set(out.map((s) => s.id));
    if (extra.convoke) {
      for (const id of g.state.battlefield) {
        const o = g.obj(id);
        if (o.controller !== p || o.tapped || used.has(id)) continue;
        const ch = g.characteristics(id);
        if (!ch.types.includes('Creature')) continue;
        const alts: ManaColor[][] = ch.colors.map((c) => [c]);
        alts.push(['C']);
        out.push({ id, alternatives: alts, priority: 50, kind: 'convoke' });
      }
    }
    if (extra.improvise) {
      for (const id of g.state.battlefield) {
        const o = g.obj(id);
        if (o.controller !== p || o.tapped || used.has(id)) continue;
        if (!g.characteristics(id).types.includes('Artifact')) continue;
        out.push({ id, alternatives: [['C']], priority: 60, kind: 'improvise', genericOnly: true });
      }
    }
    if (extra.delve) {
      for (const id of g.player(p).graveyard) out.push({ id, alternatives: [['C']], priority: 70, kind: 'delve', genericOnly: true });
    }
  };
  for (const id of g.state.battlefield) {
    const obj = g.obj(id);
    if (obj.controller !== p || obj.phasedOut) continue;
    const alts: ManaColor[][] = [];
    let sacs = false;
    for (const ab of abilitiesOf(g, obj)) {
      if (!ab.spec.manaAbility) continue;
      if (ab.spec.cost.tap && !canUseTapAbility(g, obj)) continue;
      if (ab.spec.cost.mana || ab.spec.cost.sacrifice || ab.spec.cost.payLife || ab.spec.cost.discard || ab.spec.cost.removeCounters) continue; // don't auto-pay with costly sources
      if (ab.spec.cost.sacrificeSelf) sacs = true; // Treasure, Lotus Petal: usable, but last
      if (ab.spec.condition && !g.checkCondition(ab.spec.condition, { sourceId: obj.id, controller: p })) continue;
      alts.push(...manaFromAbility(g, obj, ab.spec));
    }
    if (!alts.length) continue;
    // Deduplicate alternatives
    const uniq = new Map<string, ManaColor[]>();
    for (const a of alts) uniq.set(a.join(''), a);
    const ch = g.characteristics(id);
    const priority = sacs ? 40 : ch.supertypes.includes('Basic') ? 0 : ch.types.includes('Land') ? 1 + uniq.size : ch.types.includes('Creature') ? 10 : 5 + uniq.size;
    out.push({ id, alternatives: [...uniq.values()], priority, kind: 'mana' });
  }
  virtual();
  return out;
}

/** Tap a source for mana producing a specific alternative. Runs the ability's side effects. */
export function* tapForMana(g: Game, sourceId: ObjectId, produce: ManaColor[]): Gen {
  const obj = g.state.objects[sourceId];
  if (!obj) return;
  const ab = abilitiesOf(g, obj).find((a) => a.spec.manaAbility && manaFromAbility(g, obj, a.spec).some((alt) => alt.join('') === produce.join('')));
  if (!ab || ab.spec.cost.tap) g.tap(sourceId);
  const controller = obj.controller;
  const pool = g.player(controller).manaPool;
  for (const c of produce) pool[c]++;
  g.touch();
  if (ab) {
    if (ab.spec.cost.sacrificeSelf) g.moveObject(sourceId, 'graveyard', { cause: 'sacrifice', sourceId });
    // Side effects other than adding mana (e.g. painland damage).
    const extra = ab.spec.effects.filter((e) => e.kind !== 'addMana' && e.kind !== 'chooseMode');
    if (extra.length) yield* executeEffects(g, extra, { sourceId, controller, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} });
  }
  // "Whenever enchanted land is tapped for mana, its controller adds an additional {G}": mana triggers resolve at once (rule 605.1b).
  const event: import('./types.js').GameEvent = { name: 'tappedForMana', objectId: sourceId, playerId: controller, data: { mana: produce } };
  for (const id of [...g.state.battlefield]) {
    const src = g.state.objects[id];
    if (!src) continue;
    for (const ab of g.scriptFor(src).abilities) {
      if (ab.kind !== 'triggered' || ab.event !== 'tappedForMana' || !ab.effects.every((e) => e.kind === 'addMana')) continue;
      if (!g.triggerMatches(ab.filter, event, src, src.controller)) continue;
      yield* executeEffects(g, ab.effects, { sourceId: id, controller: src.controller, targets: [], triggerContext: g.triggerContextFrom(event), x: 0, modes: [], memory: {} });
    }
  }
  g.emit(event);
  g.emit({ name: 'abilityActivated', objectId: sourceId, playerId: obj.controller, data: { mana: true } });
}

/** Deduct a fully-payable cost from the pool. Assumes feasibility. */
function deductFromPool(pool: ManaPool, cost: ManaCost, x: number): boolean {
  const reqs = expandRequirements(cost, x);
  // singles → hybrids → generic
  const order = [...reqs].sort((a, b) => rank(a) - rank(b));
  function rank(r: { options: ManaColor[] | 'any' }) {
    if (r.options === 'any') return 2;
    return r.options.length === 1 ? 0 : 1;
  }
  const snapshot = { ...pool };
  for (const r of order) {
    if (r.options === 'any') {
      const c = (['C', 'W', 'U', 'B', 'R', 'G'] as ManaColor[]).find((k) => pool[k] > 0);
      if (!c) {
        Object.assign(pool, snapshot);
        return false;
      }
      pool[c]--;
    } else {
      const c = r.options.find((k) => pool[k] > 0);
      if (!c) {
        Object.assign(pool, snapshot);
        return false;
      }
      pool[c]--;
    }
  }
  return true;
}

/**
 * Pay a mana cost: auto-tap sources (Arena-style) then deduct from pool.
 * Returns false (with no changes) if the cost can't be paid.
 */
export function* payCost(g: Game, p: PlayerId, cost: ManaCost, x: number, sourceId: ObjectId | null, keywords: CastingKeywords = {}, manual = false): Gen<boolean> {
  const player = g.player(p);
  // Prefer paying with real mana; only reach for convoke/improvise/delve when needed.
  let sources = manaSourcesFor(g, p);
  let solution = solvePayment(cost, x, player.manaPool, sources);
  if (!solution && (keywords.convoke || keywords.improvise || keywords.delve)) {
    sources = manaSourcesFor(g, p, keywords);
    solution = solvePayment(cost, x, player.manaPool, sources);
  }
  // Phyrexian mana: offer 2 life per symbol that mana can't cover.
  if (!solution && cost.symbols.some((sy) => sy.kind === 'phyrexian')) {
    const phy = cost.symbols.filter((sy) => sy.kind === 'phyrexian').length;
    for (let k = 1; k <= phy; k++) {
      let dropped = 0;
      const reduced: ManaCost = { symbols: cost.symbols.filter((sy) => (sy.kind === 'phyrexian' && dropped < k ? (dropped++, false) : true)), xCount: cost.xCount };
      const sol = solvePayment(reduced, x, player.manaPool, sources);
      if (sol && player.life >= 2 * k) {
        const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Pay ${2 * k} life for ${k} Phyrexian mana symbol${k === 1 ? '' : 's'}?`, sourceId: sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return false;
        g.loseLife(p, 2 * k, sourceId ?? undefined);
        cost = reduced;
        solution = sol;
        break;
      }
    }
  }
  if (!solution) return false;
  if (manual) {
    // Let the player pick exactly which sources to use.
    const suggestion = { tap: solution.tap, fromPool: solution.fromPool };
    for (;;) {
      const r = yield* g.ask({ type: 'payMana', player: p, prompt: `Pay ${formatCost(cost, x)}: choose sources to tap`, cost: formatCost(cost, x), suggestion, sources: sources.map((so) => ({ id: so.id, produces: so.alternatives })), sourceId: sourceId ?? undefined });
      if (r.type === 'cancel') return false;
      if (r.type !== 'payMana') return false;
      if (r.auto) break;
      const chosen = sources.filter((so) => r.tap.includes(so.id));
      const sol = solvePayment(cost, x, player.manaPool, chosen);
      if (sol && sol.tap.length === chosen.length) {
        solution = sol;
        break;
      }
      g.log('Those sources cannot pay this cost exactly; choose again or use the suggestion.');
    }
  }
  const delveCount = solution.tap.filter((id) => sources.find((s) => s.id === id)?.kind === 'delve').length;
  if (delveCount > 0) {
    const gy = [...player.graveyard];
    const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Delve: exile ${delveCount} card${delveCount === 1 ? '' : 's'} from your graveyard`, candidates: gy, min: delveCount, max: delveCount, revealToChooser: true, sourceId: sourceId ?? undefined });
    if (resp.type !== 'objects') return false;
    for (const id of resp.ids) g.moveObject(id, 'exile', { cause: 'exile', sourceId: sourceId ?? undefined });
    for (let i = 0; i < delveCount; i++) player.manaPool.C++;
  }
  for (let i = 0; i < solution.tap.length; i++) {
    const src = sources.find((s) => s.id === solution.tap[i])!;
    if (src.kind === 'delve') continue;
    if (src.kind === 'convoke' || src.kind === 'improvise') {
      g.tap(src.id);
      if (src.kind === 'convoke' && sourceId !== null && sourceId !== undefined) {
        const so = g.state.objects[sourceId];
        if (so) so.memory['convokedBy'] = [...((so.memory['convokedBy'] as number[] | undefined) ?? []), src.id];
      }
      for (const c of src.alternatives[solution.alternatives[i]]) player.manaPool[c]++;
      g.log(`${player.name} taps ${g.nameOf(src.id)} to help pay (${src.kind}).`);
      continue;
    }
    yield* tapForMana(g, src.id, src.alternatives[solution.alternatives[i]]);
  }
  const poolBefore = { ...player.manaPool };
  if (!deductFromPool(player.manaPool, cost, x)) {
    // Should not happen; leave mana in pool for the player to use.
    g.log('Payment mismatch after tapping; mana left in pool.');
    return false;
  }
  if (sourceId !== null && g.state.objects[sourceId]) {
    const used: Record<string, number> = {};
    for (const k of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
      const d = (poolBefore[k] ?? 0) - (player.manaPool[k] ?? 0);
      if (d > 0) used[k] = d;
    }
    g.state.objects[sourceId].memory['manaSpentPool'] = used;
  }
  g.touch();
  // Expend: track total mana spent this turn and fire "expend N" thresholds.
  {
    const spent = cost.symbols.reduce((acc, sym) => acc + (sym.kind === 'generic' ? sym.amount : sym.kind === 'x' ? 0 : 1), 0) + x * cost.xCount;
    if (spent > 0) {
      const pl = g.player(p);
      const before = pl.turnStats['manaSpent'] ?? 0;
      pl.turnStats['manaSpent'] = before + spent;
      for (const n of [4, 8]) if (before < n && before + spent >= n) g.emit({ name: 'expend', playerId: p, data: { n } });
    }
  }
  return true;
}

/** Non-mana costs: tap, sacrifice, discard, life, counters... Returns false if unpayable. */
/** Remove up to `n` generic mana from a parsed cost (ability cost reductions). */
function reduceGeneric(cost: ManaCost, n: number): ManaCost {
  let left = n;
  const symbols = cost.symbols.map((sy) => {
    if (left <= 0 || sy.kind !== 'generic') return sy;
    const take = Math.min(left, sy.amount);
    left -= take;
    return { ...sy, amount: sy.amount - take };
  }).filter((sy) => sy.kind !== 'generic' || sy.amount > 0);
  return { ...cost, symbols };
}

/** Objects a cost just sacrificed or exiled, for "the sacrificed creature's power" style references. */
export function costMemory(obj: GameObject | undefined): Record<string, unknown> {
  if (!obj) return {};
  const moved = [...((obj.memory['sacrificedAsCost'] as ObjectId[] | undefined) ?? []), ...((obj.memory['exiledAsCost'] as ObjectId[] | undefined) ?? [])];
  return moved.length ? { lastMoved: moved } : {};
}

export function* payAbilityCost(g: Game, p: PlayerId, obj: GameObject, cost: AbilityCost, x: number, abilityText?: string): Gen<boolean> {
  const ctx = { sourceId: obj.id, controller: p, x };
  delete obj.memory['sacrificedAsCost'];
  delete obj.memory['exiledAsCost'];
  if (cost.optional) {
    const { optional: _o, ...rest } = cost;
    void _o;
    const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `${obj.card.name}: pay the optional additional cost?`, sourceId: obj.id });
    if (!(r.type === 'yesNo' && r.value)) {
      obj.memory['additionalCostPaid'] = false;
      return true;
    }
    const paid = yield* payAbilityCost(g, p, obj, rest, x, abilityText);
    obj.memory['additionalCostPaid'] = paid;
    return paid;
  }
  if (cost.choice) {
    // "Sacrifice a creature or pay {3}": pick one option, then pay it.
    const label = (c: AbilityCost): string => c.mana ?? (c.sacrifice ? 'Sacrifice' : c.discard ? 'Discard' : c.payLife ? `Pay ${c.payLife} life` : c.returnToHand ? 'Return a permanent to hand' : c.exileFromGraveyard ? 'Exile from graveyard' : c.tapUntapped ? 'Tap creatures' : 'Other');
    const resp = yield* g.ask({ type: 'chooseOption', player: p, prompt: 'Choose which cost to pay', options: cost.choice.map((c, i) => ({ id: String(i), label: label(c) })), min: 1, max: 1, sourceId: obj.id });
    if (resp.type !== 'options' || !resp.ids.length) return false;
    return yield* payAbilityCost(g, p, obj, cost.choice[parseInt(resp.ids[0], 10)], x, abilityText);
  }
  // Check first
  if (cost.tap && (obj.tapped || (g.characteristics(obj.id).types.includes('Creature') && summoningSick(g, obj)))) return false;
  if (cost.untap && !obj.tapped) return false;
  const nx = (v: number | 'X' | 'all' | 'halfUp' | 'halfDown' | undefined): number =>
    v === 'X' ? x : v === 'all' ? (cost.removeCounters ? obj.counters[cost.removeCounters.counter] ?? 0 : 0) : v === 'halfUp' ? Math.ceil(g.player(p).life / 2) : v === 'halfDown' ? Math.floor(g.player(p).life / 2) : (v ?? 0);
  const cnt = (v: number | 'X' | 'any' | 'all' | 'halfUp' | 'halfDown' | undefined, avail: number, dflt = 1): number =>
    v === 'X' ? x : v === 'any' || v === 'all' ? avail : v === 'halfUp' ? Math.ceil(avail / 2) : v === 'halfDown' ? Math.floor(avail / 2) : (v ?? dflt);
  if (cost.payLife !== undefined && g.player(p).life < nx(cost.payLife)) return false;
  if (cost.energy !== undefined && g.player(p).energy < (cost.energy === 'X' ? x : cost.energy)) return false;
  if (cost.removeCounters && cost.removeCounters.counter === 'any' && Object.values(obj.counters).reduce((s, v) => s + (v ?? 0), 0) < nx(cost.removeCounters.amount)) return false;
  if (cost.removeCounters && cost.removeCounters.counter !== 'any' && (obj.counters[cost.removeCounters.counter] ?? 0) < nx(cost.removeCounters.amount)) return false;
  if (cost.loyalty !== undefined && cost.loyalty < 0 && (obj.counters['loyalty'] ?? 0) < -cost.loyalty) return false;
  if (cost.sacrifice) {
    const cands = objectsMatching(g, { ...cost.sacrifice.filter, controller: 'you' }, ctx);
    if (cost.sacrifice.count !== 'any' && cands.length < cnt(cost.sacrifice.count, cands.length)) return false;
  }
  if (cost.sacrificeEach) {
    for (const f of cost.sacrificeEach) if (!objectsMatching(g, { ...f, controller: 'you' }, ctx).length) return false;
  }
  if (cost.discard) {
    const hand = g.player(p).hand;
    if (cost.discard === 'hand') {
      /* ok */
    } else if (hand.filter((id) => !cost.discard || cost.discard === 'hand' || matchesFilter(g, g.obj(id), { ...cost.discard.filter, zone: 'hand' }, ctx)).length < nx(cost.discard.count)) return false;
  }
  if (cost.exileObjects) {
    const cands = objectsMatching(g, cost.exileObjects.filter, ctx).map((o) => o.id);
    const en = cost.exileObjects.count === 'any' ? cands.length : cnt(cost.exileObjects.count, cands.length);
    let ids = cands.slice(0, en);
    if (cands.length > 1 || cost.exileObjects.count === 'any') {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: cost.exileObjects.count === 'any' ? 'Exile any number as a cost' : `Exile ${en} as a cost`, candidates: cands, min: cost.exileObjects.count === 'any' ? 0 : en, max: en, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    obj.memory['exiledAsCost'] = ids;
    for (const id of ids) g.moveObject(id, 'exile', { cause: 'exile', sourceId: obj.id });
  }
  if (cost.putCounters) {
    const cands = objectsMatching(g, cost.putCounters.filter, ctx).map((o) => o.id);
    if (!cands.length) return false;
    let pick = cands[0];
    if (cands.length > 1) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Put ${cost.putCounters.amount} ${cost.putCounters.counter} counter(s) as a cost`, candidates: cands, min: 1, max: 1, sourceId: obj.id });
      if (resp.type !== 'objects' || !resp.ids.length) return false;
      pick = resp.ids[0];
    }
    g.addCounters(pick, cost.putCounters.counter, cost.putCounters.amount);
  }
  if (cost.tapUntappedTotalPower) {
    const cands = objectsMatching(g, { ...cost.tapUntappedTotalPower.filter, controller: 'you', untapped: true }, ctx);
    if (cands.reduce((s, o) => s + (g.characteristics(o.id).power ?? 0), 0) < cost.tapUntappedTotalPower.power) return false;
  }
  if (cost.collectEvidence && !cost.collectEvidence.optional) {
    const total = g.player(p).graveyard.reduce((s, id) => s + g.characteristics(id).manaValue, 0);
    if (total < cost.collectEvidence.n) return false;
  }
  if (cost.behold) {
    const inHand = g.player(p).hand.some((id) => matchesFilter(g, g.obj(id), { ...cost.behold, zone: 'hand' }, ctx));
    const onField = objectsMatching(g, { ...cost.behold, controller: 'you', zone: 'battlefield' }, ctx).length > 0;
    if (!inHand && !onField) return false;
  }
  if (cost.revealFromHand && !g.player(p).hand.some((id) => matchesFilter(g, g.obj(id), { ...cost.revealFromHand, zone: 'hand' }, ctx))) return false;
  if (cost.processFromExile && !objectsMatching(g, { ...cost.processFromExile, zone: 'exile', owner: 'opponent' }, ctx).length) return false;
  if (cost.blight !== undefined && !cost.blightOptional && !objectsMatching(g, { types: ['Creature'], controller: 'you', zone: 'battlefield' }, ctx).length) return false;
  if (cost.collectEvidence) {
    const cands = [...g.player(p).graveyard];
    const need = cost.collectEvidence.n;
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Collect evidence ${need}: exile cards with total mana value ${need} or more from your graveyard${cost.collectEvidence.optional ? ' (or choose none)' : ''}`, candidates: cands, min: 0, max: cands.length, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      if (!resp.ids.length) {
        if (cost.collectEvidence.optional) break;
        continue;
      }
      const total = resp.ids.reduce((s, id) => s + g.characteristics(id).manaValue, 0);
      if (total < need) continue;
      for (const id of resp.ids) g.moveObject(id, 'exile', { cause: 'exile' });
      obj.memory['evidenceCollected'] = true;
      obj.memory['additionalCostPaid'] = true;
      break;
    }
  }
  if (cost.behold) {
    const hand = g.player(p).hand.filter((id) => matchesFilter(g, g.obj(id), { ...cost.behold, zone: 'hand' }, ctx));
    const field = objectsMatching(g, { ...cost.behold, controller: 'you', zone: 'battlefield' }, ctx).map((o) => o.id);
    const cands = [...hand, ...field];
    if (cands.length) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Behold: reveal a card from your hand or choose a creature you control', candidates: cands, min: 1, max: 1, revealToChooser: true, sourceId: obj.id });
      if (resp.type !== 'objects' || !resp.ids.length) return false;
      obj.memory['beheld'] = resp.ids[0];
      g.log(`${g.player(p).name} beholds ${g.nameOf(resp.ids[0])}.`);
      if (cost.beholdExile) {
        const moved = g.moveObject(resp.ids[0], 'exile', { cause: 'exile', sourceId: obj.id });
        if (moved) obj.memory['exiled'] = [moved.id];
      }
    }
  }
  if (cost.processFromExile) {
    const cands = objectsMatching(g, { ...cost.processFromExile, zone: 'exile', owner: 'opponent' }, ctx).map((o) => o.id);
    if (!cands.length) return false;
    const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: "Put a card an opponent owns from exile into that player's graveyard", candidates: cands, min: 1, max: 1, sourceId: obj.id });
    if (resp.type !== 'objects' || !resp.ids.length) return false;
    g.moveObject(resp.ids[0], 'graveyard');
    obj.memory['processed'] = resp.ids[0];
  }
  if (cost.revealFromHandX) {
    const cands = g.player(p).hand.filter((id) => matchesFilter(g, g.obj(id), { ...cost.revealFromHandX, zone: 'hand' }, ctx));
    if (cands.length < x) return false;
    if (x > 0) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Reveal ${x} card${x === 1 ? '' : 's'} from your hand`, candidates: cands, min: x, max: x, revealToChooser: true, sourceId: obj.id });
      if (resp.type !== 'objects' || resp.ids.length !== x) return false;
      g.log(`${g.player(p).name} reveals ${resp.ids.map((i) => g.nameOf(i)).join(', ')}.`);
    }
  }
  if (cost.revealHand) {
    const hand = g.player(p).hand;
    g.log(hand.length ? `${g.player(p).name} reveals their hand: ${hand.map((i) => g.nameOf(i)).join(', ')}.` : `${g.player(p).name} reveals an empty hand.`);
  }
  if (cost.revealFromHand) {
    const cands = g.player(p).hand.filter((id) => matchesFilter(g, g.obj(id), { ...cost.revealFromHand, zone: 'hand' }, ctx));
    const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Reveal a card from your hand', candidates: cands, min: 1, max: 1, revealToChooser: true, sourceId: obj.id });
    if (resp.type !== 'objects' || !resp.ids.length) return false;
    obj.memory['revealed'] = resp.ids[0];
    g.log(`${g.player(p).name} reveals ${g.nameOf(resp.ids[0])}.`);
  }
  if (cost.blight !== undefined) {
    const cands = objectsMatching(g, { types: ['Creature'], controller: 'you', zone: 'battlefield' }, ctx).map((o) => o.id);
    if (cands.length) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Blight ${cost.blight}: put ${cost.blight} -1/-1 counter${cost.blight === 1 ? '' : 's'} on a creature you control${cost.blightOptional ? ' (or choose none)' : ''}`, candidates: cands, min: cost.blightOptional ? 0 : 1, max: 1, sourceId: obj.id });
      if (resp.type !== 'objects' || (!resp.ids.length && !cost.blightOptional)) return false;
      if (resp.ids.length) {
        g.addCounters(resp.ids[0], '-1/-1', cost.blight, obj.id);
        obj.memory['additionalCostPaid'] = true;
      }
    }
  }
  if (cost.chooseCreatureType) {
    const resp = yield* g.ask({ type: 'chooseOption', player: p, prompt: 'Choose a creature type', options: g.creatureTypeOptions().map((t) => ({ id: t, label: t })), min: 1, max: 1, sourceId: obj.id });
    if (resp.type !== 'options' || !resp.ids.length) return false;
    obj.memory['creatureType'] = resp.ids[0];
  }
  if (cost.waterbend !== undefined) {
    // Choose helpers to tap (each pays {1}), then pay the rest with mana.
    const cands = objectsMatching(g, { types: ['Artifact', 'Creature'], controller: 'you', untapped: true, zone: 'battlefield' }, ctx).map((o) => o.id);
    let helpers: ObjectId[] = [];
    if (cands.length) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Waterbend {${cost.waterbend === 'X' ? x : cost.waterbend}}: tap artifacts and creatures to pay {1} each (choose none to pay with mana)`, candidates: cands, min: 0, max: Math.min(cands.length, cost.waterbend === 'X' ? x : cost.waterbend), sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      helpers = resp.ids;
    }
    const rest = (cost.waterbend === 'X' ? x : cost.waterbend) - helpers.length;
    if (rest > 0) {
      const paid = yield* payCost(g, p, parseManaCost(`{${rest}}`), 0, obj.id);
      if (!paid) return false;
    }
    for (const id of helpers) g.tap(id);
  }
  if (cost.exileFromGraveyard) {
    const cands = g.player(p).graveyard.filter((id) => matchesFilter(g, g.obj(id), { ...cost.exileFromGraveyard!.filter, zone: 'graveyard' }, ctx));
    if (cands.length < cnt(cost.exileFromGraveyard.count, cands.length)) return false;
  }
  if (cost.exileObjects) {
    const cands = objectsMatching(g, cost.exileObjects.filter, ctx);
    if (cost.exileObjects.count !== 'any' && cands.length < cnt(cost.exileObjects.count, cands.length)) return false;
  }
  if (cost.putCounters && objectsMatching(g, cost.putCounters.filter, ctx).length === 0) return false;
  if (cost.tapUntapped) {
    const cands = objectsMatching(g, { ...cost.tapUntapped.filter, controller: 'you', untapped: true }, ctx);
    if (cost.tapUntapped.count !== 'any' && cands.length < cnt(cost.tapUntapped.count, cands.length)) return false;
  }
  if (cost.returnToHand) {
    const cands = objectsMatching(g, { ...cost.returnToHand.filter, controller: 'you' }, ctx);
    if (cands.length < cost.returnToHand.count) return false;
  }
  if (cost.untapOther) {
    const cands = objectsMatching(g, { ...cost.untapOther.filter, tapped: true }, ctx);
    if (cands.length < cost.untapOther.count) return false;
  }
  if ((cost.tapAttached || cost.sacrificeAttached) && obj.attachedTo === null) return false;
  if (cost.mill !== undefined && g.player(p).library.length < cost.mill) return false;
  if (cost.exileTop) {
    const pile = cost.exileTop.from === 'library' ? g.player(p).library : g.player(p).graveyard;
    if (cost.exileTop.filter) {
      if (!pile.some((id) => matchesFilter(g, g.obj(id), { ...cost.exileTop!.filter, zone: cost.exileTop!.from }, ctx))) return false;
    } else if (pile.length < cost.exileTop.count) return false;
  }
  if (cost.handToLibrary && g.player(p).hand.length < cost.handToLibrary.count) return false;
  if (cost.removeCountersAcross) {
    const need = cost.removeCountersAcross.amount === 'X' ? x : cost.removeCountersAcross.amount;
    const kind = cost.removeCountersAcross.counter;
    const have = objectsMatching(g, cost.removeCountersAcross.filter, ctx).reduce((a, o) => a + (kind === 'any' ? Object.values(o.counters).reduce((s, v) => s + (v ?? 0), 0) : o.counters[kind] ?? 0), 0);
    if (have < need) return false;
  }
  const amtCtx = { sourceId: obj.id, controller: p, targets: [], triggerContext: {}, x, modes: [], memory: {} };
  if (cost.payLifeAmount !== undefined && g.player(p).life < g.resolveAmount(cost.payLifeAmount, amtCtx)) return false;
  if (cost.unattachSelf && obj.attachedTo === null) return false;
  if (cost.removeCountersFrom) {
    const cands = objectsMatching(g, cost.removeCountersFrom.filter, ctx).filter((o) => (cost.removeCountersFrom!.counter === 'any' ? Object.values(o.counters).reduce((a, b) => a + (b ?? 0), 0) : o.counters[cost.removeCountersFrom!.counter] ?? 0) >= cost.removeCountersFrom!.amount);
    if (!cands.length) return false;
  }
  // "You may pay {0} rather than pay the equip cost of the first equip ability you activate each
  // turn": the first matching activation this turn skips its mana cost entirely.
  let freeThisActivation = false;
  if (cost.mana) {
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || r.tag !== 'freeFirstAbilityEachTurn') continue;
      const d = (r.data as { textPrefix?: string; always?: boolean } | undefined) ?? {};
      if (d.textPrefix && !new RegExp(`^${d.textPrefix}`, 'i').test(abilityText ?? '')) continue;
      const key = `freeAbility:${d.textPrefix ?? '*'}:${p}`;
      if (!d.always) {
        if (g.state.turnStats[key]) continue;
        g.state.turnStats[key] = 1;
      }
      freeThisActivation = true;
      break;
    }
  }
  // Mana (with X), after any "activated abilities of X cost {N} less to activate" reductions.
  if (cost.mana && !freeThisActivation) {
    const parsed = parseManaCost(cost.mana);
    let reduce = 0;
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || r.tag !== 'abilityCostReduction') continue;
      const d = (r.data as { amount?: number; filter?: import('./types.js').ObjectFilter; textPrefix?: string; notMana?: boolean } | undefined) ?? {};
      if (d.notMana && /(?::|^)\s*add \{/i.test(abilityText ?? '')) continue;
      if (d.textPrefix && !new RegExp(`^${d.textPrefix}`, 'i').test(abilityText ?? '')) continue;
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: obj.id, controller: p })) continue;
      reduce += d.amount ?? 0;
    }
    // "Activated abilities cost {2} more to activate." / "This ability costs {1} more for each card in your hand."
    let extra = 0;
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || (r.tag !== 'abilityCostIncrease' && r.tag !== 'thisAbilityCostIncrease')) continue;
      if (r.tag === 'thisAbilityCostIncrease' && (r as { sourceId?: ObjectId }).sourceId !== obj.id) continue;
      const d = (r.data as { amount?: number; filter?: import('./types.js').ObjectFilter; notMana?: boolean } | undefined) ?? {};
      if (d.notMana && /(?::|^)\s*add \{/i.test(abilityText ?? '')) continue;
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: obj.id, controller: p })) continue;
      extra += d.amount ?? 0;
    }
    // "Equipped creature's activated abilities cost {1} less to activate": written on the permanent itself.
    for (const r of g.characteristics(obj.id).rules) {
      if (r.kind !== 'custom' || r.tag !== 'abilityCostChange') continue;
      const d = (r.data as { amount?: number } | undefined) ?? {};
      if ((d.amount ?? 0) >= 0) extra += d.amount ?? 0;
      else reduce += -(d.amount ?? 0);
    }
    let manaCost = reduce > 0 ? reduceGeneric(parsed, reduce) : parsed;
    if (extra > 0) manaCost = { symbols: [...manaCost.symbols, { kind: 'generic', amount: extra }], xCount: manaCost.xCount };
    // "You may spend mana as though it were mana of any color to activate abilities of creatures you control."
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || r.tag !== 'manaAsAnyColorAbilities') continue;
      const d = (r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: obj.id, controller: p })) continue;
      manaCost = { symbols: manaCost.symbols.map((sy) => (sy.kind === 'color' || sy.kind === 'hybrid' || sy.kind === 'phyrexian' ? { kind: 'generic' as const, amount: 1 } : sy.kind === 'monoHybrid' ? { kind: 'generic' as const, amount: 2 } : sy)), xCount: manaCost.xCount };
      break;
    }
    const paid = yield* payCost(g, p, manaCost, x, obj.id);
    if (!paid) return false;
  }
  // Pay the rest
  if (cost.tap) g.tap(obj.id);
  if (cost.untap) g.untap(obj.id);
  if (cost.payLife) g.loseLife(p, nx(cost.payLife));
  if (cost.energy) g.player(p).energy -= cost.energy === 'X' ? x : cost.energy;
  if (cost.removeCounters && cost.removeCounters.counter === 'any') {
    for (let i = 0; i < nx(cost.removeCounters.amount); i++) {
      const kinds = Object.entries(obj.counters).filter(([, v]) => (v ?? 0) > 0).map(([k]) => k);
      if (!kinds.length) break;
      let pick = kinds[0];
      if (kinds.length > 1) {
        const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: 'Remove which counter?', options: kinds.map((k) => ({ id: k, label: `${k} counter` })), min: 1, max: 1, sourceId: obj.id });
        if (r.type === 'options' && r.ids[0]) pick = r.ids[0];
      }
      g.removeCounters(obj.id, pick, 1);
    }
  } else if (cost.removeCounters) g.removeCounters(obj.id, cost.removeCounters.counter, nx(cost.removeCounters.amount));
  if (cost.addCounters) g.addCounters(obj.id, cost.addCounters.counter, cost.addCounters.amount);
  if (cost.loyalty !== undefined) {
    if (cost.loyalty > 0) g.addCounters(obj.id, 'loyalty', cost.loyalty);
    else if (cost.loyalty < 0) g.removeCounters(obj.id, 'loyalty', -cost.loyalty);
  }
  if (cost.sacrifice) {
    const cands = objectsMatching(g, { ...cost.sacrifice.filter, controller: 'you' }, ctx).map((o) => o.id);
    const n = cnt(cost.sacrifice.count, cands.length);
    let ids = cands;
    if (cost.sacrifice.count === 'any' || (cost.sacrifice.count !== 'all' && cands.length > n)) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: cost.sacrifice.count === 'any' ? 'Sacrifice any number' : `Sacrifice ${n}`, candidates: cands, min: cost.sacrifice.count === 'any' ? 0 : n, max: cost.sacrifice.count === 'any' ? cands.length : n, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    obj.memory['sacrificedAsCost'] = ids;
    for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: obj.id });
  }
  if (cost.sacrificeEach) {
    const used: ObjectId[] = [];
    for (const f of cost.sacrificeEach) {
      const cands = objectsMatching(g, { ...f, controller: 'you' }, ctx).map((o) => o.id).filter((id) => !used.includes(id));
      if (!cands.length) return false;
      let pick = cands[0];
      if (cands.length > 1) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Sacrifice a creature for this cost', candidates: cands, min: 1, max: 1, sourceId: obj.id });
        if (resp.type !== 'objects' || !resp.ids.length) return false;
        pick = resp.ids[0];
      }
      used.push(pick);
    }
    for (const id of used) g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: obj.id });
  }
  if (cost.tapAttached && obj.attachedTo !== null) g.tap(obj.attachedTo);
  if (cost.sacrificeAttached && obj.attachedTo !== null) g.moveObject(obj.attachedTo, 'graveyard', { cause: 'sacrifice', sourceId: obj.id });
  if (cost.exert) obj.memory['exerted'] = true;
  if (cost.mill !== undefined) for (const id of g.player(p).library.slice(0, cost.mill)) g.moveObject(id, 'graveyard', { cause: 'mill' });
  if (cost.exileTop) {
    const pile = cost.exileTop.from === 'library' ? g.player(p).library : g.player(p).graveyard;
    const ids = cost.exileTop.filter ? pile.filter((id) => matchesFilter(g, g.obj(id), { ...cost.exileTop!.filter, zone: cost.exileTop!.from }, ctx)).slice(0, cost.exileTop.count) : pile.slice(0, cost.exileTop.count);
    const moved: ObjectId[] = [];
    for (const id of ids) {
      const mv = g.moveObject(id, 'exile', { cause: 'exile', sourceId: obj.id });
      if (mv) moved.push(mv.id);
    }
    obj.memory['exiled'] = [...((obj.memory['exiled'] as ObjectId[]) ?? []), ...moved];
  }
  if (cost.handToLibrary) {
    const cands = [...g.player(p).hand];
    const n = cost.handToLibrary.count;
    let ids = cands.slice(0, n);
    if (cands.length > n) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Put ${n} card${n === 1 ? '' : 's'} from your hand on ${cost.handToLibrary.position} of your library`, candidates: cands, min: n, max: n, revealToChooser: true, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.moveObject(id, 'library', { position: cost.handToLibrary.position });
  }
  if (cost.untapOther) {
    const cands = objectsMatching(g, { ...cost.untapOther.filter, tapped: true }, ctx).map((o) => o.id);
    const n = cost.untapOther.count;
    let ids = cands.slice(0, n);
    if (cands.length > n) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Untap ${n} as a cost`, candidates: cands, min: n, max: n, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.untap(id);
  }
  if (cost.payLifeAmount !== undefined) g.loseLife(p, g.resolveAmount(cost.payLifeAmount, amtCtx));
  if (cost.unattachSelf) {
    if (obj.attachedTo === null) return false;
    const host = g.state.objects[obj.attachedTo];
    if (host) host.attachments = host.attachments.filter((id) => id !== obj.id);
    obj.attachedTo = null;
    g.emit({ name: 'becomesUnattached', objectId: obj.id, playerId: obj.controller });
    g.touch();
  }
  if (cost.removeCountersAcross) {
    const need = cost.removeCountersAcross.amount === 'X' ? x : cost.removeCountersAcross.amount;
    const kind = cost.removeCountersAcross.counter;
    const has = (o: GameObject): number => (kind === 'any' ? Object.values(o.counters).reduce((s, v) => s + (v ?? 0), 0) : o.counters[kind] ?? 0);
    for (let left = need; left > 0; left--) {
      const cands = objectsMatching(g, cost.removeCountersAcross.filter, ctx).filter((o) => has(o) > 0).map((o) => o.id);
      if (!cands.length) return false;
      let pick = cands[0];
      if (cands.length > 1) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Remove a ${kind === 'any' ? '' : `${kind} `}counter as a cost (${left} left)`, candidates: cands, min: 1, max: 1, sourceId: obj.id });
        if (resp.type !== 'objects' || !resp.ids.length) return false;
        pick = resp.ids[0];
      }
      const one = kind === 'any' ? (Object.entries(g.obj(pick).counters).find(([, v]) => (v ?? 0) > 0)?.[0] ?? '') : kind;
      if (!one) return false;
      g.removeCounters(pick, one, 1);
    }
  }
  if (cost.removeCountersFrom) {
    const need = cost.removeCountersFrom.amount;
    const kind = cost.removeCountersFrom.counter;
    const cands = objectsMatching(g, cost.removeCountersFrom.filter, ctx).filter((o) => (kind === 'any' ? Object.values(o.counters).reduce((a, b) => a + (b ?? 0), 0) : o.counters[kind] ?? 0) >= need).map((o) => o.id);
    if (!cands.length) return false;
    let pick = cands[0];
    if (cands.length > 1) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Remove ${need} ${kind === 'any' ? '' : `${kind} `}counter${need === 1 ? '' : 's'} as a cost`, candidates: cands, min: 1, max: 1, sourceId: obj.id });
      if (resp.type !== 'objects' || !resp.ids.length) return false;
      pick = resp.ids[0];
    }
    if (kind === 'any') {
      let left = need;
      for (const [k, v] of Object.entries(g.obj(pick).counters)) {
        if (left <= 0) break;
        const take = Math.min(left, v ?? 0);
        if (take > 0) {
          g.removeCounters(pick, k, take);
          left -= take;
        }
      }
    } else g.removeCounters(pick, kind, need);
  }
  if (cost.sacrificeSelf) g.moveObject(obj.id, 'graveyard', { cause: 'sacrifice', sourceId: obj.id });
  if (cost.exileSelf) g.moveObject(obj.id, 'exile', { cause: 'exile', sourceId: obj.id });
  if (cost.discardSelf) {
    g.moveObject(obj.id, 'graveyard', { cause: 'discard' });
    g.emit({ name: 'discardBatch', playerId: p, amount: 1, objectId: obj.id });
    g.emit({ name: 'cycled', playerId: p, objectId: obj.id }); // cycling (and channel) discards
  }
  if (cost.returnSelf) g.moveObject(obj.id, 'hand', { cause: 'bounce' });
  if (cost.discard) {
    const hand = [...g.player(p).hand];
    if (cost.discard === 'hand') for (const id of hand) g.moveObject(id, 'graveyard', { cause: 'discard' });
    else {
      const cands = hand.filter((id) => !cost.discard || cost.discard === 'hand' || matchesFilter(g, g.obj(id), { ...cost.discard.filter, zone: 'hand' }, ctx));
      const dn = nx(cost.discard.count);
      let ids = cands.slice(0, dn);
      if (cost.discard.random) ids = g.rng.shuffle([...cands]).slice(0, dn);
      else if (cands.length > dn) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Discard ${dn}`, candidates: cands, min: dn, max: dn, revealToChooser: true, sourceId: obj.id });
        if (resp.type !== 'objects') return false;
        ids = resp.ids;
      }
      for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'discard' });
      if (ids.length) g.emit({ name: 'discardBatch', playerId: p, amount: ids.length, objectId: ids[0] });
    }
  }
  if (cost.exileFromGraveyard) {
    const cands = g.player(p).graveyard.filter((id) => matchesFilter(g, g.obj(id), { ...cost.exileFromGraveyard!.filter, zone: 'graveyard' }, ctx));
    let ids = cands;
    const en = cnt(cost.exileFromGraveyard.count, cands.length);
    ids = cands.slice(0, en);
    if (cands.length > en) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Exile ${en} from your graveyard`, candidates: cands, min: en, max: en, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.moveObject(id, 'exile', { cause: 'exile' });
  }
  if (cost.tapUntappedTotalPower) {
    // Crew / saddle: the tapped creatures crewed this permanent.
    const need = cost.tapUntappedTotalPower.power;
    const cands = objectsMatching(g, { ...cost.tapUntappedTotalPower.filter, controller: 'you', untapped: true }, ctx)
      .filter((o) => !g.characteristics(o.id).rules.some((r) => r.kind === 'custom' && r.tag === 'cantCrew'))
      .map((o) => o.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Tap untapped creatures with total power ${need} or more`, candidates: cands, min: 1, max: cands.length, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      const total = resp.ids.reduce((s, id) => s + (g.characteristics(id).power ?? 0), 0);
      if (total < need) continue;
      for (const id of resp.ids) {
        g.tap(id);
        g.emit({ name: 'crewed', objectId: id, sourceId: obj.id, playerId: p });
      }
      break;
    }
  }
  if (cost.tapUntapped) {
    const cands = objectsMatching(g, { ...cost.tapUntapped.filter, controller: 'you', untapped: true }, ctx).map((o) => o.id);
    const tn = cnt(cost.tapUntapped.count, cands.length);
    let ids = cands.slice(0, tn);
    if (cost.tapUntapped.count === 'any' || cands.length > tn) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: cost.tapUntapped.count === 'any' ? 'Tap any number' : `Tap ${tn}`, candidates: cands, min: cost.tapUntapped.count === 'any' ? 0 : tn, max: cost.tapUntapped.count === 'any' ? cands.length : tn, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.tap(id);
    obj.memory['costTapped'] = ids;
  }
  if (cost.returnToHand) {
    const cands = objectsMatching(g, { ...cost.returnToHand.filter, controller: 'you' }, ctx).map((o) => o.id);
    let ids = cands.slice(0, cost.returnToHand.count);
    if (cands.length > cost.returnToHand.count) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Return ${cost.returnToHand.count} to hand`, candidates: cands, min: cost.returnToHand.count, max: cost.returnToHand.count, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.moveObject(id, 'hand', { cause: 'bounce' });
  }
  if (cost.manual) {
    const resp = yield* g.ask({ type: 'yesNo', player: p, prompt: `Pay cost: ${cost.manual}?`, sourceId: obj.id });
    if (resp.type !== 'yesNo' || !resp.value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Timing and legality
// ---------------------------------------------------------------------------

export function canCastSorcerySpeed(g: Game, p: PlayerId): boolean {
  return g.state.turn.activePlayer === p && g.isMainPhase() && g.state.stack.length === 0;
}

/** "You may play lands and cast creature spells from the top of your library." */
export function playableFromTop(g: Game, p: PlayerId, obj: GameObject): boolean {
  if (obj.owner !== p || g.player(p).library[0] !== obj.id) return false;
  const land = /\bLand\b/.test(faceOf(obj, 0).typeLine);
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'playFromTop') continue;
    const d = (r.data as { lands?: boolean; spells?: boolean; oncePerTurn?: boolean; filter?: import('./types.js').ObjectFilter; landFilter?: import('./types.js').ObjectFilter } | undefined) ?? {};
    if (land) {
      if (!d.lands) continue;
      if (d.landFilter && !matchesFilter(g, obj, { ...d.landFilter, zone: undefined }, { sourceId: null, controller: p })) continue;
      return true;
    }
    if (!d.spells) continue;
    if (d.oncePerTurn && g.state.turnStats[`castFromTop:${p}`]) continue;
    if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
    return true;
  }
  return false;
}

/** Zones a player may cast the object from right now. */
function castableFrom(g: Game, p: PlayerId, obj: GameObject): boolean {
  if (obj.zone === 'library') return playableFromTop(g, p, obj);
  if (obj.owner !== p && obj.zone !== 'exile' && obj.zone !== 'graveyard') return false;
  if (obj.zone === 'hand' || obj.zone === 'command') return true;
  if (obj.zone === 'graveyard') {
    if ((obj.owner === p && /^Flashback/m.test(obj.card.oracleText)) || obj.memory['castableBy'] === p) return true;
    if (obj.owner !== p) return false;
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || r.tag !== 'castFromGraveyard') continue;
      const d = (r.data as { filter?: import('./types.js').ObjectFilter; oncePerTurn?: boolean } | undefined) ?? {};
      if (d.oncePerTurn && g.state.turnStats[`castFromGy:${p}`]) continue;
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
      return true;
    }
    return false;
  }
  // "You may cast spells from among cards exiled with ~."
  if (obj.zone === 'exile') {
    for (const id of g.state.battlefield) {
      const holder = g.state.objects[id];
      if (!holder || holder.controller !== p) continue;
      const exiled = (holder.memory['exiled'] as ObjectId[] | undefined) ?? [];
      if (!exiled.includes(obj.id)) continue;
      for (const r of g.characteristics(id).rules) {
        if (r.kind !== 'custom' || r.tag !== 'castExiledWithSource') continue;
        const d = r.data as { filter?: import('./types.js').ObjectFilter } | undefined;
        if (d?.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: id, controller: p })) continue;
        return true;
      }
      for (const r of g.playerRules(p)) {
        if (r.kind !== 'custom' || r.tag !== 'castExiledWithSource') continue;
        const d = r.data as { filter?: import('./types.js').ObjectFilter } | undefined;
        if (d?.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: id, controller: p })) continue;
        return true;
      }
    }
  }
  // "You may cast ~ from exile." (the permission is printed on the card itself)
  if (obj.zone === 'exile' && obj.owner === p && /^You may cast .+ from exile\.?$/mi.test(obj.card.oracleText)) return true;
  if (obj.zone === 'exile' && obj.memory['playableBy'] !== p) {
    // "You may play cards you don't own with stash counters on them from exile" style permissions.
    for (const r of g.playerRules(p)) {
      if (r.kind === 'custom' && r.tag === 'playExiledWithSource') {
        const d = r.data as { yourTurn?: boolean } | undefined;
        const srcId = (r as { sourceId?: ObjectId }).sourceId ?? null;
        if (d?.yourTurn && g.state.turn.activePlayer !== p) continue;
        if (matchesFilter(g, obj, { exiledWithSource: true }, { sourceId: srcId, controller: p })) return true;
      }
      if (r.kind === 'custom' && r.tag === 'playExiledWithCounter') {
        const d = r.data as { counter: string; notOwned?: boolean; yourTurn?: boolean } | undefined;
        if (!d) continue;
        if ((obj.counters[d.counter] ?? 0) <= 0) continue;
        if (d.notOwned && obj.owner === p) continue;
        if (d.yourTurn && g.state.turn.activePlayer !== p) continue;
        return true;
      }
    }
  }
  if (obj.zone === 'exile') {
    const until = obj.memory['playableUntil'];
    if (obj.memory['playableBy'] !== p) return false;
    if (typeof obj.memory['plotted'] === 'number' && obj.memory['plotted'] >= g.state.turn.number) return false; // plot: a later turn
    if (typeof obj.memory['foretoldTurn'] === 'number' && obj.memory['foretoldTurn'] >= g.state.turn.number) return false; // foretell: a later turn
    return until === 'permanent' || until === g.state.turn.number;
  }
  return false;
}

function freeFromExile(g: Game, obj: GameObject): boolean {
  return obj.zone === 'exile' && obj.memory['freeCast'] === true;
}

export interface CastOptions {
  free?: boolean;
  faceIndex?: number;
  /** Mana of any type may be spent (colored symbols become generic). */
  anyMana?: boolean;
  /** "by paying life equal to its mana value rather than paying its mana cost" */
  payLifeInsteadOfMana?: boolean;
}

/** The face being cast. */
function faceOf(obj: GameObject, faceIndex: number) {
  if (faceIndex > 0 && obj.card.faces?.[faceIndex]) return obj.card.faces[faceIndex];
  return obj.card;
}

/** Compute the total mana cost to cast, including commander tax and reductions. */
export function computeCastCost(g: Game, p: PlayerId, obj: GameObject, faceIndex: number, opts: { kicker?: boolean; kicks?: number; alternative?: string; kickerCosts?: string[]; /** Zone the card is being cast from (it is already on the stack while costs are computed). */ fromZone?: ZoneName } = {}): ManaCost {
  const face = faceOf(obj, faceIndex);
  const zone = opts.fromZone ?? obj.zone;
  let cost: ManaCost;
  const script = g.scriptFor({ ...obj, faceIndex });
  const alt = opts.alternative ? script.alternativeCosts?.find((a) => a.id === opts.alternative) : undefined;
  const granted = opts.alternative?.startsWith('plr:') ? grantedAltCosts(g, p, obj).find((a) => a.id === opts.alternative) : undefined;
  if (granted) cost = parseManaCost(granted.mana);
  else if (alt) cost = parseManaCost(alt.cost.mana ?? '');
  else if (opts.alternative === 'flashback' && zone === 'graveyard') {
    const fb = obj.card.oracleText.match(/Flashback (\{[^\n]+?\})(?:\s|$)/);
    cost = parseManaCost(fb?.[1] ?? face.manaCost);
  } else if (typeof obj.memory['playForCost'] === 'string' && zone === 'exile') {
    // Airbend and similar: cast it from exile for a fixed cost instead of its mana cost.
    cost = parseManaCost(obj.memory['playForCost'] as string);
  } else if (zone === 'exile' && typeof obj.memory['foretellCost'] === 'string') {
    // Foretold: the only cost it can be cast for is its foretell cost.
    cost = parseManaCost(obj.memory['foretellCost'] as string);
  } else cost = parseManaCost(face.manaCost);
  if (obj.isCommander && zone === 'command') cost = adjustGeneric(cost, obj.commanderCasts * 2);
  if (opts.kickerCosts?.length) {
    // "Kicker {2}{B} and/or {2}{R}": only the kickers actually chosen are added.
    const extra = opts.kickerCosts.flatMap((c) => parseManaCost(c).symbols);
    cost = { symbols: [...cost.symbols, ...extra], xCount: cost.xCount };
  } else if (opts.kicker) {
    const k = obj.card.oracleText.match(/(?:Multik|K)icker (\{[^\n]+?\})(?:\s|$)/) ?? obj.card.oracleText.match(/Replicate (\{[^\n]+?\})(?:\s|$)/);
    const times = opts.kicks ?? 1;
    if (k) {
      const extra = parseManaCost(k[1]).symbols;
      const all = Array.from({ length: times }, () => extra).flat();
      cost = { symbols: [...cost.symbols, ...all], xCount: cost.xCount };
    }
  }
  // Defiler cycle: "As an additional cost to cast <X> spells, you may pay 2 life. Those spells cost {W} less."
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'optionalLifeCost') continue;
    const d = (r.data as { filter?: import('./types.js').ObjectFilter; life?: number } | undefined) ?? {};
    if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
    if (obj.memory['defilerLifePaid']) cost = adjustGeneric(cost, -1);
  }
  // "You may spend mana as though it were mana of any color to cast <X> spells": every coloured
  // symbol becomes generic, the same shape as a card-specific `anyManaType`.
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'manaAsAnyColor') continue;
    const d = (r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
    if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
    cost = { symbols: cost.symbols.map((sy) => (sy.kind === 'color' || sy.kind === 'hybrid' || sy.kind === 'phyrexian' ? { kind: 'generic' as const, amount: 1 } : sy.kind === 'monoHybrid' ? { kind: 'generic' as const, amount: 2 } : sy)), xCount: cost.xCount };
    break;
  }
  // Cost reductions / increases from static rules.
  let delta = 0;
  // "The next spell you cast this turn costs {1} less to cast." Spent by the first matching spell.
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'nextSpellCostReduction') continue;
    if (!nextSpellReductionApplies(g, obj, p, r.data)) continue;
    delta -= (r.data as { amount?: number }).amount ?? 1;
    break;
  }
  for (const r of g.playerRules(p)) {
    if (r.kind === 'costReduction' && (!r.filter || matchesFilter(g, obj, { ...r.filter, zone: undefined }, { sourceId: null, controller: p }))) {
      const srcId = (r as { sourceId?: ObjectId }).sourceId ?? null;
      const mult = r.per ? objectsMatching(g, { ...r.per, zone: r.per.zone ?? 'battlefield' }, { sourceId: srcId, controller: p }).length : r.perAmount !== undefined ? g.resolveAmount(r.perAmount, { sourceId: srcId, controller: p, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} }) : 1;
      if (r.symbols) cost = adjustSymbols(cost, r.symbols, -mult);
      else delta -= r.amount * mult;
    }
    if (r.kind === 'costIncrease' && (!r.filter || matchesFilter(g, obj, { ...r.filter, zone: undefined }, { sourceId: null, controller: p }))) {
      if (r.symbols) cost = adjustSymbols(cost, r.symbols, 1);
      else delta += r.amount;
    }
  }
  // The spell's own cost modifiers (affinity, "costs {1} less for each ...").
  for (const mod of script.costModifiers ?? []) {
    if (mod.perExtraTarget || mod.ifTargets) continue; // applied at cast time once targets are known
    if (mod.condition && !g.checkCondition(mod.condition, { sourceId: obj.id, controller: p })) continue;
    const n = mod.per ? objectsMatching(g, { ...mod.per, zone: mod.per.zone ?? 'battlefield' }, { sourceId: obj.id, controller: p }).length : mod.perAmount !== undefined ? g.resolveAmount(mod.perAmount, { sourceId: obj.id, controller: p, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} }) : 1;
    if (mod.symbols) {
      cost = adjustSymbols(cost, mod.symbols, (mod.direction === 'less' ? -1 : 1) * n);
      continue;
    }
    delta += (mod.direction === 'less' ? -1 : 1) * mod.amount * n;
  }
  if (delta !== 0) cost = adjustGeneric(cost, delta);
  return cost;
}

/** Does a pending "next spell you cast" cost reduction apply to this spell? */
function nextSpellReductionApplies(g: Game, obj: GameObject, p: PlayerId, data: unknown): boolean {
  const d = (data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
  return !d.filter || matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p });
}

/** Alternative costs the player could pay for this card right now. */
export function availableAlternativeCosts(g: Game, p: PlayerId, obj: GameObject): { id: string; label: string }[] {
  const script = g.scriptFor(obj);
  const out: { id: string; label: string }[] = [];
  for (const alt of script.alternativeCosts ?? []) {
    if (alt.zone && obj.zone !== alt.zone) continue;
    if (alt.condition && !g.checkCondition(alt.condition, { sourceId: obj.id, controller: p })) continue;
    const cost = computeCastCost(g, p, obj, 0, { alternative: alt.id });
    if (solvePayment(cost, 0, g.player(p).manaPool, manaSourcesFor(g, p, castingKeywordsOf(g, obj)))) out.push({ id: alt.id, label: alt.text });
  }
  // "Once each turn, you may pay {0} rather than pay the mana cost for a spell you cast from exile."
  for (const a of grantedAltCosts(g, p, obj)) {
    const cost = computeCastCost(g, p, obj, 0, { alternative: a.id });
    if (solvePayment(cost, 0, g.player(p).manaPool, manaSourcesFor(g, p, castingKeywordsOf(g, obj)))) out.push({ id: a.id, label: a.label });
  }
  return out;
}

/** Alternative costs a player rule grants for other players' spells ("you may pay {0} rather than ..."). */
export interface GrantedAltCost {
  id: string;
  label: string;
  mana: string;
  /** "by paying life equal to its mana value rather than paying its mana cost" */
  payLifeEqualToManaValue?: boolean;
  /** "You may pay eight {E} rather than pay the mana cost for permanent spells you cast." */
  energy?: number;
}

export function grantedAltCosts(g: Game, p: PlayerId, obj: GameObject): GrantedAltCost[] {
  const out: GrantedAltCost[] = [];
  const rules = g.playerRules(p);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.kind !== 'custom' || r.tag !== 'altCostForSpells') continue;
    const d = r.data as { cost?: string; payLifeEqualToManaValue?: boolean; energy?: number; filter?: import('./types.js').ObjectFilter; oncePerTurn?: boolean; fromZone?: GameObject['zone'] } | undefined;
    if (!d || (!d.cost && !d.payLifeEqualToManaValue && d.energy === undefined)) continue;
    if (d.oncePerTurn && g.state.turnStats[`altCost:${p}`]) continue;
    if (d.fromZone && obj.zone !== d.fromZone) continue;
    if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
    if (d.payLifeEqualToManaValue) {
      const mv = g.characteristics(obj.id).manaValue;
      if (g.player(p).life < mv) continue;
      out.push({ id: `plr:${i}`, label: `Pay ${mv} life instead of this spell's mana cost`, mana: '', payLifeEqualToManaValue: true });
    } else if (d.energy !== undefined) {
      if (g.player(p).energy < d.energy) continue;
      out.push({ id: `plr:${i}`, label: `Pay ${d.energy} {E} instead of this spell's mana cost`, mana: '', energy: d.energy });
    } else out.push({ id: `plr:${i}`, label: `Pay ${d.cost} instead of this spell's mana cost`, mana: d.cost! });
  }
  return out;
}

export function spellTargets(g: Game, obj: GameObject, script: CardScript, faceIndex: number, modes: number[]): TargetSpec[] {
  const face = faceOf(obj, faceIndex);
  const spell = script.abilities.find((a) => a.kind === 'spell');
  const specs: TargetSpec[] = [];
  if (spell && spell.kind === 'spell') {
    if (spell.modes && modes.length) for (const m of modes) specs.push(...(spell.modes[m]?.targets ?? []));
    else specs.push(...(spell.targets ?? []));
  }
  if (/\bAura\b/.test(face.typeLine)) specs.push(auraTargetSpec(face.oracleText));
  return specs;
}

/** Can `cost` be paid, counting 2 life per Phyrexian symbol the player cannot cover with mana (CR 107.4f)? */
export function payableWithLife(g: Game, p: PlayerId, cost: ManaCost, x: number, sources: ManaSourceOption[]): boolean {
  const pl = g.player(p);
  if (solvePayment(cost, x, pl.manaPool, sources)) return true;
  const phy = cost.symbols.filter((sy) => sy.kind === 'phyrexian').length;
  for (let k = 1; k <= phy; k++) {
    let dropped = 0;
    const reduced: ManaCost = { symbols: cost.symbols.filter((sy) => (sy.kind === 'phyrexian' && dropped < k ? (dropped++, false) : true)), xCount: cost.xCount };
    if (pl.life >= 2 * k && solvePayment(reduced, x, pl.manaPool, sources)) return true;
  }
  return false;
}

export function canCastNow(g: Game, p: PlayerId, obj: GameObject): boolean {
  if (!castableFrom(g, p, obj)) return false;
  const ch = g.characteristics(obj.id);
  const face = obj.card;
  const isInstant = ch.types.includes('Instant') || ch.keywords.has('Flash') || /\bFlash\b/.test(face.oracleText.split('\n')[0] ?? '');
  const anyFaceInstant = obj.card.faces?.some((f) => /Instant/.test(f.typeLine) || /^Flash\b/m.test(f.oracleText));
  if (ch.types.includes('Land') && !(obj.card.faces?.some((f) => !/Land/.test(f.typeLine)))) return false; // lands are played, not cast
  const sorceryOnly = obj.memory['sorceryOnly'] === true;
  const castCond = g.scriptFor(obj).castCondition;
  if (castCond && !g.checkCondition(castCond, { sourceId: obj.id, controller: p })) return false;
  if ((sorceryOnly || (!isInstant && !anyFaceInstant)) && !canCastSorcerySpeed(g, p)) return false;
  // "Each opponent can cast spells only any time they could cast a sorcery."
  if (g.playerRules(p).some((r) => r.kind === 'custom' && r.tag === 'sorcerySpeedOnly') && !canCastSorcerySpeed(g, p)) return false;
  // "Players can't cast spells from graveyards or libraries."
  if ((obj.zone === 'graveyard' || obj.zone === 'library') && g.playerRules(p).some((r) => r.kind === 'custom' && r.tag === 'noCastFromGraveyardOrLibrary')) return false;
  // "Spells with the chosen name can't be cast."
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'cantCast') continue;
    const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter;
    const srcId = (r as { sourceId?: ObjectId }).sourceId ?? null;
    if (f && matchesFilter(g, obj, { ...f, zone: undefined }, { sourceId: srcId, controller: p })) return false;
  }
  // Can we afford it?
  const cost = computeCastCost(g, p, obj, 0, { alternative: obj.zone === 'graveyard' && /^Flashback\b/m.test(obj.card.oracleText) ? 'flashback' : undefined });
  const sources = manaSourcesFor(g, p, castingKeywordsOf(g, obj));
  if (!freeFromExile(g, obj) && !payableWithLife(g, p, cost, 0, sources) && availableAlternativeCosts(g, p, obj).length === 0) {
    // Try other faces (MDFC / adventure)
    if (obj.card.faces) {
      for (let i = 1; i < obj.card.faces.length; i++) {
        if (/Land/.test(obj.card.faces[i].typeLine)) continue;
        if (solvePayment(computeCastCost(g, p, obj, i), 0, g.player(p).manaPool, sources)) return true;
      }
    }
    return false;
  }
  // Targets must exist
  const script = g.scriptFor(obj);
  const specs = spellTargets(g, obj, script, 0, []);
  const spell = script.abilities.find((a) => a.kind === 'spell');
  if (spell && spell.kind === 'spell' && spell.modes) return true; // modes checked at cast time
  for (const spec of specs) {
    if (spec.optional) continue;
    const { legalTargets } = filtersMod();
    if (legalTargets(g, spec, obj.id, p).length < (spec.min ?? 1)) return false;
  }
  return true;
}

export function canPlayLandNow(g: Game, p: PlayerId): boolean {
  if (!canCastSorcerySpeed(g, p)) return false;
  const pl = g.player(p);
  let max = pl.maxLandsPerTurn;
  for (const r of g.playerRules(p)) if (r.kind === 'extraLandDrop') max += r.count;
  return pl.landsPlayedThisTurn < max;
}

function isLandCard(obj: GameObject, faceIndex = 0): boolean {
  return /\bLand\b/.test(faceOf(obj, faceIndex).typeLine);
}

export function buildPriorityDecision(g: Game, p: PlayerId): PriorityDecision {
  const pl = g.player(p);
  const playable: ObjectId[] = [];
  const landOk = canPlayLandNow(g, p);
  const zonesToScan: ObjectId[] = [...pl.hand, ...pl.command, ...pl.graveyard, ...pl.exile];
  if (pl.library[0] !== undefined && g.playerRules(p).some((r) => r.kind === 'custom' && r.tag === 'playFromTop')) zonesToScan.push(pl.library[0]);
  const landsFromGraveyard = (o: GameObject) => g.playerRules(p).some((r) => {
    if (r.kind !== 'custom' || r.tag !== 'playLandsFromGraveyard') return false;
    const d = r.data as { filter?: import('./types.js').ObjectFilter } | undefined;
    return !d?.filter || matchesFilter(g, o, { ...d.filter, zone: undefined }, { sourceId: null, controller: p });
  });
  for (const o of g.opponentsOf(p)) zonesToScan.push(...g.player(o).graveyard.filter((id) => g.obj(id).memory['castableBy'] === p), ...g.player(o).exile.filter((id) => Object.values(g.obj(id).counters).some((n) => n > 0)));
  for (const id of zonesToScan) {
    const obj = g.obj(id);
    if (isLandCard(obj) || obj.card.faces?.some((f) => /\bLand\b/.test(f.typeLine))) {
      if (landOk && (obj.zone === 'hand' || obj.zone === 'command' || ((obj.zone === 'exile' || obj.zone === 'library') && castableFrom(g, p, obj)) || (obj.zone === 'graveyard' && landsFromGraveyard(obj) && obj.owner === p))) {
        if (isLandCard(obj) || obj.card.layout === 'modal_dfc') playable.push(id);
      }
      if (isLandCard(obj) && obj.card.layout !== 'modal_dfc') continue;
    }
    if (canCastNow(g, p, obj)) {
      if (!playable.includes(id)) playable.push(id);
    }
  }
  const abilities: PriorityDecision['activatableAbilities'] = [];
  for (const obj of Object.values(g.state.objects)) {
    const foreign = obj.controller !== p;
    if (foreign && obj.zone !== 'battlefield') continue;
    if (obj.zone !== 'battlefield' && obj.zone !== 'graveyard' && obj.zone !== 'hand' && obj.zone !== 'command' && obj.zone !== 'exile') continue;
    for (const ab of abilitiesOf(g, obj)) {
      if (foreign && !ab.spec.anyPlayer) continue; // "Any player may activate this ability"
      if ((ab.spec.zone ?? 'battlefield') !== obj.zone) continue;
      if (!canActivate(g, p, obj, ab)) continue;
      abilities.push({ objectId: obj.id, abilityIndex: ab.index, text: ab.spec.text });
    }
  }
  const alternativeCosts: PriorityDecision['alternativeCosts'] = [];
  for (const id of playable) {
    const obj = g.obj(id);
    if (isLandCard(obj)) continue;
    for (const a of availableAlternativeCosts(g, p, obj)) alternativeCosts.push({ objectId: id, id: a.id, label: a.label });
  }
  return { type: 'priority', id: 0, player: p, prompt: g.state.stack.length ? `${g.state.stack[g.state.stack.length - 1].text} is on the stack. Respond or pass.` : `${stepName(g)} — you have priority.`, playableCards: playable, activatableAbilities: abilities, alternativeCosts, canPlayLand: landOk && pl.hand.some((id) => isLandCard(g.obj(id))) };
}

export function stepName(g: Game): string {
  const names: Record<string, string> = { untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw step', main1: 'Main phase 1', beginCombat: 'Beginning of combat', declareAttackers: 'Declare attackers', declareBlockers: 'Declare blockers', firstStrikeDamage: 'First-strike damage', combatDamage: 'Combat damage', endCombat: 'End of combat', main2: 'Main phase 2', end: 'End step', cleanup: 'Cleanup' };
  return `${g.player(g.state.turn.activePlayer).name}'s ${names[g.state.turn.step] ?? g.state.turn.step}`;
}

export function canActivate(g: Game, p: PlayerId, obj: GameObject, ab: ObjectAbility): boolean {
  const spec = ab.spec;
  if (spec.sorcerySpeed && !canCastSorcerySpeed(g, p)) return false;
  if (spec.cost.loyalty !== undefined) {
    if (!canCastSorcerySpeed(g, p)) return false;
    if (g.state.turnStats[`loyalty:${obj.id}`]) return false;
    if (spec.cost.loyalty < 0 && (obj.counters['loyalty'] ?? 0) < -spec.cost.loyalty) return false;
  }
  if (spec.oncePerTurn && g.state.turnStats[`once:${obj.id}:${spec.text}`]) return false;
  if (spec.perTurnLimit !== undefined && (g.state.turnStats[`uses:${obj.id}:${spec.text}`] ?? 0) >= spec.perTurnLimit) return false;
  if (spec.exhaust && obj.memory[`exhausted:${spec.text}`]) return false;
  if (spec.condition && !g.checkCondition(spec.condition, { sourceId: obj.id, controller: p })) return false;
  if (obj.zone === 'battlefield' && g.characteristics(obj.id).rules.some((r) => r.kind === 'custom' && r.tag === 'cantActivate')) return false;
  // "Its activated abilities can't be activated (unless they are mana abilities)."
  if (obj.zone === 'battlefield') {
    for (const r of g.characteristics(obj.id).rules) {
      if (r.kind !== 'custom' || r.tag !== 'cantActivateOwnAbilities') continue;
      if ((r.data as { exceptMana?: boolean } | undefined)?.exceptMana && spec.manaAbility) continue;
      return false;
    }
  }
  // "Only your opponents may activate this ability."
  if (spec.opponentsOnly && obj.controller === p) return false;
  // "Activated abilities of sources with the chosen name can't be activated."
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'cantActivateNamed') continue;
    const d = (r.data as { key?: string; exceptMana?: boolean } | undefined) ?? {};
    if (d.exceptMana && spec.manaAbility) continue;
    const srcId = (r as { sourceId?: ObjectId }).sourceId;
    const holder = srcId !== undefined ? g.state.objects[srcId] : undefined;
    const want = holder?.chosen[d.key ?? 'cardName'];
    if (typeof want === 'string' && g.characteristics(obj.id).name === want) return false;
  }
  // "That player cannot activate abilities that aren't mana abilities."
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom' || r.tag !== 'cantActivateAbilities') continue;
    const d = (r.data as { exceptMana?: boolean } | undefined) ?? {};
    if (d.exceptMana && spec.manaAbility) continue;
    return false;
  }
  if (spec.cost.tap && !canUseTapAbility(g, obj)) return false;
  if (spec.cost.untap && !obj.tapped) return false;
  if (spec.cost.sacrificeSelf && obj.zone !== 'battlefield') return false;
  if (spec.cost.discardSelf && obj.zone !== 'hand') return false;
  if (spec.cost.returnSelf && obj.zone !== 'battlefield') return false;
  if (spec.cost.payLife !== undefined && typeof spec.cost.payLife === 'number' && g.player(p).life < spec.cost.payLife) return false;
  if (spec.cost.removeCounters && typeof spec.cost.removeCounters.amount === 'number' && (obj.counters[spec.cost.removeCounters.counter] ?? 0) < spec.cost.removeCounters.amount) return false;
  if (spec.cost.removeCounters && typeof spec.cost.removeCounters.amount !== 'number' && !(obj.counters[spec.cost.removeCounters.counter] ?? 0)) return false;
  if (spec.cost.tapUntappedTotalPower && objectsMatching(g, { ...spec.cost.tapUntappedTotalPower.filter, controller: 'you', untapped: true }, { sourceId: obj.id, controller: p }).reduce((s, o) => s + (g.characteristics(o.id).power ?? 0), 0) < spec.cost.tapUntappedTotalPower.power) return false;
  if (spec.cost.sacrifice) {
    if (objectsMatching(g, { ...spec.cost.sacrifice.filter, controller: 'you' }, { sourceId: obj.id, controller: p }).length < (typeof spec.cost.sacrifice.count === 'number' ? spec.cost.sacrifice.count : spec.cost.sacrifice.count === undefined ? 1 : 0)) return false;
  }
  if (spec.cost.discard && spec.cost.discard !== 'hand' && g.player(p).hand.length < (spec.cost.discard.count === 'X' ? 1 : spec.cost.discard.count)) return false;
  if (spec.cost.exileFromGraveyard && g.player(p).graveyard.filter((id) => matchesFilter(g, g.obj(id), { ...spec.cost.exileFromGraveyard!.filter, zone: 'graveyard' }, { sourceId: obj.id, controller: p })).length < (typeof spec.cost.exileFromGraveyard.count === 'number' ? spec.cost.exileFromGraveyard.count : 1)) return false;
  if (spec.cost.mana) {
    const cost = parseManaCost(spec.cost.mana);
    if (!solvePayment(cost, 0, g.player(p).manaPool, manaSourcesFor(g, p).filter((s) => s.id !== obj.id || !spec.cost.tap))) return false;
  }
  if (spec.targets?.length) {
    const { legalTargets } = filtersMod();
    for (const t of spec.targets) if (!t.optional && legalTargets(g, t, obj.id, p).length < (t.min ?? 1)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function* playLand(g: Game, p: PlayerId, id: ObjectId): Gen<boolean> {
  const obj = g.state.objects[id];
  if (!obj || !canPlayLandNow(g, p)) return false;
  if (g.playerRules(p).some((r) => r.kind === 'custom' && r.tag === 'cantPlayLands')) return false;
  let faceIndex = 0;
  if (!isLandCard(obj)) {
    const back = obj.card.faces?.findIndex((f, i) => i > 0 && /\bLand\b/.test(f.typeLine)) ?? -1;
    if (back < 1) return false;
    faceIndex = back;
  }
  const fromGraveyard = obj.zone === 'graveyard' && obj.owner === p && g.playerRules(p).some((r) => r.kind === 'custom' && r.tag === 'playLandsFromGraveyard');
  if (!(obj.zone === 'hand' || ((obj.zone === 'exile' || obj.zone === 'library') && castableFrom(g, p, obj)) || obj.zone === 'command' || fromGraveyard)) return false;
  obj.faceIndex = faceIndex;
  const r = yield* enterBattlefield(g, id, p, {});
  if (!r) return false;
  r.faceIndex = faceIndex;
  g.player(p).landsPlayedThisTurn++;
  g.log(`${g.player(p).name} plays ${g.nameOf(id)}.`, { kind: 'play', data: { player: p, objectId: id } });
  g.emit({ name: 'landPlayed', objectId: id, playerId: p });
  return true;
}

export function* castSpell(g: Game, p: PlayerId, id: ObjectId, resp: Extract<Response, { type: 'cast' }>, opts: CastOptions = {}): Gen<boolean> {
  const obj = g.state.objects[id];
  if (!obj) return false;
  if (!opts.free && !castableFrom(g, p, obj)) return false;
  const faceIndex = resp.faceIndex ?? opts.faceIndex ?? 0;
  const face = faceOf(obj, faceIndex);
  if (/\bLand\b/.test(face.typeLine)) return false;
  const fromZone = obj.zone;
  const ch = g.characteristics(obj.id);
  const altInstant = !!resp.alternativeCost && (g.scriptFor(obj).alternativeCosts ?? []).some((a) => a.id === resp.alternativeCost && a.instantSpeed);
  const flashRule = g.playerRules(p).some((r) => {
    if (r.kind !== 'custom' || r.tag !== 'castAsThoughFlash') return false;
    const d = (r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
    return !d.filter || matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: (r as { sourceId?: ObjectId }).sourceId ?? null, controller: p });
  });
  const isInstantSpeed = /Instant/.test(face.typeLine) || /^Flash\b/m.test(face.oracleText) || ch.keywords.has('Flash') || altInstant || flashRule;
  if (freeFromExile(g, obj)) opts = { ...opts, free: true };
  // "Mana of any type can be spent to cast those spells": carried by the permission that allows it.
  if (!opts.anyMana) {
    const anyManaZone: Record<string, ZoneName> = { playFromTop: 'library', playExiledWithSource: 'exile', playExiledWithCounter: 'exile', castExiledWithSource: 'exile', castFromGraveyard: 'graveyard' };
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || anyManaZone[r.tag] !== fromZone) continue;
      if ((r.data as { anyMana?: boolean } | undefined)?.anyMana) {
        opts = { ...opts, anyMana: true };
        break;
      }
    }
  }
  if (obj.memory['playAnyMana']) opts = { ...opts, anyMana: true };
  if ((obj.memory['sorceryOnly'] === true || (!opts.free && !isInstantSpeed)) && !canCastSorcerySpeed(g, p)) return false;
  for (const r of g.playerRules(p)) {
    if (r.kind !== 'custom') continue;
    if (r.tag === 'maxSpellsPerTurn') {
      const d = r.data;
      if (typeof d === 'object' && d !== null) {
        const { count, filter } = d as { count?: number; filter?: import('./types.js').ObjectFilter };
        const f = filter ?? {};
        const already = (g.state.castThisTurn ?? []).filter((c) => {
          if (c.controller !== p) return false;
          if (f.types && !f.types.every((t) => c.types.includes(t))) return false;
          if (f.notTypes && f.notTypes.some((t) => c.types.includes(t))) return false;
          if (f.subtypes && !f.subtypes.every((t) => c.subtypes.includes(t))) return false;
          if (f.notSubtypes && f.notSubtypes.some((t) => c.subtypes.includes(t))) return false;
          if (f.colors && !f.colors.some((col) => c.colors.includes(col))) return false;
          return true;
        }).length;
        if (already >= (count ?? 1) && matchesFilter(g, obj, { ...(filter ?? {}), zone: undefined }, { sourceId: null, controller: p })) return false;
      } else if ((g.state.turnStats[`cast:${p}`] ?? 0) >= ((d as number | undefined) ?? 1)) return false;
    }
    if (r.tag === 'cantCastSpells') {
      const d = (r.data as { filter?: import('./types.js').ObjectFilter; sourceTurnOnly?: boolean; notFromHand?: boolean; chosenNameKey?: string; duringCombat?: boolean; fromGraveyard?: boolean; sameNameAsExiled?: boolean } | undefined) ?? {};
      const srcId = (r as { sourceId?: ObjectId }).sourceId;
      const srcController = (r as { sourceController?: PlayerId }).sourceController;
      if (d.sourceTurnOnly && g.state.turn.activePlayer !== srcController) continue;
      if (d.notFromHand && fromZone === 'hand') continue;
      if (d.duringCombat && g.state.turn.phase !== 'combat') continue;
      if (d.fromGraveyard && fromZone !== 'graveyard') continue;
      if (d.sameNameAsExiled) {
        const src = srcId !== undefined ? g.state.objects[srcId] : undefined;
        const exiled = (src?.memory['exiled'] as ObjectId[] | undefined) ?? [];
        if (!exiled.some((x) => g.state.objects[x] && g.characteristics(x).name === face.name)) continue;
      }
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: srcId ?? null, controller: srcController ?? p })) continue;
      if (d.chosenNameKey) {
        const src = srcId !== undefined ? g.state.objects[srcId] : undefined;
        const chosen = src?.memory[d.chosenNameKey];
        if (typeof chosen !== 'string' || chosen !== face.name) continue;
      }
      return false;
    }
  }
  const keywords = castingKeywordsOf(g, obj);
  const altId = resp.alternativeCost;
  if (altId && !availableAlternativeCosts(g, p, obj).some((a) => a.id === altId)) return false;

  const script = g.scriptFor({ ...obj, faceIndex });
  const player = g.player(p);
  const originalIndex = g.zoneList(obj.owner, fromZone).indexOf(id);

  // 601.2a: move to the stack
  obj.faceIndex = faceIndex;
  // Non-mana additional costs (sacrifice, discard…) are paid before the mana; if the mana then cannot
  // be paid the whole cast is undone (CR 730.1), so keep a snapshot to restore.
  const snap = script.additionalCost ? g.snapshotState() : null;
  g.moveObject(id, 'stack', { controller: p, skipEvents: true });
  obj.castFromZone = fromZone;
  const revert = () => {
    if (snap) {
      g.restoreState(snap);
      return;
    }
    const back = g.moveObject(id, fromZone, { skipEvents: true, position: fromZone === 'library' ? originalIndex : undefined });
    if (back) {
      back.faceIndex = 0;
      back.castFromZone = undefined;
    }
    g.state.stack = g.state.stack.filter((s) => !(s.kind === 'spell' && s.sourceId === id));
  };

  // Modes
  let modes: number[] = resp.modes ?? [];
  const spell = script.abilities.find((a) => a.kind === 'spell');
  if (spell && spell.kind === 'spell' && spell.modes && spell.modes.length) {
    const min = spell.minModes ?? 1;
    let max = spell.maxModes ?? 1;
    if (spell.maxModesIf && g.checkCondition(spell.maxModesIf.condition, { sourceId: id, controller: p })) max = Math.max(max, spell.maxModesIf.max);
    if (modes.length < min || modes.length > max) {
      if (spell.modesRepeatable) {
        // Pick one mode at a time so the same mode can be chosen repeatedly.
        modes = [];
        for (let k = 0; k < max; k++) {
          const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: `${face.name}: choose mode ${k + 1} of ${max}`, options: spell.modes.map((m, i) => ({ id: String(i), label: m.text })), min: 1, max: 1, sourceId: id });
          if (r.type !== 'options') {
            revert();
            return false;
          }
          modes.push(Number(r.ids[0]));
        }
      } else {
        const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: `${face.name}: choose ${min === max ? min : `${min}-${max}`} mode${max > 1 ? 's' : ''}`, options: spell.modes.map((m, i) => ({ id: String(i), label: m.text })), min, max, sourceId: id });
        if (r.type !== 'options') {
          revert();
          return false;
        }
        modes = r.ids.map(Number);
      }
    }
  }
  obj.modes = modes;

  // Kicker / multikicker
  let kicker = false;
  let kicks = 0;
  let kickerCosts: string[] | undefined;
  const multi = !opts.free ? face.oracleText.match(/^Kicker ((?:\{[^}]+\})+) and\/or ((?:\{[^}]+\})+)/m) : null;
  if (multi) {
    const chosen: string[] = [];
    for (const kc of [multi[1], multi[2]]) {
      const total = computeCastCost(g, p, obj, faceIndex, { kickerCosts: [...chosen, kc] });
      if (!solvePayment(total, 0, player.manaPool, manaSourcesFor(g, p))) continue;
      const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Pay the kicker cost ${kc} for ${face.name}?`, sourceId: id });
      if (r.type === 'yesNo' && r.value) chosen.push(kc);
    }
    if (chosen.length) {
      kicker = true;
      kicks = chosen.length;
      kickerCosts = chosen;
      obj.memory['kickersPaid'] = chosen;
    }
  } else if (!opts.free && /^Kicker /m.test(face.oracleText)) {
    const kcost = face.oracleText.match(/Kicker (\{[^\n]+?\})(?:\s|$)/)?.[1];
    if (kcost) {
      const total = computeCastCost(g, p, obj, faceIndex, { kicker: true });
      if (solvePayment(total, 0, player.manaPool, manaSourcesFor(g, p))) {
        const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Pay the kicker cost ${kcost} for ${face.name}?`, sourceId: id });
        kicker = r.type === 'yesNo' && r.value;
        if (kicker) kicks = 1;
      }
    }
  } else if (!opts.free && /^(?:Multikicker|Replicate) /m.test(face.oracleText)) {
    const kcost = face.oracleText.match(/(?:Multikicker|Replicate) (\{[^\n]+?\})(?:\s|$)/)?.[1];
    if (kcost) {
      for (;;) {
        const total = computeCastCost(g, p, obj, faceIndex, { kicker: true, kicks: kicks + 1 });
        if (!solvePayment(total, 0, player.manaPool, manaSourcesFor(g, p))) break;
        const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Pay the ${/^Replicate /m.test(face.oracleText) ? 'replicate' : 'multikicker'} cost ${kcost} for ${face.name} ${kicks ? 'again' : ''} (${kicks} so far)?`, sourceId: id });
        if (!(r.type === 'yesNo' && r.value)) break;
        kicks++;
      }
      kicker = kicks > 0;
    }
  }
  if (kicker) obj.additionalCostsPaid.push('kicker');
  // Gift: "You may promise an opponent a gift as you cast this spell."
  if (script.gift) {
    const opps = g.opponentsOf(p);
    if (opps.length) {
      const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Promise an opponent ${script.gift.text}?`, sourceId: id });
      if (r.type === 'yesNo' && r.value) {
        let to = opps[0];
        if (opps.length > 1) {
          const pick = yield* g.ask({ type: 'chooseOption', player: p, prompt: `Promise ${script.gift.text} to which opponent?`, options: opps.map((o) => ({ id: o, label: g.player(o).name })), min: 1, max: 1, sourceId: id });
          if (pick.type === 'options' && pick.ids[0] !== undefined) to = pick.ids[0];
        }
        obj.memory['giftPromised'] = to;
      }
    }
  }
  obj.memory['kicks'] = kicks;
  obj.memory['castAtInstantSpeed'] = !canCastSorcerySpeed(g, p);
  if (altId === 'overload') obj.memory['overloaded'] = true;
  // "More Than Meets the Eye {cost}": the card is cast converted, so it resolves as its back face.
  if (altId === 'converted' && obj.card.faces && obj.card.faces.length > 1) obj.faceIndex = 1;
  {
    // Morph / disguise: the spell resolves as a face-down 2/2 creature.
    const fd = altId ? (g.scriptFor(obj).alternativeCosts ?? []).find((a) => a.id === altId && a.faceDown) : undefined;
    if (fd) {
      obj.memory['castFaceDown'] = true;
      if (fd.ward) obj.memory['faceDownWard'] = fd.ward;
    }
  }

  // X
  let cost = opts.free ? { symbols: [], xCount: 0 } : computeCastCost(g, p, obj, faceIndex, { kicker, kicks: Math.max(1, kicks), kickerCosts, alternative: altId ?? (fromZone === 'graveyard' ? 'flashback' : undefined), fromZone });
  // "If you cast a spell this way, pay life equal to its mana value rather than paying its mana cost."
  let lifeInsteadOfMana = 0;
  let energyInsteadOfMana = 0;
  const grantedAlt = altId?.startsWith('plr:') ? grantedAltCosts(g, p, obj).find((a) => a.id === altId) : undefined;
  if (!opts.free && (opts.payLifeInsteadOfMana || grantedAlt?.payLifeEqualToManaValue)) {
    lifeInsteadOfMana = g.characteristics(obj.id).manaValue;
    cost = { symbols: [], xCount: cost.xCount };
  }
  if (!opts.free && grantedAlt?.energy !== undefined) {
    if (g.player(p).energy < grantedAlt.energy) return false;
    energyInsteadOfMana = grantedAlt.energy;
    cost = { symbols: [], xCount: cost.xCount };
  }
  if (!opts.free && !opts.payLifeInsteadOfMana && obj.memory['payLifeToCast']) {
    lifeInsteadOfMana = g.characteristics(obj.id).manaValue;
    cost = { symbols: [], xCount: cost.xCount };
  }
  if (!opts.free && !opts.payLifeInsteadOfMana && !lifeInsteadOfMana) {
    // The permission that let this spell be cast may charge life instead of mana.
    const zoneTag: Record<string, ZoneName> = { playFromTop: 'library', playExiledWithSource: 'exile', castExiledWithSource: 'exile', castFromGraveyard: 'graveyard', playLandsFromGraveyard: 'graveyard' };
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || zoneTag[r.tag] !== fromZone) continue;
      const d = (r.data as { payLifeEqualToManaValue?: boolean; filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
      if (!d.payLifeEqualToManaValue) continue;
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
      lifeInsteadOfMana = g.characteristics(obj.id).manaValue;
      cost = { symbols: [], xCount: cost.xCount };
      break;
    }
  }
  // Spree: each chosen mode carries an additional cost.
  if (!opts.free && spell && spell.kind === 'spell' && spell.modeCosts) {
    for (const mi of modes) {
      const mc = spell.modeCosts[mi];
      if (!mc) continue;
      const extra = parseManaCost(mc);
      cost = { symbols: [...cost.symbols, ...extra.symbols], xCount: cost.xCount + extra.xCount };
    }
  }
  if (altId) obj.additionalCostsPaid.push(altId);
  const baseCost = parseManaCost(face.manaCost);
  let x = resp.xValue ?? 0;
  if (baseCost.xCount > 0 && resp.xValue === undefined) {
    const mx = opts.free ? 0 : maxX(cost, player.manaPool, manaSourcesFor(g, p));
    const r = yield* g.ask({ type: 'chooseNumber', player: p, prompt: `Choose X for ${face.name}`, min: 0, max: mx, sourceId: id });
    if (r.type !== 'number') {
      revert();
      return false;
    }
    x = r.value;
  }
  obj.xValue = x;

  // Targets
  const specs = altId === 'overload' ? [] : spellTargets(g, obj, script, faceIndex, modes);
  let targets: Target[] = [];
  let targetSlots: Target[][] | undefined;
  if (specs.length) {
    const chosen = yield* chooseTargetsGrouped(g, p, id, specs, `Choose targets for ${face.name}`, x);
    if (!chosen) {
      revert();
      return false;
    }
    targets = chosen.flat;
    targetSlots = chosen.slots;
  }

  // Additional costs from the script (sacrifice, discard...)
  if (!opts.free && script.additionalCost) {
    const ok = yield* payAbilityCost(g, p, obj, script.additionalCost, x);
    if (!ok) {
      revert();
      return false;
    }
  }
  // "You may cast a permanent spell from your graveyard by sacrificing a land in addition to
  // paying its other costs": the permission that let this spell be cast carries its own cost.
  if (!opts.free && fromZone === 'graveyard') {
    for (const r of g.playerRules(p)) {
      if (r.kind !== 'custom' || r.tag !== 'castFromGraveyard') continue;
      const d = (r.data as { filter?: import('./types.js').ObjectFilter; extraCost?: AbilityCost } | undefined) ?? {};
      if (!d.extraCost) continue;
      if (d.filter && !matchesFilter(g, obj, { ...d.filter, zone: undefined }, { sourceId: null, controller: p })) continue;
      const ok = yield* payAbilityCost(g, p, obj, d.extraCost, x);
      if (!ok) {
        revert();
        return false;
      }
      break;
    }
  }
  // "costs {1} more to cast for each target beyond the first" / "costs {3} less to cast if it targets a tapped creature"
  for (const mod of script.costModifiers ?? []) {
    if (mod.perExtraTarget) {
      const n = targets.filter((t) => t.kind !== 'none').length - 1;
      if (n > 0) cost = adjustGeneric(cost, (mod.direction === 'less' ? -1 : 1) * mod.amount * n);
    } else if (mod.ifTargets) {
      const hit = targets.some((t) => t.kind === 'object' && g.state.objects[t.id] && matchesFilter(g, g.state.objects[t.id], { ...mod.ifTargets, zone: undefined }, { sourceId: id, controller: p }));
      if (hit) cost = adjustGeneric(cost, (mod.direction === 'less' ? -1 : 1) * mod.amount);
    }
  }
  // Mana
  if (obj.memory['anyManaType'] || opts.anyMana) cost = { symbols: cost.symbols.map((sy) => (sy.kind === 'color' || sy.kind === 'hybrid' || sy.kind === 'phyrexian' ? { kind: 'generic' as const, amount: 1 } : sy.kind === 'monoHybrid' ? { kind: 'generic' as const, amount: 2 } : sy)), xCount: cost.xCount };
  if (!opts.free) {
    const paid = yield* payCost(g, p, cost, x, id, keywords, !!resp.manualMana);
    if (paid) {
      if (fromZone === 'graveyard' && !/^Flashback/m.test(face.oracleText) && obj.memory['castableBy'] !== p) g.state.turnStats[`castFromGy:${p}`] = 1;
      if (fromZone === 'library') g.state.turnStats[`castFromTop:${p}`] = 1;
      if (altId?.startsWith('plr:')) g.state.turnStats[`altCost:${p}`] = 1;
      obj.memory['wasCast'] = true;
      obj.memory['manaSpent'] = cost.symbols.reduce((acc, sym) => acc + (sym.kind === 'generic' ? sym.amount : sym.kind === 'x' ? 0 : 1), 0) + x * cost.xCount;
    }
    if (!paid) {
      revert();
      g.log(`${player.name} can't pay for ${face.name}.`);
      return false;
    }
  }
  if (fromZone === 'exile' && obj.memory['freeCast']) {
    delete obj.memory['freeCast'];
    delete obj.memory['plotted'];
    delete obj.memory['sorceryOnly'];
    delete obj.memory['playableBy'];
  }

  const item: StackItem = {
    id: g.state.nextStackId++,
    kind: 'spell',
    sourceId: id,
    controller: p,
    text: face.name,
    targets,
    targetStamps: g.stampTargets(targets),
    targetSpecs: specs,
    modes,
    xValue: x,
    timestamp: g.now(),
    triggerContext: targetSlots ? { targetSlots } : undefined,
  };
  g.state.stack.push(item);
  wardTriggers(g, item);
  if (lifeInsteadOfMana > 0) g.loseLife(p, lifeInsteadOfMana, id);
  if (energyInsteadOfMana > 0) g.player(p).energy -= energyInsteadOfMana;
  obj.wasCast = true;
  player.spellsCastThisTurn++;
  if (obj.isCommander && fromZone === 'command') obj.commanderCasts++;
  g.touch();
  const tgt = targets.filter((t) => t.kind !== 'none').map((t) => g.targetName(t));
  g.log(`${player.name} casts ${face.name}${x ? ` (X=${x})` : ''}${tgt.length ? ` targeting ${tgt.join(', ')}` : ''}.`, { kind: 'cast', data: { player: p, objectId: id, targets } });
  {
    const cch = g.characteristics(id);
    (g.state.castThisTurn ??= []).push({ controller: p, name: cch.name, types: [...cch.types], subtypes: [...cch.subtypes], colors: [...cch.colors] });
  }
  {
    const rules = g.state.turnRules ?? [];
    const i = rules.findIndex((t) => t.player === p && t.rule.kind === 'custom' && t.rule.tag === 'nextSpellCostReduction' && nextSpellReductionApplies(g, obj, p, t.rule.data));
    if (i >= 0) rules.splice(i, 1);
  }
  g.emit({ name: 'cast', objectId: id, playerId: p, fromZone, data: { targets } });
  return true;
}

/** Choose targets for several specs, returning both grouped and flattened forms. */
export function* chooseTargetsGrouped(g: Game, p: PlayerId, sourceId: ObjectId | null, specs: TargetSpec[], prompt: string, x?: number): Gen<{ flat: Target[]; slots: Target[][] } | null> {
  const { legalTargets } = filtersMod();
  const slots = specs.map((spec) => {
    const xn = spec.countX ? (x ?? 0) * (spec.countX.times ?? 1) : null;
    const min = spec.optional || (xn !== null && spec.countX?.upTo) ? 0 : xn ?? spec.min ?? 1;
    const cap = spec.maxAmount !== undefined ? g.resolveAmount(spec.maxAmount, { sourceId, controller: p, targets: [], triggerContext: {}, memory: {}, x: x ?? 0, modes: [] }) : null;
    return { description: spec.description, legal: legalTargets(g, spec, sourceId, p, x), min, max: cap ?? xn ?? spec.max ?? 1 };
  });
  if (slots.some((s) => s.legal.length < s.min)) return null;
  let chosen: Target[][];
  const trivial = slots.every((s) => s.legal.length === s.min && s.min === s.max);
  if (trivial) chosen = slots.map((s) => s.legal.slice(0, s.max));
  else {
    const r = yield* g.ask({ type: 'chooseTargets', player: p, prompt, sourceId: sourceId ?? undefined, slots });
    if (r.type !== 'targets') return null;
    chosen = r.targets;
  }
  const flat: Target[] = chosen.map((s) => (s.length ? s[0] : { kind: 'none' as const }));
  // If any slot has multiple targets, flat carries only the first; effects use slots.
  for (const s of chosen) for (const t of s) if (t.kind === 'object') g.emit({ name: 'becomesTarget', objectId: t.id, sourceId: sourceId ?? undefined, playerId: p });
  return { flat, slots: chosen };
}

export function* activateAbility(g: Game, p: PlayerId, id: ObjectId, abilityIndex: number, resp: Extract<Response, { type: 'activate' }>): Gen<boolean> {
  const obj = g.state.objects[id];
  if (!obj) return false;
  const ab = findAbility(g, obj, abilityIndex);
  if (!ab) return false;
  if (obj.controller !== p && !ab.spec.anyPlayer) return false;
  if ((ab.spec.zone ?? 'battlefield') !== obj.zone) return false;
  if (!canActivate(g, p, obj, ab)) return false;
  const spec = ab.spec;

  // Mana abilities resolve immediately.
  if (spec.manaAbility) {
    const alts = manaFromAbility(g, obj, spec);
    if (alts.length === 1 && !spec.effects.some((e) => e.kind === 'addMana' && (e.mana === 'anyColor' || e.mana === 'anyOneColor' || e.mana === 'commanderColors'))) {
      const ok = yield* payAbilityCost(g, p, obj, spec.cost, 0, spec.text);
      if (!ok) return false;
      for (const c of alts[0]) g.player(p).manaPool[c]++;
      const extra = spec.effects.filter((e) => e.kind !== 'addMana');
      if (extra.length) yield* executeEffects(g, extra, { sourceId: id, controller: p, targets: [], triggerContext: {}, x: 0, modes: [], memory: costMemory(obj) });
    } else {
      const ok = yield* payAbilityCost(g, p, obj, spec.cost, 0, spec.text);
      if (!ok) return false;
      yield* executeEffects(g, spec.effects, { sourceId: id, controller: p, targets: [], triggerContext: {}, x: 0, modes: [], memory: costMemory(obj) });
    }
    g.touch();
    g.emit({ name: 'abilityActivated', objectId: id, playerId: p, data: { mana: true } });
    return true;
  }

  // X for abilities with {X} in cost
  let x = resp.xValue ?? 0;
  if (spec.cost.removeCounters?.amount === 'all') x = obj.counters[spec.cost.removeCounters.counter] ?? 0;
  else if (spec.cost.removeCounters?.amount === 'X' && !(spec.cost.mana && parseManaCost(spec.cost.mana).xCount > 0)) {
    // "Remove X / any number of counters": X is how many counters to remove.
    const mx = obj.counters[spec.cost.removeCounters.counter] ?? 0;
    const r = yield* g.ask({ type: 'chooseNumber', player: p, prompt: `Remove how many ${spec.cost.removeCounters.counter} counters?`, min: 1, max: mx, sourceId: id });
    if (r.type !== 'number') return false;
    x = r.value;
  } else if (spec.cost.revealFromHandX) {
    // "Reveal X green cards from your hand": X is how many you reveal.
    const f = spec.cost.revealFromHandX;
    const mx = g.player(p).hand.filter((cid) => matchesFilter(g, g.obj(cid), { ...f, zone: 'hand' }, { sourceId: id, controller: p })).length;
    const r = yield* g.ask({ type: 'chooseNumber', player: p, prompt: `Reveal how many cards for ${spec.text}?`, min: 0, max: mx, sourceId: id });
    if (r.type !== 'number') return false;
    x = r.value;
  } else if (spec.cost.mana && parseManaCost(spec.cost.mana).xCount > 0 && resp.xValue === undefined) {
    const mx = maxX(parseManaCost(spec.cost.mana), g.player(p).manaPool, manaSourcesFor(g, p));
    const r = yield* g.ask({ type: 'chooseNumber', player: p, prompt: `Choose X for ${spec.text}`, min: 0, max: mx, sourceId: id });
    if (r.type !== 'number') return false;
    x = r.value;
  }
  // Targets first (601.2c) so cancelling costs nothing.
  let targets: Target[] = [];
  let slots: Target[][] | undefined;
  if (spec.targets?.length) {
    const chosen = yield* chooseTargetsGrouped(g, p, id, spec.targets, `${g.nameOf(id)}: ${spec.text}`, x);
    if (!chosen) return false;
    targets = chosen.flat;
    slots = chosen.slots;
  }
  const ok = yield* payAbilityCost(g, p, obj, spec.cost, x, spec.text);
  if (!ok) return false;
  if (spec.cost.loyalty !== undefined) g.state.turnStats[`loyalty:${obj.id}`] = 1;
  if (spec.oncePerTurn) g.state.turnStats[`once:${obj.id}:${spec.text}`] = 1;
  if (spec.perTurnLimit !== undefined) g.state.turnStats[`uses:${obj.id}:${spec.text}`] = (g.state.turnStats[`uses:${obj.id}:${spec.text}`] ?? 0) + 1;
  if (spec.exhaust) obj.memory[`exhausted:${spec.text}`] = true;
  const item: StackItem = {
    id: g.state.nextStackId++,
    kind: 'ability',
    sourceId: id,
    controller: p,
    text: `${g.nameOf(id)}: ${spec.text}`,
    abilityRef: String(abilityIndex),
    targets,
    targetStamps: g.stampTargets(targets),
    targetSpecs: spec.targets,
    xValue: x,
    timestamp: g.now(),
    triggerContext: { ability: spec, targetSlots: slots, costMemory: costMemory(obj) },
  };
  g.state.stack.push(item);
  wardTriggers(g, item);
  g.touch();
  g.log(`${g.player(p).name} activates ${item.text}`, { kind: 'activate', data: { player: p, objectId: id } });
  g.emit({ name: 'abilityActivated', objectId: id, playerId: p, data: { stackItemId: item.id, abilityText: spec.text, ...(spec.exhaust ? { exhaust: true } : {}) } });
  return true;
}

function filtersMod(): typeof import('./filters.js') {
  return filtersModule;
}
import * as filtersModule from './filters.js';

/** Total mana the player could produce right now from untapped sources (for display). */
export function availableMana(g: Game, p: PlayerId): number {
  let n = 0;
  for (const c of Object.values(g.player(p).manaPool)) n += c;
  for (const s of manaSourcesFor(g, p)) n += Math.max(...s.alternatives.map((a) => a.length));
  return n;
}

/**
 * Ward (CR 702.21a): whenever a permanent with ward becomes the target of a spell or ability an
 * opponent controls, counter it unless that player pays the ward cost. Queued right after the
 * targeting spell or ability is put on the stack, so it resolves first.
 */
export function wardTriggers(g: Game, item: StackItem) {
  const all = ((item.triggerContext?.targetSlots as Target[][] | undefined)?.flat() ?? []).concat(item.targets);
  const seen = new Set<ObjectId>();
  for (const t of all) {
    if (t.kind !== 'object' || seen.has(t.id)) continue;
    seen.add(t.id);
    const o = g.state.objects[t.id];
    if (!o || o.zone !== 'battlefield' || o.controller === item.controller) continue;
    const ward = g.characteristics(o.id).wardCost;
    if (!ward) continue;
    let cost: Extract<Effect, { kind: 'unlessPays' }>['cost'] | null = null;
    const life = ward.match(/^Pay (\d+) life$/i);
    if (/^(?:\{[^}]+\})+$/.test(ward)) cost = ward;
    else if (life) cost = { payLife: parseInt(life[1], 10) };
    else if (/^Discard a card$/i.test(ward)) cost = { discard: 1 };
    else continue;
    g.queueTrigger({
      sourceId: o.id,
      controller: o.controller,
      ability: { kind: 'triggered', text: `Ward — ${ward}`, event: 'becomesTarget', effects: [{ kind: 'unlessPays', who: { ref: 'triggerPlayer' }, cost, effects: [{ kind: 'counterSpell', what: { ref: 'stackTarget' } }] }] },
      context: { triggerPlayer: item.controller, triggerObject: o.id, presetTargets: [{ kind: 'stackItem', id: item.id }] },
    });
  }
}
