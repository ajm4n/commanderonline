import { describe, it, expect } from 'vitest';
import { Game } from '../src/index.js';
import { newGame, deck, setup, FOREST, MOUNTAIN, ISLAND, PLAINS, BEARS, BOLT, SOL_RING, ELVES, SERRA, WALL, VISIONARY, BLOOD_ARTIST, ANTHEM, COUNTERSPELL, COMMANDER, GIANT_GROWTH, WRATH, UNSCRIPTED, UPKEEP_GUY, scriptProvider } from './helpers.js';

const forests = () => deck([FOREST], 40);

describe('game start', () => {
  it('deals opening hands and asks for mulligans', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    expect(d.d?.type).toBe('mulligan');
    expect(d.g.player('a').hand.length).toBe(7);
    expect(d.g.player('b').hand.length).toBe(7);
  });

  it('London mulligan with a free first mulligan', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const first = d.d!.player;
    d.submit({ type: 'mulligan', keep: false }); // free
    d.until((x) => x.type === 'mulligan' && x.player === first);
    expect(d.g.player(first).hand.length).toBe(7);
    d.submit({ type: 'mulligan', keep: false }); // second: bottom 1
    d.until((x) => x.type === 'mulligan' && x.player === first);
    const hand = [...d.g.player(first).hand];
    d.submit({ type: 'mulligan', keep: true, bottom: [hand[0]] });
    d.until((x) => x.type !== 'mulligan' || x.player !== first);
    expect(d.g.player(first).hand.length).toBe(6);
  });

  it('first player skips draw in a two-player game and reaches main phase with priority', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const first = d.g.state.playerOrder[0];
    d.toMainPhase(first);
    expect(d.g.state.turn.number).toBe(1);
    expect(d.g.player(first).hand.length).toBe(7);
    expect(d.d?.type).toBe('priority');
    expect((d.d as { canPlayLand: boolean }).canPlayLand).toBe(true);
  });
});

describe('lands, mana and casting', () => {
  it('plays a land, then only one per turn', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    d.playLand(p, 'Forest');
    expect(d.g.state.battlefield.length).toBe(1);
    d.until((x) => x.type === 'priority' && x.player === p);
    expect((d.d as { canPlayLand: boolean }).canPlayLand).toBe(false);
  });

  it('auto-taps lands to cast a creature; creature is summoning sick', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    d.put(p, FOREST);
    d.put(p, FOREST);
    const bears = d.give(p, BEARS);
    d.until((x) => x.type === 'priority' && x.player === p);
    expect((d.d as { playableCards: number[] }).playableCards).toContain(bears);
    d.submit({ type: 'cast', objectId: bears });
    // Nobody has anything to respond with, so everyone auto-passes and it resolves at once.
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).tapped).length).toBe(2);
    d.resolveAll();
    expect(d.g.obj(bears).zone).toBe('battlefield');
    expect(d.g.state.log.some((l) => /casts Grizzly Bears/.test(l.text))).toBe(true);
    const view = d.g.characteristics(bears);
    expect(view.power).toBe(2);
  });

  it('Sol Ring makes two colorless and pays generic costs', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    d.put(p, SOL_RING);
    d.put(p, FOREST);
    const serraCost = d.give(p, BEARS); // {1}{G}: Sol Ring pays {1}, Forest pays {G}
    d.until((x) => x.type === 'priority' && x.player === p);
    d.submit({ type: 'cast', objectId: serraCost });
    d.resolveAll();
    expect(d.g.obj(serraCost).zone).toBe('battlefield');
    // Leftover colorless stays in the pool until end of step.
    expect(d.g.player(p).manaPool.C).toBe(1);
  });

  it('cannot cast a creature without enough mana', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    d.put(p, FOREST);
    const bears = d.give(p, BEARS);
    d.until((x) => x.type === 'priority' && x.player === p);
    expect((d.d as { playableCards: number[] }).playableCards).not.toContain(bears);
  });

  it('a mana creature can tap for mana only when not summoning sick', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    d.put(p, FOREST);
    const elves = d.give(p, ELVES);
    d.until((x) => x.type === 'priority' && x.player === p);
    d.submit({ type: 'cast', objectId: elves });
    d.resolveAll();
    const bears = d.give(p, BEARS);
    d.until((x) => x.type === 'priority' && x.player === p);
    expect((d.d as { playableCards: number[] }).playableCards).not.toContain(bears); // elves sick, forest tapped
  });
});

describe('combat', () => {
  it('attacks for damage; commander damage is tracked and vigilance does not tap', () => {
    const d = newGame([setup('a', forests(), [COMMANDER]), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    const cmdr = d.put(p1, COMMANDER);
    d.g.obj(cmdr).isCommander = true;
    const serra = d.put(p1, SERRA);
    d.until((x) => x.type === 'declareAttackers' && x.player === p1);
    const dec = d.d as { candidates: { id: number; canAttack: (string | number)[] }[] };
    expect(dec.candidates.map((c) => c.id).sort()).toEqual([cmdr, serra].sort());
    d.submit({ type: 'attackers', attacks: [{ attacker: cmdr, target: p2 }, { attacker: serra, target: p2 }] });
    expect(d.g.obj(cmdr).tapped).toBe(true);
    expect(d.g.obj(serra).tapped).toBe(false);
    d.until((x) => d.g.state.turn.step === 'main2');
    expect(d.g.player(p2).life).toBe(40 - 9);
    expect(d.g.player(p2).commanderDamage[cmdr]).toBe(5);
  });

  it('blocking: creatures trade and go to graveyards; flyers cannot be blocked by ground', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    const bears1 = d.put(p1, BEARS);
    const serra = d.put(p1, SERRA);
    const bears2 = d.put(p2, BEARS);
    d.until((x) => x.type === 'declareAttackers');
    d.submit({ type: 'attackers', attacks: [{ attacker: bears1, target: p2 }, { attacker: serra, target: p2 }] });
    d.until((x) => x.type === 'declareBlockers');
    const dec = d.d as { candidates: { id: number; canBlock: number[] }[] };
    expect(dec.candidates[0].canBlock).toEqual([bears1]);
    d.submit({ type: 'blockers', blocks: [{ blocker: bears2, attacker: bears1 }] });
    d.until((x) => d.g.state.turn.step === 'main2');
    expect(d.g.obj(bears1).zone).toBe('graveyard');
    expect(d.g.obj(bears2).zone).toBe('graveyard');
    expect(d.g.player(p2).life).toBe(36);
  });

  it('defenders cannot attack; trample assigns excess to the player', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, WALL);
    const cmdr = d.put(p1, COMMANDER); // 5/5 trample
    const wall = d.put(p2, WALL); // 0/3
    d.until((x) => x.type === 'declareAttackers');
    expect((d.d as { candidates: { id: number }[] }).candidates.map((c) => c.id)).toEqual([cmdr]);
    d.submit({ type: 'attackers', attacks: [{ attacker: cmdr, target: p2 }] });
    d.until((x) => x.type === 'declareBlockers');
    d.submit({ type: 'blockers', blocks: [{ blocker: wall, attacker: cmdr }] });
    d.until((x) => d.g.state.turn.step === 'main2');
    expect(d.g.obj(wall).zone).toBe('graveyard');
    expect(d.g.player(p2).life).toBe(38);
  });

  it('21 commander damage loses the game', () => {
    const d = newGame([setup('a', forests(), [COMMANDER]), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    const cmdr = d.put(p1, COMMANDER);
    d.g.obj(cmdr).isCommander = true;
    d.g.player(p2).commanderDamage[cmdr] = 16;
    d.until((x) => x.type === 'declareAttackers');
    d.submit({ type: 'attackers', attacks: [{ attacker: cmdr, target: p2 }] });
    d.until(() => d.g.state.over, 200);
    expect(d.g.state.winner).toBe(p1);
    expect(d.g.player(p2).lossReason).toMatch(/commander/);
  });
});

describe('spells, targets and the stack', () => {
  it('Lightning Bolt kills a creature via state-based actions', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    const bolt = d.give(p1, BOLT);
    const bears = d.put(p2, BEARS);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.resolveAll();
    expect(d.g.obj(bears).zone).toBe('graveyard');
    expect(d.g.obj(bolt).zone).toBe('graveyard');
  });

  it('Bolt to the face; opponent gets priority to respond with Counterspell', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.put(p2, ISLAND);
    d.put(p2, ISLAND);
    const bolt = d.give(p1, BOLT);
    const cs = d.give(p2, COUNTERSPELL);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    // p1 has nothing else to do and auto-passes; p2 gets priority with bolt on the stack
    d.until((x) => x.type === 'priority' && x.player === p2);
    expect(d.g.state.stack.length).toBe(1);
    expect((d.d as { playableCards: number[] }).playableCards).toContain(cs);
    d.submit({ type: 'cast', objectId: cs });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(40);
    expect(d.g.obj(bolt).zone).toBe('graveyard');
    expect(d.g.obj(cs).zone).toBe('graveyard');
  });

  it('a spell fizzles when its only target is gone', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    d.put(p2, MOUNTAIN);
    const bears = d.put(p1, BEARS);
    const gg = d.give(p1, GIANT_GROWTH);
    const bolt = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: gg });
    d.until((x) => x.type === 'priority' && x.player === p2);
    expect(d.g.state.stack.length).toBe(1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.resolveAll();
    expect(d.g.obj(bears).zone).toBe('graveyard');
    expect(d.g.obj(gg).zone).toBe('graveyard');
    expect(d.g.state.log.some((l) => /fizzles/.test(l.text))).toBe(true);
  });

  it('Giant Growth pumps until end of turn, then wears off', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const bears = d.put(p1, BEARS);
    const gg = d.give(p1, GIANT_GROWTH);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: gg });
    d.resolveAll();
    expect(d.g.characteristics(bears).power).toBe(5);
    d.until((x) => d.g.state.turn.number === 2);
    expect(d.g.characteristics(bears).power).toBe(2);
  });

  it('Wrath of God destroys everything', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 4; i++) d.put(p1, PLAINS);
    const b1 = d.put(p1, BEARS);
    const b2 = d.put(p2, BEARS);
    const w = d.give(p1, WRATH);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: w });
    d.resolveAll();
    expect(d.g.obj(b1).zone).toBe('graveyard');
    expect(d.g.obj(b2).zone).toBe('graveyard');
  });

  it('unscripted spells prompt the caster to resolve them by hand', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const m = d.give(p1, UNSCRIPTED);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: m });
    d.until((x) => x.type === 'manualTrigger');
    expect((d.d as { text: string }).text).toMatch(/does not understand/);
    d.submit({ type: 'manualDone' });
    d.resolveAll();
    expect(d.g.obj(m).zone).toBe('graveyard');
  });
});

describe('triggers and statics', () => {
  it('ETB trigger draws a card', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    d.put(p1, FOREST);
    const v = d.give(p1, VISIONARY);
    const before = d.g.player(p1).hand.length;
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: v });
    d.resolveAll();
    expect(d.g.player(p1).hand.length).toBe(before); // -1 cast +1 draw
    expect(d.g.state.log.some((l) => /Trigger: Elvish Visionary/.test(l.text))).toBe(true);
  });

  it('dies trigger with a target fires from the graveyard (look-back)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p2, MOUNTAIN);
    const artist = d.put(p1, BLOOD_ARTIST);
    const bolt = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: artist }]] });
    d.until((x) => x.type === 'chooseTargets' && x.player === p1); // Blood Artist trigger target
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(39);
    expect(d.g.player(p1).life).toBe(41);
  });

  it('static anthem applies through the layer system', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    const mine = d.put(p1, BEARS);
    const theirs = d.put(p2, BEARS);
    expect(d.g.characteristics(mine).power).toBe(2);
    d.put(p1, ANTHEM);
    expect(d.g.characteristics(mine).power).toBe(3);
    expect(d.g.characteristics(theirs).power).toBe(2);
  });

  it('upkeep triggers fire on the controller\'s upkeep only', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, UPKEEP_GUY);
    d.until((x) => d.g.state.turn.number === 2 && d.g.state.turn.step === 'main1');
    expect(d.g.player(p1).life).toBe(40);
    d.until((x) => d.g.state.turn.number === 3 && d.g.state.turn.step === 'main1');
    expect(d.g.player(p1).life).toBe(41);
    expect(d.g.player(p2).life).toBe(40);
  });
});

describe('commander rules', () => {
  it('casts the commander from the command zone with increasing tax and returns it on death', () => {
    const d = newGame([setup('a', forests(), [COMMANDER]), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 5; i++) d.put(p1, FOREST);
    const cmdr = d.g.player(p1).command[0];
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as { playableCards: number[] }).playableCards).toContain(cmdr);
    d.submit({ type: 'cast', objectId: cmdr });
    d.resolveAll();
    expect(d.g.obj(cmdr).zone).toBe('battlefield');
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).tapped).length).toBe(3);
    // Kill it
    d.put(p2, MOUNTAIN);
    const bolt = d.give(p2, BOLT);
    const bolt2 = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.g.obj(cmdr).damage = 3; // pre-damage so one bolt finishes it
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: cmdr }]] });
    d.until((x) => x.type === 'yesNo' && x.player === p1);
    expect((d.d as { prompt: string }).prompt).toMatch(/command zone/);
    d.submit({ type: 'yesNo', value: true });
    d.resolveAll();
    expect(d.g.obj(cmdr).zone).toBe('command');
    expect(d.g.obj(cmdr).commanderCasts).toBe(1);
    // Recast costs {2}{G} + {2} = 5 mana; we have 5 forests but 3 are tapped → not castable now
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as { playableCards: number[] }).playableCards).not.toContain(cmdr);
    void bolt2;
  });
});

describe('determinism', () => {
  it('replaying the decision history reproduces the same game', () => {
    const d = newGame([setup('a', deck([FOREST, BEARS, BOLT, MOUNTAIN], 40)), setup('b', deck([FOREST, BEARS, ELVES], 40))], 7);
    // Play a few turns with default answers.
    d.until((x) => d.g.state.turn.number >= 4, 2000);
    const setups = [setup('a', deck([FOREST, BEARS, BOLT, MOUNTAIN], 40)), setup('b', deck([FOREST, BEARS, ELVES], 40))];
    const g2 = Game.replay(setups, { seed: 7 }, d.g.history, scriptProvider);
    expect(g2.state.log.map((l) => l.text)).toEqual(d.g.state.log.map((l) => l.text));
    expect(g2.pending).toEqual(d.g.pending);
  });
});

describe('state-based actions', () => {
  it('a player at 0 life loses; the game ends when one remains', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.g.player(p2).life = 3;
    d.put(p1, MOUNTAIN);
    const bolt = d.give(p1, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.until(() => d.g.state.over, 100);
    expect(d.g.state.winner).toBe(p1);
  });

  it('legend rule asks which to keep', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, COMMANDER);
    const second = d.put(p1, COMMANDER);
    d.until((x) => x.type === 'chooseObjects' && /Legend rule/.test(x.prompt));
    d.submit({ type: 'objects', ids: [second] });
    d.until((x) => x.type === 'priority');
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).card.name === 'Test Commander').length).toBe(1);
    expect(d.g.obj(second).zone).toBe('battlefield');
  });
});
