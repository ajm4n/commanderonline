import { describe, it, expect } from 'vitest';
import { newGame, setup, deck, MOUNTAIN, MORPH_GUY } from './helpers.js';
import type { Decision } from '../src/types.js';
type Prio = Extract<Decision, { type: 'priority' }>;
const mountains = () => deck([MOUNTAIN], 40);

describe('morph', () => {
  it('casts face down as a nameless 2/2 with no abilities, then turns face up with a counter and triggers', () => {
    const d = newGame([setup('a', mountains()), setup('b', mountains())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 10; i++) d.put(p1, MOUNTAIN);
    const dragon = d.give(p1, MORPH_GUY);
    d.until((x) => x.type === 'priority' && x.player === p1);
    // The face-down cast is offered as an alternative cost.
    expect((d.d as Prio).alternativeCosts?.some((a) => a.objectId === dragon && a.id === 'megamorph')).toBe(true);
    d.submit({ type: 'cast', objectId: dragon, alternativeCost: 'megamorph' });
    d.resolveAll();

    const o = d.g.obj(dragon);
    expect(o.zone).toBe('battlefield');
    expect(o.faceDown).toBe(true);
    const ch = d.g.characteristics(dragon);
    expect(ch.name).toBe('');
    expect(ch.power).toBe(2);
    expect(ch.toughness).toBe(2);
    expect(ch.keywords.has('Flying')).toBe(false);

    // Face down, only the turn-up ability is available.
    d.until((x) => x.type === 'priority' && x.player === p1);
    const abilities = ((d.d as Prio).activatableAbilities ?? []).filter((a) => a.objectId === dragon);
    expect(abilities).toHaveLength(1);
    expect(abilities[0].text).toMatch(/face up/i);

    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'activate', objectId: dragon, abilityIndex: abilities[0].abilityIndex, targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();

    const after = d.g.obj(dragon);
    expect(after.faceDown).toBe(false);
    expect(after.counters['+1/+1']).toBe(1);
    expect(d.g.characteristics(dragon).keywords.has('Flying')).toBe(true);
    // The turned-face-up trigger dealt its 2 damage (the driver picks the first legal target).
    const lives = d.g.state.playerOrder.map((x) => d.g.player(x).life);
    expect(lives.filter((l) => l === 38)).toHaveLength(1);
  });
});
