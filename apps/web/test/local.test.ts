import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '@commander/protocol';
import type { CardData } from '@commander/engine';
import { LocalConnection } from '../src/lib/connection.js';
import { defaultAnswer } from '../src/lib/bots.js';
import { basicLand, computeCoverage } from '../src/lib/deck.js';
import { parseDeckText } from '@commander/deck-import';

function card(p: Partial<CardData> & { name: string; typeLine: string }): CardData {
  return { oracleId: `oracle:${p.name}`, layout: 'normal', manaCost: '', cmc: 0, oracleText: '', colors: [], colorIdentity: [], keywords: [], ...p };
}
const BEARS = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2', colors: ['G'], colorIdentity: ['G'] });
const BOLT = card({ name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{R}', cmc: 1, oracleText: 'Lightning Bolt deals 3 damage to any target.', colors: ['R'], colorIdentity: ['R'] });
const ELVES = card({ name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid', manaCost: '{G}', cmc: 1, power: '1', toughness: '1', oracleText: '{T}: Add {G}.', colors: ['G'], colorIdentity: ['G'] });
const CMDR = card({ name: 'Test Commander', typeLine: 'Legendary Creature — Human Warrior', manaCost: '{2}{G}', cmc: 3, power: '5', toughness: '5', oracleText: 'Trample', keywords: ['Trample'], colors: ['G'], colorIdentity: ['G'] });

function deck() {
  const main: CardData[] = [];
  for (let i = 0; i < 40; i++) main.push(i % 4 === 0 ? BEARS : i % 4 === 1 ? ELVES : i % 4 === 2 ? BOLT : basicLand('Forest'));
  for (let i = 0; i < 20; i++) main.push(basicLand(i % 2 ? 'Forest' : 'Mountain'));
  return { name: 'Test', commanders: [CMDR], mainboard: main };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LocalConnection', () => {
  it('runs a lobby and a game against bots entirely in-process', async () => {
    const conn = new LocalConnection({ botDelayMs: 0, seed: 7 });
    const msgs: ServerMessage[] = [];
    conn.subscribe((m) => msgs.push(m));
    conn.send({ type: 'createRoom', playerName: 'Tester' });
    expect(msgs.find((m) => m.type === 'welcome')).toBeTruthy();
    expect(msgs.find((m) => m.type === 'lobby')).toBeTruthy();
    conn.send({ type: 'startGame' });
    expect(msgs.some((m) => m.type === 'error' && m.code === 'noDeck')).toBe(true);
    conn.send({ type: 'setDeck', deck: deck() });
    conn.send({ type: 'addDummy' });
    conn.send({ type: 'addDummy', name: 'Fishy' });
    const lobby = [...msgs].reverse().find((m) => m.type === 'lobby');
    expect(lobby && lobby.type === 'lobby' && lobby.lobby.players.length).toBe(3);
    conn.send({ type: 'startGame' });
    await sleep(5);
    let view = [...msgs].reverse().find((m) => m.type === 'view');
    expect(view && view.type === 'view').toBeTruthy();
    // Drive the human with default answers for a while; bots answer on timers.
    let turns = 0;
    let lastVersion = -1;
    for (let i = 0; i < 400; i++) {
      const v = [...msgs].reverse().find((m) => m.type === 'view');
      if (!v || v.type !== 'view') break;
      if (v.view.over) break;
      turns = Math.max(turns, v.view.turn.number);
      if (v.view.decision && v.view.version !== lastVersion) {
        lastVersion = v.view.version;
        conn.send({ type: 'decision', decisionId: v.view.decision.id, response: defaultAnswer(v.view.decision) });
      }
      await sleep(2);
    }
    view = [...msgs].reverse().find((m) => m.type === 'view');
    expect(view && view.type === 'view' && view.view.turn.number).toBeGreaterThan(1);
    const errors = msgs.filter((m) => m.type === 'error' && m.code !== 'noDeck');
    expect(errors.map((e) => (e.type === 'error' ? e.message : ''))).toEqual([]);
    // Manual actions work at any time.
    const before = view!.type === 'view' ? view!.view.players.find((p) => p.id === 'you')!.life : 0;
    conn.send({ type: 'manual', action: { kind: 'adjustLife', playerId: 'you', delta: -3 } });
    await sleep(2);
    const after = [...msgs].reverse().find((m) => m.type === 'view');
    expect(after && after.type === 'view' && after.view.players.find((p) => p.id === 'you')!.life).toBe(before - 3);
    conn.close();
  });

  it('computes coverage with the real script provider', () => {
    const stats = computeCoverage([BOLT, ELVES, basicLand('Forest'), card({ name: 'Weird Thing', typeLine: 'Enchantment', oracleText: 'Whenever you do something odd, the engine cannot handle it. Then do it twice.' })]);
    expect(stats.full + stats.partial + stats.none).toBe(4);
    expect(stats.manual.length).toBeGreaterThanOrEqual(0);
  });

  it('parses a decklist', () => {
    const d = parseDeckText('Commander\n1 Zada, Hedron Grinder\n\nDeck\n1 Sol Ring\n30 Mountain');
    expect(d.commanders[0].name).toBe('Zada, Hedron Grinder');
    expect(d.mainboard.reduce((a, e) => a + e.quantity, 0)).toBe(31);
  });
});
