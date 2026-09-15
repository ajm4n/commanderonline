/** Rank the first unhandled line of every uncompiled card, plus planeswalker samples: `npx tsx scripts/analyze.ts`. */
import { loadCardDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
const db = await loadCardDb();
const key = (u: string) => u.replace(/\{[^}]+\}/g, '{M}').replace(/\b\d+\b/g, 'N').slice(0, 110);
const first = new Map<string, number>(); const ex = new Map<string, string>();
const pw: string[] = [];
for (const c of db.all()) {
  const r = compileCard(c);
  if (r.script.coverage === 'none' && r.unhandledLines.length) { const k = key(r.unhandledLines[0]); first.set(k, (first.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, c.name); }
  if (/Planeswalker/.test(c.typeLine) && r.script.coverage !== 'full' && pw.length < 14) pw.push(`${c.name}: ${r.unhandledLines.map((u) => u.slice(0, 90)).join(' || ')}`);
}
console.log('Top FIRST unhandled line in NONE cards:');
for (const [k, n] of [...first].sort((a, b) => b[1] - a[1]).slice(0, 50)) console.log(`${n.toString().padStart(5)}  ${k}   [${ex.get(k)}]`);
console.log('\nPlaneswalker samples:'); for (const p of pw) console.log(' - ' + p);
