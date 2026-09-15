import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMoxfieldJson } from '../src/index.js';

const v3 = JSON.parse(readFileSync(new URL('./fixtures/moxfield-v3.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(readFileSync(new URL('./fixtures/moxfield-legacy.json', import.meta.url), 'utf8'));

describe('parseMoxfieldJson', () => {
  it('parses the v3 boards shape', () => {
    const deck = parseMoxfieldJson(v3);
    expect(deck.source).toBe('moxfield');
    expect(deck.name).toBe('Atraxa Superfriends');
    expect(deck.url).toBe('https://www.moxfield.com/decks/aB3dE9fGh1');
    expect(deck.commanders).toEqual([
      { name: "Atraxa, Praetors' Voice", quantity: 1, set: 'cmm', collectorNumber: '342', isCommander: true },
    ]);
    expect(deck.mainboard.map((e) => e.name)).toEqual(['Sol Ring', 'Arcane Signet', 'Command Tower', 'Forest', 'Bonecrusher Giant // Stomp']);
    expect(deck.mainboard.find((e) => e.name === 'Forest')?.quantity).toBe(2);
    expect(deck.mainboard[0]).toMatchObject({ set: 'c21', collectorNumber: '263' });
    expect(deck.sideboard).toEqual([{ name: 'Mulldrifter', quantity: 1, set: 'lrw', collectorNumber: '76' }]);
    // Maybeboard is not imported.
    expect([...deck.mainboard, ...deck.sideboard].some((e) => e.name === 'Opt')).toBe(false);
    expect(deck.warnings).toEqual([]);
  });

  it('parses the legacy top-level board shape (name-keyed maps)', () => {
    const deck = parseMoxfieldJson(legacy);
    expect(deck.name).toBe('Krenko Goblins');
    expect(deck.commanders).toEqual([{ name: 'Krenko, Mob Boss', quantity: 1, set: 'm13', collectorNumber: '137', isCommander: true }]);
    expect(deck.mainboard).toHaveLength(3);
    expect(deck.mainboard.find((e) => e.name === 'Mountain')?.quantity).toBe(30);
    expect(deck.sideboard).toEqual([]);
    expect(deck.mainboard.some((e) => e.name === 'Lightning Bolt')).toBe(false);
  });

  it('falls back to the map key for a legacy record with no card name', () => {
    const deck = parseMoxfieldJson({ name: 'x', commanders: {}, mainboard: { 'Sol Ring': { quantity: 2 } } });
    expect(deck.mainboard).toEqual([{ name: 'Sol Ring', quantity: 2 }]);
  });

  it('reports non-object input and missing commanders as warnings rather than throwing', () => {
    expect(parseMoxfieldJson(null).warnings.length).toBeGreaterThan(0);
    expect(parseMoxfieldJson('nope').warnings.length).toBeGreaterThan(0);
    const noCmdr = parseMoxfieldJson({ name: 'd', boards: { mainboard: { count: 1, cards: { a: { quantity: 1, card: { name: 'Sol Ring' } } } } } });
    expect(noCmdr.mainboard).toHaveLength(1);
    expect(noCmdr.warnings.some((w) => /no commander/i.test(w))).toBe(true);
  });
});
