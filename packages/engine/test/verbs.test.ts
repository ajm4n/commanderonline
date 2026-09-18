import { describe, it, expect } from 'vitest';
import { newGame, deck, setup, FOREST, PLAINS, BEARS, WRATH, BLOOD_ARTIST, VISIONARY, SURVEILLER, SEER, SLEUTH, PIRATE, MILLER, DRAW_WATCHER, type Driver } from './helpers.js';
import type { CardData, PlayerId } from '../src/index.js';

const forests = () => deck([FOREST], 40);
const two = () => newGame([setup('a', forests()), setup('b', forests())]);

/** Cast `c` for real (so its enter-the-battlefield trigger fires) off `mana` freshly-put lands. */
function castWith(d: Driver, p: PlayerId, c: CardData, mana = 2, land = FOREST) {
  for (let i = 0; i < mana; i++) d.put(p, land);
  d.give(p, c);
  d.until((x) => x.type === 'priority' && x.player === p);
  d.submit({ type: 'cast', objectId: d.hand(p, c.name) });
}

describe('verbs actually change the game state', () => {
  it('surveil puts the chosen card in the graveyard and leaves the rest on top', () => {
    const d = two();
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    const top = d.g.player(p).library.slice(0, 2);
    castWith(d, p, SURVEILLER);
    d.until((x) => x.type === 'chooseObjects' && x.player === p && x.candidates.includes(top[0]));
    d.submit({ type: 'objects', ids: [top[0]] });
    d.resolveAll();
    expect(d.g.obj(top[0]).zone).toBe('graveyard');
    expect(d.g.player(p).graveyard).toContain(top[0]);
    expect(d.g.player(p).library[0]).toBe(top[1]);
  });

  it('scry keeps the library the same size and puts nothing in the graveyard', () => {
    const d = two();
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    const n = d.g.player(p).library.length;
    const top = d.g.player(p).library.slice(0, 2);
    castWith(d, p, SEER);
    d.resolveAll();
    expect(d.g.player(p).library.length).toBe(n);
    expect([...d.g.player(p).library.slice(0, 2)].sort()).toEqual([...top].sort());
    expect(d.g.player(p).graveyard.length).toBe(0);
  });

  it('"each opponent investigates" gives the Clues to the opponents, not the controller', () => {
    const d = two();
    const [p, q] = d.g.state.playerOrder;
    d.toMainPhase(p);
    castWith(d, p, SLEUTH);
    d.resolveAll();
    const clues = (who: PlayerId) => d.g.state.battlefield.filter((id) => d.g.obj(id).card.name === 'Clue' && d.g.obj(id).controller === who);
    expect(clues(q).length).toBe(1);
    expect(clues(p).length).toBe(0);
  });

  it('creating Treasure tokens puts them on the battlefield', () => {
    const d = two();
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    castWith(d, p, PIRATE);
    d.resolveAll();
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).card.name === 'Treasure' && d.g.obj(id).controller === p).length).toBe(2);
  });

  it('"each opponent mills" moves cards from their library to their graveyard', () => {
    const d = two();
    const [p, q] = d.g.state.playerOrder;
    d.toMainPhase(p);
    const before = d.g.player(q).library.length;
    castWith(d, p, MILLER);
    d.resolveAll();
    expect(d.g.player(q).library.length).toBe(before - 3);
    expect(d.g.player(q).graveyard.length).toBe(3);
    expect(d.g.player(p).graveyard.length).toBe(0);
  });
});

describe('triggers keep firing', () => {
  /** Answer everything, pointing any player target at `foe`, until the stack is empty. */
  function drain(d: Driver, foe: PlayerId, onDecision?: (t: string, ctx?: string) => void) {
    for (let i = 0; i < 200 && d.g.pending; i++) {
      const dec = d.g.pending;
      onDecision?.(dec.type, dec.type === 'orderObjects' ? dec.context : undefined);
      if (dec.type === 'priority' && d.g.state.stack.length === 0) return;
      if (dec.type === 'chooseTargets') {
        const picked = dec.slots.map((sl) => {
          const foeTarget = sl.legal.filter((t) => t.kind === 'player' && t.id === foe).slice(0, 1);
          return foeTarget.length ? foeTarget : sl.legal.slice(0, sl.min);
        });
        d.submit({ type: 'targets', targets: picked });
        continue;
      }
      d.defaultAnswer(dec);
    }
  }

  it('fires once per death when several creatures die at the same time', () => {
    const d = two();
    const [p, q] = d.g.state.playerOrder;
    d.toMainPhase(p);
    d.put(p, BLOOD_ARTIST);
    d.put(p, BEARS);
    d.put(q, BEARS);
    const life = d.g.player(p).life;
    const foe = d.g.player(q).life;
    castWith(d, p, WRATH, 4, PLAINS);
    drain(d, q);
    expect(d.g.state.battlefield.filter((id) => d.g.characteristics(id).types.includes('Creature')).length).toBe(0);
    // Blood Artist and both Bears die: three triggers.
    expect(d.g.player(p).life).toBe(life + 3);
    expect(d.g.player(q).life).toBe(foe - 3);
  });

  it('a trigger that fires during another trigger still resolves', () => {
    const d = two();
    const p = d.g.state.playerOrder[0];
    d.toMainPhase(p);
    d.put(p, DRAW_WATCHER);
    const life = d.g.player(p).life;
    const hand = d.g.player(p).hand.length;
    castWith(d, p, VISIONARY);
    d.resolveAll();
    // Visionary's ETB draws, which triggers Draw Watcher.
    expect(d.g.player(p).hand.length).toBe(hand + 1);
    expect(d.g.player(p).life).toBe(life + 1);
  });

  it('does not ask a player to order their own simultaneous triggers', () => {
    const d = two();
    const [p, q] = d.g.state.playerOrder;
    d.toMainPhase(p);
    d.put(p, BLOOD_ARTIST);
    d.put(p, DRAW_WATCHER);
    d.put(p, BEARS);
    d.put(q, BEARS);
    let asked = false;
    castWith(d, p, WRATH, 4, PLAINS);
    drain(d, q, (t, ctx) => {
      if (t === 'orderObjects' && ctx === 'triggers') asked = true;
    });
    expect(asked).toBe(false);
  });
});
