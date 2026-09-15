/** A discard deck's cards, compiled from oracle text and played through the engine. */
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
type Prio = Extract<Decision, { type: 'priority' }>;

class D {
  constructor(public g: Game) {}
  get d() {
    return this.g.pending!;
  }
  submit(r: Response) {
    this.g.submit(this.g.pending!.player, r);
  }
  until(pred: (d: Decision) => boolean, max = 800) {
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
  put(p: PlayerId, c: CardData, counters?: Record<string, number>): ObjectId {
    const o = this.g.createObject(c, p, 'battlefield', { skipEvents: true, counters });
    o.controlSinceTurn = -1;
    o.enteredThisTurn = false;
    this.g.refreshDecision();
    return o.id;
  }
  lands(p: PlayerId, name: string, n: number) {
    for (let i = 0; i < n; i++) this.put(p, C(name));
  }
  main(p: PlayerId) {
    this.until((d) => d.type === 'priority' && d.player === p && this.g.state.turn.activePlayer === p && this.g.state.turn.step === 'main1' && this.g.state.stack.length === 0);
  }
  resolve() {
    this.until((d) => d.type === 'priority' && this.g.state.stack.length === 0);
  }
  cast(id: ObjectId) {
    this.submit({ type: 'cast', objectId: id });
  }
  targetPlayer(p: PlayerId) {
    this.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    if (this.d.type === 'chooseTargets') this.submit({ type: 'targets', targets: [[{ kind: 'player', id: p }]] });
  }
  /**
   * Pick a target when asked. The engine skips the prompt when there is exactly one legal target, and
   * with nothing to respond with the spell may even have resolved already by the time we get priority back.
   */
  targetObject(id: ObjectId) {
    this.until((x) => x.type === 'chooseTargets' || x.type === 'priority');
    if (this.d.type === 'chooseTargets') this.submit({ type: 'targets', targets: [[{ kind: 'object', id }]] });
  }
  prio(): Prio {
    return this.d as Prio;
  }
}

function game(opts: { p1Deck?: CardData[]; seed?: number } = {}): { d: D; p1: PlayerId; p2: PlayerId } {
  const swamps = Array.from({ length: 40 }, () => C('Swamp'));
  const setups: PlayerSetup[] = [
    { id: 'a', name: 'A', deck: { mainboard: opts.p1Deck ?? swamps, commanders: [] } },
    { id: 'b', name: 'B', deck: { mainboard: Array.from({ length: 40 }, () => C('Forest')), commanders: [] } },
  ];
  const g = new Game(setups, { seed: opts.seed ?? 3 }, scriptFor);
  g.start();
  const d = new D(g);
  const [p1, p2] = g.state.playerOrder;
  d.main(p1);
  return { d, p1, p2 };
}

describe('Tinybones discard deck', () => {
  it('every card in the suite compiles fully', () => {
    const names = ['Tinybones, Pocket Nuisance', 'Tinybones, Trinket Thief', 'Bone Miser', 'Bojuka Bog', "Witch's Cottage", 'Undying Malice', 'Syr Konrad, the Grim', 'Sanguine Bond', 'Erebos, God of the Dead', 'Cut Down', 'Painful Quandary', 'Peer into the Abyss', 'Dark Deal', 'Wishclaw Talisman', 'Necropotence', 'Waste Not', 'Quest for the Nihil Stone', 'Feed the Swarm', 'Leechridden Swamp', 'Whispersilk Cloak', 'Urborg, Tomb of Yawgmoth', 'Gray Merchant of Asphodel', 'Nezumi Shortfang', 'Vito, Thorn of the Dusk Rose', 'Exsanguinate'];
    const notFull = names.filter((n) => scriptFor(C(n)).coverage !== 'full').map((n) => `${n}: ${scriptFor(C(n)).unhandledText?.join(' / ')}`);
    expect(notFull).toEqual([]);
  });

  it('Dark Deal wheels everyone and Bone Miser pays off each discarded card type', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 4);
    d.put(p1, C('Bone Miser'));
    // Empty p1's hand of the random Swamps so the discards are exactly one land, one creature and one noncreature spell.
    for (const id of [...d.g.player(p1).hand]) d.g.applyManual(p1, { kind: 'moveObject', objectId: id, toZone: 'library', position: 'bottom' });
    d.give(p1, C('Swamp'));
    d.give(p1, C('Grizzly Bears'));
    d.give(p1, C('Lightning Bolt'));
    const deal = d.give(p1, C('Dark Deal'));
    d.g.refreshDecision();
    const p2Hand = d.g.player(p2).hand.length;
    d.cast(deal);
    d.resolve();
    // Bone Miser: land → {B}{B}, creature → Zombie, noncreature → draw. Dark Deal: draw 3 - 1 = 2.
    expect(d.g.player(p1).manaPool.B).toBe(2);
    expect(d.g.state.battlefield.some((id) => d.g.obj(id).card.name === 'Zombie' && d.g.obj(id).controller === p1)).toBe(true);
    expect(d.g.player(p1).hand.length).toBe(3);
    expect(d.g.player(p2).hand.length).toBe(p2Hand - 1);
  });

  it('Bojuka Bog exiles the targeted graveyard', () => {
    const { d, p1, p2 } = game();
    d.g.applyManual(p2, { kind: 'mill', count: 3 });
    d.g.refreshDecision();
    expect(d.g.player(p2).graveyard.length).toBe(3);
    const bog = d.give(p1, C('Bojuka Bog'));
    d.submit({ type: 'playLand', objectId: bog });
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).graveyard.length).toBe(0);
    expect(d.g.player(p2).exile.length).toBe(3);
    expect(d.g.obj(bog).tapped).toBe(true);
  });

  it("Witch's Cottage enters tapped without three other Swamps and untapped with them", () => {
    const a = game();
    a.d.lands(a.p1, 'Swamp', 2);
    const c1 = a.d.give(a.p1, C("Witch's Cottage"));
    a.d.submit({ type: 'playLand', objectId: c1 });
    a.d.resolve();
    expect(a.d.g.obj(c1).tapped).toBe(true);

    const b = game();
    b.d.lands(b.p1, 'Swamp', 3);
    const bears = b.d.g.createObject(C('Grizzly Bears'), b.p1, 'graveyard', { skipEvents: true }).id;
    const c2 = b.d.give(b.p1, C("Witch's Cottage"));
    b.d.g.refreshDecision();
    b.d.submit({ type: 'playLand', objectId: c2 });
    // "When it enters untapped, you may put target creature card from your graveyard on top of your library."
    b.d.until((x) => x.type === 'chooseTargets' || x.type === 'yesNo');
    if (b.d.d.type === 'chooseTargets') b.d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    b.d.resolve();
    expect(b.d.g.obj(c2).tapped).toBe(false);
    expect(b.d.g.player(b.p1).library[0]).toBe(bears);
  });

  it('Undying Malice grants a dies trigger that brings the creature back tapped with a counter', () => {
    const { d, p1 } = game();
    d.lands(p1, 'Swamp', 2);
    d.put(p1, C('Mountain'));
    const bears = d.put(p1, C('Grizzly Bears'));
    const malice = d.give(p1, C('Undying Malice'));
    d.cast(malice);
    d.targetObject(bears);
    d.resolve();
    const bolt = d.give(p1, C('Lightning Bolt'));
    d.cast(bolt);
    d.targetObject(bears);
    d.resolve();
    const back = d.g.state.battlefield.find((id) => d.g.obj(id).card.name === 'Grizzly Bears');
    expect(back).toBeDefined();
    expect(d.g.obj(back!).tapped).toBe(true);
    expect(d.g.obj(back!).counters['+1/+1']).toBe(1);
  });

  it('Syr Konrad pings for creature cards leaving graveyards and for other creatures dying', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Syr Konrad, the Grim'));
    const dead = d.g.createObject(C('Grizzly Bears'), p1, 'graveyard', { skipEvents: true }).id;
    d.g.applyManual(p1, { kind: 'moveObject', objectId: dead, toZone: 'exile' });
    d.g.refreshDecision();
    d.submit({ type: 'pass' }); // the trigger is put on the stack when priority moves on
    d.resolve();
    expect(d.g.player(p2).life).toBe(39);
    // Another creature dies → another ping; a creature card milled (library → graveyard) → another.
    d.put(p1, C('Mountain'));
    const bears = d.put(p2, C('Grizzly Bears'));
    const bolt = d.give(p1, C('Lightning Bolt'));
    d.cast(bolt);
    d.targetObject(bears);
    d.resolve();
    expect(d.g.player(p2).life).toBe(38);
  });

  it('Gray Merchant drains for devotion and Sanguine Bond doubles up on the life gained', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 5);
    d.put(p1, C('Sanguine Bond'));
    const gary = d.give(p1, C('Gray Merchant of Asphodel'));
    d.cast(gary);
    d.resolve(); // Merchant resolves; its ETB trigger goes on the stack
    d.until((x) => x.type === 'chooseTargets' || (x.type === 'priority' && d.g.state.stack.length === 0 && d.g.player(p2).life < 36));
    if (d.d.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolve();
    // Devotion to black: Gray Merchant {B}{B} + Sanguine Bond {B}{B} = 4. Drain 4, Bond makes the opponent lose 4 more.
    expect(d.g.player(p1).life).toBe(44);
    expect(d.g.player(p2).life).toBe(32);
  });

  it('Erebos is not a creature until devotion to black reaches five', () => {
    const { d, p1 } = game();
    const erebos = d.put(p1, C('Erebos, God of the Dead'));
    expect(d.g.characteristics(erebos).types).not.toContain('Creature');
    d.put(p1, C('Sanguine Bond')); // {B}{B}
    expect(d.g.characteristics(erebos).types).not.toContain('Creature'); // devotion 3
    d.put(p1, C('Gray Merchant of Asphodel')); // {B}{B} → 5
    expect(d.g.characteristics(erebos).types).toContain('Creature');
  });

  it('Cut Down only targets creatures with total power and toughness 5 or less', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 1);
    const bears = d.put(p2, C('Grizzly Bears'));
    const angel = d.put(p2, C('Serra Angel'));
    const cut = d.give(p1, C('Cut Down'));
    d.cast(cut);
    d.targetObject(bears); // the Angel (4/4) is not a legal target, so the Bears are chosen automatically
    d.resolve();
    expect(d.g.obj(bears).zone).toBe('graveyard');
    expect(d.g.obj(angel).zone).toBe('battlefield');
  });

  it('Painful Quandary makes an opponent lose 5 life unless they discard', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Painful Quandary'));
    d.lands(p2, 'Forest', 2);
    const bears = d.give(p2, C('Grizzly Bears'));
    d.main(p2);
    d.cast(bears);
    d.until((x) => x.type === 'chooseObjects' && x.player === p2 && /Discard/i.test(x.prompt));
    d.submit({ type: 'objects', ids: [] });
    d.resolve();
    expect(d.g.player(p2).life).toBe(35);
    expect(d.g.obj(bears).zone).toBe('battlefield');
  });

  it('Peer into the Abyss draws half the library and takes half the life, rounded up', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 7);
    const lib = d.g.player(p2).library.length;
    const hand = d.g.player(p2).hand.length;
    const peer = d.give(p1, C('Peer into the Abyss'));
    d.cast(peer);
    d.targetPlayer(p2);
    d.resolve();
    expect(d.g.player(p2).hand.length).toBe(hand + Math.ceil(lib / 2));
    expect(d.g.player(p2).life).toBe(20);
  });

  it('Wishclaw Talisman tutors and then hands itself to an opponent', () => {
    const { d, p1, p2 } = game();
    d.lands(p1, 'Swamp', 1);
    const wish = d.put(p1, C('Wishclaw Talisman'), { wish: 3 });
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === wish)!;
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: wish, abilityIndex: ab.abilityIndex });
    d.until((x) => x.type === 'chooseObjects' && /Search/.test(x.prompt));
    const pick = (d.d as Extract<Decision, { type: 'chooseObjects' }>).candidates[0];
    d.submit({ type: 'objects', ids: [pick] });
    d.resolve();
    expect(d.g.obj(pick).zone).toBe('hand');
    expect(d.g.obj(wish).controller).toBe(p2);
    expect(d.g.obj(wish).counters['wish']).toBe(2);
  });

  it('Leechridden Swamp only activates with two black permanents', () => {
    const { d, p1, p2 } = game();
    const leech = d.put(p1, C('Leechridden Swamp'));
    d.lands(p1, 'Swamp', 1);
    expect(d.prio().activatableAbilities.filter((a) => a.objectId === leech).some((a) => /loses 1 life/.test(a.text))).toBe(false);
    d.put(p1, C('Sanguine Bond'));
    d.put(p1, C('Painful Quandary'));
    const ab = d.prio().activatableAbilities.find((a) => a.objectId === leech && /loses 1 life/.test(a.text));
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: leech, abilityIndex: ab!.abilityIndex });
    d.resolve();
    expect(d.g.player(p2).life).toBe(39);
  });

  it('Necropotence skips the draw step', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Necropotence'));
    d.main(p2);
    const hand = d.g.player(p1).hand.length;
    d.main(p1);
    expect(d.g.player(p1).hand.length).toBe(hand);
  });

  it('Leyline of the Void may start on the battlefield', () => {
    const setups: PlayerSetup[] = [
      { id: 'a', name: 'A', deck: { mainboard: Array.from({ length: 40 }, () => C('Leyline of the Void')), commanders: [] } },
      { id: 'b', name: 'B', deck: { mainboard: Array.from({ length: 40 }, () => C('Forest')), commanders: [] } },
    ];
    const g = new Game(setups, { seed: 3 }, scriptFor);
    g.start();
    const d = new D(g);
    let asked = 0;
    d.until((x) => {
      if (x.type === 'yesNo' && /Begin the game with Leyline/.test(x.prompt)) asked++;
      return g.state.turn.number >= 1;
    });
    expect(asked).toBe(7);
    expect(g.state.battlefield.filter((id) => g.obj(id).card.name === 'Leyline of the Void' && g.obj(id).controller === 'a').length).toBe(7);
    expect(g.player('a').hand.length).toBe(0);
  });

  it('Quest for the Nihil Stone drains an empty-handed opponent at their upkeep', () => {
    const { d, p1, p2 } = game();
    d.put(p1, C('Quest for the Nihil Stone'), { quest: 2 });
    for (const id of [...d.g.player(p2).hand]) d.g.applyManual(p2, { kind: 'moveObject', objectId: id, toZone: 'library', position: 'bottom' });
    d.g.refreshDecision();
    d.main(p2);
    expect(d.g.player(p2).life).toBe(35);
  });

  it('Urborg makes every land a Swamp; Whispersilk Cloak grants shroud and unblockability', () => {
    const { d, p1 } = game();
    const forest = d.put(p1, C('Forest'));
    expect(d.g.characteristics(forest).subtypes).not.toContain('Swamp');
    d.put(p1, C('Urborg, Tomb of Yawgmoth'));
    expect(d.g.characteristics(forest).subtypes).toContain('Swamp');
    const bears = d.put(p1, C('Grizzly Bears'));
    const cloak = d.put(p1, C('Whispersilk Cloak'));
    d.lands(p1, 'Swamp', 2);
    const equip = d.prio().activatableAbilities.find((a) => a.objectId === cloak && /Equip/.test(a.text));
    expect(equip).toBeDefined();
    d.submit({ type: 'activate', objectId: cloak, abilityIndex: equip!.abilityIndex });
    d.targetObject(bears);
    d.resolve();
    const ch = d.g.characteristics(bears);
    expect(ch.keywords.has('Shroud')).toBe(true);
    expect(ch.rules.some((r) => r.kind === 'cantBeBlocked')).toBe(true);
  });
});
