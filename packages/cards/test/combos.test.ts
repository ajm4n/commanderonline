/** Well-known Commander interactions, compiled from oracle text and played through the engine. */
import { describe, it, expect } from 'vitest';
import { Game, buildPriorityDecision, type CardData, type Decision, type PlayerSetup, type Response, type PlayerId, type ObjectId, type Target, type AbilitySpec, type Effect } from '@commander/engine';
import { loadFixtureDb } from '../src/db-node.js';
import { scriptFor } from '../src/index.js';
import { compileCard } from '../src/compiler/index.js';

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

function game(seed = 3, commanders: CardData[] = [], config: Partial<import('@commander/engine').GameConfig> = {}): { d: D; p1: PlayerId; p2: PlayerId } {
  const setups: PlayerSetup[] = [
    { id: 'a', name: 'A', deck: { mainboard: Array.from({ length: 40 }, () => C('Plains')), commanders } },
    { id: 'b', name: 'B', deck: { mainboard: Array.from({ length: 40 }, () => C('Forest')), commanders: [] } },
  ];
  const g = new Game(setups, { seed, ...config }, scriptFor);
  g.start();
  const d = new D(g);
  const [p1, p2] = g.state.playerOrder;
  d.enemy = p2;
  d.main(p1);
  return { d, p1, p2 };
}

describe('combos and staples played through the engine', () => {
  it('every card in the suite compiles fully', () => {
    const names = ["Thassa's Oracle", 'Blood Artist', 'Zulaport Cutthroat', 'Wrath of God', 'Sanguine Bond', 'Exquisite Blood', 'Grave Pact', 'Fling', 'Chaos Warp', 'Mana Drain', 'Wheel of Fortune', 'Peregrine Drake', 'Kiki-Jiki, Mirror Breaker', 'Esper Sentinel', 'Walking Ballista', 'Grim Hireling', 'Living Death', 'Notion Thief', 'Dockside Extortionist', 'Swords to Plowshares', 'Rhystic Study', 'Skullclamp', 'Swan Song', 'Aven Mindcensor', 'Cultivate', 'Edgar Markov', 'Muldrotha, the Gravetide', 'Niv-Mizzet, Parun', 'The Gitrog Monster', 'Animate Dead', 'Guardian Project', 'Sylvan Library', 'Scroll Rack', 'Krosan Grip', 'Damn', 'Anointed Procession', 'Parallel Lives', 'Doubling Season', 'Impact Tremors', 'Sword of Feast and Famine', 'Underworld Breach', 'Brain Freeze', 'Thousand-Year Storm', 'Bonus Round', 'Thalia, Guardian of Thraben', 'Blood Moon', 'Squee, the Immortal', 'Rings of Brighthearth', 'Triskelion', "Teferi's Protection", "Angel's Grace", 'Platinum Angel', 'Narset, Enlightened Master', 'Grand Arbiter Augustin IV', 'Kalonian Hydra', 'Winding Constrictor', 'Hardened Scales', 'Yorion, Sky Nomad', 'Elesh Norn, Mother of Machines', 'Grapeshot', 'Maelstrom Wanderer', 'Feather, the Redeemed', 'Bloodbraid Elf', 'Snapcaster Mage', 'Deep Analysis', "Mizzix's Mastery", 'Terastodon', 'Light Up the Stage', 'Bite Down', 'Warstorm Surge', 'Fecundity', 'Heartless Hidetsugu', 'Yawgmoth Demon', 'Glimpse the Sun God', 'Cataclysm', 'Aether Flash', 'Lightning Dart', 'Smash to Smithereens', 'Impossible Man', 'Vesuvan Drifter', 'Comet Storm', 'Carbonize', 'Old Man of the Sea', 'Helm of the Host'];
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
  it('Guardian Project draws only for creatures with a new name', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Forest', 4);
    d.put(p1, C('Guardian Project'));
    const hand0 = d.g.player(p1).hand.length;
    const settle = () => {
      d.resolve();
      d.answer(d.d); // pass once so pending triggers reach the stack
      d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step === 'main1');
    };
    const b1 = d.give(p1, C('Grizzly Bears'));
    d.cast(b1);
    settle();
    expect(d.g.player(p1).hand.length).toBe(hand0 + 1); // cast one, drew one
    const b2 = d.give(p1, C('Grizzly Bears'));
    d.cast(b2);
    settle();
    expect(d.g.player(p1).hand.length).toBe(hand0 + 1); // second Bears: same name as another creature you control, no draw
  });

  it('Sylvan Library draws two extra and charges 4 life per kept card', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Sylvan Library'));
    d.main(p2);
    const hand = d.g.player(p1).hand.length;
    d.yesNo = () => true; // draw the extra cards and pay for both
    d.until((x) => x.type === 'priority' && d.g.state.turn.activePlayer === p1 && d.g.state.turn.step === 'main1' && d.g.state.stack.length === 0);
    expect(d.g.player(p1).hand.length).toBe(hand + 3); // draw step + two extra (one discarded to hand size later, not yet)
    expect(d.g.player(p1).life).toBe(32);
  });

  it('Sylvan Library puts unpaid cards back on top', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Sylvan Library'));
    d.main(p2);
    const hand = d.g.player(p1).hand.length;
    d.yesNo = (prompt) => !/Pay 4 life/.test(prompt);
    d.until((x) => x.type === 'priority' && d.g.state.turn.activePlayer === p1 && d.g.state.turn.step === 'main1' && d.g.state.stack.length === 0);
    expect(d.g.player(p1).hand.length).toBe(hand + 1);
    expect(d.g.player(p1).life).toBe(40);
  });

  it('Scroll Rack swaps hand cards for the top of the library', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Plains', 1);
    const rack = d.put(p1, C('Scroll Rack'));
    const hand = [...d.g.player(p1).hand];
    const top = d.g.player(p1).library.slice(0, 2);
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === rack);
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: rack, abilityIndex: ab!.abilityIndex });
    d.until((x) => x.type === 'chooseObjects' && x.player === p1 && /Scroll Rack/.test(x.prompt));
    if (d.d.type === 'chooseObjects') d.submit({ type: 'objects', ids: hand.slice(0, 2) });
    d.resolve();
    const now = d.g.player(p1).hand;
    expect(now).toHaveLength(hand.length);
    expect(now).toEqual(expect.arrayContaining(top));
    expect(now).not.toContain(hand[0]);
    expect(d.g.player(p1).library.slice(0, 2).sort()).toEqual(hand.slice(0, 2).sort());
  });
  it('Krosan Grip (split second) stops spells and non-mana abilities while on the stack', () => {
    const { d, p1, p2 } = game(3, [], { autoPassWhenNothingToDo: false });
    d.lands(p1, 'Forest', 3);
    d.lands(p2, 'Island', 2);
    const ring = d.put(p2, C('Sol Ring'));
    const top = d.put(p2, C("Sensei's Divining Top"));
    const drain = d.give(p2, C('Mana Drain'));
    const grip = d.give(p1, C('Krosan Grip'));
    // Before: p2 could respond with Mana Drain and use the Top.
    const before = buildPriorityDecision(d.g, p2);
    expect(before.activatableAbilities.some((a) => a.objectId === top)).toBe(true);
    d.cast(grip);
    d.targetObject(ring);
    d.until((x) => x.type === 'priority' && x.player === p2 && d.g.state.stack.length === 1);
    const during = d.prio();
    expect(during.playableCards).not.toContain(drain);
    expect(during.activatableAbilities.some((a) => a.objectId === top)).toBe(false);
    expect(during.activatableAbilities.some((a) => a.objectId === ring)).toBe(true); // mana ability
    d.resolve();
    expect(d.bf(p2, 'Sol Ring')).toHaveLength(0);
    expect(buildPriorityDecision(d.g, p2).activatableAbilities.some((a) => a.objectId === top)).toBe(true);
  });
  it('token doublers multiply: Procession + Parallel Lives + Doubling Season make eight tokens from one', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 4);
    d.put(p1, C('Anointed Procession'));
    d.put(p1, C('Parallel Lives'));
    d.put(p1, C('Doubling Season'));
    d.put(p1, C('Impact Tremors'));
    const life = d.g.player(p2).life;
    const bastion = d.give(p1, C('Bastion of Remembrance'));
    d.cast(bastion);
    d.resolve();
    d.answer(d.d);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step === 'main1');
    expect(d.bf(p1, 'Human Soldier')).toHaveLength(8);
    expect(d.g.player(p2).life).toBe(life - 8); // Impact Tremors once per token
  });

  it('Doubling Season doubles counters placed on your permanents', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Forest', 2);
    d.put(p1, C('Doubling Season'));
    const bears = d.put(p1, C('Grizzly Bears'));
    const kenrith = d.put(p1, C('Kenrith, the Returned King'));
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === kenrith && /\+1\/\+1 counter/.test(a.text));
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: kenrith, abilityIndex: ab!.abilityIndex });
    d.targetObject(bears);
    d.resolve();
    expect(d.g.obj(bears).counters['+1/+1']).toBe(2);
  });
  it('Sword of Feast and Famine: the hit player discards and your lands untap', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Forest', 3, { tapped: true });
    const sword = d.put(p1, C('Sword of Feast and Famine'));
    const bear = d.put(p1, C('Grizzly Bears'));
    d.g.applyManual(p1, { kind: 'attach', objectId: sword, to: bear });
    expect(d.g.obj(sword).attachedTo).toBe(bear);
    d.g.refreshDecision();
    const hand2 = d.g.player(p2).hand.length;
    d.until((x) => x.type === 'declareAttackers');
    d.submit({ type: 'attackers', attacks: [{ attacker: bear, target: p2 }] });
    const turn = d.g.state.turn.number;
    d.until(() => d.g.state.turn.number > turn || (d.g.state.turn.number === turn && d.g.state.turn.step === 'main2' && d.g.state.stack.length === 0));
    expect(d.g.player(p2).life).toBe(36); // 2/2 + 2/+2
    expect(d.g.player(p2).hand.length).toBe(hand2 - 1);
    expect(d.g.state.battlefield.filter((id) => d.g.obj(id).controller === p1 && d.g.obj(id).card.name === 'Forest').every((id) => !d.g.obj(id).tapped)).toBe(true);
  });
  it('Underworld Breach lets you escape a spell from the graveyard by exiling three other cards', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Island', 2);
    d.put(p1, C('Underworld Breach'));
    const freeze = d.g.createObject(C('Brain Freeze'), p1, 'graveyard', { skipEvents: true }).id;
    for (let i = 0; i < 3; i++) d.g.createObject(C('Plains'), p1, 'graveyard', { skipEvents: true });
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).toContain(freeze);
    const lib2 = d.g.player(p2).library.length;
    d.cast(freeze);
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).library.length).toBe(lib2 - 3);
    expect(d.g.player(p1).exile).toHaveLength(3); // the three Plains
    expect(d.g.player(p1).graveyard.map((id) => d.g.obj(id).card.name)).toContain('Brain Freeze'); // back to the graveyard, not exiled
    // With only Brain Freeze left there is nothing to exile, so it is no longer castable.
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).not.toContain(freeze);
  });

  it('Thousand-Year Storm copies the second spell once', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Island', 4);
    d.put(p1, C('Thousand-Year Storm'));
    const f1 = d.give(p1, C('Brain Freeze'));
    const f2 = d.give(p1, C('Brain Freeze'));
    const lib2 = d.g.player(p2).library.length;
    d.cast(f1);
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).library.length).toBe(lib2 - 3); // no earlier spell: no copies
    d.cast(f2);
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).library.length).toBe(lib2 - 12); // original + Thousand-Year Storm copy + storm copy (one spell before it)
  });
  it("Thalia taxes opponents' noncreature spells too", () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Thalia, Guardian of Thraben'));
    d.lands(p2, 'Island', 1);
    d.lands(p2, 'Forest', 1);
    const freeze = d.give(p2, C('Brain Freeze')); // {1}{U}
    d.main(p2);
    expect(d.prio().playableCards).not.toContain(freeze); // {1}{U} becomes {2}{U} with two lands
    d.lands(p2, 'Forest', 1);
    d.until((x) => x.type === 'priority' && x.player === p2);
    expect(d.prio().playableCards).toContain(freeze);
  });

  it('Blood Moon turns a nonbasic land into a plain Mountain (305.7)', () => {
    const { d, p1 } = game();
    const tower = d.put(p1, C('Command Tower'));
    const before = d.prio().activatableAbilities.filter((a) => a.objectId === tower).map((a) => a.text);
    expect(before.some((t) => /commander's color identity/.test(t))).toBe(true);
    d.put(p1, C('Blood Moon'));
    const after = d.prio().activatableAbilities.filter((a) => a.objectId === tower).map((a) => a.text);
    expect(after).toEqual(['{T}: Add {R}.']);
    expect(d.g.characteristics(tower).subtypes).toEqual(['Mountain']);
  });
  it('Squee, the Immortal can be cast from the graveyard and from exile', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Mountain', 3);
    const squee = d.g.createObject(C('Squee, the Immortal'), p1, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).toContain(squee);
    d.cast(squee);
    d.resolve();
    expect(d.bf(p1, 'Squee, the Immortal')).toHaveLength(1);
    const onField = d.bf(p1, 'Squee, the Immortal')[0];
    d.lands(p1, 'Mountain', 3); // the first three are tapped from the cast
    d.g.moveObject(onField, 'exile', { cause: 'exile' });
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).toContain(onField);
  });

  it('Rings of Brighthearth copies a non-mana activated ability for {2}', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 2);
    d.put(p1, C('Rings of Brighthearth'));
    const trisk = d.put(p1, C('Triskelion'));
    d.g.obj(trisk).counters['+1/+1'] = 3;
    d.g.refreshDecision();
    const ping = d.prio().activatableAbilities.find((a) => a.objectId === trisk);
    expect(ping).toBeDefined();
    d.yesNo = () => true; // pay {2} for the copy
    d.enemy = p2;
    d.submit({ type: 'activate', objectId: trisk, abilityIndex: ping!.abilityIndex });
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).life).toBe(38); // original ping + copy
    expect(d.g.obj(trisk).counters['+1/+1']).toBe(2); // the copy costs no counter
  });
  it("Teferi's Protection: no targeting, no damage, no life change until your next turn", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 3);
    d.lands(p2, 'Mountain', 1);
    const prot = d.give(p1, C("Teferi's Protection"));
    const bolt = d.give(p2, C('Lightning Bolt'));
    const bear = d.put(p1, C('Grizzly Bears'));
    d.cast(prot);
    d.resolve();
    expect(d.g.obj(bear).phasedOut).toBe(true);
    expect(d.g.player(p1).exile.map((id) => d.g.obj(id).card.name)).toContain("Teferi's Protection");
    // The opponent's Bolt cannot target p1 at all now.
    d.main(p2);
    d.cast(bolt);
    d.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    expect(d.d.type).toBe('chooseTargets');
    if (d.d.type === 'chooseTargets') {
      expect(d.d.slots[0].legal.some((t) => t.kind === 'player' && t.id === p1)).toBe(false);
      d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    }
    d.resolve();
    expect(d.g.player(p2).life).toBe(37);
    d.g.dealDamage(null, { kind: 'player', id: p1 }, 5, false);
    expect(d.g.player(p1).life).toBe(40);
    d.g.loseLife(p1, 3);
    expect(d.g.player(p1).life).toBe(40);
    // p1's next turn: the protection has ended and the Bears are back.
    d.main(p1);
    expect(d.g.obj(bear).phasedOut).toBeFalsy();
    d.g.loseLife(p1, 3);
    expect(d.g.player(p1).life).toBe(37);
  });

  it("Angel's Grace: you can't lose this turn and damage can't take you below 1", () => {
    const { d, p1 } = game();
    d.lands(p1, 'Plains', 1);
    d.g.player(p1).life = 3;
    const grace = d.give(p1, C("Angel's Grace"));
    d.cast(grace);
    d.resolve();
    d.g.dealDamage(null, { kind: 'player', id: p1 }, 10, false);
    expect(d.g.player(p1).life).toBe(1);
    d.g.loseLife(p1, 5); // loss of life is not damage: it goes through
    expect(d.g.player(p1).life).toBe(-4);
    d.until((x) => x.type === 'priority');
    expect(d.g.player(p1).lost).toBe(false); // can't lose this turn
  });

  it("Platinum Angel stops an opponent's Thassa's Oracle win", () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Platinum Angel'));
    d.lands(p2, 'Island', 2);
    d.main(p2);
    d.clearLibrary(p2); // after p2's draw step, so p2 does not deck out
    const oracle = d.give(p2, C("Thassa's Oracle"));
    d.cast(oracle);
    d.until((x) => (x.type === 'priority' && d.g.state.stack.length === 0) || d.g.state.over);
    expect(d.g.state.over).toBe(false);
    expect(d.g.player(p1).lost).toBe(false);
  });
  it('Narset exiles four and lets you cast the noncreature ones free', () => {
    const { d, p1, p2 } = game();
    const narset = d.put(p1, C('Narset, Enlightened Master'));
    const freeze = d.g.createObject(C('Brain Freeze'), p1, 'library', { skipEvents: true }).id;
    const bears = d.g.createObject(C('Grizzly Bears'), p1, 'library', { skipEvents: true }).id;
    const lib = d.g.player(p1).library;
    for (const id of [freeze, bears]) lib.splice(lib.indexOf(id), 1);
    lib.unshift(freeze, bears); // top two cards
    d.g.refreshDecision();
    d.until((x) => x.type === 'declareAttackers');
    d.submit({ type: 'attackers', attacks: [{ attacker: narset, target: p2 }] });
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step !== 'declareAttackers');
    expect(d.g.obj(freeze).zone).toBe('exile');
    expect(d.g.obj(bears).zone).toBe('exile');
    expect(d.prio().playableCards).toContain(freeze); // free, no lands needed
    expect(d.prio().playableCards).not.toContain(bears); // creature: not allowed
  });

  it("Grand Arbiter taxes opponents' spells and discounts your white and blue ones", () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Grand Arbiter Augustin IV'));
    d.lands(p2, 'Forest', 2);
    const bears = d.give(p2, C('Grizzly Bears')); // {1}{G} → {2}{G}
    d.main(p2);
    expect(d.prio().playableCards).not.toContain(bears);
    d.lands(p2, 'Forest', 1);
    d.until((x) => x.type === 'priority' && x.player === p2);
    expect(d.prio().playableCards).toContain(bears);
  });
  it('Kalonian Hydra doubles each creature\'s own counters, with Hardened Scales adding one per creature', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Hardened Scales'));
    const hydra = d.put(p1, C('Kalonian Hydra'));
    d.g.obj(hydra).counters['+1/+1'] = 4;
    const bear = d.put(p1, C('Grizzly Bears'));
    d.g.obj(bear).counters['+1/+1'] = 1;
    d.g.refreshDecision();
    d.until((x) => x.type === 'declareAttackers');
    d.submit({ type: 'attackers', attacks: [{ attacker: hydra, target: p2 }] });
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0 && d.g.state.turn.step !== 'declareAttackers');
    expect(d.g.obj(hydra).counters['+1/+1']).toBe(9); // 4 + (4 + 1 from Scales)
    expect(d.g.obj(bear).counters['+1/+1']).toBe(3); // 1 + (1 + 1)
  });

  it('Winding Constrictor adds a counter to every batch of counters on your artifacts and creatures', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Forest', 5);
    d.put(p1, C('Winding Constrictor'));
    const hydra = d.give(p1, C('Kalonian Hydra'));
    d.cast(hydra);
    d.resolve();
    expect(d.g.obj(d.bf(p1, 'Kalonian Hydra')[0]).counters['+1/+1']).toBe(5);
  });
  it('Yorion blinks your permanents until the next end step', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Plains', 4);
    d.lands(p1, 'Island', 1);
    const bear = d.put(p1, C('Grizzly Bears'));
    const ring = d.put(p1, C('Sol Ring'));
    const yorion = d.give(p1, C('Yorion, Sky Nomad'));
    const turn = d.g.state.turn.number;
    d.cast(yorion);
    d.until(() => d.g.obj(bear).zone === 'exile', 200);
    expect(d.g.obj(bear).zone).toBe('exile');
    expect(d.g.obj(ring).zone).toBe('exile');
    expect(d.g.state.turn.number).toBe(turn);
    d.until(() => d.g.obj(bear).zone === 'battlefield', 400);
    expect(d.g.state.turn.number).toBeLessThanOrEqual(turn + 1); // back by the end of this turn (the harness only sees decision points)
    expect(d.bf(p1, 'Grizzly Bears')).toHaveLength(1);
    expect(d.bf(p1, 'Sol Ring')).toHaveLength(1);
  });

  it("Elesh Norn, Mother of Machines: opponents' ETB triggers don't fire", () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Elesh Norn, Mother of Machines'));
    d.put(p2, C('Impact Tremors'));
    d.lands(p2, 'Forest', 2);
    d.main(p2);
    const bears = d.give(p2, C('Grizzly Bears'));
    d.cast(bears);
    d.resolve();
    d.answer(d.d);
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0);
    expect(d.g.player(p1).life).toBe(40); // no Impact Tremors damage
  });
  it('Storm copies Grapeshot once per spell cast before it this turn', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Mountain', 4);
    d.lands(p1, 'Island', 2);
    const f1 = d.give(p1, C('Brain Freeze'));
    const shot = d.give(p1, C('Grapeshot'));
    d.cast(f1);
    d.targetPlayer(p2);
    d.resolve();
    d.cast(shot);
    d.targetPlayer(p2);
    d.enemy = p2;
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0 && x.player === p1, 400);
    expect(d.g.player(p2).life).toBe(38); // Grapeshot + one storm copy
  });

  it('Cascade exiles until a cheaper nonland card and lets you cast it free', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Forest', 6);
    d.lands(p1, 'Island', 1);
    d.lands(p1, 'Mountain', 1);
    const bears = d.g.createObject(C('Grizzly Bears'), p1, 'library', { skipEvents: true }).id;
    const lib = d.g.player(p1).library;
    lib.splice(lib.indexOf(bears), 1);
    lib.splice(2, 0, bears); // third from the top, under two Plains
    d.g.refreshDecision();
    const libBefore = lib.length;
    const wanderer = d.give(p1, C('Maelstrom Wanderer'));
    d.cast(wanderer);
    d.yesNo = () => true;
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0 && x.player === p1, 400);
    expect(d.bf(p1, 'Grizzly Bears')).toHaveLength(1); // cast for free off the first cascade
    expect(d.bf(p1, 'Maelstrom Wanderer')).toHaveLength(1);
    expect(d.g.player(p1).exile).toHaveLength(0); // everything else went to the bottom
    expect(d.g.player(p1).library.length).toBe(libBefore - 1);
  });

  it('Feather returns a spell that targeted your creature to your hand at end step', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Forest', 2);
    d.put(p1, C('Feather, the Redeemed'));
    const bear = d.put(p1, C('Grizzly Bears'));
    const gg = d.give(p1, C('Giant Growth'));
    d.cast(gg);
    d.targetObject(bear);
    d.resolve();
    d.until(() => d.g.obj(gg).zone === 'exile', 50);
    expect(d.g.obj(gg).zone).toBe('exile');
    d.until(() => d.g.obj(gg).zone === 'hand', 400);
    expect(d.g.obj(gg).zone).toBe('hand');
  });
  it('Bloodbraid Elf cascades exactly once', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Mountain', 2);
    d.lands(p1, 'Forest', 2);
    const bears = d.g.createObject(C('Grizzly Bears'), p1, 'library', { skipEvents: true }).id;
    const ring = d.g.createObject(C('Sol Ring'), p1, 'library', { skipEvents: true }).id;
    const lib = d.g.player(p1).library;
    for (const id of [bears, ring]) lib.splice(lib.indexOf(id), 1);
    lib.unshift(bears, ring); // Bears on top, Sol Ring right under it
    d.g.refreshDecision();
    const elf = d.give(p1, C('Bloodbraid Elf'));
    d.cast(elf);
    d.yesNo = () => true;
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0 && x.player === p1, 400);
    expect(d.bf(p1, 'Grizzly Bears')).toHaveLength(1);
    expect(d.bf(p1, 'Sol Ring')).toHaveLength(0); // one cascade, not two
    expect(d.g.obj(ring).zone).toBe('library');
  });

  it('Snapcaster Mage grants flashback for the card\'s mana cost', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Island', 4);
    const freeze = d.g.createObject(C('Brain Freeze'), p1, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    const snap = d.give(p1, C('Snapcaster Mage'));
    d.cast(snap);
    d.targetObject(freeze);
    d.until(() => d.g.characteristics(freeze).keywords.has('Flashback'), 60);
    expect(d.g.characteristics(freeze).keywords.has('Flashback')).toBe(true);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0, 60);
    expect(d.prio().playableCards).toContain(freeze);
    const lib2 = d.g.player(p2).library.length;
    d.cast(freeze);
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).library.length).toBe(lib2 - 6); // Brain Freeze plus its storm copy (Snapcaster was cast before it)
    expect(d.g.obj(freeze).zone).toBe('exile'); // flashback exiles it
  });
  it('"deals damage equal to its power" measures the subject, not the victim', () => {
    const bite = compileCard(C('Bite Down')).script.abilities[0] as Extract<AbilitySpec, { kind: 'spell' }>;
    const dmg = bite.effects[0] as Extract<Effect, { kind: 'damage' }>;
    expect(dmg.amount).toEqual({ kind: 'power', ref: { ref: 'target', slot: 0 } });
    expect(dmg.to).toEqual({ ref: 'target', slot: 1 });
    const surge = compileCard(C('Warstorm Surge')).script.abilities[0] as Extract<AbilitySpec, { kind: 'triggered' }>;
    const sd = surge.effects[0] as Extract<Effect, { kind: 'damage' }>;
    expect(sd.amount).toEqual({ kind: 'power', ref: { ref: 'triggerObject' } });
    expect(sd.to).toEqual({ ref: 'target', slot: 0 });
  });
  it("Fecundity: the dying creature's controller, not Fecundity's, gets the draw", () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 3);
    d.put(p1, C('Fecundity'));
    const bears = d.put(p2, C('Grizzly Bears'));
    d.put(p2, C('Llanowar Elves')); // a second legal target, so Murder's target is a real choice
    const h1 = d.g.player(p1).hand.length;
    const h2 = d.g.player(p2).hand.length;
    const murder = d.give(p1, C('Murder'));
    d.cast(murder);
    d.targetObject(bears);
    let asked: PlayerId | null = null;
    d.until((x) => { if (x.type === 'yesNo' && /Fecundity/.test(x.prompt)) asked = x.player; return d.g.player(p2).hand.length === h2 + 1; }, 200);
    expect(asked).toBe(p2);
    expect(d.g.player(p2).hand.length).toBe(h2 + 1);
    expect(d.g.player(p1).hand.length).toBe(h1); // Murder left the hand, nothing drawn
  });
  it('"~ deals N damage to it/that creature" hits the antecedent, not the source', () => {
    const flash = compileCard(C('Aether Flash')).script.abilities[0] as Extract<AbilitySpec, { kind: 'triggered' }>;
    expect((flash.effects[0] as Extract<Effect, { kind: 'damage' }>).to).toEqual({ ref: 'triggerObject' });
    const dart = compileCard(C('Lightning Dart')).script.abilities[0] as Extract<AbilitySpec, { kind: 'spell' }>;
    const cond = dart.effects[0] as Extract<Effect, { kind: 'conditional' }>;
    expect(cond.if).toEqual({ kind: 'objectMatches', ref: { ref: 'target', slot: 0 }, filter: { colors: ['W', 'U'] } });
    expect((cond.then[0] as Extract<Effect, { kind: 'damage' }>).to).toEqual({ ref: 'target', slot: 0 });
    const smash = compileCard(C('Smash to Smithereens')).script.abilities[0] as Extract<AbilitySpec, { kind: 'spell' }>;
    expect((smash.effects[1] as Extract<Effect, { kind: 'damage' }>).to).toEqual({ ref: 'controllerOf', of: { ref: 'target', slot: 0 } });
    // Carbonize: "If it's a creature" asks about the target, not the spell.
    const carb = compileCard(C('Carbonize')).script.abilities[0] as Extract<AbilitySpec, { kind: 'spell' }>;
    expect((carb.effects[1] as Extract<Effect, { kind: 'conditional' }>).if).toEqual({ kind: 'objectMatches', ref: { ref: 'target', slot: 0 }, filter: { types: ['Creature'] } });
  });
  it('Aether Flash: a creature entering takes 2 from the enchantment', () => {
    const { d, p1 } = game();
    d.put(p1, C('Aether Flash'));
    d.lands(p1, 'Forest', 2);
    const bears = d.give(p1, C('Grizzly Bears'));
    d.cast(bears);
    d.resolve();
    d.until(() => d.g.state.objects[bears]?.zone === 'graveyard', 200);
    expect(d.g.state.objects[bears]?.zone).toBe('graveyard');
    expect(d.g.state.objects[d.bf(p1, 'Aether Flash')[0]]).toBeDefined(); // the enchantment took no damage
  });
  it('temporary copies end with the turn and copy the right object', () => {
    const man = compileCard(C('Impossible Man')).script.abilities.find((a) => a.kind === 'activated') as Extract<AbilitySpec, { kind: 'activated' }>;
    const copy = man.effects[0] as Extract<Effect, { kind: 'becomeCopy' }>;
    expect(copy.duration).toBe('endOfTurn');
    expect(copy.of).toEqual({ ref: 'target', slot: 0 });
    expect(man.targets).toHaveLength(1);
    const drifter = compileCard(C('Vesuvan Drifter')).script.abilities.find((a) => a.kind === 'triggered') as Extract<AbilitySpec, { kind: 'triggered' }>;
    const cond = drifter.effects[1] as Extract<Effect, { kind: 'conditional' }>;
    const dc = cond.then[0] as Extract<Effect, { kind: 'becomeCopy' }>;
    expect(dc.of).toEqual({ ref: 'lastMoved' });
    expect(dc.duration).toBe('endOfTurn');
    const oldMan = compileCard(C('Old Man of the Sea')).script.abilities.find((a) => a.kind === 'activated') as Extract<AbilitySpec, { kind: 'activated' }>;
    expect((oldMan.effects[0] as Extract<Effect, { kind: 'gainControl' }>).duration).toBe('whileSourceTapped');
  });
  it('"That token gains haste" with no stated duration lasts indefinitely', () => {
    const helm = compileCard(C('Helm of the Host')).script.abilities.find((a) => a.kind === 'triggered') as Extract<AbilitySpec, { kind: 'triggered' }>;
    const grant = helm.effects.find((e) => e.kind === 'grantKeywords') as Extract<Effect, { kind: 'grantKeywords' }>;
    expect(grant.keywords).toEqual(['Haste']);
    expect(grant.on).toEqual({ ref: 'lastCreated' });
    expect(grant.duration).toBe('permanent');
  });
  it('Comet Storm: one extra target per kick, X damage to each', () => {
    const storm = compileCard(C('Comet Storm')).script.abilities.find((a) => a.kind === 'spell') as Extract<AbilitySpec, { kind: 'spell' }>;
    expect(storm.targets).toHaveLength(2);
    expect(storm.targets![1].countAmount).toEqual({ kind: 'kickCount' });
    expect(storm.effects.filter((e) => e.kind === 'damage').map((e) => (e as Extract<Effect, { kind: 'damage' }>).to)).toEqual([{ ref: 'target', slot: 0 }, { ref: 'target', slot: 1 }]);
  });
  it('Heartless Hidetsugu halves each player\'s own life total', () => {
    const { d, p1, p2 } = game();
    const hide = d.put(p1, C('Heartless Hidetsugu'));
    d.g.player(p1).life = 40;
    d.g.player(p2).life = 21;
    d.g.refreshDecision();
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === hide);
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: hide, abilityIndex: ab!.abilityIndex });
    d.resolve();
    expect(d.g.player(p1).life).toBe(20);
    expect(d.g.player(p2).life).toBe(11); // half of 21 rounded down is 10
  });
  it('Yawgmoth Demon: declining the sacrifice taps it and deals 2 damage to you', () => {
    const { d, p1 } = game(3, [], { autoPassWhenNothingToDo: false });
    const demon = d.put(p1, C('Yawgmoth Demon'));
    d.put(p1, C('Sol Ring'));
    d.g.player(p1).life = 40;
    d.yesNo = (prompt) => !/Yawgmoth Demon/.test(prompt); // say no to the Demon's sacrifice
    const turn = d.g.state.turn.number;
    d.until(() => d.g.state.turn.number > turn && d.g.state.turn.activePlayer === p1 && d.g.state.turn.step !== 'untap' && d.g.state.turn.step !== 'upkeep' && d.g.state.stack.length === 0, 1500);
    expect(d.g.obj(demon).tapped).toBe(true);
    expect(d.g.player(p1).life).toBe(38);
    expect(d.bf(p1, 'Sol Ring')).toHaveLength(1);
  });
  it('"Tap X target creatures" asks for exactly X targets', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 3);
    const a = d.put(p2, C('Grizzly Bears'));
    const b = d.put(p2, C('Grizzly Bears'));
    d.put(p2, C('Llanowar Elves'));
    const glimpse = d.give(p1, C('Glimpse the Sun God'));
    d.cast(glimpse, { xValue: 2 });
    d.until((x) => x.type === 'chooseTargets', 60);
    const dec = d.g.pending as Extract<Decision, { type: 'chooseTargets' }>;
    expect(dec.slots[0].min).toBe(2);
    expect(dec.slots[0].max).toBe(2);
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: a }, { kind: 'object', id: b }]] });
    d.resolve();
    expect(d.g.obj(a).tapped).toBe(true);
    expect(d.g.obj(b).tapped).toBe(true);
  });
  it('Cataclysm: each player keeps one permanent of each kind and sacrifices the rest', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Plains', 4);
    d.put(p1, C('Sol Ring'));
    d.put(p1, C('Skullclamp'));
    d.put(p1, C('Grizzly Bears'));
    d.put(p1, C('Llanowar Elves'));
    d.put(p1, C('Fecundity'));
    d.lands(p2, 'Forest', 2);
    d.put(p2, C('Grizzly Bears'));
    const cat = d.give(p1, C('Cataclysm'));
    d.cast(cat);
    d.resolve();
    const kinds = (p: PlayerId) => d.g.state.battlefield.filter((id) => d.g.obj(id).controller === p).map((id) => d.g.characteristics(id).types.join('/')).sort();
    expect(kinds(p1)).toEqual(['Artifact', 'Creature', 'Enchantment', 'Land']);
    expect(kinds(p2)).toEqual(['Creature', 'Land']);
  });
  it('Terastodon: each destroyed permanent\'s controller gets an Elephant', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Forest', 8);
    const ring = d.put(p2, C('Sol Ring'));
    const island = d.put(p2, C('Island'));
    const mine = d.put(p1, C('Sol Ring'));
    const tera = d.give(p1, C('Terastodon'));
    d.cast(tera);
    d.yesNo = () => true;
    d.until((x) => x.type === 'chooseTargets', 60);
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: ring }, { kind: 'object', id: island }, { kind: 'object', id: mine }]] });
    d.until(() => d.bf(p2, 'Elephant').length + d.bf(p1, 'Elephant').length === 3, 200);
    expect(d.g.obj(ring).zone).toBe('graveyard');
    expect(d.bf(p2, 'Elephant')).toHaveLength(2);
    expect(d.bf(p1, 'Elephant')).toHaveLength(1);
  });
  it('Light Up the Stage: exiled cards stay playable through your next turn, not after', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Mountain', 4);
    const bears = d.g.createObject(C('Grizzly Bears'), p1, 'library', { skipEvents: true }).id;
    const ring = d.g.createObject(C('Sol Ring'), p1, 'library', { skipEvents: true }).id;
    const lib = d.g.player(p1).library;
    for (const id of [bears, ring]) lib.splice(lib.indexOf(id), 1);
    lib.unshift(bears, ring);
    d.g.refreshDecision();
    const stage = d.give(p1, C('Light Up the Stage'));
    d.cast(stage);
    d.resolve();
    expect(d.g.obj(ring).zone).toBe('exile');
    expect(d.prio().playableCards).toContain(ring);
    const turn = d.g.state.turn.number;
    const main1 = (x: Decision, minTurn: number) => x.type === 'priority' && x.player === p1 && d.g.state.turn.activePlayer === p1 && d.g.state.turn.number > minTurn && d.g.state.turn.step === 'main1' && d.g.state.stack.length === 0;
    d.until((x) => main1(x, turn), 800);
    expect(d.prio().playableCards).toContain(ring); // your next turn: still playable
    const next = d.g.state.turn.number;
    d.until((x) => main1(x, next), 800);
    expect(d.prio().playableCards).not.toContain(ring); // the turn after: permission has ended
  });
  it('Deep Analysis flashes back for {1}{U} and 3 life', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Island', 2);
    const da = d.g.createObject(C('Deep Analysis'), p1, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect(d.prio().playableCards).toContain(da); // {1}{U} with two Islands, not {3}{U}
    const hand = d.g.player(p1).hand.length;
    d.cast(da);
    d.targetPlayer(p1);
    d.resolve();
    expect(d.g.player(p1).life).toBe(37);
    expect(d.g.player(p1).hand.length).toBe(hand + 2);
    expect(d.g.obj(da).zone).toBe('exile');
  });
});
