import { loadCardDb } from '../../src/db-node.js';
import { compileCard } from '../../src/compiler/index.js';
const db = await loadCardDb();
const key = (u: string) => u.replace(/\{[^}]+\}/g, '{M}').replace(/\b\d+\b/g, 'N').slice(0, 100);
const noneBy = new Map<string, number>(); const oneBy = new Map<string, number>(); const types = new Map<string, [number, number]>();
const ex = new Map<string, string>();
let none = 0, partial1 = 0;
for (const c of db.all()) {
  const r = compileCard(c);
  const t = c.typeLine.split(' — ')[0].replace(/^Legendary /, '').replace(/^Basic /, '').replace(/^Snow /, '');
  const tt = types.get(t) ?? [0, 0]; tt[0]++; if (r.script.coverage === 'full') tt[1]++; types.set(t, tt);
  if (r.script.coverage === 'none') { none++; for (const u of r.unhandledLines) { const k = key(u); noneBy.set(k, (noneBy.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, c.name); } }
  if (r.script.coverage === 'partial' && r.unhandledLines.length === 1) { partial1++; const k = key(r.unhandledLines[0]); oneBy.set(k, (oneBy.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, c.name); }
}
console.log('none cards', none, 'partial with exactly one unhandled line', partial1);
console.log('\nBy type (total / full%):');
for (const [t, [n, f]] of [...types].sort((a, b) => b[1][0] - a[1][0]).slice(0, 12)) console.log(`  ${t.padEnd(28)} ${n.toString().padStart(6)}  ${((100 * f) / n).toFixed(0)}%`);
console.log('\nTop unhandled in NONE cards:');
for (const [k, n] of [...noneBy].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(`${n.toString().padStart(5)}  ${k}   [${ex.get(k)}]`);
console.log('\nTop single blockers in PARTIAL cards:');
for (const [k, n] of [...oneBy].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(`${n.toString().padStart(5)}  ${k}   [${ex.get(k)}]`);
