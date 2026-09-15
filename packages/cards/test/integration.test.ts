/** Plays real fixture cards through compiled scripts inside the engine. */
import { describe, it, expect } from 'vitest';
import { Game, type CardData, type Decision, type PlayerSetup, type Response, type PlayerId, type ObjectId } from '@commander/engine';
import { loadFixtureDb } from '../src/db-node.js';
import { scriptFor } from '../src/index.js';

const db = loadFixtureDb();
const C = (n: string): CardData => {
  const c = db.byName(n);
  if (!c) throw new Error(`missing ${n}`);
  return c;
};
const forests = (n = 40) => Array.from({ length: n }, () => C('Forest'));

class D {
  constructor(public g: Game) {}
  get d() {
    return this.g.pending;
  }
  submit(r: Response) {
    this.g.submit(this.g.pending!.player, r);
  }
  until(pred: (d: Decision) => boolean, max = 600) {
    for (let i = 0; i < max; i++) {
      const d = this.g.pending;
      if (!d || pred(d)) return;
      this.answer(d);
    }
    throw new Error('never matched: ' + JSON.stringify(this.g.pending));
  }
  answer(d: Decision) {
    switch (d.type) {
      case 'mulligan':
        return this.submit({ type: 'mulligan', keep: true });
      case 'priority':
        return this.submit({ type: 'pass' });
      case 'yesNo':
        return this.submit({ type: 'yesNo', value: true });
      case 'declareAttackers':
        return this.submit({ type: 'attackers', attacks: [] });
      case 'declareBlockers':
        return this.submit({ type: 'blockers', blocks: [] });
      case 'chooseObjects':
        return this.submit({ type: 'objects', ids: d.candidates.slice(0, Math.max(d.min, Math.min(1, d.max))) });
      case 'chooseOption':
        return this.submit({ type: 'options', ids: d.options.slice(0, d.min).map((o) => o.id) });
      case 'orderObjects':
        return this.submit({ type: 'order', ids: d.items ? d.items.map((i) => i.id) : d.objectIds });
      case 'chooseTargets':
        return this.submit({ type: 'targets', targets: d.slots.map((s) => s.legal.slice(0, s.min)) });
      case 'chooseNumber':
        return this.submit({ type: 'number', value: d.max });
      case 'distribute': {
        const a = d.targets.map(() => d.minPer);
        a[0] += d.amount - a.reduce((x, y) => x + y, 0);
        return this.submit({ type: 'distribute', amounts: a });
      }
      case 'manualTrigger':
        return this.submit({ type: 'manualDone' });
      case 'payMana':
        return this.submit({ type: 'payMana', tap: [], auto: true });
    }
  }
  give(p: PlayerId, c: CardData): ObjectId {
    const o = this.g.createObject(c, p, 'hand', { skipEvents: true });
    this.g.refreshDecision();
    return o.id;
  }
  put(p: PlayerId, c: CardData): ObjectId {
    const o = this.g.createObject(c, p, 'battlefield', { skipEvents: true });
    o.controlSinceTurn = -1;
    o.enteredThisTurn = false;
    this.g.refreshDecision();
    return o.id;
  }
  main(p: PlayerId) {
    this.until((d) => d.type === 'priority' && d.player === p && this.g.state.turn.activePlayer === p && this.g.state.turn.step === 'main1' && this.g.state.stack.length === 0);
  }
  resolve() {
    this.until((d) => d.type === 'priority' && this.g.state.stack.length === 0);
  }
}

function game(commander: CardData | null = null): { d: D; p1: PlayerId; p2: PlayerId } {
  const setups: PlayerSetup[] = [
    { id: 'a', name: 'A', deck: { mainboard: forests(), commanders: commander ? [commander] : [] } },
    { id: 'b', name: 'B', deck: { mainboard: forests(), commanders: [] } },
  ];
  const g = new Game(setups, { seed: 3 }, scriptFor);
  g.start();
  const d = new D(g);
  const [p1, p2] = g.state.playerOrder;
  d.main(p1);
  return { d, p1, p2 };
}

describe('real cards through the compiler', () => {
  it('Lightning Bolt kills Grizzly Bears', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Mountain'));
    const bears = d.put(p2, C('Grizzly Bears'));
    const bolt = d.give(p1, C('Lightning Bolt'));
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.resolve();
    expect(d.g.obj(bears).zone).toBe('graveyard');
  });

  it('Rampant Growth fetches a Forest tapped and shuffles', () => {
    const { d, p1 } = game();
    d.put(p1, C('Forest'));
    d.put(p1, C('Forest'));
    const rg = d.give(p1, C('Rampant Growth'));
    const before = d.g.state.battlefield.length;
    d.submit({ type: 'cast', objectId: rg });
    d.until((x) => x.type === 'chooseObjects' && /Search/.test(x.prompt));
    const dec = d.d as { candidates: number[] };
    expect(dec.candidates.length).toBeGreaterThan(0);
    d.submit({ type: 'objects', ids: [dec.candidates[0]] });
    d.resolve();
    expect(d.g.state.battlefield.length).toBe(before + 1);
    const newLand = d.g.state.battlefield.find((id) => d.g.obj(id).tapped && d.g.obj(id).card.name === 'Forest' && d.g.obj(id).timestamp > 0 && d.g.obj(id).controller === p1 && d.g.obj(id).enteredThisTurn);
    expect(newLand).toBeDefined();
    expect(d.g.state.log.some((l) => /shuffles/.test(l.text))).toBe(true);
  });

  it('Mulldrifter draws two on entering; Blood Artist drains when it dies', () => {
    const { d, p1, p2 } = game();
    for (let i = 0; i < 5; i++) d.put(p1, C('Island'));
    d.put(p1, C('Swamp'));
    d.put(p1, C('Swamp'));
    const artist = d.give(p1, C('Blood Artist'));
    d.submit({ type: 'cast', objectId: artist });
    d.resolve();
    const md = d.give(p1, C('Mulldrifter'));
    const hand = d.g.player(p1).hand.length;
    d.submit({ type: 'cast', objectId: md });
    d.resolve();
    expect(d.g.player(p1).hand.length).toBe(hand - 1 + 2);
    // Kill Blood Artist with a Bolt from p2
    d.put(p2, C('Mountain'));
    const bolt = d.give(p2, C('Lightning Bolt'));
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: artist }]] });
    d.until((x) => x.type === 'chooseTargets' && x.player === p1);
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolve();
    expect(d.g.player(p2).life).toBe(39);
    expect(d.g.player(p1).life).toBe(41);
  });

  it('Sol Ring and Command Tower pay for a commander', () => {
    const { d, p1 } = game(C('Ezuri, Renegade Leader'));
    d.put(p1, C('Sol Ring'));
    d.put(p1, C('Command Tower'));
    d.put(p1, C('Forest'));
    const cmdr = d.g.player(p1).command[0];
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as { playableCards: number[] }).playableCards).toContain(cmdr);
    d.submit({ type: 'cast', objectId: cmdr });
    d.resolve();
    expect(d.g.obj(cmdr).zone).toBe('battlefield');
  });

  it('Elesh Norn pumps your team and shrinks theirs', () => {
    const { d, p1, p2 } = game();
    const mine = d.put(p1, C('Grizzly Bears'));
    const theirs = d.put(p2, C('Grizzly Bears'));
    d.put(p1, C('Elesh Norn, Grand Cenobite'));
    expect(d.g.characteristics(mine).power).toBe(4);
    expect(d.g.characteristics(theirs).power).toBe(0);
    d.submit({ type: 'pass' }); // priority passes → state-based actions run
    d.until((x) => x.type === 'priority');
    expect(d.g.obj(theirs).zone).toBe('graveyard'); // 0 toughness → SBA
  });

  it('Krenko doubles goblins', () => {
    const { d, p1 } = game();
    const k = d.put(p1, C('Krenko, Mob Boss'));
    d.until((x) => x.type === 'priority' && x.player === p1);
    const ab = (d.d as { activatableAbilities: { objectId: number; abilityIndex: number }[] }).activatableAbilities.find((a) => a.objectId === k);
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: k, abilityIndex: ab!.abilityIndex });
    d.resolve();
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).card.name === 'Goblin').length).toBe(1);
    d.until((x) => d.g.state.turn.number >= 3 && x.type === 'priority' && x.player === p1 && d.g.state.turn.step === 'main1');
    const ab2 = (d.d as { activatableAbilities: { objectId: number; abilityIndex: number }[] }).activatableAbilities.find((a) => a.objectId === k)!;
    d.submit({ type: 'activate', objectId: k, abilityIndex: ab2.abilityIndex });
    d.resolve();
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).card.name === 'Goblin').length).toBe(3);
  });
});
