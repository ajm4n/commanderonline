/** Rebuild data/fixtures/sample-cards.json from Scryfall (run: node scripts/build-fixture.mjs). */
import { writeFileSync } from 'node:fs';
const NAMES = [
  'Plains','Island','Swamp','Mountain','Forest','Command Tower','Sol Ring','Arcane Signet','Lightning Bolt','Counterspell',
  'Swords to Plowshares','Rampant Growth','Cultivate','Llanowar Elves','Grizzly Bears','Serra Angel','Shivan Dragon','Wrath of God',
  'Divination','Opt','Ponder','Brainstorm','Dark Ritual','Doom Blade','Murder','Giant Growth','Naturalize','Disenchant','Beast Within',
  'Rhystic Study','Smothering Tithe','Dockside Extortionist','Krenko, Mob Boss','Elesh Norn, Grand Cenobite','Avenger of Zendikar',
  'Sun Titan','Mulldrifter','Solemn Simulacrum','Burnished Hart','Wood Elves','Farhaven Elf','Skullclamp','Lightning Greaves',
  'Swiftfoot Boots','Cyclonic Rift','Blasphemous Act','Toxic Deluge','Path to Exile','Rancor','Pacifism','Zulaport Cutthroat',
  'Blood Artist',"Kodama's Reach",'Explosive Vegetation','Prosper, Tome-Bound',"Atraxa, Praetors' Voice",'Edgar Markov',
  'Ezuri, Renegade Leader',"Gishath, Sun's Avatar",'Omnath, Locus of Rage','Kenrith, the Returned King','Delina, Wild Mage',
  'Rograkh, Son of Rohgahh','Jeska, Thrice Reborn','Tatyova, Benthic Druid','Valakut Exploration','Fabled Passage','Evolving Wilds',
  'Elvish Mystic','Fyndhorn Elves',"Thassa's Oracle",'Demonic Consultation','Craterhoof Behemoth','Eternal Witness','Reclamation Sage',
  'Acidic Slime','Fierce Guardianship','Deflecting Swat',"Teferi's Protection",'Heroic Intervention','Wear',
  'Bonecrusher Giant','Valki, God of Lies','Delver of Secrets',
  // Tinybones / discard deck cards used by test/tinybones.test.ts
  'Tinybones, Pocket Nuisance','Tinybones, Trinket Thief','Bone Miser','Bojuka Bog',"Witch's Cottage",'Undying Malice','Syr Konrad, the Grim',
  'Sanguine Bond','Erebos, God of the Dead','Cut Down','Painful Quandary','Peer into the Abyss','Dark Deal','Wishclaw Talisman','Necropotence',
  'Leyline of the Void','Waste Not','Quest for the Nihil Stone','Feed the Swarm','Leechridden Swamp','Whispersilk Cloak','Urborg, Tomb of Yawgmoth',
  'Gray Merchant of Asphodel','Nezumi Shortfang','Vito, Thorn of the Dusk Rose','Exsanguinate','Words of Waste','Archfiend of Ifnir',
];
const SETS = { Plains: 'fdn', Island: 'fdn', Swamp: 'fdn', Mountain: 'fdn', Forest: 'fdn', 'Demonic Consultation': 'ice', 'Sol Ring': 'c21', 'Command Tower': 'cmr', 'Arcane Signet': 'eld', 'Lightning Bolt': 'clb' };
const FACE_KEYS = ['object','name','mana_cost','type_line','oracle_text','colors','power','toughness','loyalty','defense','flavor_name','image_uris','oracle_id'];
const KEYS = ['object','id','oracle_id','name','lang','released_at','layout','mana_cost','cmc','type_line','oracle_text','power','toughness','loyalty','defense','colors','color_identity','keywords','card_faces','image_uris','legalities','produced_mana','set','set_name','collector_number','rarity','games','digital','reserved'];
const pickImgs = (u) => u && { small: u.small, normal: u.normal, large: u.large, art_crop: u.art_crop };
function trim(c) {
  const out = {};
  for (const k of KEYS) if (c[k] !== undefined) out[k] = c[k];
  if (out.image_uris) out.image_uris = pickImgs(out.image_uris);
  if (out.card_faces) out.card_faces = out.card_faces.map((f) => { const o = {}; for (const k of FACE_KEYS) if (f[k] !== undefined) o[k] = f[k]; if (o.image_uris) o.image_uris = pickImgs(o.image_uris); return o; });
  return out;
}
const headers = { 'User-Agent': 'CommanderOnline/0.1', Accept: 'application/json', 'Content-Type': 'application/json' };
const cards = []; const notFound = [];
for (let i = 0; i < NAMES.length; i += 70) {
  const chunk = NAMES.slice(i, i + 70);
  const res = await fetch('https://api.scryfall.com/cards/collection', { method: 'POST', headers, body: JSON.stringify({ identifiers: chunk.map((name) => SETS[name] ? { name, set: SETS[name] } : { name }) }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  notFound.push(...(json.not_found ?? []));
  cards.push(...json.data.map(trim));
  await new Promise((r) => setTimeout(r, 200));
}
console.log('fetched', cards.length, 'not found', JSON.stringify(notFound));
const digital = cards.filter((c) => c.digital || !c.games?.includes('paper')).map((c) => c.name + ' ' + c.set);
console.log('digital/non-paper printings:', digital);
console.log('sets:', cards.map((c) => `${c.name} [${c.set}] ${c.layout}`).join('\n'));
writeFileSync(new URL('../data/fixtures/sample-cards.json', import.meta.url), JSON.stringify(cards, null, 2) + '\n');
