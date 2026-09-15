/** Print how given cards compile: `npx tsx scripts/probe.ts "Card Name" ...` (set DUMP=1 for the full script). */
import { loadCardDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
import { normalizeOracle } from '../src/compiler/text.js';
const db = await loadCardDb();
const names = process.argv.slice(2);
for (const n of names) {
  const c = db.byName(n) ?? db.byName(n.split(' // ')[0]);
  if (!c) { console.log(`MISSING ${n}`); continue; }
  const r = compileCard(c);
  console.log(`\n## ${n} [${r.script.coverage}]`);
  for (const l of normalizeOracle(c)) console.log(`   | ${l}`);
  for (const u of r.unhandledLines) console.log(`   - UNHANDLED: ${u}`);
  if (process.env.DUMP) console.log(JSON.stringify(r.script.abilities, null, 1).slice(0, 3000));
}
