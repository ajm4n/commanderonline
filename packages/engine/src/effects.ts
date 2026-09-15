/**
 * Effect executor: interprets script Effects against the game.
 */
import type { Game, Gen } from './game.js';
import type { CardData, GameObject, ObjectId, PlayerId, Target, ZoneName, ManaColor, Color, ContinuousEffect } from './types.js';
import { COLORS } from './types.js';
import type { Effect, Ref, TokenSpec, Duration, Amount } from './script.js';
import { TOKEN_PRESETS } from './tokens.js';
import { matchesFilter, objectsMatching, legalTargets } from './filters.js';
import { parseManaCost, solvePayment } from './mana.js';
import { manaSourcesFor, payCost } from './casting.js';

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

export function tokenCard(spec: TokenSpec, g: Game, ctx: EffectContext): CardData {
  const preset = spec.preset ? TOKEN_PRESETS[spec.preset] : undefined;
  const merged: TokenSpec = { ...(preset ?? {}), ...spec, name: spec.name || preset?.name || 'Token', typeLine: spec.typeLine || preset?.typeLine || 'Creature', colors: spec.colors ?? preset?.colors ?? [] };
  if (spec.copyOf) {
    const src = g.resolveObjects(spec.copyOf, ctx)[0];
    if (src) {
      const ch = g.characteristics(src.id);
      const base = src.copyOf ?? src.card;
      return { ...base, isToken: true, oracleId: base.oracleId, name: ch.name || base.name, keywords: [...ch.keywords, ...(spec.exceptions?.keywords ?? [])] };
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

function playersOf(g: Game, ref: Ref | undefined, ctx: EffectContext): PlayerId[] {
  return ref ? g.resolvePlayers(ref, ctx) : [ctx.controller];
}

export function* executeEffect(g: Game, e: Effect, ctx: EffectContext): Gen {
  const amt = (a: Amount) => g.resolveAmount(a, ctx);
  switch (e.kind) {
    case 'draw':
      for (const p of playersOf(g, e.who, ctx)) g.drawCards(p, amt(e.amount));
      return;
    case 'gainLife':
      for (const p of playersOf(g, e.who, ctx)) g.gainLife(p, amt(e.amount), ctx.sourceId ?? undefined);
      return;
    case 'loseLife':
      for (const p of playersOf(g, e.who, ctx)) g.loseLife(p, amt(e.amount), ctx.sourceId ?? undefined);
      return;
    case 'setLife':
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = amt(e.amount);
        if (n > pl.life) g.gainLife(p, n - pl.life);
        else if (n < pl.life) g.loseLife(p, pl.life - n);
      }
      return;
    case 'damage': {
      const targets = g.resolveRef(e.to, ctx);
      const source = e.source ? g.resolveObjects(e.source, ctx)[0]?.id ?? ctx.sourceId : ctx.sourceId;
      const total = amt(e.amount);
      if (e.divided && targets.length > 1) {
        const resp = yield* g.ask({ type: 'distribute', player: ctx.controller, prompt: `Divide ${total} damage`, amount: total, targets, minPer: 1, sourceId: ctx.sourceId ?? undefined });
        const amounts = resp.type === 'distribute' ? resp.amounts : targets.map((_, i) => (i === 0 ? total : 0));
        targets.forEach((t, i) => g.dealDamage(source, t, amounts[i], false));
      } else for (const t of targets) g.dealDamage(source, t, total, false);
      return;
    }
    case 'destroy':
      for (const o of g.resolveObjects(e.what, ctx)) destroyObject(g, o.id, ctx.sourceId, e.cantRegenerate);
      return;
    case 'exile': {
      const moved: ObjectId[] = [];
      for (const o of g.resolveObjects(e.what, ctx)) {
        const r = g.moveObject(o.id, 'exile', { cause: 'exile', sourceId: ctx.sourceId ?? undefined });
        if (r) moved.push(r.id);
      }
      ctx.memory['lastMoved'] = moved;
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
      for (const o of g.resolveObjects(e.what, ctx)) if (o.zone === 'battlefield') g.moveObject(o.id, 'graveyard', { cause: 'sacrifice', sourceId: ctx.sourceId ?? undefined });
      return;
    case 'sacrificeChoice': {
      for (const p of g.resolvePlayers(e.who, ctx)) {
        const n = amt(e.count);
        const cands = objectsMatching(g, { ...e.filter, controller: p }, { sourceId: ctx.sourceId, controller: p, x: ctx.x }).map((o) => o.id);
        const k = Math.min(n, cands.length);
        if (k === 0) continue;
        let ids = cands;
        if (cands.length > k) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Sacrifice ${k}`, candidates: cands, min: k, max: k, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : cands.slice(0, k);
        }
        for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'sacrifice', sourceId: ctx.sourceId ?? undefined });
      }
      return;
    }
    case 'returnToHand': {
      const moved: ObjectId[] = [];
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
    case 'returnToBattlefield': {
      const moved: ObjectId[] = [];
      for (const o of g.resolveObjects(e.what, ctx)) {
        const controller = e.controller === 'owner' ? o.owner : ctx.controller;
        const counters = e.counters ? { [e.counters.counter]: amt(e.counters.amount) } : undefined;
        const r = yield* enterBattlefield(g, o.id, controller, { tapped: e.tapped, counters, ctx });
        if (r) moved.push(r.id);
      }
      ctx.memory['lastMoved'] = moved;
      return;
    }
    case 'putOnLibrary':
      for (const o of g.resolveObjects(e.what, ctx)) g.moveObject(o.id, 'library', { position: e.position === 'bottom' ? 'bottom' : e.position === 'secondFromTop' ? 1 : 'top' });
      return;
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
        for (const src of g.state.battlefield.map((id) => g.obj(id))) {
          if (src.controller !== p) continue;
          for (const ab of g.scriptFor(src).abilities) if (ab.kind === 'replacement' && ab.event === 'tokenCreated') count += ab.extra * n;
        }
        for (let i = 0; i < count; i++) {
          const card = tokenCard(e.token, g, ctx);
          let attacking: PlayerId | ObjectId | undefined;
          if (e.attacking) {
            const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
            attacking = src?.attacking ?? g.opponentsOf(p)[0];
          }
          const o = g.createObject(card, p, 'battlefield', { tapped: e.tapped, attacking });
          created.push(o.id);
        }
        if (count > 0) g.log(`${g.player(p).name} creates ${count} ${card_name(e.token)} token${count === 1 ? '' : 's'}.`, { kind: 'token', data: { player: p, count, name: card_name(e.token) } });
      }
      ctx.memory['lastCreated'] = created;
      return;
    }
    case 'addCounters':
      for (const o of g.resolveObjects(e.on, ctx)) if (o.zone === 'battlefield' || o.zone === 'stack') g.addCounters(o.id, e.counter, amt(e.amount), ctx.sourceId ?? undefined);
      // Player counters (poison / experience)
      for (const t of g.resolveRef(e.on, ctx)) {
        if (t.kind !== 'player') continue;
        const pl = g.player(t.id);
        if (e.counter === 'poison') pl.poison += amt(e.amount);
        else if (e.counter === 'experience') pl.experience += amt(e.amount);
        else if (e.counter === 'energy') pl.energy += amt(e.amount);
        g.touch();
      }
      return;
    case 'removeCounters':
      for (const o of g.resolveObjects(e.on, ctx)) g.removeCounters(o.id, e.counter, e.amount === 'all' ? o.counters[e.counter] ?? 0 : amt(e.amount));
      return;
    case 'pump': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: '7c', power: amt(e.power), toughness: amt(e.toughness) } });
      return;
    }
    case 'setPT': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: '7b', setPower: amt(e.power), setToughness: amt(e.toughness) } });
      return;
    }
    case 'grantKeywords': {
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
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 4, addTypes: e.types, addSubtypes: e.subtypes } });
      return;
    }
    case 'setColors': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 5, setColors: e.colors } });
      return;
    }
    case 'applyRule': {
      const ids = g.resolveObjects(e.on, ctx).map((o) => o.id);
      if (!ids.length) return;
      g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 'rule', rule: e.rule } });
      return;
    }
    case 'tap':
      for (const o of g.resolveObjects(e.what, ctx)) g.tap(o.id);
      return;
    case 'untap':
      for (const o of g.resolveObjects(e.what, ctx)) g.untap(o.id);
      return;
    case 'scry':
      for (const p of playersOf(g, e.who, ctx)) yield* scry(g, p, amt(e.amount));
      return;
    case 'surveil':
      for (const p of playersOf(g, e.who, ctx)) yield* surveil(g, p, amt(e.amount));
      return;
    case 'mill':
      for (const p of playersOf(g, e.who, ctx)) {
        const n = amt(e.amount);
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
          for (const id of [...pl.hand]) g.moveObject(id, 'graveyard', { cause: 'discard' });
          continue;
        }
        const n = Math.min(amt(e.amount), pl.hand.length);
        if (n === 0) continue;
        let ids: ObjectId[];
        if (e.random) ids = g.rng.shuffle([...pl.hand]).slice(0, n);
        else if (n >= pl.hand.length) ids = [...pl.hand];
        else {
          const chooser = e.chooser === 'controller' ? ctx.controller : p;
          const resp = yield* g.ask({ type: 'chooseObjects', player: chooser, prompt: `Discard ${n}`, candidates: [...pl.hand], min: n, max: n, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : pl.hand.slice(0, n);
        }
        for (const id of ids) g.moveObject(id, 'graveyard', { cause: 'discard' });
      }
      return;
    case 'addMana': {
      const n = e.amount !== undefined ? amt(e.amount) : 1;
      for (const p of playersOf(g, e.who, ctx)) {
        const pool = g.player(p).manaPool;
        if (e.mana === 'chosenColor') {
          const src = ctx.sourceId !== null ? g.state.objects[ctx.sourceId] : null;
          const c = (src?.memory['color'] ?? src?.chosen['color'] ?? 'W') as ManaColor;
          pool[c] += n;
          g.touch();
          continue;
        }
        if (e.mana === 'anyColor' || e.mana === 'anyOneColor' || e.mana === 'commanderColors') {
          const opts = e.mana === 'commanderColors' ? g.colorsOfCommander(p) : COLORS;
          const choices = (opts.length ? opts : COLORS).map((c) => ({ id: c, label: c }));
          let color: ManaColor = choices[0].id as ManaColor;
          if (choices.length > 1) {
            const resp = yield* g.ask({ type: 'chooseOption', player: p, prompt: `Choose a color of mana${n > 1 ? ` (×${n})` : ''}`, options: choices, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
            if (resp.type === 'options') color = resp.ids[0] as ManaColor;
          }
          pool[color] += n;
        } else {
          for (let i = 0; i < n; i++) for (const c of e.mana) pool[c]++;
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
        if (item.kind === 'spell' && spellObj && g.scriptFor(spellObj).abilities.some((a) => a.kind === 'static' && a.rule?.kind === 'custom' && a.rule.tag === 'cantBeCountered')) {
          g.log(`${item.text} can't be countered.`);
          continue;
        }
        if (e.unlessPays) {
          const paid = yield* offerToPay(g, item.controller, e.unlessPays, `Pay ${e.unlessPays} to prevent ${item.text} from being countered?`);
          if (paid) continue;
        }
        counterStackItem(g, item.id, e.exileInstead ? 'exile' : 'graveyard');
      }
      return;
    }
    case 'searchLibrary': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = amt(e.count);
        const cands = pl.library.filter((id) => matchesFilter(g, g.obj(id), { ...e.filter, zone: 'library' }, { sourceId: ctx.sourceId, controller: p, x: ctx.x }));
        let ids: ObjectId[] = [];
        if (cands.length > 0) {
          const resp = yield* g.ask({ type: 'chooseObjects', player: p, prompt: `Search your library: choose up to ${n}`, candidates: cands, min: 0, max: Math.min(n, cands.length), revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
          ids = resp.type === 'objects' ? resp.ids : [];
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
      g.touch();
      return;
    }
    case 'copySpell': {
      const n = e.count !== undefined ? amt(e.count) : 1;
      for (const t of g.resolveRef(e.what, ctx)) {
        if (t.kind !== 'stackItem') continue;
        const item = g.state.stack.find((s) => s.id === t.id);
        if (!item) continue;
        for (let i = 0; i < n; i++) {
          const copy = { ...item, id: g.state.nextStackId++, controller: ctx.controller, timestamp: g.now(), text: `${item.text} (copy)`, copiedCard: g.state.objects[item.sourceId]?.card, targets: [...item.targets] };
          // TODO: allow new targets for the copy; keep same targets for now.
          g.state.stack.push(copy);
        }
        g.log(`${g.player(ctx.controller).name} copies ${item.text}.`);
      }
      g.touch();
      return;
    }
    case 'fight': {
      const a = g.resolveObjects(e.a, ctx)[0];
      const b = g.resolveObjects(e.b, ctx)[0];
      if (!a || !b || a.zone !== 'battlefield' || b.zone !== 'battlefield') return;
      const pa = g.characteristics(a.id).power ?? 0;
      const pb = g.characteristics(b.id).power ?? 0;
      g.dealDamage(a.id, { kind: 'object', id: b.id }, pa, false);
      g.dealDamage(b.id, { kind: 'object', id: a.id }, pb, false);
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
        o.faceIndex = o.faceIndex === 0 ? 1 : 0;
        g.touch();
        g.emit({ name: 'transformed', objectId: o.id, playerId: o.controller });
        g.log(`${g.nameOf(o.id)} transforms.`);
      }
      return;
    case 'flipCoin': {
      const win = g.rng.coin();
      g.log(`${g.player(ctx.controller).name} flips a coin and ${win ? 'wins' : 'loses'}.`);
      g.emit({ name: 'coinFlipped', playerId: ctx.controller, data: { won: win } });
      yield* executeEffects(g, win ? e.win : e.lose ?? [], ctx);
      return;
    }
    case 'rollDie': {
      const roll = 1 + g.rng.int(e.sides);
      g.log(`${g.player(ctx.controller).name} rolls a d${e.sides}: ${roll}.`);
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
      g.createObject({ ...(src.copyOf ?? src.card), isToken: true }, ctx.controller, 'battlefield');
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
      const ids = g.resolveObjects(e.to, ctx).map((o) => o.id);
      if (ids.length) g.addContinuousEffect({ sourceId: ctx.sourceId, controller: ctx.controller, fromStatic: false, affected: { kind: 'fixed', ids }, duration: durationOf(e.duration), modification: { layer: 'rule', rule: { kind: 'damagePrevention', amount: e.amount === 'all' ? 'all' : amt(e.amount) } } });
      for (const t of g.resolveRef(e.to, ctx)) if (t.kind === 'player') g.player(t.id).flags['preventDamageThisTurn'] = e.amount;
      return;
    }
    case 'lookAtTop': {
      for (const p of playersOf(g, e.who, ctx)) {
        const pl = g.player(p);
        const n = Math.min(amt(e.amount), pl.library.length);
        const top = pl.library.slice(0, n);
        if (!top.length) return;
        g.log(`${pl.name} looks at the top ${n} card${n === 1 ? '' : 's'}.`);
        if (e.then === 'reorder') {
          const resp = yield* g.ask({ type: 'orderObjects', player: p, prompt: 'Put them back in any order (first = top)', objectIds: top, context: 'libraryTop' });
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
        yield* castSpell(g, ctx.controller, o.id, { type: 'cast', objectId: o.id }, { free: true });
      }
      return;
    case 'playFromExile':
      for (const o of g.resolveObjects(e.what, ctx)) {
        o.memory['playableBy'] = ctx.controller;
        o.memory['playableUntil'] = e.duration === 'permanent' ? 'permanent' : g.state.turn.number;
      }
      return;
    case 'chooseColor': {
      const resp = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Choose a color', options: COLORS.map((c) => ({ id: c, label: c })), min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      const c = resp.type === 'options' ? resp.ids[0] : 'W';
      setMemory(g, ctx, e.key, c);
      return;
    }
    case 'chooseCreatureType': {
      const types = new Set<string>();
      for (const o of Object.values(g.state.objects)) if (g.characteristics(o.id).types.includes('Creature')) g.characteristics(o.id).subtypes.forEach((s) => types.add(s));
      const options = [...types].sort().map((t) => ({ id: t, label: t }));
      if (!options.length) options.push({ id: 'Human', label: 'Human' });
      const resp = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: 'Choose a creature type', options, min: 1, max: 1, sourceId: ctx.sourceId ?? undefined });
      setMemory(g, ctx, e.key, resp.type === 'options' ? resp.ids[0] : options[0].id);
      return;
    }
    case 'nameCard':
      setMemory(g, ctx, e.key, '(named card — manual)');
      return;
    case 'setMemory':
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
      const items = g.resolveRef(e.over, ctx);
      for (const it of items) yield* executeEffects(g, e.effects, { ...ctx, iter: it });
      return;
    }
    case 'repeat': {
      const n = amt(e.times);
      for (let i = 0; i < n; i++) yield* executeEffects(g, e.effects, ctx);
      return;
    }
    case 'may': {
      const who = e.who ? g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      const resp = yield* g.ask({ type: 'yesNo', player: who, prompt: e.prompt ?? `${ctx.sourceId !== null ? g.nameOf(ctx.sourceId) : 'Effect'}: ${describe(e.effects)}?`, sourceId: ctx.sourceId ?? undefined });
      if (resp.type === 'yesNo' && resp.value) yield* executeEffects(g, e.effects, ctx);
      return;
    }
    case 'unlessPays': {
      for (const p of g.resolvePlayers(e.who, ctx)) {
        const paid = yield* offerToPay(g, p, e.cost, e.text ?? `Pay ${e.cost}? Otherwise: ${describe(e.effects)}`);
        if (!paid) yield* executeEffects(g, e.effects, { ...ctx, iter: { kind: 'player', id: p } });
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
        const names = g.player(p).hand.map((id) => g.nameOf(id));
        g.log(`${g.player(p).name} reveals their hand: ${names.join(', ') || '(empty)'}.`, { kind: 'revealHand', data: { player: p, ids: [...g.player(p).hand] } });
      }
      return;
    }
    case 'ifPays': {
      const who = e.who ? g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      if (e.energy !== undefined) {
        if (g.player(who).energy < e.energy) return;
        const r = yield* g.ask({ type: 'yesNo', player: who, prompt: e.text ?? `Pay ${e.energy} energy? If you do: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return;
        g.player(who).energy -= e.energy;
        yield* executeEffects(g, e.effects, ctx);
        return;
      }
      if (e.payLife !== undefined) {
        if (g.player(who).life < e.payLife) return;
        const r = yield* g.ask({ type: 'yesNo', player: who, prompt: e.text ?? `Pay ${e.payLife} life? If you do: ${describe(e.effects)}`, sourceId: ctx.sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return;
        g.loseLife(who, e.payLife, ctx.sourceId ?? undefined);
        yield* executeEffects(g, e.effects, ctx);
        return;
      }
      const paid = yield* offerToPay(g, who, e.cost, e.text ?? `Pay ${e.cost}? If you do: ${describe(e.effects)}`);
      if (paid) yield* executeEffects(g, e.effects, ctx);
      return;
    }
    case 'chooseObjects': {
      const who = e.who ? g.resolvePlayers(e.who, ctx)[0] ?? ctx.controller : ctx.controller;
      const cands = objectsMatching(g, e.filter, { sourceId: ctx.sourceId, controller: who, x: ctx.x }, e.filter.zone ? undefined : ['battlefield']).map((o) => o.id);
      const n = Math.min(amt(e.count), cands.length);
      let ids: ObjectId[] = [];
      if (cands.length > 0) {
        const resp = yield* g.ask({ type: 'chooseObjects', player: who, prompt: `Choose ${e.upTo ? 'up to ' : ''}${n}`, candidates: cands, min: e.upTo ? 0 : n, max: n, revealToChooser: true, sourceId: ctx.sourceId ?? undefined });
        ids = resp.type === 'objects' ? resp.ids : cands.slice(0, n);
      }
      ctx.memory[e.key] = ids;
      if (ctx.sourceId !== null && g.state.objects[ctx.sourceId]) g.state.objects[ctx.sourceId].memory[e.key] = ids;
      return;
    }
    case 'chooseMode': {
      const n = e.count ?? 1;
      const resp = yield* g.ask({ type: 'chooseOption', player: ctx.controller, prompt: `Choose ${n}`, options: e.options.map((o, i) => ({ id: String(i), label: o.text })), min: n, max: n, sourceId: ctx.sourceId ?? undefined });
      const picks = resp.type === 'options' ? resp.ids.map(Number) : [0];
      for (const i of picks) yield* executeEffects(g, e.options[i].effects, ctx);
      return;
    }
    case 'delayedTrigger':
      g.state.delayedTriggers.push({ id: g.state.nextEffectId++, event: e.event, filter: e.filter, effects: e.effects, text: e.text, controller: ctx.controller, sourceId: ctx.sourceId ?? -1, once: e.once ?? true, context: { ...ctx.triggerContext, delayedTargets: ctx.targets, delayedMemory: { ...ctx.memory } } });
      return;
    case 'log':
      g.log(e.text);
      return;
    case 'ventureIntoDungeon':
      yield* g.ask({ type: 'manualTrigger', player: ctx.controller, prompt: 'Venture into the dungeon (track your dungeon manually).', text: 'Venture into the dungeon', objectId: ctx.sourceId ?? -1 });
      return;
    case 'investigate': {
      const n = e.count !== undefined ? amt(e.count) : 1;
      for (let i = 0; i < n; i++) g.createObject(tokenCard({ preset: 'Clue', name: 'Clue', typeLine: '', colors: [] }, g, ctx), ctx.controller, 'battlefield');
      return;
    }
    case 'treasure': {
      const n = e.count !== undefined ? amt(e.count) : 1;
      for (let i = 0; i < n; i++) g.createObject(tokenCard({ preset: 'Treasure', name: 'Treasure', typeLine: '', colors: [] }, g, ctx), ctx.controller, 'battlefield');
      return;
    }
    case 'phaseOut':
      for (const o of g.resolveObjects(e.what, ctx)) {
        o.phasedOut = true;
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

export function destroyObject(g: Game, id: ObjectId, sourceId: ObjectId | null, cantRegenerate = false) {
  const o = g.state.objects[id];
  if (!o || o.zone !== 'battlefield') return;
  const ch = g.characteristics(id);
  if (ch.keywords.has('Indestructible')) {
    g.log(`${g.nameOf(id)} is indestructible.`);
    return;
  }
  if (!cantRegenerate) {
    const shieldIdx = g.state.continuousEffects.findIndex((ce) => ce.modification.layer === 'rule' && ce.modification.rule.kind === 'custom' && ce.modification.rule.tag === 'regenerationShield' && ce.affected.kind === 'fixed' && ce.affected.ids.includes(id));
    if (shieldIdx >= 0) {
      g.state.continuousEffects.splice(shieldIdx, 1);
      o.tapped = true;
      o.damage = 0;
      o.deathtouchDamage = false;
      o.attacking = null;
      o.blocking = [];
      g.touch();
      g.log(`${g.nameOf(id)} regenerates.`);
      return;
    }
  }
  g.log(`${g.nameOf(id)} is destroyed.`);
  g.moveObject(id, 'graveyard', { cause: 'destroy', sourceId: sourceId ?? undefined });
}

export function counterStackItem(g: Game, stackId: number, toZone: 'graveyard' | 'exile' = 'graveyard') {
  const item = g.state.stack.find((s) => s.id === stackId);
  if (!item) return;
  g.state.stack = g.state.stack.filter((s) => s.id !== stackId);
  g.log(`${item.text} is countered.`);
  if (item.kind === 'spell' && !item.copiedCard) {
    const o = g.state.objects[item.sourceId];
    if (o && o.zone === 'stack') g.moveObject(item.sourceId, toZone, { cause: 'countered' });
  }
  g.emit({ name: 'countered', objectId: item.sourceId, playerId: item.controller });
  g.touch();
}

export function attach(g: Game, whatId: ObjectId, toId: ObjectId) {
  const what = g.obj(whatId);
  if (what.attachedTo !== null) {
    const host = g.state.objects[what.attachedTo];
    if (host) host.attachments = host.attachments.filter((x) => x !== whatId);
  }
  what.attachedTo = toId;
  const to = g.obj(toId);
  if (!to.attachments.includes(whatId)) to.attachments.push(whatId);
  g.touch();
}

/**
 * Put an object onto the battlefield applying "enters" replacement effects
 * from its own script (enters tapped, with counters, choices) and from other
 * permanents (e.g. "creatures your opponents control enter tapped").
 */
export function* enterBattlefield(g: Game, id: ObjectId, controller: PlayerId, opts: { tapped?: boolean; counters?: Record<string, number>; ctx?: EffectContext; attacking?: PlayerId | ObjectId; fromStack?: boolean } = {}): Gen<GameObject | null> {
  const o = g.state.objects[id];
  if (!o) return null;
  const script = g.scriptFor(o);
  let tapped = opts.tapped ?? false;
  const counters: Record<string, number> = { ...(opts.counters ?? {}) };
  const chosen: Record<string, unknown> = {};
  const ectx: EffectContext = { sourceId: id, controller, targets: [], triggerContext: {}, x: o.xValue ?? 0, modes: o.modes ?? [], memory: {} };
  for (const ab of script.abilities) {
    if (ab.kind !== 'replacement' || ab.event !== 'entersBattlefield' || !ab.self) continue;
    if (ab.tapped) tapped = true;
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
    if (ab.choose === 'color') {
      const resp = yield* g.ask({ type: 'chooseOption', player: controller, prompt: `${o.card.name}: choose a color`, options: COLORS.map((c) => ({ id: c, label: c })), min: 1, max: 1, sourceId: id });
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
      yield* executeEffect(g, { kind: 'chooseCreatureType', key: ab.chooseKey ?? 'creatureType' }, ectx);
      chosen[ab.chooseKey ?? 'creatureType'] = ectx.memory[ab.chooseKey ?? 'creatureType'];
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
  const result = g.moveObject(id, 'battlefield', { tapped, controller, counters, attackingFor: opts.attacking, cause: opts.fromStack ? 'resolve' : 'other' });
  if (!result) return null;
  Object.assign(result.chosen, chosen);
  Object.assign(result.memory, chosen);
  if (attachTo !== null) attach(g, id, attachTo);
  return result;
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
