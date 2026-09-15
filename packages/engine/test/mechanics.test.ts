import { describe, it, expect } from 'vitest';
import { newGame, deck, setup, FOREST, ISLAND, MOUNTAIN, PLAINS, BEARS, SOL_RING, CONTROL_MAGIC, CONVOKE_GUY, DELVE_SPELL, AFFINITY_GUY, PLOT_SPELL, WARP_GUY, MONSTER, LEVELER } from './helpers.js';

const forests = () => deck([FOREST], 40);
type Prio = { playableCards: number[]; activatableAbilities: { objectId: number; abilityIndex: number }[]; alternativeCosts: { objectId: number; id: string }[] };

describe('control-changing auras', () => {
  it('Control Magic steals a creature and gives it back when the aura leaves', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 4; i++) d.put(p1, ISLAND);
    const bears = d.put(p2, BEARS);
    const cm = d.give(p1, CONTROL_MAGIC);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: cm });
    if (d.d?.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.resolveAll();
    expect(d.g.obj(bears).controller).toBe(p1);
    expect(d.g.obj(cm).attachedTo).toBe(bears);
    // Aura leaves → control reverts (state-based sync)
    d.g.moveObject(cm, 'graveyard', { cause: 'destroy' });
    d.g.refreshDecision();
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority');
    expect(d.g.obj(bears).controller).toBe(p2);
  });
});

describe('alternative payment', () => {
  it('convoke taps creatures to pay', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    d.put(p1, FOREST);
    const b1 = d.put(p1, BEARS);
    const b2 = d.put(p1, BEARS);
    const b3 = d.put(p1, BEARS);
    const b4 = d.put(p1, BEARS);
    const wurm = d.give(p1, CONVOKE_GUY); // {4}{G}{G}: 2 forests + 4 green creatures
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(wurm);
    d.submit({ type: 'cast', objectId: wurm });
    d.resolveAll();
    expect(d.g.obj(wurm).zone).toBe('battlefield');
    expect([b1, b2, b3, b4].every((id) => d.g.obj(id).tapped)).toBe(true);
  });

  it('delve exiles graveyard cards chosen by the player', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, ISLAND);
    for (let i = 0; i < 6; i++) d.g.createObject(BEARS, p1, 'graveyard', { skipEvents: true });
    const spell = d.give(p1, DELVE_SPELL); // {6}{U}
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(spell);
    d.submit({ type: 'cast', objectId: spell });
    d.until((x) => x.type === 'chooseObjects' && /Delve/.test(x.prompt));
    const dec = d.d as { candidates: number[]; min: number };
    expect(dec.min).toBe(6);
    d.submit({ type: 'objects', ids: dec.candidates.slice(0, 6) });
    d.resolveAll();
    expect(d.g.player(p1).graveyard.filter((id) => d.g.obj(id).card.name === 'Grizzly Bears').length).toBe(0);
    expect(d.g.player(p1).exile.length).toBe(6);
  });

  it('affinity reduces the cost per artifact', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, SOL_RING);
    d.put(p1, SOL_RING);
    d.put(p1, SOL_RING);
    d.put(p1, SOL_RING);
    // 4 artifacts → Frogmite costs {0}
    d.g.state.battlefield.forEach((id) => (d.g.obj(id).tapped = true));
    d.g.touch();
    const frog = d.give(p1, AFFINITY_GUY);
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(frog);
    d.submit({ type: 'cast', objectId: frog });
    d.resolveAll();
    expect(d.g.obj(frog).zone).toBe('battlefield');
  });
});

describe('plot and warp', () => {
  it('a plotted card is cast for free on a later turn, at sorcery speed', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    const bolt = d.give(p1, PLOT_SPELL);
    d.until((x) => x.type === 'priority' && x.player === p1);
    const ab = (d.d as Prio).activatableAbilities.find((a) => a.objectId === bolt);
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: bolt, abilityIndex: ab!.abilityIndex });
    d.resolveAll();
    expect(d.g.obj(bolt).zone).toBe('exile');
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).not.toContain(bolt); // not this turn
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.activePlayer === p1 && d.g.state.turn.number >= 3 && d.g.state.turn.step === 'main1');
    d.g.state.battlefield.forEach((id) => (d.g.obj(id).tapped = true)); // no mana available: still castable (free)
    d.g.touch();
    d.g.refreshDecision();
    expect((d.d as Prio).playableCards).toContain(bolt);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(37);
  });

  it('warp: cast cheaply, exiled at end step, castable from exile later', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const beast = d.give(p1, WARP_GUY);
    d.until((x) => x.type === 'priority' && x.player === p1);
    const prio = d.d as Prio;
    expect(prio.playableCards).toContain(beast);
    expect(prio.alternativeCosts).toEqual([{ objectId: beast, id: 'warp', label: 'Warp {G}' }]);
    d.submit({ type: 'cast', objectId: beast, alternativeCost: 'warp' });
    d.resolveAll();
    expect(d.g.obj(beast).zone).toBe('battlefield');
    d.until((x) => d.g.state.turn.number === 2);
    expect(d.g.obj(beast).zone).toBe('exile');
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.activePlayer === p1 && d.g.state.turn.number === 3 && d.g.state.turn.step === 'main1');
    for (let i = 0; i < 3; i++) d.put(p1, FOREST);
    expect((d.d as Prio).playableCards).toContain(beast);
    d.submit({ type: 'cast', objectId: beast });
    d.resolveAll();
    expect(d.g.obj(beast).zone).toBe('battlefield');
  });
});

describe('monstrosity and level up', () => {
  it('monstrosity adds counters once and fires its trigger', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 6; i++) d.put(p1, FOREST);
    const m = d.put(p1, MONSTER);
    d.until((x) => x.type === 'priority' && x.player === p1);
    const ab = (d.d as Prio).activatableAbilities.find((a) => a.objectId === m)!;
    d.submit({ type: 'activate', objectId: m, abilityIndex: ab.abilityIndex });
    d.resolveAll();
    expect(d.g.characteristics(m).power).toBe(5);
    expect(d.g.player(p1).life).toBe(43);
    const ab2 = (d.d as Prio).activatableAbilities.find((a) => a.objectId === m)!;
    d.submit({ type: 'activate', objectId: m, abilityIndex: ab2.abilityIndex });
    d.resolveAll();
    expect(d.g.characteristics(m).power).toBe(5); // already monstrous
    expect(d.g.player(p1).life).toBe(43);
  });

  it('level up changes P/T and abilities by level', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 3; i++) d.put(p1, PLAINS);
    const lv = d.put(p1, LEVELER);
    expect(d.g.characteristics(lv).power).toBe(1);
    const levelUp = () => {
      d.until((x) => x.type === 'priority' && x.player === p1);
      const ab = (d.d as Prio).activatableAbilities.find((a) => a.objectId === lv)!;
      d.submit({ type: 'activate', objectId: lv, abilityIndex: ab.abilityIndex });
      d.resolveAll();
    };
    levelUp();
    expect(d.g.characteristics(lv).power).toBe(2);
    expect(d.g.characteristics(lv).keywords.has('Lifelink')).toBe(false);
    levelUp();
    levelUp();
    expect(d.g.characteristics(lv).power).toBe(3);
    expect(d.g.characteristics(lv).keywords.has('Lifelink')).toBe(true);
  });
});
