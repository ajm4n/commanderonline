/** Text utilities for the oracle compiler. */
import type { CardData } from '@commander/engine';

export const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };

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
  // Rebalanced (Alchemy) cards mark their changed words with square brackets; the text inside is the real text.
  t = t.replace(/\[([^\[\]]*)\]/g, '$1');
  const names = [faceName];
  for (const f of card.faces ?? []) if (f.name && f.name !== faceName) names.push(f.name);
  const sn = shortName(faceName);
  if (sn) names.push(sn);
  for (const f of card.faces ?? []) {
    const fs = f.name ? shortName(f.name) : null;
    if (fs && !names.includes(fs)) names.push(fs);
  }
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
  // Legendary/planeswalker cards sometimes use a nickname built from their own name words
  // ("Captain James T. Kirk" → "Captain Kirk"): replace variants keeping the first and last word.
  if (/Legendary|Planeswalker/.test(card.typeLine) && /\s/.test(faceName)) {
    const ws = faceName.replace(/,/g, '').split(/\s+/).filter(Boolean);
    if (ws.length >= 3 && ws.length <= 6 && /^[A-Z]/.test(ws[0]) && /^[A-Z]/.test(ws[ws.length - 1])) {
      const mid = ws.slice(1, -1);
      const variants: string[] = [];
      for (let mask = 0; mask < 1 << mid.length; mask++) {
        const keep = mid.filter((_w, i) => (mask >> i) & 1);
        variants.push([ws[0], ...keep, ws[ws.length - 1]].join(' '));
      }
      variants.sort((a, b) => b.length - a.length);
      for (const v of variants) {
        if (v === faceName) continue;
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(`\\b${esc}'s`, 'g'), "~'s");
        t = t.replace(new RegExp(`\\b${esc}\\b`, 'g'), '~');
      }
    }
  }
  // Legendary permanents without a comma sometimes refer to themselves by their first name ("Catti-brie of Mithral Hall" → "Catti-brie").
  if (/Legendary/.test(card.typeLine) && !faceName.includes(',') && faceName.includes(' ')) {
    const first = faceName.split(' ')[0];
    if (first.length >= 4 && /^[A-Z][a-zà-ÿÀ-Ÿ]/u.test(first) && !/'s$/.test(first) && !/^(The|Sword|Shield|Tower|Temple|Throne|Hall|Book|Staff|Crown|Ring|Blade|Gate|Cradle|Academy|Palace|Hammer|Heart|Scroll|Mask)$/.test(first)) {
      const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\b${esc}'s\\b`, 'g'), "~'s").replace(new RegExp(`\\b${esc}\\b(?! [A-Z])`, 'g'), '~');
    }
  }
  t = t.replace(/\b[Tt]his (creature|permanent|artifact|enchantment|land|spell|card|planeswalker|Aura|Equipment|Vehicle|token|battle|Class|Spacecraft|Case|Siege|Room|Saga|Contraption)\b/g, '~');
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
  t = t.replace(/\b(?:He|She) (deals|gets|gains|has|is|becomes|cannot|can't|attacks|blocks|fights|enters)\b/g, '~ $1').replace(/\b(?:he|she) (deals|gets|gains|has|is|becomes|cannot|can't|attacks|blocks|fights|enters)\b/g, '~ $1');
  t = t.replace(/\b(counters? on) (?:her|him)\b/g, '$1 it');
  t = t.replace(/\b(transform|untap|tap|exile|sacrifice|return|destroy) (?:her|him)\b/g, '$1 ~');
  t = t.replace(/\b(to|on) (?:her|him)\b(?! (?:power|toughness|controller|owner|hand|library|graveyard))/g, '$1 ~');
  // Universes Beyond cards use gendered pronouns for the card itself.
  t = t.replace(/\b(?:He|She)'s\b/g, 'It is').replace(/\b(?:he|she)'s\b/g, 'it is');
  t = t.replace(/\b(?:he|she) (was|is|has|isn't|is not|was not|wasn't|would|dealt|deals|attacked|blocked|entered|died|left)\b/g, 'it $1').replace(/\b(?:He|She) (was|is|has|is not|was not|would|dealt|attacked|blocked|entered|died|left)\b/g, 'It $1');
  t = t.replace(/\b(?:his|her) (power|toughness|name|owner|owner's|controller|controller's|mana value|mana cost|other types|base|colors?|abilities|activated abilities|triggered abilities|types|loyalty)\b/g, 'its $1').replace(/\b(?:His|Her) (power|toughness|name|owner|controller|mana value|base|colors?|abilities|types|loyalty)\b/g, 'Its $1');
  t = t.replace(/\b(?:himself|herself)\b/g, 'itself');
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
    // Flavor words ("Nitro-9 — Whenever ~ attacks", "Power-up — {5}: ...") are decorative: strip anything dash-prefixed that isn't a real keyword or Saga chapter.
    .map((l) => l.replace(/^([A-Z][\w' !,.-]{1,40}?) — (?=[A-Z{~•+−-])/, (m0, w: string) => (DASH_KEYWORDS.test(w) || /^(I|II|III|IV|V|VI)(, (I|II|III|IV|V|VI))*$/.test(w) || /^Choose/i.test(w) || /^To solve$/i.test(w) ? m0 : '')))
    .filter(Boolean);
}

/** Keyword abilities that also use an em dash and must keep their prefix. */
const DASH_KEYWORDS = /^(Choose|Companion|Boast|Escape|Suspend|Awaken|Reinforce|Impending|Ward|Flashback|Prototype|Cleave|Cycling|Equip|Level up|Splice|Spree|Champion|Gift|Emerge|Casualty|Offspring|Squad|Kicker|Multikicker|Madness|Morph|Disguise|Foretell|Blitz|Dash|Bestow|Embalm|Eternalize|Unearth|Encore|Mutate|Surge|Evoke|Ninjutsu|Buyback|Entwine|Transmute|Recover|Miracle|Outlast|Prowl|Fortify|Aura swap|Freerunning|Escalate|Overload|Emerge|Scavenge|Adapt|Amass|Craft|Umbra armor|Exhaust|Max speed|Start your engines!|Tiered|Saddle|Crew|Station|Warp|Plot|Ravenous|Backup|Class|LEVEL|STATION)\b/i;

/** Custom ability words ("Mystic Arcanum — At the beginning of ...") are flavor labels: drop them. */
export function stripAbilityWord(line: string): string {
  const m = line.match(/^([A-Z][A-Za-z']*(?: [A-Za-z']+){0,3}) — (?=[A-Z{~•])/);
  if (!m) return line;
  if (DASH_KEYWORDS.test(m[1])) return line;
  if (/^To solve$/i.test(m[1])) return line; // Cases: the condition after it is the solve condition
  if (/^(?:I|II|III|IV|V|VI)(?:, (?:I|II|III|IV|V|VI))*$/.test(m[1])) return line; // Saga chapters
  return line.slice(m[0].length);
}

/** Split a line into sentences on ". " boundaries, keeping mana symbols intact. */
export function sentences(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    cur += c;
    if (c === '"') quoted = !quoted;
    // Never split inside quoted ability text ("You get an emblem with \"Creatures you control get +2/+2.\"").
    if (!quoted && c === '.' && (i === line.length - 1 || line[i + 1] === ' ')) {
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
