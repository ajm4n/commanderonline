import type { Game, Gen } from './game.js';
import type { GameObject, ObjectId } from './types.js';
import { auraTargetSpec, enterBattlefield } from './effects.js';
import { legalTargets, matchesFilter } from './filters.js';

function matchesFilterFor(g: Game, id: ObjectId, filter: import('./types.js').ObjectFilter, controller: import('./types.js').PlayerId): boolean {
  return matchesFilter(g, g.obj(id), { ...filter, zone: 'battlefield' }, { sourceId: null, controller });
}

/**
 * State-based actions (rule 704). Loops until nothing changes. May need
 * player decisions (legend rule, commander zone choice).
 */
export function* checkStateBasedActions(g: Game): Gen {
  for (let iter = 0; iter < 50; iter++) {
    if (g.state.over) return;
    let changed = false;
    g.pruneConditionalDurations();
    // Ascend: ten or more permanents while controlling an Ascend source grants the city's blessing for the rest of the game.
    for (const pid of g.activePlayers()) {
      const pl = g.player(pid);
      if (pl.flags['cityBlessing']) continue;
      const mine = g.state.battlefield.filter((id) => g.obj(id).controller === pid);
      if (mine.length >= 10 && mine.some((id) => g.characteristics(id).keywords.has('Ascend'))) {
        pl.flags['cityBlessing'] = true;
        g.log(`${pl.name} gets the city's blessing.`);
      }
    }

    // State triggers ("When no creatures are on the battlefield, sacrifice ~"): fire on the rising edge.
    for (const id of [...g.state.battlefield]) {
      const o = g.state.objects[id];
      if (!o) continue;
      const abs = g.scriptFor(o).abilities;
      for (let i = 0; i < abs.length; i++) {
        const ab = abs[i];
        if (ab.kind !== 'triggered' || !ab.stateCondition) continue;
        const key = `stFired:${i}`;
        const now = g.checkCondition(ab.stateCondition, { sourceId: id, controller: o.controller });
        if (now && !o.memory[key]) {
          o.memory[key] = true;
          g.queueTrigger({ sourceId: id, controller: o.controller, ability: ab, context: {} });
          changed = true;
        } else if (!now && o.memory[key]) delete o.memory[key];
      }
    }

    // Soulbond: a pair breaks when either creature leaves the battlefield or changes controller.
    for (const id of [...g.state.battlefield]) {
      const o = g.state.objects[id];
      if (!o || o.pairedWith === null || o.pairedWith === undefined) continue;
      const other = g.state.objects[o.pairedWith];
      if (!other || other.zone !== 'battlefield' || other.controller !== o.controller || other.pairedWith !== id) {
        o.pairedWith = null;
        if (other && other.pairedWith === id) other.pairedWith = null;
        changed = true;
      }
    }

    // General state triggers: "When ~ has no +1/+1 counters on it, sacrifice it."
    for (const id of [...g.state.battlefield]) {
      const o = g.state.objects[id];
      if (!o) continue;
      for (const ab of g.scriptFor(o).abilities) {
        if (ab.kind !== 'triggered' || ab.event !== 'stateTrigger' || !ab.condition) continue;
        const holds = g.checkCondition(ab.condition, { sourceId: id, controller: o.controller });
        const key = `state:${ab.text}`;
        if (!holds) {
          if (o.memory[key]) delete o.memory[key];
          continue;
        }
        if (o.memory[key]) continue;
        o.memory[key] = 1;
        g.queueTrigger({ sourceId: id, controller: o.controller, ability: { ...ab, event: 'stateTrigger' }, context: {} });
        changed = true;
      }
    }

    // "When you control no Islands, sacrifice ~." (a state trigger, handled like an SBA)
    for (const id of [...g.state.battlefield]) {
      const o = g.state.objects[id];
      if (!o) continue;
      for (const r of g.characteristics(id).rules) {
        if (r.kind !== 'custom' || r.tag !== 'sacrificeUnlessControl') continue;
        const filter = r.data as import('./types.js').ObjectFilter;
        if (g.state.battlefield.some((x) => x !== id && g.obj(x).controller === o.controller && matchesFilterFor(g, x, filter, o.controller))) continue;
        g.log(`${g.nameOf(id)} is sacrificed: its controller controls none of the required permanents.`);
        g.moveObject(id, 'graveyard', { cause: 'sacrifice' });
        changed = true;
      }
    }

    // 704.5a-c, 704.5u: players lose
    for (const pid of g.activePlayers()) {
      const p = g.player(pid);
      const cantLose = g.playerRules(pid).some((r) => r.kind === 'cantLose') || p.flags['cantLose'];
      if (cantLose) continue;
      if (p.life <= 0) {
        g.playerLoses(pid, `life total ${p.life}`);
        changed = true;
      } else if (p.poison >= 10) {
        g.playerLoses(pid, 'ten poison counters');
        changed = true;
      } else if (p.attemptedDrawFromEmpty) {
        g.playerLoses(pid, 'drew from an empty library');
        changed = true;
      } else {
        const cd = Object.entries(p.commanderDamage).find(([, n]) => n >= g.config.commanderDamageThreshold);
        if (cd) {
          g.playerLoses(pid, `${g.config.commanderDamageThreshold} damage from a commander`);
          changed = true;
        }
      }
      if (g.state.over) return;
    }

    // Permanents. One sweep puts everything into the graveyard simultaneously, so
    // leave-the-battlefield abilities see every other permanent that died with them.
    g.simultaneousZoneChange(() => {
      for (const id of [...g.state.battlefield]) {
        const o = g.state.objects[id];
        if (!o || o.zone !== 'battlefield') continue;
        const ch = g.characteristics(id);
        if (ch.types.includes('Creature')) {
          if ((ch.toughness ?? 0) <= 0) {
            g.log(`${g.nameOf(id)} has 0 or less toughness and is put into the graveyard.`);
            g.moveObject(id, 'graveyard', { cause: 'other' });
            changed = true;
            continue;
          }
          if ((o.damage >= (ch.toughness ?? 0) || o.deathtouchDamage) && !ch.keywords.has('Indestructible')) {
            const { destroyObject } = effectsMod();
            destroyObject(g, id, null);
            changed = true;
            continue;
          }
        }
        if (ch.types.includes('Planeswalker') && (o.counters['loyalty'] ?? 0) <= 0) {
          g.log(`${g.nameOf(id)} has no loyalty and is put into the graveyard.`);
          g.moveObject(id, 'graveyard', { cause: 'other' });
          changed = true;
          continue;
        }
        if (ch.types.includes('Battle') && (o.counters['defense'] ?? 0) <= 0) {
          g.moveObject(id, 'graveyard', { cause: 'other' });
          changed = true;
          continue;
        }
        // Auras
        if (ch.types.includes('Enchantment') && ch.subtypes.includes('Aura')) {
          const host = o.attachedTo !== null ? g.state.objects[o.attachedTo] : null;
          let illegal = !host || host.zone !== 'battlefield';
          if (!illegal && host) {
            const spec = auraTargetSpec(o.card.oracleText);
            if (spec.kind === 'object') {
              const legal = legalTargets(g, spec, id, o.controller);
              if (!legal.some((t) => t.kind === 'object' && t.id === host.id)) illegal = true;
            }
          }
          if (illegal) {
            g.log(`${g.nameOf(id)} is no longer attached to anything legal and is put into the graveyard.`);
            g.moveObject(id, 'graveyard', { cause: 'other' });
            changed = true;
            continue;
          }
        }
        // Equipment / Fortification attached to wrong thing → unattach
        if (o.attachedTo !== null && (ch.subtypes.includes('Equipment') || ch.subtypes.includes('Fortification'))) {
          const host = g.state.objects[o.attachedTo];
          const hostCh = host ? g.characteristics(host.id) : null;
          const ok = host && host.zone === 'battlefield' && hostCh && (ch.subtypes.includes('Equipment') ? hostCh.types.includes('Creature') : hostCh.types.includes('Land'));
          if (!ok) {
            if (host) host.attachments = host.attachments.filter((x) => x !== id);
            o.attachedTo = null;
            g.emit({ name: 'becomesUnattached', objectId: id, sourceId: host?.id });
            g.touch();
            changed = true;
          }
        }
        // +1/+1 and -1/-1 annihilate
        const plus = o.counters['+1/+1'] ?? 0;
        const minus = o.counters['-1/-1'] ?? 0;
        if (plus > 0 && minus > 0) {
          const n = Math.min(plus, minus);
          o.counters['+1/+1'] = plus - n;
          o.counters['-1/-1'] = minus - n;
          if (!o.counters['+1/+1']) delete o.counters['+1/+1'];
          if (!o.counters['-1/-1']) delete o.counters['-1/-1'];
          g.touch();
          changed = true;
        }
      }
    });

    // Control-changing continuous effects (layer 2) take effect here.
    for (const id of [...g.state.battlefield]) {
      const o = g.state.objects[id];
      if (!o) continue;
      const ch = g.characteristics(id);
      if (ch.controller !== o.controller && g.state.players[ch.controller] && !g.state.players[ch.controller].lost) {
        const prev = o.controller;
        o.controller = ch.controller;
        o.controlSinceTurn = g.state.turn.number;
        o.attacking = null;
        o.blocking = [];
        g.touch();
        g.log(`${g.player(ch.controller).name} gains control of ${g.nameOf(id)}.`);
        g.emit({ name: 'controlChanged', objectId: id, playerId: ch.controller, otherPlayerId: prev });
        changed = true;
      }
    }

    // Legend rule
    const groups = new Map<string, ObjectId[]>();
    for (const id of g.state.battlefield) {
      const o = g.obj(id);
      const ch = g.characteristics(id);
      if (!ch.supertypes.includes('Legendary') || !ch.name) continue;
      // "The \"legend rule\" doesn't apply to tokens you control."
      if (g.playerRules(o.controller).some((r) => {
        if (r.kind !== 'custom' || r.tag !== 'noLegendRule') return false;
        const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter;
        return !f || matchesFilter(g, o, { ...f, zone: undefined }, { sourceId: null, controller: o.controller });
      })) continue;
      const key = `${o.controller}::${ch.name}`;
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    for (const [key, ids] of groups) {
      if (ids.length < 2) continue;
      const controller = key.split('::')[0];
      const resp = yield* g.ask({ type: 'chooseObjects', player: controller, prompt: `Legend rule: choose one ${g.nameOf(ids[0])} to keep`, candidates: ids, min: 1, max: 1 });
      const keep = resp.type === 'objects' ? resp.ids[0] : ids[0];
      for (const id of ids) if (id !== keep) g.moveObject(id, 'graveyard', { cause: 'other' });
      changed = true;
    }

    // Commanders in graveyard / exile → command zone (903.9a)
    for (const o of Object.values(g.state.objects)) {
      if (!o.isCommander || o.memory['commanderZoneOffered'] !== false || (o.zone !== 'graveyard' && o.zone !== 'exile' && o.zone !== 'hand' && o.zone !== 'library')) continue;
      o.memory['commanderZoneOffered'] = true;
      const where = o.zone === 'graveyard' ? 'your graveyard' : o.zone === 'exile' ? 'exile' : o.zone === 'hand' ? 'your hand' : 'your library';
      const resp = yield* g.ask({ type: 'yesNo', player: o.owner, prompt: `${o.card.name} is in ${where}. Move it to the command zone?`, yesLabel: 'Command zone', noLabel: `Leave in ${o.zone}`, sourceId: o.id });
      if (resp.type === 'yesNo' && resp.value) {
        g.moveObject(o.id, 'command', { skipEvents: true });
        g.log(`${o.card.name} returns to the command zone.`);
        changed = true;
      }
    }

    // Cards exiled "until this leaves the battlefield" whose source has left.
    if (g.pendingReturns.length) {
      const ids = g.pendingReturns.splice(0);
      for (const id of ids) {
        const o = g.state.objects[id];
        if (!o || o.zone !== 'exile') continue;
        yield* enterBattlefield(g, id, o.owner, {});
        g.log(`${g.nameOf(id)} returns to the battlefield.`);
      }
      changed = true;
    }

    if (!changed) return;
  }
}

function effectsMod(): typeof import('./effects.js') {
  return effectsModule;
}
import * as effectsModule from './effects.js';
