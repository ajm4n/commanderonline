/** Noun phrase → ObjectFilter / TargetSpec. */
import type { Color, ObjectFilter, TargetSpec, ZoneName } from '@commander/engine';
import { wordToNumber } from './text.js';
import { parseAmount } from './amounts.js';

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
  /** Minimum number of targets when "up to" is really "one, two, or three". */
  minCount?: number;
  /** "target player controls" / "that player controls": the controller is a player phrase resolved by the sentence parser. */
  controllerPhrase?: string;
}

const CREATURE_TYPE_RE = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/;

/** Words that are capitalized but not creature types. */
const NOT_TYPES = new Set(['If', 'When', 'Whenever', 'At', 'Then', 'You', 'Your', 'Target', 'Each', 'All', 'Another', 'Other', 'Put', 'Return', 'Destroy', 'Exile', 'Create', 'Draw', 'X', 'N', 'Aura', 'Equipment', 'Vehicle', 'Saga', 'Treasure', 'Food', 'Clue', 'Gate', 'Desert', 'Commander']);

export function parseNoun(raw: string): ParsedNoun | null {
  let text = raw.trim().replace(/[.,;]$/, '').replace(/ and\/or /g, ' or ').replace(/ or another /g, ' or ').replace(/ or (?:a|an) /g, ' or ').replace(/ cards? or (.+?) cards?$/i, ' or $1 card');
  // "each other attacking ~" → permanents with this card's name
  if (/(^|\s)~$/.test(text) && text !== '~') text = text.replace(/~$/, 'permanent named ~');
  if (/^cards? or tokens?$/i.test(text)) return { filter: {}, target: false, count: 1, upTo: false, each: false, other: false, indefinite: true, isCard: true, kind: 'object', confident: true, text: raw.trim(), plural: /s$/.test(text) };
  const result: ParsedNoun = { filter: {}, target: false, count: 1, upTo: false, each: false, other: false, indefinite: false, isCard: false, kind: 'object', confident: true, text: raw.trim(), plural: false };
  let m: RegExpMatchArray | null;

  // Special targets
  if (/^any target$/i.test(text)) return { ...result, target: true, kind: 'any' };
  if ((m = text.match(/^any number of target (players|opponents)$/i))) return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[1]) ? 'opponent' : 'any', count: 6, upTo: true };
  if ((m = text.match(/^any number of (?!target )(.+)$/i))) {
    const inner = parseNoun(m[1]) ?? parseNoun(m[1].replace(/^(\w+?)s\b/i, '$1'));
    if (inner) return { ...inner, count: 99, upTo: true, plural: true };
  }
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
  if ((m = text.match(/^(up to one )?target player or planeswalker$/i))) return { ...result, target: true, upTo: !!m[1], kind: 'objectOrPlayer', filter: { types: ['Planeswalker'] }, playerFilter: 'any' };
  if ((m = text.match(/^(up to one )?target opponent or planeswalker$/i))) return { ...result, target: true, upTo: !!m[1], kind: 'objectOrPlayer', filter: { types: ['Planeswalker'], controller: 'opponent' }, playerFilter: 'opponent' };
  if ((m = text.match(/^target opponent or battle$/i))) return { ...result, target: true, kind: 'objectOrPlayer', filter: { types: ['Battle'] }, playerFilter: 'opponent' };
  if ((m = text.match(/^target (?:activated or triggered ability|triggered ability|activated ability)$/i))) return { ...result, target: true, kind: 'activatedOrTriggered' };

  // Quantifiers
  text = text.replace(/^each of /i, '');
  // "one, two, or three target creatures" → up to three, at least one
  if ((m = text.match(/^one, two, or three target (.+)$/i)) || (m = text.match(/^one or two target (.+)$/i))) {
    const inner = parseNoun(`target ${m[1]}`);
    return inner ? { ...inner, count: /three/i.test(m[0]) ? 3 : 2, upTo: true, minCount: 1 } : null;
  }
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

  // Trailing qualifiers
  const quals: string[] = [];
  const QUAL_RE = /\s+(from graveyards|in graveyards|from all graveyards|that (?:does not|doesn't) have (?:a|an) [+-]?[\w/+-]+ counters? on it|that has (?:a|an) [+-]?[\w/+-]+ counters? on it|except for tokens you control|except for tokens|of (?:their|your|its controller's|his or her) choice|with different names|in all graveyards|attacking you or a planeswalker you control|attacking you or planeswalkers you control|attacking you|in an opponent's graveyard|from an opponent's graveyard|in that player's graveyard|from that player's graveyard|in their graveyard|from their graveyard|that was put there from (?:their|your|a) library this turn|that were put there from (?:their|your|a) library this turn|put into (?:a|your|their) graveyard from (?:a|your|their) library this turn|with (?:a |an )?[+\-\w\/]+ counters? on (?:it|them)|you control but do not own|you control but don't own|you control|you own|you do not control|on the battlefield|attached to (?:it|~)|that targets (?:a|an) [^,]+?|that targets you|that targets an opponent|with mana value equal to [^,]+?|that was dealt damage this turn|dealt damage this turn|attached to a creature|attached to a permanent|with mana value less than or equal to [^,]+?|an opponent controls|each opponent controls|your opponents control|target player controls|target opponent controls|its controller controls|they control|that is (?:a|an) [A-Z][a-z]+(?:, [A-Z][a-z]+)*(?:,? or (?:a |an )?[A-Z][a-z]+)*|named ~|named [A-Z][\w' ,-]+?|an opponent owns|you do not own|from your graveyard|in your graveyard|from a graveyard|in a graveyard|from a single graveyard|from your hand|in your hand|from your library|in your library|from exile|in exile|that is attacking|that is blocking|that is tapped|that is untapped|that has flying|that (?:is|are) enchanted|that (?:is|are) equipped|that (?:is|are) modified|that (?:has|have) an Adventure|with an Adventure|with toughness greater than (?:its|their) power|that (?:has|have) (?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash|convoke|cascade|storm|delve|kicker|flashback|cycling|prowess|ward|escape|foretell|adventure|mutate|evoke|emerge|ninjutsu|madness|morph|disguise|plot|offspring|impending|gift|bargain|overload|spree|surge|prowl|blitz|dash|riot|exploit|devoid|changeling|toxic|afflict|mentor|amass|enlist|casualty|craft)|with \{X\} in (?:its|their) mana costs?|that entered the battlefield this turn|that entered this turn|with (?:power|toughness|mana value) (?:\d+|X) or (?:greater|less)|with (?:power|toughness|mana value) (?:less than|greater than) (?:\d+|X)|with (?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash|modular|exalted|persist|undying|changeling|prowess|ward|cascade|storm|convoke|delve|evolve|kicker|cycling|flashback|morph|fabricate|afflict|riot|mentor|toxic|decayed|training|backup|offspring|foretell|escape|bushido|shadow|horsemanship|fear|intimidate|skulk|wither|deathtouch|landfall|a kicker ability|a cycling ability|a flashback ability|a morph ability)|without flying|with a (?:\+1\/\+1|-1\/-1|loyalty|charge) counter on (?:it|them)|with mana value (?:\d+|X)|with total power \d+ or less|with total power and toughness \d+ or less|of the chosen type|of the chosen creature type|with the greatest power among creatures (?:that player|you) controls?|that shares a creature type with ~|that (?:is not|is) a (?:token|commander)|other than ~|not named ~|from among them|of that color|that player controls|that opponent controls|defending player controls|an opponent controls with flying|you control with flying)$/i;
  for (;;) {
    const q = text.match(QUAL_RE);
    if (!q) break;
    quals.unshift(/^(?:named |that is )/i.test(q[1]) ? q[1].replace(/^(named|that is)/i, (w) => w.toLowerCase()) : q[1].toLowerCase());
    text = text.slice(0, q.index).trim();
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
    for (const q of quals) applyQualifier(q, result);
    return result;
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
  if (/^permanents?$/i.test(head) || /^sources?$/i.test(head)) {
    // no type restriction ("a source you control" is any object)
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
    const addHead = (hRaw: string | undefined) => {
      if (!hRaw) return false;
      const h = hRaw.replace(/,$/, '');
      const hl = h.toLowerCase();
      if (hl in TYPE_WORDS) types.add(TYPE_WORDS[hl]);
      else if (h in SUBTYPE_ALIASES) subtypes.add(SUBTYPE_ALIASES[h]);
      else if (CREATURE_TYPE_RE.test(h) && !NOT_TYPES.has(h)) subtypes.add(singularize(h));
      else return false;
      return true;
    };
    // "artifact, creature, or enchantment" (adjectives such as "basic" in "basic land or Gate cards" apply to the whole)
    const listHeads = left.filter((w) => w !== 'or');
    let ok = true;
    for (const h of listHeads) if (!addHead(h) && !parseAdjectives([h], result)) ok = false;
    if (!ok) return null;
    for (const h of right.slice(0, -0)) void h; // right side words are adjectives for the final head, already applied
    if (types.size && subtypes.size && !(result.filter.types ?? []).length && !(result.filter.subtypes ?? []).length) {
      // "artifact or Human": a card type OR a subtype.
      result.filter.anyOf = [{ types: [...types] }, { subtypes: [...subtypes] }];
    } else {
      if (types.size) result.filter.types = [...types];
      if (subtypes.size) result.filter.subtypes = [...subtypes];
    }
    adjWords = right.length ? right.slice(0, right.length) : [];
    // if leftHead itself got into adjectives, strip type words from adjectives
    adjWords = adjWords.filter((w) => !(w.toLowerCase() in TYPE_WORDS) && !(w in SUBTYPE_ALIASES) && !CREATURE_TYPE_RE.test(w));
    void leftHead;
  }
  if (!parseAdjectives(adjWords, result)) return null;
  for (const q of quals) applyQualifier(q, result);
  if (result.plural && result.other && result.indefinite) result.indefinite = false;
  if (result.filter.subtypes?.length === 1 && result.filter.types?.length === 1 && result.filter.types[0] === 'Creature' && result.filter.subtypes[0] === 'Creature') delete result.filter.subtypes;
  return result;
}

function singularize(w: string): string {
  if (/^(Plains|Aetherborn|Serpents?)$/i.test(w)) return w.replace(/^Serpents$/i, 'Serpent');
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
    else if (l === 'commander') r.filter.isCommander = true;
    else if (l === 'noncommander') r.filter.isCommander = false;
    else if (l === 'nontoken') r.filter.nonToken = true;
    else if (l === 'tapped') r.filter.tapped = true;
    else if (l === 'modified') r.filter.modified = true;
    else if (l === 'enchanted') r.filter.hasAttachment = 'Aura';
    else if (l === 'equipped') r.filter.hasAttachment = 'Equipment';
    else if (l === 'permanent') r.filter.permanentCard = true;
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
  else if (q === 'you do not control' || q === 'an opponent controls' || q === 'each opponent controls' || q === 'your opponents control') r.filter.controller = 'opponent';
  else if (/^that (?:is|are) enchanted$/.test(q)) r.filter.hasAttachment = 'Aura';
  else if (/^that (?:is|are) equipped$/.test(q)) r.filter.hasAttachment = 'Equipment';
  else if (/^that (?:is|are) modified$/.test(q)) r.filter.modified = true;
  else if (/^(?:that (?:has|have)|with) an adventure$/i.test(q)) r.filter.hasAdventure = true;
  else if (/^with toughness greater than (?:its|their) power$/i.test(q)) r.filter.toughnessGreaterThanPower = true;
  else if (/^that shares? a creature type with ~$/i.test(q)) r.filter.sharesCreatureTypeWithSource = true;
  else if (q === 'from a single graveyard') r.filter.zone = 'graveyard';
  else if ((m = q.match(/^that (?:has|have) ([a-z ]+)$/))) r.filter.keywords = [m[1].charAt(0).toUpperCase() + m[1].slice(1)];
  else if (/^with \{x\} in (?:its|their) mana costs?$/i.test(q)) r.filter.custom = 'hasX';
  else if (q === 'you do not own' || q === 'an opponent owns') r.filter.owner = 'opponent';
  else if (q === 'you control but do not own' || q === "you control but don't own") {
    r.filter.controller = 'you';
    r.filter.owner = 'opponent';
  }
  else if (q === 'that player controls' || q === 'defending player controls' || q === 'target player controls' || q === 'target opponent controls' || q === 'its controller controls' || q === 'that opponent controls' || q === 'they control') r.controllerPhrase = q === 'they control' ? 'they' : q.replace(/ controls$/, '');
  else if (q === 'on the battlefield') r.filter.zone = 'battlefield';
  else if (q === 'attached to it' || q === 'attached to ~') r.filter.attachedToSource = true;
  else if (q === 'that targets you') r.filter.spellTargets = 'you';
  else if (q === 'that targets an opponent') r.filter.spellTargets = 'opponent';
  else if ((m = q.match(/^that targets (?:a|an) (.+)$/))) {
    const inner = parseNoun(`a ${m[1]}`);
    if (inner) r.filter.spellTargets = inner.filter.zone ? inner.filter : { ...inner.filter, zone: 'battlefield' };
    else r.confident = false;
  } else if ((m = q.match(/^with mana value equal to (.+)$/))) {
    const a = parseAmount(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a !== null) r.filter.cmcEQAmount = a;
    else r.confident = false;
  }
  else if (q === 'that was dealt damage this turn' || q === 'dealt damage this turn') r.filter.damaged = true;
  else if (q === 'attached to a creature' || q === 'attached to a permanent') r.filter.attached = true;
  else if ((m = q.match(/^with mana value less than or equal to (.+)$/))) {
    const a = parseAmount(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a !== null) r.filter.cmcLEAmount = a;
    else r.confident = false;
  }
  else if ((m = q.match(/^named (.+)$/))) r.filter.nameIs = m[1] === '~' ? '~' : m[1];
  else if ((m = q.match(/^that is (?:a|an) (.+)$/))) r.filter.subtypes = m[1].split(/,? or (?:a |an )?|, /).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  else if ((m = q.match(/^that (?:does not|doesn't) have (?:a|an) ([+-]?[\w/+-]+) counters? on it$/))) r.filter.withoutCounter = m[1];
  else if ((m = q.match(/^that has (?:a|an) ([+-]?[\w/+-]+) counters? on it$/))) r.filter.counterAtLeast = { counter: m[1], n: 1 };
  else if (/^except for tokens(?: you control)?$/.test(q)) r.filter.nonToken = true;
  else if (/^of (?:their|your|its controller's|his or her) choice$/.test(q)) {
    // "a creature of their choice": the chooser is already the sentence's subject.
  } else if (q === 'with different names') r.filter.differentNames = true;
  else if (q === 'from graveyards' || q === 'in graveyards' || q === 'from all graveyards') {
    r.filter.zone = 'graveyard';
    r.isCard = true;
  } else if (q === 'in all graveyards') {
    r.filter.zone = 'graveyard';
    r.isCard = true;
  } else if (q === 'from your graveyard' || q === 'in your graveyard') {
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
  } else if (q === 'that is attacking' || q === 'attacking you' || q === 'attacking you or a planeswalker you control' || q === 'attacking you or planeswalkers you control') r.filter.attacking = true;
  else if (q === 'that is blocking') r.filter.blocking = true;
  else if (q === 'that is tapped') r.filter.tapped = true;
  else if (q === 'that is untapped') r.filter.untapped = true;
  else if (q === 'that has flying' || q === 'with flying' || q === 'you control with flying' || q === 'an opponent controls with flying') {
    r.filter.keywords = ['Flying'];
    if (q.includes('you control')) r.filter.controller = 'you';
    if (q.includes('opponent')) r.filter.controller = 'opponent';
  } else if (q === 'without flying') r.filter.withoutKeywords = ['Flying'];
  else if ((m = q.match(/^with (?:a )?(flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash|modular|exalted|persist|undying|changeling|prowess|ward|cascade|storm|convoke|delve|evolve|kicker|cycling|flashback|morph|fabricate|afflict|riot|mentor|toxic|decayed|training|backup|offspring|foretell|escape|bushido|shadow|horsemanship|fear|intimidate|skulk|wither|landfall)(?: ability)?$/))) r.filter.keywords = [m[1].charAt(0).toUpperCase() + m[1].slice(1)];
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
  else if (q === 'that entered this turn' || q === 'that entered the battlefield this turn') r.filter.enteredThisTurn = true;
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
  const spec: TargetSpec = { description: desc, kind: n.kind, min: n.upTo ? (n.minCount ?? 0) : count, max: count };
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
