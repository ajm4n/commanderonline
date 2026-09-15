import { Game, type CardData, type CardScript, type Decision, type PlayerSetup, type Response, type PlayerId, type ObjectId, E, R, T } from '../src/index.js';

let oid = 0;
export function card(p: Partial<CardData> & { name: string; typeLine: string }): CardData {
  return {
    oracleId: `oracle:${p.name}`,
    scryfallId: `sf:${p.name}:${oid++}`,
    layout: 'normal',
    manaCost: '',
    cmc: 0,
    oracleText: '',
    colors: [],
    colorIdentity: [],
    keywords: [],
    ...p,
  };
}

export const FOREST = card({ name: 'Forest', typeLine: 'Basic Land — Forest', oracleText: '({T}: Add {G}.)' });
export const MOUNTAIN = card({ name: 'Mountain', typeLine: 'Basic Land — Mountain', oracleText: '({T}: Add {R}.)' });
export const ISLAND = card({ name: 'Island', typeLine: 'Basic Land — Island', oracleText: '({T}: Add {U}.)' });
export const PLAINS = card({ name: 'Plains', typeLine: 'Basic Land — Plains', oracleText: '({T}: Add {W}.)' });
export const BEARS = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', colors: ['G'], colorIdentity: ['G'] });
export const BOLT = card({ name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', cmc: 1, oracleText: 'Lightning Bolt deals 3 damage to any target.', colors: ['R'], colorIdentity: ['R'] });
export const SOL_RING = card({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, oracleText: '{T}: Add {C}{C}.' });
export const ELVES = card({ name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid', manaCost: '{G}', cmc: 1, power: '1', toughness: '1', oracleText: '{T}: Add {G}.', colors: ['G'], colorIdentity: ['G'] });
export const SERRA = card({ name: 'Serra Angel', typeLine: 'Creature — Angel', manaCost: '{3}{W}{W}', cmc: 5, power: '4', toughness: '4', oracleText: 'Flying, vigilance', keywords: ['Flying', 'Vigilance'], colors: ['W'], colorIdentity: ['W'] });
export const WALL = card({ name: 'Wall of Wood', typeLine: 'Creature — Wall', manaCost: '{G}', cmc: 1, power: '0', toughness: '3', oracleText: 'Defender', keywords: ['Defender'], colors: ['G'], colorIdentity: ['G'] });
export const VISIONARY = card({ name: 'Elvish Visionary', typeLine: 'Creature — Elf Shaman', manaCost: '{1}{G}', cmc: 2, power: '1', toughness: '1', oracleText: 'When Elvish Visionary enters the battlefield, draw a card.', colors: ['G'], colorIdentity: ['G'] });
export const BLOOD_ARTIST = card({ name: 'Blood Artist', typeLine: 'Creature — Vampire', manaCost: '{1}{B}', cmc: 2, power: '0', toughness: '1', oracleText: 'Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.', colors: ['B'], colorIdentity: ['B'] });
export const ANTHEM = card({ name: 'Glorious Anthem', typeLine: 'Enchantment', manaCost: '{1}{W}{W}', cmc: 3, oracleText: 'Creatures you control get +1/+1.', colors: ['W'], colorIdentity: ['W'] });
export const COUNTERSPELL = card({ name: 'Counterspell', typeLine: 'Instant', manaCost: '{U}{U}', cmc: 2, oracleText: 'Counter target spell.', colors: ['U'], colorIdentity: ['U'] });
export const COMMANDER = card({ name: 'Test Commander', typeLine: 'Legendary Creature — Human Warrior', manaCost: '{2}{G}', cmc: 3, power: '5', toughness: '5', oracleText: 'Trample', keywords: ['Trample'], colors: ['G'], colorIdentity: ['G'] });
export const GIANT_GROWTH = card({ name: 'Giant Growth', typeLine: 'Instant', manaCost: '{G}', cmc: 1, oracleText: 'Target creature gets +3/+3 until end of turn.', colors: ['G'], colorIdentity: ['G'] });
export const WRATH = card({ name: 'Wrath of God', typeLine: 'Sorcery', manaCost: '{2}{W}{W}', cmc: 4, oracleText: "Destroy all creatures. They can't be regenerated.", colors: ['W'], colorIdentity: ['W'] });
export const UNSCRIPTED = card({ name: 'Mystery Sorcery', typeLine: 'Sorcery', manaCost: '{G}', cmc: 1, oracleText: 'Do something the engine does not understand.', colors: ['G'], colorIdentity: ['G'] });
export const CONTROL_MAGIC = card({ name: 'Control Magic', typeLine: 'Enchantment — Aura', manaCost: '{2}{U}{U}', cmc: 4, oracleText: 'Enchant creature\nYou control enchanted creature.', colors: ['U'], colorIdentity: ['U'] });
export const CONVOKE_GUY = card({ name: 'Convoke Wurm', typeLine: 'Creature — Wurm', manaCost: '{4}{G}{G}', cmc: 6, power: '5', toughness: '5', oracleText: 'Convoke', keywords: ['Convoke'], colors: ['G'], colorIdentity: ['G'] });
export const DELVE_SPELL = card({ name: 'Delve Draw', typeLine: 'Sorcery', manaCost: '{6}{U}', cmc: 7, oracleText: 'Delve\nDraw three cards.', keywords: ['Delve'], colors: ['U'], colorIdentity: ['U'] });
export const AFFINITY_GUY = card({ name: 'Frogmite', typeLine: 'Artifact Creature — Frog', manaCost: '{4}', cmc: 4, power: '2', toughness: '2', oracleText: 'Affinity for artifacts', keywords: ['Affinity'] });
export const PLOT_SPELL = card({ name: 'Plot Bolt', typeLine: 'Sorcery', manaCost: '{R}', cmc: 1, oracleText: 'Plot Bolt deals 3 damage to any target.\nPlot {R}', colors: ['R'], colorIdentity: ['R'] });
export const WARP_GUY = card({ name: 'Warp Beast', typeLine: 'Creature — Beast', manaCost: '{3}{G}', cmc: 4, power: '4', toughness: '4', oracleText: 'Warp {G}', colors: ['G'], colorIdentity: ['G'] });
export const MONSTER = card({ name: 'Monster', typeLine: 'Creature — Beast', manaCost: '{2}{G}', cmc: 3, power: '2', toughness: '2', oracleText: '{2}{G}: Monstrosity 3.\nWhen Monster becomes monstrous, you gain 3 life.', colors: ['G'], colorIdentity: ['G'] });
export const LEVELER = card({ name: 'Leveler', typeLine: 'Creature — Human', manaCost: '{W}', cmc: 1, power: '1', toughness: '1', oracleText: 'Level up {W}\nLEVEL 1-2\n2/2\nFirst strike\nLEVEL 3+\n3/3\nFirst strike, lifelink', colors: ['W'], colorIdentity: ['W'] });
export const UPKEEP_GUY = card({ name: 'Upkeep Guy', typeLine: 'Creature — Human', manaCost: '{G}', cmc: 1, power: '1', toughness: '1', oracleText: 'At the beginning of your upkeep, you gain 1 life.', colors: ['G'], colorIdentity: ['G'] });

export const SCRIPTS: Record<string, CardScript> = {
  'Control Magic': { name: 'Control Magic', coverage: 'full', origin: 'hand', abilities: [{ kind: 'static', text: 'You control enchanted creature.', affects: 'attachedTo', modification: { layer: 'control', controller: 'sourceController' } }] },
  'Frogmite': { name: 'Frogmite', coverage: 'full', origin: 'hand', abilities: [], costModifiers: [{ amount: 1, direction: 'less', per: { types: ['Artifact'], controller: 'you', zone: 'battlefield' } }] },
  'Plot Bolt': { name: 'Plot Bolt', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.any()], effects: [E.damage(3, R.target())] }, { kind: 'activated', text: 'Plot {R}', cost: { mana: '{R}' }, effects: [{ kind: 'plot' }], zone: 'hand', sorcerySpeed: true }] },
  'Warp Beast': { name: 'Warp Beast', coverage: 'full', origin: 'hand', abilities: [], alternativeCosts: [{ id: 'warp', text: 'Warp {G}', cost: { mana: '{G}' }, zone: 'hand' }] },
  'Delve Draw': { name: 'Delve Draw', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [E.draw(3)] }] },
  Monster: { name: 'Monster', coverage: 'full', origin: 'hand', abilities: [{ kind: 'activated', text: '{2}{G}: Monstrosity 3.', cost: { mana: '{2}{G}' }, effects: [{ kind: 'monstrosity', amount: 3 }] }, { kind: 'triggered', text: 'When Monster becomes monstrous, you gain 3 life.', event: 'becomesMonstrous', filter: { self: true }, effects: [E.gainLife(3)] }] },
  Leveler: {
    name: 'Leveler',
    coverage: 'full',
    origin: 'hand',
    abilities: [
      { kind: 'activated', text: 'Level up {W}', cost: { mana: '{W}' }, effects: [E.counters('level', 1, R.self)], sorcerySpeed: true },
      { kind: 'static', text: 'LEVEL 1-2 2/2', affects: 'self', modification: { layer: '7b', setPower: 2, setToughness: 2 }, condition: { kind: 'and', cs: [{ kind: 'hasCounter', ref: R.self, counter: 'level', op: '>=', value: 1 }, { kind: 'hasCounter', ref: R.self, counter: 'level', op: '<=', value: 2 }] } },
      { kind: 'static', text: 'LEVEL 3+ 3/3', affects: 'self', modification: { layer: '7b', setPower: 3, setToughness: 3 }, condition: { kind: 'hasCounter', ref: R.self, counter: 'level', op: '>=', value: 3 } },
      { kind: 'static', text: 'LEVEL 3+ lifelink', affects: 'self', modification: { layer: 6, addKeywords: ['Lifelink'] }, condition: { kind: 'hasCounter', ref: R.self, counter: 'level', op: '>=', value: 3 } },
    ],
  },
  'Lightning Bolt': { name: 'Lightning Bolt', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.any()], effects: [E.damage(3, R.target())] }] },
  'Sol Ring': { name: 'Sol Ring', coverage: 'full', origin: 'hand', abilities: [{ kind: 'activated', text: '{T}: Add {C}{C}.', cost: { tap: true }, effects: [E.mana(['C', 'C'])], manaAbility: true }] },
  'Llanowar Elves': { name: 'Llanowar Elves', coverage: 'full', origin: 'hand', abilities: [{ kind: 'activated', text: '{T}: Add {G}.', cost: { tap: true }, effects: [E.mana(['G'])], manaAbility: true }] },
  'Elvish Visionary': { name: 'Elvish Visionary', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'When Elvish Visionary enters the battlefield, draw a card.', event: 'entersBattlefield', filter: { self: true }, effects: [E.draw(1)] }] },
  'Blood Artist': {
    name: 'Blood Artist',
    coverage: 'full',
    origin: 'hand',
    abilities: [{ kind: 'triggered', text: 'Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.', event: 'dies', filter: { object: { types: ['Creature'] } }, targets: [T.player()], effects: [E.loseLife(1, R.target()), E.gainLife(1)] }],
  },
  'Glorious Anthem': { name: 'Glorious Anthem', coverage: 'full', origin: 'hand', abilities: [{ kind: 'static', text: 'Creatures you control get +1/+1.', affects: { types: ['Creature'], controller: 'you' }, modification: { layer: '7c', power: 1, toughness: 1 } }] },
  Counterspell: { name: 'Counterspell', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.spell()], effects: [E.counter()] }] },
  'Giant Growth': { name: 'Giant Growth', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.pump(3, 3, R.target())] }] },
  'Wrath of God': { name: 'Wrath of God', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [{ kind: 'destroy', what: R.all({ types: ['Creature'] }), cantRegenerate: true }] }] },
  'Upkeep Guy': { name: 'Upkeep Guy', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'At the beginning of your upkeep, you gain 1 life.', event: 'beginningOfUpkeep', filter: { player: 'you' }, effects: [E.gainLife(1)] }] },
};

export function scriptProvider(card: CardData): CardScript {
  return SCRIPTS[card.name] ?? { name: card.name, abilities: [], coverage: 'none', origin: 'keywordsOnly', unhandledText: card.oracleText ? [card.oracleText] : [] };
}

export function deck(cards: CardData[], n = 40): CardData[] {
  const out: CardData[] = [];
  while (out.length < n) for (const c of cards) if (out.length < n) out.push(c);
  return out;
}

export function setup(id: string, main: CardData[], commanders: CardData[] = []): PlayerSetup {
  return { id, name: id.toUpperCase(), deck: { mainboard: main, commanders } };
}

/** Test driver: answers decisions with sensible defaults until a predicate matches. */
export class Driver {
  constructor(public g: Game) {}
  get d(): Decision | null {
    return this.g.pending;
  }
  submit(r: Response) {
    if (!this.g.pending) throw new Error('no pending decision');
    this.g.submit(this.g.pending.player, r);
  }
  /** Keep answering with defaults until pred(decision) or the game ends. */
  until(pred: (d: Decision) => boolean, max = 500) {
    for (let i = 0; i < max; i++) {
      const d = this.g.pending;
      if (!d) return;
      if (pred(d)) return;
      this.defaultAnswer(d);
    }
    throw new Error(`Predicate never matched. Last decision: ${JSON.stringify(this.g.pending)}`);
  }
  defaultAnswer(d: Decision) {
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
        return this.submit({ type: 'objects', ids: d.candidates.slice(0, d.min) });
      case 'chooseOption':
        return this.submit({ type: 'options', ids: d.options.filter((o) => !o.disabled).slice(0, d.min).map((o) => o.id) });
      case 'orderObjects':
        return this.submit({ type: 'order', ids: d.items ? d.items.map((i) => i.id) : d.objectIds });
      case 'chooseTargets':
        return this.submit({ type: 'targets', targets: d.slots.map((s) => s.legal.slice(0, s.min)) });
      case 'chooseNumber':
        return this.submit({ type: 'number', value: d.max });
      case 'distribute': {
        const amounts = d.targets.map(() => d.minPer);
        amounts[0] += d.amount - amounts.reduce((a, b) => a + b, 0);
        return this.submit({ type: 'distribute', amounts });
      }
      case 'manualTrigger':
        return this.submit({ type: 'manualDone' });
      case 'payMana':
        return this.submit({ type: 'payMana', tap: [], auto: true });
    }
  }
  /** Advance to the given player's priority in a main phase of their own turn. */
  toMainPhase(player: PlayerId, which: 'main1' | 'main2' = 'main1') {
    this.until((d) => d.type === 'priority' && d.player === player && this.g.state.turn.activePlayer === player && this.g.state.turn.step === which && this.g.state.stack.length === 0);
  }
  toStep(player: PlayerId, step: string) {
    this.until((d) => d.type === 'priority' && d.player === player && this.g.state.turn.activePlayer === player && this.g.state.turn.step === step);
  }
  hand(p: PlayerId, name: string): ObjectId {
    const id = this.g.player(p).hand.find((x) => this.g.obj(x).card.name === name);
    if (id === undefined) throw new Error(`${name} not in ${p}'s hand: ${this.g.player(p).hand.map((x) => this.g.obj(x).card.name).join(', ')}`);
    return id;
  }
  bf(p: PlayerId, name: string): ObjectId {
    const id = this.g.state.battlefield.find((x) => this.g.obj(x).card.name === name && this.g.obj(x).controller === p);
    if (id === undefined) throw new Error(`${name} not on ${p}'s battlefield`);
    return id;
  }
  /** Put a card into a player's hand from wherever (test setup convenience via manual). */
  give(p: PlayerId, c: CardData): ObjectId {
    const o = this.g.createObject(c, p, 'hand', { skipEvents: true });
    this.g.refreshDecision();
    return o.id;
  }
  /** Put a permanent directly onto the battlefield (untapped, no summoning sickness). */
  put(p: PlayerId, c: CardData, opts: { tapped?: boolean } = {}): ObjectId {
    const o = this.g.createObject(c, p, 'battlefield', { tapped: opts.tapped, skipEvents: true });
    o.controlSinceTurn = -1;
    o.enteredThisTurn = false;
    this.g.refreshDecision();
    return o.id;
  }
  playLand(p: PlayerId, name: string) {
    this.until((d) => d.type === 'priority' && d.player === p);
    this.submit({ type: 'playLand', objectId: this.hand(p, name) });
  }
  cast(p: PlayerId, name: string) {
    this.until((d) => d.type === 'priority' && d.player === p);
    this.submit({ type: 'cast', objectId: this.hand(p, name) });
  }
  /** Everyone passes until the stack is empty and we're back to `p` with priority (or step changes). */
  resolveAll() {
    this.until((d) => d.type === 'priority' && this.g.state.stack.length === 0);
  }
}

export function newGame(setups: PlayerSetup[], seed = 42, config: Partial<import('../src/index.js').GameConfig> = {}): Driver {
  const g = new Game(setups, { seed, ...config }, scriptProvider);
  g.start();
  return new Driver(g);
}
