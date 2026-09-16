/** Drill into unhandled sentences by leading words: `npx tsx scripts/deep.ts "you may" "as long" ...` */
import { loadCardDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
const db = await loadCardDb();
const prefixes = process.argv.slice(2).map((p) => p.toLowerCase());
const norm = (u: string) => u.replace(/\{[^}]+\}/g, '{M}').replace(/\b\d+\b/g, 'N');
const buckets = new Map<string, Map<string, number>>(); const ex = new Map<string, string>();
for (const p of prefixes) buckets.set(p, new Map());
for (const c of db.all()) {
  const r = compileCard(c);
  for (const u0 of r.unhandledLines) {
    let u = norm(u0);
    // Trigger lines are reported as "head, effect": look at the effect part too.
    const parts = [u];
    const tm = u.match(/^(?:When(?:ever)?|At the beginning of)[^,]*, (.+)$/);
    if (tm) parts.push(tm[1].charAt(0).toUpperCase() + tm[1].slice(1));
    for (const part of parts) {
      const l = part.toLowerCase();
      for (const p of prefixes) {
        if (!l.startsWith(p + ' ') && l !== p) continue;
        const rest = part.slice(p.length).trim();
        const key = rest.split(' ').slice(0, 4).join(' ');
        const m = buckets.get(p)!;
        m.set(key, (m.get(key) ?? 0) + 1);
        if (!ex.has(p + key)) ex.set(p + key, u0.slice(0, 120));
      }
    }
  }
}
for (const p of prefixes) {
  const m = buckets.get(p)!;
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  console.log(`\n=== "${p}" (${total}) ===`);
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toString().padStart(5)}  ${k.padEnd(40)}  e.g. ${ex.get(p + k)}`);
}
