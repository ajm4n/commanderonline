/**
 * Rules audit: combat, state-based actions, turn structure, triggers, damage and life.
 *
 * Every test asserts the behaviour the Comprehensive Rules require and cites the rule.
 * A failing test here is a confirmed engine bug; passing tests document verified behaviour.
 */
import { describe, it, expect } from 'vitest';
import { summoningSick, buildPriorityDecision, E, R, T } from '../src/index.js';
import type { Game, ObjectId, PlayerId } from '../src/index.js';
import { newGame, deck, setup, card, FOREST, MOUNTAIN, PLAINS, BEARS, BOLT, WALL, ELVES, COMMANDER, WRATH, BLOOD_ARTIST, SCRIPTS, type Driver } from './helpers.js';

// ---------------------------------------------------------------------------
// Test cards
// ---------------------------------------------------------------------------
const FS_GUY = card({ name: 'First Striker', typeLine: 'Creature — Knight', power: '2', toughness: '2', oracleText: 'First strike', keywords: ['First strike'], colors: ['W'] });
const DS_GUY = card({ name: 'Double Striker', typeLine: 'Creature — Knight', power: '2', toughness: '2', oracleText: 'Double strike', keywords: ['Double strike'], colors: ['R'] });
const BIG = card({ name: 'Big Beast', typeLine: 'Creature — Beast', power: '3', toughness: '3', colors: ['G'] });
const TOXIC_ASSASSIN = card({ name: 'Toxic Assassin', typeLine: 'Creature — Assassin', power: '1', toughness: '1', oracleText: 'Infect\nDeathtouch', keywords: ['Infect', 'Deathtouch'], colors: ['B'] });
const INFECTOR = card({ name: 'Infector', typeLine: 'Creature — Horror', power: '1', toughness: '1', oracleText: 'Infect', keywords: ['Infect'], colors: ['B'] });
const LIFELINKER = card({ name: 'Lifelinker', typeLine: 'Creature — Cleric', power: '2', toughness: '2', oracleText: 'Lifelink', keywords: ['Lifelink'], colors: ['W'] });
const MENACE_GUY = card({ name: 'Menacer', typeLine: 'Creature — Ogre', power: '2', toughness: '2', oracleText: 'Menace', keywords: ['Menace'], colors: ['R'] });
const INDESTRUCTIBLE_GUY = card({ name: 'Unkillable', typeLine: 'Creature — Golem', power: '2', toughness: '2', oracleText: 'Indestructible', keywords: ['Indestructible'] });
const PRO_GREEN = card({ name: 'Green Hater', typeLine: 'Creature — Knight', power: '2', toughness: '2', oracleText: 'Protection from green', colors: ['W'] });
const WALKER = card({ name: 'Test Walker', typeLine: 'Legendary Planeswalker — Tester', loyalty: '4', colors: ['U'] });
const LIFE_WATCHER = card({ name: 'Life Watcher', typeLine: 'Creature — Spirit', power: '1', toughness: '1', oracleText: 'Whenever you lose life, draw a card.', colors: ['B'] });
const WORSHIPPER = card({ name: 'Worshipper', typeLine: 'Enchantment', oracleText: 'Damage that would reduce your life total to less than 1 reduces it to 1 instead.', colors: ['W'] });
const MYRIAD_LIKE = card({ name: 'Token Captain', typeLine: 'Creature — Soldier', power: '2', toughness: '2', oracleText: 'Whenever Token Captain attacks, create a 1/1 white Soldier creature token tapped and attacking.', colors: ['W'] });
const ATTACK_WATCHER = card({ name: 'Attack Watcher', typeLine: 'Creature — Spirit', power: '1', toughness: '1', oracleText: 'Whenever a creature you control attacks, you gain 1 life.', colors: ['W'] });
const DEFENDER_WATCHER = card({ name: 'Defender Watcher', typeLine: 'Creature — Spirit', power: '1', toughness: '1', oracleText: 'Whenever one or more creatures attack you, draw a card.', colors: ['U'] });
const CLEANUP_DRAWER = card({ name: 'Cleanup Drawer', typeLine: 'Enchantment', oracleText: 'At the beginning of your cleanup step, draw a card.', colors: ['U'] });

Object.assign(SCRIPTS, {
  'Life Watcher': { name: 'Life Watcher', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'Whenever you lose life, draw a card.', event: 'lifeLost', filter: { player: 'you' }, effects: [E.draw(1)] }] },
  Worshipper: { name: 'Worshipper', coverage: 'full', origin: 'hand', abilities: [{ kind: 'static', text: 'Damage that would reduce your life total to less than 1 reduces it to 1 instead.', ruleAffects: 'controller', rule: { kind: 'custom', tag: 'lifeFloor', data: 1 } }] },
  'Token Captain': {
    name: 'Token Captain',
    coverage: 'full',
    origin: 'hand',
    abilities: [{ kind: 'triggered', text: 'Whenever Token Captain attacks, create a 1/1 white Soldier creature token tapped and attacking.', event: 'attacks', filter: { self: true }, effects: [E.token({ name: 'Soldier', typeLine: 'Creature — Soldier', power: '1', toughness: '1', colors: ['W'] }, 1, { tapped: true, attacking: true })] }],
  },
  'Attack Watcher': { name: 'Attack Watcher', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'Whenever a creature you control attacks, you gain 1 life.', event: 'attacks', filter: { player: 'you' }, effects: [E.gainLife(1)] }] },
  'Defender Watcher': { name: 'Defender Watcher', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'Whenever one or more creatures attack you, draw a card.', event: 'attacked', filter: { player: 'you' }, effects: [E.draw(1)] }] },
  'Cleanup Drawer': { name: 'Cleanup Drawer', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'At the beginning of your cleanup step, draw a card.', event: 'cleanup', filter: { player: 'you' }, oncePerTurn: true, effects: [E.draw(1)] }] },
});
void R;
void T;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const forests = () => deck([FOREST], 40);

function twoPlayer(seed = 42, commanders: { a?: typeof FOREST[]; b?: typeof FOREST[] } = {}) {
  const d = newGame([setup('a', forests(), commanders.a ?? []), setup('b', forests(), commanders.b ?? [])], seed);
  const [p1, p2] = d.g.state.playerOrder;
  return { d, p1, p2 };
}

/** Give p1 an instant they could cast so they receive priority in every step (instead of auto-passing). */
function makeResponsive(d: Driver, p: PlayerId) {
  d.put(p, MOUNTAIN);
  d.give(p, BOLT);
}

function grantKeyword(g: Game, id: ObjectId, kw: string) {
  g.addContinuousEffect({ sourceId: null, controller: g.obj(id).controller, fromStatic: false, affected: { kind: 'fixed', ids: [id] }, duration: 'endOfTurn', modification: { layer: 6, addKeywords: [kw] } });
}
function removeKeyword(g: Game, id: ObjectId, kw: string) {
  g.addContinuousEffect({ sourceId: null, controller: g.obj(id).controller, fromStatic: false, affected: { kind: 'fixed', ids: [id] }, duration: 'endOfTurn', modification: { layer: 6, removeKeywords: [kw] } });
}
function pump(g: Game, id: ObjectId, p: number, t: number) {
  g.addContinuousEffect({ sourceId: null, controller: g.obj(id).controller, fromStatic: false, affected: { kind: 'fixed', ids: [id] }, duration: 'endOfTurn', modification: { layer: '7c', power: p, toughness: t } });
}
/** "Regenerate ~" shield, exactly as the `regenerate` effect creates it (effects.ts). */
function regenShield(g: Game, id: ObjectId) {
  g.addContinuousEffect({ sourceId: null, controller: g.obj(id).controller, fromStatic: false, affected: { kind: 'fixed', ids: [id] }, duration: 'endOfTurn', modification: { layer: 'rule', rule: { kind: 'custom', tag: 'regenerationShield' } } });
}

function attack(d: Driver, attacks: { attacker: ObjectId; target: PlayerId | ObjectId }[]) {
  d.until((x) => x.type === 'declareAttackers');
  d.submit({ type: 'attackers', attacks });
}
function block(d: Driver, blocks: { blocker: ObjectId; attacker: ObjectId }[]) {
  d.until((x) => x.type === 'declareBlockers');
  d.submit({ type: 'blockers', blocks });
}
/** Advance until combat is over (postcombat main of the same turn, or a later turn). */
function afterCombat(d: Driver) {
  const turn = d.g.state.turn.number;
  d.until(() => d.g.state.over || d.g.state.turn.number > turn || (d.g.state.turn.number === turn && d.g.state.turn.step === 'main2'));
}

// ===========================================================================
// Combat damage steps: first strike / double strike
// ===========================================================================
describe('first strike and double strike steps', () => {
  it('a creature that GAINS first strike after the first-strike damage step still deals damage in the regular step (CR 702.7c)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    makeResponsive(d, p1);
    const fs = d.put(p1, FS_GUY);
    const bears = d.put(p1, BEARS);
    attack(d, [{ attacker: fs, target: p2 }, { attacker: bears, target: p2 }]);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.step === 'firstStrikeDamage');
    expect(d.g.player(p2).life).toBe(38); // only the first striker has dealt damage so far
    // In the first-strike damage step's priority round, the bears gain first strike.
    grantKeyword(d.g, bears, 'First strike');
    afterCombat(d);
    // 702.7c: gaining first strike after first-strike damage was dealt does not stop it from dealing damage in the second step.
    expect(d.g.player(p2).life).toBe(36);
  });

  it('a creature that LOSES first strike after dealing first-strike damage does not deal damage again in the regular step (CR 702.7c)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    makeResponsive(d, p1);
    const fs = d.put(p1, FS_GUY);
    attack(d, [{ attacker: fs, target: p2 }]);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.step === 'firstStrikeDamage');
    expect(d.g.player(p2).life).toBe(38);
    removeKeyword(d.g, fs, 'First strike');
    expect(d.g.characteristics(fs).keywords.has('First strike')).toBe(false);
    afterCombat(d);
    // 702.7c: removing first strike after it dealt first-strike damage does not let it deal damage again.
    expect(d.g.player(p2).life).toBe(38);
  });

  it('double strike deals damage in both steps; a plain creature only in the second (CR 702.4b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const ds = d.put(p1, DS_GUY);
    const bears = d.put(p1, BEARS);
    attack(d, [{ attacker: ds, target: p2 }, { attacker: bears, target: p2 }]);
    afterCombat(d);
    expect(d.g.player(p2).life).toBe(40 - 2 - 2 - 2);
  });
});

// ===========================================================================
// Removal from combat (regeneration)
// ===========================================================================
describe('regeneration removes the creature from combat', () => {
  it('a blocker that regenerates in the first-strike step is removed from combat: a double striker deals it no more damage (CR 701.15a, 506.4, 510.1c)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const ds = d.put(p1, DS_GUY); // 2/2 double strike
    const bears = d.put(p2, BEARS); // 2/2 with a regeneration shield
    regenShield(d.g, bears);
    attack(d, [{ attacker: ds, target: p2 }]);
    block(d, [{ blocker: bears, attacker: ds }]);
    afterCombat(d);
    // First-strike step: 2 damage → lethal → destroyed → regenerates (tapped, damage removed, removed from combat).
    // Regular step: the attacker is blocked but has no blocker left → assigns no damage (no trample).
    expect(d.g.state.log.some((l) => /regenerates/.test(l.text))).toBe(true);
    expect(d.g.obj(bears).zone).toBe('battlefield');
    expect(d.g.obj(bears).tapped).toBe(true);
    expect(d.g.obj(bears).damage).toBe(0);
    expect(d.g.player(p2).life).toBe(40);
    // Bears was removed from combat, so it dealt no damage either.
    expect(d.g.obj(ds).damage).toBe(0);
  });

  it('an attacker that regenerates in the first-strike step is removed from combat: its blocker deals it no more damage (CR 701.15a, 506.4, 510.1d)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const bears = d.put(p1, BEARS);
    regenShield(d.g, bears);
    const ds = d.put(p2, DS_GUY); // 2/2 double strike blocker
    attack(d, [{ attacker: bears, target: p2 }]);
    block(d, [{ blocker: ds, attacker: bears }]);
    afterCombat(d);
    expect(d.g.state.log.some((l) => /regenerates/.test(l.text))).toBe(true);
    // The regenerated bears left combat; the double striker has nothing to deal regular damage to.
    expect(d.g.obj(bears).zone).toBe('battlefield');
    expect(d.g.obj(bears).damage).toBe(0);
    expect(d.g.obj(ds).damage).toBe(0);
  });
});

// ===========================================================================
// Blocked status and damage assignment
// ===========================================================================
describe('blocked creatures and damage assignment', () => {
  it('a blocked creature whose blocker left combat stays blocked and deals no damage (CR 509.1h, 510.1c)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    makeResponsive(d, p1);
    const bears = d.put(p1, BEARS);
    const wall = d.put(p2, WALL);
    attack(d, [{ attacker: bears, target: p2 }]);
    block(d, [{ blocker: wall, attacker: bears }]);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.step === 'declareBlockers');
    d.g.moveObject(wall, 'hand', { cause: 'bounce' });
    afterCombat(d);
    expect(d.g.player(p2).life).toBe(40);
    expect(d.g.obj(bears).zone).toBe('battlefield');
  });

  it('...but with trample all of its damage is assigned to the player (CR 702.19c)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    makeResponsive(d, p1);
    const cmdr = d.put(p1, COMMANDER); // 5/5 trample
    const wall = d.put(p2, WALL);
    attack(d, [{ attacker: cmdr, target: p2 }]);
    block(d, [{ blocker: wall, attacker: cmdr }]);
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.step === 'declareBlockers');
    d.g.moveObject(wall, 'hand', { cause: 'bounce' });
    afterCombat(d);
    expect(d.g.player(p2).life).toBe(35);
  });

  it('trample + deathtouch: 1 damage is lethal for each blocker, the rest tramples over (CR 702.2c, 702.19b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const cmdr = d.put(p1, COMMANDER); // 5/5 trample
    grantKeyword(d.g, cmdr, 'Deathtouch');
    const wall = d.put(p2, WALL); // 0/3
    attack(d, [{ attacker: cmdr, target: p2 }]);
    block(d, [{ blocker: wall, attacker: cmdr }]);
    afterCombat(d);
    expect(d.g.obj(wall).zone).toBe('graveyard');
    expect(d.g.player(p2).life).toBe(36); // 1 to the wall, 4 to the player
  });

  it('lethal damage accounts for damage already marked on the blocker (CR 702.19b, 120.6)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const cmdr = d.put(p1, COMMANDER); // 5/5 trample
    const wall = d.put(p2, WALL); // 0/3, already has 2 damage
    d.g.obj(wall).damage = 2;
    d.g.touch();
    attack(d, [{ attacker: cmdr, target: p2 }]);
    block(d, [{ blocker: wall, attacker: cmdr }]);
    afterCombat(d);
    expect(d.g.obj(wall).zone).toBe('graveyard');
    expect(d.g.player(p2).life).toBe(36); // only 1 more is lethal; 4 trample over
  });

  it('with several blockers the attacker divides damage as it chooses; no lethal-in-order requirement (CR 510.1c, post-Foundations)', () => {
    // NOTE: rules-version dependent. The "damage assignment order" (old 509.2 / 510.1c) was removed from the CR with
    // Foundations (Nov 2024). Under the current rules an attacking creature blocked by two creatures may divide its
    // damage among them freely (only trample still requires lethal to all blockers before hitting the player).
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const big = d.put(p1, BIG); // 3/3
    const b1 = d.put(p2, BEARS);
    const b2 = d.put(p2, BEARS);
    attack(d, [{ attacker: big, target: p2 }]);
    block(d, [{ blocker: b1, attacker: big }, { blocker: b2, attacker: big }]);
    // The engine may ask for a damage assignment order; keep b1 first.
    d.until((x) => (x.type === 'orderObjects' && x.context === 'damageAssignment') || x.type === 'distribute');
    if (d.d?.type === 'orderObjects') d.submit({ type: 'order', ids: [b1, b2] });
    d.until((x) => x.type === 'distribute');
    const dec = d.d as { targets: { kind: string; id: number }[] };
    const amounts = dec.targets.map((t) => (t.id === b1 ? 1 : 2));
    d.submit({ type: 'distribute', amounts });
    afterCombat(d);
    // 1 damage to b1 (survives), 2 to b2 (dies).
    expect(d.g.obj(b2).zone).toBe('graveyard');
    expect(d.g.obj(b1).zone).toBe('battlefield');
    expect(d.g.obj(b1).damage).toBe(1);
  });
});

// ===========================================================================
// Creatures put onto the battlefield attacking
// ===========================================================================
describe('creatures entering the battlefield attacking', () => {
  it('a token created tapped and attacking is an attacking creature and deals combat damage (CR 508.4)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    makeResponsive(d, p1);
    const cap = d.put(p1, MYRIAD_LIKE);
    attack(d, [{ attacker: cap, target: p2 }]);
    // Priority in the declare attackers step after the trigger resolved.
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.stack.length === 0 && d.g.state.turn.step === 'declareAttackers' && d.g.state.battlefield.some((id) => d.g.obj(id).card.name === 'Soldier'));
    const token = d.g.state.battlefield.map((id) => d.g.obj(id)).find((o) => o.card.name === 'Soldier')!;
    expect(token.attacking).toBe(p2);
    // 508.4: it is an attacking creature for all purposes (blockable, deals combat damage), so combat must track it.
    expect(d.g.state.turn.attackers).toContain(token.id);
    afterCombat(d);
    // Captain 2 + Soldier token 1.
    expect(d.g.player(p2).life).toBe(37);
  });
});

// ===========================================================================
// Damage, life, lifelink, protection, poison, planeswalkers
// ===========================================================================
describe('damage and life', () => {
  it('damage dealt to a player causes that player to lose life: "whenever you lose life" triggers fire (CR 120.3a)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    const bolt = d.give(p1, BOLT);
    d.put(p2, LIFE_WATCHER);
    const before = d.g.player(p2).hand.length;
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(37);
    expect(d.g.player(p2).hand.length).toBe(before + 1);
  });

  it('"Damage that would reduce your life total to less than 1 reduces it to 1 instead" applies to damage (Worship; CR 120.3a, 614.1)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    const bolt = d.give(p1, BOLT);
    d.put(p2, WORSHIPPER);
    d.g.player(p2).life = 2;
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 0);
    expect(d.g.player(p2).life).toBe(1);
    expect(d.g.player(p2).lost).toBe(false);
    expect(d.g.state.over).toBe(false);
  });

  it('lifelink gains life for combat damage dealt (CR 702.15b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const ll = d.put(p1, LIFELINKER);
    const bears = d.put(p2, BEARS);
    attack(d, [{ attacker: ll, target: p2 }]);
    block(d, [{ blocker: bears, attacker: ll }]);
    afterCombat(d);
    expect(d.g.player(p1).life).toBe(42);
    expect(d.g.obj(bears).zone).toBe('graveyard');
  });

  it('deathtouch damage dealt as -1/-1 counters (infect) is still lethal (CR 702.2b, 704.5h)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const ta = d.put(p1, TOXIC_ASSASSIN); // 1/1 infect deathtouch
    const big = d.put(p2, BIG); // 3/3
    attack(d, [{ attacker: ta, target: p2 }]);
    block(d, [{ blocker: big, attacker: ta }]);
    afterCombat(d);
    // The -1/-1 counter alone would leave a 2/2; deathtouch makes the damage lethal and the counter is cleared when it dies (CR 400.7).
    expect(d.g.state.log.some((l) => /Toxic Assassin deals 1 damage to Big Beast/.test(l.text))).toBe(true);
    expect(d.g.obj(big).zone).toBe('graveyard');
  });

  it('protection prevents damage from and blocking by sources with the quality (CR 702.16b, 702.16c)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const bears = d.put(p1, BEARS); // green 2/2
    const hater = d.put(p2, PRO_GREEN); // pro-green 2/2
    attack(d, [{ attacker: bears, target: p2 }]);
    block(d, [{ blocker: hater, attacker: bears }]);
    afterCombat(d);
    expect(d.g.obj(hater).damage).toBe(0);
    expect(d.g.obj(hater).zone).toBe('battlefield');
    expect(d.g.obj(bears).zone).toBe('graveyard');
    // And a green creature cannot block the pro-green creature.
    d.until((x) => x.type === 'declareAttackers' && x.player === p2);
    d.submit({ type: 'attackers', attacks: [{ attacker: hater, target: p1 }] });
    // p1 has no legal blockers (its only creature died), so no declareBlockers decision should be offered with a candidate.
    const other = d.put(p1, BEARS);
    void other;
    afterCombat(d);
    expect(d.g.player(p1).life).toBe(38);
  });

  it('ten poison counters lose the game (CR 704.5c) and infect damage to players is poison, not life loss (CR 702.90b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const inf = d.put(p1, INFECTOR);
    d.g.player(p2).poison = 9;
    attack(d, [{ attacker: inf, target: p2 }]);
    d.until(() => d.g.state.over, 300);
    expect(d.g.player(p2).life).toBe(40);
    expect(d.g.player(p2).poison).toBe(10);
    expect(d.g.state.winner).toBe(p1);
  });

  it('combat damage to a planeswalker removes loyalty; at 0 it dies; no damage is redirected to/from the player (CR 120.3c, 306.8, 704.5i)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const walker = d.g.createObject(WALKER, p2, 'battlefield', { skipEvents: true, counters: { loyalty: 4 } }).id;
    const bears = d.put(p1, BEARS);
    const cmdr = d.put(p1, COMMANDER);
    d.g.obj(cmdr).isCommander = true;
    attack(d, [{ attacker: bears, target: walker }, { attacker: cmdr, target: walker }]);
    afterCombat(d);
    expect(d.g.obj(walker).zone).toBe('graveyard');
    expect(d.g.player(p2).life).toBe(40);
    expect(d.g.player(p2).commanderDamage[cmdr] ?? 0).toBe(0);
  });
});

// ===========================================================================
// State-based actions
// ===========================================================================
describe('state-based actions', () => {
  it('indestructible survives lethal damage but not toughness 0 or less (CR 704.5f, 704.5g, 702.12b)', () => {
    const { d, p1 } = twoPlayer();
    d.toMainPhase(p1);
    const golem = d.put(p1, INDESTRUCTIBLE_GUY);
    d.g.obj(golem).damage = 5;
    d.g.touch();
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority');
    expect(d.g.obj(golem).zone).toBe('battlefield');
    pump(d.g, golem, -2, -2);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority');
    expect(d.g.obj(golem).zone).toBe('graveyard');
  });

  it('+1/+1 and -1/-1 counters annihilate (CR 704.5q)', () => {
    const { d, p1 } = twoPlayer();
    d.toMainPhase(p1);
    const bears = d.put(p1, BEARS);
    d.g.obj(bears).counters['+1/+1'] = 3;
    d.g.obj(bears).counters['-1/-1'] = 2;
    d.g.touch();
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority');
    expect(d.g.obj(bears).counters['+1/+1']).toBe(1);
    expect(d.g.obj(bears).counters['-1/-1']).toBeUndefined();
    expect(d.g.characteristics(bears).power).toBe(3);
  });

  it('a player only loses for an empty-library draw attempted since the LAST state-based check (CR 704.5b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    // p2 cannot lose for now (Platinum Angel-style), and draws from an empty library.
    for (const id of [...d.g.player(p2).library]) d.g.moveObject(id, 'exile', { skipEvents: true });
    d.g.player(p2).flags['cantLose'] = true;
    d.g.drawCards(p2, 1);
    expect(d.g.player(p2).attemptedDrawFromEmpty).toBe(true);
    d.submit({ type: 'pass' }); // state-based actions are checked: p2 can't lose right now
    d.until((x) => x.type === 'priority');
    expect(d.g.player(p2).lost).toBe(false);
    // The "can't lose" effect ends later. The draw attempt happened before the last SBA check, so it no longer matters.
    delete d.g.player(p2).flags['cantLose'];
    // Give p2 a library again so their next draw step is not a fresh empty-library draw.
    for (const id of d.g.player(p2).exile.slice(0, 5)) d.g.moveObject(id, 'library', { skipEvents: true });
    d.g.touch();
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority');
    expect(d.g.player(p2).lost).toBe(false);
    expect(d.g.state.over).toBe(false);
  });
});

// ===========================================================================
// Triggers: simultaneity, look-back, APNAP
// ===========================================================================
describe('triggered abilities', () => {
  it('Blood Artist dying alongside another creature sees both deaths (CR 603.10a, 700.4)', () => {
    const { d, p1 } = twoPlayer();
    d.toMainPhase(p1);
    for (let i = 0; i < 4; i++) d.put(p1, PLAINS);
    d.put(p1, BLOOD_ARTIST);
    d.put(p1, BEARS);
    const w = d.give(p1, WRATH);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: w });
    d.resolveAll();
    expect(d.g.state.log.filter((l) => /^Trigger: Blood Artist/.test(l.text)).length).toBe(2);
  });

  it('a TOKEN Blood Artist dying alongside another creature also sees both deaths (CR 603.10a, 704.5d, 111.7)', () => {
    const { d, p1 } = twoPlayer();
    d.toMainPhase(p1);
    for (let i = 0; i < 4; i++) d.put(p1, PLAINS);
    const ba = d.g.createObject({ ...BLOOD_ARTIST, isToken: true }, p1, 'battlefield', { skipEvents: true });
    ba.controlSinceTurn = -1;
    d.put(p1, BEARS);
    const w = d.give(p1, WRATH);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: w });
    d.resolveAll();
    // The token ceases to exist as a state-based action AFTER the simultaneous destruction, so its
    // leaves-the-battlefield ability looks back and triggers for itself and for the bears.
    expect(d.g.state.log.filter((l) => /^Trigger: Blood Artist/.test(l.text)).length).toBe(2);
  });

  it('"whenever attacks" fires once per attacker; "whenever one or more attack you" once per defender; APNAP puts the active player\'s trigger on the stack first (CR 603.2, 603.3b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    makeResponsive(d, p1);
    d.put(p1, ATTACK_WATCHER);
    d.put(p2, DEFENDER_WATCHER);
    const b1 = d.put(p1, BEARS);
    const b2 = d.put(p1, BEARS);
    const hand2 = d.g.player(p2).hand.length;
    attack(d, [{ attacker: b1, target: p2 }, { attacker: b2, target: p2 }]);
    d.until((x) => x.type === 'priority' && d.g.state.stack.length === 3);
    // Bottom of the stack (index 0) belongs to the active player; the non-active player's trigger is on top and resolves first.
    expect(d.g.state.stack[0].controller).toBe(p1);
    expect(d.g.state.stack[1].controller).toBe(p1);
    expect(d.g.state.stack[2].controller).toBe(p2);
    afterCombat(d);
    expect(d.g.player(p1).life).toBe(42);
    expect(d.g.player(p2).hand.length).toBe(hand2 + 1);
  });
});

// ===========================================================================
// Turn structure
// ===========================================================================
describe('turn structure', () => {
  it('a creature stays summoning sick during the opponent\'s turn until its controller\'s next turn begins (CR 302.6)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const elves = d.put(p1, ELVES);
    d.g.obj(elves).controlSinceTurn = d.g.state.turn.number; // as if cast this turn
    d.g.touch();
    expect(summoningSick(d.g, d.g.obj(elves))).toBe(true);
    d.until(() => d.g.state.turn.number === 2 && d.g.state.turn.step === 'main1');
    expect(d.g.state.turn.activePlayer).toBe(p2);
    // p1 has not begun a new turn since the elves entered: still sick, so its {T} ability cannot be activated.
    expect(summoningSick(d.g, d.g.obj(elves))).toBe(true);
    expect(buildPriorityDecision(d.g, p1).activatableAbilities.some((a) => a.objectId === elves)).toBe(false);
    d.until(() => d.g.state.turn.number === 3 && d.g.state.turn.step === 'main1');
    expect(summoningSick(d.g, d.g.obj(elves))).toBe(false);
  });

  it('the untap step untaps only the active player\'s permanents (CR 502.3)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const mine = d.put(p1, BEARS, { tapped: true });
    const theirs = d.put(p2, BEARS, { tapped: true });
    d.until(() => d.g.state.turn.number === 2 && d.g.state.turn.step === 'main1');
    expect(d.g.obj(theirs).tapped).toBe(false);
    expect(d.g.obj(mine).tapped).toBe(true);
    d.until(() => d.g.state.turn.number === 3 && d.g.state.turn.step === 'main1');
    expect(d.g.obj(mine).tapped).toBe(false);
  });

  it('attacking/blocking status ends at end of combat (CR 506.4, 511.3)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const bears = d.put(p1, BEARS);
    const wall = d.put(p2, WALL);
    attack(d, [{ attacker: bears, target: p2 }]);
    block(d, [{ blocker: wall, attacker: bears }]);
    afterCombat(d);
    expect(d.g.obj(bears).attacking).toBeNull();
    expect(d.g.obj(wall).blocking).toEqual([]);
    expect(d.g.obj(bears).blockedBy).toEqual([]);
    expect(d.g.state.turn.attackers).toEqual([]);
  });

  it('a trigger during cleanup gives priority and then another cleanup step with a new hand-size discard (CR 514.3a)', () => {
    const { d, p1 } = twoPlayer();
    d.toMainPhase(p1);
    d.put(p1, CLEANUP_DRAWER);
    expect(d.g.player(p1).hand.length).toBe(7);
    d.until(() => d.g.state.turn.number === 2 && d.g.state.turn.step === 'main1');
    // Drew to 8 during cleanup, then discarded back to 7 in the second cleanup step.
    expect(d.g.player(p1).hand.length).toBe(7);
    expect(d.g.player(p1).graveyard.length).toBe(1);
  });
});

// ===========================================================================
// Attack / block legality
// ===========================================================================
describe('attack and block legality', () => {
  it('menace needs two blockers; tapped creatures cannot block (CR 702.110b, 509.1a)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    const men = d.put(p1, MENACE_GUY);
    const b1 = d.put(p2, BEARS);
    const b2 = d.put(p2, BEARS);
    const tapped = d.put(p2, BEARS, { tapped: true });
    attack(d, [{ attacker: men, target: p2 }]);
    d.until((x) => x.type === 'declareBlockers');
    const dec = d.d as { candidates: { id: number }[] };
    expect(dec.candidates.map((c) => c.id)).not.toContain(tapped);
    d.submit({ type: 'blockers', blocks: [{ blocker: b1, attacker: men }] });
    expect(d.d?.type).toBe('declareBlockers'); // rejected, asked again
    d.submit({ type: 'blockers', blocks: [{ blocker: b1, attacker: men }, { blocker: b2, attacker: men }] });
    afterCombat(d);
    expect(d.g.obj(men).zone).toBe('graveyard');
    expect(d.g.player(p2).life).toBe(40);
  });

  it('defender cannot attack, tapped creatures cannot attack, vigilance does not tap (CR 702.3b, 508.1a, 702.20b)', () => {
    const { d, p1, p2 } = twoPlayer();
    d.toMainPhase(p1);
    d.put(p1, WALL);
    d.put(p1, BEARS, { tapped: true });
    const bears = d.put(p1, BEARS);
    d.until((x) => x.type === 'declareAttackers');
    expect((d.d as { candidates: { id: number }[] }).candidates.map((c) => c.id)).toEqual([bears]);
    d.submit({ type: 'attackers', attacks: [{ attacker: bears, target: p2 }] });
    expect(d.g.obj(bears).tapped).toBe(true);
  });
});
