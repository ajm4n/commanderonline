/**
 * Download Scryfall's "oracle_cards" bulk file, keep the paper-playable cards,
 * convert them to engine CardData and write:
 *   data/scryfall/cards.json  - CardData[]
 *   data/scryfall/meta.json   - { fetchedAt, count, source, ... }
 *
 * Run with `pnpm cards:fetch` (root) or `pnpm --filter @commander/cards fetch`.
 * Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1 so Node's fetch honors HTTPS_PROXY.
 *
 * Scryfall's bulk-data index (https://scryfall.com/docs/api/bulk-data) has offered
 * either a plain JSON array (`download_uri`) or a gzipped JSON-lines file
 * (`jsonl_download_uri`); both are supported here.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { isPlayableCard, toCardData, type ScryfallCard } from '../src/scryfall.js';

const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const HEADERS = { 'User-Agent': 'CommanderOnline/0.1', Accept: 'application/json' };
const OUT_DIR = fileURLToPath(new URL('../data/scryfall/', import.meta.url));

interface BulkDataEntry {
  type: string;
  /** Plain JSON array (older index shape). */
  download_uri?: string;
  /** Gzipped JSON-lines file (current index shape). */
  jsonl_download_uri?: string;
  updated_at?: string;
  size?: number;
  compressed_size?: number;
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res;
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await (await get(url)).json()) as T;
}

/** Download the plain JSON-array flavour of the bulk file. */
async function downloadJsonArray(url: string): Promise<ScryfallCard[]> {
  const raw = await fetchJson<unknown>(url);
  if (!Array.isArray(raw)) throw new Error('oracle_cards download is not a JSON array');
  return raw as ScryfallCard[];
}

/** Stream the gzipped JSON-lines flavour of the bulk file, one card per line. */
async function downloadJsonLines(url: string): Promise<ScryfallCard[]> {
  const res = await get(url);
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  const gzipped = /\.gz($|\?)/.test(url) || (res.headers.get('content-type') ?? '').includes('gzip');
  const text = gzipped ? body.pipe(createGunzip()) : body;
  const cards: ScryfallCard[] = [];
  const rl = createInterface({ input: text, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    cards.push(JSON.parse(trimmed) as ScryfallCard);
  }
  return cards;
}

function formatMb(bytes: number | undefined): string {
  return bytes ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : '';
}

async function main(): Promise<void> {
  console.log(`Fetching bulk data index from ${BULK_DATA_URL} ...`);
  const index = await fetchJson<{ data: BulkDataEntry[] }>(BULK_DATA_URL);
  const oracle = index.data?.find((d) => d.type === 'oracle_cards');
  if (!oracle) throw new Error('No "oracle_cards" entry in Scryfall bulk-data index');

  const started = Date.now();
  let raw: ScryfallCard[];
  let source: string;
  if (oracle.download_uri) {
    source = oracle.download_uri;
    console.log(`Downloading oracle_cards${formatMb(oracle.size)} from ${source} ...`);
    raw = await downloadJsonArray(source);
  } else if (oracle.jsonl_download_uri) {
    source = oracle.jsonl_download_uri;
    console.log(`Downloading oracle_cards${formatMb(oracle.compressed_size)} from ${source} ...`);
    raw = await downloadJsonLines(source);
  } else {
    throw new Error('oracle_cards entry has neither download_uri nor jsonl_download_uri');
  }
  console.log(`Downloaded ${raw.length} cards in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const cards = raw.filter(isPlayableCard).map(toCardData);
  cards.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}cards.json`, JSON.stringify(cards));
  const meta = {
    fetchedAt: new Date().toISOString(),
    count: cards.length,
    rawCount: raw.length,
    source,
    scryfallUpdatedAt: oracle.updated_at ?? null,
  };
  await writeFile(`${OUT_DIR}meta.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log(`Wrote ${cards.length} playable cards (of ${raw.length}) to ${OUT_DIR}cards.json`);
}

main().catch((err: unknown) => {
  console.error('fetch-scryfall failed:', err instanceof Error ? err.message : err);
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
    console.error('Hint: HTTPS_PROXY is set; retry with NODE_USE_ENV_PROXY=1 so fetch() uses the proxy.');
  }
  process.exit(1);
});
