import { loadCardDb } from '../../src/db-node.js';
import { scriptFor } from '../../src/index.js';
const db = await loadCardDb();
const names = ['Tinybones, Pocket Nuisance','Tinybones, Trinket Thief','Tinybones, Bauble Burglar','Tinybones, the Pickpocket','Bone Miser','Cut Down','Final Parting','Peer into the Abyss','Sidisi, Undead Vizier','Undying Malice','Waste Not','Whispersilk Cloak','Words of Waste','Archfiend of Ifnir','Bojuka Bog','Chain of Smog','Containment Construct','Dread Summons','Erebos, God of the Dead','Exsanguinate','Feed the Swarm','Gray Merchant of Asphodel','Leechridden Swamp','Nezumi Shortfang','Nightmare Void','Painful Quandary','Professor Onyx','Quest for the Nihil Stone','Syr Konrad, the Grim','Wishclaw Talisman',"Witch's Cottage","Captain N'ghathrod",'Benny, Platinum Thief','Sol Ring','Arcane Signet','Mind Stone','Charcoal Diamond','Commander\'s Sphere','Thought Vessel','Bloodchief Ascension','Liliana\'s Caress','Megrim','Raiders\' Wake','Burglar Rat','Kitesail Freebooter','Hymn to Tourach','Mind Rot','Dark Deal','Burning Inquiry','Windfall','Necrogen Mists','Bottomless Pit','Oppression','Tergrid, God of Fright // Tergrid\'s Lantern','Geth\'s Grimoire','Blood Artist','Zulaport Cutthroat','Bastion of Remembrance','Vito, Thorn of the Dusk Rose','Sanguine Bond','Exquisite Blood','Toxic Deluge','Damnation','Black Sun\'s Zenith','Necropotence','Phyrexian Arena','Dark Ritual','Cabal Coffers','Urborg, Tomb of Yawgmoth','Reliquary Tower','Command Tower','Swamp'];
let full = 0;
for (const n of names) {
  const c = db.byName(n) ?? db.byName(n.split(' // ')[0]);
  if (!c) { console.log(`MISSING ${n}`); continue; }
  const s = scriptFor(c);
  if (s.coverage === 'full') { full++; continue; }
  console.log(`\n## ${n} [${s.coverage}]`);
  for (const u of s.unhandledText ?? []) console.log(`   - ${u}`);
}
console.log(`\nfull: ${full}/${names.length}`);
