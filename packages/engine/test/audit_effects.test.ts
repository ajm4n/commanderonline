/**
 * Rules audit: effects.ts / characteristics.ts / filters.ts / tokens.ts / replacement & prevention handling.
 *
 * Every test asserts the behaviour the Comprehensive Rules require and cites the rule. A failing test is a confirmed
 * engine bug; passing tests document verified-correct areas. Nothing under src/ is modified.
 */
import { describe, it, expect } from 'vitest';
import { E, R, T, type Target, type ObjectId, type PlayerId } from '../src/index.js';
import { attach } from '../src/effects.js';
import { newGame, deck, setup, card, FOREST, MOUNTAIN, PLAINS, BEARS, BOLT, SERRA, ANTHEM, BLOOD_ARTIST, UPKEEP_GUY, GIANT_GROWTH, WRATH, SCRIPTS, type Driver } from './helpers.js';

// ---------------------------------------------------------------------------
// Test cards. All spells cost {G} so one Forest pays for each.
// ---------------------------------------------------------------------------
const G = (name: string, text: string) => card({ name, typeLine: 'Instant', manaCost: '{G}', cmc: 1, oracleText: text, colors: ['G'], colorIdentity: ['G'] });

const SHIELD_2 = G('Shield Two', 'Prevent the next 2 damage that would be dealt to target creature this turn.');
const SHIELD_YOU_3 = G('Shield You Three', 'Prevent the next 3 damage that would be dealt to you this turn.');
const FOG_SHIELD_2 = G('Fog Shield Two', 'Prevent the next 2 damage that would be dealt to target creature this turn.');
const HUMBLE = G('Humble', 'Target creature loses all abilities.');
const HUMBLE_EOT = G('Humble Briefly', 'Target creature loses all abilities until end of turn.');
const WINGS = G('Wings', 'Target creature gains flying until end of turn.');
const CLONE_TOKEN = G('Clone Token', "Create a token that's a copy of target creature.");
const BECOME_11 = G('Become One', 'Target creature has base power and toughness 1/1 until end of turn.');
const THREATEN = G('Threaten', 'Gain control of target creature until end of turn.');
const SAC_EACH = G('Sac Each', 'Each player sacrifices a creature.');
const DOOM = G('Doom', 'Destroy target creature.');
const DOOM_NR = G('Doom Final', "Destroy target creature. It can't be regenerated.");
const REGEN = G('Regen', 'Regenerate target creature.');
const FLICKER = G('Flicker', 'Exile target creature, then return it to the battlefield under its owner\'s control.');
const PLUS_COUNTER = G('Plus Counter', 'Put a +1/+1 counter on target creature.');
const MINUS_COUNTER = G('Minus Counter', 'Put a -1/-1 counter on target creature.');
const MAKE_BEAR = G('Make Bear', 'Create a 2/2 green Bear creature token.');
const LIFELINK_GRANT = G('Lifelink Grant', 'Target creature gains lifelink until end of turn.');
const BITE_PLAYER = G('Bite Player', 'Target creature deals damage equal to its power to target player.');
const MIMIC = G('Mimic', 'Target creature becomes a copy of another target creature.');
const FOG_YOU = G('Fog You', 'Prevent all damage that would be dealt to you this turn.');
const DRAIN_YOU = G('Drain You', 'You lose 3 life.');
const SACRIFICE_ONE = G('Sacrifice One', 'Sacrifice target creature.');

const BIG_BEAR = card({ name: 'Big Bear', typeLine: 'Creature — Bear', manaCost: '{3}{G}{G}', cmc: 5, power: '5', toughness: '5', colors: ['G'], colorIdentity: ['G'] });
const BULKY_BEAR = card({ name: 'Bulky Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Bulky Bear gets +2/+2.', colors: ['G'], colorIdentity: ['G'] });
const GOYF = card({ name: 'Goyf', typeLine: 'Creature — Lhurgoyf', manaCost: '{1}{G}', cmc: 2, power: '*', toughness: '1+*', oracleText: "Goyf's power and toughness are each equal to the number of creatures you control.", colors: ['G'], colorIdentity: ['G'] });
const LIFE_GOYF = card({ name: 'Life Goyf', typeLine: 'Creature — Avatar', manaCost: '{1}{G}', cmc: 2, power: '*', toughness: '1+*', oracleText: "Life Goyf's power and toughness are each equal to your life total.", colors: ['G'], colorIdentity: ['G'] });
const INDESTRUCTIBLE_BEAR = card({ name: 'Iron Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Indestructible', keywords: ['Indestructible'], colors: ['G'], colorIdentity: ['G'] });
const LIFELINK_BEAR = card({ name: 'Lifelink Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Lifelink', keywords: ['Lifelink'], colors: ['G'], colorIdentity: ['G'] });
const WINGS_AURA = card({ name: 'Wings Aura', typeLine: 'Enchantment — Aura', manaCost: '{G}', cmc: 1, oracleText: 'Enchant creature\nEnchanted creature has flying.', colors: ['G'], colorIdentity: ['G'] });
const REST_IN_PEACE = card({ name: 'Rest in Pieces', typeLine: 'Enchantment', manaCost: '{1}{W}', cmc: 2, oracleText: 'If a creature would die, exile it instead.', colors: ['W'], colorIdentity: ['W'] });
const COUNTER_BEAR = card({ name: 'Counter Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Counter Bear enters with two +1/+1 counters on it.\nWhen Counter Bear enters, you gain life equal to its power.', colors: ['G'], colorIdentity: ['G'] });
const OTHER_ANTHEM = card({ name: 'Other Anthem', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Other creatures you control get +1/+1.', colors: ['G'], colorIdentity: ['G'] });

Object.assign(SCRIPTS, {
  'Shield Two': { name: 'Shield Two', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'preventDamage', amount: 2, to: R.target(), duration: 'endOfTurn' }] }] },
  'Shield You Three': { name: 'Shield You Three', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [{ kind: 'preventDamage', amount: 3, to: R.controller, duration: 'endOfTurn' }] }] },
  'Fog Shield Two': { name: 'Fog Shield Two', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'preventAll', amount: 2, to: 'creatures', toRef: R.target() }] }] },
  Humble: { name: 'Humble', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'loseAllAbilities', on: R.target(), duration: 'permanent' }] }] },
  'Humble Briefly': { name: 'Humble Briefly', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'loseAllAbilities', on: R.target(), duration: 'endOfTurn' }] }] },
  Wings: { name: 'Wings', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.keywords(['Flying'], R.target())] }] },
  'Clone Token': { name: 'Clone Token', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.token({ name: 'Copy', typeLine: 'Creature', colors: [], copyOf: R.target() })] }] },
  'Become One': { name: 'Become One', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'setPT', power: 1, toughness: 1, on: R.target(), duration: 'endOfTurn' }] }] },
  Threaten: { name: 'Threaten', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'gainControl', what: R.target(), duration: 'endOfTurn' }] }] },
  'Sac Each': { name: 'Sac Each', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [{ kind: 'sacrificeChoice', who: R.eachPlayer, filter: { types: ['Creature'] }, count: 1 }] }] },
  Doom: { name: 'Doom', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.destroy(R.target())] }] },
  'Doom Final': { name: 'Doom Final', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'destroy', what: R.target(), cantRegenerate: true }] }] },
  Regen: { name: 'Regen', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'regenerate', what: R.target() }] }] },
  Flicker: { name: 'Flicker', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.exile(R.target()), { kind: 'returnToBattlefield', what: { ref: 'lastMoved' }, controller: 'owner' }] }] },
  'Plus Counter': { name: 'Plus Counter', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.counters('+1/+1', 1, R.target())] }] },
  'Minus Counter': { name: 'Minus Counter', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.counters('-1/-1', 1, R.target())] }] },
  'Make Bear': { name: 'Make Bear', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [E.token({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2', colors: ['G'] })] }] },
  'Lifelink Grant': { name: 'Lifelink Grant', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.keywords(['Lifelink'], R.target())] }] },
  'Bite Player': { name: 'Bite Player', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature(), T.player()], effects: [{ kind: 'dealsDamageEqualToPower', source: R.target(0), to: R.target(1) }] }] },
  Mimic: { name: 'Mimic', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature(), T.creature('another target creature')], effects: [{ kind: 'becomeCopy', what: R.target(0), of: R.target(1) }] }] },
  'Fog You': { name: 'Fog You', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [{ kind: 'preventAll', to: 'you' }] }] },
  'Drain You': { name: 'Drain You', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [E.loseLife(3)] }] },
  'Sacrifice One': { name: 'Sacrifice One', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.sacrifice(R.target())] }] },
  'Bulky Bear': { name: 'Bulky Bear', coverage: 'full', origin: 'hand', abilities: [{ kind: 'static', text: 'Bulky Bear gets +2/+2.', affects: 'self', modification: { layer: '7c', power: 2, toughness: 2 } }] },
  'Wings Aura': { name: 'Wings Aura', coverage: 'full', origin: 'hand', abilities: [{ kind: 'static', text: 'Enchanted creature has flying.', affects: 'attachedTo', modification: { layer: 6, addKeywords: ['Flying'] } }] },
  'Rest in Pieces': { name: 'Rest in Pieces', coverage: 'full', origin: 'hand', abilities: [{ kind: 'replacement', text: 'If a creature would die, exile it instead.', event: 'dies', self: false, filter: { types: ['Creature'] }, instead: 'exile' }] },
  'Counter Bear': {
    name: 'Counter Bear',
    coverage: 'full',
    origin: 'hand',
    abilities: [
      { kind: 'replacement', text: 'Counter Bear enters with two +1/+1 counters on it.', event: 'entersBattlefield', self: true, counters: { counter: '+1/+1', amount: 2 } },
      { kind: 'triggered', text: 'When Counter Bear enters, you gain life equal to its power.', event: 'entersBattlefield', filter: { self: true }, effects: [E.gainLife({ kind: 'power', ref: R.self })] },
    ],
  },
  'Other Anthem': { name: 'Other Anthem', coverage: 'full', origin: 'hand', abilities: [{ kind: 'static', text: 'Other creatures you control get +1/+1.', affects: { types: ['Creature'], controller: 'you', other: true }, modification: { layer: '7c', power: 1, toughness: 1 } }] },
} satisfies typeof SCRIPTS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const forests = () => deck([FOREST], 40);
function start(): { d: Driver; p1: PlayerId; p2: PlayerId } {
  const d = newGame([setup('a', forests()), setup('b', forests())]);
  const [p1, p2] = d.g.state.playerOrder;
  d.toMainPhase(p1);
  return { d, p1, p2 };
}
const obj = (id: ObjectId): Target => ({ kind: 'object', id });
const player = (id: PlayerId): Target => ({ kind: 'player', id });
/** Give `p` the spell plus a land to pay for it, cast it, answer its target slots, and let it resolve. */
function cast(d: Driver, p: PlayerId, spell: ReturnType<typeof card>, targets: Target[] = [], land = FOREST) {
  d.put(p, land);
  const id = d.give(p, spell);
  d.until((x) => x.type === 'priority' && x.player === p);
  d.submit({ type: 'cast', objectId: id });
  // With a single legal target the engine picks it automatically and the spell resolves at once.
  if (targets.length && d.d?.type === 'chooseTargets') d.submit({ type: 'targets', targets: targets.map((t) => [t]) });
  d.resolveAll();
}
const bolt = (d: Driver, p: PlayerId, t: Target) => cast(d, p, BOLT, [t], MOUNTAIN);
const triggerCount = (d: Driver, name: string) => d.g.state.log.filter((l) => new RegExp(`^Trigger: .*${name}`).test(l.text)).length;

// ---------------------------------------------------------------------------
// Prevention shields (CR 615.7, 616.1)
// ---------------------------------------------------------------------------
describe('damage prevention shields', () => {
  it('BUG: "prevent the next N damage" shield is used up by the first damage event (CR 615.7)', () => {
    const { d, p1, p2 } = start();
    const bear = d.put(p2, BIG_BEAR); // 5/5
    cast(d, p1, SHIELD_2, [obj(bear)]);
    bolt(d, p1, obj(bear)); // 3 damage, 2 prevented → 1 marked
    expect(d.g.obj(bear).damage).toBe(1);
    bolt(d, p1, obj(bear)); // shield is gone: all 3 are dealt → 4 marked
    // CR 615.7: a shield that prevents "the next N damage" is reduced by the amount it prevents and ends once used up.
    expect(d.g.obj(bear).damage).toBe(4);
  });

  it('BUG: two "prevent the next 2 damage" shields on the same creature both apply to one damage event (CR 616.1)', () => {
    const { d, p1, p2 } = start();
    const bear = d.put(p2, BIG_BEAR);
    cast(d, p1, FOG_SHIELD_2, [obj(bear)]);
    cast(d, p1, FOG_SHIELD_2, [obj(bear)]);
    expect(d.g.state.preventions.length).toBe(2);
    bolt(d, p1, obj(bear));
    // CR 616.1: every applicable prevention effect gets a chance to apply (order chosen by the affected player); 2 + 1 of the 3 are prevented.
    expect(d.g.obj(bear).damage).toBe(0);
    // One shield is fully consumed, the other has 1 left.
    expect(d.g.state.preventions.map((p) => p.amount).sort()).toEqual([1]);
  });

  it('BUG: "prevent the next 3 damage that would be dealt to you" does nothing (player shields are stored in an unread flag)', () => {
    const { d, p1 } = start();
    cast(d, p1, SHIELD_YOU_3);
    bolt(d, p1, player(p1));
    // CR 615.7: the shield prevents the next 3 damage dealt to that player this turn.
    expect(d.g.player(p1).life).toBe(40);
  });

  it('prevention does not stop life loss (CR 615.10 / 120.3)', () => {
    const { d, p1 } = start();
    cast(d, p1, FOG_YOU);
    cast(d, p1, DRAIN_YOU);
    expect(d.g.player(p1).life).toBe(37);
    bolt(d, p1, player(p1)); // but damage is prevented
    expect(d.g.player(p1).life).toBe(37);
  });
});

// ---------------------------------------------------------------------------
// Losing all abilities (CR 613.1f, 604.2, 613.5, 107.3)
// ---------------------------------------------------------------------------
describe('loses all abilities', () => {
  it('BUG: a permanent that has lost all abilities still fires its triggered abilities', () => {
    const { d, p1 } = start();
    const guy = d.put(p1, UPKEEP_GUY);
    cast(d, p1, HUMBLE, [obj(guy)]);
    expect(d.g.characteristics(guy).lostAllAbilities).toBe(true);
    d.until(() => d.g.state.turn.number === 3 && d.g.state.turn.step === 'main1');
    // CR 613.1f: after layer 6 the object has no triggered abilities, so "at the beginning of your upkeep" never triggers.
    expect(d.g.player(p1).life).toBe(40);
  });

  it("BUG: a creature's own P/T-boosting static ability keeps applying after it loses all abilities (CR 613.1f / 613.6)", () => {
    const { d, p1 } = start();
    const bulky = d.put(p1, BULKY_BEAR); // 2/2 with "gets +2/+2"
    expect(d.g.characteristics(bulky).power).toBe(4);
    cast(d, p1, HUMBLE, [obj(bulky)]);
    // The layer-7c effect comes from an ability removed in layer 6, so it is not applied: 2/2.
    expect(d.g.characteristics(bulky).power).toBe(2);
    expect(d.g.characteristics(bulky).toughness).toBe(2);
  });

  it('BUG: a "*" characteristic-defining ability still sets P/T after the creature loses all abilities (CR 107.3, 604.3; Dress Down ruling)', () => {
    const { d, p1 } = start();
    const goyf = d.put(p1, LIFE_GOYF); // life 40 → 40/41
    expect(d.g.characteristics(goyf).power).toBe(40);
    expect(d.g.characteristics(goyf).toughness).toBe(41);
    cast(d, p1, HUMBLE, [obj(goyf)]);
    // Without its CDA, "*" is 0: 0/1.
    expect(d.g.characteristics(goyf).power).toBe(0);
    expect(d.g.characteristics(goyf).toughness).toBe(1);
  });

  it('BUG: CDA "equal to the number of creatures you control" evaluates to 0 (game.ts evaluateStarPT greedy regex)', () => {
    const { d, p1 } = start();
    d.put(p1, BEARS);
    d.put(p1, BEARS);
    const goyf = d.put(p1, GOYF); // 3 creatures → 3/4 (CR 604.3)
    expect(d.g.characteristics(goyf).power).toBe(3);
    expect(d.g.characteristics(goyf).toughness).toBe(4);
  });

  it('BUG: stale characteristics cache — a creature keeps a bonus from an ability-less source until the next state change', () => {
    const { d, p1 } = start();
    const anthem = d.put(p1, OTHER_ANTHEM);
    const bear = d.put(p1, BEARS);
    expect(d.g.characteristics(bear).power).toBe(3);
    expect(d.g.characteristics(anthem).power).toBe(2); // "other" excludes itself (filters.ts)
    cast(d, p1, HUMBLE, [obj(anthem)]);
    expect(d.g.characteristics(anthem).lostAllAbilities).toBe(true);
    // CR 613.8 / 613.1f: the source has no static ability any more, so the bear is 2/2 right away. The engine returns 3 here
    // because the bear's characteristics were cached while the anthem was mid-computation (re-entrancy fallback treats the
    // anthem as still having abilities); `touch()` below shows the correct value appears only after the cache is invalidated.
    const seen = d.g.characteristics(bear).power;
    d.g.touch();
    expect(d.g.characteristics(bear).power).toBe(2);
    expect(seen).toBe(2);
  });

  it('layer 6 timestamps: gain flying then lose all abilities → no flying; the reverse order keeps flying (CR 613.7)', () => {
    const { d, p1 } = start();
    const a = d.put(p1, BEARS);
    const b = d.put(p1, BEARS);
    cast(d, p1, WINGS, [obj(a)]);
    cast(d, p1, HUMBLE_EOT, [obj(a)]);
    expect(d.g.characteristics(a).keywords.has('Flying')).toBe(false);
    cast(d, p1, HUMBLE_EOT, [obj(b)]);
    cast(d, p1, WINGS, [obj(b)]);
    expect(d.g.characteristics(b).keywords.has('Flying')).toBe(true);
  });

  it('BUG: an Aura does not get a new timestamp when it becomes attached (CR 613.7e)', () => {
    const { d, p1 } = start();
    const a = d.put(p1, BEARS);
    const b = d.put(p1, BEARS);
    const aura = d.put(p1, WINGS_AURA);
    attach(d.g, aura, b);
    expect(d.g.characteristics(b).keywords.has('Flying')).toBe(true);
    cast(d, p1, HUMBLE_EOT, [obj(a)]); // later timestamp than the Aura's arrival
    attach(d.g, aura, a); // CR 613.7e: the Aura's effect now has a timestamp later than the ability-loss effect
    d.g.touch();
    expect(d.g.characteristics(a).keywords.has('Flying')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Copy effects (CR 707.2)
// ---------------------------------------------------------------------------
describe('copy effects', () => {
  it('BUG: a token copy inherits keywords granted to the original by other effects (CR 707.2: copiable values only)', () => {
    const { d, p1 } = start();
    const bear = d.put(p1, BEARS);
    cast(d, p1, WINGS, [obj(bear)]);
    expect(d.g.characteristics(bear).keywords.has('Flying')).toBe(true);
    cast(d, p1, CLONE_TOKEN, [obj(bear)]);
    const token = d.g.state.battlefield.map((id) => d.g.obj(id)).find((o) => o.card.isToken)!;
    expect(token).toBeDefined();
    expect(d.g.characteristics(token.id).name).toBe('Grizzly Bears');
    expect(d.g.characteristics(token.id).keywords.has('Flying')).toBe(false);
  });

  it('BUG: copying a face-down creature copies the hidden card instead of a nameless 2/2 (CR 707.2, 708.2)', () => {
    const { d, p1, p2 } = start();
    const serra = d.put(p2, SERRA);
    d.g.obj(serra).faceDown = true;
    d.g.touch();
    expect(d.g.characteristics(serra).power).toBe(2);
    cast(d, p1, CLONE_TOKEN, [obj(serra)]);
    const token = d.g.state.battlefield.map((id) => d.g.obj(id)).find((o) => o.card.isToken)!;
    const ch = d.g.characteristics(token.id);
    // The copiable values of a face-down permanent are those of the face-down state: no name, 2/2, no abilities.
    expect(ch.name).toBe('');
    expect(ch.power).toBe(2);
    expect(ch.keywords.has('Flying')).toBe(false);
  });

  it('"becomes a copy" copies copiable values (including other copy effects) but not counters (CR 707.2)', () => {
    const { d, p1 } = start();
    const serra = d.put(p1, SERRA);
    const bear1 = d.put(p1, BEARS);
    const bear2 = d.put(p1, BEARS);
    cast(d, p1, PLUS_COUNTER, [obj(serra)]);
    expect(d.g.characteristics(serra).power).toBe(5);
    cast(d, p1, MIMIC, [obj(bear1), obj(serra)]);
    expect(d.g.characteristics(bear1).name).toBe('Serra Angel');
    expect(d.g.characteristics(bear1).power).toBe(4); // counters are not copiable
    expect(d.g.characteristics(bear1).keywords.has('Flying')).toBe(true);
    cast(d, p1, MIMIC, [obj(bear2), obj(bear1)]);
    expect(d.g.characteristics(bear2).name).toBe('Serra Angel'); // copy of a copy
  });
});

// ---------------------------------------------------------------------------
// Layer 7 ordering (CR 613.4)
// ---------------------------------------------------------------------------
describe('power/toughness layers', () => {
  it('set P/T (7b) applies before an earlier Anthem (7c): 1/1 base + 1 = 2/2', () => {
    const { d, p1 } = start();
    d.put(p1, ANTHEM);
    const bear = d.put(p1, BEARS);
    expect(d.g.characteristics(bear).power).toBe(3);
    cast(d, p1, BECOME_11, [obj(bear)]);
    expect(d.g.characteristics(bear).power).toBe(2);
    expect(d.g.characteristics(bear).toughness).toBe(2);
  });

  it('counters are applied after set P/T (7c after 7b)', () => {
    const { d, p1 } = start();
    const bear = d.put(p1, BEARS);
    cast(d, p1, PLUS_COUNTER, [obj(bear)]);
    cast(d, p1, BECOME_11, [obj(bear)]);
    expect(d.g.characteristics(bear).power).toBe(2);
  });

  it('+1/+1 and -1/-1 counters annihilate as a state-based action (CR 704.5q)', () => {
    const { d, p1 } = start();
    const bear = d.put(p1, BEARS);
    cast(d, p1, PLUS_COUNTER, [obj(bear)]);
    cast(d, p1, MINUS_COUNTER, [obj(bear)]);
    expect(d.g.obj(bear).counters['+1/+1']).toBeUndefined();
    expect(d.g.obj(bear).counters['-1/-1']).toBeUndefined();
    expect(d.g.characteristics(bear).power).toBe(2);
  });

  it('"until end of turn" effects last through the end step and end at cleanup (CR 514.2)', () => {
    const { d, p1 } = start();
    const bear = d.put(p1, BEARS);
    d.put(p1, MOUNTAIN);
    d.give(p1, BOLT); // gives p1 something to do so they receive priority in the end step
    cast(d, p1, GIANT_GROWTH, [obj(bear)]);
    d.until(() => d.g.state.turn.step === 'end');
    expect(d.g.characteristics(bear).power).toBe(5);
    d.until(() => d.g.state.turn.number === 2);
    expect(d.g.characteristics(bear).power).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Control change (CR 613.2, 302.6)
// ---------------------------------------------------------------------------
describe('control change', () => {
  it('"gain control until end of turn": the creature is summoning sick and control reverts at cleanup', () => {
    const { d, p1, p2 } = start();
    const bear = d.put(p2, BEARS);
    cast(d, p1, THREATEN, [obj(bear)]);
    expect(d.g.obj(bear).controller).toBe(p1);
    expect(d.g.obj(bear).controlSinceTurn).toBe(d.g.state.turn.number); // CR 302.6: control since start of turn required to attack
    d.until(() => d.g.state.turn.number === 2);
    expect(d.g.obj(bear).controller).toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// Zone changes, new objects, tokens (CR 400.7, 704.5d, 704.5m, 111.7)
// ---------------------------------------------------------------------------
describe('zone changes and new objects', () => {
  it('exile-and-return: counters and pump are gone, the Aura falls off, and it is a new summoning-sick object (CR 400.7)', () => {
    const { d, p1 } = start();
    const bear = d.put(p1, BEARS);
    const aura = d.put(p1, WINGS_AURA);
    attach(d.g, aura, bear);
    cast(d, p1, PLUS_COUNTER, [obj(bear)]);
    cast(d, p1, GIANT_GROWTH, [obj(bear)]);
    expect(d.g.characteristics(bear).power).toBe(6);
    cast(d, p1, FLICKER, [obj(bear)]);
    expect(d.g.obj(bear).zone).toBe('battlefield');
    expect(d.g.obj(bear).counters).toEqual({});
    expect(d.g.characteristics(bear).power).toBe(2);
    expect(d.g.characteristics(bear).keywords.has('Flying')).toBe(false);
    expect(d.g.obj(aura).zone).toBe('graveyard'); // CR 704.5m
    expect(d.g.obj(bear).controlSinceTurn).toBe(d.g.state.turn.number);
  });

  it('a token that dies triggers "dies" abilities, then ceases to exist (CR 111.7, 704.5d)', () => {
    const { d, p1, p2 } = start();
    d.put(p1, BLOOD_ARTIST);
    cast(d, p1, MAKE_BEAR);
    const token = d.g.state.battlefield.map((id) => d.g.obj(id)).find((o) => o.card.isToken)!;
    d.put(p1, FOREST);
    const doom = d.give(p1, DOOM);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: doom });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[obj(token.id)]] });
    d.until((x) => x.type === 'chooseTargets' && x.player === p1); // Blood Artist trigger
    d.submit({ type: 'targets', targets: [[player(p2)]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(39);
    expect(d.g.state.objects[token.id]).toBeUndefined();
  });

  it('"if a creature would die, exile it instead": no dies trigger fires (CR 614.1a, 700.4)', () => {
    const { d, p1, p2 } = start();
    d.put(p1, REST_IN_PEACE);
    d.put(p1, BLOOD_ARTIST);
    const bear = d.put(p2, BEARS);
    cast(d, p1, DOOM, [obj(bear)]);
    expect(d.g.obj(bear).zone).toBe('exile');
    expect(triggerCount(d, 'Blood Artist')).toBe(0);
    expect(d.g.player(p2).life).toBe(40);
  });

  it('indestructible stops destroy but not sacrifice (CR 702.12b)', () => {
    const { d, p1 } = start();
    const iron = d.put(p1, INDESTRUCTIBLE_BEAR);
    cast(d, p1, DOOM, [obj(iron)]);
    expect(d.g.obj(iron).zone).toBe('battlefield');
    cast(d, p1, SACRIFICE_ONE, [obj(iron)]);
    expect(d.g.obj(iron).zone).toBe('graveyard');
  });

  it('a regeneration shield is consumed once and is ignored by "can\'t be regenerated" (CR 701.15)', () => {
    const { d, p1 } = start();
    const bear = d.put(p1, BEARS);
    cast(d, p1, REGEN, [obj(bear)]);
    cast(d, p1, DOOM, [obj(bear)]);
    expect(d.g.obj(bear).zone).toBe('battlefield');
    expect(d.g.obj(bear).tapped).toBe(true);
    cast(d, p1, DOOM, [obj(bear)]);
    expect(d.g.obj(bear).zone).toBe('graveyard');
    const bear2 = d.put(p1, BEARS);
    cast(d, p1, REGEN, [obj(bear2)]);
    cast(d, p1, DOOM_NR, [obj(bear2)]);
    expect(d.g.obj(bear2).zone).toBe('graveyard');
  });

  it('"enters with counters" is applied before the ETB trigger sees the object (CR 614.1c)', () => {
    const { d, p1 } = start();
    d.put(p1, FOREST);
    d.put(p1, FOREST);
    const cb = d.give(p1, COUNTER_BEAR);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: cb });
    d.resolveAll();
    expect(d.g.obj(cb).counters['+1/+1']).toBe(2);
    expect(d.g.player(p1).life).toBe(44);
  });
});

// ---------------------------------------------------------------------------
// Simultaneity of "each player" effects (CR 608.2c, 101.4, 700.4)
// ---------------------------------------------------------------------------
describe('each-player effects', () => {
  it('control: creatures destroyed by one effect leave together and each sees the other die (CR 700.4)', () => {
    const { d, p1, p2 } = start();
    d.put(p1, BLOOD_ARTIST);
    d.put(p2, BEARS);
    for (let i = 0; i < 3; i++) d.put(p1, PLAINS);
    cast(d, p1, WRATH, [], PLAINS);
    expect(triggerCount(d, 'Blood Artist')).toBe(2);
  });

  it('BUG: "each player sacrifices a creature" sacrifices one at a time, so a dying Blood Artist misses the other death (CR 101.4, 700.4)', () => {
    const { d, p1, p2 } = start();
    d.put(p1, BLOOD_ARTIST); // p1's only creature
    d.put(p2, BEARS); // p2's only creature
    cast(d, p1, SAC_EACH);
    // CR 101.4: each player chooses in APNAP order, then the sacrifices happen simultaneously; Blood Artist sees both deaths (CR 700.4, 603.10a).
    expect(triggerCount(d, 'Blood Artist')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Keyword deduplication (CR 702.1c / 702.15)
// ---------------------------------------------------------------------------
describe('keywords', () => {
  it('two instances of lifelink gain life once', () => {
    const { d, p1, p2 } = start();
    const ll = d.put(p1, LIFELINK_BEAR);
    cast(d, p1, LIFELINK_GRANT, [obj(ll)]);
    cast(d, p1, BITE_PLAYER, [obj(ll), player(p2)]);
    expect(d.g.player(p2).life).toBe(38);
    expect(d.g.player(p1).life).toBe(42);
  });
});
