import { parseArchidektJson } from './archidekt.js';
import { parseMoxfieldJson } from './moxfield.js';
import { parseDeckText } from './text.js';
import { type DeckSource, type ImportedDeck, emptyDeck } from './types.js';

export const USER_AGENT = 'CommanderOnline/0.1';

const MOXFIELD_RE = /^(?:https?:\/\/)?(?:www\.)?moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i;
const ARCHIDEKT_RE = /^(?:https?:\/\/)?(?:www\.)?archidekt\.com\/(?:decks|api\/decks)\/(\d+)/i;
const TAPPEDOUT_RE = /^(?:https?:\/\/)?(?:www\.)?tappedout\.net\/mtg-decks\/([A-Za-z0-9_-]+)/i;

export function detectSource(url: string): Exclude<DeckSource, 'text'> {
  const u = url.trim();
  if (MOXFIELD_RE.test(u)) return 'moxfield';
  if (ARCHIDEKT_RE.test(u)) return 'archidekt';
  if (TAPPEDOUT_RE.test(u)) return 'tappedout';
  return 'unknown';
}

/** Translate a public deck page URL into the API endpoint we fetch. */
export function apiUrlFor(url: string): { source: Exclude<DeckSource, 'text'>; apiUrl?: string; id?: string } {
  const u = url.trim();
  let m = MOXFIELD_RE.exec(u);
  if (m) return { source: 'moxfield', id: m[1], apiUrl: `https://api2.moxfield.com/v3/decks/all/${m[1]}` };
  m = ARCHIDEKT_RE.exec(u);
  if (m) return { source: 'archidekt', id: m[1], apiUrl: `https://archidekt.com/api/decks/${m[1]}/` };
  m = TAPPEDOUT_RE.exec(u);
  if (m) return { source: 'tappedout', id: m[1], apiUrl: `https://tappedout.net/mtg-decks/${m[1]}/?fmt=txt` };
  return { source: 'unknown' };
}

const PASTE_HINT = 'Paste the deck as exported text instead (Moxfield: More > Export > Copy to clipboard).';

/**
 * Fetch and parse a deck from a Moxfield, Archidekt or TappedOut URL.
 * Never throws for remote failures: problems are reported in `warnings`.
 */
export async function importDeckFromUrl(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ImportedDeck> {
  const { source, apiUrl } = apiUrlFor(url);
  const fail = (message: string): ImportedDeck => {
    const deck = emptyDeck(source);
    deck.url = url;
    deck.warnings.push(message);
    return deck;
  };
  if (source === 'unknown' || !apiUrl) {
    return fail(`Unrecognised deck URL "${url}". Supported: moxfield.com/decks/..., archidekt.com/decks/..., tappedout.net/mtg-decks/...`);
  }
  if (typeof fetchImpl !== 'function') return fail('No fetch implementation is available in this environment.');

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: source === 'tappedout' ? 'text/plain, */*' : 'application/json',
      },
      redirect: 'follow',
    });
  } catch (err) {
    return fail(`Network error fetching ${apiUrl}: ${err instanceof Error ? err.message : String(err)}. ${PASTE_HINT}`);
  }

  if (!response.ok) {
    if (source === 'moxfield' && (response.status === 403 || response.status === 401)) {
      return fail(
        `Moxfield refused the request (HTTP ${response.status}); its API only accepts approved user agents. ${PASTE_HINT}`,
      );
    }
    if (response.status === 404) return fail(`Deck not found at ${apiUrl} (HTTP 404). Is the deck public?`);
    return fail(`Failed to fetch ${apiUrl}: HTTP ${response.status}. ${PASTE_HINT}`);
  }

  let deck: ImportedDeck;
  try {
    if (source === 'tappedout') {
      const text = await response.text();
      if (/<!doctype html|<html/i.test(text.slice(0, 500))) {
        return fail(`TappedOut returned a web page instead of a decklist. ${PASTE_HINT}`);
      }
      deck = parseDeckText(text);
      deck.source = 'tappedout';
    } else {
      const json: unknown = await response.json();
      deck = source === 'moxfield' ? parseMoxfieldJson(json) : parseArchidektJson(json);
    }
  } catch (err) {
    return fail(`Could not parse the response from ${apiUrl}: ${err instanceof Error ? err.message : String(err)}. ${PASTE_HINT}`);
  }
  deck.url = url;
  return deck;
}
