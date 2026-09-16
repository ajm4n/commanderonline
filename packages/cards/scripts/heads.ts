/** Rank trigger lines whose head the compiler cannot parse: `npx tsx scripts/heads.ts` */
import { loadCardDb } from '../src/db-node.js';
import { normalizeOracle } from '../src/compiler/text.js';
import { parseTriggerHead } from '../src/compiler/triggers.js';
const db = await loadCardDb();
const m = new Map<string, number>(); const ex = new Map<string, string>();
let total = 0, failed = 0;
for (const c of db.all()) {
  for (const line of normalizeOracle(c)) {
    if (!/^(When|Whenever|At the beginning)/i.test(line)) continue;
    total++;
    if (parseTriggerHead(line)) continue;
    failed++;
    const head = line.split(',')[0].replace(/\{[^}]+\}/g, '{M}').replace(/\b\d+\b/g, 'N');
    const key = head.split(' ').slice(0, 7).join(' ');
    m.set(key, (m.get(key) ?? 0) + 1);
    if (!ex.has(key)) ex.set(key, head.slice(0, 120));
  }
}
console.log(`trigger lines ${total}, unparsed heads ${failed}`);
for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 70)) console.log(`${v.toString().padStart(5)}  ${ex.get(k)}`);
