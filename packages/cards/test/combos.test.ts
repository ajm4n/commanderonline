/** Well-known Commander interactions, compiled from oracle text and played through the engine. */
import { describe, it, expect } from 'vitest';
import { Game, type CardData, type Decision, type PlayerSetup, type Response, type PlayerId, type ObjectId, type Target } from '@commander/engine';
import { loadFixtureDb } from '../src/db-node.js';
import { scriptFor } from '../src/index.js';

const db = loadFixtureDb();
const C = (n: string): CardData => {
  const c = db.byName(n);
  if (!c) throw new Error(`missing ${n}`);
  return c;
};
type Prio = Extract<Decision, { type: 'priority' }>;

class D {
  /** The player our target choices point at when a spell or trigger asks for a player. */
  enemy: PlayerId | null = null;
  yesNo: (prompt: string) => boolean = () => true;
  constructor(public g: Game) {}
  get d() {
    return this.g.pending!;
  }
  submit(r: Response) {
    this.g.submit(this.g.pending!.player, r);
  }
  until(pred: (d: Decision) => boolean, max = 3000) {
    for (let i = 0; i < max; i++) {
      const d = this.g.pending;
      if (!d || pred(d)) return;
      this.answer(d);
    }
    throw new Error('never matched: ' + JSON.stringify(this.g.pending).slice(0, 300));
  }
  answer(d: Decision) {
    switch (d.type) {
      case 'mulligan':
        return this.submit({ type: 'mulligan', keep: true });
      case 'priority':
        return this.submit({ type: 'pass' });
      case 'yesNo':
        return this.submit({ type: 'yesNo', value: this.yesNo(d.prompt) });
      case 'declareAttackers':
        return this.submit({ type: 'attackers', attacks: [] });
      case 'declareBlockers':
        return this.submit({ type: 'blockers', blocks: [] });
      case 'chooseObjects': {
        // Tapped permanents first, so "untap up to five lands" picks the lands that need it.
        const cands = [...d.candidates].sort((a, b) => Number(this.g.obj(b).tapped) - Number(this.g.obj(a).tapped));
        return this.submit({ type: 'objects', ids: cands.slice(0, Math.min(d.max, cands.length)) });
      }
      case 'chooseOption':
        return this.submit({ type: 'options', ids: d.options.filter((o) => !o.disabled).slice(0, Math.max(1, d.min)).map((o) => o.id) });
      case 'orderObjects':
        return this.submit({ type: 'order', ids: d.items ? d.items.map((i) => i.id) : d.objectIds });
      case 'chooseTargets':
        return this.submit({
          type: 'targets',
          targets: d.slots.map((s) => {
            const pick = s.legal.find((t) => t.kind === 'player' && t.id === this.enemy) ?? s.legal[0];
            return (pick ? [pick] : []).slice(0, Math.max(s.min, 1)) as Target[];
          }),
        });
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
  put(p: PlayerId, c: CardData, opts: { tapped?: boolean } = {}): ObjectId {
    const o = this.g.createObject(c, p, 'battlefield', { skipEvents: true, tapped: opts.tapped });
    o.controlSinceTurn = -1;
    o.enteredThisTurn = false;
    this.g.refreshDecision();
    return o.id;
  }
  lands(p: PlayerId, name: string, n: number, opts: { tapped?: boolean } = {}) {
    for (let i = 0; i < n; i++) this.put(p, C(name), opts);
  }
  main(p: PlayerId) {
    this.until((d) => d.type === 'priority' && d.player === p && this.g.state.turn.activePlayer === p && this.g.state.turn.step === 'main1' && this.g.state.stack.length === 0);
  }
  resolve() {
    this.until((d) => d.type === 'priority' && this.g.state.stack.length === 0);
  }
  cast(id: ObjectId, extra: Partial<Extract<Response, { type: 'cast' }>> = {}) {
    this.submit({ type: 'cast', objectId: id, ...extra });
  }
  targetPlayer(p: PlayerId) {
    this.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    if (this.d.type === 'chooseTargets') this.submit({ type: 'targets', targets: [[{ kind: 'player', id: p }]] });
  }
  targetObject(id: ObjectId) {
    this.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    if (this.d.type === 'chooseTargets') this.submit({ type: 'targets', targets: [[{ kind: 'object', id }]] });
  }
  prio(): Prio {
    return this.d as Prio;
  }
  bf(p: PlayerId, name: string): ObjectId[] {
    return this.g.state.battlefield.filter((id) => this.g.obj(id).controller === p && this.g.obj(id).card.name === name);
  }
  clearLibrary(p: PlayerId) {
    for (const id of [...this.g.player(p).library]) this.g.applyManual(p, { kind: 'moveObject', objectId: id, toZone: 'exile' });
    this.g.refreshDecision();
  }
}

function game(seed = 3, commanders: CardData[] = []): { d: D; p1: PlayerId; p2: PlayerId } {
  const setups: PlayerSetup[] = [
    { id: 'a', name: 'A', deck: { mainboard: Array.from({ length: 40 }, () => C('Plains')), commanders } },
    { id: 'b', name: 'B', deck: { mainboard: Array.from({ length: 40 }, () => C('Forest')), commanders: [] } },
  ];
  const g = new Game(setups, { seed }, scriptFor);
  g.start();
  const d = new D(g);
  const [p1, p2] = g.state.playerOrder;
  d.enemy = p2;
  d.main(p1);
  return { d, p1, p2 };
}

describe('combos and staples played through the engine', () => {
  it('every card in the suite compiles fully', () => {
    const names = ["Thassa's Oracle", 'Blood Artist', 'Zulaport Cutthroat', 'Wrath of God', 'Sanguine Bond', 'Exquisite Blood', 'Grave Pact', 'Fling', 'Chaos Warp', 'Mana Drain', 'Wheel of Fortune', 'Peregrine Drake', 'Kiki-Jiki, Mirror Breaker', 'Esper Sentinel', 'Walking Ballista', 'Grim Hireling', 'Living Death', 'Notion Thief', 'Dockside Extortionist', 'Swords to Plowshares', 'Rhystic Study', 'Skullclamp', 'Swan Song', 'Aven Mindcensor', 'Cultivate', 'Edgar Markov', 'Muldrotha, the Gravetide', 'Niv-Mizzet, Parun', 'The Gitrog Monster', 'Animate Dead'];
    const notFull = names.filter((n) => scriptFor(C(n)).coverage !== 'full').map((n) => `${n}: ${scriptFor(C(n)).unhandledText?.join(' / ')}`);
    expect(notFull).toEqual([]);
  });

  it("Thassa's Oracle wins the game with an empty library", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Island', 2);
    d.clearLibrary(p1);
    const oracle = d.give(p1, C("Thassa's Oracle"));
    d.cast(oracle);
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0 || d.g.state.over);
    expect(d.g.state.over).toBe(true);
    expect(d.g.player(p2).lost).toBe(true);
    expect(d.g.player(p1).lost).toBe(false);
  });

  it('Blood Artist and Zulaport Cutthroat both see every creature dying to Wrath of God', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 4);
    d.put(p1, C('Blood Artist'));
    d.put(p1, C('Zulaport Cutthroat'));
    d.put(p1, C('Grizzly Bears'));
    d.put(p1, C('Grizzly Bears'));
    const wrath = d.give(p1, C('Wrath of God'));
    d.cast(wrath);
    d.resolve();
    // Four creatures died: Blood Artist drains 1 each (targeting the opponent), Zulaport drains 1 each.
    expect(d.g.player(p2).life).toBe(40 - 8);
    expect(d.g.player(p1).life).toBe(40 + 8);
  });

  it('Sanguine Bond + Exquisite Blood loops until the opponent loses', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Mountain', 1);
    d.put(p1, C('Sanguine Bond'));
    d.put(p1, C('Exquisite Blood'));
    d.put(p1, C('Blood Artist'));
    const bears = d.put(p1, C('Grizzly Bears'));
    const bolt = d.give(p1, C('Lightning Bolt'));
    d.cast(bolt);
    d.targetObject(bears);
    d.until(() => d.g.state.over, 20000);
    expect(d.g.player(p2).lost).toBe(true);
    expect(d.g.player(p2).life).toBeLessThanOrEqual(0);
  });

  it("Fling deals damage equal to the sacrificed creature's power, and Grave Pact makes the opponent sacrifice", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Mountain', 2);
    d.put(p1, C('Grave Pact'));
    d.put(p1, C('Grizzly Bears'));
    const serra = d.put(p2, C('Serra Angel'));
    const fling = d.give(p1, C('Fling'));
    d.cast(fling);
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).life).toBe(38);
    expect(d.g.obj(serra).zone).toBe('graveyard');
  });

  it("Chaos Warp shuffles the target away and puts the owner's revealed permanent onto the battlefield", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Mountain', 3);
    const serra = d.put(p2, C('Serra Angel'));
    const warp = d.give(p1, C('Chaos Warp'));
    d.cast(warp);
    d.targetObject(serra);
    d.resolve();
    expect(d.g.obj(serra).zone).toBe('library');
    expect(d.g.obj(serra).owner).toBe(p2);
    // The top card of a mono-Forest library is a Forest: a permanent card, so it enters under its owner's control.
    expect(d.bf(p2, 'Forest').length).toBe(1);
  });

  it('Wheel of Fortune makes each player discard and draw seven', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Mountain', 3);
    const wheel = d.give(p1, C('Wheel of Fortune'));
    d.cast(wheel);
    d.resolve();
    expect(d.g.player(p1).hand.length).toBe(7);
    expect(d.g.player(p2).hand.length).toBe(7);
  });

  it('Peregrine Drake untaps up to five lands', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Island', 5, { tapped: true });
    d.lands(p1, 'Island', 5);
    const drake = d.give(p1, C('Peregrine Drake'));
    d.cast(drake); // taps the five untapped Islands
    d.resolve();
    // All ten were tapped when the trigger resolved; it untaps five of them.
    expect(d.bf(p1, 'Island').filter((id) => !d.g.obj(id).tapped).length).toBe(5);
  });

  it("Mana Drain counters the spell and adds mana equal to its mana value in the caster's next main phase", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Forest', 2);
    d.lands(p2, 'Island', 2);
    const drain = d.give(p2, C('Mana Drain'));
    const bears = d.give(p1, C('Grizzly Bears'));
    d.cast(bears);
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.cast(drain);
    d.resolve();
    expect(d.g.obj(bears).zone).toBe('graveyard');
    d.until((x) => x.type === 'priority' && d.g.state.turn.activePlayer === p2 && d.g.state.turn.step === 'main1' && d.g.state.stack.length === 0);
    expect(d.g.player(p2).manaPool.C).toBe(2);
  });

  it('Esper Sentinel taxes the first noncreature spell: the opponent declines to pay and its controller draws', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Esper Sentinel'));
    d.lands(p2, 'Mountain', 1);
    const bolt = d.give(p2, C('Lightning Bolt'));
    const hand = d.g.player(p1).hand.length;
    d.yesNo = (prompt) => !/^Pay /.test(prompt);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.cast(bolt);
    d.targetPlayer(p1);
    d.resolve();
    expect(d.g.player(p1).life).toBe(37);
    expect(d.g.player(p1).hand.length).toBe(hand + 1);
  });

  it('Kiki-Jiki copies a creature with haste and the copy is sacrificed at the next end step', () => {
    const { d, p1 } = game();
    const kiki = d.put(p1, C('Kiki-Jiki, Mirror Breaker'));
    const bears = d.put(p1, C('Grizzly Bears'));
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === kiki);
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: kiki, abilityIndex: ab!.abilityIndex });
    d.targetObject(bears);
    d.resolve();
    const tokens = d.bf(p1, 'Grizzly Bears').filter((id) => id !== bears);
    expect(tokens.length).toBe(1);
    expect(d.g.characteristics(tokens[0]).keywords.has('Haste')).toBe(true);
    const turn = d.g.state.turn.number;
    d.until(() => d.g.state.turn.number > turn);
    expect(d.g.state.objects[tokens[0]]).toBeUndefined();
    expect(d.g.obj(bears).zone).toBe('battlefield');
  });

  it('Walking Ballista enters with X counters and pings by removing them', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 4);
    const ballista = d.give(p1, C('Walking Ballista'));
    d.cast(ballista, { xValue: 2 });
    d.resolve();
    expect(d.g.obj(ballista).counters['+1/+1']).toBe(2);
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === ballista && /damage/.test(a.text));
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: ballista, abilityIndex: ab!.abilityIndex });
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).life).toBe(39);
    expect(d.g.obj(ballista).counters['+1/+1']).toBe(1);
  });

  it('Grim Hireling triggers once per player however many creatures connect', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Grim Hireling'));
    const b1 = d.put(p1, C('Grizzly Bears'));
    const b2 = d.put(p1, C('Grizzly Bears'));
    d.until((x) => x.type === 'declareAttackers');
    d.submit({ type: 'attackers', attacks: [{ attacker: b1, target: p2 }, { attacker: b2, target: p2 }] });
    const turn = d.g.state.turn.number;
    d.until(() => d.g.state.turn.number > turn || (d.g.state.turn.number === turn && d.g.state.turn.step === 'main2' && d.g.state.stack.length === 0));
    expect(d.g.player(p2).life).toBe(36);
    expect(d.bf(p1, 'Treasure').length).toBe(2);
  });

  it('Living Death swaps graveyards and battlefields', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 5);
    const bears = d.give(p1, C('Grizzly Bears'));
    d.g.applyManual(p1, { kind: 'moveObject', objectId: bears, toZone: 'graveyard' });
    const serra = d.put(p2, C('Serra Angel'));
    const death = d.give(p1, C('Living Death'));
    d.g.refreshDecision();
    d.cast(death);
    d.resolve();
    expect(d.g.obj(bears).zone).toBe('battlefield');
    expect(d.g.obj(bears).controller).toBe(p1);
    expect(d.g.obj(serra).zone).toBe('graveyard');
  });

  it("Notion Thief steals an opponent's extra draws but not their draw-step draw", () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Notion Thief'));
    d.lands(p2, 'Island', 3);
    const div = d.give(p2, C('Divination'));
    const h1 = d.g.player(p1).hand.length;
    // Advance into p2's turn: the draw-step draw is exempt.
    d.until((x) => x.type === 'priority' && d.g.state.turn.activePlayer === p2 && d.g.state.turn.step === 'main1' && d.g.state.stack.length === 0);
    const h2 = d.g.player(p2).hand.length;
    expect(d.g.player(p1).hand.length).toBe(h1); // p2's draw-step draw was not replaced
    d.cast(div);
    d.resolve();
    expect(d.g.player(p2).hand.length).toBe(h2 - 1); // Divination left the hand, both draws were stolen
    expect(d.g.player(p1).hand.length).toBe(h1 + 2);
  });
  it('Dockside Extortionist counts only artifacts and enchantments on the battlefield', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Mountain', 2);
    d.put(p2, C('Sol Ring'));
    d.put(p2, C('Rhystic Study'));
    d.give(p2, C('Sol Ring')); // in hand: not counted
    d.g.createObject(C('Sol Ring'), p2, 'graveyard', { skipEvents: true }); // in graveyard: not counted
    d.put(p1, C('Sol Ring')); // yours: not counted
    const dock = d.give(p1, C('Dockside Extortionist'));
    d.cast(dock);
    d.resolve();
    expect(d.bf(p1, 'Treasure')).toHaveLength(2);
  });

  it("Swords to Plowshares exiles the creature and its controller gains life equal to its power", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 1);
    const bear = d.put(p2, C('Grizzly Bears'));
    const life = d.g.player(p2).life;
    const swords = d.give(p1, C('Swords to Plowshares'));
    d.cast(swords);
    d.targetObject(bear);
    d.resolve();
    expect(d.bf(p2, 'Grizzly Bears')).toHaveLength(0);
    expect(d.g.player(p2).exile.map((id) => d.g.obj(id).card.name)).toContain('Grizzly Bears');
    expect(d.g.player(p2).life).toBe(life + 2);
    expect(d.g.player(p1).life).toBe(40);
  });
  it('Skullclamp on a 1/1 kills it and draws two cards', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Plains', 1);
    const clamp = d.put(p1, C('Skullclamp'));
    const sentinel = d.put(p1, C('Esper Sentinel'));
    const hand = d.g.player(p1).hand.length;
    const equip = d.prio().activatableAbilities.find((a) => a.objectId === clamp && /Equip/.test(a.text));
    expect(equip).toBeDefined();
    d.submit({ type: 'activate', objectId: clamp, abilityIndex: equip!.abilityIndex });
    d.targetObject(sentinel);
    d.resolve();
    expect(d.bf(p1, 'Esper Sentinel')).toHaveLength(0);
    expect(d.g.player(p1).graveyard.map((id) => d.g.obj(id).card.name)).toContain('Esper Sentinel');
    expect(d.g.player(p1).hand.length).toBe(hand + 2);
    expect(d.g.obj(clamp).attachedTo).toBeNull();
  });
  it("Swan Song counters the spell and gives the countered spell's controller a 2/2 Bird", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Island', 1);
    d.lands(p2, 'Forest', 3);
    const song = d.give(p1, C('Swan Song'));
    d.main(p2);
    const cult = d.give(p2, C('Cultivate'));
    d.cast(cult);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 1);
    d.cast(song);
    d.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    if (d.d.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[d.d.slots[0].legal[0]]] });
    d.resolve();
    expect(d.g.player(p2).graveyard.map((id) => d.g.obj(id).card.name)).toContain('Cultivate');
    expect(d.bf(p2, 'Bird')).toHaveLength(1);
    expect(d.bf(p1, 'Bird')).toHaveLength(0);
  });

  it('Aven Mindcensor limits an opposing search to the top four cards', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Aven Mindcensor'));
    d.lands(p2, 'Forest', 3);
    d.main(p2);
    const cult = d.give(p2, C('Cultivate'));
    d.cast(cult);
    d.until((x) => x.type === 'chooseObjects' && x.player === p2);
    expect(d.d.type).toBe('chooseObjects');
    if (d.d.type === 'chooseObjects') {
      expect(d.d.candidates).toHaveLength(4);
      expect(d.d.candidates).toEqual(d.g.player(p2).library.slice(0, 4));
    }
  });
  it('Edgar Markov makes a Vampire token from the command zone (eminence)', () => {
    const { d, p1 } = game(3, [C('Edgar Markov')]);
    expect(d.g.player(p1).command.map((id) => d.g.obj(id).card.name)).toContain('Edgar Markov');
    d.lands(p1, 'Swamp', 2);
    const artist = d.give(p1, C('Blood Artist'));
    d.cast(artist);
    d.resolve();
    expect(d.bf(p1, 'Blood Artist')).toHaveLength(1);
    expect(d.bf(p1, 'Vampire')).toHaveLength(1);
  });

  it('Muldrotha lets you cast one permanent spell of each type from your graveyard on your turn', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Forest', 6);
    d.put(p1, C('Muldrotha, the Gravetide'));
    const bear1 = d.g.createObject(C('Grizzly Bears'), p1, 'graveyard', { skipEvents: true }).id;
    const bear2 = d.g.createObject(C('Grizzly Bears'), p1, 'graveyard', { skipEvents: true }).id;
    const ring = d.g.createObject(C('Sol Ring'), p1, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).toEqual(expect.arrayContaining([bear1, bear2, ring]));
    d.cast(bear1);
    d.resolve();
    expect(d.bf(p1, 'Grizzly Bears')).toHaveLength(1);
    // The creature slot is used; the artifact slot is not.
    expect(d.prio().playableCards).not.toContain(bear2);
    expect(d.prio().playableCards).toContain(ring);
    // The slots reset on your next turn.
    d.main(p2);
    d.main(p1);
    expect(d.prio().playableCards).toEqual(expect.arrayContaining([bear2, ring]));
  });
  it("Niv-Mizzet, Parun can't be countered", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Island', 3);
    d.lands(p1, 'Mountain', 3);
    d.lands(p2, 'Island', 2);
    const niv = d.give(p1, C('Niv-Mizzet, Parun'));
    const drain = d.give(p2, C('Mana Drain'));
    d.cast(niv);
    d.until((x) => x.type === 'priority' && x.player === p2 && d.g.state.stack.length === 1);
    expect(d.prio().playableCards).toContain(drain);
    d.cast(drain);
    d.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    if (d.d.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[d.d.slots[0].legal[0]]] });
    d.resolve();
    expect(d.bf(p1, 'Niv-Mizzet, Parun')).toHaveLength(1);
    expect(d.g.player(p2).graveyard.map((id) => d.g.obj(id).card.name)).toContain('Mana Drain');
  });

  it('The Gitrog Monster draws once when several lands hit the graveyard together', () => {
    const { d, p1 } = game();
    d.put(p1, C('The Gitrog Monster'));
    const a = d.put(p1, C('Forest'));
    const b = d.put(p1, C('Forest'));
    const c = d.put(p1, C('Forest'));
    const hand = d.g.player(p1).hand.length;
    d.g.simultaneousZoneChange(() => {
      for (const id of [a, b, c]) d.g.moveObject(id, 'graveyard', { cause: 'sacrifice' });
    });
    d.g.refreshDecision();
    d.answer(d.d); // pass priority: the pending trigger goes on the stack and resolves
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step === 'main1');
    expect(d.g.player(p1).hand.length).toBe(hand + 1);
    // Separate events are separate triggers.
    const e = d.put(p1, C('Forest'));
    const f = d.put(p1, C('Forest'));
    d.g.moveObject(e, 'graveyard', { cause: 'sacrifice' });
    d.g.moveObject(f, 'graveyard', { cause: 'sacrifice' });
    d.g.refreshDecision();
    d.answer(d.d);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step === 'main1');
    expect(d.g.player(p1).hand.length).toBe(hand + 3);
  });
  it('Animate Dead reanimates a creature from any graveyard and takes it with it when it leaves', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 2);
    const bear = d.g.createObject(C('Grizzly Bears'), p2, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    const ad = d.give(p1, C('Animate Dead'));
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).toContain(ad);
    d.cast(ad);
    d.targetObject(bear);
    d.resolve();
    // The Bears are back under p1's control, enchanted, at -1/-0.
    expect(d.bf(p1, 'Grizzly Bears')).toHaveLength(1);
    expect(d.bf(p1, 'Animate Dead')).toHaveLength(1);
    const bearNow = d.bf(p1, 'Grizzly Bears')[0];
    expect(d.g.obj(d.bf(p1, 'Animate Dead')[0]).attachedTo).toBe(bearNow);
    expect(d.g.characteristics(bearNow).power).toBe(1);
    expect(d.g.characteristics(bearNow).toughness).toBe(2);
    // Animate Dead leaves: the creature's controller sacrifices it.
    d.g.moveObject(d.bf(p1, 'Animate Dead')[0], 'graveyard', { cause: 'destroy' });
    d.g.refreshDecision();
    d.answer(d.d);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step === 'main1');
    expect(d.bf(p1, 'Grizzly Bears')).toHaveLength(0);
    expect(d.g.player(p2).graveyard.map((id) => d.g.obj(id).card.name)).toContain('Grizzly Bears');
  });
});
