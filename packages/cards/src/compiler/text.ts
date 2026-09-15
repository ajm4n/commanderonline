/** Text utilities for the oracle compiler. */
import type { CardData } from '@commander/engine';

export const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fifteen: 15, twenty: 20 };

export function wordToNumber(w: string | undefined): number | 'X' | null {
  if (w === undefined) return null;
  const t = w.trim().toLowerCase();
  if (t === 'x') return 'X';
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  return null;
}

const ABILITY_WORDS = /^(Landfall|Constellation|Battalion|Heroic|Raid|Ferocious|Morbid|Metalcraft|Threshold|Delirium|Revolt|Adamant|Hellbent|Magecraft|Pack tactics|Coven|Alliance|Celebration|Descend \d+|Fathomless descent|Valiant|Eerie|Survival|Council's dilemma|Will of the council|Parley|Tempting offer|Join forces|Secret council|Lieutenant|Inspired|Enrage|Domain|Kinship|Sweep|Grandeur|Chroma|Addendum|Undergrowth|Formidable|Bloodrush|Channel|Converge|Spell mastery|Rally|Cohort|Corrupted|Paradox|Flurry|Renew|Max speed|Void|Job select|Cosmic|Mayhem|Eminence|Legacy|Strive|Fateful hour|Imprint|Radiance|Hellbent|Join forces|Tempting offer|Parley|Enlist|Exhaust|Mobilize|Harmonize|Behold|Station|Warp|Freerunning|Plot|Saddle|Spree|Suspect|Cloak|Collect evidence|Solved|Explore|Ravenous|Backup|Read ahead|Unlock|Lock|Prowess|Choose one|Choose two|Choose one or both|Choose any number|Choose one or more|Choose two or more|Choose up to two|Choose three|Threshold|Vehicle|Alliance|Descend)\s*—\s*/i;

/** Short name: "Krenko, Mob Boss" → "Krenko"; also the first word for names like "Sun Titan"? No — only comma-split. */
export function shortName(name: string): string | null {
  const i = name.indexOf(',');
  if (i > 0) return name.slice(0, i);
  return null;
}

/** Replace self-references with "~", strip reminder text, normalize wording. */
export function normalizeOracle(card: CardData, faceName = card.name, text = card.oracleText): string[] {
  let t = text ?? '';
  // Strip reminder text (parenthesized) but keep the rest.
  t = t.replace(/\s*\([^()]*\)/g, '');
  const names = [faceName];
  const sn = shortName(faceName);
  if (sn) names.push(sn);
  // Planeswalkers refer to themselves by first name ("Ajani deals 3 damage").
  if (/Planeswalker/.test(card.typeLine) && !faceName.includes(',') && faceName.includes(' ')) {
    const first = faceName.split(' ')[0];
    if (first.length >= 3 && /^[A-Z]/.test(first)) names.push(first);
  }
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(esc + "'s", 'g'), "~'s");
    t = t.replace(new RegExp(esc, 'g'), '~');
  }
  t = t.replace(/\b[Tt]his (creature|permanent|artifact|enchantment|land|spell|card|planeswalker|Aura|Equipment|Vehicle|token|battle)\b/g, '~');
  t = t.replace(/\benters the battlefield\b/g, 'enters');
  t = t.replace(/\bput onto the battlefield\b/g, 'put onto the battlefield');
  t = t.replace(/\bmana value\b/g, 'mana value');
  t = t.replace(/\bconverted mana cost\b/g, 'mana value');
  t = t.replace(/\bThat's\b/g, 'That is').replace(/\bthat's\b/g, 'that is');
  t = t.replace(/\bcan't\b/gi, 'cannot');
  t = t.replace(/\bdoesn't\b/gi, 'does not');
  t = t.replace(/\bdon't\b/gi, 'do not');
  t = t.replace(/\bisn't\b/gi, 'is not');
  t = t.replace(/\bIt's\b/g, 'It is').replace(/\bit's\b/g, 'it is');
  t = t.replace(/\bThey're\b/g, 'They are').replace(/\bthey're\b/g, 'they are');
  t = t.replace(/\bhis or her\b/g, 'their');
  t = t.replace(/\bhe or she\b/g, 'they');
  t = t.replace(/\bhim or her\b/g, 'them');
  t = t.replace(/\bcomes into play\b/g, 'enters');
  t = t.replace(/\bis put into a graveyard from the battlefield\b/g, 'dies');
  t = t.replace(/\bis put into your graveyard from the battlefield\b/g, 'dies');
  t = t.replace(/\bare put into a graveyard from the battlefield\b/g, 'die');
  t = t.replace(/\bin play\b/g, 'on the battlefield');
  return t
    .split('\n')
    .map((l) => l.replace(ABILITY_WORDS, (m) => (/^Choose/i.test(m) ? m : '')).trim())
    .map(stripAbilityWord)
    .filter(Boolean);
}

/** Keyword abilities that also use an em dash and must keep their prefix. */
const DASH_KEYWORDS = /^(Choose|Companion|Boast|Escape|Suspend|Awaken|Reinforce|Impending|Ward|Flashback|Prototype|Cleave|Cycling|Equip|Level up|Splice|Spree|Champion|Gift|Emerge|Casualty|Offspring|Squad|Kicker|Multikicker|Madness|Morph|Disguise|Foretell|Blitz|Dash|Bestow|Embalm|Eternalize|Unearth|Encore|Mutate|Surge|Evoke|Ninjutsu|Buyback|Entwine|Transmute|Recover|Miracle|Outlast|Prowl|Fortify|Aura swap|Freerunning|Escalate|Overload|Emerge|Scavenge|Adapt|Amass|Craft|Umbra armor|Exhaust|Max speed|Start your engines!|Tiered|Saddle|Crew|Station|Warp|Plot|Ravenous|Backup|Class|LEVEL|STATION)\b/i;

/** Custom ability words ("Mystic Arcanum — At the beginning of ...") are flavor labels: drop them. */
export function stripAbilityWord(line: string): string {
  const m = line.match(/^([A-Z][A-Za-z']*(?: [A-Za-z']+){0,3}) — (?=[A-Z{~•])/);
  if (!m) return line;
  if (DASH_KEYWORDS.test(m[1])) return line;
  if (/^(?:I|II|III|IV|V|VI)(?:, (?:I|II|III|IV|V|VI))*$/.test(m[1])) return line; // Saga chapters
  return line.slice(m[0].length);
}

/** Split a line into sentences on ". " boundaries, keeping mana symbols intact. */
export function sentences(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    cur += c;
    if (c === '.' && (i === line.length - 1 || line[i + 1] === ' ')) {
      // Don't split decimals or "e.g."
      out.push(cur.trim());
      cur = '';
      i++; // skip space
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((s) => s.replace(/\.$/, '').trim()).filter(Boolean);
}

export function lc(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
