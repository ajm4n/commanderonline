import { loadCardDb, loadFixtureDb } from '@commander/cards/node';
import { DEFAULT_PORT } from '@commander/protocol';
import { createServer } from './server.js';
import * as log from './log.js';

async function main(): Promise<void> {
  let cardDb;
  let fixture = false;
  try {
    cardDb = await loadCardDb(process.env.CARDS_PATH || undefined);
  } catch (err) {
    console.warn(`\nWARNING: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('Falling back to the small fixture card database. Run `pnpm cards:fetch` for the full card pool.\n');
    cardDb = loadFixtureDb();
    fixture = true;
  }

  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = await createServer({ cardDb, port, host: process.env.HOST, fixture });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
