/**
 * Node-only loaders for the card database. Kept out of `db.ts` / the package
 * root so the browser bundle never pulls in `node:fs`. Import via
 * `@commander/cards/node`.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CardData } from '@commander/engine';
import { CardDb } from './db.js';
import { isPlayableCard, toCardData, type ScryfallCard } from './scryfall.js';

/** Absolute path of the fetched Scryfall snapshot (see scripts/fetch-scryfall.ts). */
export const DEFAULT_CARDS_PATH = fileURLToPath(new URL('../data/scryfall/cards.json', import.meta.url));
/** Absolute path of the small checked-in fixture used by tests. */
export const FIXTURE_CARDS_PATH = fileURLToPath(new URL('../data/fixtures/sample-cards.json', import.meta.url));

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Load the full card database written by `pnpm cards:fetch`
 * (`packages/cards/data/scryfall/cards.json`, an array of engine `CardData`).
 */
export async function loadCardDb(path: string = DEFAULT_CARDS_PATH): Promise<CardDb> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(`Card database not found at ${path}. Run \`pnpm cards:fetch\` to download the Scryfall oracle data.`);
    }
    throw err;
  }
  const cards = JSON.parse(raw) as CardData[];
  if (!Array.isArray(cards)) throw new Error(`Card database at ${path} is not a JSON array. Re-run \`pnpm cards:fetch\`.`);
  return new CardDb(cards);
}

/** Synchronously load the checked-in fixture (raw Scryfall JSON) as a CardDb. */
export function loadFixtureDb(path: string = FIXTURE_CARDS_PATH): CardDb {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ScryfallCard[];
  return new CardDb(raw.filter(isPlayableCard).map(toCardData));
}
