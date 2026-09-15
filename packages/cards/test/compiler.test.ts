import { describe, it, expect } from 'vitest';
import { loadFixtureDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
import { scriptFor } from '../src/index.js';
import type { CardData, TriggeredAbilitySpec, SpellAbilitySpec, ActivatedAbilitySpec, StaticAbilitySpec } from '@commander/engine';

const db = loadFixtureDb();
const card = (name: string): CardData => {
  const c = db.byName(name);
  if (!c) throw new Error(`fixture missing ${name}`);
  return c;
};
const spell = (name: string) => compileCard(card(name)).script.abilities.find((a) => a.kind === 'spell') as SpellAbilitySpec;
const triggers = (name: string) => compileCard(card(name)).script.abilities.filter((a) => a.kind === 'triggered') as TriggeredAbilitySpec[];
const activated = (name: string) => compileCard(card(name)).script.abilities.filter((a) => a.kind === 'activated') as ActivatedAbilitySpec[];
const statics = (name: string) => compileCard(card(name)).script.abilities.filter((a) => a.kind === 'static') as StaticAbilitySpec[];

describe('compiler: spells', () => {
  it('Lightning Bolt: 3 damage to any target', () => {
    const s = spell('Lightning Bolt');
    expect(s.targets?.[0].kind).toBe('any');
    expect(s.effects).toEqual([{ kind: 'damage', amount: 3, to: { ref: 'target', slot: 0 }, source: undefined, divided: false }]);
    expect(compileCard(card('Lightning Bolt')).script.coverage).toBe('full');
  });
  it('Counterspell', () => {
    const s = spell('Counterspell');
    expect(s.targets?.[0].kind).toBe('spell');
    expect(s.effects[0].kind).toBe('counterSpell');
  });
  it('Swords to Plowshares: exile + controller gains life equal to power', () => {
    const s = spell('Swords to Plowshares');
    expect(s.effects[0].kind).toBe('exile');
    expect(s.effects[1]).toMatchObject({ kind: 'gainLife', who: { ref: 'controllerOf' } });
    expect(compileCard(card('Swords to Plowshares')).script.coverage).toBe('full');
  });
  it('Rampant Growth: search for a basic land onto the battlefield tapped', () => {
    const s = spell('Rampant Growth');
    expect(s.effects[0]).toMatchObject({ kind: 'searchLibrary', destination: 'battlefield', tapped: true, count: 1 });
    expect((s.effects[0] as { filter: { supertypes: string[] } }).filter.supertypes).toEqual(['Basic']);
  });
  it('Divination and Wrath of God', () => {
    expect(spell('Divination').effects).toEqual([{ kind: 'draw', amount: 2, who: { ref: 'controller' } }]);
    expect(spell('Wrath of God').effects[0]).toMatchObject({ kind: 'destroy', what: { ref: 'all' } });
  });
  it('Giant Growth pumps until end of turn', () => {
    expect(spell('Giant Growth').effects[0]).toMatchObject({ kind: 'pump', power: 3, toughness: 3, duration: 'endOfTurn' });
  });
  it('Blasphemous Act: damage to each creature', () => {
    expect(spell('Blasphemous Act').effects[0]).toMatchObject({ kind: 'damage', amount: 13, to: { ref: 'all' } });
  });
});

describe('compiler: triggers', () => {
  it('Elvish Visionary style ETB (Mulldrifter)', () => {
    const t = triggers('Mulldrifter');
    expect(t[0]).toMatchObject({ event: 'entersBattlefield', filter: { self: true } });
    expect(t[0].effects).toEqual([{ kind: 'draw', amount: 2, who: { ref: 'controller' } }]);
  });
  it('Blood Artist: dies trigger with target player', () => {
    const t = triggers('Blood Artist')[0];
    expect(t.event).toBe('dies');
    expect(t.targets?.[0].kind).toBe('player');
    expect(t.effects[0]).toMatchObject({ kind: 'loseLife', amount: 1, who: { ref: 'target', slot: 0 } });
    expect(t.effects[1]).toMatchObject({ kind: 'gainLife', amount: 1 });
  });
  it('Zulaport Cutthroat: each opponent loses life', () => {
    const t = triggers('Zulaport Cutthroat')[0];
    expect(t.event).toBe('dies');
    expect(t.effects).toEqual([{ kind: 'loseLife', amount: 1, who: { ref: 'eachOpponent' } }, { kind: 'gainLife', amount: 1, who: { ref: 'controller' } }]);
  });
  it('Rhystic Study: opponent casts → draw unless they pay {1}', () => {
    const t = triggers('Rhystic Study')[0];
    expect(t.event).toBe('cast');
    expect(t.filter?.player).toBe('opponent');
    expect(t.optional).toBe(true); // "you may" → asked on resolution
    expect(t.effects[0]).toMatchObject({ kind: 'unlessPays', cost: '{1}', who: { ref: 'triggerPlayer' } });
    expect((t.effects[0] as { effects: unknown[] }).effects[0]).toMatchObject({ kind: 'draw', amount: 1 });
  });
  it('Sun Titan: ETB and attacks share the effect', () => {
    const t = triggers('Sun Titan');
    expect(t.length).toBe(2);
    expect(t.map((x) => x.event).sort()).toEqual(['attacks', 'entersBattlefield']);
  });
  it('Krenko: activated token creation scaled by Goblins', () => {
    const a = activated('Krenko, Mob Boss')[0];
    expect(a.cost.tap).toBe(true);
    expect(a.effects[0]).toMatchObject({ kind: 'createToken', count: { kind: 'count' } });
  });
  it('Landfall (Omnath, Locus of Rage)', () => {
    const t = triggers('Omnath, Locus of Rage');
    expect(t[0]).toMatchObject({ event: 'entersBattlefield', filter: { object: { types: ['Land'] }, objectController: 'you' } });
    expect(t[0].effects[0]).toMatchObject({ kind: 'createToken', count: 1 });
  });
});

describe('compiler: statics, mana and keywords', () => {
  it('Sol Ring is a mana ability', () => {
    const a = activated('Sol Ring')[0];
    expect(a.manaAbility).toBe(true);
    expect(a.effects).toEqual([{ kind: 'addMana', mana: ['C', 'C'] }]);
  });
  it('Command Tower adds commander colors', () => {
    const a = activated('Command Tower')[0];
    expect(a.manaAbility).toBe(true);
    expect(a.effects[0]).toMatchObject({ kind: 'addMana', mana: 'commanderColors' });
  });
  it('Elesh Norn: anthem + opponents malus', () => {
    const s = statics('Elesh Norn, Grand Cenobite');
    expect(s.some((x) => x.modification && x.modification.layer === '7c' && x.modification.power === 2)).toBe(true);
    expect(s.some((x) => x.modification && x.modification.layer === '7c' && x.modification.power === -2)).toBe(true);
  });
  it('Serra Angel is keywords-only and fully covered', () => {
    const r = compileCard(card('Serra Angel'));
    expect(r.script.coverage).toBe('full');
    expect(r.script.abilities.length).toBe(0);
  });
  it('multi-face cards compile every face', () => {
    const s = scriptFor(card('Bonecrusher Giant // Stomp'));
    expect(s.faces?.length).toBe(1);
    expect(s.faces?.[0].abilities.some((a) => a.kind === 'spell')).toBe(true);
  });
  it('reports coverage honestly for cards with unhandled text', () => {
    const all = db.all().map((c) => compileCard(c));
    const full = all.filter((r) => r.script.coverage === 'full').length;
    expect(full / all.length).toBeGreaterThan(0.5);
    for (const r of all) if (r.script.coverage === 'full') expect(r.unhandledLines).toEqual([]);
  });
});
