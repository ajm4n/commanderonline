import { describe, expect, it } from 'vitest';
import { parseCardLine, parseDeckText } from '../src/index.js';

const find = (list: { name: string; quantity: number }[], name: string) => list.find((e) => e.name === name);

describe('parseCardLine', () => {
  it('parses "1 Sol Ring"', () => {
    expect(parseCardLine('1 Sol Ring')?.entry).toEqual({ name: 'Sol Ring', quantity: 1 });
  });

  it('parses "4x Lightning Bolt" and "4 x" spacing', () => {
    expect(parseCardLine('4x Lightning Bolt')?.entry).toEqual({ name: 'Lightning Bolt', quantity: 4 });
    expect(parseCardLine('4 x Lightning Bolt')?.entry).toEqual({ name: 'Lightning Bolt', quantity: 4 });
  });

  it('defaults quantity to 1 for a bare name', () => {
    expect(parseCardLine('Sol Ring')?.entry).toEqual({ name: 'Sol Ring', quantity: 1 });
  });

  it('parses Arena format "1 Sol Ring (C21) 263"', () => {
    expect(parseCardLine('1 Sol Ring (C21) 263')?.entry).toEqual({ name: 'Sol Ring', quantity: 1, set: 'c21', collectorNumber: '263' });
  });

  it('parses set code without collector number and Deckstats leading set', () => {
    expect(parseCardLine('1 Sol Ring (C21)')?.entry).toEqual({ name: 'Sol Ring', quantity: 1, set: 'c21' });
    expect(parseCardLine('1 [C21] Sol Ring')?.entry).toEqual({ name: 'Sol Ring', quantity: 1, set: 'c21' });
  });

  it('keeps commas, apostrophes and split-card separators in names', () => {
    expect(parseCardLine("1 Atraxa, Praetors' Voice")?.entry.name).toBe("Atraxa, Praetors' Voice");
    expect(parseCardLine('1 Wear // Tear')?.entry.name).toBe('Wear // Tear');
    expect(parseCardLine('1 Wear / Tear')?.entry.name).toBe('Wear // Tear');
    expect(parseCardLine('1 Fire // Ice (MH2) 290')?.entry).toEqual({ name: 'Fire // Ice', quantity: 1, set: 'mh2', collectorNumber: '290' });
  });

  it('recognises *CMDR* and #!Commander markers', () => {
    const a = parseCardLine('1 Krenko, Mob Boss *CMDR*');
    expect(a?.entry.isCommander).toBe(true);
    expect(a?.board).toBe('commanders');
    expect(a?.entry.name).toBe('Krenko, Mob Boss');
    const b = parseCardLine('1 Krenko, Mob Boss #!Commander');
    expect(b?.board).toBe('commanders');
    expect(b?.entry.name).toBe('Krenko, Mob Boss');
  });

  it('strips foil markers and reads SB: prefix', () => {
    expect(parseCardLine('1 Sol Ring (C21) 263 *F*')?.entry).toEqual({ name: 'Sol Ring', quantity: 1, set: 'c21', collectorNumber: '263' });
    const sb = parseCardLine('SB: 1 Mulldrifter');
    expect(sb?.board).toBe('sideboard');
    expect(sb?.entry).toEqual({ name: 'Mulldrifter', quantity: 1 });
  });

  it('reads Archidekt bracket categories', () => {
    const p = parseCardLine('1x Prosper, Tome-Bound (afc) 232 [Commander{top}]');
    expect(p?.board).toBe('commanders');
    expect(p?.entry).toEqual({ name: 'Prosper, Tome-Bound', quantity: 1, set: 'afc', collectorNumber: '232', isCommander: true, categories: ['Commander'] });
    const r = parseCardLine('1x Sol Ring (c21) 263 [Ramp,Artifact]');
    expect(r?.entry.categories).toEqual(['Ramp', 'Artifact']);
    expect(r?.board).toBeUndefined();
  });
});

describe('parseDeckText', () => {
  it('parses a plain MTGO-style list with no sections', () => {
    const deck = parseDeckText('1 Sol Ring\n1 Arcane Signet\n30 Forest\n');
    expect(deck.source).toBe('text');
    expect(deck.commanders).toEqual([]);
    expect(deck.mainboard).toHaveLength(3);
    expect(find(deck.mainboard, 'Forest')?.quantity).toBe(30);
    expect(deck.warnings.some((w) => /commander/i.test(w))).toBe(true);
  });

  it('parses Arena/Moxfield sections: Commander, Deck, Sideboard, Maybeboard (ignored)', () => {
    const text = `Commander
1 Atraxa, Praetors' Voice (CMM) 342

Deck
1 Sol Ring (C21) 263
1 Command Tower (CMR) 350
97 Forest (MKM) 281

Sideboard
1 Mulldrifter (LRW) 76

Maybeboard
1 Opt (M20) 59
`;
    const deck = parseDeckText(text);
    expect(deck.commanders).toEqual([{ name: "Atraxa, Praetors' Voice", quantity: 1, set: 'cmm', collectorNumber: '342', isCommander: true }]);
    expect(deck.mainboard.map((e) => e.name)).toEqual(['Sol Ring', 'Command Tower', 'Forest']);
    expect(deck.sideboard).toEqual([{ name: 'Mulldrifter', quantity: 1, set: 'lrw', collectorNumber: '76' }]);
    expect(deck.mainboard.some((e) => e.name === 'Opt')).toBe(false);
    expect(deck.sideboard.some((e) => e.name === 'Opt')).toBe(false);
    expect(deck.warnings).toEqual([]);
  });

  it('handles "// Commander" comment headers and "Commander:" with counts', () => {
    const a = parseDeckText('// Commander\n1 Krenko, Mob Boss\n// Deck\n1 Skullclamp\n');
    expect(a.commanders[0]?.name).toBe('Krenko, Mob Boss');
    expect(a.mainboard[0]?.name).toBe('Skullclamp');
    const b = parseDeckText('Commander (1)\n1 Krenko, Mob Boss\n\nMainboard (99)\n1 Skullclamp\nLands - 1\n1 Mountain');
    expect(b.commanders).toHaveLength(1);
    expect(b.mainboard.map((e) => e.name)).toEqual(['Skullclamp', 'Mountain']);
  });

  it('puts *CMDR* cards in commanders regardless of section and merges duplicates', () => {
    const deck = parseDeckText('1 Sol Ring\n1 Krenko, Mob Boss *CMDR*\n2 Sol Ring\nSB: 1 Mulldrifter\nSB: 1 Mulldrifter');
    expect(deck.commanders).toEqual([{ name: 'Krenko, Mob Boss', quantity: 1, isCommander: true }]);
    expect(deck.mainboard).toEqual([{ name: 'Sol Ring', quantity: 3 }]);
    expect(deck.sideboard).toEqual([{ name: 'Mulldrifter', quantity: 2 }]);
  });

  it('supports partner commanders and warns about card counts', () => {
    const deck = parseDeckText('Commander\n1 Rograkh, Son of Rohgahh\n1 Jeska, Thrice Reborn\nDeck\n98 Mountain');
    expect(deck.commanders.map((e) => e.name)).toEqual(['Rograkh, Son of Rohgahh', 'Jeska, Thrice Reborn']);
    expect(deck.warnings).toEqual([]);
    const short = parseDeckText('Commander\n1 Krenko, Mob Boss\nDeck\n10 Mountain');
    expect(short.warnings.some((w) => w.includes('11 cards'))).toBe(true);
  });

  it('reads a deck name line, ignores blank lines, CRLF and comments', () => {
    const deck = parseDeckText('// Name: Goblin Party\r\n\r\n# just a comment\r\n1 Krenko, Mob Boss *CMDR*\r\n\r\n1 Sol Ring\r\n');
    expect(deck.name).toBe('Goblin Party');
    expect(deck.commanders).toHaveLength(1);
    expect(deck.mainboard).toEqual([{ name: 'Sol Ring', quantity: 1 }]);
  });

  it('returns an empty deck with a warning for empty input', () => {
    const deck = parseDeckText('\n\n   \n');
    expect(deck.commanders).toEqual([]);
    expect(deck.mainboard).toEqual([]);
    expect(deck.sideboard).toEqual([]);
  });
});

describe('Moxfield export shapes', () => {
  it('a Commander header followed by a blank line ends the commander block', () => {
    const d = parseDeckText(`Commander\n1 Tinybones, Trinket Thief (CMM) 470\n\n1 Sol Ring (CMM) 1\n1 Swamp (CMM) 1000\n1 Dark Ritual (CMM) 5\n`);
    expect(d.commanders.map((c) => c.name)).toEqual(['Tinybones, Trinket Thief']);
    expect(d.mainboard.length).toBe(3);
  });
  it('*CMDR* markers still win', () => {
    const d = parseDeckText(`1 Sol Ring\n1 Tinybones, Trinket Thief *CMDR*\n1 Swamp`);
    expect(d.commanders.map((c) => c.name)).toEqual(['Tinybones, Trinket Thief']);
  });

  // Moxfield's own text export introduces nothing at all: the commander is the first block.
  const ninetyNine = Array.from({ length: 20 }, (_, i) => `1 Island (LEA) ${i + 1}`).join('\n');

  it('claims a headerless first block of one card as the commander', () => {
    const d = parseDeckText(`1 Tinybones, Trinket Thief (CMM) 470\n\n${ninetyNine}\n`);
    expect(d.commanders.map((c) => c.name)).toEqual(['Tinybones, Trinket Thief']);
    expect(d.mainboard.some((e) => e.name === 'Tinybones, Trinket Thief')).toBe(false);
    expect(d.warnings.some((w) => /no commander/i.test(w))).toBe(false);
  });

  it('claims a headerless first block of two cards (partners)', () => {
    const d = parseDeckText(`1 Thrasios, Triton Hero (C16) 40\n1 Tymna the Weaver (C16) 38\n\n${ninetyNine}\n`);
    expect(d.commanders.map((c) => c.name)).toEqual(['Thrasios, Triton Hero', 'Tymna the Weaver']);
  });

  it('still claims it when a SIDEBOARD section follows the deck', () => {
    const d = parseDeckText(`1 Tinybones, Trinket Thief (CMM) 470\n\n${ninetyNine}\n\nSIDEBOARD:\n1 Swords to Plowshares (STA) 12\n`);
    expect(d.commanders.map((c) => c.name)).toEqual(['Tinybones, Trinket Thief']);
    expect(d.sideboard.map((c) => c.name)).toEqual(['Swords to Plowshares']);
  });

  it('leaves an MTGO maindeck / sideboard split alone', () => {
    const main = Array.from({ length: 12 }, (_, i) => `4 Bolt ${i} (LEA) ${i}`).join('\n');
    const d = parseDeckText(`${main}\n\n2 Smash to Smithereens (SOM) 1\n`);
    expect(d.commanders).toEqual([]);
    expect(d.mainboard.length).toBe(13);
  });

  it('leaves a flat list with no blank line alone', () => {
    const d = parseDeckText(`1 Tinybones, Trinket Thief (CMM) 470\n${ninetyNine}\n`);
    expect(d.commanders).toEqual([]);
  });
});
