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

    // Permanents
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
      if (!o.isCommander || (o.zone !== 'graveyard' && o.zone !== 'exile') || o.memory['commanderZoneOffered']) continue;
      o.memory['commanderZoneOffered'] = true;
      const resp = yield* g.ask({ type: 'yesNo', player: o.owner, prompt: `${o.card.name} is in ${o.zone === 'graveyard' ? 'your graveyard' : 'exile'}. Move it to the command zone?`, yesLabel: 'Command zone', noLabel: `Leave in ${o.zone}`, sourceId: o.id });
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
