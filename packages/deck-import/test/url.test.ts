import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { apiUrlFor, detectSource, importDeckFromUrl, USER_AGENT } from '../src/index.js';

const v3 = readFileSync(new URL('./fixtures/moxfield-v3.json', import.meta.url), 'utf8');
const archidekt = readFileSync(new URL('./fixtures/archidekt.json', import.meta.url), 'utf8');

function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
}

describe('detectSource', () => {
  it('recognises Moxfield, Archidekt and TappedOut URLs', () => {
    expect(detectSource('https://www.moxfield.com/decks/aB3dE9fGh1')).toBe('moxfield');
    expect(detectSource('moxfield.com/decks/aB3dE9fGh1?x=1')).toBe('moxfield');
    expect(detectSource('https://archidekt.com/decks/7654321/prosper_tome_bound')).toBe('archidekt');
    expect(detectSource('https://www.archidekt.com/decks/7654321')).toBe('archidekt');
    expect(detectSource('https://tappedout.net/mtg-decks/krenko-goblins/')).toBe('tappedout');
    expect(detectSource('https://example.com/decks/1')).toBe('unknown');
  });

  it('maps page URLs to API URLs', () => {
    expect(apiUrlFor('https://www.moxfield.com/decks/aB3dE9fGh1').apiUrl).toBe('https://api2.moxfield.com/v3/decks/all/aB3dE9fGh1');
    expect(apiUrlFor('https://archidekt.com/decks/7654321/some-slug').apiUrl).toBe('https://archidekt.com/api/decks/7654321/');
  });
});

describe('importDeckFromUrl', () => {
  it('fetches and parses a Moxfield deck with our User-Agent', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = { url, init };
      return new Response(v3, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const deck = await importDeckFromUrl('https://www.moxfield.com/decks/aB3dE9fGh1', fetchImpl);
    expect(seen?.url).toBe('https://api2.moxfield.com/v3/decks/all/aB3dE9fGh1');
    expect((seen?.init?.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(deck.source).toBe('moxfield');
    expect(deck.url).toBe('https://www.moxfield.com/decks/aB3dE9fGh1');
    expect(deck.commanders[0]?.name).toBe("Atraxa, Praetors' Voice");
    expect(deck.mainboard).toHaveLength(5);
  });

  it('fetches and parses an Archidekt deck', async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe('https://archidekt.com/api/decks/7654321/');
      return new Response(archidekt, { status: 200 });
    });
    const deck = await importDeckFromUrl('https://archidekt.com/decks/7654321/prosper', fetchImpl);
    expect(deck.source).toBe('archidekt');
    expect(deck.commanders[0]?.name).toBe('Prosper, Tome-Bound');
    expect(deck.sideboard).toHaveLength(2);
  });

  it('returns a warning (not an exception) when Moxfield responds 403', async () => {
    const fetchImpl = mockFetch(() => new Response('Forbidden', { status: 403 }));
    const deck = await importDeckFromUrl('https://www.moxfield.com/decks/aB3dE9fGh1', fetchImpl);
    expect(deck.source).toBe('moxfield');
    expect(deck.commanders).toEqual([]);
    expect(deck.mainboard).toEqual([]);
    expect(deck.warnings).toHaveLength(1);
    expect(deck.warnings[0]).toMatch(/403/);
    expect(deck.warnings[0]).toMatch(/paste/i);
  });

  it('reports network errors and unknown URLs as warnings', async () => {
    const failing = mockFetch(() => {
      throw new Error('ECONNRESET');
    });
    const deck = await importDeckFromUrl('https://archidekt.com/decks/1', failing);
    expect(deck.warnings[0]).toMatch(/ECONNRESET/);
    const unknown = await importDeckFromUrl('https://example.com/deck', failing);
    expect(unknown.source).toBe('unknown');
    expect(unknown.warnings[0]).toMatch(/Unrecognised/);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('parses TappedOut text exports', async () => {
    const fetchImpl = mockFetch(() => new Response('1x Krenko, Mob Boss *CMDR*\n1x Sol Ring\nSB: 1x Mulldrifter\n', { status: 200 }));
    const deck = await importDeckFromUrl('https://tappedout.net/mtg-decks/krenko-goblins/', fetchImpl);
    expect(deck.source).toBe('tappedout');
    expect(deck.commanders[0]?.name).toBe('Krenko, Mob Boss');
    expect(deck.mainboard).toEqual([{ name: 'Sol Ring', quantity: 1 }]);
    expect(deck.sideboard).toEqual([{ name: 'Mulldrifter', quantity: 1 }]);
  });
});
