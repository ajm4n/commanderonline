/**
 * Casting spells, activating abilities, playing lands, and paying costs.
 */
import type { Game, Gen } from './game.js';
import type { GameObject, ObjectId, PlayerId, PriorityDecision, Response, StackItem, Target, ZoneName, ManaColor, ManaPool } from './types.js';
import { emptyPool } from './types.js';
import type { ActivatedAbilitySpec, AbilityCost, CardScript, TargetSpec, Effect } from './script.js';
import { type ManaCost, type ManaSourceOption, parseManaCost, solvePayment, adjustGeneric, maxX, expandRequirements, parseAddManaText, formatCost } from './mana.js';
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
  if (ch.lostAllAbilities) {
    // Still gets basic-land mana abilities from land types (intrinsic to the type)
  } else {
    script.abilities.forEach((ab, i) => {
      if (ab.kind === 'activated') out.push({ index: i, spec: ab });
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
  // A creature is sick unless controlled continuously since the start of its controller's most recent turn.
  if (g.state.turn.activePlayer !== obj.controller) return obj.controlSinceTurn >= g.state.turn.number;
  return obj.controlSinceTurn >= g.state.turn.number;
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
  return {
    convoke: ch.keywords.has('Convoke') || /^Convoke\b/m.test(text),
    improvise: ch.keywords.has('Improvise') || /^Improvise\b/m.test(text),
    delve: ch.keywords.has('Delve') || /^Delve\b/m.test(text),
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
      if (sol && player.life > 2 * k) {
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
      for (const c of src.alternatives[solution.alternatives[i]]) player.manaPool[c]++;
      g.log(`${player.name} taps ${g.nameOf(src.id)} to help pay (${src.kind}).`);
      continue;
    }
    yield* tapForMana(g, src.id, src.alternatives[solution.alternatives[i]]);
  }
  if (!deductFromPool(player.manaPool, cost, x)) {
    // Should not happen; leave mana in pool for the player to use.
    g.log('Payment mismatch after tapping; mana left in pool.');
    return false;
  }
  g.touch();
  return true;
}

/** Non-mana costs: tap, sacrifice, discard, life, counters... Returns false if unpayable. */
export function* payAbilityCost(g: Game, p: PlayerId, obj: GameObject, cost: AbilityCost, x: number): Gen<boolean> {
  const ctx = { sourceId: obj.id, controller: p, x };
  // Check first
  if (cost.tap && (obj.tapped || (g.characteristics(obj.id).types.includes('Creature') && summoningSick(g, obj)))) return false;
  if (cost.untap && !obj.tapped) return false;
  if (cost.payLife !== undefined && g.player(p).life < cost.payLife) return false;
  if (cost.energy !== undefined && g.player(p).energy < cost.energy) return false;
  if (cost.removeCounters && (obj.counters[cost.removeCounters.counter] ?? 0) < cost.removeCounters.amount) return false;
  if (cost.loyalty !== undefined && cost.loyalty < 0 && (obj.counters['loyalty'] ?? 0) < -cost.loyalty) return false;
  if (cost.sacrifice) {
    const cands = objectsMatching(g, { ...cost.sacrifice.filter, controller: 'you' }, ctx);
    if (cands.length < (cost.sacrifice.count ?? 1)) return false;
  }
  if (cost.discard) {
    const hand = g.player(p).hand;
    if (cost.discard === 'hand') {
      /* ok */
    } else if (hand.filter((id) => !cost.discard || cost.discard === 'hand' || matchesFilter(g, g.obj(id), { ...cost.discard.filter, zone: 'hand' }, ctx)).length < cost.discard.count) return false;
  }
  if (cost.exileFromGraveyard) {
    const cands = g.player(p).graveyard.filter((id) => matchesFilter(g, g.obj(id), { ...cost.exileFromGraveyard!.filter, zone: 'graveyard' }, ctx));
    if (cands.length < cost.exileFromGraveyard.count) return false;
  }
  if (cost.tapUntapped) {
    const cands = objectsMatching(g, { ...cost.tapUntapped.filter, controller: 'you', untapped: true }, ctx);
    if (cands.length < cost.tapUntapped.count) return false;
  }
  if (cost.returnToHand) {
    const cands = objectsMatching(g, { ...cost.returnToHand.filter, controller: 'you' }, ctx);
    if (cands.length < cost.returnToHand.count) return false;
  }
  // Mana (with X)
  if (cost.mana) {
    const parsed = parseManaCost(cost.mana);
    const paid = yield* payCost(g, p, parsed, x, obj.id);
    if (!paid) return false;
  }
  // Pay the rest
  if (cost.tap) g.tap(obj.id);
  if (cost.untap) g.untap(obj.id);
  if (cost.payLife) g.loseLife(p, cost.payLife);
  if (cost.energy) g.player(p).energy -= cost.energy;
  if (cost.removeCounters) g.removeCounters(obj.id, cost.removeCounters.counter, cost.removeCounters.amount);
  if (cost.addCounters) g.addCounters(obj.id, cost.addCounters.counter, cost.addCounters.amount);
  if (cost.loyalty !== undefined) {
    if (cost.loyalty > 0) g.addCounters(obj.id, 'loyalty', cost.loyalty);
    else if (cost.loyalty < 0) g.removeCounters(obj.id, 'loyalty', -cost.loyalty);
  }
  if (cost.sacrifice) {
    const cands = objectsMatching(g, { ...cost.sacrifice.filter, controller: 'you' }, ctx).map((o) => o.id);
    const n = cost.sacrifice.count ?? 1;
    let ids = cands;
    if (cands.length > n) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Sacrifice ${n}`, candidates: cands, min: n, max: n, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: obj.id });
  }
  if (cost.sacrificeSelf) g.moveObject(obj.id, 'graveyard', { cause: 'sacrifice', sourceId: obj.id });
  if (cost.exileSelf) g.moveObject(obj.id, 'exile', { cause: 'exile', sourceId: obj.id });
  if (cost.discardSelf) {
    g.moveObject(obj.id, 'graveyard', { cause: 'discard' });
    g.emit({ name: 'discardBatch', playerId: p, amount: 1, objectId: obj.id });
  }
  if (cost.returnSelf) g.moveObject(obj.id, 'hand', { cause: 'bounce' });
  if (cost.discard) {
    const hand = [...g.player(p).hand];
    if (cost.discard === 'hand') for (const id of hand) g.moveObject(id, 'graveyard', { cause: 'discard' });
    else {
      const cands = hand.filter((id) => !cost.discard || cost.discard === 'hand' || matchesFilter(g, g.obj(id), { ...cost.discard.filter, zone: 'hand' }, ctx));
      let ids = cands;
      if (cands.length > cost.discard.count) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Discard ${cost.discard.count}`, candidates: cands, min: cost.discard.count, max: cost.discard.count, revealToChooser: true, sourceId: obj.id });
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
    if (cands.length > cost.exileFromGraveyard.count) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Exile ${cost.exileFromGraveyard.count} from your graveyard`, candidates: cands, min: cost.exileFromGraveyard.count, max: cost.exileFromGraveyard.count, sourceId: obj.id });
      if (resp.type !== 'objects') return false;
      ids = resp.ids;
    }
    for (const id of ids) g.moveObject(id, 'exile', { cause: 'exile' });
  }
  if (cost.tapUntapped) {
    const cands = objectsMatching(g, { ...cost.tapUntapped.filter, controller: 'you', untapped: true }, ctx).map((o) => o.id);
    let ids = cands.slice(0, cost.tapUntapped.count);
    if (cands.length > cost.tapUntapped.count) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Tap ${cost.tapUntapped.count}`, candidates: cands, min: cost.tapUntapped.count, max: cost.tapUntapped.count, sourceId: obj.id });
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

/** Zones a player may cast the object from right now. */
function castableFrom(g: Game, p: PlayerId, obj: GameObject): boolean {
  if (obj.owner !== p && obj.zone !== 'exile' && obj.zone !== 'graveyard') return false;
  if (obj.zone === 'hand' || obj.zone === 'command') return true;
  if (obj.zone === 'graveyard') return (obj.owner === p && /^Flashback/m.test(obj.card.oracleText)) || obj.memory['castableBy'] === p;
  if (obj.zone === 'exile' && obj.memory['playableBy'] !== p) {
    // "You may play cards you don't own with stash counters on them from exile" style permissions.
    for (const r of g.playerRules(p)) {
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
}

/** The face being cast. */
function faceOf(obj: GameObject, faceIndex: number) {
  if (faceIndex > 0 && obj.card.faces?.[faceIndex]) return obj.card.faces[faceIndex];
  return obj.card;
}

/** Compute the total mana cost to cast, including commander tax and reductions. */
export function computeCastCost(g: Game, p: PlayerId, obj: GameObject, faceIndex: number, opts: { kicker?: boolean; alternative?: string } = {}): ManaCost {
  const face = faceOf(obj, faceIndex);
  let cost: ManaCost;
  const script = g.scriptFor({ ...obj, faceIndex });
  const alt = opts.alternative ? script.alternativeCosts?.find((a) => a.id === opts.alternative) : undefined;
  if (alt) cost = parseManaCost(alt.cost.mana ?? '');
  else if (opts.alternative === 'flashback' && obj.zone === 'graveyard') {
    const fb = obj.card.oracleText.match(/Flashback (\{[^\n]+?\})(?:\s|$)/);
    cost = parseManaCost(fb?.[1] ?? face.manaCost);
  } else cost = parseManaCost(face.manaCost);
  if (obj.isCommander && obj.zone === 'command') cost = adjustGeneric(cost, obj.commanderCasts * 2);
  if (opts.kicker) {
    const k = obj.card.oracleText.match(/Kicker (\{[^\n]+?\})(?:\s|$)/);
    if (k) cost = { symbols: [...cost.symbols, ...parseManaCost(k[1]).symbols], xCount: cost.xCount };
  }
  // Cost reductions / increases from static rules.
  let delta = 0;
  for (const r of g.playerRules(p)) {
    if (r.kind === 'costReduction' && (!r.filter || matchesFilter(g, obj, { ...r.filter, zone: undefined }, { sourceId: null, controller: p }))) delta -= r.amount;
    if (r.kind === 'costIncrease' && (!r.filter || matchesFilter(g, obj, { ...r.filter, zone: undefined }, { sourceId: null, controller: p }))) delta += r.amount;
  }
  // The spell's own cost modifiers (affinity, "costs {1} less for each ...").
  for (const mod of script.costModifiers ?? []) {
    if (mod.condition && !g.checkCondition(mod.condition, { sourceId: obj.id, controller: p })) continue;
    const n = mod.per ? objectsMatching(g, { ...mod.per, zone: mod.per.zone ?? 'battlefield' }, { sourceId: obj.id, controller: p }).length : 1;
    delta += (mod.direction === 'less' ? -1 : 1) * mod.amount * n;
  }
  if (delta !== 0) cost = adjustGeneric(cost, delta);
  return cost;
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

export function canCastNow(g: Game, p: PlayerId, obj: GameObject): boolean {
  if (!castableFrom(g, p, obj)) return false;
  const ch = g.characteristics(obj.id);
  const face = obj.card;
  const isInstant = ch.types.includes('Instant') || ch.keywords.has('Flash') || /\bFlash\b/.test(face.oracleText.split('\n')[0] ?? '');
  const anyFaceInstant = obj.card.faces?.some((f) => /Instant/.test(f.typeLine) || /^Flash\b/m.test(f.oracleText));
  if (ch.types.includes('Land') && !(obj.card.faces?.some((f) => !/Land/.test(f.typeLine)))) return false; // lands are played, not cast
  const sorceryOnly = obj.memory['sorceryOnly'] === true;
  if ((sorceryOnly || (!isInstant && !anyFaceInstant)) && !canCastSorcerySpeed(g, p)) return false;
  // Can we afford it?
  const cost = computeCastCost(g, p, obj, 0);
  const sources = manaSourcesFor(g, p, castingKeywordsOf(g, obj));
  if (!freeFromExile(g, obj) && !solvePayment(cost, 0, g.player(p).manaPool, sources) && availableAlternativeCosts(g, p, obj).length === 0) {
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
  for (const o of g.opponentsOf(p)) zonesToScan.push(...g.player(o).graveyard.filter((id) => g.obj(id).memory['castableBy'] === p), ...g.player(o).exile.filter((id) => Object.values(g.obj(id).counters).some((n) => n > 0)));
  for (const id of zonesToScan) {
    const obj = g.obj(id);
    if (isLandCard(obj) || obj.card.faces?.some((f) => /\bLand\b/.test(f.typeLine))) {
      if (landOk && (obj.zone === 'hand' || obj.zone === 'command' || (obj.zone === 'exile' && castableFrom(g, p, obj)))) {
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
    if (obj.controller !== p) continue;
    if (obj.zone !== 'battlefield' && obj.zone !== 'graveyard' && obj.zone !== 'hand' && obj.zone !== 'command' && obj.zone !== 'exile') continue;
    for (const ab of abilitiesOf(g, obj)) {
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
  if (spec.condition && !g.checkCondition(spec.condition, { sourceId: obj.id, controller: p })) return false;
  if (spec.cost.tap && !canUseTapAbility(g, obj)) return false;
  if (spec.cost.untap && !obj.tapped) return false;
  if (spec.cost.sacrificeSelf && obj.zone !== 'battlefield') return false;
  if (spec.cost.discardSelf && obj.zone !== 'hand') return false;
  if (spec.cost.returnSelf && obj.zone !== 'battlefield') return false;
  if (spec.cost.payLife !== undefined && g.player(p).life < spec.cost.payLife) return false;
  if (spec.cost.removeCounters && (obj.counters[spec.cost.removeCounters.counter] ?? 0) < spec.cost.removeCounters.amount) return false;
  if (spec.cost.sacrifice) {
    if (objectsMatching(g, { ...spec.cost.sacrifice.filter, controller: 'you' }, { sourceId: obj.id, controller: p }).length < (spec.cost.sacrifice.count ?? 1)) return false;
  }
  if (spec.cost.discard && spec.cost.discard !== 'hand' && g.player(p).hand.length < spec.cost.discard.count) return false;
  if (spec.cost.exileFromGraveyard && g.player(p).graveyard.filter((id) => matchesFilter(g, g.obj(id), { ...spec.cost.exileFromGraveyard!.filter, zone: 'graveyard' }, { sourceId: obj.id, controller: p })).length < spec.cost.exileFromGraveyard.count) return false;
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
  let faceIndex = 0;
  if (!isLandCard(obj)) {
    const back = obj.card.faces?.findIndex((f, i) => i > 0 && /\bLand\b/.test(f.typeLine)) ?? -1;
    if (back < 1) return false;
    faceIndex = back;
  }
  if (!(obj.zone === 'hand' || (obj.zone === 'exile' && castableFrom(g, p, obj)) || obj.zone === 'command')) return false;
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
  const isInstantSpeed = /Instant/.test(face.typeLine) || /^Flash\b/m.test(face.oracleText) || ch.keywords.has('Flash');
  if (freeFromExile(g, obj)) opts = { ...opts, free: true };
  if (fromZone === 'exile' && obj.memory['playableBy'] !== p && g.playerRules(p).some((r) => r.kind === 'custom' && r.tag === 'playExiledWithCounter' && (r.data as { anyMana?: boolean } | undefined)?.anyMana)) opts = { ...opts, anyMana: true };
  if ((obj.memory['sorceryOnly'] === true || (!opts.free && !isInstantSpeed)) && !canCastSorcerySpeed(g, p)) return false;
  const keywords = castingKeywordsOf(g, obj);
  const altId = resp.alternativeCost;
  if (altId && !availableAlternativeCosts(g, p, obj).some((a) => a.id === altId)) return false;

  const script = g.scriptFor({ ...obj, faceIndex });
  const player = g.player(p);
  const originalIndex = g.zoneList(obj.owner, fromZone).indexOf(id);

  // 601.2a: move to the stack
  obj.faceIndex = faceIndex;
  g.moveObject(id, 'stack', { controller: p, skipEvents: true });
  obj.castFromZone = fromZone;
  const revert = () => {
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

  // Kicker
  let kicker = false;
  if (!opts.free && /^Kicker /m.test(face.oracleText)) {
    const kcost = face.oracleText.match(/Kicker (\{[^\n]+?\})(?:\s|$)/)?.[1];
    if (kcost) {
      const total = computeCastCost(g, p, obj, faceIndex, { kicker: true });
      if (solvePayment(total, 0, player.manaPool, manaSourcesFor(g, p))) {
        const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Pay the kicker cost ${kcost} for ${face.name}?`, sourceId: id });
        kicker = r.type === 'yesNo' && r.value;
      }
    }
  }
  if (kicker) obj.additionalCostsPaid.push('kicker');

  // X
  let cost = opts.free ? { symbols: [], xCount: 0 } : computeCastCost(g, p, obj, faceIndex, { kicker, alternative: altId ?? (fromZone === 'graveyard' ? 'flashback' : undefined) });
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
  const specs = spellTargets(g, obj, script, faceIndex, modes);
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
  // Mana
  if (obj.memory['anyManaType'] || opts.anyMana) cost = { symbols: cost.symbols.map((sy) => (sy.kind === 'color' || sy.kind === 'hybrid' || sy.kind === 'phyrexian' ? { kind: 'generic' as const, amount: 1 } : sy.kind === 'monoHybrid' ? { kind: 'generic' as const, amount: 2 } : sy)), xCount: cost.xCount };
  if (!opts.free) {
    const paid = yield* payCost(g, p, cost, x, id, keywords, !!resp.manualMana);
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
    modes,
    xValue: x,
    timestamp: g.now(),
    triggerContext: targetSlots ? { targetSlots } : undefined,
  };
  g.state.stack.push(item);
  obj.wasCast = true;
  player.spellsCastThisTurn++;
  if (obj.isCommander && fromZone === 'command') obj.commanderCasts++;
  g.touch();
  const tgt = targets.filter((t) => t.kind !== 'none').map((t) => g.targetName(t));
  g.log(`${player.name} casts ${face.name}${x ? ` (X=${x})` : ''}${tgt.length ? ` targeting ${tgt.join(', ')}` : ''}.`, { kind: 'cast', data: { player: p, objectId: id, targets } });
  g.emit({ name: 'cast', objectId: id, playerId: p, fromZone, data: { targets } });
  return true;
}

/** Choose targets for several specs, returning both grouped and flattened forms. */
export function* chooseTargetsGrouped(g: Game, p: PlayerId, sourceId: ObjectId | null, specs: TargetSpec[], prompt: string, x?: number): Gen<{ flat: Target[]; slots: Target[][] } | null> {
  const { legalTargets } = filtersMod();
  const slots = specs.map((spec) => ({ description: spec.description, legal: legalTargets(g, spec, sourceId, p, x), min: spec.optional ? 0 : (spec.min ?? 1), max: spec.max ?? 1 }));
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
  if (!obj || obj.controller !== p) return false;
  const ab = findAbility(g, obj, abilityIndex);
  if (!ab) return false;
  if ((ab.spec.zone ?? 'battlefield') !== obj.zone) return false;
  if (!canActivate(g, p, obj, ab)) return false;
  const spec = ab.spec;

  // Mana abilities resolve immediately.
  if (spec.manaAbility) {
    const alts = manaFromAbility(g, obj, spec);
    if (alts.length === 1 && !spec.effects.some((e) => e.kind === 'addMana' && (e.mana === 'anyColor' || e.mana === 'anyOneColor' || e.mana === 'commanderColors'))) {
      const ok = yield* payAbilityCost(g, p, obj, spec.cost, 0);
      if (!ok) return false;
      for (const c of alts[0]) g.player(p).manaPool[c]++;
      const extra = spec.effects.filter((e) => e.kind !== 'addMana');
      if (extra.length) yield* executeEffects(g, extra, { sourceId: id, controller: p, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} });
    } else {
      const ok = yield* payAbilityCost(g, p, obj, spec.cost, 0);
      if (!ok) return false;
      yield* executeEffects(g, spec.effects, { sourceId: id, controller: p, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} });
    }
    g.touch();
    g.emit({ name: 'abilityActivated', objectId: id, playerId: p, data: { mana: true } });
    return true;
  }

  // X for abilities with {X} in cost
  let x = resp.xValue ?? 0;
  if (spec.cost.mana && parseManaCost(spec.cost.mana).xCount > 0 && resp.xValue === undefined) {
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
  const ok = yield* payAbilityCost(g, p, obj, spec.cost, x);
  if (!ok) return false;
  if (spec.cost.loyalty !== undefined) g.state.turnStats[`loyalty:${obj.id}`] = 1;
  if (spec.oncePerTurn) g.state.turnStats[`once:${obj.id}:${spec.text}`] = 1;
  const item: StackItem = {
    id: g.state.nextStackId++,
    kind: 'ability',
    sourceId: id,
    controller: p,
    text: `${g.nameOf(id)}: ${spec.text}`,
    abilityRef: String(abilityIndex),
    targets,
    targetStamps: g.stampTargets(targets),
    xValue: x,
    timestamp: g.now(),
    triggerContext: { ability: spec, targetSlots: slots },
  };
  g.state.stack.push(item);
  g.touch();
  g.log(`${g.player(p).name} activates ${item.text}`, { kind: 'activate', data: { player: p, objectId: id } });
  g.emit({ name: 'abilityActivated', objectId: id, playerId: p });
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
