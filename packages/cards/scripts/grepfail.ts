/** Sample unhandled lines matching a regex: `npx tsx scripts/grepfail.ts "you may pay" [count]` */
import { loadCardDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
const db = await loadCardDb();
const re = new RegExp(process.argv[2] ?? '.', 'i');
const max = Number(process.argv[3] ?? 25);
let total = 0; const out: string[] = [];
for (const c of db.all()) {
  const r = compileCard(c);
  for (const u of r.unhandledLines) {
    if (!re.test(u)) continue;
    total++;
    if (out.length < max) out.push(`[${c.name}] ${u.slice(0, 200)}`);
  }
}
console.log(`matches: ${total}`);
for (const o of out) console.log(o);
