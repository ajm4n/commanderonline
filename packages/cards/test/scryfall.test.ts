import { readFileSync } from 'node:fs';
import type { CardData } from '@commander/engine';
import { describe, expect, it } from 'vitest';
import { CardDb, normalizeName } from '../src/db.js';
import { FIXTURE_CARDS_PATH, loadCardDb, loadFixtureDb } from '../src/db-node.js';
import {
  colorsFromManaCost,
  isCommanderBanned,
  isCommanderLegal,
  isPlayableCard,
  toCardData,
  type ScryfallCard,
} from '../src/scryfall.js';

const raw = JSON.parse(readFileSync(FIXTURE_CARDS_PATH, 'utf8')) as ScryfallCard[];
const byName = (name: string): ScryfallCard => {
  const c = raw.find((x) => x.name === name);
  if (!c) throw new Error(`fixture missing ${name}`);
  return c;
};

describe('fixture', () => {
  it('contains the expected cards and every one is playable', () => {
    expect(raw.length).toBe(130);
    expect(raw.every(isPlayableCard)).toBe(true);
    expect(raw.filter((c) => c.card_faces).map((c) => c.layout).sort()).toEqual(['adventure', 'flip', 'modal_dfc', 'split', 'transform']);
  });
});

describe('toCardData', () => {
  it('converts a normal card', () => {
    const card = toCardData(byName('Lightning Bolt'));
    expect(card).toMatchObject({
      name: 'Lightning Bolt',
      manaCost: '{R}',
      typeLine: 'Instant',
      oracleText: 'Lightning Bolt deals 3 damage to any target.',
      colors: ['R'],
      colorIdentity: ['R'],
      layout: 'normal',
      cmc: 1,
      keywords: [],
      oracleId: '4457ed35-7c10-48c8-9776-456485fdf070',
      scryfallId: 'ae5f9fb1-5a55-4db3-98a1-2628e3598c18',
    });
    expect(card.faces).toBeUndefined();
    expect(card.power).toBeUndefined();
    expect(card.imageUri).toMatch(/^https:\/\/cards\.scryfall\.io\/normal\//);
  });

  it('keeps creature stats, keywords and produced mana', () => {
    const prosper = toCardData(byName('Prosper, Tome-Bound'));
    expect(prosper.power).toBe('1');
    expect(prosper.toughness).toBe('4');
    expect(prosper.colors).toEqual(['B', 'R']);
    expect(prosper.keywords).toContain('Deathtouch');
    expect(prosper.typeLine).toBe('Legendary Creature — Tiefling Warlock');

    const solRing = toCardData(byName('Sol Ring'));
    expect(solRing.producedMana).toEqual(['C']);
    expect(solRing.colors).toEqual([]);
    expect(solRing.oracleText).toBe('{T}: Add {C}{C}.');

    const tower = toCardData(byName('Command Tower'));
    expect(tower.manaCost).toBe('');
    expect(tower.typeLine).toBe('Land');
  });

  it('converts a transform card: front face on top, both faces exposed', () => {
    const card = toCardData(byName('Delver of Secrets // Insectile Aberration'));
    expect(card.layout).toBe('transform');
    expect(card.name).toBe('Delver of Secrets // Insectile Aberration');
    expect(card.manaCost).toBe('{U}');
    expect(card.typeLine).toBe('Creature — Human Wizard');
    expect(card.oracleText).toMatch(/^At the beginning of your upkeep/);
    expect(card.power).toBe('1');
    expect(card.toughness).toBe('1');
    expect(card.colors).toEqual(['U']);
    expect(card.cmc).toBe(1);
    expect(card.keywords).toEqual(['Flying', 'Transform']);

    expect(card.faces).toHaveLength(2);
    const [front, back] = card.faces!;
    expect(front.name).toBe('Delver of Secrets');
    expect(front.imageUri).toMatch(/\/normal\/front\//);
    expect(back).toMatchObject({
      name: 'Insectile Aberration',
      manaCost: '',
      typeLine: 'Creature — Human Insect',
      oracleText: 'Flying',
      power: '3',
      toughness: '2',
      colors: ['U'],
    });
    expect(back.imageUri).toMatch(/\/normal\/back\//);
    expect(card.imageUri).toBe(front.imageUri);
  });

  it('converts a modal DFC with a planeswalker back face', () => {
    const card = toCardData(byName('Valki, God of Lies // Tibalt, Cosmic Impostor'));
    expect(card.layout).toBe('modal_dfc');
    expect(card.manaCost).toBe('{1}{B}');
    expect(card.colors).toEqual(['B']);
    expect(card.colorIdentity).toEqual(['B', 'R']);
    expect(card.loyalty).toBeUndefined();
    const back = card.faces![1];
    expect(back.name).toBe('Tibalt, Cosmic Impostor');
    expect(back.manaCost).toBe('{5}{B}{R}');
    expect(back.loyalty).toBe('5');
    expect(back.colors).toEqual(['B', 'R']);
    expect(back.oracleText).toContain('+2: Exile the top card of each player\'s library.');
  });

  it('converts an adventure card and derives face colors from mana cost', () => {
    const card = toCardData(byName('Bonecrusher Giant // Stomp'));
    expect(card.layout).toBe('adventure');
    expect(card.manaCost).toBe('{2}{R}');
    expect(card.typeLine).toBe('Creature — Giant');
    expect(card.power).toBe('4');
    expect(card.toughness).toBe('3');
    expect(card.colors).toEqual(['R']);
    expect(card.faces).toHaveLength(2);
    const stomp = card.faces![1];
    expect(stomp.name).toBe('Stomp');
    expect(stomp.manaCost).toBe('{1}{R}');
    expect(stomp.typeLine).toBe('Instant — Adventure');
    expect(stomp.oracleText).toBe("Damage can't be prevented this turn. Stomp deals 2 damage to any target.");
    expect(stomp.colors).toEqual(['R']);
    expect(stomp.power).toBeUndefined();
    // Faces share the single printed image.
    expect(stomp.imageUri).toBe(card.imageUri);
  });

  it('converts a split card: union of both halves for colors', () => {
    const card = toCardData(byName('Wear // Tear'));
    expect(card.layout).toBe('split');
    expect(card.manaCost).toBe('{1}{R}');
    expect(card.typeLine).toBe('Instant');
    expect(card.oracleText).toMatch(/^Destroy target artifact\./);
    expect(card.colors).toEqual(['W', 'R']);
    expect(card.cmc).toBe(3);
    expect(card.keywords).toEqual(['Fuse']);
    expect(card.faces!.map((f) => f.name)).toEqual(['Wear', 'Tear']);
    expect(card.faces![0].colors).toEqual(['R']);
    expect(card.faces![1].colors).toEqual(['W']);
    expect(card.faces![1].manaCost).toBe('{W}');
  });

  it('falls back to a normal layout for unknown layouts and flags tokens', () => {
    const weird = toCardData({ ...byName('Grizzly Bears'), layout: 'something_new' });
    expect(weird.layout).toBe('normal');
    const token = toCardData({ ...byName('Grizzly Bears'), layout: 'token' });
    expect(token.isToken).toBe(true);
    expect(toCardData(byName('Grizzly Bears')).isToken).toBeUndefined();
  });

  it('derives colors from hybrid mana costs', () => {
    expect(colorsFromManaCost('{1}{W/U}{G}')).toEqual(['W', 'U', 'G']);
    expect(colorsFromManaCost('{3}')).toEqual([]);
    expect(colorsFromManaCost(undefined)).toEqual([]);
  });
});

describe('isPlayableCard / legality', () => {
  const bolt = byName('Lightning Bolt');

  it('accepts real paper cards', () => {
    expect(isPlayableCard(bolt)).toBe(true);
    expect(isPlayableCard(byName('Wear // Tear'))).toBe(true);
  });

  it('rejects tokens, emblems, art cards and other non-deck layouts', () => {
    for (const layout of ['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar']) {
      expect(isPlayableCard({ ...bolt, layout })).toBe(false);
    }
  });

  it('rejects digital-only cards and memorabilia', () => {
    const digitalOnly = { commander: 'not_legal', legacy: 'not_legal', vintage: 'not_legal', historic: 'legal', alchemy: 'legal' };
    expect(isPlayableCard({ ...bolt, games: ['arena'], legalities: digitalOnly })).toBe(false);
    expect(isPlayableCard({ ...bolt, games: undefined, legalities: digitalOnly })).toBe(false);
    expect(isPlayableCard({ ...bolt, games: ['arena'], legalities: undefined })).toBe(false);
    expect(isPlayableCard({ ...bolt, set_type: 'memorabilia' })).toBe(false);
    expect(isPlayableCard({ ...bolt, set_type: 'token' })).toBe(false);
    expect(isPlayableCard({ ...bolt, type_line: 'Token Creature — Goblin' })).toBe(false);
    expect(isPlayableCard({ ...bolt, type_line: 'Conspiracy' })).toBe(false);
  });

  it('keeps paper cards whose oracle_cards representative printing is digital-only', () => {
    // Scryfall's oracle_cards feed represents Demonic Consultation with its MTGO-only
    // Masters Edition II printing; paper-format legalities prove it exists in paper.
    const consult = byName('Demonic Consultation');
    const me2 = { ...consult, set: 'me2', set_type: 'masters', games: ['mtgo'], digital: true };
    expect(isPlayableCard(me2)).toBe(true);
    expect(isPlayableCard({ ...me2, legalities: { ...me2.legalities, commander: 'banned' } })).toBe(true);
  });

  it('reports commander legality and bans', () => {
    expect(isCommanderLegal(bolt)).toBe(true);
    expect(isCommanderBanned(bolt)).toBe(false);
    const dockside = byName('Dockside Extortionist');
    expect(isCommanderLegal(dockside)).toBe(true); // banned cards are still importable
    expect(isCommanderBanned(dockside)).toBe(true);
    expect(isCommanderLegal({ ...bolt, legalities: { commander: 'not_legal' } })).toBe(false);
    expect(isCommanderLegal({ ...bolt, legalities: undefined })).toBe(false);
  });
});

describe('CardDb', () => {
  const db = loadFixtureDb();

  it('loads the fixture synchronously', () => {
    expect(db.size).toBe(130);
    expect(db.all()).toHaveLength(130);
    expect(db.all()).not.toBe(db.all()); // defensive copy
  });

  it('byName is exact and case-insensitive', () => {
    expect(db.byName('Sol Ring')?.name).toBe('Sol Ring');
    expect(db.byName('sol ring')?.name).toBe('Sol Ring');
    expect(db.byName('SOL RING')?.name).toBe('Sol Ring');
    expect(db.byName('Nonexistent Card')).toBeUndefined();
    expect(db.byName('')).toBeUndefined();
  });

  it('byName ignores extra whitespace and trailing punctuation', () => {
    expect(db.byName('  sol   ring ')?.name).toBe('Sol Ring');
    expect(db.byName('Sol Ring.')?.name).toBe('Sol Ring');
    expect(db.byName('Krenko, Mob Boss,')?.name).toBe('Krenko, Mob Boss');
    expect(db.byName("Thassa's Oracle")?.name).toBe("Thassa's Oracle");
    expect(db.byName('Thassa’s Oracle')?.name).toBe("Thassa's Oracle"); // curly apostrophe
    expect(db.byName("Atraxa, Praetors' Voice")?.name).toBe("Atraxa, Praetors' Voice");
  });

  it('byName ignores diacritics', () => {
    const accented = new CardDb([
      { ...db.byName('Grizzly Bears')!, name: "Lim-Dûl's Vault", oracleId: 'x1' },
      { ...db.byName('Grizzly Bears')!, name: 'Jötun Grunt', oracleId: 'x2' },
    ]);
    expect(accented.byName("lim-dul's vault")?.name).toBe("Lim-Dûl's Vault");
    expect(accented.byName("LIM-DÛL'S VAULT")?.name).toBe("Lim-Dûl's Vault");
    expect(accented.byName('jotun grunt')?.name).toBe('Jötun Grunt');
    expect(db.byName('Lim-Dûl\'s Vault')).toBeUndefined();
  });

  it('byName matches multi-face cards by full name, front face or back face', () => {
    const delver = 'Delver of Secrets // Insectile Aberration';
    expect(db.byName(delver)?.name).toBe(delver);
    expect(db.byName('delver of secrets // insectile aberration')?.name).toBe(delver);
    expect(db.byName('Delver of Secrets')?.name).toBe(delver);
    expect(db.byName('Insectile Aberration')?.name).toBe(delver);
    expect(db.byName('Delver of Secrets/Insectile Aberration')?.name).toBe(delver);
    expect(db.byName('Delver of Secrets//Insectile Aberration')?.name).toBe(delver);

    expect(db.byName('Bonecrusher Giant')?.layout).toBe('adventure');
    expect(db.byName('Stomp')?.name).toBe('Bonecrusher Giant // Stomp');
    expect(db.byName('Wear')?.name).toBe('Wear // Tear');
    expect(db.byName('Tear')?.name).toBe('Wear // Tear');
    expect(db.byName('Valki, God of Lies')?.name).toBe('Valki, God of Lies // Tibalt, Cosmic Impostor');
    expect(db.byName('Tibalt, Cosmic Impostor')?.name).toBe('Valki, God of Lies // Tibalt, Cosmic Impostor');
  });

  it('front-face and full names win over another card\'s back-face name', () => {
    const base = db.byName('Grizzly Bears')!;
    const back: CardData = { ...base, name: 'Alpha // Beta', oracleId: 'a', faces: [
      { name: 'Alpha', manaCost: '', typeLine: '', oracleText: '', colors: [] },
      { name: 'Beta', manaCost: '', typeLine: '', oracleText: '', colors: [] },
    ] };
    const real = { ...base, name: 'Beta', oracleId: 'b', faces: undefined };
    for (const order of [[back, real], [real, back]]) {
      const small = new CardDb(order);
      expect(small.byName('Beta')?.oracleId).toBe('b');
      expect(small.byName('Alpha')?.oracleId).toBe('a');
    }
  });

  it('byOracleId finds cards by Scryfall oracle id', () => {
    expect(db.byOracleId('6ad8011d-3471-4369-9d68-b264cc027487')?.name).toBe('Sol Ring');
    expect(db.byOracleId('nope')).toBeUndefined();
    const stomp = db.byName('Stomp')!;
    expect(db.byOracleId(stomp.oracleId)).toBe(stomp);
  });

  it('search ranks prefix matches before substring matches, case-insensitively', () => {
    const names = db.search('EL', 100).map((c) => c.name);
    const isPrefix = (n: string) => n.toLowerCase().startsWith('el');
    const prefixNames = names.filter(isPrefix);
    const substringNames = names.filter((n) => !isPrefix(n));
    expect(prefixNames.length).toBeGreaterThan(0);
    expect(substringNames.length).toBeGreaterThan(0);
    expect(names).toEqual([...prefixNames, ...substringNames]);
    expect(prefixNames).toContain('Elvish Mystic');
    expect(prefixNames).toContain('Elesh Norn, Grand Cenobite');
    expect(substringNames).toContain('Llanowar Elves');
    expect(substringNames).toContain('Farhaven Elf');
    // Prefix matches are alphabetical.
    expect(prefixNames).toEqual([...prefixNames].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));

    const sol = db.search('sol').map((c) => c.name);
    expect(sol).toEqual(['Sol Ring', 'Solemn Simulacrum']);
    expect(db.search('ring').map((c) => c.name)).toEqual(['Smothering Tithe', 'Sol Ring']); // both substring hits, alphabetical
  });

  it('search matches face names, dedupes, and respects the limit', () => {
    expect(db.search('stomp').map((c) => c.name)).toEqual(['Bonecrusher Giant // Stomp']);
    expect(db.search('tear').map((c) => c.name)).toEqual(['Wear // Tear']);
    expect(db.search('a', 5)).toHaveLength(5);
    expect(db.search('a', 0)).toEqual([]);
    expect(db.search('')).toEqual([]);
    expect(db.search('zzzzzz')).toEqual([]);
    const all = db.search('e', 1000);
    expect(new Set(all).size).toBe(all.length);
  });

  it('normalizeName is idempotent', () => {
    for (const c of db.all()) {
      const n = normalizeName(c.name);
      expect(normalizeName(n)).toBe(n);
    }
  });
});

describe('loadCardDb', () => {
  it('tells the caller to run pnpm cards:fetch when the snapshot is missing', async () => {
    await expect(loadCardDb('/definitely/not/here/cards.json')).rejects.toThrow(/pnpm cards:fetch/);
  });

  it('loads a CardData[] snapshot from disk', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cards-'));
    const file = join(dir, 'cards.json');
    writeFileSync(file, JSON.stringify(loadFixtureDb().all()));
    const db = await loadCardDb(file);
    expect(db.size).toBe(130);
    expect(db.byName('Counterspell')?.oracleText).toBe('Counter target spell.');
  });
});
