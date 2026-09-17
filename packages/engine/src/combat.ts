import type { Game, Gen } from './game.js';
import type { GameObject, ObjectId, PlayerId, Step, Target } from './types.js';
import { offerToPay } from './effects.js';
import { summoningSick } from './casting.js';
import { protectionApplies, matchesFilter } from './filters.js';
import { BASIC_LAND_TYPES } from './typeline.js';

function matchesFilterFor(g: Game, id: ObjectId, filter: import('./types.js').ObjectFilter, controller: PlayerId): boolean {
  return matchesFilter(g, g.obj(id), { ...filter, zone: 'battlefield' }, { sourceId: null, controller });
}

function creaturesOf(g: Game, p: PlayerId): GameObject[] {
  return g.state.battlefield.map((id) => g.obj(id)).filter((o) => o.controller === p && !o.phasedOut && g.characteristics(o.id).types.includes('Creature'));
}

function canAttack(g: Game, o: GameObject): boolean {
  if (o.tapped) return false;
  const ch = g.characteristics(o.id);
  if (ch.keywords.has('Defender') && !ch.rules.some((r) => r.kind === 'custom' && r.tag === 'canAttackWithDefender')) return false;
  if (ch.rules.some((r) => r.kind === 'cantAttack')) return false;
  if (summoningSick(g, o)) return false;
  return true;
}

function goadedBy(g: Game, o: GameObject): PlayerId[] {
  return g.characteristics(o.id).rules.filter((r) => r.kind === 'custom' && r.tag === 'goaded').map((r) => (r as { data: PlayerId }).data);
}

/** Who can this creature attack? Players and planeswalkers/battles they control. */
function attackTargets(g: Game, o: GameObject): (PlayerId | ObjectId)[] {
  const out: (PlayerId | ObjectId)[] = [];
  const goaders = goadedBy(g, o);
  const unless = g.characteristics(o.id).rules.filter((r) => r.kind === 'cantAttackUnlessDefenderControls');
  for (const p of g.opponentsOf(o.controller)) {
    if (unless.some((r) => !g.state.battlefield.some((id) => g.obj(id).controller === p && g.characteristics(id).types.length > 0 && matchesFilterFor(g, id, r.filter, p)))) continue;
    // "Creatures can't attack you": a rule on the defending player, matched against the attacker.
    const shielded = g.playerRules(p).some((r) => {
      if (r.kind !== 'custom' || r.tag !== 'cantBeAttacked') return false;
      const f = (r.data as { filter?: import('./types.js').ObjectFilter } | undefined)?.filter;
      return !f || matchesFilterFor(g, o.id, f, p);
    });
    if (shielded) continue;
    out.push(p);
    for (const id of g.state.battlefield) {
      const t = g.obj(id);
      if (t.controller !== p) continue;
      const ch = g.characteristics(id);
      if (ch.types.includes('Planeswalker') || ch.types.includes('Battle')) out.push(id);
    }
  }
  if (goaders.length) {
    const nonGoader = out.filter((t) => (typeof t === 'string' ? !goaders.includes(t) : !goaders.includes(g.obj(t).controller)));
    if (nonGoader.length) return nonGoader;
  }
  return out;
}

function defenderOf(g: Game, target: PlayerId | ObjectId): PlayerId {
  return typeof target === 'string' ? target : g.obj(target).controller;
}

function canBlock(g: Game, blocker: GameObject, attacker: GameObject): boolean {
  const bch = g.characteristics(blocker.id);
  const ach = g.characteristics(attacker.id);
  if (blocker.tapped) return false;
  if (bch.rules.some((r) => r.kind === 'cantBlock')) return false;
  for (const r of bch.rules) if (r.kind === 'cantBlockFilter' && matchesFilter(g, attacker, { ...r.filter, zone: 'battlefield' }, { sourceId: blocker.id, controller: blocker.controller })) return false;
  if (ach.rules.some((r) => r.kind === 'cantBeBlocked')) return false;
  if (ach.keywords.has('Flying') && !(bch.keywords.has('Flying') || bch.keywords.has('Reach'))) return false;
  // "~ can block creatures with shadow as though it had shadow."
  const asThough = new Set<string>();
  for (const r of bch.rules) if (r.kind === 'custom' && r.tag === 'canBlockAsThough' && typeof r.data === 'string') asThough.add(r.data.toLowerCase());
  if (ach.keywords.has('Shadow') !== bch.keywords.has('Shadow') && !(ach.keywords.has('Shadow') && asThough.has('shadow'))) return false;
  if (ach.keywords.has('Horsemanship') && !bch.keywords.has('Horsemanship')) return false;
  if (ach.keywords.has('Fear') && !(bch.types.includes('Artifact') || bch.colors.includes('B'))) return false;
  if (ach.keywords.has('Intimidate') && !(bch.types.includes('Artifact') || bch.colors.some((c) => ach.colors.includes(c)))) return false;
  if (ach.keywords.has('Skulk') && (bch.power ?? 0) > (ach.power ?? 0)) return false;
  for (const r of ach.rules) {
    if (r.kind === 'cantBeBlockedByPowerLE' && (bch.power ?? 0) <= r.power) return false;
    if (r.kind === 'cantBeBlockedByPowerGE' && (bch.power ?? 0) >= r.power) return false;
    if (r.kind === 'cantBeBlockedByPowerLessThanSource' && (bch.power ?? 0) < (ach.power ?? 0)) return false;
    if (r.kind === 'cantBeBlockedBy' && matchesFilter(g, blocker, { ...r.filter, zone: 'battlefield' }, { sourceId: attacker.id, controller: attacker.controller })) return false;
    if (r.kind === 'cantBeBlockedExceptBy' && !matchesFilter(g, blocker, { ...r.filter, zone: 'battlefield' }, { sourceId: attacker.id, controller: attacker.controller })) return false;
    if (r.kind === 'canBeBlockedOnlyBy' && !matchesFilter(g, blocker, { ...r.filter, zone: 'battlefield' }, { sourceId: attacker.id, controller: attacker.controller })) return false;
    if (r.kind === 'cantBeBlockedByPowerGreaterThanSource' && (bch.power ?? 0) > (ach.power ?? 0)) return false;
    if (r.kind === 'custom' && r.tag === 'ringBearer' && (bch.power ?? 0) > (ach.power ?? 0)) return false;
  }
  // "Target creature can't block ~ this turn"
  if (bch.rules.some((r) => r.kind === 'custom' && r.tag === 'cantBlockSource' && r.data === attacker.id)) return false;
  for (const prot of ach.protections) if (protectionApplies(prot, bch.colors, bch.types, bch.subtypes, true)) return false;
  // Landwalk ("Creatures with islandwalk can be blocked as though they didn't have islandwalk.")
  const ignored = new Set<string>();
  for (const r of g.playerRules(blocker.controller)) if (r.kind === 'custom' && r.tag === 'ignoreLandwalk' && typeof r.data === 'string') ignored.add(r.data.toLowerCase());
  for (const [land] of Object.entries(BASIC_LAND_TYPES)) {
    if (ignored.has(`${land.toLowerCase()}walk`)) continue;
    if (ach.keywords.has(`${land}walk`) && g.state.battlefield.some((id) => g.obj(id).controller === blocker.controller && g.characteristics(id).subtypes.includes(land))) return false;
  }
  // "can block only creatures with flying"
  if (bch.rules.some((r) => r.kind === 'custom' && r.tag === 'blockOnlyFlying') && !ach.keywords.has('Flying')) return false;
  return true;
}

export function* runCombatStep(g: Game, step: Step): Gen {
  const active = g.state.turn.activePlayer;
  switch (step) {
    case 'beginCombat':
      g.emit({ name: 'beginningOfCombat', playerId: active });
      yield* g.priorityRound();
      return;
    case 'declareAttackers':
      yield* declareAttackers(g, active);
      if (g.state.turn.attackers.length) yield* g.priorityRound();
      return;
    case 'declareBlockers':
      yield* declareBlockers(g);
      yield* g.priorityRound();
      return;
    case 'firstStrikeDamage':
      yield* dealCombatDamage(g, true);
      g.state.turn.firstStrikeHappened = true;
      yield* g.priorityRound();
      return;
    case 'combatDamage':
      yield* dealCombatDamage(g, false);
      yield* g.priorityRound();
      return;
    case 'endCombat':
      g.emit({ name: 'endOfCombat', playerId: active });
      yield* g.priorityRound();
      for (const o of Object.values(g.state.objects)) {
        o.attacking = null;
        o.blocking = [];
        o.blockedBy = [];
        o.wasBlocked = false;
      }
      g.state.turn.attackers = [];
      g.expireEffects('endOfCombat');
      g.touch();
      return;
  }
}

function* declareAttackers(g: Game, active: PlayerId): Gen {
  const creatures = creaturesOf(g, active).filter((o) => canAttack(g, o));
  const candidates = creatures
    .map((o) => {
      const targets = attackTargets(g, o);
      const ch = g.characteristics(o.id);
      const must = goadedBy(g, o).length > 0 || ch.rules.some((r) => r.kind === 'mustAttack');
      return { id: o.id, canAttack: targets, mustAttack: must };
    })
    .filter((c) => c.canAttack.length > 0);
  g.emit({ name: 'beginningOfDeclareAttackers', playerId: active });
  if (candidates.length === 0) {
    g.state.turn.attackers = [];
    return;
  }
  let attacks: { attacker: ObjectId; target: PlayerId | ObjectId }[] = [];
  for (;;) {
    const resp = yield* g.ask({ type: 'declareAttackers', player: active, prompt: 'Declare attackers', candidates });
    if (resp.type !== 'attackers') return;
    attacks = resp.attacks;
    const valid = attacks.every((a) => candidates.some((c) => c.id === a.attacker && c.canAttack.some((t) => t === a.target))) && new Set(attacks.map((a) => a.attacker)).size === attacks.length;
    const mustOk = candidates.filter((c) => c.mustAttack).every((c) => attacks.some((a) => a.attacker === c.id));
    // "~ can't attack alone"
    const aloneOk = attacks.length !== 1 || !g.characteristics(attacks[0].attacker).rules.some((r) => r.kind === 'custom' && (r.tag === 'cantAttackAlone' || r.tag === 'cantAttackOrBlockAlone'));
    // "No more than one creature can attack each combat."
    let maxAtk = Infinity;
    for (const r of g.playerRules(active)) if (r.kind === 'custom' && r.tag === 'maxAttackers' && typeof r.data === 'number') maxAtk = Math.min(maxAtk, r.data);
    const maxOk = attacks.length <= maxAtk;
    if (valid && mustOk && aloneOk && maxOk) break;
    g.log(valid ? 'Some creatures must attack this combat.' : 'Invalid attack declaration.');
  }
  // "Creatures can't attack you unless their controller pays {2} for each creature they control that is attacking you."
  {
    const taxed = new Map<PlayerId, { cost: string; n: number }>();
    for (const a of attacks) {
      const o = g.obj(a.attacker);
      const def = defenderOf(g, a.target);
      if (def === active) continue;
      for (const r of g.playerRules(active)) {
        if (r.kind !== 'custom' || r.tag !== 'attackTax') continue;
        const d = (r.data as { filter?: import('./types.js').ObjectFilter; cost?: string } | undefined) ?? {};
        const srcId = (r as { sourceId?: ObjectId }).sourceId;
        const srcCtl = srcId !== undefined ? g.state.objects[srcId]?.controller : undefined;
        if (srcCtl !== undefined && srcCtl !== def) continue;
        if (d.filter && !matchesFilter(g, o, { ...d.filter, zone: 'battlefield' }, { sourceId: srcId ?? null, controller: active })) continue;
        if (!d.cost) continue;
        const prev = taxed.get(def) ?? { cost: d.cost, n: 0 };
        taxed.set(def, { cost: d.cost, n: prev.n + 1 });
      }
    }
    for (const [, t] of taxed) {
      for (let i = 0; i < t.n; i++) {
        const paid = yield* offerToPay(g, active, t.cost, `Pay ${t.cost} for an attacking creature?`);
        if (!paid) {
          // Remove one attacker that was taxed.
          const drop = attacks.findIndex((a) => defenderOf(g, a.target) !== active);
          if (drop >= 0) attacks.splice(drop, 1);
        }
      }
    }
  }
  g.state.turn.attackers = attacks.map((a) => a.attacker);
  const defenders = new Set<PlayerId>();
  for (const a of attacks) {
    const o = g.obj(a.attacker);
    o.attacking = a.target;
    o.memory['attackedThisTurn'] = true;
    const ch = g.characteristics(o.id);
    if (!ch.keywords.has('Vigilance')) g.tap(o.id);
    defenders.add(defenderOf(g, a.target));
  }
  g.touch();
  if (attacks.length) g.log(`${g.player(active).name} attacks with ${attacks.map((a) => `${g.nameOf(a.attacker)} → ${typeof a.target === 'string' ? g.player(a.target).name : g.nameOf(a.target)}`).join(', ')}.`, { kind: 'attack', data: { attacks } });
  for (const a of attacks) {
    g.emit({ name: 'attacks', objectId: a.attacker, playerId: active, otherPlayerId: defenderOf(g, a.target), sourceId: typeof a.target === 'number' ? a.target : undefined, combat: true });
  }
  for (const d of defenders) g.emit({ name: 'attacked', playerId: d, otherPlayerId: active, amount: attacks.filter((a) => defenderOf(g, a.target) === d).length, combat: true });
  // Battle cry / Exalted / Myriad hooks handled by scripts via 'attacks' events.
}

function* declareBlockers(g: Game): Gen {
  const attackers = g.state.turn.attackers.map((id) => g.state.objects[id]).filter((o): o is GameObject => !!o && o.zone === 'battlefield' && o.attacking !== null);
  if (!attackers.length) return;
  const defenders = [...new Set(attackers.map((a) => defenderOf(g, a.attacking!)))];
  for (const d of g.apnap().filter((p) => defenders.includes(p))) {
    const mine = attackers.filter((a) => defenderOf(g, a.attacking!) === d);
    const blockers = creaturesOf(g, d).filter((o) => !o.tapped);
    const candidates = blockers.map((b) => ({ id: b.id, canBlock: mine.filter((a) => canBlock(g, b, a)).map((a) => a.id) })).filter((c) => c.canBlock.length);
    if (!candidates.length) continue;
    let blocks: { blocker: ObjectId; attacker: ObjectId }[] = [];
    for (;;) {
      const resp = yield* g.ask({ type: 'declareBlockers', player: d, prompt: 'Declare blockers', attackers: mine.map((a) => a.id), candidates });
      if (resp.type !== 'blockers') break;
      blocks = resp.blocks;
      // A creature blocks one attacker, plus one more per "can block an additional creature" rule.
      const perBlocker = new Map<ObjectId, number>();
      for (const b of blocks) perBlocker.set(b.blocker, (perBlocker.get(b.blocker) ?? 0) + 1);
      const countOk = [...perBlocker].every(([id, n]) => n <= 1 + g.characteristics(id).rules.filter((r) => r.kind === 'custom' && r.tag === 'extraBlock').length);
      const blockAloneOk = blocks.length !== 1 || !g.characteristics(blocks[0].blocker).rules.some((r) => r.kind === 'custom' && (r.tag === 'cantBlockAlone' || r.tag === 'cantAttackOrBlockAlone'));
      // "~ blocks each combat if able."
      const mustBlockOk = candidates.every((c) => !g.characteristics(c.id).rules.some((r) => r.kind === 'mustBlock') || blocks.some((b) => b.blocker === c.id));
      // "Creatures can't block unless their controller pays {1} for each of those creatures."
      let blockTax: { cost: string; n: number } | null = null as { cost: string; n: number } | null;
      for (const b of blocks) {
        const o = g.obj(b.blocker);
        for (const r of g.playerRules(d)) {
          if (r.kind !== 'custom' || r.tag !== 'blockTax') continue;
          const dd = (r.data as { filter?: import('./types.js').ObjectFilter; cost?: string } | undefined) ?? {};
          if (!dd.cost) continue;
          if (dd.filter && !matchesFilter(g, o, { ...dd.filter, zone: 'battlefield' }, { sourceId: (r as { sourceId?: ObjectId }).sourceId ?? null, controller: d })) continue;
          blockTax = { cost: dd.cost, n: (blockTax?.n ?? 0) + 1 };
        }
      }
      if (blockTax) {
        for (let i = 0; i < blockTax.n; i++) {
          const paid = yield* offerToPay(g, d, blockTax.cost, `Pay ${blockTax.cost} for a blocking creature?`);
          if (!paid && blocks.length) blocks.pop();
        }
      }
      // "No more than one creature can block each combat."
      let maxBlk = Infinity;
      for (const r of g.playerRules(d)) if (r.kind === 'custom' && r.tag === 'maxBlockersTotal' && typeof r.data === 'number') maxBlk = Math.min(maxBlk, r.data);
      const valid = blocks.every((b) => candidates.some((c) => c.id === b.blocker && c.canBlock.includes(b.attacker))) && countOk && blockAloneOk && mustBlockOk && blocks.length <= maxBlk;
      // Block requirements: "must be blocked if able", "all creatures able to block ~ do so", "target creature blocks ~ this turn if able".
      const requirementsOk = mine.every((a) => {
        const rules = g.characteristics(a.id).rules;
        const able = candidates.filter((c) => c.canBlock.includes(a.id));
        if (!able.length) return true;
        const blockedBy = blocks.filter((b) => b.attacker === a.id).map((b) => b.blocker);
        if (rules.some((r) => r.kind === 'custom' && r.tag === 'mustBeBlocked') && blockedBy.length === 0) return false;
        // "Target creature blocks this turn if able": any such blocker able to block something must block.
        if (able.some((c) => g.characteristics(c.id).rules.some((r) => r.kind === 'custom' && r.tag === 'mustBlockAny') && !blocks.some((b) => b.blocker === c.id))) return false;
        if (rules.some((r) => r.kind === 'custom' && r.tag === 'lure') && able.some((c) => !blockedBy.includes(c.id) && !blocks.some((b) => b.blocker === c.id))) return false;
        return able.every((c) => !g.characteristics(c.id).rules.some((r) => r.kind === 'custom' && r.tag === 'mustBlock' && r.data === a.id) || blockedBy.includes(c.id) || blocks.some((b) => b.blocker === c.id));
      });
      // Menace: needs 2+ blockers
      const menaceOk = mine.every((a) => {
        const n = blocks.filter((b) => b.attacker === a.id).length;
        const ch = g.characteristics(a.id);
        if (ch.keywords.has('Menace') && n === 1) return false;
        const minBlockers = ch.rules.find((r) => r.kind === 'custom' && r.tag === 'minBlockers') as { data?: number } | undefined;
        if (minBlockers?.data && n > 0 && n < minBlockers.data) return false;
        const maxBlockers = ch.rules.find((r) => r.kind === 'maxBlockers') as { count: number } | undefined;
        if (maxBlockers && n > maxBlockers.count) return false;
        return true;
      });
      if (valid && menaceOk && requirementsOk) break;
      g.log(!valid ? 'Invalid block declaration.' : !menaceOk ? 'A creature with menace must be blocked by two or more creatures.' : 'A block requirement was not met (a creature must be blocked if able).');
    }
    for (const b of blocks) {
      const blocker = g.obj(b.blocker);
      const attacker = g.obj(b.attacker);
      blocker.blocking.push(b.attacker);
      attacker.blockedBy.push(b.blocker);
      attacker.wasBlocked = true;
    }
    g.touch();
    if (blocks.length) g.log(`${g.player(d).name} blocks: ${blocks.map((b) => `${g.nameOf(b.blocker)} blocks ${g.nameOf(b.attacker)}`).join(', ')}.`, { kind: 'block', data: { blocks } });
    for (const b of blocks) g.emit({ name: 'blocks', objectId: b.blocker, sourceId: b.attacker, playerId: d, combat: true });
    for (const a of mine) if (a.blockedBy.length) g.emit({ name: 'becomesBlocked', objectId: a.id, playerId: a.controller, combat: true });
  }
  // "Target unblocked attacking creature becomes blocked."
  for (const a of attackers) {
    if (a.blockedBy.length) continue;
    if (g.characteristics(a.id).rules.some((r) => r.kind === 'custom' && r.tag === 'becomesBlocked')) {
      a.wasBlocked = true;
      g.log(`${g.nameOf(a.id)} becomes blocked.`);
      g.emit({ name: 'becomesBlocked', objectId: a.id, playerId: a.controller, combat: true });
    }
  }
  // "Whenever ~ attacks and isn't blocked"
  for (const a of attackers) if (!a.blockedBy.length && !a.wasBlocked && a.attacking !== null) g.emit({ name: 'attacksUnblocked', objectId: a.id, playerId: a.controller, otherPlayerId: defenderOf(g, a.attacking), combat: true });
  // Damage assignment order for attackers blocked by multiple creatures.
  for (const a of attackers) {
    if (a.blockedBy.length > 1) {
      const resp = yield* g.ask({ type: 'orderObjects', player: a.controller, prompt: `Order blockers for ${g.nameOf(a.id)} (damage assigned in this order)`, objectIds: [...a.blockedBy], context: 'damageAssignment' });
      if (resp.type === 'order') a.blockedBy = resp.ids;
    }
  }
}

interface DamageAssignment {
  source: ObjectId;
  target: Target;
  amount: number;
}

function* dealCombatDamage(g: Game, firstStrikeStep: boolean): Gen {
  const assignments: DamageAssignment[] = [];
  const dealsNow = (o: GameObject) => {
    const ch = g.characteristics(o.id);
    const fs = ch.keywords.has('First strike');
    const ds = ch.keywords.has('Double strike');
    if (firstStrikeStep) return fs || ds;
    if (ds) return true;
    if (fs) return false; // already dealt in first-strike step
    return true;
  };
  const attackers = g.state.turn.attackers.map((id) => g.state.objects[id]).filter((o): o is GameObject => !!o && o.zone === 'battlefield' && o.attacking !== null);
  for (const a of attackers) {
    if (!dealsNow(a)) continue;
    const ch = g.characteristics(a.id);
    const power = (ch.rules.some((r) => r.kind === 'custom' && r.tag === 'damageByToughness') ? ch.toughness : ch.power) ?? 0;
    if (power <= 0) continue;
    const deathtouch = ch.keywords.has('Deathtouch');
    const blockers = a.blockedBy.map((id) => g.state.objects[id]).filter((b): b is GameObject => !!b && b.zone === 'battlefield');
    let asUnblocked = false;
    if (a.wasBlocked && a.attacking !== null && ch.rules.some((r) => r.kind === 'custom' && r.tag === 'assignAsUnblocked')) {
      const r = yield* g.ask({ type: 'yesNo', player: a.controller, prompt: `${g.nameOf(a.id)}: assign its combat damage as though it weren't blocked?`, sourceId: a.id });
      asUnblocked = r.type === 'yesNo' && r.value;
    }
    if (!a.wasBlocked || asUnblocked) {
      const target: Target = typeof a.attacking === 'string' ? { kind: 'player', id: a.attacking } : { kind: 'object', id: a.attacking as ObjectId };
      if (target.kind === 'object' && !g.state.objects[target.id]) continue;
      assignments.push({ source: a.id, target, amount: power });
      continue;
    }
    if (blockers.length === 0) {
      // Blocked, blockers gone: no damage unless trample.
      if (ch.keywords.has('Trample') && a.attacking !== null) {
        const target: Target = typeof a.attacking === 'string' ? { kind: 'player', id: a.attacking } : { kind: 'object', id: a.attacking as ObjectId };
        assignments.push({ source: a.id, target, amount: power });
      }
      continue;
    }
    // Assign lethal to each blocker in order, remainder to next; trample excess to defender.
    let remaining = power;
    const lethalFor = (b: GameObject) => {
      if (deathtouch) return 1;
      const bch = g.characteristics(b.id);
      const already = assignments.filter((x) => x.target.kind === 'object' && x.target.id === b.id).reduce((s, x) => s + x.amount, 0);
      return Math.max(0, (bch.toughness ?? 0) - b.damage - already);
    };
    let assignedAny = false;
    if (blockers.length > 1 || ch.keywords.has('Trample')) {
      // Player may distribute; default to lethal-first.
      const plan: number[] = [];
      let rem = remaining;
      for (let i = 0; i < blockers.length; i++) {
        const lethal = lethalFor(blockers[i]);
        const give = i === blockers.length - 1 && !ch.keywords.has('Trample') ? rem : Math.min(rem, lethal);
        plan.push(give);
        rem -= give;
      }
      const targets: Target[] = blockers.map((b) => ({ kind: 'object', id: b.id }));
      const defender: Target | null = ch.keywords.has('Trample') && a.attacking !== null ? (typeof a.attacking === 'string' ? { kind: 'player', id: a.attacking } : { kind: 'object', id: a.attacking as ObjectId }) : null;
      if (defender) {
        targets.push(defender);
        plan.push(rem);
        rem = 0;
      }
      let amounts = plan;
      const canChoose = blockers.length > 1; // single blocker (+ trample): lethal first, excess tramples over
      if (canChoose && targets.length > 1) {
        const resp = yield* g.ask({ type: 'distribute', player: a.controller, prompt: `Assign ${power} combat damage from ${g.nameOf(a.id)} (lethal damage must be assigned in order${ch.keywords.has('Trample') ? '; excess may trample over' : ''})`, amount: power, targets, minPer: 0, sourceId: a.id });
        if (resp.type === 'distribute') {
          // Validate ordering: each blocker before the last assigned must have lethal.
          let ok = true;
          let seenShort = false;
          for (let i = 0; i < blockers.length; i++) {
            const lethal = lethalFor(blockers[i]);
            if (seenShort && resp.amounts[i] > 0) ok = false;
            if (resp.amounts[i] < lethal) seenShort = true;
          }
          if (defender && seenShort && resp.amounts[blockers.length] > 0) ok = false;
          if (ok) amounts = resp.amounts;
          else g.log('Damage assignment must give lethal damage in order; using default assignment.');
        }
      }
      targets.forEach((t, i) => {
        if (amounts[i] > 0) assignments.push({ source: a.id, target: t, amount: amounts[i] });
      });
      assignedAny = true;
    }
    if (!assignedAny) assignments.push({ source: a.id, target: { kind: 'object', id: blockers[0].id }, amount: remaining });
  }
  // Blockers deal damage to attackers they block.
  for (const id of g.state.battlefield) {
    const b = g.obj(id);
    if (!b.blocking.length || !dealsNow(b)) continue;
    const bch = g.characteristics(b.id);
    const power = (bch.rules.some((r) => r.kind === 'custom' && r.tag === 'damageByToughness') ? bch.toughness : bch.power) ?? 0;
    if (power <= 0) continue;
    const alive = b.blocking.filter((aid) => g.state.objects[aid]?.zone === 'battlefield');
    if (!alive.length) continue;
    if (alive.length === 1) assignments.push({ source: b.id, target: { kind: 'object', id: alive[0] }, amount: power });
    else {
      const resp = yield* g.ask({ type: 'distribute', player: b.controller, prompt: `Assign ${power} damage from ${g.nameOf(b.id)} among the creatures it blocks`, amount: power, targets: alive.map((aid) => ({ kind: 'object' as const, id: aid })), minPer: 0, sourceId: b.id });
      const amounts = resp.type === 'distribute' ? resp.amounts : alive.map((_, i) => (i === 0 ? power : 0));
      alive.forEach((aid, i) => amounts[i] > 0 && assignments.push({ source: b.id, target: { kind: 'object', id: aid }, amount: amounts[i] }));
    }
  }
  if (!assignments.length) return;
  // All combat damage is dealt simultaneously.
  for (const a of assignments) g.dealDamage(a.source, a.target, a.amount, true);
  if (g.pendingInitiative) {
    const who = g.pendingInitiative;
    g.pendingInitiative = null;
    if (g.state.initiative !== who) {
      g.state.initiative = who;
      g.log(`${g.player(who).name} takes the initiative.`);
      g.emit({ name: 'takesInitiative', playerId: who });
    }
  }
  g.touch();
}
