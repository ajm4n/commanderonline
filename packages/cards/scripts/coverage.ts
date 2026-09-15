/** Compile every card in the DB and report how much of the pool is automated. */
import { loadCardDb, loadFixtureDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
import { writeFileSync } from 'node:fs';

const db = await loadCardDb().catch(() => loadFixtureDb());
const cards = db.all().filter((c) => !/Land/.test(c.typeLine) || c.oracleText.split('\n').length > 1);
const counts = { full: 0, partial: 0, none: 0 };
const unhandled = new Map<string, number>();
const examples = new Map<string, string>();
const t0 = Date.now();
for (const c of db.all()) {
  const r = compileCard(c);
  counts[r.script.coverage]++;
  for (const u of r.unhandledLines) {
    const key = u.replace(/\{[^}]+\}/g, '{M}').replace(/\b\d+\b/g, 'N').slice(0, 90);
    unhandled.set(key, (unhandled.get(key) ?? 0) + 1);
    if (!examples.has(key)) examples.set(key, c.name);
  }
}
const total = db.all().length;
console.log(`Cards: ${total}  (${Date.now() - t0}ms)`);
for (const k of ['full', 'partial', 'none'] as const) console.log(`  ${k.padEnd(8)} ${counts[k].toString().padStart(6)}  ${((100 * counts[k]) / total).toFixed(1)}%`);
const top = [...unhandled.entries()].sort((a, b) => b[1] - a[1]).slice(0, parseInt(process.argv[2] ?? '60', 10));
console.log('\nMost common unhandled lines:');
for (const [k, n] of top) console.log(`${n.toString().padStart(5)}  ${k}   [${examples.get(k)}]`);
writeFileSync(new URL('../data/coverage.json', import.meta.url), JSON.stringify({ total, counts, generatedAt: new Date().toISOString() }, null, 2));
void cards;
