import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArchidektJson } from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/archidekt.json', import.meta.url), 'utf8'));

describe('parseArchidektJson', () => {
  it('parses name, commander, mainboard and set info', () => {
    const deck = parseArchidektJson(fixture);
    expect(deck.source).toBe('archidekt');
    expect(deck.name).toBe('Prosper, Tome-Bound Treasure Storm');
    expect(deck.url).toBe('https://archidekt.com/decks/7654321');
    expect(deck.commanders).toEqual([
      { name: 'Prosper, Tome-Bound', quantity: 1, set: 'afc', collectorNumber: '232', categories: ['Commander'], isCommander: true },
    ]);
    const names = deck.mainboard.map((e) => e.name);
    expect(names).toEqual(['Sol Ring', 'Arcane Signet', 'Lightning Bolt', 'Mountain', 'Swamp', 'Command Tower']);
    expect(deck.mainboard.find((e) => e.name === 'Mountain')?.quantity).toBe(12);
    expect(deck.mainboard.find((e) => e.name === 'Arcane Signet')).toMatchObject({ set: 'eld', collectorNumber: '331', categories: ['Ramp', 'Artifact'] });
    expect(deck.warnings).toEqual([]);
  });

  it('sends cards in categories with includedInDeck=false to the sideboard', () => {
    const deck = parseArchidektJson(fixture);
    expect(deck.sideboard.map((e) => e.name).sort()).toEqual(['Bonecrusher Giant // Stomp', 'Rhystic Study']);
  });

  it('treats a premier category as the commander category even when not named "Commander"', () => {
    const json = {
      id: 1,
      name: 'Oathbreaker-ish',
      categories: [{ name: 'Leader', isPremier: true, includedInDeck: true }],
      cards: [
        { quantity: 1, categories: ['Leader'], card: { oracleCard: { name: 'Krenko, Mob Boss' }, edition: { editioncode: 'm13' }, collectorNumber: '137' } },
        { quantity: 1, categories: ['Maybeboard'], card: { oracleCard: { name: 'Opt' } } },
        { quantity: 1, card: { oracleCard: { name: 'Sol Ring' } } },
      ],
    };
    const deck = parseArchidektJson(json);
    expect(deck.commanders.map((e) => e.name)).toEqual(['Krenko, Mob Boss']);
    expect(deck.sideboard.map((e) => e.name)).toEqual(['Opt']);
    expect(deck.mainboard.map((e) => e.name)).toEqual(['Sol Ring']);
  });

  it('warns on malformed input instead of throwing', () => {
    expect(parseArchidektJson(undefined).warnings.length).toBeGreaterThan(0);
    const deck = parseArchidektJson({ name: 'broken', cards: 'nope' });
    expect(deck.mainboard).toEqual([]);
    expect(deck.warnings.some((w) => /cards/.test(w))).toBe(true);
  });
});
