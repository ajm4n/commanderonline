import type { Game, Gen } from './game.js';
import type { StackItem, Target, ZoneName } from './types.js';
import type { TriggeredAbilitySpec, ActivatedAbilitySpec, SpellAbilitySpec } from './script.js';
import { canTarget } from './filters.js';
import { enterBattlefield, executeEffects, attach, type EffectContext } from './effects.js';

function targetsStillLegal(g: Game, item: StackItem): { legal: Target[]; anyIllegal: boolean } {
  const legal: Target[] = [];
  let anyIllegal = false;
  for (let i = 0; i < item.targets.length; i++) {
    const t = item.targets[i];
    if (t.kind === 'none') {
      legal.push(t);
      continue;
    }
    const stamp = item.targetStamps?.[i];
    const sameObject = t.kind !== 'object' || (g.state.objects[t.id] !== undefined && (stamp === undefined || stamp === null || g.state.objects[t.id].timestamp === stamp));
    const ok = sameObject && canTarget(g, t, g.state.objects[item.sourceId] ? item.sourceId : null, item.controller);
    if (ok) legal.push(t);
    else {
      anyIllegal = true;
      legal.push({ kind: 'none' });
    }
  }
  return { legal, anyIllegal };
}

export function* resolveTopOfStack(g: Game): Gen {
  const item = g.state.stack.pop();
  if (!item) return;
  g.touch();
  const src = g.state.objects[item.sourceId];
  const hadTargets = item.targets.some((t) => t.kind !== 'none');
  const { legal, anyIllegal } = targetsStillLegal(g, item);
  if (hadTargets && legal.every((t) => t.kind === 'none')) {
    g.log(`${item.text} fizzles (all targets illegal).`);
    if (item.kind === 'spell' && src && src.zone === 'stack' && !item.copiedCard) g.moveObject(item.sourceId, 'graveyard', { cause: 'countered' });
    return;
  }
  if (anyIllegal) g.log(`Some targets of ${item.text} became illegal.`);
  const targetSlots = (item.triggerContext?.targetSlots as Target[][] | undefined)?.map((slot) => slot.filter((t) => t.kind === 'none' || canTarget(g, t, null, item.controller)));
  const ctx: EffectContext = {
    sourceId: g.state.objects[item.sourceId] ? item.sourceId : null,
    controller: item.controller,
    targets: legal,
    targetSlots,
    triggerContext: item.triggerContext ?? {},
    x: item.xValue ?? 0,
    modes: item.modes ?? [],
    memory: {},
    stackItemId: item.id,
  };
  if (item.triggerContext?.delayedTargets) {
    const dt = item.triggerContext.delayedTargets as Target[];
    ctx.targets = dt.map((t) => (t.kind === 'object' && !g.state.objects[t.id] ? { kind: 'none' } : t));
    ctx.memory = { ...((item.triggerContext.delayedMemory as Record<string, unknown>) ?? {}) };
  }
  if (item.triggerContext?.snapshot && !ctx.sourceId) ctx.sourceId = item.sourceId; // LKI source for dies triggers (object may be in graveyard)
  if (!g.state.objects[item.sourceId]) ctx.sourceId = null;

  if (item.kind === 'spell') {
    yield* resolveSpell(g, item, ctx);
  } else {
    const ability = item.triggerContext?.ability as TriggeredAbilitySpec | ActivatedAbilitySpec | undefined;
    if (!ability) return;
    // Snapshot-based source: allow effects to reference the graveyard object.
    if (ctx.sourceId === null && src) ctx.sourceId = src.id;
    if (ability.kind === 'triggered') {
      if (ability.condition && !g.checkCondition(ability.condition, { sourceId: ctx.sourceId, controller: ctx.controller, triggerContext: ctx.triggerContext, targets: ctx.targets, x: ctx.x })) {
        g.log(`${item.text}: condition no longer true.`);
        return;
      }
      if (ability.optional) {
        const r = yield* g.ask({ type: 'yesNo', player: item.controller, prompt: `${item.text}`, yesLabel: 'Yes', noLabel: 'No', sourceId: ctx.sourceId ?? undefined });
        if (r.type !== 'yesNo' || !r.value) return;
      }
    }
    g.log(`Resolving: ${item.text}`, { kind: 'resolve', data: { stackId: item.id } });
    yield* executeEffects(g, ability.effects, ctx);
  }
}

function* resolveSpell(g: Game, item: StackItem, ctx: EffectContext): Gen {
  const obj = g.state.objects[item.sourceId];
  const isCopy = !!item.copiedCard;
  const card = item.copiedCard ?? obj?.card;
  if (!card) return;
  const faceIndex = obj?.faceIndex ?? 0;
  const face = faceIndex > 0 && card.faces?.[faceIndex] ? card.faces[faceIndex] : card;
  const script = obj ? g.scriptFor(obj) : g.scriptFor({ card, faceIndex: 0 } as unknown as import('./types.js').GameObject);
  const isPermanent = /\b(Creature|Artifact|Enchantment|Planeswalker|Land|Battle)\b/.test(face.typeLine) && !/\b(Instant|Sorcery)\b/.test(face.typeLine);
  g.log(`Resolving: ${item.text}`, { kind: 'resolve', data: { stackId: item.id } });

  if (isPermanent && obj && !isCopy) {
    const fromStack = true;
    const entered = yield* enterBattlefield(g, obj.id, item.controller, { ctx, fromStack });
    if (entered && obj.additionalCostsPaid.includes('warp')) {
      g.state.delayedTriggers.push({ id: g.state.nextEffectId++, event: 'beginningOfEndStep', effects: [{ kind: 'exile', what: { ref: 'self' } }, { kind: 'playFromExile', what: { ref: 'self' }, duration: 'permanent' }], text: `Warp: exile ${face.name}`, controller: item.controller, sourceId: entered.id, once: true, context: {}, sourceZone: 'battlefield' });
    }
    if (entered && /\bAura\b/.test(face.typeLine)) {
      const t = item.targets.find((x) => x.kind === 'object');
      if (t && t.kind === 'object' && g.state.objects[t.id]) attach(g, entered.id, t.id);
    }
    // "When you cast" effects of permanents with spell abilities (rare) run after entering.
    const spell = script.abilities.find((a) => a.kind === 'spell') as SpellAbilitySpec | undefined;
    if (spell) yield* runSpellEffects(g, spell, item, ctx);
    g.emit({ name: 'spellResolved', objectId: item.sourceId, playerId: item.controller });
    return;
  }
  // Instant / sorcery (or a copy of anything).
  const spell = script.abilities.find((a) => a.kind === 'spell') as SpellAbilitySpec | undefined;
  if (spell) yield* runSpellEffects(g, spell, item, ctx);
  else if (script.coverage === 'none' || !spell) {
    // Unscripted: show the text so the player can do it by hand.
    yield* g.ask({ type: 'manualTrigger', player: item.controller, prompt: `Resolve ${face.name} manually:\n${face.oracleText}`, text: face.oracleText, objectId: item.sourceId, sourceId: item.sourceId });
  }
  g.emit({ name: 'spellResolved', objectId: item.sourceId, playerId: item.controller });
  if (obj && !isCopy && obj.zone === 'stack') {
    let dest: ZoneName = 'graveyard';
    if (obj.castFromZone === 'graveyard' || obj.memory['exileOnResolve']) dest = 'exile';
    if (/^Rebound\b/m.test(face.oracleText) && obj.castFromZone === 'hand') dest = 'exile';
    if (obj.isCommander && dest === 'graveyard') {
      // Commander in graveyard offered to command zone by SBA.
    }
    if (obj.card.layout === 'adventure' && faceIndex > 0) {
      dest = 'exile';
      const moved = g.moveObject(obj.id, 'exile', { cause: 'resolve' });
      if (moved) {
        moved.memory['playableBy'] = item.controller;
        moved.memory['playableUntil'] = 'permanent';
        moved.memory['adventureExiled'] = true;
      }
      return;
    }
    g.moveObject(obj.id, dest, { cause: 'resolve' });
  }
}

function* runSpellEffects(g: Game, spell: SpellAbilitySpec, item: StackItem, ctx: EffectContext): Gen {
  if (spell.modes && spell.modes.length) {
    const modes = item.modes ?? [];
    // Targets were chosen per mode in order; re-slice targets per mode.
    let slotOffset = 0;
    for (const m of modes) {
      const mode = spell.modes[m];
      if (!mode) continue;
      const n = mode.targets?.length ?? 0;
      const sub: EffectContext = { ...ctx, targets: ctx.targets.slice(slotOffset, slotOffset + n), targetSlots: ctx.targetSlots?.slice(slotOffset, slotOffset + n) };
      slotOffset += n;
      yield* executeEffects(g, mode.effects, sub);
    }
    return;
  }
  yield* executeEffects(g, spell.effects, ctx);
}
