/**
 * Goldfish bot: answers any engine decision with a sensible default, with a
 * pinch of aggression so the board visibly changes (plays lands, casts what it
 * can, attacks). Mirrors Driver.defaultAnswer from the engine's test helpers,
 * plus a loop guard so a rejected response falls back to the safe default.
 */
import type { Decision, Response, GameView, PlayerId, ObjectId } from '@commander/engine';

export function defaultAnswer(d: Decision): Response {
  switch (d.type) {
    case 'mulligan':
      return { type: 'mulligan', keep: true };
    case 'priority':
      return { type: 'pass' };
    case 'yesNo':
      return { type: 'yesNo', value: true };
    case 'declareAttackers':
      return { type: 'attackers', attacks: [] };
    case 'declareBlockers':
      return { type: 'blockers', blocks: [] };
    case 'chooseObjects':
      return { type: 'objects', ids: d.candidates.slice(0, d.min) };
    case 'chooseOption':
      return { type: 'options', ids: d.options.filter((o) => !o.disabled).slice(0, d.min).map((o) => o.id) };
    case 'orderObjects':
      return { type: 'order', ids: d.items ? d.items.map((i) => i.id) : d.objectIds };
    case 'chooseTargets':
      return { type: 'targets', targets: d.slots.map((s) => s.legal.slice(0, s.min)) };
    case 'chooseNumber':
      return { type: 'number', value: d.max };
    case 'distribute': {
      const amounts = d.targets.map(() => d.minPer);
      if (amounts.length) amounts[0] += d.amount - amounts.reduce((a, b) => a + b, 0);
      return { type: 'distribute', amounts };
    }
    case 'manualTrigger':
      return { type: 'manualDone' };
    case 'payMana':
      return { type: 'payMana', tap: [], auto: true };
    default:
      // Unknown decision type from a newer engine: pass is the least harmful guess.
      return { type: 'pass' };
  }
}

export interface BotContext {
  view: GameView;
  /** Ids of the other bots, so bots prefer attacking humans. */
  botIds: Set<PlayerId>;
  /** How many times this exact decision id has been answered already (loop guard). */
  attempts: number;
  rng: () => number;
}

function pick<T>(arr: T[], rng: () => number): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/** A slightly smarter bot than defaultAnswer; degrades to defaultAnswer after repeated rejections. */
export function botAnswer(d: Decision, ctx: BotContext): Response {
  if (ctx.attempts >= 2) return defaultAnswer(d);
  const { view } = ctx;
  switch (d.type) {
    case 'priority': {
      const me = d.player;
      const myTurn = view.turn.activePlayer === me;
      const mainPhase = view.turn.step === 'main1' || view.turn.step === 'main2';
      if (!myTurn || !mainPhase || view.stack.length > 0) return { type: 'pass' };
      const playable = d.playableCards.map((id) => view.objects[id]).filter(Boolean);
      if (d.canPlayLand) {
        const land = playable.find((o) => o.types.includes('Land') && o.zone === 'hand');
        if (land) return { type: 'playLand', objectId: land.id };
      }
      // Cast the most expensive thing we can, preferring permanents (fewer targeting prompts).
      const spells = playable.filter((o) => !o.types.includes('Land') && (o.zone === 'hand' || o.zone === 'command'));
      const permanents = spells.filter((o) => !o.types.includes('Instant') && !o.types.includes('Sorcery') && o.coverage !== 'none');
      const pool = permanents.length ? permanents : spells.filter((o) => o.coverage === 'full');
      pool.sort((a, b) => b.manaValue - a.manaValue);
      if (pool.length && ctx.attempts === 0) return { type: 'cast', objectId: pool[0].id };
      // Activate a non-mana ability occasionally.
      const abilities = d.activatableAbilities.filter((a) => !view.objects[a.objectId]?.abilities.find((x) => x.index === a.abilityIndex)?.manaAbility);
      if (abilities.length && ctx.rng() < 0.15 && ctx.attempts === 0) {
        const a = abilities[0];
        return { type: 'activate', objectId: a.objectId, abilityIndex: a.abilityIndex };
      }
      return { type: 'pass' };
    }
    case 'declareAttackers': {
      const attacks: { attacker: ObjectId; target: PlayerId | ObjectId }[] = [];
      for (const c of d.candidates) {
        const humans = c.canAttack.filter((t) => typeof t === 'string' && !ctx.botIds.has(t));
        const target = pick(humans.length ? humans : c.canAttack, ctx.rng);
        if (target === undefined) continue;
        const obj = view.objects[c.id];
        const aggressive = c.mustAttack || (obj && (obj.power ?? 0) >= 2) || ctx.rng() < 0.5;
        if (aggressive) attacks.push({ attacker: c.id, target });
      }
      return { type: 'attackers', attacks };
    }
    case 'declareBlockers': {
      const blocks: { blocker: ObjectId; attacker: ObjectId }[] = [];
      const used = new Set<ObjectId>();
      for (const c of d.candidates) {
        const blocker = view.objects[c.id];
        if (!blocker) continue;
        const target = c.canBlock.find((a) => {
          const att = view.objects[a];
          return att && !used.has(a) && (blocker.toughness ?? 0) > (att.power ?? 0);
        });
        if (target !== undefined) {
          blocks.push({ blocker: c.id, attacker: target });
          used.add(target);
        }
      }
      return { type: 'blockers', blocks };
    }
    case 'chooseTargets': {
      // Prefer targeting opponents / their stuff when the slot allows players.
      const targets = d.slots.map((s) => {
        const legal = [...s.legal];
        const opp = legal.filter((t) => (t.kind === 'player' ? t.id !== d.player : t.kind === 'object' ? view.objects[t.id]?.controller !== d.player : true));
        const chosen = (opp.length >= s.min ? opp : legal).slice(0, s.min);
        return chosen;
      });
      return { type: 'targets', targets };
    }
    case 'mulligan':
      return { type: 'mulligan', keep: true };
    default:
      return defaultAnswer(d);
  }
}

export function seededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
