/**
 * Rules audit: casting, mana payment, resolution, targeting, priority.
 *
 * Every test asserts the behaviour the Comprehensive Rules require and cites the rule.
 * Tests whose `it` title starts with "[BUG]" are EXPECTED TO FAIL against the current engine
 * (they document confirmed deviations). The others verify correct behaviour.
 */
import { describe, it, expect } from 'vitest';
import { newGame, deck, setup, card, SCRIPTS, FOREST, MOUNTAIN, ISLAND, PLAINS, BEARS, BOLT, SOL_RING, ELVES, COUNTERSPELL, COMMANDER, GIANT_GROWTH, CONTROL_MAGIC, BLOOD_ARTIST } from './helpers.js';
import { E, R, T, adjustSymbols, parseManaCost, formatCost, manaSourcesFor } from '../src/index.js';

const forests = () => deck([FOREST], 40);
type Prio = { playableCards: number[]; activatableAbilities: { objectId: number; abilityIndex: number; text: string }[]; alternativeCosts: { objectId: number; id: string }[] };

// ---------------------------------------------------------------------------
// Test cards + scripts
// ---------------------------------------------------------------------------

const FLASHBACK_BOLT = card({ name: 'Flashback Bolt', typeLine: 'Instant', manaCost: '{2}{R}{R}', cmc: 4, oracleText: 'Flashback Bolt deals 3 damage to any target.\nFlashback {R}', keywords: ['Flashback'], colors: ['R'], colorIdentity: ['R'] });
SCRIPTS['Flashback Bolt'] = { name: 'Flashback Bolt', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.any()], effects: [E.damage(3, R.target())] }] };

const BOUNCE = card({ name: 'Unsummon', typeLine: 'Instant', manaCost: '{U}', cmc: 1, oracleText: "Return target creature to its owner's hand.", colors: ['U'], colorIdentity: ['U'] });
SCRIPTS['Unsummon'] = { name: 'Unsummon', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [E.bounce(R.target())] }] };

const PHYREXIAN_BEAR = card({ name: 'Phyrexian Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G/P}', cmc: 2, power: '2', toughness: '2', oracleText: '({G/P} can be paid with either {G} or 2 life.)', colors: ['G'], colorIdentity: ['G'] });
SCRIPTS['Phyrexian Bear'] = { name: 'Phyrexian Bear', coverage: 'full', origin: 'hand', abilities: [] };

const TWOBRID = card({ name: 'Twobrid Knight', typeLine: 'Creature — Knight', manaCost: '{2/W}', cmc: 2, power: '2', toughness: '2', oracleText: '({2/W} can be paid with either {W} or two mana of any type.)', colors: ['W'], colorIdentity: ['W'] });
SCRIPTS['Twobrid Knight'] = { name: 'Twobrid Knight', coverage: 'full', origin: 'hand', abilities: [] };

const MY_PUMP = card({ name: 'Loyal Growth', typeLine: 'Instant', manaCost: '{G}', cmc: 1, oracleText: 'Target creature you control gets +3/+3 until end of turn.', colors: ['G'], colorIdentity: ['G'] });
SCRIPTS['Loyal Growth'] = { name: 'Loyal Growth', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature('target creature you control', { controller: 'you' })], effects: [E.pump(3, 3, R.target())] }] };

const STEAL = card({ name: 'Snatch', typeLine: 'Instant', manaCost: '{U}{U}', cmc: 2, oracleText: 'Gain control of target creature.', colors: ['U'], colorIdentity: ['U'] });
SCRIPTS['Snatch'] = { name: 'Snatch', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.creature()], effects: [{ kind: 'gainControl', what: R.target() }] }] };

const SAC_SPELL = card({ name: 'Costly Insight', typeLine: 'Sorcery', manaCost: '{1}{G}', cmc: 2, oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw a card.', colors: ['G'], colorIdentity: ['G'] });
SCRIPTS['Costly Insight'] = { name: 'Costly Insight', coverage: 'full', origin: 'hand', additionalCost: { sacrifice: { filter: { types: ['Creature'], zone: 'battlefield' }, count: 1 } }, abilities: [{ kind: 'spell', effects: [E.draw(1)] }] };

const WARDED = card({ name: 'Warded Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Ward {2}', keywords: ['Ward'], colors: ['G'], colorIdentity: ['G'] });
SCRIPTS['Warded Bear'] = { name: 'Warded Bear', coverage: 'full', origin: 'hand', abilities: [] };

const HEXPROOF_BEAR = card({ name: 'Hexproof Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'Hexproof', keywords: ['Hexproof'], colors: ['G'], colorIdentity: ['G'] });

const FORK = card({ name: 'Fork', typeLine: 'Instant', manaCost: '{R}{R}', cmc: 2, oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.', colors: ['R'], colorIdentity: ['R'] });
SCRIPTS['Fork'] = { name: 'Fork', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.spell('target instant or sorcery spell', { types: ['Instant'] })], effects: [{ kind: 'copySpell', what: R.target() }] }] };

const CAST_WATCHER = card({ name: 'Cast Watcher', typeLine: 'Creature — Spirit', manaCost: '{1}{W}', cmc: 2, power: '1', toughness: '1', oracleText: 'Whenever you cast an instant spell, you gain 1 life.', colors: ['W'], colorIdentity: ['W'] });
SCRIPTS['Cast Watcher'] = { name: 'Cast Watcher', coverage: 'full', origin: 'hand', abilities: [{ kind: 'triggered', text: 'Whenever you cast an instant spell, you gain 1 life.', event: 'cast', filter: { player: 'you', object: { types: ['Instant'] } }, effects: [E.gainLife(1)] }] };

const FIREBALL = card({ name: 'Fireball', typeLine: 'Sorcery', manaCost: '{X}{R}', cmc: 1, oracleText: 'Fireball deals X damage to any target.', colors: ['R'], colorIdentity: ['R'] });
SCRIPTS['Fireball'] = { name: 'Fireball', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', targets: [T.any()], effects: [E.damage('X', R.target())] }] };

const CHEAP_BEAR = card({ name: 'Cheap Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', oracleText: 'This spell costs {2} less to cast for each artifact you control.', colors: ['G'], colorIdentity: ['G'] });
SCRIPTS['Cheap Bear'] = { name: 'Cheap Bear', coverage: 'full', origin: 'hand', abilities: [], costModifiers: [{ amount: 2, direction: 'less', per: { types: ['Artifact'], controller: 'you', zone: 'battlefield' } }] };

const tappedCount = (d: ReturnType<typeof newGame>, p: string) => d.g.state.battlefield.filter((id) => d.g.obj(id).controller === p && d.g.obj(id).tapped).length;

// ---------------------------------------------------------------------------
// Commander-specific
// ---------------------------------------------------------------------------

describe('commander casting (CR 903)', () => {
  it('[BUG] commander tax is actually paid when casting from the command zone (CR 903.8)', () => {
    const d = newGame([setup('a', forests(), [COMMANDER]), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 5; i++) d.put(p1, FOREST);
    const cmdr = d.g.player(p1).command[0];
    // Simulate one previous cast from the command zone: tax is now {2}.
    d.g.obj(cmdr).commanderCasts = 1;
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(cmdr); // {2}{G} + {2} tax = 5 mana, 5 Forests: castable
    d.submit({ type: 'cast', objectId: cmdr });
    d.resolveAll();
    expect(d.g.obj(cmdr).zone).toBe('battlefield');
    // CR 903.8: total cost is {2}{G} plus {2} for the previous cast → all 5 Forests must be tapped.
    // Engine: computeCastCost checks `obj.zone === 'command'` AFTER the card was moved to the stack, so no tax is charged (3 tapped).
    expect(tappedCount(d, p1)).toBe(5);
  });

  it('a commander that dies triggers "dies" abilities before its owner may move it to the command zone (CR 903.9a)', () => {
    const d = newGame([setup('a', forests(), [COMMANDER]), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 3; i++) d.put(p1, FOREST);
    d.put(p2, MOUNTAIN);
    d.put(p1, BLOOD_ARTIST);
    const cmdr = d.g.player(p1).command[0];
    const bolt = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: cmdr });
    d.resolveAll();
    d.g.obj(cmdr).damage = 3;
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: cmdr }]] });
    d.until((x) => x.type === 'chooseTargets' && x.player === p1); // Blood Artist trigger
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.obj(cmdr).zone).toBe('command');
    expect(d.g.player(p2).life).toBe(39);
    expect(d.g.player(p1).life).toBe(41);
  });

  it('[BUG] commander returned to hand may be put into the command zone instead (CR 903.9b)', () => {
    const d = newGame([setup('a', forests(), [COMMANDER]), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 3; i++) d.put(p1, FOREST);
    d.put(p2, ISLAND);
    const cmdr = d.g.player(p1).command[0];
    const bounce = d.give(p2, BOUNCE);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: cmdr });
    d.resolveAll();
    expect(d.g.obj(cmdr).zone).toBe('battlefield');
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: bounce });
    if (d.d?.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[{ kind: 'object', id: cmdr }]] });
    // The Driver answers every yes/no with "yes", so if the owner is offered the command zone the commander ends up there.
    d.resolveAll();
    // CR 903.9b: if a commander would be put into its owner's hand or library, its owner may put it into the command zone instead.
    // Engine: only graveyard/exile are handled (SBA 903.9a); a bounced commander silently stays in hand.
    expect(d.g.obj(cmdr).zone).toBe('command');
  });
});

// ---------------------------------------------------------------------------
// Flashback / casting from graveyard
// ---------------------------------------------------------------------------

describe('flashback (CR 702.34)', () => {
  function flashbackGame() {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    return { d, p1, p2 };
  }

  it('[BUG] a flashback spell is castable from the graveyard for its flashback cost (CR 702.34a)', () => {
    const { d, p1 } = flashbackGame();
    d.put(p1, MOUNTAIN); // one red source: enough for Flashback {R}, not for {2}{R}{R}
    const fb = d.g.createObject(FLASHBACK_BOLT, p1, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    // Engine: canCastNow prices the graveyard card at its printed mana cost, so it is not offered.
    expect((d.d as Prio).playableCards).toContain(fb);
  });

  it('[BUG] paying for a flashback cast charges the flashback cost, and the card is exiled on resolution (CR 702.34a)', () => {
    const { d, p1, p2 } = flashbackGame();
    for (let i = 0; i < 4; i++) d.put(p1, MOUNTAIN);
    const fb = d.g.createObject(FLASHBACK_BOLT, p1, 'graveyard', { skipEvents: true }).id;
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(fb);
    d.submit({ type: 'cast', objectId: fb });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(37);
    expect(d.g.obj(fb).zone).toBe('exile'); // exiled instead of going anywhere else
    // Engine: computeCastCost's `obj.zone === 'graveyard'` check runs after the card moved to the stack → full {2}{R}{R} charged.
    expect(tappedCount(d, p1)).toBe(1);
  });

  it('[BUG] a countered flashback spell is exiled, not put into the graveyard (CR 702.34a)', () => {
    const { d, p1, p2 } = flashbackGame();
    for (let i = 0; i < 4; i++) d.put(p1, MOUNTAIN);
    d.put(p2, ISLAND);
    d.put(p2, ISLAND);
    const fb = d.g.createObject(FLASHBACK_BOLT, p1, 'graveyard', { skipEvents: true }).id;
    const cs = d.give(p2, COUNTERSPELL);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: fb });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: cs });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(40);
    // 702.34a: "If the flashback cost is paid, ... exile it instead of putting it anywhere else any time it would leave the stack."
    expect(d.g.obj(fb).zone).toBe('exile');
  });

  it('[BUG] a flashback spell whose target became illegal is exiled, not put into the graveyard (CR 702.34a, 608.2b)', () => {
    const { d, p1, p2 } = flashbackGame();
    for (let i = 0; i < 4; i++) d.put(p1, MOUNTAIN);
    d.put(p2, MOUNTAIN);
    const bears = d.put(p2, BEARS);
    const fb = d.g.createObject(FLASHBACK_BOLT, p1, 'graveyard', { skipEvents: true }).id;
    const bolt = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: fb });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] }); // p2 kills its own Bears in response
    d.resolveAll();
    expect(d.g.obj(bears).zone).toBe('graveyard');
    expect(d.g.state.log.some((l) => /fizzles/.test(l.text))).toBe(true);
    expect(d.g.obj(fb).zone).toBe('exile');
  });
});

// ---------------------------------------------------------------------------
// Mana symbols and payment
// ---------------------------------------------------------------------------

describe('mana symbols and payment', () => {
  it('[BUG] a Phyrexian mana symbol can be paid with 2 life when no matching mana is available (CR 107.4f)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.put(p1, MOUNTAIN); // no green at all
    const bear = d.give(p1, PHYREXIAN_BEAR); // {1}{G/P}
    d.until((x) => x.type === 'priority' && x.player === p1);
    // Engine: canCastNow solves the payment without the life option and reports the spell as uncastable.
    expect((d.d as Prio).playableCards).toContain(bear);
  });

  it('[BUG] 2 life for a Phyrexian symbol can be paid at exactly 2 life (CR 119.4)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.g.player(p1).life = 2;
    const bear = d.give(p1, PHYREXIAN_BEAR);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bear });
    d.until((x) => x.type === 'priority' || d.g.state.over, 50);
    // 119.4: a player may pay life only if their life total is greater than or equal to the amount → 2 life at 2 life is legal.
    // Engine: payCost requires `life > 2 * k` (strict), so the cast is rejected and life stays at 2.
    expect(d.g.player(p1).life).toBe(0);
  });

  it('[BUG] a mono-hybrid symbol {2/W} can be paid with two generic mana (CR 107.4e)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    d.put(p1, FOREST);
    const knight = d.give(p1, TWOBRID); // {2/W}
    d.until((x) => x.type === 'priority' && x.player === p1);
    // Engine: expandRequirements records `monoHybridGeneric: 2` but solvePayment never uses it, so only {W} can pay.
    expect((d.d as Prio).playableCards).toContain(knight);
  });

  it('a mono-hybrid symbol {2/W} can still be paid with {W}', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, PLAINS);
    const knight = d.give(p1, TWOBRID);
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(knight);
  });

  it('[BUG] a colored cost reduction with no matching symbol reduces generic mana instead (CR 118.7d, 118.7e)', () => {
    // 118.7d: "If a cost is reduced by an amount of colored mana, but the cost doesn't contain mana of that color, the cost is reduced by that much generic mana."
    expect(formatCost(adjustSymbols(parseManaCost('{2}{W}'), '{B}', -1))).toBe('{1}{W}');
    // 118.7e: colored reduction exceeding the colored component spills into generic.
    expect(formatCost(adjustSymbols(parseManaCost('{1}{W}'), '{W}{W}', -1))).toBe('');
  });

  it('cost reductions only reduce generic mana and never below {0} (CR 601.2f)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, SOL_RING);
    d.put(p1, SOL_RING); // two artifacts → "{4} less"; {1}{G} → {G}, colorless mana can't pay it
    const bear = d.give(p1, CHEAP_BEAR);
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).not.toContain(bear);
    d.put(p1, FOREST);
    d.g.refreshDecision();
    expect((d.d as Prio).playableCards).toContain(bear);
    d.submit({ type: 'cast', objectId: bear });
    d.resolveAll();
    expect(d.g.obj(bear).zone).toBe('battlefield');
    expect(tappedCount(d, p1)).toBe(1); // only the Forest
  });

  it('X spells: X is chosen on casting, paid for, and used on resolution; X may be 0 (CR 601.2b, 107.3)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 3; i++) d.put(p1, MOUNTAIN);
    const fb = d.give(p1, FIREBALL);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: fb, xValue: 2 });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(38);
    expect(tappedCount(d, p1)).toBe(3);
    // X = 0 on a fresh board
    const d2 = newGame([setup('a', forests()), setup('b', forests())]);
    const [q1, q2] = d2.g.state.playerOrder;
    d2.toMainPhase(q1);
    d2.put(q1, MOUNTAIN);
    const fb2 = d2.give(q1, FIREBALL);
    d2.until((x) => x.type === 'priority' && x.player === q1);
    d2.submit({ type: 'cast', objectId: fb2, xValue: 0 });
    d2.until((x) => x.type === 'chooseTargets');
    d2.submit({ type: 'targets', targets: [[{ kind: 'player', id: q2 }]] });
    d2.resolveAll();
    expect(d2.g.player(q2).life).toBe(40);
    expect(d2.g.obj(fb2).zone).toBe('graveyard');
  });

  it('mana abilities do not use the stack and the pool empties between steps (CR 605.3a, 500.4)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())], 42, { autoPassWhenNothingToDo: false });
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    const forest = d.put(p1, FOREST);
    d.until((x) => x.type === 'priority' && x.player === p1);
    const ab = (d.d as Prio).activatableAbilities.find((a) => a.objectId === forest);
    expect(ab).toBeDefined();
    d.submit({ type: 'activate', objectId: forest, abilityIndex: ab!.abilityIndex });
    expect(d.g.state.stack.length).toBe(0);
    expect(d.g.player(p1).manaPool.G).toBe(1);
    expect(d.d?.type).toBe('priority');
    expect(d.d?.player).toBe(p1);
    d.toStep(p1, 'beginCombat');
    expect(d.g.player(p1).manaPool.G).toBe(0);
  });

  it('a creature that came under your control this turn cannot use its {T} mana ability; a noncreature artifact can (CR 302.6)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())], 42, { autoPassWhenNothingToDo: false });
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const elves = d.give(p1, ELVES);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: elves });
    d.resolveAll();
    expect(d.g.obj(elves).zone).toBe('battlefield');
    const ring = d.g.createObject(SOL_RING, p1, 'battlefield', { skipEvents: true }).id; // entered this turn
    d.g.refreshDecision();
    d.until((x) => x.type === 'priority' && x.player === p1);
    const abilities = (d.d as Prio).activatableAbilities;
    expect(abilities.some((a) => a.objectId === elves)).toBe(false);
    expect(abilities.some((a) => a.objectId === ring)).toBe(true);
    const srcIds = manaSourcesFor(d.g, p1).map((s) => s.id);
    expect(srcIds).not.toContain(elves);
    expect(srcIds).toContain(ring);
  });

  it('[BUG] a cast that cannot be paid for is fully reversed, including additional costs already paid (CR 601.2h, 730.1)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    const elves = d.put(p1, ELVES); // the only creature AND the second mana source
    const spell = d.give(p1, SAC_SPELL); // {1}{G}, additional cost: sacrifice a creature
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(spell); // Forest + Elves look like enough mana
    d.submit({ type: 'cast', objectId: spell });
    d.until((x) => x.type === 'priority' && x.player === p1);
    // Sacrificing the Elves as the additional cost removed the mana needed for {1}{G}. The game must be
    // reversed to before the spell was cast: the Elves must be back on the battlefield.
    // Engine: payAbilityCost sacrifices the Elves, payCost then fails, revert() only puts the card back in hand.
    expect(d.g.obj(spell).zone).toBe('hand');
    expect(d.g.obj(elves).zone).toBe('battlefield');
  });
});

// ---------------------------------------------------------------------------
// Targeting and resolution
// ---------------------------------------------------------------------------

describe('targets and resolution', () => {
  it('[BUG] a target that no longer meets the targeting requirement is illegal on resolution (CR 608.2b)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, FOREST);
    d.put(p2, ISLAND);
    d.put(p2, ISLAND);
    const bears = d.put(p1, BEARS);
    const pump = d.give(p1, MY_PUMP); // "target creature you control gets +3/+3"
    const steal = d.give(p2, STEAL); // "gain control of target creature"
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: pump });
    if (d.d?.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.until((x) => x.type === 'priority' && x.player === p2);
    expect(d.g.state.stack.length).toBe(1);
    d.submit({ type: 'cast', objectId: steal });
    if (d.d?.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.resolveAll();
    expect(d.g.obj(bears).controller).toBe(p2);
    // Bears is no longer "a creature you control" for p1 → Loyal Growth's only target is illegal → it doesn't resolve.
    // Engine: targetsStillLegal only re-checks hexproof/shroud/protection and zone change, not the target's filter.
    expect(d.g.characteristics(bears).power).toBe(2);
    expect(d.g.state.log.some((l) => /fizzles/.test(l.text))).toBe(true);
  });

  it('an Aura spell whose target is gone does not resolve and goes to the graveyard (CR 608.2b, 303.4)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 4; i++) d.put(p1, ISLAND);
    d.put(p2, MOUNTAIN);
    const bears = d.put(p2, BEARS);
    const cm = d.give(p1, CONTROL_MAGIC);
    const bolt = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: cm });
    if (d.d?.type === 'chooseTargets') d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.until((x) => x.type === 'priority' && x.player === p2);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: bears }]] });
    d.resolveAll();
    expect(d.g.obj(bears).zone).toBe('graveyard');
    expect(d.g.obj(cm).zone).toBe('graveyard');
    expect(d.g.obj(cm).attachedTo).toBeNull();
  });

  it('a spell cannot target itself; Counterspell with an empty stack is not castable (CR 115.5, 601.2c)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())], 42, { autoPassWhenNothingToDo: false });
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.put(p2, ISLAND);
    d.put(p2, ISLAND);
    const bolt = d.give(p1, BOLT);
    const cs = d.give(p2, COUNTERSPELL);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    expect((d.d as Prio).playableCards).not.toContain(cs); // nothing to target
    d.submit({ type: 'pass' });
    // step ended; go to p1's main2 and cast Bolt, then p2 counters it
    d.until((x) => x.type === 'priority' && x.player === p1 && d.g.state.turn.step === 'main2');
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    const boltItem = d.g.state.stack[0].id;
    d.submit({ type: 'cast', objectId: cs });
    // Only Bolt is a legal target (the Counterspell itself is excluded), so targets are chosen automatically.
    const top = d.g.state.stack[d.g.state.stack.length - 1];
    expect(top.sourceId).toBe(cs);
    expect(top.targets).toEqual([{ kind: 'stackItem', id: boltItem }]);
  });

  it('hexproof: an opponent cannot target the creature, its controller can (CR 702.11)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.put(p1, FOREST);
    const hb = d.put(p2, HEXPROOF_BEAR);
    const mine = d.put(p1, HEXPROOF_BEAR);
    const bolt = d.give(p1, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    const legal = (d.d as { slots: { legal: { kind: string; id: unknown }[] }[] }).slots[0].legal;
    expect(legal.some((t) => t.kind === 'object' && t.id === hb)).toBe(false);
    expect(legal.some((t) => t.kind === 'object' && t.id === mine)).toBe(true);
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
  });

  it('[BUG] ward: a spell targeting a warded permanent is countered unless its controller pays the ward cost (CR 702.21a)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())]);
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN); // exactly enough for Bolt, nothing left for Ward {2}
    const warded = d.put(p2, WARDED);
    const bolt = d.give(p1, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'object', id: warded }]] });
    d.resolveAll();
    // Ward is listed in ENFORCED_KEYWORDS and `wardCost` is parsed, but nothing ever triggers on `becomesTarget`.
    expect(d.g.obj(warded).zone).toBe('battlefield');
    expect(d.g.obj(bolt).zone).toBe('graveyard');
  });

  it('a copy of a spell is not cast: no cast triggers, no storm count, and it may get new targets (CR 707.10, 707.12)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())], 42, { autoPassWhenNothingToDo: false });
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    for (let i = 0; i < 3; i++) d.put(p1, MOUNTAIN);
    d.put(p1, CAST_WATCHER);
    const bolt = d.give(p1, BOLT);
    const fork = d.give(p1, FORK);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.until((x) => x.type === 'priority' && x.player === p1); // caster keeps priority (117.3c); watcher trigger is on the stack
    d.submit({ type: 'cast', objectId: fork });
    // Fork's target (Bolt) is forced. Resolve: watcher trigger → Fork → copy asks for new targets.
    d.until((x) => x.type === 'chooseTargets' && /copy/i.test(x.prompt));
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.resolveAll();
    expect(d.g.player(p2).life).toBe(34); // Bolt + copy
    expect(d.g.player(p1).life).toBe(42); // two casts (Bolt, Fork), the copy is not cast
    expect(d.g.player(p1).spellsCastThisTurn).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Timing and priority
// ---------------------------------------------------------------------------

describe('timing and priority', () => {
  it('sorcery-speed spells need own main phase and an empty stack; instants only need priority (CR 307.1, 302.1, 304.1)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())], 42, { autoPassWhenNothingToDo: false });
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.put(p1, FOREST);
    d.put(p1, FOREST);
    d.put(p2, FOREST);
    d.put(p2, FOREST);
    d.put(p2, BEARS); // a creature for Giant Growth to target
    const bolt = d.give(p1, BOLT);
    const myBears = d.give(p1, BEARS);
    const theirBears = d.give(p2, BEARS);
    const gg = d.give(p2, GIANT_GROWTH);
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).toContain(myBears);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    d.until((x) => x.type === 'priority' && x.player === p1);
    expect((d.d as Prio).playableCards).not.toContain(myBears); // stack not empty
    d.submit({ type: 'pass' });
    d.until((x) => x.type === 'priority' && x.player === p2);
    const prio = d.d as Prio;
    expect(prio.playableCards).not.toContain(theirBears); // not p2's turn
    expect(prio.playableCards).toContain(gg); // instant
  });

  it('after casting a spell its controller receives priority; after resolution the active player does (CR 117.3b, 117.3c)', () => {
    const d = newGame([setup('a', forests()), setup('b', forests())], 42, { autoPassWhenNothingToDo: false });
    const [p1, p2] = d.g.state.playerOrder;
    d.toMainPhase(p1);
    d.put(p1, MOUNTAIN);
    d.put(p2, MOUNTAIN);
    const bolt = d.give(p1, BOLT);
    const bolt2 = d.give(p2, BOLT);
    d.until((x) => x.type === 'priority' && x.player === p1);
    d.submit({ type: 'cast', objectId: bolt });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p2 }]] });
    expect(d.d?.type).toBe('priority');
    expect(d.d?.player).toBe(p1); // 117.3c
    expect(d.g.state.stack.length).toBe(1);
    d.submit({ type: 'pass' });
    expect(d.d?.player).toBe(p2);
    d.submit({ type: 'cast', objectId: bolt2 });
    d.until((x) => x.type === 'chooseTargets');
    d.submit({ type: 'targets', targets: [[{ kind: 'player', id: p1 }]] });
    expect(d.d?.player).toBe(p2); // 117.3c again
    d.submit({ type: 'pass' });
    expect(d.d?.player).toBe(p1);
    d.submit({ type: 'pass' }); // both passed in succession → top resolves
    expect(d.g.state.stack.length).toBe(1);
    expect(d.g.player(p1).life).toBe(37);
    expect(d.d?.player).toBe(p1); // 117.3b: active player gets priority after resolution
    expect(d.g.state.turn.step).toBe('main1');
  });
});

// ---------------------------------------------------------------------------
// Rebound (CR 702.88)
// ---------------------------------------------------------------------------

const REBOUND_DRAW = card({ name: 'Rebound Draw', typeLine: 'Sorcery', manaCost: '{U}', cmc: 1, oracleText: 'Draw a card.\nRebound', keywords: ['Rebound'], colors: ['U'], colorIdentity: ['U'] });
SCRIPTS['Rebound Draw'] = { name: 'Rebound Draw', coverage: 'full', origin: 'hand', abilities: [{ kind: 'spell', effects: [E.draw(1)] }] };

describe('rebound (CR 702.88)', () => {
  it('a rebound spell cast from hand is exiled as it resolves and may be cast free at the next upkeep', () => {
    const d = newGame([setup('A', deck([ISLAND], 40)), setup('B', deck([FOREST], 40))]);
    d.toMainPhase('A');
    d.put('A', ISLAND);
    d.give('A', REBOUND_DRAW);
    const handBefore = d.g.player('A').hand.length;
    d.cast('A', 'Rebound Draw');
    d.resolveAll();
    expect(d.g.player('A').hand.length).toBe(handBefore); // cast one, drew one
    expect(d.g.player('A').exile.map((id) => d.g.obj(id).card.name)).toContain('Rebound Draw');
    expect(d.g.player('A').graveyard.map((id) => d.g.obj(id).card.name)).not.toContain('Rebound Draw');
    // B's turn passes with nothing happening.
    d.toMainPhase('B');
    expect(d.g.player('A').exile.map((id) => d.g.obj(id).card.name)).toContain('Rebound Draw');
    const afterCleanup = d.g.player('A').hand.length; // A discarded to seven at cleanup
    // A's next upkeep: the delayed trigger offers the free cast (default answer: yes).
    d.toMainPhase('A');
    expect(d.g.player('A').exile.map((id) => d.g.obj(id).card.name)).not.toContain('Rebound Draw');
    expect(d.g.player('A').graveyard.map((id) => d.g.obj(id).card.name)).toContain('Rebound Draw'); // second resolution: graveyard, not exile
    expect(d.g.player('A').hand.length).toBe(afterCleanup + 2); // draw step + rebound draw
    expect(d.g.state.delayedTriggers.filter((t) => /Rebound/.test(t.text))).toHaveLength(0);
  });
});
