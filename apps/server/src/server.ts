import http from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CardData } from '@commander/engine';
import { DEFAULT_PORT, WS_PATH, decodeClient, encode } from '@commander/protocol';
import { importDeckFromUrl, parseDeckText } from '@commander/deck-import';
import { FIXTURE_WARNING, lookupCard, resolveDeck, type CardDbLike } from './cards.js';
import { RoomManager } from './rooms.js';
import * as log from './log.js';

export interface ServerOptions {
  cardDb: CardDbLike;
  /** 0 picks an ephemeral port (tests). Defaults to DEFAULT_PORT. */
  port?: number;
  host?: string;
  /** Directory of the built web client. Defaults to apps/web/dist; skipped when missing. */
  staticDir?: string | null;
  /** True when running on the fixture DB: deck imports carry a warning. */
  fixture?: boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  emptyRoomTtlMs?: number;
}

export interface RunningServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  rooms: RoomManager;
  /** The port actually bound. */
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new HttpError(400, 'Body must be a JSON object'));
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

export async function createServer(opts: ServerOptions): Promise<RunningServer> {
  const { cardDb } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const rooms = new RoomManager({ cardDb, emptyRoomTtlMs: opts.emptyRoomTtlMs });
  const staticDir = opts.staticDir === null ? null : resolveStaticDir(opts.staticDir ?? DEFAULT_STATIC_DIR);
  const extraWarnings = opts.fixture ? [FIXTURE_WARNING] : [];

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const route = `${method} ${url.pathname.replace(/\/+$/, '')}`;
    switch (route) {
      case 'GET /api/health':
        return sendJson(res, 200, { ok: true, cards: cardDb.size, rooms: rooms.rooms.size, fixture: !!opts.fixture });

      case 'GET /api/rooms':
        return sendJson(res, 200, rooms.list());

      case 'GET /api/cards/search': {
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        return sendJson(res, 200, { cards: q.trim() ? cardDb.search(q, limit) : [] });
      }

      case 'POST /api/cards/resolve': {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.names)) throw new HttpError(400, '`names` must be an array of card names');
        const cards: Record<string, CardData> = {};
        const missing: string[] = [];
        for (const name of body.names) {
          if (typeof name !== 'string') continue;
          const card = lookupCard(cardDb, name);
          if (card) cards[name] = card;
          else missing.push(name);
        }
        return sendJson(res, 200, { cards, missing });
      }

      case 'POST /api/deck/import': {
        const body = await readJsonBody(req);
        if (typeof body.url === 'string' && body.url.trim()) {
          let imported;
          try {
            imported = await importDeckFromUrl(body.url.trim(), fetchImpl, { userAgent: process.env.DECK_IMPORT_USER_AGENT });
          } catch (err) {
            throw new HttpError(502, `Could not import deck from URL: ${err instanceof Error ? err.message : String(err)}`);
          }
          return sendJson(res, 200, resolveDeck(cardDb, imported, extraWarnings));
        }
        if (typeof body.text === 'string' && body.text.trim()) {
          return sendJson(res, 200, resolveDeck(cardDb, parseDeckText(body.text), extraWarnings));
        }
        throw new HttpError(400, 'Provide either `url` or `text`');
      }

      default:
        throw new HttpError(404, `No route ${route}`);
    }
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!staticDir) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const rel = path.posix.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|$))+/, '');
    let file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir)) return false;
    if (!isFile(file)) {
      // SPA fallback: anything that is not a real asset gets index.html.
      if (path.extname(rel) && rel !== '/') return false;
      file = path.join(staticDir, 'index.html');
      if (!isFile(file)) return false;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  const httpServer = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await api(req, res, url);
        return;
      }
      if (await serveStatic(req, res, url)) return;
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else {
        log.error(`${req.method} ${url.pathname}`, err);
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
      }
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (data) => {
      let msg;
      try {
        msg = decodeClient(data.toString());
      } catch {
        socket.send(encode({ type: 'error', message: 'Invalid JSON', code: 'BAD_JSON' }));
        return;
      }
      rooms.handleMessage(socket, msg);
    });
    socket.on('close', () => rooms.handleClose(socket));
    socket.on('error', (err) => log.error('socket error', err));
  });

  const port = opts.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, opts.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  log.info(`listening on http://${opts.host ?? 'localhost'}:${boundPort} (ws ${WS_PATH}, ${cardDb.size} cards${staticDir ? `, static ${staticDir}` : ''})`);

  return {
    httpServer,
    wss,
    rooms,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        rooms.close();
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections?.();
        });
      }),
  };
}

function resolveStaticDir(dir: string): string | null {
  const abs = path.resolve(dir);
  return existsSync(abs) && statSync(abs).isDirectory() ? abs : null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
