import { describe, it, expect } from 'vitest';
import { newGame, setup, deck, FOREST, WARP_GUY } from './helpers.js';
import type { Decision } from '../src/types.js';
type Prio = Extract<Decision, { type: 'priority' }>;
const forests = () => deck([FOREST], 40);
describe('warp edge cases', () => {
  it('a warped creature exiled at end step is only castable by its controller, and a failed cast keeps the decision id', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const beast = d.give(p1, WARP_GUY);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: beast, alternativeCost: 'warp' });
    d.resolveAll();
    d.until((x) => x.type === 'priority' && x.player === p2 && d.g.state.turn.activePlayer === p2 && d.g.state.turn.step === 'main1');
    expect(d.g.obj(beast).zone).toBe('exile');
    expect((d.d as Prio).playableCards).not.toContain(beast);
    // An illegal cast attempt is rejected, re-asked under the same id with an error, and the player keeps priority.
    const id = d.d.id;
    d.submit({ type: 'cast', objectId: beast });
    expect(d.d.type).toBe('priority');
    expect(d.d.player).toBe(p2);
    expect(d.d.id).toBe(id);
    expect((d.d as { error?: string }).error).toMatch(/Could not cast/);
  });

  it('a warped creature that died stays in the graveyard and is not castable by anyone', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const beast = d.give(p1, WARP_GUY);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: beast, alternativeCost: 'warp' });
    d.resolveAll();
    expect(d.g.obj(beast).zone).toBe('battlefield');
    d.g.applyManual(p1, { kind: 'moveObject', objectId: beast, toZone: 'graveyard' });
    expect(d.g.obj(beast).zone).toBe('graveyard');
    d.until((x) => d.g.state.turn.number === 2);
    expect(d.g.obj(beast).zone).toBe('graveyard');
    d.until((x) => x.type === 'priority' && x.player === p2 && d.g.state.turn.activePlayer === p2 && d.g.state.turn.step === 'main1');
    expect((d.d as Prio).playableCards).not.toContain(beast);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.activePlayer === p1 && d.g.state.turn.number === 3 && d.g.state.turn.step === 'main1');
    expect((d.d as Prio).playableCards).not.toContain(beast);
  });
});
