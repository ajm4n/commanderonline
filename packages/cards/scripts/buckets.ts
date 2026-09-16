/** Bucket unhandled lines by shape (trigger heads, statics, effect verbs) to find parser gaps: `npx tsx scripts/buckets.ts`. */
import { loadCardDb } from '../src/db-node.js';
import { compileCard } from '../src/compiler/index.js';
const db = await loadCardDb();
const heads = new Map<string, number>(); const verbs = new Map<string, number>(); const statics = new Map<string, number>();
const ex = new Map<string, string>();
const norm = (u: string) => u.replace(/\{[^}]+\}/g, '{M}').replace(/\b\d+\b/g, 'N');
let total = 0;
for (const c of db.all()) {
  const r = compileCard(c);
  for (const u0 of r.unhandledLines) {
    total++;
    const u = norm(u0);
    let key: string; let map: Map<string, number>;
    const m = u.match(/^(When(?:ever)?|At the beginning of) (.{0,40}?)(?:,|$)/);
    if (m) { key = `${m[1]} ${m[2]}`.split(' ').slice(0, 6).join(' '); map = heads; }
    else if (/^(~|Enchanted|Equipped|Creatures|Each|Other|All|You|Your|Spells|Nonbasic|Lands|Artifacts|Players|Permanents)\b/.test(u) && !/^(You|Your) (may|gain|lose|draw|get|create|choose|search|reveal|put|return|exile|sacrifice|discard|scry|mill|shuffle|control|have no|cannot lose|win)/.test(u)) { key = u.split(' ').slice(0, 5).join(' '); map = statics; }
    else { key = u.split(' ').slice(0, 2).join(' ').toLowerCase(); map = verbs; }
    map.set(key, (map.get(key) ?? 0) + 1);
    if (!ex.has(key)) ex.set(key, u0.slice(0, 110));
  }
}
console.log('unhandled lines total', total);
const dump = (title: string, m: Map<string, number>, n: number) => { console.log(`\n${title}`); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`${v.toString().padStart(5)}  ${k.padEnd(45)}  e.g. ${ex.get(k)}`); };
dump('Trigger heads', heads, 40); dump('Statics', statics, 40); dump('Effect verbs', verbs, 50);
