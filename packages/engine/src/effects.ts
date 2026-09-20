/**
 * Effect executor: interprets script Effects against the game.
 */
import type { Game, Gen } from './game.js';
import type { CardData, GameObject, ObjectId, PlayerId, Target, ZoneName, ManaColor, Color, ContinuousEffect } from './types.js';
import { COLORS } from './types.js';
import type { Effect, Ref, TokenSpec, Duration, Amount, AbilitySpec } from './script.js';
import { TOKEN_PRESETS } from './tokens.js';
import { matchesFilter, objectsMatching, legalTargets } from './filters.js';
import { parseManaCost, solvePayment } from './mana.js';
import { manaSourcesFor, payCost, spellTargets, chooseTargetsGrouped, payAbilityCost } from './casting.js';
import { DUNGEONS } from './dungeons.js';

export interface EffectContext {
  sourceId: ObjectId | null;
  controller: PlayerId;
  targets: Target[];
  /** Targets grouped by slot (when specs have multiple targets per slot). */
  targetSlots?: Target[][];
  triggerContext: Record<string, unknown>;
  x: number;
  modes: number[];
  iter?: Target;
  /** Scratch memory for this resolution (lastCreated, chosen objects, ...). */
  memory: Record<string, unknown>;
  stackItemId?: number;
}

function durationOf(d: Duration | undefined): ContinuousEffect['duration'] {
  return d ?? 'endOfTurn';
}

/** Apply clone exceptions ("except it is an enchantment in addition to its other types") to a copied card. */
export function applyCopyExceptions(base: CardData, ex: TokenSpec['exceptions'] | undefined): CardData {
  if (!ex) return base;
  let typeLine = base.typeLine;
  if (ex.notLegendary) typeLine = typeLine.replace(/^Legendary /, '');
  if (ex.legendary && !/^Legendary /.test(typeLine)) typeLine = `Legendary ${typeLine}`;
  if (ex.addTypes?.length) typeLine = `${ex.addTypes.filter((t) => !typeLine.includes(t)).join(' ')} ${typeLine}`.trim();
  if (ex.addSubtypes?.length) typeLine = typeLine.includes(' — ') ? `${typeLine} ${ex.addSubtypes.join(' ')}` : `${typeLine} — ${ex.addSubtypes.join(' ')}`;
  const extraText = [...(ex.keywords ?? []), ...(ex.haste ? ['Haste'] : []), ...(ex.abilities ?? [])];
  const kept = ex.losesAbilities?.length
    ? base.oracleText.split('\n').filter((l) => !ex.losesAbilities!.some((k) => new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(l.trim()))).join('\n')
    : base.oracleText;
  return { ...base, oracleId: `${base.oracleId}:x`, name: ex.name ?? base.name, typeLine, oracleText: extraText.length ? `${kept}\n${extraText.join('\n')}` : kept, power: ex.power ?? base.power, toughness: ex.toughness ?? base.toughness, colors: ex.colors ?? base.colors };
}

/** A face-down permanent's copiable values: a nameless colorless 2/2 creature with no text (CR 708.2). */
const FACE_DOWN_CARD: CardData = { oracleId: 'face-down', scryfallId: 'face-down', layout: 'normal', name: '', manaCost: '', cmc: 0, typeLine: 'Creature', oracleText: '', colors: [], colorIdentity: [], keywords: [], power: '2', toughness: '2' };

/** The values a copy effect copies from `src` (CR 707.2): the printed card or what it already copies, never granted abilities. */
export function copiableCard(src: GameObject): CardData {
  if (src.faceDown) return FACE_DOWN_CARD;
  return src.copyOf ?? src.card;
}

export function tokenCard(spec: TokenSpec, g: Game, ctx: EffectContext): CardData {
  const preset = spec.preset ? TOKEN_PRESETS[spec.preset] : undefined;
  const merged: TokenSpec = { ...(preset ?? {}), ...spec, name: spec.name || preset?.name || 'Token', typeLine: spec.typeLine || preset?.typeLine || 'Creature', colors: spec.colors ?? preset?.colors ?? [] };
  if (spec.copyOf) {
    const src = g.resolveObjects(spec.copyOf, ctx)[0];
    if (src) {
      const base = copiableCard(src);
      const ex = spec.exceptions;
      let typeLine = base.typeLine;
      if (ex?.notLegendary) typeLine = typeLine.replace(/^Legendary /, '');
      if (ex?.legendary && !/^Legendary /.test(typeLine)) typeLine = `Legendary ${typeLine}`;
      if (ex?.addTypes?.length) typeLine = `${ex.addTypes.filter((t) => !typeLine.includes(t)).join(' ')} ${typeLine}`.trim();
      if (ex?.addSubtypes?.length) typeLine = typeLine.includes(' — ') ? `${typeLine} ${ex.addSubtypes.join(' ')}` : `${typeLine} — ${ex.addSubtypes.join(' ')}`;
      const extraLines = [...(ex?.keywords ?? []), ...(ex?.abilities ?? [])];
      const extraText = extraLines.length ? `\n${extraLines.join('\n')}` : '';
      return { ...base, isToken: true, oracleId: `${base.oracleId}${ex ? ':x' : ''}`, name: ex?.name ?? base.name, typeLine, oracleText: `${base.oracleText}${extraText}`, power: ex?.power ?? base.power, toughness: ex?.toughness ?? base.toughness, colors: ex?.colors ?? base.colors, keywords: [...(base.keywords ?? []), ...(ex?.keywords ?? [])] };
    }
  }
  const text = [merged.oracleText, ...(merged.keywords ?? [])].filter(Boolean).join('\n');
  return {
    oracleId: `token:${merged.name}:${merged.typeLine}:${merged.power ?? ''}/${merged.toughness ?? ''}`,
    name: merged.name,
    manaCost: '',
    typeLine: (merged.legendary ? 'Legendary ' : '') + merged.typeLine,
    oracleText: text,
    power: merged.power,
    toughness: merged.toughness,
    loyalty: merged.loyalty,
    colors: merged.colors,
    colorIdentity: merged.colors,
    keywords: merged.keywords ?? [],
    layout: 'token',
    cmc: 0,
    isToken: true,
  };
}

export function* executeEffects(g: Game, effects: Effect[], ctx: EffectContext): Gen {
  for (const e of effects) {
    if (g.state.over) return;
    yield* executeEffect(g, e, ctx);
  }
}

/** Track discards made by the current effect for "that many"/"the greatest number" follow-ups. */
function rememberDiscard(ctx: EffectContext, p: PlayerId, ids: ObjectId[]) {
  ctx.memory[`discarded:${p}`] = ((ctx.memory[`discarded:${p}`] as number) ?? 0) + ids.length;
  ctx.memory['discardedCount'] = ((ctx.memory['discardedCount'] as number) ?? 0) + ids.length;
  ctx.memory['maxDiscarded'] = Math.max((ctx.memory['maxDiscarded'] as number) ?? 0, ids.length);
  ctx.memory['lastDiscarded'] = ids;
}

function playersOf(g: Game, ref: Ref | undefined, ctx: EffectContext): PlayerId[] {
  return ref ? g.resolvePlayers(ref, ctx) : [ctx.controller];
}

export function* executeEffect(g: Game, e: Effect, ctx: EffectContext): Gen {
  const amt = (a: Amount) => g.resolveAmount(a, ctx);
  switch (e.kind) {
    case 'draw':
      for (const p of playersOf(g, e.who, ctx)) g.drawCards(p, g.resolveAmount(e.amount, { ...ctx, iter: { kind: 'player', id: p } }));
      return;
    case 'gainLife':
      for (const p of playersOf(g, e.who, ctx)) g.gainLife(p, amt(e.amount), ctx.sourceId ?? undefined);
      return;
    case 'loseLife': {
      const n = amt(e.amount);
      for (const p of playersOf(g, e.who, ctx)) {
        const before = g.player(p).life;
        g.loseLife(p, n, ctx.sourceId ?? undefined);
        ctx.memory['lifeLostThisWay'] = ((ctx.memory['lifeLostThisWay'] as number) ?? 0) + (before - g.player(p).life);
      }
      return;
    }
    case 'setLife':
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = amt(e.amount);
        if (n > pl.life) g.gainLife(p, n - pl.life);
        else if (n < pl.life) g.loseLife(p, pl.life - n);
      }
      return;
    case 'damage': {
      let targets = g.resolveRef(e.to, ctx);
      const source = e.source ? g.resolveObjects(e.source, ctx)[0]?.id ?? ctx.sourceId : ctx.sourceId;
      // "... to that player or a planeswalker that player controls": the source's controller picks.
      if (e.orPlaneswalker) {
        const picked: Target[] = [];
        for (const t of targets) {
          const pws = t.kind === 'player' ? g.state.battlefield.map((id) => g.state.objects[id]).filter((o) => !!o && o.controller === t.id && g.characteristics(o.id).types.includes('Planeswalker')) : [];
          if (!pws.length) {
            picked.push(t);
            continue;
          }
          const resp = yield* g.ask({
            type: 'chooseOption',
            player: ctx.controller,
            prompt: 'Damage that player, or a planeswalker they control?',
            options: [{ id: 'player', label: 'That player' }, ...pws.map((o) => ({ id: String(o!.id), label: g.characteristics(o!.id).name }))],
            min: 1,
            max: 1,
            sourceId: ctx.sourceId ?? undefined,
          });
          const pick = resp.type === 'options' ? resp.ids[0] : 'player';
          picked.push(pick === 'player' ? t : { kind: 'object', id: Number(pick) });
        }
        targets = picked;
      }
      const total = amt(e.amount);
      if (e.divided && targets.length > 1) {
        const resp = yield* g.ask({ type: 'distribute', player: ctx.controller, prompt: `Divide ${total} damage`, amount: total, targets, minPer: 1, sourceId: ctx.sourceId ?? undefined });
        const amounts = resp.type === 'distribute' ? resp.amounts : targets.map((_, i) => (i === 0 ? total : 0));
        targets.forEach((t, i) => g.dealDamage(source, t, amounts[i], false));
      } else if (e.excessToController) {
        // "Excess damage is dealt to that creature's controller instead."
        for (const t of targets) {
          if (t.kind !== 'object') {
            g.dealDamage(source, t, total, false);
            continue;
          }
          const obj = g.state.objects[t.id];
          const ch = obj ? g.characteristics(obj.id) : null;
          const lethal = ch?.toughness !== null && ch?.toughness !== undefined ? Math.max(0, ch.toughness - (obj?.damage ?? 0)) : total;
          const onCreature = Math.min(total, lethal);
          g.dealDamage(source, t, onCreature, false);
          const excess = total - onCreature;
          if (excess > 0 && obj) g.dealDamage(source, { kind: 'player', id: obj.controller }, excess, false);
        }
      } else for (const t of targets) g.dealDamage(source, t, total, false);
      ctx.memory['lastDamaged'] = [...((ctx.memory['lastDamaged'] as ObjectId[]) ?? []), ...targets.filter((t) => t.kind === 'object').map((t) => (t as { id: ObjectId }).id)];
      return;
    }
    case 'destroy': {
      let destroyed = 0;
      // Everything destroyed by one effect leaves the battlefield simultaneously.
      g.simultaneousZoneChange(() => {
        for (const o of g.resolveObjects(e.what, ctx)) {
          destroyObject(g, o.id, ctx.sourceId, e.cantRegenerate);
          if (g.state.objects[o.id]?.zone !== 'battlefield') destroyed++;
        }
      });
      ctx.memory['destroyedThisWay'] = ((ctx.memory['destroyedThisWay'] as number) ?? 0) + destroyed;
      return;
    }
    case 'exile': {
      const moved: ObjectId[] = [];
      g.simultaneousZoneChange(() => {
        for (const o of g.resolveObjects(e.what, ctx)) {
          const r = g.moveObject(o.id, 'exile', { cause: 'exile', sourceId: ctx.sourceId ?? undefined });
          if (r) moved.push(r.id);
        }
      });
      ctx.memory['lastMoved'] = moved;
      if (e.faceDown) for (const id of moved) { const o = g.state.objects[id]; if (o) o.faceDown = true; }
      if (e.counters) for (const id of moved) g.addCounters(id, e.counters.counter, amt(e.counters.amount), ctx.sourceId ?? undefined);
      if (e.remember && ctx.sourceId !== null) {
        const src = g.state.objects[ctx.sourceId];
        if (src) src.memory[e.remember] = [...((src.memory[e.remember] as ObjectId[]) ?? []), ...moved];
      }
      if (e.untilSourceLeaves && ctx.sourceId !== null && moved.length) {
        const src = g.state.objects[ctx.sourceId];
        if (src) src.memory['exiledUntilLeaves'] = [...((src.memory['exiledUntilLeaves'] as ObjectId[]) ?? []), ...moved];
      }
      return;
    }
    case 'sacrifice':
      g.simultaneousZoneChange(() => {
        for (const o of g.resolveObjects(e.what, ctx)) if (o.zone === 'battlefield') g.moveObject(o.id, 'graveyard', { cause: 'sacrifice', sourceId: ctx.sourceId ?? undefined });
      });
      return;
    case 'sacrificeChoice': {
      // CR 101.4 / 700.4: every player chooses first, then all the sacrifices happen at once.
      const chosen: ObjectId[] = [];
      for (const p of g.resolvePlayers(e.who, ctx)) {
        const n = amt(e.count);
        const cands = objectsMatching(g, { ...e.filter, controller: p }, { sourceId: ctx.sourceId, controller: p, x: ctx.x }).map((o) => o.id);
        const k = Math.min(n, cands.length);
        if (k === 0) continue;
        let ids = cands;
        if (e.upTo) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Sacrifice any number (up to ${k})`, candidates: cands, min: 0, max: k, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : [];
        } else if (cands.length > k) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Sacrifice ${k}`, candidates: cands, min: k, max: k, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : cands.slice(0, k);
        }
        chosen.push(...ids);
      }
      g.simultaneousZoneChange(() => {
        for (const id of chosen) if (g.state.objects[id]?.zone === 'battlefield') g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: ctx.sourceId ?? undefined });
      });
      return;
    }
    case 'exileChoice': {
      const chosen: ObjectId[] = [];
      for (const p of g.resolvePlayers(e.who, ctx)) {
        const n = amt(e.count);
        const cands = objectsMatching(g, { ...e.filter, controller: p }, { sourceId: ctx.sourceId, controller: p, x: ctx.x }).map((o) => o.id);
        const k = Math.min(n, cands.length);
        if (k === 0) continue;
        let ids = cands;
        if (cands.length > k) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Exile ${k}`, candidates: cands, min: k, max: k, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : cands.slice(0, k);
        }
        chosen.push(...ids);
      }
      g.simultaneousZoneChange(() => {
        for (const id of chosen) if (g.state.objects[id]?.zone === 'battlefield') g.moveObject(id, 'exile', { cause: 'exile', sourceId: ctx.sourceId ?? undefined });
      });
      if (chosen.length) ctx.memory['lastMoved'] = chosen;
      return;
    }
    case 'revealRandomFromHand': {
      for (const p of g.resolvePlayers(e.who, ctx)) {
        const pl = g.player(p);
        if (!pl.hand.length) continue;
        const ids = g.rng.shuffle([...pl.hand]).slice(0, Math.min(amt(e.count), pl.hand.length));
        for (const id of ids) g.log(`${pl.name} reveals ${g.nameOf(id)} at random from their hand.`);
        ctx.memory['lastRevealed'] = ids;
        ctx.memory['lastMoved'] = ids;
      }
      return;
    }
    case 'endure': {
      const n = amt(e.amount);
      for (const o of g.resolveObjects(e.on, ctx)) {
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Endure ${n}`, options: [{ id: 'counters', label: `Put ${n} +1/+1 counters on ${g.nameOf(o.id)}` }, { id: 'token', label: `Create a ${n}/${n} white Spirit creature token with flying` }], min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        const pick = r.type === 'options' ? r.ids[0] : 'counters';
        if (pick === 'token') yield* executeEffect(g, { kind: 'createToken', token: { name: 'Spirit', typeLine: 'Creature — Spirit', power: String(n), toughness: String(n), colors: ['W'], keywords: ['Flying'] }, count: 1 }, ctx);
        else yield* executeEffect(g, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'memory', key: '__endure' } }, { ...ctx, memory: { ...ctx.memory, __endure: [o.id] } });
      }
      return;
    }
    case 'topOrBottom': {
      for (const o of g.resolveObjects(e.what, ctx)) {
        const owner = o.owner;
        const topLabel = e.second ? 'Second from the top' : 'Top';
        const r = yield* g.ask({ type: 'chooseOption', player: owner, prompt: `Put ${g.nameOf(o.id)} ${e.second ? 'second from the top' : 'on the top'} or on the bottom of your library?`, options: [{ id: 'top', label: topLabel }, { id: 'bottom', label: 'Bottom' }], min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        const pick = r.type === 'options' ? r.ids[0] : 'top';
        g.moveObject(o.id, 'library', pick === 'bottom' ? { position: 'bottom' } : {});
        if (pick !== 'bottom' && e.second) {
          const lib = g.player(owner).library;
          const i = lib.indexOf(o.id);
          if (i === 0 && lib.length > 1) {
            lib.splice(0, 1);
            lib.splice(1, 0, o.id);
          }
        }
      }
      return;
    }
    case 'removeFromCombat': {
      for (const o of g.resolveObjects(e.what, ctx)) removeFromCombat(g, o);
      g.touch();
      return;
    }
    case 'suspect': {
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (g.characteristics(o.id).rules.some((r) => r.kind === 'custom' && r.tag === 'cantBecomeSuspected')) continue;
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: 'permanent', modification: { layer: 6, addKeywords: ['Menace'] } });
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: 'permanent', modification: { layer: 'rule', rule: { kind: 'cantBlock' } } });
        o.memory['suspected'] = true;
        g.log(`${g.nameOf(o.id)} is suspected.`);
      }
      g.touch();
      return;
    }
    case 'addManaDifferentColors': {
      const n = amt(e.amount);
      const picked: import('./types.js').ManaColor[] = [];
      for (let i = 0; i < n; i++) {
        const opts = (['W', 'U', 'B', 'R', 'G'] as const).filter((c) => !picked.includes(c)).map((c) => ({ id: c, label: `{${c}}` }));
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Add one mana of a color not yet chosen', options: opts, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        const pick = (r.type === 'options' ? r.ids[0] : opts[0].id) as import('./types.js').ManaColor;
        picked.push(pick);
      }
      yield* executeEffect(g, { kind: 'addMana', mana: picked }, ctx);
      return;
    }
    case 'grantAllActivatedAbilities': {
      const texts: string[] = [];
      for (const o of objectsMatching(g, { ...e.from, zone: e.from.zone ?? 'battlefield' }, { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x })) {
        for (const ab of g.scriptFor(o).abilities) if (ab.kind === 'activated') texts.push(ab.text);
      }
      if (!texts.length) return;
      for (const o of g.resolveObjects(e.on, ctx)) {
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: durationOf(e.duration ?? 'permanent'), modification: { layer: 6, addAbilityText: texts } });
      }
      return;
    }
    case 'separatePiles': {
      const ids = g.resolveRef(e.what, ctx).filter((t) => t.kind === 'object').map((t) => (t as { id: ObjectId }).id);
      if (!ids.length) return;
      const by = g.resolvePlayers(e.by, ctx)[0] ?? ctx.controller;
      const resp = yield* g.ask({ type: 'chooseObjects', player: by, prompt: e.faceUpDown ? 'Choose the cards for the face-down pile (the rest go face up)' : 'Choose the cards for the first pile (the rest form the second)', candidates: ids, min: 0, max: ids.length, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
      const first = resp.type === 'objects' ? resp.ids : [];
      ctx.memory['pile0'] = first;
      ctx.memory['pile1'] = ids.filter((id) => !first.includes(id));
      if (!e.faceUpDown) g.log(`${g.player(by).name} separates the cards into two piles.`);
      else g.log(`${g.player(by).name} separates the cards into a face-down pile and a face-up pile.`);
      return;
    }
    case 'choosePile': {
      const p0 = (ctx.memory['pile0'] as ObjectId[] | undefined) ?? [];
      const p1 = (ctx.memory['pile1'] as ObjectId[] | undefined) ?? [];
      const by = g.resolvePlayers(e.by, ctx)[0] ?? ctx.controller;
      const r = yield* g.ask({ type: 'chooseOption', player: by, prompt: 'Choose a pile', options: [{ id: '0', label: `First pile (${p0.length} card${p0.length === 1 ? '' : 's'})` }, { id: '1', label: `Second pile (${p1.length} card${p1.length === 1 ? '' : 's'})` }], min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      const pick = r.type === 'options' && r.ids[0] === '1' ? 1 : 0;
      ctx.memory['chosenPile'] = pick === 0 ? p0 : p1;
      ctx.memory['otherPile'] = pick === 0 ? p1 : p0;
      ctx.memory['lastMoved'] = ctx.memory['chosenPile'];
      g.log(`${g.player(by).name} chooses the ${pick === 0 ? 'first' : 'second'} pile.`);
      return;
    }
    case 'doubleCounters': {
      for (const t of g.resolveRef(e.on, ctx)) {
        if (t.kind === 'object') {
          const o = g.state.objects[t.id];
          if (!o) continue;
          for (const [k, v] of Object.entries(o.counters)) if ((v ?? 0) > 0) o.counters[k] = (v ?? 0) * 2;
        } else if (t.kind === 'player') {
          const pl = g.player(t.id);
          pl.poison *= 2;
          pl.experience *= 2;
          pl.energy *= 2;
        }
      }
      g.touch();
      return;
    }
    case 'payRepeatedly': {
      for (const p of playersOf(g, e.who, ctx)) {
        const cap = e.max ?? 20;
        let times = 0;
        for (let i = 0; i < cap; i++) {
          const ok = yield* offerToPay(g, p, e.cost, e.text ?? `Pay ${e.cost}? (${times} so far)`);
          if (!ok) break;
          times++;
          yield* executeEffects(g, e.effects, { ...ctx, iter: { kind: 'player', id: p } });
        }
        setMemory(g, ctx, 'timesPaid', times);
      }
      return;
    }
    case 'doubleMana': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pool = g.player(p).manaPool;
        for (const k of Object.keys(pool) as (keyof typeof pool)[]) pool[k] *= 2;
      }
      return;
    }
    case 'loseUnspentMana': {
      for (const p of playersOf(g, e.who, ctx)) g.player(p).manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      return;
    }
    case 'chooseNumber': {
      const who = e.who ? playersOf(g, e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      const opts: string[] = [];
      for (let i = e.min; i <= e.max; i++) opts.push(String(i));
      const r = yield* g.ask({ type: 'chooseOption', player: who, prompt: `Choose a number between ${e.min} and ${e.max}`, options: opts.map((o) => ({ id: o, label: o })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      const picked = r.type === 'options' && r.ids[0] !== undefined ? Number(r.ids[0]) : e.min;
      setMemory(g, ctx, e.key ?? 'chosenNumber', picked);
      return;
    }
    case 'chooseOption': {
      const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Choose ${e.options.join(' or ')}`, options: e.options.map((o) => ({ id: o, label: o })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      setMemory(g, ctx, e.key, r.type === 'options' ? r.ids[0] : e.options[0]);
      return;
    }
    case 'handToLibrary': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = Math.min(amt(e.count), pl.hand.length);
        if (n <= 0) continue;
        let ids = pl.hand.slice(0, n);
        if (pl.hand.length > n) {
          const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Put ${n} card(s) from your hand into your library`, candidates: [...pl.hand], min: n, max: n, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          if (r.type === 'objects') ids = r.ids;
        }
        for (const id of ids) g.moveObject(id, 'library', { skipEvents: true, position: e.position });
        if (e.shuffle) g.shuffleLibrary(p);
      }
      return;
    }
    case 'shuffleZoneIntoLibrary': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const ids = e.zone === 'hand' ? [...pl.hand] : e.zone === 'graveyard' ? [...pl.graveyard] : [...pl.exile];
        for (const id of ids) g.moveObject(id, 'library', { skipEvents: true });
        g.shuffleLibrary(p);
        g.log(`${pl.name} shuffles their ${e.zone} into their library.`);
      }
      return;
    }
    case 'millBottom': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = Math.min(amt(e.amount), pl.library.length);
        for (let i = 0; i < n; i++) {
          const id = pl.library[pl.library.length - 1];
          if (id === undefined) break;
          g.moveObject(id, 'graveyard');
        }
      }
      return;
    }
    case 'shuffleHandIntoLibraryAndDraw': {
      for (const p of g.resolvePlayers(e.who, ctx)) {
        const pl = g.player(p);
        const n = pl.hand.length;
        for (const id of [...pl.hand]) g.moveObject(id, 'library', { skipEvents: true, position: e.bottom ? 'bottom' : undefined });
        if (!e.bottom) g.shuffleLibrary(p);
        if (n > 0) g.drawCards(p, n);
      }
      return;
    }
    case 'collectEvidence': {
      const need = g.resolveAmount(e.n, ctx);
      const cands = [...g.player(ctx.controller).graveyard];
      const total = cands.reduce((sum, id) => sum + g.characteristics(id).manaValue, 0);
      if (total < need) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: ctx.controller, prompt: `Collect evidence ${need}: exile cards with total mana value ${need} or more from your graveyard`, candidates: cands, min: 0, max: cands.length, sourceId: ctx.sourceId ?? undefined });
        if (resp.type !== 'objects' || !resp.ids.length) return;
        if (resp.ids.reduce((sum, id) => sum + g.characteristics(id).manaValue, 0) < need) continue;
        for (const id of resp.ids) g.moveObject(id, 'exile', { cause: 'exile' });
        ctx.memory['evidenceCollected'] = true;
        g.emit({ name: 'evidenceCollected', playerId: ctx.controller, sourceId: ctx.sourceId ?? undefined });
        return;
      }
      return;
    }
    case 'timeTravel': {
      const cands = [...g.state.battlefield, ...g.player(ctx.controller).exile].filter((id) => {
        const o = g.state.objects[id];
        return !!o && (o.counters['time'] ?? 0) > 0 && (o.zone === 'battlefield' ? o.controller === ctx.controller : o.owner === ctx.controller);
      });
      for (const id of cands) {
        const resp = yield* g.ask({ type: 'yesNo', player: ctx.controller, prompt: `Remove a time counter from ${g.characteristics(id).name}?`, sourceId: ctx.sourceId ?? undefined });
        if (resp.type === 'yesNo' && resp.value) g.removeCounters(id, 'time', 1);
      }
      return;
    }
    case 'turnFaceDown': {
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (o.zone !== 'battlefield' || o.faceDown) continue;
        o.faceDown = true;
        g.log(`${g.nameOf(o.id)} is turned face down.`);
      }
      g.touch();
      return;
    }
    case 'payEnergy': {
      const have = g.player(ctx.controller).energy;
      const max = Math.min(e.max, have);
      if (max <= 0) {
        ctx.memory[e.key] = 0;
        return;
      }
      const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Pay how much {E}? (up to ${max})`, options: Array.from({ length: max + 1 }, (_, i) => ({ id: String(i), label: String(i) })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      const n = r.type === 'options' ? parseInt(r.ids[0] ?? '0', 10) : 0;
      g.player(ctx.controller).energy -= n;
      ctx.memory[e.key] = n;
      ctx.memory['energyPaid'] = n;
      g.touch();
      return;
    }
    case 'addManaPerColor': {
      const colors = new Set<import('./types.js').ManaColor>();
      for (const o of objectsMatching(g, { ...e.filter, zone: e.filter.zone ?? 'battlefield' }, { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x })) {
        for (const c of g.characteristics(o.id).colors) colors.add(c as import('./types.js').ManaColor);
      }
      if (colors.size) yield* executeEffect(g, { kind: 'addMana', mana: [...colors] }, ctx);
      return;
    }
    case 'loseKeywords': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration ?? 'endOfTurn'), modification: { layer: 6, removeKeywords: e.keywords } });
      return;
    }
    case 'forage': {
      const pl = g.player(ctx.controller);
      const foods = g.state.battlefield.filter((id) => g.obj(id).controller === ctx.controller && g.characteristics(id).subtypes.includes('Food'));
      const canExile = pl.graveyard.length >= 3;
      if (!foods.length && !canExile) return;
      let useFood = foods.length > 0;
      if (foods.length && canExile) {
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Forage', options: [{ id: 'food', label: 'Sacrifice a Food' }, { id: 'exile', label: 'Exile three cards from your graveyard' }], min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        useFood = r.type === 'options' ? r.ids[0] === 'food' : true;
      }
      if (useFood) {
        const pick = foods[0];
        if (foods.length > 1) {
          const r = yield* g.ask({ type: 'chooseObjects', player: ctx.controller, prompt: 'Sacrifice a Food', candidates: foods, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
          if (r.type === 'objects' && r.ids[0] !== undefined) g.moveObject(r.ids[0], 'graveyard', { cause: 'sacrifice' });
          else g.moveObject(pick, 'graveyard', { cause: 'sacrifice' });
        } else g.moveObject(pick, 'graveyard', { cause: 'sacrifice' });
      } else {
        const r = yield* g.ask({ type: 'chooseObjects', player: ctx.controller, prompt: 'Exile three cards from your graveyard', candidates: [...pl.graveyard], min: 3, max: 3, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
        const ids = r.type === 'objects' ? r.ids : pl.graveyard.slice(0, 3);
        for (const id of ids) g.moveObject(id, 'exile', { cause: 'exile' });
      }
      ctx.memory['foraged'] = 1;
      g.emit({ name: 'foraged', playerId: ctx.controller, sourceId: ctx.sourceId ?? undefined });
      return;
    }
    case 'flipUntilLose': {
      let wins = 0;
      for (;;) {
        const won = g.rng.next() < 0.5;
        g.log(`${g.player(ctx.controller).name} flips a coin: ${won ? 'heads (win)' : 'tails (lose)'}.`);
        if (!won) break;
        wins++;
        if (wins > 50) break;
      }
      ctx.memory['flipWins'] = wins;
      ctx.memory['triggerAmount'] = wins;
      return;
    }
    case 'endTurn': {
      g.state.stack.length = 0;
      g.state.turnStats['endTheTurn'] = 1;
      g.log('The turn ends.');
      g.touch();
      return;
    }
    case 'grantReplacement': {
      g.state.turnReplacements = g.state.turnReplacements ?? [];
      for (const p of playersOf(g, e.who, ctx)) g.state.turnReplacements.push({ player: p, spec: e.spec });
      g.touch();
      return;
    }
    case 'grantPlayerRule': {
      g.state.turnRules = g.state.turnRules ?? [];
      for (const p of playersOf(g, e.who, ctx)) g.state.turnRules.push({ player: p, rule: e.rule });
      g.touch();
      return;
    }
    case 'doubleStat': {
      for (const o of g.resolveObjects(e.on, ctx)) {
        const ch = g.characteristics(o.id);
        const dp = e.stat === 'toughness' ? 0 : ch.power ?? 0;
        const dt = e.stat === 'power' ? 0 : ch.toughness ?? 0;
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: durationOf(e.duration ?? 'endOfTurn'), modification: { layer: '7c', power: dp, toughness: dt } });
      }
      return;
    }
    case 'anyPlayerMay': {
      let anyPaid = false;
      for (const p of g.activePlayers()) {
        if (e.cost) {
          const paid = yield* offerToPay(g, p, e.cost, e.prompt ?? `Pay ${e.cost}?`);
          if (paid) anyPaid = true;
          continue;
        }
        const resp = yield* g.ask({ type: 'yesNo', player: p, prompt: e.prompt ?? describe(e.effects), sourceId: ctx.sourceId ?? undefined });
        if (resp.type === 'yesNo' && resp.value) {
          anyPaid = true;
          yield* executeEffects(g, e.effects, { ...ctx, controller: p });
        }
      }
      if (anyPaid && e.then) yield* executeEffects(g, e.then, ctx);
      return;
    }
    case 'anyPlayerMaySacrifice': {
      let any = false;
      for (const p of g.activePlayers()) {
        const cands = objectsMatching(g, { ...e.filter, controller: 'you' }, { sourceId: ctx.sourceId, controller: p, x: ctx.x }).map((o) => o.id);
        if (!cands.length) continue;
        const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Sacrifice one of these? (optional)', candidates: cands, min: 0, max: 1, sourceId: ctx.sourceId ?? undefined });
        const ids = resp.type === 'objects' ? resp.ids : [];
        for (const id of ids) {
          g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: ctx.sourceId ?? undefined });
          any = true;
        }
      }
      if (any && e.then) yield* executeEffects(g, e.then, ctx);
      return;
    }
    case 'returnToHand': {
      const moved: ObjectId[] = [];
      // "Return target spell or creature to its owner's hand": a spell leaves the stack for its owner's hand.
      for (const t of g.resolveRef(e.what, ctx)) {
        if (t.kind !== 'stackItem') continue;
        const item = g.state.stack.find((si) => si.id === t.id);
        if (!item) continue;
        g.state.stack = g.state.stack.filter((si) => si.id !== item.id);
        const src = g.state.objects[item.sourceId];
        if (src && src.zone === 'stack') g.moveObject(src.id, 'hand', { cause: 'bounce', sourceId: ctx.sourceId ?? undefined });
        g.log(`${item.text} is returned to its owner's hand.`);
        g.touch();
      }
      for (const o of g.resolveObjects(e.what, ctx)) {
        const r = g.moveObject(o.id, 'hand', { cause: 'bounce', sourceId: ctx.sourceId ?? undefined });
        if (r) moved.push(r.id);
      }
      ctx.memory['lastMoved'] = moved;
      return;
    }
    case 'putIntoHand': {
      for (const o of g.resolveObjects(e.what, ctx)) g.moveObject(o.id, 'hand', { skipEvents: o.zone === 'library' });
      return;
    }
    case 'putIntoGraveyard': {
      for (const o of g.resolveObjects(e.what, ctx)) g.moveObject(o.id, 'graveyard', {});
      return;
    }
    case 'returnToBattlefield': {
      const moved: ObjectId[] = [];
      for (const o of g.resolveObjects(e.what, ctx)) {
        const controller = e.controller === 'owner' ? o.owner : ctx.controller;
        const counters = e.counters ? { [e.counters.counter]: amt(e.counters.amount) } : undefined;
        const r = yield* enterBattlefield(g, o.id, controller, { tapped: e.tapped || e.attacking, counters, ctx });
        if (r && e.attacking) {
          const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
          const entered = g.state.objects[o.id];
          const atk = src?.attacking ?? g.opponentsOf(controller)[0] ?? null;
          if (entered && entered.zone === 'battlefield' && atk !== null) g.markAttacking(entered, atk);
        }
        if (r) {
          moved.push(r.id);
          if (e.faceDown) r.faceDown = true;
          if (e.transformed && r.card.faces && r.card.faces.length > 1) {
            r.faceIndex = 1;
            g.touch();
          }
          if (e.attachTo) {
            const host = g.resolveObjects(e.attachTo, ctx)[0];
            if (host) attach(g, r.id, host.id);
          }
        }
      }
      ctx.memory['lastMoved'] = moved;
      return;
    }
    case 'putOnLibrary':
      for (const o of g.resolveObjects(e.what, ctx)) {
        let pos: 'top' | 'bottom' | number = e.position === 'bottom' ? 'bottom' : e.position === 'secondFromTop' ? 1 : e.depth !== undefined ? e.depth : 'top';
        if (e.position === 'ownerChoice') {
          const r = yield* g.ask({ type: 'chooseOption', player: o.owner, prompt: `Put ${g.nameOf(o.id)} on the top or bottom of your library?`, options: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }], min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
          pos = r.type === 'options' && r.ids[0] === 'bottom' ? 'bottom' : 'top';
        }
        g.moveObject(o.id, 'library', { position: pos });
        ctx.memory['libraryPlaced'] = [...((ctx.memory['libraryPlaced'] as ObjectId[] | undefined) ?? []), o.id];
      }
      return;
    case 'exert': {
      for (const o of g.resolveObjects(e.what, ctx)) {
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: 'untilNextUntap', modification: { layer: 'rule', rule: { kind: 'cantUntap' } } });
        g.log(`${g.nameOf(o.id)} is exerted.`);
        g.emit({ name: 'exerted', objectId: o.id, playerId: o.controller });
      }
      return;
    }
    case 'copyCard': {
      const created: ObjectId[] = [];
      for (const o of g.resolveObjects(e.what, ctx)) {
        const base = o.copyOf ?? o.card;
        const copy = g.createObject({ ...base, isToken: true, oracleId: `${base.oracleId}:copy` }, ctx.controller, 'exile', { skipEvents: true });
        copy.memory['castableBy'] = ctx.controller;
        copy.memory['playableBy'] = ctx.controller;
        created.push(copy.id);
        g.log(`${g.player(ctx.controller).name} copies ${g.nameOf(o.id)}.`);
      }
      ctx.memory['lastCreated'] = created;
      return;
    }
    case 'setSubtypes': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      let subtypes = e.subtypes ?? [];
      if (e.choose) {
        const options = e.choose === 'basicLandType' ? ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] : g.creatureTypeOptions();
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: e.choose === 'basicLandType' ? 'Choose a basic land type' : 'Choose a creature type', options: options.map((t) => ({ id: t, label: t })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        subtypes = r.type === 'options' && r.ids[0] ? [r.ids[0]] : [options[0]];
      }
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 4, setSubtypes: subtypes } });
      return;
    }
    case 'moveCounters': {
      const from = g.resolveObjects(e.from, ctx)[0];
      const snapshot = (ctx.triggerContext.snapshot as { counters?: Record<string, number> } | undefined)?.counters;
      const counters = from && Object.keys(from.counters).length ? from.counters : snapshot ?? {};
      const to = g.resolveObjects(e.to, ctx)[0];
      if (!to) return;
      if (e.counter) {
        // "Move X +1/+1 counters from ~ onto another target artifact."
        const want = e.amount !== undefined ? amt(e.amount) : counters[e.counter] ?? 0;
        const have = Math.min(want, counters[e.counter] ?? 0);
        if (have <= 0) return;
        if (from) g.removeCounters(from.id, e.counter, have);
        g.addCounters(to.id, e.counter, have, ctx.sourceId ?? undefined);
        return;
      }
      for (const [k, n] of Object.entries(counters)) {
        if (n <= 0) continue;
        if (from) g.removeCounters(from.id, k, n);
        g.addCounters(to.id, k, n, ctx.sourceId ?? undefined);
      }
      return;
    }
    case 'becomeCopy': {
      const src = g.resolveObjects(e.of, ctx)[0];
      if (!src) return;
      for (const o of g.resolveObjects(e.what, ctx)) {
        let ex = e.exceptions;
        if (ex?.thisAbility) {
          const own = g.scriptFor(o).abilities.find((a): a is Extract<AbilitySpec, { kind: 'triggered' | 'activated' }> => (a.kind === 'triggered' || a.kind === 'activated') && /becomes? a copy of/i.test(a.text));
          if (own) ex = { ...ex, keywords: [...(ex.keywords ?? []), own.text] };
        }
        o.copyOf = applyCopyExceptions(copiableCard(src), ex);
        o.faceIndex = 0;
        g.log(`${g.nameOf(o.id)} becomes a copy of ${g.nameOf(src.id)}.`);
      }
      g.touch();
      return;
    }
    case 'moveToZone':
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (e.zone === 'battlefield') yield* enterBattlefield(g, o.id, ctx.controller, { ctx });
        else g.moveObject(o.id, e.zone, { position: e.position });
      }
      return;
    case 'createToken': {
      const n = amt(e.count);
      const created: ObjectId[] = [];
      for (const p of playersOf(g, e.who, ctx)) {
        // Token doubling replacements
        let count = n;
        const alsoTokens: import('./script.js').TokenSpec[] = [];
        const isCreatureToken = /Creature/.test(e.token.typeLine ?? '');
        let tokenSpec = e.token;
        for (const src of g.state.battlefield.map((id) => g.obj(id))) {
          for (const ab of g.scriptFor(src).abilities) {
            if (ab.kind !== 'replacement' || ab.event !== 'tokenCreated') continue;
            const who = ab.who ?? 'you';
            if (who === 'you' && src.controller !== p) continue;
            if (who === 'opponent' && src.controller === p) continue;
            if (ab.creatureOnly && !isCreatureToken) continue;
            count += ab.extra * n;
            if (ab.half) count = ab.half === 'up' ? Math.ceil(count / 2) : Math.floor(count / 2);
            if (ab.alsoToken) alsoTokens.push(ab.alsoToken);
            if (ab.replaceToken) tokenSpec = ab.replaceToken;
          }
        }
        for (const ab of g.turnReplacementsFor(p, 'tokenCreated')) {
          if (ab.creatureOnly && !isCreatureToken) continue;
          count += ab.extra * n;
          if (ab.half) count = ab.half === 'up' ? Math.ceil(count / 2) : Math.floor(count / 2);
          if (ab.alsoToken) alsoTokens.push(ab.alsoToken);
          if (ab.replaceToken) tokenSpec = ab.replaceToken;
        }
        for (let i = 0; i < count; i++) {
          const card = tokenCard(tokenSpec, g, ctx);
          let attacking: PlayerId | ObjectId | undefined;
          if (e.attacking) {
            const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
            const named = e.attackingPlayer ? g.resolvePlayers(e.attackingPlayer, ctx)[0] : undefined;
            attacking = named ?? src?.attacking ?? g.opponentsOf(p)[0];
          }
          const o = g.createObject(card, p, 'battlefield', { tapped: e.tapped, attacking });
          if (ctx.sourceId !== null) o.memory.createdBy = ctx.sourceId;
          if (e.counters) g.addCounters(o.id, e.counters.counter, g.resolveAmount(e.counters.amount, ctx));
          // "except it enters with an additional +1/+1 counter on it"
          const exc = e.token.exceptions?.counters;
          if (exc) g.addCounters(o.id, exc.counter, exc.amount);
          created.push(o.id);
          if (e.attachTo) {
            const host = g.resolveObjects(e.attachTo, ctx)[0];
            if (host) attach(g, o.id, host.id);
            else g.moveObject(o.id, 'graveyard', { skipEvents: true });
          }
        }
        if (count > 0) g.log(`${g.player(p).name} creates ${count} ${card_name(e.token)} token${count === 1 ? '' : 's'}.`, { kind: 'token', data: { player: p, count, name: card_name(e.token) } });
        // "those tokens plus a Clue token are created instead": one extra token of the named kind.
        if (count > 0) {
          for (const extra of alsoTokens) {
            const o = g.createObject(tokenCard(extra, g, ctx), p, 'battlefield', {});
            if (ctx.sourceId !== null) o.memory.createdBy = ctx.sourceId;
            created.push(o.id);
            g.log(`${g.player(p).name} also creates a ${card_name(extra)} token.`);
          }
        }
      }
      ctx.memory['lastCreated'] = created;
      return;
    }
    case 'addCounters':
      if (e.counterOptions?.length) {
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Choose a kind of counter', options: e.counterOptions.map((c) => ({ id: c, label: `${c} counter` })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        const pick = r.type === 'options' && r.ids[0] ? r.ids[0] : e.counterOptions[0];
        yield* executeEffects(g, [{ ...e, counter: pick, counterOptions: undefined }], ctx);
        return;
      }
      if (e.upTo) {
        const max = amt(e.amount);
        if (max <= 0) return;
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Put how many ${e.counter} counters?`, options: Array.from({ length: max + 1 }, (_, i) => ({ id: String(i), label: String(i) })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        const n = r.type === 'options' ? parseInt(r.ids[0] ?? '0', 10) : max;
        if (n > 0) yield* executeEffects(g, [{ ...e, amount: n, upTo: undefined }], ctx);
        return;
      }
      if (e.divided) {
        const objs = g.resolveObjects(e.on, ctx).filter((o) => o.zone === 'battlefield');
        const total = amt(e.amount);
        if (objs.length > 1) {
          const resp = yield* g.ask({ type: 'distribute', player: ctx.controller, prompt: `Distribute ${total} ${e.counter} counters`, amount: total, targets: objs.map((o) => ({ kind: 'object' as const, id: o.id })), minPer: 1, sourceId: ctx.sourceId ?? undefined });
          const amounts = resp.type === 'distribute' ? resp.amounts : objs.map((_, i) => (i === 0 ? total : 0));
          objs.forEach((o, i) => g.addCounters(o.id, e.counter, amounts[i], ctx.sourceId ?? undefined));
        } else for (const o of objs) g.addCounters(o.id, e.counter, total, ctx.sourceId ?? undefined);
        return;
      }
      for (const o of g.resolveObjects(e.on, ctx)) if (o.zone === 'battlefield' || o.zone === 'stack') g.addCounters(o.id, e.counter, amt(e.amount), ctx.sourceId ?? undefined);
      // Player counters (poison / experience)
      for (const t of g.resolveRef(e.on, ctx)) {
        if (t.kind !== 'player') continue;
        const pl = g.player(t.id);
        if (e.counter === 'poison') pl.poison += amt(e.amount);
        else if (e.counter === 'experience') pl.experience += amt(e.amount);
        else if (e.counter === 'energy') {
          let en = amt(e.amount);
          for (const r of g.playerRules(t.id)) {
            if (r.kind === 'custom' && r.tag === 'energyMultiplier' && typeof r.data === 'number') en *= r.data;
          }
          pl.energy += en;
          g.emit({ name: 'gotEnergy', playerId: t.id, amount: en, sourceId: ctx.sourceId ?? undefined });
        } else pl.turnStats[e.counter] = (pl.turnStats[e.counter] ?? 0) + amt(e.amount);
        g.touch();
      }
      return;
    case 'removeCounters': {
      for (const o of g.resolveObjects(e.on, ctx)) {
        const have = e.counter === 'any' ? Object.values(o.counters).reduce((a, b) => a + (b ?? 0), 0) : o.counters[e.counter] ?? 0;
        let want = e.amount === 'all' ? have : Math.min(amt(e.amount), have);
        if (e.upTo && want > 0) {
          const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Remove how many counters from ${g.nameOf(o.id)}?`, options: Array.from({ length: want + 1 }, (_, i) => ({ id: String(i), label: String(i) })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
          want = r.type === 'options' ? parseInt(r.ids[0] ?? '0', 10) : want;
        }
        if (want <= 0) continue;
        ctx.memory['countersRemovedThisWay'] = ((ctx.memory['countersRemovedThisWay'] as number) ?? 0) + want;
        if (e.counter !== 'any') {
          g.removeCounters(o.id, e.counter, want);
          continue;
        }
        // "Remove a counter": the controller picks which kinds come off.
        for (const [kind, n] of Object.entries(o.counters)) {
          if (want <= 0) break;
          const take = Math.min(want, n ?? 0);
          if (take > 0) {
            g.removeCounters(o.id, kind, take);
            want -= take;
          }
        }
      }
      return;
    }
    case 'pump': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: '7c', power: amt(e.power), toughness: amt(e.toughness) } });
      return;
    }
    case 'setPT': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: '7b', ...(e.power !== undefined ? { setPower: amt(e.power) } : {}), ...(e.toughness !== undefined ? { setToughness: amt(e.toughness) } : {}) } });
      return;
    }
    case 'exchangeLifeWith': {
      const o = g.resolveObjects(e.what, ctx)[0];
      if (!o) return;
      const p = e.who ? (g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller) : ctx.controller;
      const ch = g.characteristics(o.id);
      const stat = (e.stat === 'power' ? ch.power : ch.toughness) ?? 0;
      const life = g.player(p).life;
      if (stat > life) g.gainLife(p, stat - life);
      else if (stat < life) g.loseLife(p, life - stat);
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: 'permanent', modification: { layer: '7b', ...(e.stat === 'power' ? { setPower: life } : { setToughness: life }) } });
      g.log(`${g.player(p).name} exchanges life total with ${g.nameOf(o.id)}.`);
      return;
    }
    case 'exchangeZones': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const get = (z: import('./types.js').ZoneName): ObjectId[] => (z === 'hand' ? pl.hand : z === 'graveyard' ? pl.graveyard : pl.library);
        const a = [...get(e.a)];
        const b = [...get(e.b)];
        for (const id of a) g.moveObject(id, e.b, { skipEvents: true });
        for (const id of b) g.moveObject(id, e.a, { skipEvents: true });
        if (e.shuffle || e.a === 'library' || e.b === 'library') g.shuffleLibrary(p);
        g.log(`${pl.name} exchanges their ${e.a} and ${e.b}.`);
      }
      return;
    }
    case 'becomeBlocked': {
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (o.attacking === null || o.wasBlocked) continue;
        o.wasBlocked = true;
        g.log(`${g.characteristics(o.id).name} becomes blocked.`);
        g.emit({ name: 'becomesBlocked', objectId: o.id, sourceId: ctx.sourceId ?? undefined });
      }
      return;
    }
    case 'grantKeywords': {
      if (e.choose !== undefined && e.keywords.length > e.choose) {
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Choose ${e.choose}`, options: e.keywords.map((k) => ({ id: k, label: k })), min: e.choose, max: e.choose, sourceId: ctx.sourceId ?? undefined });
        const picks = r.type === 'options' && r.ids.length ? r.ids : e.keywords.slice(0, e.choose);
        yield* executeEffect(g, { ...e, keywords: picks, choose: undefined }, ctx);
        return;
      }
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 6, addKeywords: e.keywords } });
      return;
    }
    case 'removeKeywords': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 6, removeKeywords: e.keywords } });
      return;
    }
    case 'loseAllAbilities': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 6, loseAllAbilities: true } });
      return;
    }
    case 'addTypes': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 4, addTypes: e.types, addSubtypes: e.subtypes, setTypes: e.setTypes, setSubtypes: e.setSubtypes, addSupertypes: e.addSupertypes, removeSupertypes: e.removeSupertypes } });
      return;
    }
    case 'setColors': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      let colors = e.colors;
      if (e.chosenKey) {
        const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
        const pick = (src?.chosen?.[e.chosenKey] ?? ctx.memory[e.chosenKey]) as string | undefined;
        if (pick) colors = [pick] as typeof e.colors;
      }
      if (e.chooseColors) {
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Choose one or more colors', options: (['W', 'U', 'B', 'R', 'G'] as const).map((c) => ({ id: c, label: c })), min: 1, max: 5, sourceId: ctx.sourceId ?? undefined });
        if (r.type === 'options' && r.ids.length) colors = r.ids as typeof e.colors;
      }
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: e.add ? { layer: 5, addColors: colors } : { layer: 5, setColors: colors } });
      return;
    }
    case 'applyRule': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      // Rules that refer back to the effect's source ("can't block ~ this turn") carry its id.
      const rule = e.rule.kind === 'custom' && e.rule.data === '__self__' ? { ...e.rule, data: ctx.sourceId } : e.rule;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 'rule', rule } });
      return;
    }
    case 'tap':
      for (const o of g.resolveObjects(e.what, ctx)) g.tap(o.id);
      return;
    case 'untap':
      for (const o of g.resolveObjects(e.what, ctx)) g.untap(o.id);
      return;
    case 'scry':
      for (const p of playersOf(g, e.who, ctx)) {
        let n = amt(e.amount);
        let toDraw = false;
        // "If you would scry a number of cards, draw that many cards instead."
        for (const r of g.playerRules(p)) {
          if (r.kind !== 'custom' || r.tag !== 'scryReplace') continue;
          const d = r.data as { plus?: number; toDraw?: boolean } | undefined;
          if (d?.toDraw) toDraw = true;
          if (d?.plus) n += d.plus;
        }
        if (toDraw) g.drawCards(p, n);
        else yield* scry(g, p, n);
      }
      return;
    case 'surveil':
      for (const p of playersOf(g, e.who, ctx)) {
        yield* surveil(g, p, amt(e.amount));
        g.emit({ name: 'surveil', playerId: p, amount: amt(e.amount) });
      }
      return;
    case 'mill':
      for (const p of playersOf(g, e.who, ctx)) {
        let n = amt(e.amount);
        // "If an opponent would mill one or more cards, they mill twice that many cards instead."
        if (n > 0) {
          for (const ab of g.turnReplacementsFor(p, 'mill')) {
            if (ab.multiply !== undefined) n *= ab.multiply;
            if (ab.add) n += ab.add;
          }
          for (const src of g.state.battlefield.map((id) => g.obj(id))) {
            for (const ab of g.scriptFor(src).abilities) {
              if (ab.kind !== 'replacement' || ab.event !== 'mill') continue;
              const applies = ab.who === 'any' || (ab.who === 'you' && src.controller === p) || (ab.who === 'opponent' && src.controller !== p);
              if (!applies) continue;
              if (ab.multiply !== undefined) n *= ab.multiply;
              if (ab.add) n += ab.add;
            }
          }
        }
        const milled: ObjectId[] = [];
        for (let i = 0; i < n; i++) {
          const id = g.player(p).library[0];
          if (id === undefined) break;
          const r = g.moveObject(id, 'graveyard', { cause: 'mill' });
          if (r) milled.push(r.id);
        }
        ctx.memory['lastMoved'] = milled;
        if (milled.length) g.log(`${g.player(p).name} mills ${milled.length}.`);
      }
      return;
    case 'discard':
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        if (e.amount === 'hand') {
          let all = e.filter ? pl.hand.filter((id) => matchesFilter(g, g.obj(id), { ...e.filter, zone: 'hand' }, { sourceId: ctx.sourceId, controller: ctx.controller })) : [...pl.hand];
          if (e.except) {
            const keep = new Set(g.resolveRef(e.except, ctx).filter((t) => t.kind === 'object').map((t) => t.id));
            all = all.filter((id) => !keep.has(id));
          }
          for (const id of all) g.moveObject(id, 'graveyard', { cause: 'discard' });
          if (all.length) g.emit({ name: 'discardBatch', playerId: p, amount: all.length, objectId: all[0] });
          rememberDiscard(ctx, p, all);
          continue;
        }
        const n = Math.min(amt(e.amount), pl.hand.length);
        if (n === 0) continue;
        let ids: ObjectId[];
        if (e.random) ids = g.rng.shuffle([...pl.hand]).slice(0, n);
        else if (e.upTo) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Discard any number of cards (up to ${n})`, candidates: [...pl.hand], min: 0, max: n, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : [];
        } else if (n >= pl.hand.length) ids = [...pl.hand];
        else {
          const chooser = e.chooser === 'controller' ? ctx.controller : p;
          const resp = yield* g.ask({ type: 'chooseObjects', player: chooser, prompt: `Discard ${n}`, candidates: [...pl.hand], min: n, max: n, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : pl.hand.slice(0, n);
        }
        for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'discard' });
        if (ids.length) g.emit({ name: 'discardBatch', playerId: p, amount: ids.length, objectId: ids[0] });
        rememberDiscard(ctx, p, ids);
      }
      return;
    case 'discardObjects': {
      const byOwner = new Map<PlayerId, ObjectId[]>();
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (o.zone !== 'hand') continue;
        g.moveObject(o.id, 'graveyard', { cause: 'discard' });
        byOwner.set(o.owner, [...(byOwner.get(o.owner) ?? []), o.id]);
      }
      for (const [p, ids] of byOwner) g.emit({ name: 'discardBatch', playerId: p, amount: ids.length, objectId: ids[0] });
      return;
    }
    case 'addMana': {
      let n = e.amount !== undefined ? amt(e.amount) : 1;
      // "If you tap a permanent for mana, it produces twice as much of that mana instead."
      let manaOverride: ManaColor[] | 'anyOneColor' | null = null;
      {
        const msrc = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
        if (msrc && msrc.zone === 'battlefield') {
          for (const r of g.playerRules(msrc.controller)) {
            if (r.kind !== 'custom') continue;
            if (r.tag === 'manaMultiplier') {
              const d = r.data as { times?: number; filter?: import('./types.js').ObjectFilter } | undefined;
              if (!d) continue;
              if (d.filter && !matchesFilter(g, msrc, { ...d.filter, zone: undefined }, { sourceId: ctx.sourceId, controller: msrc.controller })) continue;
              n *= d.times ?? 1;
            } else if (r.tag === 'manaTypeReplace') {
              // "If a land is tapped for mana, it produces {B} instead of any other type."
              const d = r.data as { filter?: import('./types.js').ObjectFilter; produce?: string[] | 'anyOneColor'; fixedAmount?: number } | undefined;
              if (!d?.produce) continue;
              if (d.filter && !matchesFilter(g, msrc, { ...d.filter, zone: undefined }, { sourceId: ctx.sourceId, controller: msrc.controller })) continue;
              manaOverride = d.produce === 'anyOneColor' ? 'anyOneColor' : (d.produce as ManaColor[]);
              if (d.fixedAmount !== undefined) n = d.fixedAmount;
            }
          }
        }
      }
      const manaKind: typeof e.mana = manaOverride !== null ? manaOverride : e.mana;
      for (const p of playersOf(g, e.who, ctx)) {
        const pool = g.player(p).manaPool;
        if (manaKind === 'chosenColor') {
          const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
          const c = (src?.memory['color'] ?? src?.chosen['color'] ?? 'W') as ManaColor;
          pool[c] += n;
          g.touch();
          continue;
        }
        if (manaKind === 'triggerMana') {
          const produced = ((ctx.triggerContext['triggerData'] as { mana?: ManaColor[] } | undefined)?.mana ?? []) as ManaColor[];
          for (let k = 0; k < n; k++) for (const c of produced) pool[c]++;
          g.touch();
          continue;
        }
        if (manaKind === 'anyColor' || manaKind === 'anyOneColor' || manaKind === 'commanderColors') {
          const opts = manaKind === 'commanderColors' ? g.colorsOfCommander(p) : COLORS;
          const choices = (opts.length ? opts : COLORS).map((c) => ({ id: c, label: c }));
          let color: ManaColor = choices[0].id as ManaColor;
          if (choices.length > 1) {
            const resp = yield* g.ask({ type: 'chooseOption', player: p, prompt: `Choose a color of mana${n > 1 ? ` (×${n})` : ''}`, options: choices, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
            if (resp.type === 'options') color = resp.ids[0] as ManaColor;
          }
          pool[color] += n;
        } else {
          for (let i = 0; i < n; i++) for (const c of manaKind) pool[c]++;
        }
        g.touch();
      }
      return;
    }
    case 'counterSpell': {
      for (const t of g.resolveRef(e.what, ctx)) {
        if (t.kind !== 'stackItem') continue;
        const item = g.state.stack.find((s) => s.id === t.id);
        if (!item) continue;
        const spellObj = g.state.objects[item.sourceId];
        if (item.kind === 'spell' && g.playerRules(item.controller).some((r) => r.kind === 'custom' && r.tag === 'spellsCantBeCountered')) {
          g.log(`${item.text} can't be countered.`);
          continue;
        }
        if (item.kind === 'spell' && spellObj && g.scriptFor(spellObj).abilities.some((a) => a.kind === 'static' && a.rule?.kind === 'custom' && a.rule.tag === 'cantBeCountered')) {
          g.log(`${item.text} can't be countered.`);
          continue;
        }
        if (e.unlessPays) {
          const paid = yield* offerToPay(g, item.controller, e.unlessPays, `Pay ${e.unlessPays} to prevent ${item.text} from being countered?`);
          if (paid) continue;
        }
        counterStackItem(g, item.id, e.exileInstead ? 'exile' : (e.to ?? 'graveyard'));
      }
      return;
    }
    case 'searchLibrary': {
      // "Players can't search libraries."
      if (g.playerRules(ctx.controller).some((r) => r.kind === 'custom' && r.tag === 'noSearch')) return;
      ctx.memory['searched'] = 1;
      for (const sp of playersOf(g, e.who, ctx)) g.emit({ name: 'searchedLibrary', playerId: sp, sourceId: ctx.sourceId ?? undefined });
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = amt(e.count);
        const pool = e.zones ? e.zones.flatMap((z) => (z === 'graveyard' ? pl.graveyard : z === 'hand' ? pl.hand : pl.library)) : pl.library;
        const cands = pool.filter((id) => matchesFilter(g, g.obj(id), { ...e.filter, zone: e.zones ?? 'library' }, { sourceId: ctx.sourceId, controller: p, x: ctx.x }));
        let ids: ObjectId[] = [];
        if (cands.length > 0 && e.random) {
          ids = g.rng.shuffle([...cands]).slice(0, Math.min(n, cands.length));
        } else if (cands.length > 0) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Search your library: choose up to ${n}${e.filter.differentNames ? ' with different names' : ''}`, candidates: cands, min: 0, max: Math.min(n, cands.length), revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : [];
          if (e.filter.differentNames) {
            const seen = new Set<string>();
            ids = ids.filter((id) => {
              const nm = g.characteristics(id).name;
              if (seen.has(nm)) return false;
              seen.add(nm);
              return true;
            });
          }
        }
        if (e.destination === 'hold') {
          ctx.memory[e.key ?? 'searchedCards'] = ids;
          ctx.memory['lastMoved'] = ids;
          if (e.reveal) for (const id of ids) g.log(`${pl.name} reveals ${g.nameOf(id)}.`);
          if (e.shuffle) g.shuffleLibrary(p);
          continue;
        }
        const moved: ObjectId[] = [];
        for (const id of ids) {
          if (e.destination === 'battlefield') {
            const r = yield* enterBattlefield(g, id, p, { tapped: e.tapped, ctx });
            if (r) moved.push(r.id);
          } else if (e.destination === 'top') {
            // stays; moved to top after shuffle
            moved.push(id);
          } else {
            const r = g.moveObject(id, e.destination, { skipEvents: e.destination === 'hand' });
            if (r) moved.push(r.id);
          }
          if (e.reveal) g.log(`${pl.name} reveals ${g.nameOf(id)}.`);
        }
        if (e.shuffle !== false) g.shuffleLibrary(p);
        if (e.destination === 'top') for (const id of moved.reverse()) g.moveObject(id, 'library', { position: 'top', skipEvents: true });
        ctx.memory['lastMoved'] = moved;
      }
      return;
    }
    case 'shuffle':
      for (const p of playersOf(g, e.who, ctx)) g.shuffleLibrary(p);
      return;
    case 'gainControl': {
      const who = e.who ? g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      const ids = g.resolveObjects(e.what, ctx).map((o) => o.id);
      if (!ids.length) return;
      const dur = e.duration ?? 'permanent';
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: dur, modification: { layer: 'control', controller: who } });
      for (const id of ids) {
        const o = g.obj(id);
        const prev = o.controller;
        o.controller = who;
        if (dur === 'permanent') o.baseController = who;
        o.controlSinceTurn = g.state.turn.number;
        g.emit({ name: 'controlChanged', objectId: id, playerId: who, otherPlayerId: prev });
      }
      g.touch();
      return;
    }
    case 'exchangeControl': {
      const a = g.resolveObjects(e.a, ctx)[0];
      const b = g.resolveObjects(e.b, ctx)[0];
      if (!a || !b) return;
      const ca = a.controller;
      const cb = b.controller;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [a.id] }, duration: 'permanent', modification: { layer: 'control', controller: cb } });
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [b.id] }, duration: 'permanent', modification: { layer: 'control', controller: ca } });
      a.controller = cb;
      b.controller = ca;
      a.baseController = cb;
      b.baseController = ca;
      g.touch();
      return;
    }
    case 'copySpell': {
      const n = e.count !== undefined ? amt(e.count) : 1;
      for (const t of g.resolveRef(e.what, ctx)) {
        if (t.kind !== 'stackItem') continue;
        const item = g.state.stack.find((s) => s.id === t.id);
        if (!item) continue;
        const srcCard = g.state.objects[item.sourceId];
        if (srcCard && g.characteristics(srcCard.id).rules.some((r) => r.kind === 'custom' && r.tag === 'cantBeCopied')) {
          g.log(`${item.text} can't be copied.`);
          continue;
        }
        for (let i = 0; i < n; i++) {
          const copy = { ...item, id: g.state.nextStackId++, controller: ctx.controller, timestamp: g.now(), text: `${item.text} (copy)`, copiedCard: g.state.objects[item.sourceId]?.card, targets: [...item.targets], targetStamps: item.targetStamps ? [...item.targetStamps] : undefined };
          // Rule 707.10c: the copy's controller may choose new targets.
          const srcObj = g.state.objects[item.sourceId];
          if (srcObj && item.targets.some((t) => t.kind !== 'none')) {
            const specs = spellTargets(g, srcObj, g.scriptFor(srcObj), srcObj.faceIndex, item.modes ?? []);
            if (specs.length) {
              const r = yield* g.ask({ type: 'yesNo', player: ctx.controller, prompt: `Choose new targets for the copy of ${item.text}?`, yesLabel: 'New targets', noLabel: 'Keep targets', sourceId: ctx.sourceId ?? undefined });
              if (r.type === 'yesNo' && r.value) {
                const chosen = yield* chooseTargetsGrouped(g, ctx.controller, item.sourceId, specs, `New targets for the copy of ${item.text}`, item.xValue);
                if (chosen) {
                  copy.targets = chosen.flat;
                  copy.targetStamps = g.stampTargets(chosen.flat);
                  copy.triggerContext = { ...(copy.triggerContext ?? {}), targetSlots: chosen.slots };
                }
              }
            }
          }
          g.state.stack.push(copy);
        }
        g.log(`${g.player(ctx.controller).name} copies ${item.text}.`);
        g.emit({ name: 'spellCopied', playerId: ctx.controller, sourceId: item.sourceId });
      }
      g.touch();
      return;
    }
    case 'fight': {
      const a = g.resolveObjects(e.a, ctx)[0];
      const b = g.resolveObjects(e.b, ctx)[0];
      if (!a || !b || a.zone !== 'battlefield' || b.zone !== 'battlefield') return;
      const cha = g.characteristics(a.id);
      const chb = g.characteristics(b.id);
      const pa = (e.useToughness ? cha.toughness : cha.power) ?? 0;
      const pb = (e.useToughness ? chb.toughness : chb.power) ?? 0;
      g.dealDamage(a.id, { kind: 'object', id: b.id }, pa, false);
      g.dealDamage(b.id, { kind: 'object', id: a.id }, pb, false);
      g.emit({ name: 'fights', objectId: a.id, sourceId: b.id, playerId: a.controller });
      g.emit({ name: 'fights', objectId: b.id, sourceId: a.id, playerId: b.controller });
      return;
    }
    case 'bite':
    case 'dealsDamageEqualToPower': {
      const a = g.resolveObjects(e.kind === 'bite' ? e.a : e.source, ctx)[0];
      const targets = g.resolveRef(e.kind === 'bite' ? e.b : e.to, ctx);
      if (!a) return;
      const pa = g.characteristics(a.id).power ?? 0;
      for (const t of targets) g.dealDamage(a.id, t, pa, false);
      return;
    }
    case 'unattach': {
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (o.attachedTo === null) continue;
        const host = g.state.objects[o.attachedTo];
        if (host) host.attachments = host.attachments.filter((id) => id !== o.id);
        o.attachedTo = null;
        g.emit({ name: 'becomesUnattached', objectId: o.id, playerId: o.controller });
        // Drop any continuous type change this object gave itself (the Licid Aura effect).
        g.state.continuousEffects = g.state.continuousEffects.filter((ce) => !(ce.sourceId === o.id && ce.affected.kind === 'fixed' && ce.affected.ids.includes(o.id) && ce.modification.layer === 4));
        g.touch();
      }
      return;
    }
    case 'attach': {
      const what = g.resolveObjects(e.what, ctx)[0];
      const to = g.resolveObjects(e.to, ctx)[0];
      if (!what || !to || what.zone !== 'battlefield' || to.zone !== 'battlefield') return;
      attach(g, what.id, to.id);
      return;
    }
    case 'transform':
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (!o.card.faces || o.card.faces.length < 2) continue;
        if (g.characteristics(o.id).rules.some((r) => r.kind === 'custom' && r.tag === 'cantTransform')) continue;
        o.faceIndex = o.faceIndex === 0 ? 1 : 0;
        g.touch();
        g.emit({ name: 'transformed', objectId: o.id, playerId: o.controller });
        g.log(`${g.nameOf(o.id)} transforms.`);
      }
      return;
    case 'flipCoin': {
      const win = g.rng.coin();
      g.log(`${g.player(ctx.controller).name} flips a coin and ${win ? 'wins' : 'loses'}.`);
      ctx.memory['flipWon'] = win ? 1 : 0;
      ctx.memory['flipsWon'] = ((ctx.memory['flipsWon'] as number) ?? 0) + (win ? 1 : 0);
      ctx.memory['flipsLost'] = ((ctx.memory['flipsLost'] as number) ?? 0) + (win ? 0 : 1);
      g.emit({ name: 'coinFlipped', playerId: ctx.controller, data: { won: win } });
      yield* executeEffects(g, win ? e.win : e.lose ?? [], ctx);
      return;
    }
    case 'rollDie': {
      let roll = 1 + g.rng.int(e.sides);
      // "If you would roll one or more dice, instead roll that many dice plus one and ignore the lowest roll."
      for (const r of g.playerRules(ctx.controller)) {
        if (r.kind !== 'custom' || r.tag !== 'extraDice') continue;
        const d = r.data as { plus?: number; ignore?: 'lowest' | 'highest' } | undefined;
        const extra = d?.plus ?? 1;
        const rolls = [roll, ...Array.from({ length: extra }, () => 1 + g.rng.int(e.sides))].sort((a, b) => a - b);
        roll = d?.ignore === 'highest' ? rolls[0] : rolls[rolls.length - 1];
        g.log(`Rolled ${rolls.join(', ')}; keeping ${roll}.`);
      }
      g.log(`${g.player(ctx.controller).name} rolls a d${e.sides}: ${roll}.`);
      ctx.memory['lastRoll'] = roll;
      g.emit({ name: 'rolledDie', playerId: ctx.controller, amount: roll, sourceId: ctx.sourceId ?? undefined });
      const r = e.results.find((x) => roll >= x.min && roll <= x.max);
      if (r) yield* executeEffects(g, r.effects, ctx);
      return;
    }
    case 'extraTurn':
      for (const p of playersOf(g, e.who, ctx)) {
        g.state.turn.extraTurns.unshift(p);
        g.log(`${g.player(p).name} takes an extra turn after this one.`);
      }
      return;
    case 'extraCombat':
      g.state.turnStats['extraCombat'] = 1;
      // Untap creatures that attacked for a true additional combat handled by scripts (e.g. Aggravated Assault untaps all).
      return;
    case 'winGame':
      for (const p of playersOf(g, e.who, ctx)) for (const o of g.opponentsOf(p)) g.playerLoses(o, `${g.player(p).name} won the game`);
      return;
    case 'loseGame':
      for (const p of playersOf(g, e.who, ctx)) g.playerLoses(p, 'effect');
      return;
    case 'proliferate': {
      g.emit({ name: 'proliferated', playerId: ctx.controller, sourceId: ctx.sourceId ?? undefined });
      const cands: Target[] = [];
      for (const id of g.state.battlefield) if (Object.keys(g.obj(id).counters).length) cands.push({ kind: 'object', id });
      for (const p of g.activePlayers()) if (g.player(p).poison > 0 || g.player(p).experience > 0) cands.push({ kind: 'player', id: p });
      if (!cands.length) return;
      const objCands = cands.filter((c) => c.kind === 'object').map((c) => (c as { id: ObjectId }).id);
      const resp = yield* g.ask({ type: 'chooseObjects', player: ctx.controller, prompt: 'Proliferate: choose any number of permanents with counters', candidates: objCands, min: 0, max: objCands.length, sourceId: ctx.sourceId ?? undefined });
      const chosen = resp.type === 'objects' ? resp.ids : [];
      for (const id of chosen) for (const k of Object.keys(g.obj(id).counters)) g.addCounters(id, k, 1);
      for (const p of g.activePlayers()) {
        if (g.player(p).poison > 0 && p !== ctx.controller) {
          const r = yield* g.ask({ type: 'yesNo', player: ctx.controller, prompt: `Proliferate: add a poison counter to ${g.player(p).name}?` });
          if (r.type === 'yesNo' && r.value) g.player(p).poison++;
        }
      }
      return;
    }
    case 'populate': {
      const tokens = g.state.battlefield.filter((id) => g.obj(id).controller === ctx.controller && g.obj(id).card.isToken && g.characteristics(id).types.includes('Creature'));
      if (!tokens.length) return;
      let pick = tokens[0];
      if (tokens.length > 1) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: ctx.controller, prompt: 'Populate: choose a creature token to copy', candidates: tokens, min: 1, max: 1 });
        if (resp.type === 'objects') pick = resp.ids[0];
      }
      const src = g.obj(pick);
      let attacking: import('./types.js').PlayerId | import('./types.js').ObjectId | undefined;
      if (e.attacking) {
        const own = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
        attacking = own?.attacking ?? g.opponentsOf(ctx.controller)[0];
      }
      const made = g.createObject({ ...(src.copyOf ?? src.card), isToken: true }, ctx.controller, 'battlefield', { tapped: e.tapped, attacking });
      if (ctx.sourceId !== null) made.memory.createdBy = ctx.sourceId;
      return;
    }
    case 'becomeMonarch':
      for (const p of playersOf(g, e.who, ctx)) {
        g.state.monarch = p;
        g.log(`${g.player(p).name} becomes the monarch.`);
        g.emit({ name: 'becomesMonarch', playerId: p });
      }
      return;
    case 'goad':
      for (const o of g.resolveObjects(e.what, ctx)) {
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: 'untilYourNextTurn', modification: { layer: 'rule', rule: { kind: 'custom', tag: 'goaded', data: ctx.controller } } });
        g.log(`${g.nameOf(o.id)} is goaded.`);
      }
      return;
    case 'regenerate':
      for (const o of g.resolveObjects(e.what, ctx)) {
        g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids: [o.id] }, duration: 'endOfTurn', modification: { layer: 'rule', rule: { kind: 'custom', tag: 'regenerationShield' } } });
      }
      return;
    case 'preventDamage': {
      const ts = g.resolveRef(e.to, ctx);
      const ids = ts.filter((t) => t.kind === 'object').map((t) => (t as { id: ObjectId }).id);
      const playerIds = ts.filter((t) => t.kind === 'player').map((t) => (t as { id: PlayerId }).id);
      if (e.amount === 'all') {
        // "Prevent all damage that would be dealt to it this turn": a rule on the recipient for the duration.
        if (ids.length) g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 'rule', rule: { kind: 'damagePrevention', amount: 'all' } } });
        if (playerIds.length) g.state.preventions.push({ combat: false, to: 'all', controller: ctx.controller, sourceId: ctx.sourceId, playerIds, permanent: e.duration !== undefined && e.duration !== 'endOfTurn' });
        return;
      }
      // CR 615.7: a shield that prevents "the next N damage" is reduced by what it prevents and ends when used up.
      if (!ids.length && !playerIds.length) return;
      g.state.preventions.push({ combat: false, to: 'all', controller: ctx.controller, sourceId: ctx.sourceId, amount: amt(e.amount), ids: ids.length ? ids : undefined, playerIds: playerIds.length ? playerIds : undefined, permanent: e.duration !== undefined && e.duration !== 'endOfTurn' });
      return;
    }
    case 'lookAtTop': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = Math.min(amt(e.amount), pl.library.length);
        const top = pl.library.slice(0, n);
        if (!top.length) return;
        const asker = e.looker ? playersOf(g, e.looker, ctx)[0] ?? p : p;
        const whose = asker === p ? 'your' : `${pl.name}'s`;
        g.log(`${g.player(asker).name} ${e.reveal ? 'reveals' : 'looks at'} the top ${n} card${n === 1 ? '' : 's'} of ${whose} library${e.reveal ? `: ${top.map((id) => g.nameOf(id)).join(', ')}` : ''}.`);
        if (e.then === 'hold') {
          if (!e.reveal) yield* g.ask({ type: 'chooseObjects', player: asker, prompt: `Top ${n} card${n === 1 ? '' : 's'} of ${whose} library`, candidates: top, min: 0, max: 0, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          ctx.memory[e.key ?? 'looked'] = top;
          ctx.memory['lastMoved'] = top;
          return;
        }
        if (e.then === 'reorder') {
          const resp = yield* g.ask({ type: 'orderObjects', player: asker, prompt: 'Put them back in any order (first = top)', objectIds: top, context: 'libraryTop' });
          if (resp.type === 'order') pl.library.splice(0, n, ...resp.ids);
          g.touch();
          return;
        }
        if (e.then === 'topRestGraveyard' || e.then === 'graveyardRestTop') {
          const keepN = e.pick !== undefined ? amt(e.pick) : e.then === 'topRestGraveyard' ? 1 : n;
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.then === 'topRestGraveyard' ? `Choose up to ${keepN} to keep on top (the rest go to your graveyard)` : 'Choose any number to put into your graveyard', candidates: top, min: 0, max: e.then === 'topRestGraveyard' ? Math.min(keepN, top.length) : top.length, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          const chosen = resp.type === 'objects' ? resp.ids : [];
          const toGy = e.then === 'topRestGraveyard' ? top.filter((id) => !chosen.includes(id)) : chosen;
          const stay = top.filter((id) => !toGy.includes(id));
          pl.library.splice(0, n, ...stay);
          for (const id of toGy) g.moveObject(id, 'graveyard', { cause: 'mill' });
          g.touch();
          return;
        }
        const pickN = e.pick !== undefined ? amt(e.pick) : 1;
        const cands = e.filter ? top.filter((id) => matchesFilter(g, g.obj(id), { ...e.filter!, zone: 'library' }, { sourceId: ctx.sourceId, controller: p })) : top;
        let picked: ObjectId[] = [];
        if (cands.length > 0) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Choose up to ${pickN} to ${e.then === 'battlefieldRestBottom' ? 'put onto the battlefield' : 'put into your hand'}`, candidates: cands, min: 0, max: Math.min(pickN, cands.length), revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          picked = resp.type === 'objects' ? resp.ids : [];
        }
        const rest = top.filter((id) => !picked.includes(id));
        for (const id of picked) {
          if (e.then === 'battlefieldRestBottom') yield* enterBattlefield(g, id, p, { ctx });
          else g.moveObject(id, 'hand', { skipEvents: true });
        }
        if (e.then === 'handRestGraveyard') for (const id of rest) g.moveObject(id, 'graveyard');
        else if (e.then === 'handRestTop') {
          let order = rest;
          if (rest.length > 1) {
            const resp = yield* g.ask({ type: 'orderObjects', player: p, prompt: 'Put the rest back on top in any order', objectIds: rest, context: 'libraryTop' });
            if (resp.type === 'order') order = resp.ids;
          }
          pl.library.splice(0, 0, ...order.filter((id) => g.state.objects[id]?.zone === 'library' && !pl.library.includes(id)));
          g.touch();
        } else {
          let order = rest;
          if (rest.length > 1) {
            const resp = yield* g.ask({ type: 'orderObjects', player: p, prompt: 'Put the rest on the bottom in any order', objectIds: rest, context: 'libraryTop' });
            if (resp.type === 'order') order = resp.ids;
          }
          for (const id of order) g.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
        }
        ctx.memory['lastMoved'] = picked;
      }
      return;
    }
    case 'revealTop': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = e.amount !== undefined ? amt(e.amount) : 1;
        if (n > 1) {
          const ids = pl.library.slice(0, n);
          if (!ids.length) continue;
          for (const rid of ids) g.log(`${pl.name} reveals ${g.nameOf(rid)} from the top of their library.`, { kind: 'reveal', data: { objectId: rid } });
          ctx.memory['revealed'] = ids;
          ctx.memory['lastMoved'] = ids;
          continue;
        }
        const id = pl.library[0];
        if (id === undefined) return;
        g.log(`${pl.name} reveals ${g.nameOf(id)} from the top of their library.`, { kind: 'reveal', data: { objectId: id } });
        const matches = !e.ifMatches || matchesFilter(g, g.obj(id), { ...e.ifMatches, zone: 'library' }, { sourceId: ctx.sourceId, controller: p });
        ctx.memory['revealed'] = [id];
        ctx.memory['lastMoved'] = [id];
        if (matches && e.then) yield* executeEffects(g, e.then, ctx);
        if (!matches && e.else) yield* executeEffects(g, e.else, ctx);
        const still = g.state.objects[id]?.zone === 'library';
        if (still && e.destination && e.destination !== 'stay') {
          if (e.destination === 'hand') g.moveObject(id, 'hand', { skipEvents: true });
          else if (e.destination === 'graveyard') g.moveObject(id, 'graveyard', { cause: 'mill' });
          else if (e.destination === 'bottom') g.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
        }
      }
      return;
    }
    case 'castWithoutPaying':
      for (const o of g.resolveObjects(e.what, ctx)) {
        const { castSpell } = await_casting();
        if (e.exileAfter) o.memory['exileOnResolve'] = true;
        const ok = yield* castSpell(g, ctx.controller, o.id, { type: 'cast', objectId: o.id }, { free: true });
        if (!ok) delete o.memory['exileOnResolve'];
      }
      return;
    case 'castFrom':
      for (const o of g.resolveObjects(e.what, ctx)) {
        const { castSpell } = await_casting();
        o.memory['castableBy'] = ctx.controller;
        if (e.exileAfter) o.memory['exileOnResolve'] = true;
        const ok = yield* castSpell(g, ctx.controller, o.id, { type: 'cast', objectId: o.id }, { free: e.free, anyMana: e.anyManaType, payLifeInsteadOfMana: e.payLifeInsteadOfMana });
        if (!ok) {
          delete o.memory['castableBy'];
          delete o.memory['exileOnResolve'];
        }
      }
      return;
    case 'playFromExile':
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (e.fromGraveyard) o.memory['castableBy'] = ctx.controller;
        if (e.exileAfter) o.memory['exileOnResolve'] = true;
        o.memory['playableBy'] = e.owner ? o.owner : ctx.controller;
        o.memory['playableUntil'] = e.duration === 'permanent' ? 'permanent' : g.state.turn.number;
        if (e.forCost) o.memory['playForCost'] = e.forCost;
        if (e.anyMana) o.memory['playAnyMana'] = true;
        if (e.payLife) o.memory['payLifeToCast'] = true;
      }
      return;
    case 'moveAll': {
      const moved: ObjectId[] = [];
      for (const p of g.resolvePlayers(e.who, ctx)) {
        for (const id of [...g.zoneList(p, e.from)]) {
          const r = g.moveObject(id, e.to, { cause: e.to === 'exile' ? 'exile' : 'other', sourceId: ctx.sourceId ?? undefined });
          if (r) moved.push(r.id);
        }
      }
      ctx.memory['lastMoved'] = moved;
      return;
    }
    case 'choosePlayer': {
      const cands = e.who === 'opponent' ? g.opponentsOf(ctx.controller) : g.state.playerOrder.filter((p) => !g.player(p).lost);
      if (!cands.length) return;
      let pick = cands[0];
      if (e.random) {
        pick = g.rng.shuffle([...cands])[0];
        g.log(`${g.player(pick).name} is chosen at random.`);
      } else if (cands.length > 1) {
        const resp = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: e.who === 'opponent' ? 'Choose an opponent' : 'Choose a player', options: cands.map((p) => ({ id: p, label: g.player(p).name })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        if (resp.type === 'options') pick = resp.ids[0];
      }
      setMemory(g, ctx, e.key, pick);
      return;
    }
    case 'grantAbility': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 6, addAbilityText: [e.text] } });
      return;
    }
    case 'switchPT': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: '7d', switchPT: true } });
      return;
    }
    case 'emblem': {
      for (const p of playersOf(g, e.who, ctx)) {
        const card = { ...tokenCard({ name: 'Emblem', typeLine: 'Emblem', colors: [], oracleText: e.text }, g, ctx), isToken: false };
        g.createObject(card, p, 'command', { controller: p });
        g.log(`${g.player(p).name} gets an emblem: "${e.text}"`);
      }
      return;
    }
    case 'revealUntil': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const seen: ObjectId[] = [];
        const hits: ObjectId[] = [];
        const want = e.count !== undefined ? Math.max(1, amt(e.count)) : 1;
        for (let i = 0; i < pl.library.length && hits.length < want; i++) {
          const id = pl.library[i];
          seen.push(id);
          g.log(`${pl.name} reveals ${g.nameOf(id)}.`);
          if (matchesFilter(g, g.obj(id), { ...e.filter, zone: 'library' }, { sourceId: ctx.sourceId, controller: p, x: ctx.x })) hits.push(id);
        }
        ctx.memory['revealedCount'] = ((ctx.memory['revealedCount'] as number) ?? 0) + seen.length;
        const rest = seen.filter((id) => !hits.includes(id));
        if (e.destination === 'hold') {
          ctx.memory[e.key ?? 'revealed'] = hits;
          ctx.memory['lastMoved'] = hits;
        } else {
          for (const hit of hits) {
            if (e.destination === 'battlefield') yield* enterBattlefield(g, hit, p, { tapped: e.tapped, ctx });
            else g.moveObject(hit, e.destination, { skipEvents: e.destination === 'hand', cause: e.destination === 'exile' ? 'exile' : 'other' });
          }
          if (hits.length) ctx.memory['lastMoved'] = hits;
        }
        if (e.rest === 'shuffle') {
          for (const id of rest) g.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
          if (rest.length) g.shuffleLibrary(g.state.objects[rest[0]].owner);
        } else if (e.rest === 'bottom') for (const id of g.rng.shuffle(rest)) g.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
        else if (e.rest === 'top') for (const id of [...rest].reverse()) g.moveObject(id, 'library', { position: 'top', skipEvents: true });
        else for (const id of rest) g.moveObject(id, e.rest, { skipEvents: e.rest === 'hand', cause: e.rest === 'exile' ? 'exile' : 'mill' });
      }
      return;
    }
    case 'preventAll': {
      const pv: Game['state']['preventions'][number] = { combat: !!e.combat, source: e.source, to: e.to, controller: ctx.controller, sourceId: ctx.sourceId, once: e.once, effects: e.effects, amount: e.amount };
      if (e.sourceRef) {
        pv.sourceIds = g.resolveObjects(e.sourceRef, ctx).map((o) => o.id);
        if (!pv.sourceIds.length) return;
      }
      if (e.toRef) {
        const ts = g.resolveRef(e.toRef, ctx);
        pv.ids = ts.filter((t) => t.kind === 'object').map((t) => (t as { id: ObjectId }).id);
        pv.playerIds = ts.filter((t) => t.kind === 'player').map((t) => (t as { id: PlayerId }).id);
        if (!pv.ids.length && !pv.playerIds.length) return;
      }
      if (e.redirectTo) {
        const rs = g.resolveRef(e.redirectTo, ctx);
        pv.redirectIds = rs.filter((t) => t.kind === 'object').map((t) => (t as { id: ObjectId }).id);
        pv.redirectPlayers = rs.filter((t) => t.kind === 'player').map((t) => (t as { id: PlayerId }).id);
      }
      if (e.redirectToSourceController) pv.redirectToSourceController = true;
      g.state.preventions.push(pv);
      return;
    }
    case 'endCombatPhase': {
      for (const step of ['declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'] as const) {
        if (!g.state.turn.skipSteps.includes(step)) g.state.turn.skipSteps.push(step);
      }
      g.log('The combat phase ends.');
      g.touch();
      return;
    }
    case 'turnFlag':
      g.state.turnStats[e.flag === 'keepMana' ? `keepMana:${ctx.controller}` : e.flag] = 1;
      return;
    case 'vote': {
      const order = g.votingOrder(ctx.controller);
      const tally: Record<string, number> = {};
      for (const o of e.options) tally[o] = 0;
      const by: Record<string, string> = {};
      for (const p of order) {
        const times = 1 + g.extraVotes(p);
        for (let i = 0; i < times; i++) {
          const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: `Vote: ${e.options.join(' or ')}`, options: e.options.map((o) => ({ id: o, label: o })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
          const pick = r.type === 'options' && r.ids[0] && e.options.includes(r.ids[0]) ? r.ids[0] : e.options[0];
          tally[pick]++;
          if (i === 0) by[p] = pick;
          g.log(`${g.player(p).name} votes for ${pick}.`);
        }
      }
      ctx.memory['votes'] = tally;
      ctx.memory['votesBy'] = by;
      if (ctx.sourceId !== null && g.state.objects[ctx.sourceId]) g.state.objects[ctx.sourceId].memory['votes'] = tally;
      g.emit({ name: 'finishedVoting', playerId: ctx.controller });
      return;
    }
    case 'voteObjects': {
      const cands = objectsMatching(g, g.bindFilter(e.filter, ctx), { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x }, e.filter.zone ? undefined : ['battlefield']).map((o) => o.id);
      if (!cands.length) {
        ctx.memory[e.key] = [];
        return;
      }
      const tally = new Map<ObjectId, number>();
      for (const p of g.votingOrder(ctx.controller)) {
        const times = 1 + g.extraVotes(p);
        for (let i = 0; i < times; i++) {
          const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Vote for one', candidates: cands, min: 1, max: 1, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          const pick = r.type === 'objects' && r.ids[0] !== undefined ? r.ids[0] : cands[0];
          tally.set(pick, (tally.get(pick) ?? 0) + 1);
          g.log(`${g.player(p).name} votes for ${g.nameOf(pick)}.`);
        }
      }
      const best = Math.max(...tally.values());
      ctx.memory[e.key] = [...tally].filter(([, n]) => n === best).map(([id]) => id);
      g.emit({ name: 'finishedVoting', playerId: ctx.controller });
      return;
    }
    case 'turnFaceUp': {
      for (const o of g.resolveObjects(e.what ?? { ref: 'self' }, ctx)) {
        if (!o.faceDown || o.zone !== 'battlefield') continue;
        o.faceDown = false;
        delete o.memory['faceDownWard'];
        if (e.counters) g.addCounters(o.id, e.counters.counter, g.resolveAmount(e.counters.amount, ctx));
        g.log(`${g.nameOf(o.id)} is turned face up.`);
        g.touch();
        g.emit({ name: 'turnedFaceUp', objectId: o.id, playerId: o.controller });
      }
      return;
    }
    case 'manifest': {
      for (const p of playersOf(g, e.who, ctx)) {
        const n = amt(e.amount);
        for (let i = 0; i < n; i++) {
          const pl = g.player(p);
          const pile = e.fromHand ? pl.hand : pl.library;
          if (!pile.length) break;
          let pick = pile[0];
          if (e.fromHand && pile.length > 1) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Manifest a card from your hand', candidates: [...pile], min: 1, max: 1, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'objects' && r.ids[0] !== undefined) pick = r.ids[0];
          }
          if (e.dread) {
            const top = pl.library.slice(0, 2);
            if (top.length === 2) {
              const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'Manifest dread: choose one to manifest (the other goes to your graveyard)', candidates: top, min: 1, max: 1, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
              pick = r.type === 'objects' && r.ids[0] !== undefined ? r.ids[0] : top[0];
              const other = top.find((id) => id !== pick);
              if (other !== undefined) g.moveObject(other, 'graveyard', { cause: 'mill' });
            }
          }
          const entered = yield* enterBattlefield(g, pick, p, { ctx, faceDown: true });
          if (entered) {
            if (e.ward) entered.memory['faceDownWard'] = e.ward;
            g.log(`${g.player(p).name} manifests a card face down.`);
          }
        }
      }
      return;
    }
    case 'unlockDoor': {
      if (ctx.sourceId === null) return;
      const o = g.state.objects[ctx.sourceId];
      if (!o) return;
      const doors = ((o.memory['unlockedDoors'] as number[] | undefined) ?? []).slice();
      if (doors.includes(e.door)) return;
      doors.push(e.door);
      o.memory['unlockedDoors'] = doors;
      const name = e.door > 0 ? o.card.faces?.[e.door]?.name ?? o.card.name : o.card.name;
      g.log(`${g.player(o.controller).name} unlocks ${name}.`);
      g.touch();
      g.emit({ name: 'unlockedDoor', objectId: o.id, playerId: o.controller, data: { door: e.door } });
      return;
    }
    case 'setDayNight': {
      if (e.to === 'startDay' || e.to === 'startNight') {
        if (g.state.dayNight === undefined) g.setDayNight(e.to === 'startDay' ? 'day' : 'night');
      } else g.setDayNight(e.to);
      return;
    }
    case 'empower': {
      const n = amt(e.amount);
      const existing = g.state.battlefield
        .map((id) => g.state.objects[id])
        .find((o) => o && o.controller === ctx.controller && o.card.isToken && g.characteristics(o.id).name === e.token);
      if (existing) {
        g.addCounters(existing.id, 'loyalty', n);
        return;
      }
      const spec = TOKEN_PRESETS[e.token];
      if (!spec) return;
      yield* executeEffects(g, [{ kind: 'createToken', token: { ...spec, preset: e.token }, count: 1, counters: { counter: 'loyalty', amount: n } }], ctx);
      return;
    }
    case 'clash': {
      const opps = g.activePlayers().filter((x) => x !== ctx.controller);
      if (!opps.length) return;
      let opp = opps[0];
      if (opps.length > 1) {
        const r = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Clash with which opponent?', options: opps.map((p) => ({ id: p, label: g.player(p).name })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
        if (r.type === 'options' && r.ids[0]) opp = r.ids[0] as typeof opp;
      }
      const mv: Record<string, number> = {};
      for (const p of [ctx.controller, opp]) {
        const top = g.player(p).library[0];
        mv[p] = top !== undefined ? g.characteristics(top).manaValue : -1;
        if (top !== undefined) {
          g.log(`${g.player(p).name} reveals ${g.nameOf(top)} for the clash.`);
          const r = yield* g.ask({ type: 'yesNo', player: p, prompt: `Clash: put ${g.nameOf(top)} on the bottom of your library?`, sourceId: ctx.sourceId ?? undefined });
          if (r.type === 'yesNo' && r.value) {
            g.player(p).library.shift();
            g.player(p).library.push(top);
          }
        }
      }
      const won = mv[ctx.controller] > mv[opp];
      g.log(won ? `${g.player(ctx.controller).name} wins the clash.` : `${g.player(ctx.controller).name} does not win the clash.`);
      if (ctx.sourceId !== null && g.state.objects[ctx.sourceId]) g.state.objects[ctx.sourceId].memory['clashWon'] = won;
      ctx.memory['clashWon'] = won ? 1 : 0;
      g.emit({ name: 'clashed', playerId: ctx.controller, sourceId: ctx.sourceId ?? undefined, data: { won } });
      return;
    }
    case 'discover': {
      const n = amt(e.amount);
      const pl = g.player(ctx.controller);
      const exiled: ObjectId[] = [];
      let hit: ObjectId | null = null;
      while (pl.library.length) {
        const top = pl.library[0];
        const r = g.moveObject(top, 'exile', { cause: 'exile', sourceId: ctx.sourceId ?? undefined });
        if (!r) break;
        exiled.push(r.id);
        const ch = g.characteristics(r.id);
        if (!ch.types.includes('Land') && ch.manaValue <= n) {
          hit = r.id;
          break;
        }
      }
      if (hit !== null) {
        const resp = yield* g.ask({ type: 'yesNo', player: ctx.controller, prompt: `Discover: cast ${g.nameOf(hit)} without paying its mana cost? (No puts it into your hand.)`, sourceId: ctx.sourceId ?? undefined });
        let cast = false;
        if (resp.type === 'yesNo' && resp.value) {
          const { castSpell } = await_casting();
          cast = yield* castSpell(g, ctx.controller, hit, { type: 'cast', objectId: hit }, { free: true });
        }
        if (!cast && g.state.objects[hit]?.zone === 'exile') g.moveObject(hit, 'hand', { skipEvents: true });
      }
      const rest = exiled.filter((id) => id !== hit && g.state.objects[id]?.zone === 'exile');
      for (const id of g.rng.shuffle(rest)) g.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
      return;
    }
    case 'extraLandThisTurn':
      for (const p of playersOf(g, e.who, ctx)) g.player(p).landsPlayedThisTurn--;
      return;
    case 'chooseColor': {
      const chooser = e.who ? (g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller) : ctx.controller;
      const resp = yield* g.ask({ type: 'chooseOption', player: chooser, prompt: 'Choose a color', options: COLORS.map((c) => ({ id: c, label: c })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      const c = resp.type === 'options' ? resp.ids[0] : 'W';
      setMemory(g, ctx, e.key, c);
      return;
    }
    case 'chooseCreatureType': {
      const pool = e.pool ?? 'creature';
      let options: { id: string; label: string }[];
      if (pool === 'land') options = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].map((t) => ({ id: t, label: t }));
      else if (pool === 'cardType') options = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Battle'].map((t) => ({ id: t, label: t }));
      else {
        const types = new Set<string>();
        for (const o of Object.values(g.state.objects)) if (g.characteristics(o.id).types.includes('Creature')) g.characteristics(o.id).subtypes.forEach((s) => types.add(s));
        options = [...types].sort().map((t) => ({ id: t, label: t }));
        if (!options.length) options.push({ id: 'Human', label: 'Human' });
      }
      const resp = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: pool === 'land' ? 'Choose a land type' : pool === 'cardType' ? 'Choose a card type' : 'Choose a creature type', options, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      setMemory(g, ctx, e.key, resp.type === 'options' ? resp.ids[0] : options[0].id);
      return;
    }
    case 'nameCard':
      setMemory(g, ctx, e.key, '(named card — manual)');
      return;
    case 'setMemory':
      if (e.on) {
        for (const o of g.resolveObjects(e.on, ctx)) o.memory[e.key] = e.value;
        g.touch();
        return;
      }
      setMemory(g, ctx, e.key, e.value);
      return;
    case 'incrementMemory': {
      const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
      if (src) src.memory[e.key] = ((src.memory[e.key] as number) ?? 0) + (e.by ?? 1);
      return;
    }
    case 'conditional': {
      let ok: boolean;
      if (e.if.kind === 'manual') {
        const resp = yield* g.ask({ type: 'yesNo', player: ctx.controller, prompt: e.if.text, sourceId: ctx.sourceId ?? undefined });
        ok = resp.type === 'yesNo' && resp.value;
      } else ok = g.checkCondition(e.if, { sourceId: ctx.sourceId, controller: ctx.controller, triggerContext: ctx.triggerContext, targets: ctx.targets, x: ctx.x, modes: ctx.modes });
      yield* executeEffects(g, ok ? e.then : e.else ?? [], ctx);
      return;
    }
    case 'forEach': {
      let items = g.resolveRef(e.over, ctx);
      if (e.filter) items = items.filter((it) => it.kind === 'object' && g.state.objects[it.id] && matchesFilter(g, g.state.objects[it.id], { ...e.filter, zone: undefined }, { sourceId: ctx.sourceId, controller: ctx.controller }));
      for (const it of items) yield* executeEffects(g, e.effects, { ...ctx, iter: it });
      return;
    }
    case 'repeat': {
      const n = amt(e.times);
      for (let i = 0; i < n; i++) yield* executeEffects(g, e.effects, ctx);
      return;
    }
    case 'repeatWhile': {
      const max = e.max ?? 50;
      for (let i = 0; i < max; i++) {
        if (e.condition && !g.checkCondition(e.condition, ctx)) return;
        if (e.optional && i > 0) {
          const r = yield* g.ask({ type: 'yesNo', player: ctx.controller, prompt: 'Repeat the process again?', sourceId: ctx.sourceId ?? undefined });
          if (r.type !== 'yesNo' || !r.value) return;
        }
        yield* executeEffects(g, e.effects, ctx);
      }
      return;
    }
    case 'may': {
      const players = e.who ? g.resolvePlayers(e.who, ctx) : [ctx.controller];
      if (!players.length) return;
      let accepted = 0;
      let declined = 0;
      for (const who of players) {
        const resp = yield* g.ask({ type: 'yesNo', player: who, prompt: e.prompt ?? `${ctx.sourceId !== null ? g.nameOf(ctx.sourceId) : 'Effect'}: ${describe(e.effects)}?`, sourceId: ctx.sourceId ?? undefined });
        const yes = resp.type === 'yesNo' && resp.value;
        if (yes) accepted++;
        else declined++;
        const sub = players.length > 1 ? { ...ctx, iter: { kind: 'player' as const, id: who } } : ctx;
        if (yes) yield* executeEffects(g, e.effects, sub);
        else if (e.else?.length) yield* executeEffects(g, e.else, sub);
      }
      ctx.memory['acceptedCount'] = accepted;
      ctx.memory['declinedCount'] = declined;
      return;
    }
    case 'unlessPays': {
      for (const p of g.resolvePlayers(e.who, ctx)) {
        let paid = false;
        if (typeof e.cost === 'object' && 'putFromGraveyardOnBottom' in e.cost) {
          const n = e.cost.putFromGraveyardOnBottom;
          const cands = [...g.player(p).graveyard];
          if (cands.length >= n) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Put ${n} card${n === 1 ? '' : 's'} from your graveyard on the bottom of your library? (choose none to decline)`, candidates: cands, min: 0, max: n, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'objects' && r.ids.length === n) {
              for (const id of r.ids) g.moveObject(id, 'library', { position: 'bottom' });
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'takeDamageFromSource' in e.cost) {
          const n = g.resolveAmount(e.cost.takeDamageFromSource, ctx);
          const r = yield* g.ask({ type: 'yesNo', player: p, prompt: e.text ?? `Take ${n} damage instead? Otherwise: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
          if (r.type === 'yesNo' && r.value) {
            g.dealDamage(ctx.sourceId ?? null, { kind: 'player', id: p }, n, false);
            paid = true;
          }
        } else if (typeof e.cost === 'object' && 'removeCounters' in e.cost) {
          const d = e.cost.removeCounters;
          const cands = objectsMatching(g, { ...d.filter, controller: p, zone: 'battlefield' }, { sourceId: ctx.sourceId, controller: p }).filter((o) => (o.counters[d.counter] ?? 0) >= d.amount).map((o) => o.id);
          if (cands.length) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Remove ${d.amount} ${d.counter} counter${d.amount === 1 ? '' : 's'}? (choose none to decline)`, candidates: cands, min: 0, max: 1, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'objects' && r.ids.length === 1) {
              const o = g.obj(r.ids[0]);
              o.counters[d.counter] = (o.counters[d.counter] ?? 0) - d.amount;
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'tap' in e.cost) {
          const f = e.cost.tap;
          const need = e.cost.count ?? 1;
          const cands = objectsMatching(g, { ...f, controller: p, zone: 'battlefield', untapped: true }, { sourceId: ctx.sourceId, controller: p }).map((o) => o.id);
          if (cands.length >= need) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Tap ${need} permanent${need === 1 ? '' : 's'}? (choose none to decline)`, candidates: cands, min: 0, max: need, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'objects' && r.ids.length === need) {
              for (const id of r.ids) g.tap(id);
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'returnToHand' in e.cost) {
          const f = e.cost.returnToHand;
          const cands = objectsMatching(g, { ...f, controller: p, zone: 'battlefield' }, { sourceId: ctx.sourceId, controller: p }).map((o) => o.id);
          if (cands.length >= e.cost.count) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Return ${e.cost.count} to hand? (choose none to decline)`, candidates: cands, min: 0, max: e.cost.count });
            if (r.type === 'objects' && r.ids.length === e.cost.count) {
              for (const id of r.ids) g.moveObject(id, 'hand');
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'discard' in e.cost && e.cost.random) {
          const hand = g.player(p).hand;
          const n = e.cost.discard;
          if (hand.length >= n) {
            const r = yield* g.ask({ type: 'yesNo', player: p, prompt: e.text ?? `Discard ${n} card${n === 1 ? '' : 's'} at random? Otherwise: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'yesNo' && r.value) {
              const ids = g.rng.shuffle([...hand]).slice(0, n);
              for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'discard' });
              g.emit({ name: 'discardBatch', playerId: p, amount: n, objectId: ids[0] });
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'discard' in e.cost) {
          const df = e.cost.filter;
          const hand = df ? g.player(p).hand.filter((id) => matchesFilter(g, g.obj(id), { ...df, zone: 'hand' }, { sourceId: ctx.sourceId, controller: p })) : g.player(p).hand;
          const n = e.cost.discard;
          if (hand.length >= n) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Discard ${n} card${n === 1 ? '' : 's'}? (choose none to decline)`, candidates: [...hand], min: 0, max: n, revealToChooser: true });
            if (r.type === 'objects' && r.ids.length === n) {
              for (const id of r.ids) g.moveObject(id, 'graveyard', { cause: 'discard' });
              g.emit({ name: 'discardBatch', playerId: p, amount: n, objectId: r.ids[0] });
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'sacrifice' in e.cost) {
          const f = e.cost.sacrifice;
          const need = e.cost.count ?? 1;
          const cands = objectsMatching(g, { ...f, controller: p, zone: 'battlefield' }, { sourceId: ctx.sourceId, controller: p }).map((o) => o.id);
          if (cands.length >= need) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Sacrifice ${need}? (choose none to decline)`, candidates: cands, min: 0, max: need });
            if (r.type === 'objects' && r.ids.length === need) {
              for (const id of r.ids) g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: ctx.sourceId ?? undefined });
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'exileFromGraveyard' in e.cost) {
          const f = e.cost.exileFromGraveyard;
          const need = e.cost.count;
          const cands = g.player(p).graveyard.filter((id) => matchesFilter(g, g.obj(id), { ...f, zone: 'graveyard' }, { sourceId: ctx.sourceId, controller: p }));
          if (cands.length >= need) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Exile ${need} from your graveyard? (choose none to decline)`, candidates: cands, min: 0, max: need, revealToChooser: true });
            if (r.type === 'objects' && r.ids.length === need) {
              for (const id of r.ids) g.moveObject(id, 'exile', { cause: 'exile', sourceId: ctx.sourceId ?? undefined });
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'genericMana' in e.cost) {
          const n = Math.max(0, g.resolveAmount(e.cost.genericMana, ctx));
          paid = yield* offerToPay(g, p, `{${n}}`, e.text ?? `Pay {${n}}? Otherwise: ${describe(e.effects)}`);
        } else if (typeof e.cost === 'object' && 'energy' in e.cost) {
          const n = Math.max(0, g.resolveAmount(e.cost.energy, ctx));
          if (g.player(p).energy >= n) {
            const r = yield* g.ask({ type: 'yesNo', player: p, prompt: e.text ?? `Pay ${n} {E}? Otherwise: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'yesNo' && r.value) {
              g.player(p).energy -= n;
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'payLifeAmount' in e.cost) {
          const n = Math.max(0, g.resolveAmount(e.cost.payLifeAmount, ctx));
          if (g.player(p).life >= n) {
            const r = yield* g.ask({ type: 'yesNo', player: p, prompt: e.text ?? `Pay ${n} life? Otherwise: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'yesNo' && r.value) {
              g.loseLife(p, n, ctx.sourceId ?? undefined);
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'putCounter' in e.cost) {
          const d = e.cost.putCounter;
          const cands = objectsMatching(g, { ...d.filter, controller: 'you', zone: 'battlefield' }, { sourceId: ctx.sourceId, controller: p }).map((o) => o.id);
          if (cands.length) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? `Put ${d.amount} ${d.counter} counter${d.amount === 1 ? '' : 's'} on a permanent you control? (choose none to decline)`, candidates: cands, min: 0, max: 1, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'objects' && r.ids.length) {
              g.addCounters(r.ids[0], d.counter, d.amount);
              paid = true;
            }
          }
        } else if (typeof e.cost === 'object' && 'mana' in e.cost) {
          if (g.player(p).life >= e.cost.payLife) {
            paid = yield* offerToPay(g, p, e.cost.mana, e.text ?? `Pay ${e.cost.mana} and ${e.cost.payLife} life? Otherwise: ${describe(e.effects)}`);
            if (paid) g.loseLife(p, e.cost.payLife, ctx.sourceId ?? undefined);
          }
        } else if (typeof e.cost === 'object' && 'payLife' in e.cost) {
          if (g.player(p).life >= e.cost.payLife) {
            const r = yield* g.ask({ type: 'yesNo', player: p, prompt: e.text ?? `Pay ${e.cost.payLife} life? Otherwise: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'yesNo' && r.value) {
              g.loseLife(p, e.cost.payLife, ctx.sourceId ?? undefined);
              paid = true;
            }
          }
        } else if (e.cost === 'discard') {
          const hand = g.player(p).hand;
          if (hand.length) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? 'Discard a card? (choose none to decline)', candidates: [...hand], min: 0, max: 1, revealToChooser: true });
            if (r.type === 'objects' && r.ids.length) {
              g.moveObject(r.ids[0], 'graveyard', { cause: 'discard' });
              g.emit({ name: 'discardBatch', playerId: p, amount: 1, objectId: r.ids[0] });
              paid = true;
            }
          }
        } else if (e.cost === 'sacrifice') {
          const cands = g.state.battlefield.filter((id) => g.obj(id).controller === p && ['Artifact', 'Creature', 'Land'].some((t) => g.characteristics(id).types.includes(t)));
          if (cands.length) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: e.text ?? 'Sacrifice an artifact, creature or land? (choose none to decline)', candidates: cands, min: 0, max: 1 });
            if (r.type === 'objects' && r.ids.length) {
              g.moveObject(r.ids[0], 'graveyard', { cause: 'sacrifice' });
              paid = true;
            }
          }
        } else if (typeof e.cost === 'string') paid = yield* offerToPay(g, p, e.cost, e.text ?? `Pay ${e.cost}? Otherwise: ${describe(e.effects)}`);
        if (!paid) yield* executeEffects(g, e.effects, { ...ctx, iter: { kind: 'player', id: p } });
        else if (e.thenEffects) yield* executeEffects(g, e.thenEffects, { ...ctx, iter: { kind: 'player', id: p } });
      }
      return;
    }
    case 'exileTop': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = amt(e.amount);
        const moved: ObjectId[] = [];
        for (let i = 0; i < n; i++) {
          const id = pl.library[0];
          if (id === undefined) break;
          const r = g.moveObject(id, 'exile', { cause: 'exile', sourceId: ctx.sourceId ?? undefined, faceDown: e.faceDown });
          if (r) moved.push(r.id);
        }
        ctx.memory['lastMoved'] = moved;
        if (e.key) ctx.memory[e.key] = moved;
        if (ctx.sourceId !== null && g.state.objects[ctx.sourceId]) {
          const src = g.state.objects[ctx.sourceId];
          src.memory['exiled'] = [...((src.memory['exiled'] as ObjectId[]) ?? []), ...moved];
        }
        if (moved.length) g.log(`${pl.name} exiles the top ${moved.length === 1 ? 'card' : `${moved.length} cards`} of their library: ${moved.map((id) => g.nameOf(id)).join(', ')}.`);
      }
      return;
    }
    case 'revealHand': {
      for (const p of g.resolvePlayers(e.who, ctx)) {
        let ids = [...g.player(p).hand];
        if (e.count !== undefined) ids = (e.random ? g.rng.shuffle(ids) : ids).slice(0, e.count);
        const names = ids.map((id) => g.nameOf(id));
        const who = e.count !== undefined ? `${g.player(ctx.controller).name} looks at` : `${g.player(p).name} reveals`;
        g.log(`${who} ${e.count !== undefined ? `${ids.length} card(s) in ${g.player(p).name}'s hand` : 'their hand'}: ${names.join(', ') || '(empty)'}.`, { kind: 'revealHand', data: { player: p, ids, visibleTo: e.count !== undefined ? [ctx.controller] : undefined } });
      }
      return;
    }
    case 'ifPays': {
      const who = e.who ? g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      const payLife = e.payLifeAmount !== undefined ? amt(e.payLifeAmount) : e.payLife;
      const otherwise = function* (): Gen<void> {
        if (e.else?.length) yield* executeEffects(g, e.else, ctx);
      };
      if (e.energy !== undefined) {
        if (g.player(who).energy < e.energy) return yield* otherwise();
        const r = yield* g.ask({ type: 'yesNo', player: who, prompt: e.text ?? `Pay ${e.energy} energy? If you do: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return yield* otherwise();
        g.player(who).energy -= e.energy;
        yield* executeEffects(g, e.effects, ctx);
        return;
      }
      if (payLife !== undefined) {
        if (g.player(who).life < payLife) return yield* otherwise();
        const r = yield* g.ask({ type: 'yesNo', player: who, prompt: e.text ?? `Pay ${payLife} life? If you do: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return yield* otherwise();
        g.loseLife(who, payLife, ctx.sourceId ?? undefined);
        yield* executeEffects(g, e.effects, ctx);
        return;
      }
      if (e.payCostSpec) {
        const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : undefined;
        if (!src) return yield* otherwise();
        const r = yield* g.ask({ type: 'yesNo', player: who, prompt: e.text ?? `Pay the cost? If you do: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return yield* otherwise();
        const ok = yield* payAbilityCost(g, who, src, e.payCostSpec, 0);
        if (ok) yield* executeEffects(g, e.effects, ctx);
        else yield* otherwise();
        return;
      }
      const paid = yield* offerToPay(g, who, e.cost, e.text ?? `Pay ${e.cost}? If you do: ${describe(e.effects)}`);
      if (paid) yield* executeEffects(g, e.effects, ctx);
      else yield* otherwise();
      return;
    }
    case 'changeTargets': {
      for (const t of g.resolveRef(e.what, ctx)) {
        if (t.kind !== 'stackItem') continue;
        const item = g.state.stack.find((s) => s.id === t.id);
        if (!item) continue;
        const srcObj = g.state.objects[item.sourceId];
        if (!srcObj) continue;
        const specs = spellTargets(g, srcObj, g.scriptFor(srcObj), srcObj.faceIndex, item.modes ?? []);
        if (!specs.length) continue;
        const chosen = yield* chooseTargetsGrouped(g, ctx.controller, item.sourceId, specs, `New targets for ${item.text}`, item.xValue);
        if (chosen) {
          item.targets = chosen.flat;
          item.targetStamps = g.stampTargets(chosen.flat);
          item.triggerContext = { ...(item.triggerContext ?? {}), targetSlots: chosen.slots };
          g.log(`${g.player(ctx.controller).name} changes the target of ${item.text}.`);
          g.touch();
        }
      }
      return;
    }
    case 'moveRest': {
      const placed = (ctx.memory['libraryPlaced'] as ObjectId[] | undefined) ?? [];
      const ids = ((ctx.memory[e.key] as ObjectId[] | undefined) ?? []).filter((id) => g.state.objects[id]?.zone === 'library' && !placed.includes(id));
      if (!ids.length) return;
      const p = g.state.objects[ids[0]].controller;
      if (e.to === 'graveyard' || e.to === 'exile' || e.to === 'hand') {
        for (const id of ids) g.moveObject(id, e.to, e.to === 'graveyard' ? { cause: 'mill' } : {});
        g.touch();
        return;
      }
      let order = ids;
      if (e.to === 'bottomRandom') order = g.rng.shuffle([...ids]);
      else if (ids.length > 1) {
        const resp = yield* g.ask({ type: 'orderObjects', player: p, prompt: e.to === 'top' ? 'Put the rest back on top in any order (first = top)' : 'Put the rest on the bottom in any order', objectIds: ids, context: 'libraryTop' });
        if (resp.type === 'order') order = resp.ids;
      }
      if (e.to === 'top') {
        const pl = g.player(p);
        const rest = pl.library.filter((id) => !ids.includes(id));
        pl.library.splice(0, pl.library.length, ...order, ...rest);
      } else {
        for (const id of order) g.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
      }
      g.touch();
      return;
    }
    case 'chooseObjects': {
      const who = e.who ? g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      let cands = e.from ? g.resolveObjects(e.from, ctx).filter((o) => matchesFilter(g, o, { ...e.filter, zone: e.filter.zone ?? o.zone }, { sourceId: ctx.sourceId, controller: who, x: ctx.x })).map((o) => o.id) : objectsMatching(g, e.filter, { sourceId: ctx.sourceId, controller: who, x: ctx.x }, e.filter.zone ? undefined : ['battlefield']).map((o) => o.id);
      if (e.owner) {
        const owners = new Set(g.resolvePlayers(e.owner, ctx));
        cands = cands.filter((id) => owners.has(g.obj(id).owner));
      }
      const n = Math.min(amt(e.count), cands.length);
      let ids: ObjectId[] = [];
      if (cands.length > 0 && e.random) {
        ids = g.rng.shuffle([...cands]).slice(0, n);
      } else if (cands.length > 0) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: who, prompt: `Choose ${e.upTo ? 'up to ' : ''}${n}`, candidates: cands, min: e.upTo ? 0 : n, max: n, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
        ids = resp.type === 'objects' ? resp.ids : cands.slice(0, n);
      }
      ctx.memory[e.key] = ids;
      if (ctx.sourceId !== null && g.state.objects[ctx.sourceId]) g.state.objects[ctx.sourceId].memory[e.key] = ids;
      return;
    }
    case 'chooseMode': {
      const n = e.countAmount !== undefined ? amt(e.countAmount) : e.count ?? 1;
      const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : undefined;
      const usedKey = e.notChosen === 'turn' ? `modesChosen:${g.state.turn.number}` : 'modesChosen';
      const used = e.notChosen && src ? ((src.memory[usedKey] as number[] | undefined) ?? []) : [];
      const avail = e.options.map((o, i) => ({ o, i })).filter(({ i }) => !used.includes(i));
      if (!avail.length) return;
      const pick = Math.min(n, avail.length);
      const low = Math.min(e.min ?? pick, pick);
      let picks: number[];
      if (e.random) {
        picks = g.rng.shuffle(avail.map(({ i }) => i)).slice(0, pick);
        g.log(`Mode chosen at random: ${picks.map((i) => e.options[i].text).join(', ')}.`);
      } else {
        const resp = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Choose ${low === pick ? pick : `up to ${pick}`}`, options: avail.map(({ o, i }) => ({ id: String(i), label: o.text })), min: low, max: pick, sourceId: ctx.sourceId ?? undefined });
        picks = resp.type === 'options' ? resp.ids.map(Number) : low === 0 ? [] : [avail[0].i];
      }
      if (e.notChosen && src) src.memory[usedKey] = [...used, ...picks];
      for (const i of picks) yield* executeEffects(g, e.options[i].effects, ctx);
      return;
    }
    case 'delayedTrigger': {
      // "When that creature dies this turn": watch the specific objects the sentence refers to.
      if (e.filter?.objectRef) {
        const ids = g.resolveObjects(e.filter.objectRef, ctx).map((o) => o.id);
        const { objectRef: _o, ...rest } = e.filter;
        void _o;
        g.state.delayedTriggers.push({ id: g.state.nextEffectId++, event: e.event, filter: rest, effects: e.effects, text: e.text, controller: ctx.controller, sourceId: ctx.sourceId ?? -1, once: e.once ?? true, context: { ...ctx.triggerContext, watchIds: ids } });
        return;
      }
      // A delayed trigger about "this object" stops applying once it changes zones.
      g.state.delayedTriggers.push({ id: g.state.nextEffectId++, event: e.event, filter: e.filter, effects: e.effects, text: e.text, controller: ctx.controller, sourceId: ctx.sourceId ?? -1, once: e.untilEndOfTurn ? false : e.once ?? true, thisTurn: e.untilEndOfTurn, context: { ...ctx.triggerContext, delayedTargets: ctx.targets, delayedMemory: { ...ctx.memory } } , sourceZone: JSON.stringify(e.effects).includes('"ref":"self"') && ctx.sourceId != null ? g.state.objects[ctx.sourceId]?.zone : undefined });
      return;
    }
    case 'log':
      if (e.event) {
        const who = e.objectRef ? g.resolveObjects(e.objectRef, ctx)[0] : undefined;
        g.emit({ name: e.event, objectId: who?.id, playerId: who ? who.controller : ctx.controller, sourceId: ctx.sourceId ?? undefined });
      } else g.log(e.text);
      return;
    case 'ventureIntoDungeon':
      yield* venture(g, ctx.controller, ctx, ctx.triggerContext['dungeon'] as string | undefined);
      g.emit({ name: 'ventured', playerId: ctx.controller, sourceId: ctx.sourceId ?? undefined });
      return;
    case 'takeInitiative':
      for (const p of playersOf(g, e.who, ctx)) {
        if (g.state.initiative !== p) {
          g.state.initiative = p;
          g.log(`${g.player(p).name} takes the initiative.`);
          g.emit({ name: 'takesInitiative', playerId: p });
        }
        yield* venture(g, p, ctx, 'Undercity');
      }
      return;
    case 'ringTempts':
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        pl.ringLevel = Math.min(4, pl.ringLevel + 1);
        g.log(`The Ring tempts ${pl.name} (level ${pl.ringLevel}).`);
        const cands = g.state.battlefield.filter((id) => g.obj(id).controller === p && g.characteristics(id).types.includes('Creature'));
        if (cands.length) {
          let pick = cands[0];
          if (cands.length > 1) {
            const r = yield* g.ask({ type: 'chooseObjects', player: p, prompt: 'The Ring tempts you: choose your Ring-bearer', candidates: cands, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
            if (r.type === 'objects') pick = r.ids[0];
          }
          // Only one Ring-bearer at a time.
          g.state.continuousEffects = g.state.continuousEffects.filter((ce) => !(ce.controller === p && ce.modification.layer === 'rule' && ce.modification.rule.kind === 'custom' && ce.modification.rule.tag === 'ringBearer'));
          g.addContinuousEffect({ sourceId: null, controller: p, fromStatic: false, affected: { kind: 'fixed', ids: [pick] }, duration: 'permanent', modification: { layer: 'rule', rule: { kind: 'custom', tag: 'ringBearer' } } });
          g.log(`${g.nameOf(pick)} is ${pl.name}'s Ring-bearer.`);
        }
        g.touch();
        g.emit({ name: 'ringTempted', playerId: p });
      }
      return;
    case 'investigate': {
      const n = e.count !== undefined ? amt(e.count) : 1;
      for (const p of playersOf(g, e.who, ctx)) {
        for (let i = 0; i < n; i++) g.createObject(tokenCard({ preset: 'Clue', name: 'Clue', typeLine: '', colors: [] }, g, ctx), p, 'battlefield');
        if (n > 0) g.emit({ name: 'investigated', playerId: p, amount: n, sourceId: ctx.sourceId ?? undefined });
      }
      return;
    }
    case 'treasure': {
      const n = e.count !== undefined ? amt(e.count) : 1;
      for (const p of playersOf(g, e.who, ctx)) for (let i = 0; i < n; i++) g.createObject(tokenCard({ preset: 'Treasure', name: 'Treasure', typeLine: '', colors: [] }, g, ctx), p, 'battlefield');
      return;
    }
    case 'phaseOut':
      for (const o of g.resolveObjects(e.what, ctx)) {
        o.phasedOut = true;
        g.emit({ name: 'phasedOut', objectId: o.id, playerId: o.controller });
        g.touch();
      }
      return;
    case 'exchangeLife': {
      const a = g.resolvePlayers(e.a, ctx)[0];
      const b = g.resolvePlayers(e.b, ctx)[0];
      if (!a || !b) return;
      const la = g.player(a).life;
      const lb = g.player(b).life;
      g.player(a).life = lb;
      g.player(b).life = la;
      g.touch();
      g.log(`${g.player(a).name} and ${g.player(b).name} exchange life totals.`);
      return;
    }
    case 'skipTurn':
      for (const p of g.resolvePlayers(e.who, ctx)) g.player(p).flags['skipNextTurn'] = true;
      return;
    case 'explore':
      for (const o of g.resolveObjects(e.what, ctx)) {
        if (o.zone !== 'battlefield') continue;
        const pl = g.player(o.controller);
        if (!pl.library.length) continue;
        const top = pl.library[0];
        g.log(`${g.player(o.controller).name} explores and reveals ${g.nameOf(top)}.`, { kind: 'reveal', data: { ids: [top] } });
        if (g.characteristics(top).types.includes('Land')) {
          g.moveObject(top, 'hand');
        } else {
          g.addCounters(o.id, '+1/+1', 1);
          const r = yield* g.ask({ type: 'yesNo', player: o.controller, prompt: `Put ${g.nameOf(top)} into your graveyard?`, sourceId: ctx.sourceId ?? undefined });
          if (r.type === 'yesNo' && r.value) g.moveObject(top, 'graveyard');
        }
        g.emit({ name: 'explored', playerId: o.controller, objectId: o.id, sourceId: ctx.sourceId ?? undefined });
      }
      return;
    case 'loseAllCounters':
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        if (e.counter === 'all') {
          pl.poison = 0;
          pl.energy = 0;
          pl.experience = 0;
        } else if (e.counter === 'poison') pl.poison = 0;
        else if (e.counter === 'energy') pl.energy = 0;
        else if (e.counter === 'experience') pl.experience = 0;
        else pl.turnStats[e.counter] = 0;
        g.log(`${pl.name} loses all ${e.counter} counters.`);
      }
      return;
    case 'skipStep':
      for (const p of playersOf(g, e.who, ctx)) {
        if (p === g.state.turn.activePlayer) g.state.turn.skipSteps.push(e.step as import('./types.js').Step);
        else g.player(p).flags[`skipStep:${e.step}`] = true;
        g.log(`${g.player(p).name} skips their ${e.step} step.`);
      }
      return;
    case 'monstrosity': {
      const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
      if (!src || src.zone !== 'battlefield' || src.memory['monstrous']) return;
      g.addCounters(src.id, '+1/+1', amt(e.amount), src.id);
      src.memory['monstrous'] = true;
      g.log(`${g.nameOf(src.id)} becomes monstrous.`);
      g.emit({ name: 'becomesMonstrous', objectId: src.id, playerId: src.controller });
      return;
    }
    case 'foretell': {
      const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
      if (!src) return;
      const moved = src.zone === 'exile' ? src : g.moveObject(src.id, 'exile', { cause: 'exile', sourceId: src.id });
      if (!moved) return;
      moved.faceDown = true;
      Object.assign(moved.memory, { foretold: true, foretoldTurn: g.state.turn.number, foretellCost: e.cost, playableBy: ctx.controller, playableUntil: 'permanent' });
      g.emit({ name: 'foretold', objectId: moved.id, playerId: ctx.controller });
      g.log(`${g.player(ctx.controller).name} foretells a card.`);
      return;
    }
    case 'plot': {
      const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
      if (!src) return;
      const moved = src.zone === 'exile' ? src : g.moveObject(src.id, 'exile', { cause: 'exile', sourceId: src.id });
      if (!moved) return;
      g.emit({ name: 'plotted', objectId: moved.id, playerId: ctx.controller });
      Object.assign(moved.memory, { plotted: g.state.turn.number, playableBy: ctx.controller, playableUntil: 'permanent', freeCast: true, sorceryOnly: true });
      g.log(`${g.player(ctx.controller).name} plots ${g.nameOf(moved.id)}.`);
      return;
    }
    case 'manual':
      yield* g.ask({ type: 'manualTrigger', player: ctx.controller, prompt: e.text, text: e.text, objectId: ctx.sourceId ?? -1, sourceId: ctx.sourceId ?? undefined });
      return;
  }
}

function card_name(t: TokenSpec): string {
  return t.name || (t.preset ? TOKEN_PRESETS[t.preset]?.name : undefined) || 'token';
}

function setMemory(g: Game, ctx: EffectContext, key: string, value: unknown) {
  ctx.memory[key] = value;
  if (ctx.sourceId !== null && g.state.objects[ctx.sourceId]) {
    g.state.objects[ctx.sourceId].memory[key] = value;
    g.state.objects[ctx.sourceId].chosen[key] = value;
  }
}

/** Short human description of a list of effects (for prompts). */
export function describe(effects: Effect[]): string {
  return effects
    .map((e) => {
      switch (e.kind) {
        case 'draw':
          return `draw ${typeof e.amount === 'number' ? e.amount : 'X'}`;
        case 'gainLife':
          return `gain ${typeof e.amount === 'number' ? e.amount : 'X'} life`;
        case 'loseLife':
          return `lose ${typeof e.amount === 'number' ? e.amount : 'X'} life`;
        case 'damage':
          return `deal ${typeof e.amount === 'number' ? e.amount : 'X'} damage`;
        case 'createToken':
          return `create ${card_name(e.token)} token(s)`;
        case 'addCounters':
          return `put ${e.counter} counter(s)`;
        case 'manual':
          return e.text;
        default:
          return e.kind;
      }
    })
    .join(', ');
}

/** Remove a creature from combat (CR 506.4): it stops attacking/blocking and everything it was paired with forgets it. */
export function removeFromCombat(g: Game, o: GameObject) {
  o.attacking = null;
  o.blocking = [];
  o.blockedBy = [];
  g.state.turn.attackers = g.state.turn.attackers.filter((id) => id !== o.id);
  for (const other of g.state.battlefield) {
    const a = g.state.objects[other];
    if (a) {
      a.blockedBy = a.blockedBy.filter((id) => id !== o.id);
      a.blocking = a.blocking.filter((id) => id !== o.id);
    }
  }
}

export function destroyObject(g: Game, id: ObjectId, sourceId: ObjectId | null, cantRegenerate = false) {
  const o = g.state.objects[id];
  if (!o || o.zone !== 'battlefield') return;
  const ch = g.characteristics(id);
  if (ch.keywords.has('Indestructible')) {
    g.log(`${g.nameOf(id)} is indestructible.`);
    return;
  }
  if (ch.rules.some((r) => r.kind === 'custom' && (r.tag === 'cantRegenerate' || r.tag === 'cantBeRegenerated'))) cantRegenerate = true;
  if (!cantRegenerate) {
    const shieldIdx = g.state.continuousEffects.findIndex((ce) => ce.modification.layer === 'rule' && ce.modification.rule.kind === 'custom' && ce.modification.rule.tag === 'regenerationShield' && ce.affected.kind === 'fixed' && ce.affected.ids.includes(id));
    if (shieldIdx >= 0) {
      g.state.continuousEffects.splice(shieldIdx, 1);
      o.tapped = true;
      o.damage = 0;
      o.deathtouchDamage = false;
      removeFromCombat(g, o); // CR 701.15a
      g.touch();
      g.log(`${g.nameOf(id)} regenerates.`);
      return;
    }
  }
  g.log(`${g.nameOf(id)} is destroyed.`);
  g.moveObject(id, 'graveyard', { cause: 'destroy', sourceId: sourceId ?? undefined });
}

/** Where a spell card goes when it leaves the stack without being put somewhere specific: flashback and
 * 'exile it instead' permissions exile it wherever it would go (CR 702.34a). */
export function leaveStackDestination(g: Game, obj: GameObject): 'graveyard' | 'exile' {
  return obj.castFromZone === 'graveyard' || obj.memory['exileOnResolve'] ? 'exile' : 'graveyard';
}

export function counterStackItem(g: Game, stackId: number, toZone: 'graveyard' | 'exile' | 'hand' | 'libraryTop' | 'libraryBottom' = 'graveyard') {
  const item = g.state.stack.find((s) => s.id === stackId);
  if (!item) return;
  g.rememberStackItem(item);
  g.state.stack = g.state.stack.filter((s) => s.id !== stackId);
  g.log(`${item.text} is countered.`);
  if (item.kind === 'spell' && !item.copiedCard) {
    const o = g.state.objects[item.sourceId];
    if (o && o.zone === 'stack') {
      if (toZone === 'hand') g.moveObject(item.sourceId, 'hand', { cause: 'countered' });
      else if (toZone === 'libraryTop' || toZone === 'libraryBottom') g.moveObject(item.sourceId, 'library', { cause: 'countered', position: toZone === 'libraryTop' ? 'top' : 'bottom' });
      else g.moveObject(item.sourceId, toZone === 'graveyard' ? leaveStackDestination(g, o) : toZone, { cause: 'countered' });
    }
  }
  g.emit({ name: 'countered', objectId: item.sourceId, playerId: item.controller });
  g.touch();
}

export function attach(g: Game, whatId: ObjectId, toId: ObjectId) {
  const what = g.obj(whatId);
  const wasOn = what.attachedTo;
  if (what.attachedTo !== null) {
    const host = g.state.objects[what.attachedTo];
    if (host) host.attachments = host.attachments.filter((x) => x !== whatId);
  }
  what.attachedTo = toId;
  if (wasOn !== toId) what.attachedTimestamp = g.now(); // CR 613.7e
  const to = g.obj(toId);
  if (!to.attachments.includes(whatId)) to.attachments.push(whatId);
  g.touch();
  if (wasOn !== toId) g.emit({ name: 'becomesAttached', objectId: whatId, sourceId: toId, playerId: what.controller });
}

/**
 * Put an object onto the battlefield applying "enters" replacement effects
 * from its own script (enters tapped, with counters, choices) and from other
 * permanents (e.g. "creatures your opponents control enter tapped").
 */
export function* enterBattlefield(g: Game, id: ObjectId, controller: PlayerId, opts: { tapped?: boolean; counters?: Record<string, number>; ctx?: EffectContext; attacking?: PlayerId | ObjectId; fromStack?: boolean; faceDown?: boolean } = {}): Gen<GameObject | null> {
  const o = g.state.objects[id];
  if (!o) return null;
  // "Creature cards in graveyards and libraries can't enter the battlefield." (Grafdigger's Cage)
  for (const r of g.playerRules(controller)) {
    if (r.kind !== 'custom' || r.tag !== 'cantEnterFromZone') continue;
    const d = (r.data as { filter?: import('./types.js').ObjectFilter; zones?: string[] } | undefined) ?? {};
    if (d.zones && !d.zones.includes(o.zone)) continue;
    if (d.filter && !matchesFilter(g, o, { ...d.filter, zone: undefined }, { sourceId: null, controller })) continue;
    return null;
  }
  const script = g.scriptFor(o);
  let tapped = opts.tapped ?? false;
  // "Lands you control enter untapped." overrides an "enters tapped" replacement.
  let forceUntapped = false;
  for (const r of g.playerRules(controller)) {
    if (r.kind !== 'custom' || r.tag !== 'entersUntapped') continue;
    const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter;
    if (!f || matchesFilter(g, o, { ...f, zone: undefined }, { sourceId: null, controller })) forceUntapped = true;
  }
  const extraEnterCounters: { counter: string; amount: number }[] = [];
  for (const r of g.playerRules(controller)) {
    if (r.kind !== 'custom' || r.tag !== 'extraEnterCounters') continue;
    const d = (r.data as { filter?: import('./types.js').ObjectFilter; counter?: string; amount?: number } | undefined) ?? {};
    if (d.filter && !matchesFilter(g, o, { ...d.filter, zone: undefined }, { sourceId: null, controller })) continue;
    extraEnterCounters.push({ counter: d.counter ?? '+1/+1', amount: d.amount ?? 1 });
  }
  const counters: Record<string, number> = { ...(opts.counters ?? {}) };
  const chosen: Record<string, unknown> = {};
  const ectx: EffectContext = { sourceId: id, controller, targets: [], triggerContext: {}, x: o.xValue ?? 0, modes: o.modes ?? [], memory: {} };
  for (const ab of script.abilities) {
    if (ab.kind !== 'replacement' || ab.event !== 'entersBattlefield' || !ab.self) continue;
    if (ab.condition && !g.checkCondition(ab.condition, { sourceId: id, controller })) continue;
    if (ab.enterAsCopy) {
      const f = ab.enterAsCopy;
      const cands = objectsMatching(g, f, { sourceId: id, controller }, f.zone ? undefined : ['battlefield']).filter((c) => c.id !== id).map((c) => c.id);
      if (cands.length) {
        const r = yield* g.ask({ type: 'chooseObjects', player: controller, prompt: `${o.card.name}: enter as a copy of${ab.enterAsCopyOptional ? ' (or choose none)' : ''}`, candidates: cands, min: ab.enterAsCopyOptional ? 0 : 1, max: 1, sourceId: id });
        const pick = r.type === 'objects' ? r.ids[0] : undefined;
        if (pick !== undefined) {
          const src = g.obj(pick);
          o.copyOf = applyCopyExceptions(src.copyOf ?? src.card, ab.copyExceptions);
          o.faceIndex = 0;
          const exc = ab.copyExceptions?.counters;
          if (exc) o.counters[exc.counter] = (o.counters[exc.counter] ?? 0) + exc.amount;
          g.log(`${o.card.name} enters as a copy of ${g.nameOf(pick)}.`);
        }
      }
    }
    if (ab.tribute) {
      const opps = g.opponentsOf(controller);
      if (opps.length) {
        let opp = opps[0];
        if (opps.length > 1) {
          const r = yield* g.ask({ type: 'chooseOption', player: controller, prompt: `${o.card.name}: choose an opponent for tribute`, options: opps.map((p) => ({ id: p, label: g.player(p).name })), min: 1, max: 1, sourceId: id });
          if (r.type === 'options' && r.ids[0]) opp = r.ids[0] as typeof opp;
        }
        const r = yield* g.ask({ type: 'yesNo', player: opp, prompt: `Tribute ${ab.tribute}: put ${ab.tribute} +1/+1 counter${ab.tribute === 1 ? '' : 's'} on ${o.card.name}?`, sourceId: id });
        if (r.type === 'yesNo' && r.value) {
          counters['+1/+1'] = (counters['+1/+1'] ?? 0) + ab.tribute;
          o.memory['tributePaid'] = true;
          g.log(`${g.player(opp).name} pays tribute to ${o.card.name}.`);
        }
      }
    }
    if (ab.devour) {
      const cands = g.state.battlefield.filter((cid) => {
        const c2 = g.state.objects[cid];
        return !!c2 && c2.controller === controller && cid !== id && g.characteristics(cid).types.includes('Creature');
      });
      if (cands.length) {
        const r = yield* g.ask({ type: 'chooseObjects', player: controller, prompt: `Devour ${ab.devour}: sacrifice any number of creatures`, candidates: cands, min: 0, max: cands.length, sourceId: id });
        const picks = r.type === 'objects' ? r.ids : [];
        if (picks.length) {
          g.simultaneousZoneChange(() => {
            for (const pid of picks) if (g.state.objects[pid]?.zone === 'battlefield') g.moveObject(pid, 'graveyard', { cause: 'sacrifice', sourceId: id });
          });
          counters['+1/+1'] = (counters['+1/+1'] ?? 0) + ab.devour * picks.length;
          o.memory['devoured'] = picks.length;
          g.log(`${o.card.name} devours ${picks.length} creature${picks.length === 1 ? '' : 's'}.`);
        }
      }
    }
    if (ab.tapped && !(ab.unless && g.checkCondition(ab.unless, { sourceId: id, controller }))) tapped = true;
    if (ab.payLifeOrTapped !== undefined) {
      let paid = false;
      if (g.player(controller).life >= ab.payLifeOrTapped) {
        const r = yield* g.ask({ type: 'yesNo', player: controller, prompt: `${o.card.name}: pay ${ab.payLifeOrTapped} life to have it enter untapped?`, yesLabel: `Pay ${ab.payLifeOrTapped} life`, noLabel: 'Enter tapped', sourceId: id });
        paid = r.type === 'yesNo' && r.value;
      }
      if (paid) g.loseLife(controller, ab.payLifeOrTapped, id);
      else tapped = true;
    }
    if (ab.counters) counters[ab.counters.counter] = (counters[ab.counters.counter] ?? 0) + g.resolveAmount(ab.counters.amount, ectx);
    if (ab.countersList) for (const c of ab.countersList) counters[c.counter] = (counters[c.counter] ?? 0) + g.resolveAmount(c.amount, ectx);
    if (ab.counterChoice) {
      const { from, count } = ab.counterChoice;
      const r = yield* g.ask({ type: 'chooseOption', player: controller, prompt: `${o.card.name}: choose ${count} kind${count === 1 ? '' : 's'} of counter`, options: from.map((c) => ({ id: c, label: `${c} counter` })), min: count, max: count, sourceId: id });
      const picks = r.type === 'options' && r.ids.length ? r.ids : from.slice(0, count);
      for (const c of picks) counters[c] = (counters[c] ?? 0) + 1;
    }
    const chooser = ab.chooseByOpponent ? g.opponentsOf(controller)[0] ?? controller : controller;
    if (ab.choose === 'color') {
      const resp = yield* g.ask({ type: 'chooseOption', player: chooser, prompt: `${o.card.name}: choose a color`, options: COLORS.map((c) => ({ id: c, label: c })), min: 1, max: 1, sourceId: id });
      chosen[ab.chooseKey ?? 'color'] = resp.type === 'options' ? resp.ids[0] : 'W';
    } else if (ab.choose === 'opponent') {
      const opps = g.opponentsOf(controller);
      let pick = opps[0];
      if (opps.length > 1) {
        const resp = yield* g.ask({ type: 'chooseOption', player: controller, prompt: `${o.card.name}: choose an opponent`, options: opps.map((p) => ({ id: p, label: g.player(p).name })), min: 1, max: 1, sourceId: id });
        if (resp.type === 'options') pick = resp.ids[0];
      }
      chosen[ab.chooseKey ?? 'opponent'] = pick;
    } else if (ab.choose === 'creatureType') {
      yield* executeEffect(g, { kind: 'chooseCreatureType', key: ab.chooseKey ?? 'creatureType' }, ab.chooseByOpponent ? { ...ectx, controller: chooser } : ectx);
      chosen[ab.chooseKey ?? 'creatureType'] = ectx.memory[ab.chooseKey ?? 'creatureType'];
    } else if (ab.choose === 'cardName') {
      yield* executeEffect(g, { kind: 'nameCard', key: ab.chooseKey ?? 'cardName' }, ectx);
      chosen[ab.chooseKey ?? 'cardName'] = ectx.memory[ab.chooseKey ?? 'cardName'];
    } else if (ab.choose === 'player') {
      yield* executeEffect(g, { kind: 'choosePlayer', key: ab.chooseKey ?? 'player', who: 'any' }, ectx);
      chosen[ab.chooseKey ?? 'player'] = ectx.memory[ab.chooseKey ?? 'player'];
    } else if (ab.choose === 'number') {
      const r = yield* g.ask({ type: 'chooseNumber', player: controller, prompt: `${o.card.name}: choose a number`, min: 0, max: 30, sourceId: id });
      chosen[ab.chooseKey ?? 'number'] = r.type === 'number' ? r.value : 0;
    } else if (ab.chooseObject) {
      const cands = objectsMatching(g, { ...ab.chooseObject, zone: ab.chooseObject.zone ?? 'battlefield' }, { sourceId: id, controller }).filter((c) => c.id !== id).map((c) => c.id);
      if (cands.length) {
        const r = yield* g.ask({ type: 'chooseObjects', player: controller, prompt: `${o.card.name}: choose`, candidates: cands, min: 1, max: 1, sourceId: id });
        const pick = r.type === 'objects' ? r.ids[0] : cands[0];
        if (pick !== undefined) chosen[ab.chooseKey ?? 'chosen'] = pick;
      }
    } else if (ab.choose === 'option' && ab.chooseOptions?.length) {
      if (ab.chooseAtRandom) {
        chosen[ab.chooseKey ?? 'choice'] = ab.chooseOptions[g.rng.int(ab.chooseOptions.length)];
      } else {
        const r = yield* g.ask({ type: 'chooseOption', player: chooser, prompt: `${o.card.name}: choose`, options: ab.chooseOptions.map((x) => ({ id: x, label: x })), min: 1, max: 1, sourceId: id });
        chosen[ab.chooseKey ?? 'choice'] = r.type === 'options' ? r.ids[0] : ab.chooseOptions[0];
      }
    }
    // "As ~ enters, <effects>": run them before the permanent is on the battlefield.
    if (ab.effects?.length) {
      yield* executeEffects(g, ab.effects, ectx);
      Object.assign(chosen, ectx.memory);
    }
  }
  // Other permanents' ETB replacements (e.g. "Artifacts enter tapped").
  for (const src of g.state.battlefield.map((x) => g.obj(x))) {
    for (const ab of g.scriptFor(src).abilities) {
      if (ab.kind !== 'replacement' || ab.event !== 'entersBattlefield' || ab.self) continue;
      if (!matchesFilter(g, o, { ...ab.filter, zone: undefined }, { sourceId: src.id, controller: src.controller })) continue;
      if (ab.tapped) tapped = true;
      if (ab.counters) counters[ab.counters.counter] = (counters[ab.counters.counter] ?? 0) + g.resolveAmount(ab.counters.amount, { ...ectx, sourceId: src.id, controller: src.controller });
    }
  }
  for (const x of extraEnterCounters) counters[x.counter] = (counters[x.counter] ?? 0) + x.amount;
  // Auras must be attached to something as they enter.
  const ch = g.characteristics(id);
  let attachTo: ObjectId | null = null;
  if (ch.types.includes('Enchantment') && ch.subtypes.includes('Aura') && !opts.fromStack) {
    const spec = auraTargetSpec(o.card.oracleText);
    const legal = legalTargets(g, spec, id, controller).filter((t) => t.kind === 'object') as { kind: 'object'; id: ObjectId }[];
    if (!legal.length) {
      g.log(`${o.card.name} has nothing to enchant and stays where it is.`);
      return null;
    }
    let pick = legal[0].id;
    if (legal.length > 1) {
      const resp = yield* g.ask({ type: 'chooseObjects', player: controller, prompt: `${o.card.name}: choose what to enchant`, candidates: legal.map((l) => l.id), min: 1, max: 1, sourceId: id });
      if (resp.type === 'objects') pick = resp.ids[0];
    }
    attachTo = pick;
  }
  const result = g.moveObject(id, 'battlefield', { tapped: forceUntapped ? false : tapped, controller, counters, attackingFor: opts.attacking, cause: opts.fromStack ? 'resolve' : 'other', faceDown: opts.faceDown });
  if (!result) return null;
  Object.assign(result.chosen, chosen);
  Object.assign(result.memory, chosen);
  if (attachTo !== null) attach(g, id, attachTo);
  yield* offerSoulbond(g, result.id, controller);
  return result;
}

/** Soulbond: when a creature enters, it may pair with an unpaired creature its controller controls. */
function* offerSoulbond(g: Game, id: ObjectId, controller: PlayerId): Gen<void> {
  const o = g.state.objects[id];
  if (!o || o.zone !== 'battlefield') return;
  const ch = g.characteristics(id);
  if (!ch.types.includes('Creature')) return;
  const unpaired = (x: ObjectId): boolean => {
    const t = g.state.objects[x];
    return !!t && t.zone === 'battlefield' && (t.pairedWith === null || t.pairedWith === undefined || !g.state.objects[t.pairedWith] || g.state.objects[t.pairedWith].zone !== 'battlefield');
  };
  const mine = objectsMatching(g, { types: ['Creature'], controller: 'you', zone: 'battlefield' }, { sourceId: id, controller }).map((x) => x.id).filter((x) => x !== id && unpaired(x));
  const selfBonds = ch.keywords.has('Soulbond');
  const cands = selfBonds ? mine : mine.filter((x) => g.characteristics(x).keywords.has('Soulbond'));
  if (!cands.length || !unpaired(id)) return;
  const r = yield* g.ask({ type: 'yesNo', player: controller, prompt: `Soulbond: pair ${g.nameOf(id)} with another creature?`, sourceId: id });
  if (!(r.type === 'yesNo' && r.value)) return;
  let pick = cands[0];
  if (cands.length > 1) {
    const c = yield* g.ask({ type: 'chooseObjects', player: controller, prompt: 'Pair with which creature?', candidates: cands, min: 1, max: 1, sourceId: id });
    if (c.type !== 'objects' || !c.ids.length) return;
    pick = c.ids[0];
  }
  o.pairedWith = pick;
  const other = g.state.objects[pick];
  if (other) other.pairedWith = id;
  g.log(`${g.nameOf(id)} is paired with ${g.nameOf(pick)}.`);
  g.touch();
}

/** Aura "Enchant X" → target spec. */
export function auraTargetSpec(text: string) {
  const m = text.match(/^Enchant ([^\n]+)/m);
  const what = (m?.[1] ?? 'creature').toLowerCase().trim();
  const filter: import('./types.js').ObjectFilter = { zone: 'battlefield' };
  if (what.includes('creature')) filter.types = ['Creature'];
  else if (what.includes('land')) filter.types = ['Land'];
  else if (what.includes('artifact')) filter.types = ['Artifact'];
  else if (what.includes('enchantment')) filter.types = ['Enchantment'];
  else if (what.includes('planeswalker')) filter.types = ['Planeswalker'];
  else if (what === 'permanent') {
    /* any permanent */
  } else if (what.includes('player')) return { description: 'enchant player', kind: 'player' as const, playerFilter: 'any' as const };
  if (what.includes('you control')) filter.controller = 'you';
  if (what.includes('opponent controls') || what.includes("an opponent controls")) filter.controller = 'opponent';
  return { description: `enchant ${what}`, kind: 'object' as const, filter };
}

export function* scry(g: Game, p: PlayerId, n: number): Gen {
  const pl = g.player(p);
  const top = pl.library.slice(0, Math.min(n, pl.library.length));
  if (!top.length) return;
  const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Scry ${n}: choose cards to put on the BOTTOM (the rest stay on top)`, candidates: top, min: 0, max: top.length, revealToChooser: true });
  const bottom = resp.type === 'objects' ? resp.ids : [];
  const keep = top.filter((id) => !bottom.includes(id));
  let order = keep;
  if (keep.length > 1) {
    const r2 = yield* g.ask({ type: 'orderObjects', player: p, prompt: 'Order the cards staying on top (first = top)', objectIds: keep, context: 'libraryTop' });
    if (r2.type === 'order') order = r2.ids;
  }
  pl.library.splice(0, top.length, ...order);
  for (const id of bottom) pl.library.push(id);
  g.touch();
  g.log(`${pl.name} scries ${n} (${bottom.length} to the bottom).`);
  g.emit({ name: 'scry', playerId: p, amount: n });
}

export function* surveil(g: Game, p: PlayerId, n: number): Gen {
  const pl = g.player(p);
  const top = pl.library.slice(0, Math.min(n, pl.library.length));
  if (!top.length) return;
  const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Surveil ${n}: choose cards to put into your GRAVEYARD`, candidates: top, min: 0, max: top.length, revealToChooser: true });
  const gy = resp.type === 'objects' ? resp.ids : [];
  const keep = top.filter((id) => !gy.includes(id));
  let order = keep;
  if (keep.length > 1) {
    const r2 = yield* g.ask({ type: 'orderObjects', player: p, prompt: 'Order the cards staying on top (first = top)', objectIds: keep, context: 'libraryTop' });
    if (r2.type === 'order') order = r2.ids;
  }
  pl.library.splice(0, top.length, ...order);
  for (const id of gy) g.moveObject(id, 'graveyard', { cause: 'mill' });
  g.touch();
  g.log(`${pl.name} surveils ${n}.`);
}

/** Offer a player the chance to pay a mana cost. Returns true if paid. */
export function* offerToPay(g: Game, p: PlayerId, cost: string, prompt: string): Gen<boolean> {
  const parsed = parseManaCost(cost);
  const sources = manaSourcesFor(g, p);
  const solution = solvePayment(parsed, 0, g.player(p).manaPool, sources);
  if (!solution) return false;
  const resp = yield* g.ask({ type: 'yesNo', player: p, prompt });
  if (resp.type !== 'yesNo' || !resp.value) return false;
  const ok = yield* payCost(g, p, parsed, 0, null);
  return ok;
}

function await_casting(): typeof import('./casting.js') {
  return castingModule;
}
import * as castingModule from './casting.js';

/** Venture into a dungeon: enter the next room and run its effect. */
export function* venture(g: Game, p: PlayerId, ctx: EffectContext, forced?: string): Gen {
  const pl = g.player(p);
  let room: import('./dungeons.js').Room;
  if (!pl.dungeon) {
    let name = forced;
    if (!name) {
      const options = Object.keys(DUNGEONS).filter((d) => d !== 'Undercity').map((d) => ({ id: d, label: d }));
      const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: 'Venture: choose a dungeon to enter', options, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      name = r.type === 'options' ? r.ids[0] : options[0].id;
    }
    const dungeon = DUNGEONS[name] ?? DUNGEONS['Lost Mine of Phandelver'];
    room = dungeon.rooms[dungeon.start];
    pl.dungeon = { name: dungeon.name, room: room.name };
  } else {
    const dungeon = DUNGEONS[pl.dungeon.name];
    const current = dungeon.rooms[pl.dungeon.room];
    let nextName = current.next[0];
    if (current.next.length > 1) {
      const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: `${dungeon.name}: choose the next room`, options: current.next.map((n) => ({ id: n, label: n })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      if (r.type === 'options') nextName = r.ids[0];
    }
    room = dungeon.rooms[nextName];
    pl.dungeon.room = room.name;
  }
  g.touch();
  g.log(`${pl.name} ventures into ${pl.dungeon.name}: ${room.name}.`, { kind: 'venture', data: { player: p, dungeon: pl.dungeon.name, room: room.name } });
  g.emit({ name: 'ventures', playerId: p, data: { room: room.name } });
  const roomCtx: EffectContext = { ...ctx, controller: p, targets: [], memory: { ...ctx.memory } };
  if (room.name === 'Trap!') {
    const opps = g.opponentsOf(p);
    let target = opps[0];
    if (opps.length > 1) {
      const r = yield* g.ask({ type: 'chooseOption', player: p, prompt: 'Trap!: choose a player to lose 5 life', options: opps.map((o) => ({ id: o, label: g.player(o).name })), min: 1, max: 1 });
      if (r.type === 'options') target = r.ids[0];
    }
    roomCtx.memory['trapTarget'] = target;
  }
  yield* executeEffects(g, room.effects, roomCtx);
  if (room.next.length === 0) {
    pl.dungeon = null;
    pl.dungeonsCompleted++;
    g.log(`${pl.name} completes the dungeon.`);
    g.emit({ name: 'dungeonCompleted', playerId: p });
  }
}
