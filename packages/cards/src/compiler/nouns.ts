/** Noun phrase → ObjectFilter / TargetSpec. */
import type { Color, ObjectFilter, TargetSpec, ZoneName } from '@commander/engine';
import { wordToNumber } from './text.js';

const COLOR_WORDS: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const TYPE_WORDS: Record<string, string> = {
  creature: 'Creature',
  creatures: 'Creature',
  artifact: 'Artifact',
  artifacts: 'Artifact',
  enchantment: 'Enchantment',
  enchantments: 'Enchantment',
  land: 'Land',
  lands: 'Land',
  planeswalker: 'Planeswalker',
  planeswalkers: 'Planeswalker',
  instant: 'Instant',
  instants: 'Instant',
  sorcery: 'Sorcery',
  sorceries: 'Sorcery',
  battle: 'Battle',
  battles: 'Battle',
  kindred: 'Kindred',
  tribal: 'Kindred',
};
const SUBTYPE_ALIASES: Record<string, string> = { Aura: 'Aura', Auras: 'Aura', Equipment: 'Equipment', Vehicle: 'Vehicle', Vehicles: 'Vehicle', Saga: 'Saga', Sagas: 'Saga', Treasure: 'Treasure', Treasures: 'Treasure', Food: 'Food', Foods: 'Food', Clue: 'Clue', Clues: 'Clue', Gate: 'Gate', Gates: 'Gate', Desert: 'Desert', Deserts: 'Desert' };
const BASIC_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

export interface ParsedNoun {
  filter: ObjectFilter;
  /** "target" was present */
  target: boolean;
  /** number of targets (1 default), for "up to N target" / "N target" */
  count: number | 'X';
  upTo: boolean;
  /** each/all */
  each: boolean;
  /** "another"/"other" present */
  other: boolean;
  /** "a"/"an" indefinite — for triggers ("a creature") */
  indefinite: boolean;
  /** Whether the noun refers to cards (in graveyard/hand/library) rather than permanents */
  isCard: boolean;
  /** For "target creature or player"/"any target" */
  kind: TargetSpec['kind'];
  playerFilter?: TargetSpec['playerFilter'];
  /** Whether the phrase was fully consumed by known vocabulary. */
  confident: boolean;
  /** The literal phrase for descriptions. */
  text: string;
  /** Head noun was plural ("Creatures you control"). */
  plural: boolean;
}

const CREATURE_TYPE_RE = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/;

/** Words that are capitalized but not creature types. */
const NOT_TYPES = new Set(['If', 'When', 'Whenever', 'At', 'Then', 'You', 'Your', 'Target', 'Each', 'All', 'Another', 'Other', 'Put', 'Return', 'Destroy', 'Exile', 'Create', 'Draw', 'X', 'N', 'Aura', 'Equipment', 'Vehicle', 'Saga', 'Treasure', 'Food', 'Clue', 'Gate', 'Desert', 'Commander']);

export function parseNoun(raw: string): ParsedNoun | null {
  let text = raw.trim().replace(/[.,;]$/, '');
  const result: ParsedNoun = { filter: {}, target: false, count: 1, upTo: false, each: false, other: false, indefinite: false, isCard: false, kind: 'object', confident: true, text: raw.trim(), plural: false };
  let m: RegExpMatchArray | null;

  // Special targets
  if (/^any target$/i.test(text)) return { ...result, target: true, kind: 'any' };
  if ((m = text.match(/^any number of target (players|opponents)$/i))) return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[1]) ? 'opponent' : 'any', count: 6, upTo: true };
  if ((m = text.match(/^any number of target (.+)$/i))) {
    const inner = parseNoun(`target ${m[1]}`);
    return inner ? { ...inner, count: 20, upTo: true } : null;
  }
  if ((m = text.match(/^(?:up to (\w+) )?targets? (players?|opponents?)$/i))) {
    const n = wordToNumber(m[1]);
    return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[2]) ? 'opponent' : 'any', count: n ?? 1, upTo: !!m[1] };
  }
  if ((m = text.match(/^target (creature|permanent|creature or planeswalker) or player$/i))) {
    const inner = parseNoun(m[1]);
    return { ...result, target: true, kind: 'objectOrPlayer', filter: inner?.filter ?? {}, playerFilter: 'any' };
  }
  if ((m = text.match(/^target player or planeswalker$/i))) return { ...result, target: true, kind: 'objectOrPlayer', filter: { types: ['Planeswalker'] }, playerFilter: 'any' };
  if ((m = text.match(/^target opponent or planeswalker$/i))) return { ...result, target: true, kind: 'objectOrPlayer', filter: { types: ['Planeswalker'], controller: 'opponent' }, playerFilter: 'opponent' };
  if ((m = text.match(/^target opponent or battle$/i))) return { ...result, target: true, kind: 'objectOrPlayer', filter: { types: ['Battle'] }, playerFilter: 'opponent' };
  if ((m = text.match(/^target (?:activated or triggered ability|triggered ability|activated ability)$/i))) return { ...result, target: true, kind: 'activatedOrTriggered' };

  // Quantifiers
  text = text.replace(/^each of /i, '');
  if ((m = text.match(/^up to (\w+) (other |another )?target (.+)$/i))) {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    result.upTo = true;
    result.count = n;
    result.target = true;
    if (m[2]) result.other = true;
    text = m[3];
  } else if ((m = text.match(/^(?:another|other) target (.+)$/i))) {
    result.other = true;
    result.target = true;
    text = m[1];
  } else if ((m = text.match(/^(\w+) target (.+)$/i)) && wordToNumber(m[1]) !== null) {
    result.count = wordToNumber(m[1])!;
    result.target = true;
    text = m[2];
  } else if ((m = text.match(/^target (.+)$/i))) {
    result.target = true;
    text = m[1];
  } else if ((m = text.match(/^(?:each|all|every) (.+)$/i))) {
    result.each = true;
    text = m[1];
  } else if ((m = text.match(/^(?:another|other) (.+)$/i))) {
    result.other = true;
    result.indefinite = true;
    text = m[1];
  } else if ((m = text.match(/^(?:a|an) (.+)$/i))) {
    result.indefinite = true;
    text = m[1];
  } else if ((m = text.match(/^(?:one or more) (.+)$/i))) {
    result.indefinite = true;
    text = m[1];
  }
  if ((m = text.match(/^(?:another|other) (.+)$/i))) {
    result.other = true;
    text = m[1];
  }

  // Spells
  if ((m = text.match(/^(.*?)\s*spells?(?: (you control|an opponent controls|you do not control))?$/i))) {
    result.kind = 'spell';
    const pre = m[1].trim();
    if (pre) {
      const f = parseAdjectives(pre.split(/\s+/), result);
      if (!f) return null;
    }
    result.filter.zone = 'stack';
    if (m[2]) result.filter.controller = /you control/i.test(m[2]) ? 'you' : 'opponent';
    return result;
  }

  // Trailing qualifiers
  const quals: string[] = [];
  const QUAL_RE = /\s+(in an opponent's graveyard|from an opponent's graveyard|in that player's graveyard|from that player's graveyard|in their graveyard|from their graveyard|that was put there from (?:their|your|a) library this turn|that were put there from (?:their|your|a) library this turn|put into (?:a|your|their) graveyard from (?:a|your|their) library this turn|with (?:a |an )?[+\-\w\/]+ counters? on (?:it|them)|you control|you own|you do not control|an opponent controls|your opponents control|an opponent owns|you do not own|from your graveyard|in your graveyard|from a graveyard|in a graveyard|from your hand|in your hand|from your library|in your library|from exile|in exile|that is attacking|that is blocking|that is tapped|that is untapped|that has flying|that entered this turn|with (?:power|toughness|mana value) (?:\d+|X) or (?:greater|less)|with (?:power|toughness|mana value) (?:less than|greater than) (?:\d+|X)|with (?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash)|without flying|with a (?:\+1\/\+1|-1\/-1|loyalty|charge) counter on (?:it|them)|with mana value (?:\d+|X)|with total power \d+ or less|with total power and toughness \d+ or less|of the chosen type|of the chosen creature type|with the greatest power among creatures (?:that player|you) controls?|that shares a creature type with ~|that (?:is not|is) a (?:token|commander)|other than ~|not named ~|from among them|of that color|that player controls|that opponent controls|defending player controls|an opponent controls with flying|you control with flying)$/i;
  for (;;) {
    const q = text.match(QUAL_RE);
    if (!q) break;
    quals.unshift(q[1].toLowerCase());
    text = text.slice(0, q.index).trim();
  }
  // Head noun
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let head = words[words.length - 1];
  result.plural = /(?:[^s]s|ies|ches|shes|xes)$/i.test(head) && !/^(?:this|~|us)$/i.test(head) && !/ss$/i.test(head) || /^(?:creatures|artifacts|enchantments|lands|planeswalkers|permanents|spells|cards|tokens|opponents|players)$/i.test(head);
  let adjWords = words.slice(0, -1);
  // "card"/"cards" head → previous word is the real type ("creature card"), unless it is an
  // adjective ("nonland card", "black card"), in which case the card can be anything.
  if (/^cards?$/i.test(head)) {
    result.isCard = true;
    const prev = adjWords.length ? adjWords[adjWords.length - 1] : undefined;
    const probe: ParsedNoun = { ...result, filter: {} };
    if (prev && !(prev.toLowerCase() in TYPE_WORDS) && !(prev in SUBTYPE_ALIASES) && !CREATURE_TYPE_RE.test(prev) && parseAdjectives([prev], probe)) head = 'card';
    else {
      head = prev ?? 'card';
      adjWords = adjWords.slice(0, -1);
    }
  }
  // "token"/"tokens" head
  if (/^tokens?$/i.test(head)) {
    result.filter.isToken = true;
    if (adjWords.length) {
      head = adjWords[adjWords.length - 1];
      adjWords = adjWords.slice(0, -1);
    } else head = 'permanent';
  }
  // "permanent"
  if (/^permanents?$/i.test(head)) {
    // no type restriction
  } else if (/^(?:nonland )?permanents?$/i.test(head)) {
    result.filter.nonland = true;
  } else if (head.toLowerCase() in TYPE_WORDS) {
    result.filter.types = [TYPE_WORDS[head.toLowerCase()]];
  } else if (head in SUBTYPE_ALIASES) {
    result.filter.subtypes = [SUBTYPE_ALIASES[head]];
    if (['Aura', 'Equipment', 'Vehicle', 'Saga'].includes(SUBTYPE_ALIASES[head])) result.filter.types = result.filter.types ?? undefined;
  } else if (BASIC_TYPES.includes(head) || BASIC_TYPES.includes(head.replace(/s$/, ''))) {
    result.filter.subtypes = [head.replace(/s$/, '')];
    result.filter.types = ['Land'];
  } else if (/^commanders?$/i.test(head)) {
    result.filter.isCommander = true;
  } else if (head === 'card' || head === 'cards') {
    result.isCard = true;
  } else if (CREATURE_TYPE_RE.test(head) && !NOT_TYPES.has(head)) {
    // Creature type e.g. "Elf", "Dragons", "Zombie"
    const singular = singularize(head);
    result.filter.subtypes = [singular];
    if (!adjWords.some((w) => /^(artifact|enchantment|land)s?$/i.test(w))) {
      // Type-only nouns like "Elf" mean creature (or permanents with that subtype — Kindred). Creature is the safe default.
      result.filter.types = ['Creature'];
    }
  } else {
    return null;
  }
  // "attacking or blocking creature" is an adjective disjunction, not a head disjunction.
  if (adjWords.length >= 3 && /^attacking$/i.test(adjWords[0]) && /^or$/i.test(adjWords[1]) && /^blocking$/i.test(adjWords[2])) {
    result.filter.attackingOrBlocking = true;
    adjWords = adjWords.slice(3);
  }
  // "X or Y" heads: "artifact or enchantment", "creature or planeswalker"
  const orIdx = adjWords.findIndex((w) => w.toLowerCase() === 'or');
  if (orIdx >= 0) {
    const left = adjWords.slice(0, orIdx);
    const right = adjWords.slice(orIdx + 1);
    const leftHead = left[left.length - 1];
    const types = new Set(result.filter.types ?? []);
    const subtypes = new Set(result.filter.subtypes ?? []);
    const addHead = (h: string | undefined) => {
      if (!h) return false;
      const hl = h.toLowerCase().replace(/,$/, '');
      if (hl in TYPE_WORDS) types.add(TYPE_WORDS[hl]);
      else if (h in SUBTYPE_ALIASES) subtypes.add(SUBTYPE_ALIASES[h]);
      else if (CREATURE_TYPE_RE.test(h) && !NOT_TYPES.has(h)) subtypes.add(singularize(h));
      else return false;
      return true;
    };
    // "artifact, creature, or enchantment"
    const listHeads = left.filter((w) => w !== 'or');
    let ok = true;
    for (const h of listHeads) if (!addHead(h)) ok = false;
    if (!ok) return null;
    for (const h of right.slice(0, -0)) void h; // right side words are adjectives for the final head, already applied
    if (types.size) result.filter.types = [...types];
    if (subtypes.size) result.filter.subtypes = [...subtypes];
    adjWords = right.length ? right.slice(0, right.length) : [];
    // if leftHead itself got into adjectives, strip type words from adjectives
    adjWords = adjWords.filter((w) => !(w.toLowerCase() in TYPE_WORDS) && !(w in SUBTYPE_ALIASES) && !CREATURE_TYPE_RE.test(w));
    void leftHead;
  }
  if (!parseAdjectives(adjWords, result)) return null;
  for (const q of quals) applyQualifier(q, result);
  if (result.filter.subtypes?.length === 1 && result.filter.types?.length === 1 && result.filter.types[0] === 'Creature' && result.filter.subtypes[0] === 'Creature') delete result.filter.subtypes;
  return result;
}

function singularize(w: string): string {
  if (/ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (/(ch|sh|s|x|z)es$/.test(w)) return w.replace(/es$/, '');
  if (/s$/.test(w) && !/ss$/.test(w)) return w.replace(/s$/, '');
  return w;
}

function parseAdjectives(wordsIn: string[], r: ParsedNoun): boolean {
  let words = wordsIn;
  if (words.length >= 3 && /^attacking$/i.test(words[0]) && /^or$/i.test(words[1]) && /^blocking$/i.test(words[2])) {
    r.filter.attackingOrBlocking = true;
    words = words.slice(3);
  }
  for (const raw of words) {
    const w = raw.replace(/,$/, '');
    const l = w.toLowerCase();
    if (l in COLOR_WORDS) r.filter.colors = [...(r.filter.colors ?? []), COLOR_WORDS[l]];
    else if (l === 'colorless') r.filter.colorless = true;
    else if (l === 'multicolored') r.filter.multicolored = true;
    else if (l === 'monocolored') r.filter.monocolored = true;
    else if (l === 'legendary') r.filter.legendary = true;
    else if (l === 'nonlegendary') r.filter.legendary = false;
    else if (l === 'basic') r.filter.supertypes = ['Basic'];
    else if (l === 'nonbasic') r.filter.custom = 'nonbasic';
    else if (l === 'token') r.filter.isToken = true;
    else if (l === 'nontoken') r.filter.nonToken = true;
    else if (l === 'tapped') r.filter.tapped = true;
    else if (l === 'untapped') r.filter.untapped = true;
    else if (l === 'attacking') r.filter.attacking = true;
    else if (l === 'blocking') r.filter.blocking = true;
    else if (l === 'nonland') r.filter.nonland = true;
    else if (l === 'noncreature') r.filter.notTypes = [...(r.filter.notTypes ?? []), 'Creature'];
    else if (l === 'nonartifact') r.filter.notTypes = [...(r.filter.notTypes ?? []), 'Artifact'];
    else if (l === 'nonenchantment') r.filter.notTypes = [...(r.filter.notTypes ?? []), 'Enchantment'];
    else if (l === 'noninstant') r.filter.notTypes = [...(r.filter.notTypes ?? []), 'Instant'];
    else if (l === 'nonsorcery') r.filter.notTypes = [...(r.filter.notTypes ?? []), 'Sorcery'];
    else if (l === 'nonblack') r.filter.custom = 'nonblack';
    else if (/^non(white|blue|black|red|green)$/.test(l)) r.filter.custom = l;
    else if (/^non-([A-Z][a-z]+)$/.test(w)) r.filter.notSubtypes = [...(r.filter.notSubtypes ?? []), w.slice(4)];
    else if (l in TYPE_WORDS) r.filter.types = [...(r.filter.types ?? []), TYPE_WORDS[l]];
    else if (w in SUBTYPE_ALIASES) r.filter.subtypes = [...(r.filter.subtypes ?? []), SUBTYPE_ALIASES[w]];
    else if (CREATURE_TYPE_RE.test(w) && !NOT_TYPES.has(w)) r.filter.subtypes = [...(r.filter.subtypes ?? []), singularize(w)];
    else if (l === 'historic') r.filter.historic = true;
    else if (l === 'attacking' || l === 'blocking') {
      /* handled */
    } else if (l === 'or' || l === 'and') {
      /* "artifact and/or enchantment" handled loosely */
    } else if (l === 'snow') r.filter.supertypes = ['Snow'];
    else return false;
  }
  return true;
}

function applyQualifier(q: string, r: ParsedNoun) {
  let m: RegExpMatchArray | null;
  if (q === "in an opponent's graveyard" || q === "from an opponent's graveyard" || q === "in that player's graveyard" || q === "from that player's graveyard" || q === 'in their graveyard' || q === 'from their graveyard') {
    r.filter.zone = 'graveyard';
    r.filter.owner = 'opponent';
    r.isCard = true;
  } else if (/^that (?:was|were) put there from (?:their|your|a) library this turn$/.test(q) || /^put into (?:a|your|their) graveyard from (?:a|your|their) library this turn$/.test(q)) {
    r.filter.fromLibraryThisTurn = true;
    if (!r.filter.zone) r.filter.zone = 'graveyard';
    r.isCard = true;
  } else if ((m = q.match(/^with (?:a |an )?([+\-\w\/]+) counters? on (?:it|them)$/))) {
    r.filter.hasCounter = m[1];
  } else if (q === 'you control') r.filter.controller = 'you';
  else if (q === 'you own') r.filter.owner = 'you';
  else if (q === 'you do not control' || q === 'an opponent controls' || q === 'your opponents control' || q === 'that opponent controls') r.filter.controller = 'opponent';
  else if (q === 'you do not own' || q === 'an opponent owns') r.filter.owner = 'opponent';
  else if (q === 'that player controls' || q === 'defending player controls') r.filter.controller = 'any';
  else if (q === 'from your graveyard' || q === 'in your graveyard') {
    r.filter.zone = 'graveyard';
    r.filter.owner = 'you';
    r.isCard = true;
  } else if (q === 'from a graveyard' || q === 'in a graveyard') {
    r.filter.zone = 'graveyard';
    r.isCard = true;
  } else if (q === 'from your hand' || q === 'in your hand') {
    r.filter.zone = 'hand';
    r.filter.owner = 'you';
    r.isCard = true;
  } else if (q === 'from your library' || q === 'in your library') {
    r.filter.zone = 'library';
    r.filter.owner = 'you';
    r.isCard = true;
  } else if (q === 'from exile' || q === 'in exile') {
    r.filter.zone = 'exile';
    r.isCard = true;
  } else if (q === 'that is attacking') r.filter.attacking = true;
  else if (q === 'that is blocking') r.filter.blocking = true;
  else if (q === 'that is tapped') r.filter.tapped = true;
  else if (q === 'that is untapped') r.filter.untapped = true;
  else if (q === 'that has flying' || q === 'with flying' || q === 'you control with flying' || q === 'an opponent controls with flying') {
    r.filter.keywords = ['Flying'];
    if (q.includes('you control')) r.filter.controller = 'you';
    if (q.includes('opponent')) r.filter.controller = 'opponent';
  } else if (q === 'without flying') r.filter.withoutKeywords = ['Flying'];
  else if ((m = q.match(/^with (flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash)$/))) r.filter.keywords = [m[1].charAt(0).toUpperCase() + m[1].slice(1)];
  else if ((m = q.match(/^with (power|toughness|mana value) (\d+|x) or (greater|less)$/))) {
    const n = m[2] === 'x' ? 'X' : parseInt(m[2], 10);
    const key = m[1] === 'power' ? 'power' : m[1] === 'toughness' ? 'toughness' : 'cmc';
    if (m[3] === 'greater') (r.filter as Record<string, unknown>)[`${key}GE`] = n;
    else (r.filter as Record<string, unknown>)[`${key}LE`] = n;
  } else if ((m = q.match(/^with (power|toughness|mana value) (less than|greater than) (\d+|x)$/))) {
    const n = m[3] === 'x' ? 'X' : parseInt(m[3], 10);
    const key = m[1] === 'power' ? 'power' : m[1] === 'toughness' ? 'toughness' : 'cmc';
    if (typeof n === 'number') (r.filter as Record<string, unknown>)[m[2] === 'less than' ? `${key}LE` : `${key}GE`] = m[2] === 'less than' ? n - 1 : n + 1;
    else r.confident = false;
  } else if (q === 'of the chosen type' || q === 'of the chosen creature type') r.filter.chosenSubtypeKey = 'creatureType';
  else if ((m = q.match(/^with total power and toughness (\d+) or less$/))) r.filter.ptSumLE = parseInt(m[1], 10);
  else if (/^with the greatest power among creatures/.test(q)) r.filter.highestPower = true;
  else if ((m = q.match(/^with mana value (\d+|x)$/))) {
    if (m[1] === 'x') r.confident = false;
    else r.filter.cmcEQ = parseInt(m[1], 10);
  } else if ((m = q.match(/^with a (\+1\/\+1|-1\/-1|loyalty|charge) counter on (?:it|them)$/))) r.filter.hasCounter = m[1];
  else if (q === 'that entered this turn') r.filter.enteredThisTurn = true;
  else if (q === 'other than ~' || q === 'not named ~') r.filter.other = true;
  else if (q === 'that is a token') r.filter.isToken = true;
  else if (q === 'that is not a token') r.filter.nonToken = true;
  else if (q === 'that is a commander') r.filter.isCommander = true;
  else if (q === 'that is not a commander') r.filter.isCommander = false;
  else r.confident = false;
}

/** Build a TargetSpec from a parsed target noun. */
export function toTargetSpec(n: ParsedNoun): TargetSpec {
  const desc = n.text;
  const count = n.count === 'X' ? 1 : n.count;
  const spec: TargetSpec = { description: desc, kind: n.kind, min: n.upTo ? 0 : count, max: count };
  if (n.kind === 'player' || n.kind === 'objectOrPlayer') spec.playerFilter = n.playerFilter ?? 'any';
  if (n.kind === 'object' || n.kind === 'objectOrPlayer' || n.kind === 'any' || n.kind === 'spell') {
    const f: ObjectFilter = { ...n.filter };
    if (n.kind !== 'spell' && !f.zone) f.zone = 'battlefield';
    if (n.kind === 'spell') delete f.zone;
    spec.filter = f;
  }
  if (n.count === 'X') {
    spec.min = 0;
    spec.max = 20;
  }
  return spec;
}

/** Zone-less filter for use with "all"/"each" refs (battlefield default). */
export function zoneFor(n: ParsedNoun): ZoneName | undefined {
  return n.filter.zone as ZoneName | undefined;
}
