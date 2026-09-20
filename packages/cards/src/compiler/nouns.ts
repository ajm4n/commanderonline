/** Noun phrase → ObjectFilter / TargetSpec. */
import type { Color, ObjectFilter, Ref, TargetSpec, ZoneName } from '@commander/engine';
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
  playerCondition?: TargetSpec['playerCondition'];
  playerTurnStat?: TargetSpec['playerTurnStat'];
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
/** "from a colorless source", "from a creature source": restrict the ability's source object. */
const SOURCE_FILTERS: Record<string, ObjectFilter> = {
  colorless: { colors: [] },
  creature: { types: ['Creature'] },
  artifact: { types: ['Artifact'] },
  enchantment: { types: ['Enchantment'] },
  land: { types: ['Land'] },
  permanent: {},
  noncreature: { notTypes: ['Creature'] },
  nonland: { nonland: true },
  white: { colors: ['W'] },
  blue: { colors: ['U'] },
  black: { colors: ['B'] },
  red: { colors: ['R'] },
  green: { colors: ['G'] },
};

const NOT_TYPES = new Set(['If', 'When', 'Whenever', 'At', 'Then', 'You', 'Your', 'Target', 'Each', 'All', 'Another', 'Other', 'Put', 'Return', 'Destroy', 'Exile', 'Create', 'Draw', 'X', 'N', 'Aura', 'Equipment', 'Vehicle', 'Saga', 'Treasure', 'Food', 'Clue', 'Gate', 'Desert', 'Commander']);

const KEYWORD_QUALS = new Set(['flying', 'defender', 'trample', 'deathtouch', 'lifelink', 'haste', 'vigilance', 'reach', 'menace', 'hexproof', 'indestructible', 'infect', 'flash', 'shroud', 'fear', 'intimidate', 'skulk', 'shadow', 'horsemanship', 'wither', 'prowess', 'changeling', 'toxic', 'flanking', 'exalted', 'persist', 'undying', 'ward', 'banding', 'annihilator', 'melee', 'mentor', 'afflict', 'bushido', 'decayed', 'training', 'backup', 'daybound', 'nightbound']);

export function parseNoun(raw: string): ParsedNoun | null {
  let text = raw.trim().replace(/[.,;]$/, '').replace(/ and\/or /g, ' or ').replace(/ or another /g, ' or ').replace(/ or (?:a|an) /g, ' or ').replace(/ cards? or (.+?) cards?$/i, ' or $1 card');
  // "each other attacking ~" → permanents with this card's name
  if (/(^|\s)~$/.test(text) && text !== '~' && !/\b(?:than|named|as|with|to|by|from|of|for|only|controls?|convoked|crewed|blocking|enchanting|attached) ~$/i.test(text)) text = text.replace(/~$/, 'permanent named ~');
  // "each of two other target creatures" / "each of those creatures"
  if (/^each of (?:\w+ )?(?:other )?(?:target |those |the )/i.test(text)) text = text.replace(/^each of /i, '');
  // "one or two other target creatures": the "other" sits between the count and "target".
  if (/\bother target\b/i.test(text)) {
    const inner = parseNoun(text.replace(/\bother target\b/i, 'target'));
    if (inner) return { ...inner, other: true, filter: { ...inner.filter, other: true } };
  }
  // "outlaws you control": Assassins, Mercenaries, Pirates, Rogues and Warlocks.
  if (/(?<!non-)\boutlaws?\b/i.test(text)) {
    const inner = parseNoun(text.replace(/(?<!non-)\boutlaws?\b/gi, (w) => (/s$/i.test(w) ? 'creatures' : 'creature')));
    if (!inner) return null;
    return { ...inner, filter: { ...inner.filter, subtypes: ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'] } };
  }
  // "any artifact or creature on the battlefield" — "any" here is just an indefinite article.
  if (/^any (?!target\b|number of\b|other player)/i.test(text)) text = text.replace(/^any /i, 'a ');
  // "one or more target creatures"
  if (/^one or more target /i.test(text)) {
    const inner = parseNoun(text.replace(/^one or more /i, 'up to six '));
    if (inner) return { ...inner, minCount: 1 };
  }
  if (/^cards? or tokens?$/i.test(text)) return { filter: {}, target: false, count: 1, upTo: false, each: false, other: false, indefinite: true, isCard: true, kind: 'object', confident: true, text: raw.trim(), plural: /s$/.test(text) };
  const result: ParsedNoun = { filter: {}, target: false, count: 1, upTo: false, each: false, other: false, indefinite: false, isCard: false, kind: 'object', confident: true, text: raw.trim(), plural: false };
  let m: RegExpMatchArray | null;

  // "an instant card or a card with flash" — a disjunction whose right side is a keyword clause.
  if ((m = text.match(/^(.+?) or (?:a |an )?(?:card|permanent|creature|spell)s? with ([\w' -]+)$/i))) {
    const left = parseNoun(m[1]);
    const kwRaw = m[2].trim().toLowerCase();
    if (left && /^[a-z][a-z' -]*$/.test(kwRaw)) {
      const kw = kwRaw.replace(/\b[a-z]/g, (c) => c.toUpperCase());
      const zone = left.filter.zone;
      return { ...left, filter: { anyOf: [{ ...left.filter, zone: undefined }, { keywords: [kw] }], zone } };
    }
  }

  // Special targets
  if (/^any target(?: of (?:an opponent's|that player's|your) choice)?$/i.test(text)) return { ...result, target: true, kind: 'any' };
  if (/^with the same controller$/i.test(text)) return null;
  if ((m = text.match(/^any number of target (players|opponents)$/i))) return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[1]) ? 'opponent' : 'any', count: 6, upTo: true };
  // "two other target legendary creatures" reads as "two target legendary creatures", minus this permanent.
  if ((m = text.match(/^(?:(\w+) )?other target (.+)$/i))) {
    const inner = parseNoun(`${m[1] ? `${m[1]} ` : ''}target ${m[2]}`);
    if (inner) return { ...inner, other: true, filter: { ...inner.filter, other: true } };
  }
  if ((m = text.match(/^any number of (?!target )(.+)$/i))) {
    const inner = parseNoun(m[1]) ?? parseNoun(m[1].replace(/^(\w+?)s\b/i, '$1'));
    if (inner) return { ...inner, count: 99, upTo: true, plural: true };
  }
  if ((m = text.match(/^any number of target (.+)$/i))) {
    const inner = parseNoun(`target ${m[1]}`);
    return inner ? { ...inner, count: 20, upTo: true } : null;
  }
  // "target opponent who has more life than you do" / "... at least two more cards in hand than you do"
  if ((m = text.match(/^target (player|opponent) who (?:has|controls) (?:at least (\w+) )?(more|fewer) (life|cards in hand|creatures|creature cards in their graveyard) than (?:you|they) do$/i))) {
    const by = m[2] ? wordToNumber(m[2]) : 1;
    const stat = /^life$/i.test(m[4]) ? 'life' : /cards in hand/i.test(m[4]) ? 'handSize' : /^creatures$/i.test(m[4]) ? 'creatures' : 'creatureCardsInGraveyard';
    if (typeof by === 'number') {
      return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[1]) ? 'opponent' : 'any', playerCondition: { stat: stat as 'life', op: /^more$/i.test(m[3]) ? 'more' : 'fewer', byAtLeast: by } };
    }
  }
  // "target player who lost life this turn" / "target opponent who attacked this turn"
  if ((m = text.match(/^target (player|opponent) who (lost life|gained life|attacked(?: with a creature)?|cast (?:a|one or more) spells?|drew a card|discarded a card|sacrificed a permanent) this turn$/i))) {
    const w = m[2].toLowerCase();
    const key = w.startsWith('lost life') ? 'lifeLostAmount' : w.startsWith('gained life') ? 'lifeGainedAmount' : w.startsWith('attacked') ? 'attacks' : w.startsWith('cast') ? 'cast' : w.startsWith('drew') ? 'drawCard' : w.startsWith('discarded') ? 'discard' : 'sacrifice';
    return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[1]) ? 'opponent' : 'any', playerTurnStat: { key } };
  }
  if ((m = text.match(/^(?:up to (\w+) |(\w+) )?targets? (players?|opponents?)$/i))) {
    const n = wordToNumber(m[1] ?? m[2]);
    return { ...result, target: true, kind: 'player', playerFilter: /opponent/i.test(m[3]) ? 'opponent' : 'any', count: n ?? 1, upTo: !!m[1] };
  }
  if ((m = text.match(/^target (creature|permanent|creature or planeswalker) or player$/i))) {
    const inner = parseNoun(m[1]);
    return { ...result, target: true, kind: 'objectOrPlayer', filter: inner?.filter ?? {}, playerFilter: 'any' };
  }
  if ((m = text.match(/^(up to one )?target player or planeswalker$/i))) return { ...result, target: true, upTo: !!m[1], kind: 'objectOrPlayer', filter: { types: ['Planeswalker'] }, playerFilter: 'any' };
  if ((m = text.match(/^(up to one )?target opponent or planeswalker$/i))) return { ...result, target: true, upTo: !!m[1], kind: 'objectOrPlayer', filter: { types: ['Planeswalker'], controller: 'opponent' }, playerFilter: 'opponent' };
  if ((m = text.match(/^target opponent or battle$/i))) return { ...result, target: true, kind: 'objectOrPlayer', filter: { types: ['Battle'] }, playerFilter: 'opponent' };
  if ((m = text.match(/^target spell, activated ability, or triggered ability$/i))) return { ...result, target: true, kind: 'spellOrAbility' };
  if ((m = text.match(/^target spell or ability$/i))) return { ...result, target: true, kind: 'spellOrAbility' };
  if ((m = text.match(/^target spell or (creature|permanent|artifact|enchantment|creature or enchantment)$/i))) {
    const inner = parseNoun(`a ${m[1]}`);
    return { ...result, target: true, kind: 'objectOrSpell', filter: inner?.filter ?? {} };
  }
  // "target activated ability, triggered ability, or noncreature spell" / "... or legendary spell"
  if ((m = text.match(/^target (?:activated ability, triggered ability, or (.+?) spell|(?:instant spell, sorcery spell|instant or sorcery spell), or triggered ability|activated or triggered ability from a (\w+) source)$/i))) {
    if (m[2]) {
      const src = SOURCE_FILTERS[m[2].toLowerCase()];
      if (!src) return null;
      return { ...result, target: true, kind: 'activatedOrTriggered', filter: src };
    }
    if (m[1]) {
      const inner = parseNoun(`a ${m[1]} spell`);
      if (!inner) return null;
      return { ...result, target: true, kind: 'spellOrAbility', filter: { ...inner.filter, zone: undefined } };
    }
    return { ...result, target: true, kind: 'spellOrAbility', filter: { types: ['Instant', 'Sorcery'] } };
  }
  if ((m = text.match(/^target loyalty ability of a planeswalker$/i))) return { ...result, target: true, kind: 'activatedOrTriggered' };
  if ((m = text.match(/^target (?:activated or triggered ability|triggered ability|activated ability)(?: you control| an opponent controls| you do ?n[o']t control)?(?: from an? (\w+(?: or \w+)*) source)?( with a single target| that targets only (?:~|it|a player))?$/i))) {
    const pf = / you control$/i.test(text) ? 'you' : /opponent controls$/i.test(text) ? 'opponent' : /n[o']t control$/i.test(text) ? 'notController' : undefined;
    let src = m[1] ? SOURCE_FILTERS[m[1].toLowerCase()] : undefined;
    if (m[1] && !src && / or /i.test(m[1])) {
      // "from an artifact or enchantment source": one filter listing both types.
      const parts = m[1].split(/ or /i).map((w) => SOURCE_FILTERS[w.trim().toLowerCase()]);
      if (parts.every((f) => f && f.types && Object.keys(f).length === 1)) src = { types: parts.flatMap((f) => f!.types!) };
    }
    if (m[1] && !src) return null;
    const extra: ObjectFilter = {};
    if (m[2] && / with a single target/i.test(m[2])) extra.custom = 'singleTarget';
    else if (m[2] && /targets only a player/i.test(m[2])) extra.custom = 'targetsOnlyPlayer';
    else if (m[2]) extra.custom = 'targetsSourceOnly';
    return { ...result, target: true, kind: 'activatedOrTriggered', playerFilter: pf, filter: { ...(src ?? {}), ...extra } };
  }

  // Quantifiers
  text = text.replace(/^each of /i, '');
  // "one, two, or three target creatures" → up to three, at least one
  if ((m = text.match(/^one, two, or three target (.+)$/i)) || (m = text.match(/^one or two target (.+)$/i))) {
    const inner = parseNoun(`target ${m[1]}`);
    return inner ? { ...inner, count: /three/i.test(m[0]) ? 3 : 2, upTo: true, minCount: 1 } : null;
  }
  if ((m = text.match(/^up to (\w+) (?!target)(.+)$/i)) && wordToNumber(m[1]) !== null && !/^\w+ (?:other |another )?target /i.test(text)) {
    const inner = parseNoun(m[2]);
    const n = wordToNumber(m[1]);
    if (inner && typeof n === 'number') return { ...inner, upTo: true, count: n, minCount: 0 };
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
  } else if ((m = text.match(/^(\w+) (.+)$/i)) && typeof wordToNumber(m[1]) === 'number' && wordToNumber(m[1]) !== 1) {
    // "two land cards", "three creatures" — a bare count with no "target".
    result.count = wordToNumber(m[1]) as number;
    result.indefinite = true;
    text = m[2];
  }
  if ((m = text.match(/^(?:another|other) (.+)$/i))) {
    result.other = true;
    text = m[1];
  }
  // "other creatures you control" excludes the permanent whose ability this is.
  if (result.other) result.filter.other = true;

  // "two target creature cards each with mana value 2 or less" / "lands that each have a basic land type":
  // the distributive "each" says nothing the qualifier doesn't.
  text = text.replace(/\b(?:that )?each (with|have|has|having) /gi, (_x, w: string) => (/^with$/i.test(w) ? 'with ' : `that ${w.toLowerCase() === 'having' ? 'have' : w.toLowerCase()} `));

  // Trailing qualifiers
  const quals: string[] = [];
  const QUAL_RE = /\s+(that (?:aren't|are not|isn't|is not) legendary|with (?:a|an) [\w' -]+ attached to (?:it|them)|that (?:is|are) enchanted by (?:a|an) [\w' -]+|(?:each )?with (?:power|toughness) greater than (?:its|their) base (?:power|toughness)|that (?:have|has) (?:a|an)? ?[+\-\w\/]+ counters? on (?:it|them)|that (?:is|are) attacking you or (?:a )?planeswalkers? you control|with (?:power|toughness|mana value) (?:greater|less) than or equal to your life total|with the greatest power among creatures on the battlefield|with the greatest (?:power|toughness|mana value) among [\w ,]+ on the battlefield|you own or control|with (?:power|toughness|mana value) (?:greater|less) than the number of cards in your hand|that had counters put on it this way|that blocked or (?:was|were) blocked by (?:it|~) this turn|that blocked or (?:was|were) blocked by (?:a|an) [\w' -]+ this turn|that blocked or (?:was|were) blocked this turn|that blocked (?:~|it) this turn|that (?:aren't|are not|isn't|is not) enchanted|that (?:aren't|are not|isn't|is not) equipped|that (?:aren't|are not|isn't|is not) of the chosen type|that (?:aren't|are not|isn't|is not) of a type chosen this way|that (?:is|are) enchanted or equipped|that dealt damage to you this turn|that blocked this turn|that attacked during (?:their controller's|your) last turn|that convoked (?:it|~)|that (?:crewed|saddled) (?:it|~)(?: this turn)?|that attacked this turn|that (?:is|are) attacking one of your opponents|that (?:is|are) attacking you or a planeswalker you control|except for ~|except for commanders|except for legendary creatures|that (?:is|are) attacking or blocking|that (?:is|are) (?:white|blue|black|red|green)(?:(?:,? or | and\/or |, )(?:white|blue|black|red|green))+|with (?:plains|island|swamp|mountain|forest)walk|with (?:mana value|power|toughness) (?:less|greater) than ~'s (?:mana value|power|toughness)|(?:with|that (?:has|have)) (?:awaken|warp|suspend|disturb|flashback|madness|embalm|eternalize|bestow|evoke|emerge|escape|plot|rebound|aftermath|retrace|dredge|haunt|miracle|encore|jump-start|adventure|unearth|mutate|disturb|prototype|casualty)|with mana value of (?:the chosen|that) quality|with power, toughness, or mana value \d+|with mana value \d+ or \d+|with an (?:odd|even) mana value|without (?:a|an) [+\-\w\/]+ counters? on (?:it|them)|that (?:is|are) [\w-]+ cards?(?:, [\w-]+ cards?)*(?:,? (?:and\/or|or|and) (?:[\w-]+ cards?|have an Adventure))?|that (?:is|are) not historic|that (?:is|are) not (?:a|an) [A-Z][a-z]+|that (?:is|are) historic|with (?:a|an) basic land type|that (?:has|have) (?:a|an) basic land type|with the greatest power or tied for greatest power|with the chosen name|with that name|with (?:flanking|banding|exalted|bushido|soulbond|exploit|melee|mentor|myriad|extort|afterlife|training|backup|decayed|toxic|annihilator|rampage|fading|vanishing|phasing|echo)|that (?:do not|don't|does not|doesn't) have a name|with no abilities|of the chosen color|of the colou?r of your choice|without (?:\w+)(?: or \w+)+|that (?:is|are) [A-Z][a-z]+s? or tokens|attached to that creature|attached to target creature|with different controllers|your team controls|it is blocking|of (?:that|the chosen) colou?r|from graveyards|in graveyards|from all graveyards|that (?:does not|doesn't) have (?:a|an) [+-]?[\w/+-]+ counters? on it|that has (?:a|an) [+-]?[\w/+-]+ counters? on it|except for tokens you control|except for tokens|of (?:their|your|its controller's|his or her|an opponent's|that player's|defending player's) choice|with the same controller|with different names|in exile and in your graveyard|in your graveyard and in exile|that entered the battlefield under your control this turn|with (?:\w+)(?:, \w+)+(?:,? and\/or \w+|,? or \w+)?|with (?:\w+)(?: or \w+)+|in all graveyards|attacking that (?:player|opponent)|attacking enchanted player|attacking you or (?:a )?planeswalkers? you control|attacking you|from defending player's graveyard|in defending player's graveyard|in an opponent's graveyard|from an opponent's graveyard|in that player's graveyard|from that player's graveyard|in their graveyard|from their graveyard|that was put there from (?:their|your|a) library this turn|that was put there from anywhere this turn|that were put there from (?:their|your|a) library this turn|put into (?:a|your|their) graveyard from (?:a|your|their) library this turn|exiled with (?:~|it)|created with (?:~|it)|that (?:is|are) attacking you|that (?:aren't|are not|isn't|is not) on the battlefield|with counters on (?:it|them)|with one or more counters on (?:it|them)|with (?:a |an )?[+\-\w\/]+ counters? on (?:it|them)|you both own and control|you control but do not own|you control but don't own|you control|you own|you do not control|on the battlefield|attached to (?:it|~)|that targets (?:a|an) [^,]+?|with a single target|that targets only a player|that targets only (?:~|it)|that targets you|that targets an opponent|with mana value equal to [^,]+?|that dealt damage this turn|that (?:was|were) dealt damage this turn|dealt damage this turn|attached to a creature|attached to a permanent|with mana value less than or equal to [^,]+?|with (?:power|toughness) less than or equal to [^,]+?|that (?:is|are) attached to (?:a|an) (?:creature|permanent|land|artifact|player)|with (?:mana value|power|toughness) less than (?:that|its|your|the) [^,]+?|with (?:equal or lesser|lesser) (?:mana value|power|toughness)|the monarch controls|an opponent controls|each opponent controls|your opponents control|target player controls|target opponent controls|its controller controls|they control|that is (?:a|an) [A-Z][a-z]+(?:, (?:a |an )?[A-Z][a-z]+)*(?:,? or (?:a |an )?[A-Z][a-z]+)*|named ~|named [A-Z][\w' ,-]+?|an opponent owns|you do not own|from your graveyard|in your graveyard|from a graveyard|in a graveyard|from a single graveyard|from your hand|in your hand|from your library|in your library|from exile|in exile|cast from a graveyard|cast from exile|cast from a hand|that (?:wasn't|was not) cast from (?:its owner's|their|a) hand|that wasn't cast|that (?:was|were) not cast|that is attacking|that is blocking|that is tapped|that is untapped|that has flying|that (?:is|are) enchanted|that (?:is|are) equipped|that (?:is|are) modified|that (?:has|have) an Adventure|with an Adventure|with toughness greater than (?:its|their) power|that (?:has|have) (?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash|convoke|cascade|storm|delve|kicker|flashback|cycling|prowess|ward|escape|foretell|adventure|mutate|evoke|emerge|ninjutsu|madness|morph|disguise|plot|offspring|impending|gift|bargain|overload|spree|surge|prowl|blitz|dash|riot|exploit|devoid|changeling|toxic|afflict|mentor|amass|enlist|casualty|craft)|with \{[^}]+\} in (?:its|their) mana costs?|that entered the battlefield this turn|that entered this turn|with (?:power|toughness|mana value) (?:\d+|X) or (?:greater|less)|with power or toughness (?:\d+|X) or (?:greater|less)|controlled by different players|with equal toughness|with equal power|with (?:power|toughness|mana value) (?:less than|greater than) (?:\d+|X)|with (?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|infect|flash|modular|exalted|persist|undying|changeling|prowess|ward|cascade|storm|convoke|delve|evolve|kicker|cycling|flashback|morph|fabricate|afflict|riot|mentor|toxic|decayed|training|backup|offspring|foretell|escape|bushido|shadow|horsemanship|fear|intimidate|skulk|wither|deathtouch|landfall|a kicker ability|a cycling ability|a flashback ability|a morph ability)|without flying|without \w+|that (?:is|are) not enchanted|with a (?:\+1\/\+1|-1\/-1|loyalty|charge) counter on (?:it|them)|with mana value (?:\d+|X)|with base power (?:\d+|X)|with base power \d+ or less|with power (?:\d+|X)|with toughness (?:\d+|X)|with total power \d+ or less|with total power and toughness \d+ or less|of the chosen type|of that type|of the chosen creature type|of the creature type of your choice|with the (?:least|greatest|lowest|highest|smallest|largest) (?:power|toughness|mana value)|with the greatest power among creatures (?:that player|you|they) controls?|with the greatest mana value among [\w ,]+ (?:that player|you|they) controls?|that shares? a creature type with (?:~|it)|that share a creature type with (?:~|it)|that shares? a colou?r with (?:~|it)|that share a colou?r with (?:~|it)|that (?:is not|is) a (?:token|commander)|that (?:is|are) all colors|that (?:is|are) not all colors|attached to permanents you control|attached to creatures you control|that (?:is|are) one or more colors|that (?:was|were) put there this turn|that (?:was|were) put there from the battlefield this turn|other than ~|not named ~|other than (?:a|an) [\w -]+ card|without flanking blocking (?:~|it)|blocking it|blocking ~|that (?:was|were) blocked by that creature this (?:turn|combat)|blocked by it|blocked by ~|(?:~|it) is blocking|blocking or blocked by it|blocking or blocked by ~|from among them|of that color|that player controls|that opponent controls|defending player controls|an opponent controls with flying|you control with flying)$/i;
  for (;;) {
    const q = text.match(QUAL_RE);
    if (!q) break;
    quals.unshift(/^(?:named |that is |that are )/i.test(q[1]) ? q[1].replace(/^(named|that is|that are)/i, (w) => w.toLowerCase()) : q[1].toLowerCase());
    text = text.slice(0, q.index).trim();
  }
  // "the bottom card of target player's graveyard"
  if ((m = text.match(/^the (top|bottom) (.+?) of (?:target player's|target opponent's|that player's|an opponent's) graveyard$/i))) {
    const inner = parseNoun(`a ${m[2]}`);
    if (inner) {
      inner.filter.zone = 'graveyard';
      inner.filter.custom = m[1].toLowerCase() === 'top' ? 'topOfGraveyard' : 'bottomOfGraveyard';
      return { ...inner, plural: false, controllerPhrase: 'target player' };
    }
  }
  // "the top creature card of your graveyard"
  if ((m = text.match(/^the top (.+?) of (?:your|a) graveyard$/i))) {
    const inner = parseNoun(`a ${m[1]}`);
    if (inner) {
      inner.filter.zone = 'graveyard';
      inner.filter.owner = 'you';
      inner.filter.custom = 'topOfGraveyard';
      return { ...inner, plural: false };
    }
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
  result.plural = /(?:[^s]s|ies|ches|shes|xes)$/i.test(head) && !/^(?:this|~|us)$/i.test(head) && !/ss$/i.test(head) || /^(?:creatures|artifacts|enchantments|lands|planeswalkers|permanents|spells|cards|tokens|opponents|players)$/i.test(head) || head.toLowerCase() in IRREGULAR_PLURALS;
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
    // "a creature or token" — either the left-hand noun or any token.
    if (adjWords.length >= 2 && /^or$/i.test(adjWords[adjWords.length - 1])) {
      const left = parseNoun(`a ${adjWords.slice(0, -1).join(' ')}`);
      if (!left) return null;
      delete result.filter.isToken;
      result.filter.anyOf = [left.filter, { isToken: true }];
      for (const q of quals) applyQualifier(q, result);
      return result;
    }
    if (adjWords.length && !/^non/i.test(adjWords[adjWords.length - 1])) {
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
    result.filter.subtypes = [BASIC_TYPES.includes(head) ? head : head.replace(/s$/, '')];
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

/** Creature types whose plural is irregular ("Mice" → "Mouse"). */
const IRREGULAR_PLURALS: Record<string, string> = {
  mice: 'Mouse', wolves: 'Wolf', elves: 'Elf', dwarves: 'Dwarf', thieves: 'Thief', leaves: 'Leaf',
  children: 'Child', men: 'Man', women: 'Woman', people: 'Person', oxen: 'Ox', geese: 'Goose',
  fungi: 'Fungus', homunculi: 'Homunculus', nautili: 'Nautilus', loci: 'Locus', cacti: 'Cactus',
  wurms: 'Wurm', 'ouphes': 'Ouphe', knaves: 'Knave', dryads: 'Dryad',
  werewolves: 'Werewolf', heroes: 'Hero', knives: 'Knife', halves: 'Half', calves: 'Calf',
  shelves: 'Shelf', wives: 'Wife', lives: 'Life', selves: 'Self',
};
/** Creature types that are the same in the plural ("Fish", "Sheep", "Efreet"). */
const UNCHANGED_PLURALS = new Set(['fish', 'sheep', 'elk', 'moose', 'djinn', 'efreet', 'yeti', 'lammasu', 'atog', 'graveborn', 'aetherborn', 'phyrexian', 'kor', 'naga', 'nissa']);

/** Creature types whose singular already ends in "s" ("an Octopus", "two Aurochs"). */
const S_SINGULARS = new Set(['aurochs', 'octopus', 'pegasus', 'cyclops', 'locus', 'lotus', 'fungus', 'homunculus', 'nautilus', 'cactus', 'plains', 'gus', 'chaos']);
/** Types whose plural is "-ies" over a singular "-ie", not "-y" ("Zombies" → "Zombie"). */
const IE_SINGULARS = new Set(['zombie', 'faerie', 'valkyrie', 'genie', 'pixie', 'selkie', 'brownie', 'hippie', 'coyote']);

/** Words in a type list that end in "s" but are not plurals. */
const NOT_PLURAL_WORDS = new Set(['this', 'its', 'his', 'hers', 'theirs', 'is', 'as', 'has', 'was', 'does', 'yours', 'ours', 'less', 'unless', 'plus', 'versus', 'always', 'else', 'others', 'opponents', 'players']);

/** Singularise every plural word in a type list ("artifacts, creatures, and/or lands"). */
export function singularizeList(text: string): string {
  return text.replace(/\b[A-Za-z]+s\b/g, (w) => (NOT_PLURAL_WORDS.has(w.toLowerCase()) ? w : singularize(w)));
}

export function singularize(w: string): string {
  const l = w.toLowerCase();
  const irr = IRREGULAR_PLURALS[l];
  if (irr) return irr;
  if (S_SINGULARS.has(l)) return w;
  if (/^(Plains|Aetherborn|Serpents?)$/i.test(w)) return w.replace(/^Serpents$/i, 'Serpent');
  if (/ies$/.test(w)) {
    const ie = w.replace(/ies$/, 'ie');
    return IE_SINGULARS.has(ie.toLowerCase()) ? ie : w.replace(/ies$/, 'y');
  }
  // "Churches" / "Foxes" drop the whole "es"; "Horses" / "Oozes" only the final "s".
  if (/(ch|sh|x)es$/.test(w)) return w.replace(/es$/, '');
  if (/ses$/.test(w) && S_SINGULARS.has(w.slice(0, -2).toLowerCase())) return w.slice(0, -2);
  if (/(s|z)es$/.test(w)) return w.replace(/s$/, '');
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
    else if (l === 'transformed') r.filter.custom = 'transformed';
    else if (l === 'suspected') r.filter.custom = 'suspected';
    else if (l === 'goaded') r.filter.custom = 'goaded';
    else if (l === 'face-up' || l === 'faceup') r.filter.faceDown = false;
    else if (l === 'exiled') r.filter.zone = 'exile';
    else if (l === 'suspended') { r.filter.suspended = true; r.filter.zone = 'exile'; }
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
    else if (l === 'non-outlaw' || l === 'nonoutlaw') r.filter.notSubtypes = [...(r.filter.notSubtypes ?? []), 'Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'];
    else if (l === 'blocked') r.filter.custom = 'blocked';
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
    else if (l === 'face-down') r.filter.faceDown = true;
    else if (l === 'face-up') r.filter.faceDown = false;
    else if (l === 'nonsnow') r.filter.custom = 'nonsnow';
    else if (l === 'suspected') r.filter.customRule = 'suspected';
    else if (l === 'unblocked') r.filter.custom = 'unblocked';
    else if (l === 'nonattacking') r.filter.attacking = false;
    else if (l === 'nonblocking') r.filter.blocking = false;
    else if (/^\d+\/\d+$/.test(l)) {
      const [pw, tg] = l.split('/').map((n) => parseInt(n, 10));
      r.filter.powerLE = pw;
      r.filter.powerGE = pw;
      r.filter.toughnessLE = tg;
      r.filter.toughnessGE = tg;
    }
    else return false;
  }
  return true;
}

function applyQualifier(q: string, r: ParsedNoun) {
  let m: RegExpMatchArray | null;
  if (q === "from defending player's graveyard" || q === "in defending player's graveyard") {
    r.filter.zone = 'graveyard';
    r.filter.ownerRef = { ref: 'defendingPlayer' };
    r.isCard = true;
  } else if (q === "in an opponent's graveyard" || q === "from an opponent's graveyard" || q === "in that player's graveyard" || q === "from that player's graveyard" || q === 'in their graveyard' || q === 'from their graveyard') {
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
  else if ((m = q.match(/^with (?:a|an) ([\w' -]+) attached to (?:it|them)$/i)) || (m = q.match(/^that (?:is|are) enchanted by (?:a|an) ([\w' -]+)$/i))) {
    // Qualifiers arrive lowercased, so restore the head word's capital for subtype lookup.
    const inner = parseNoun(`a ${m[1].replace(/([\w'-]+)$/, (w) => w.charAt(0).toUpperCase() + w.slice(1))}`);
    if (inner && inner.confident) r.filter.hasAttachmentFilter = { ...inner.filter, zone: 'battlefield' };
    else r.confident = false;
  }
  else if ((m = q.match(/^(?:each )?with (power|toughness) greater than (?:its|their) base (power|toughness)$/i))) {
    if (m[1].toLowerCase() === 'power' && m[2].toLowerCase() === 'power') r.filter.powerGreaterThanBase = true;
    else r.confident = false;
  }
  else if (/^that (?:is|are) enchanted$/.test(q)) r.filter.hasAttachment = 'Aura';
  else if (/^that (?:is|are) equipped$/.test(q)) r.filter.hasAttachment = 'Equipment';
  else if (/^that (?:is|are) modified$/.test(q)) r.filter.modified = true;
  else if (/^(?:that (?:has|have)|with) an adventure$/i.test(q)) r.filter.hasAdventure = true;
  else if (/^with toughness greater than (?:its|their) power$/i.test(q)) r.filter.toughnessGreaterThanPower = true;
  else if (q === 'with the same controller') r.controllerPhrase = 'its controller';
  else if (/^that shares? a creature type with (?:~|it)$/i.test(q)) r.filter.sharesCreatureTypeWithSource = true;
  else if (q === 'from a single graveyard') r.filter.zone = 'graveyard';
  else if (/^the monarch controls$/.test(q)) r.filter.controllerRef = { ref: 'monarch' };
  else if ((m = q.match(/^with base power (\d+)$/))) r.filter.basePowerEQ = parseInt(m[1], 10);
  else if ((m = q.match(/^with base power (\d+) or less$/))) r.filter.basePowerLE = parseInt(m[1], 10);
  else if ((m = q.match(/^that (?:has|have) ([a-z ]+)$/))) r.filter.keywords = [m[1].charAt(0).toUpperCase() + m[1].slice(1)];
  else if (/^with \{x\} in (?:its|their) mana costs?$/i.test(q)) r.filter.custom = 'hasX';
  else if ((m = q.match(/^with \{([^}]+)\} in (?:its|their) mana costs?$/i))) r.filter.manaCostContains = `{${m[1].toUpperCase()}}`;
  else if (q === 'you do not own' || q === 'an opponent owns') r.filter.owner = 'opponent';
  else if (q === 'you control but do not own' || q === "you control but don't own") {
    r.filter.controller = 'you';
    r.filter.owner = 'opponent';
  }
  else if (q === 'that player controls' || q === 'defending player controls' || q === 'target player controls' || q === 'target opponent controls' || q === 'its controller controls' || q === 'that opponent controls' || q === 'they control') r.controllerPhrase = q === 'they control' ? 'they' : q.replace(/ controls$/, '');
  else if (q === 'on the battlefield') r.filter.zone = 'battlefield';
  else if (q === 'attached to it' || q === 'attached to ~') r.filter.attachedToSource = true;
  else if (/^with a single target$/.test(q)) r.filter.custom = 'singleTarget';
  else if (/^that targets only a player$/.test(q)) r.filter.custom = 'targetsOnlyPlayer';
  else if (/^that targets only (?:~|it)$/.test(q)) r.filter.custom = 'targetsSourceOnly';
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
  else if (q === 'that was dealt damage this turn' || q === 'that were dealt damage this turn' || q === 'dealt damage this turn') r.filter.damaged = true;
  else if (q === 'attached to a creature' || q === 'attached to a permanent') r.filter.attached = true;
  else if ((m = q.match(/^with (mana value|power|toughness) less than ((?:that|its|your|the) .+)$/))) {
    const a = parseAmount(m[2].replace(/^the /, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: true } as never);
    if (a === null) r.confident = false;
    else if (m[1] === 'mana value') r.filter.cmcLTAmount = a;
    else if (m[1] === 'power') r.filter.powerLTAmount = a;
    else r.filter.toughnessLTAmount = a;
  }
  else if ((m = q.match(/^with (?:equal or lesser|lesser) (mana value|power|toughness)$/))) {
    const a = { kind: m[1] === 'mana value' ? 'manaValue' : m[1] === 'power' ? 'power' : 'toughness', ref: { ref: 'triggerObject' } } as import('@commander/engine').Amount;
    if (m[1] === 'mana value') r.filter.cmcLEAmount = a;
    else if (m[1] === 'power') r.filter.powerLEAmount = a;
    else r.filter.toughnessLEAmount = a;
  }
  else if ((m = q.match(/^with (power|toughness) less than or equal to (.+)$/))) {
    const a = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a !== null) { if (m[1] === 'power') r.filter.powerLEAmount = a; else r.filter.toughnessLEAmount = a; }
    else r.confident = false;
  }
  else if (/^that (?:is|are) attached to (?:a|an) (?:creature|permanent|land|artifact|player)$/.test(q)) r.filter.attached = true;
  else if ((m = q.match(/^with mana value less than or equal to (.+)$/))) {
    const a = parseAmount(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a !== null) r.filter.cmcLEAmount = a;
    else r.confident = false;
  }
  else if ((m = q.match(/^named (.+)$/))) r.filter.nameIs = m[1] === '~' ? '~' : m[1];
  else if ((m = q.match(/^that is (?:a|an) (.+)$/))) r.filter.subtypes = m[1].split(/,? or (?:a |an )?|, (?:a |an )?/).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  else if ((m = q.match(/^that (?:does not|doesn't) have (?:a|an) ([+-]?[\w/+-]+) counters? on it$/))) r.filter.withoutCounter = m[1];
  else if ((m = q.match(/^that has (?:a|an) ([+-]?[\w/+-]+) counters? on it$/))) r.filter.counterAtLeast = { counter: m[1], n: 1 };
  else if (/^that shares? a colou?r with (?:~|it)$/.test(q) || /^that share a colou?r with (?:~|it)$/.test(q)) r.filter.sharesColorWith = { ref: 'self' };
  else if ((m = q.match(/^with power or toughness (\d+|X) or (greater|less)$/))) {
    const n = m[1].toUpperCase() === 'X' ? ('X' as const) : parseInt(m[1], 10);
    if (m[2] === 'less') r.filter.anyOf = [{ powerLE: n }, { toughnessLE: typeof n === 'number' ? n : undefined }];
    else r.filter.anyOf = [{ powerGE: n }, { toughnessGE: typeof n === 'number' ? n : undefined }];
  }
  else if (q === 'controlled by different players' || q === 'with equal toughness' || q === 'with equal power') {
    /* a targeting restriction the engine does not model; the filter is unchanged */
  }
  else if (/^that (?:aren't|are not|isn't|is not) enchanted$/.test(q)) r.filter.notAttachment = 'Aura';
  else if (/^that (?:aren't|are not|isn't|is not) equipped$/.test(q)) r.filter.notAttachment = 'Equipment';
  else if (q === 'attacking enchanted player') r.filter.attackingRef = { ref: 'attachedTo' };
  else if (/^attacking that (?:player|opponent)$/.test(q)) {
    r.filter.attacking = true;
    r.filter.custom = 'attackingSameDefender';
  } else if (/^that (?:aren't|are not|isn't|is not) of (?:the chosen type|a type chosen this way)$/.test(q)) r.filter.notChosenSubtypeKey = 'creatureType';
  else if (/^that (?:is|are) enchanted or equipped$/.test(q)) r.filter.anyOf = [{ hasAttachment: 'Aura' }, { hasAttachment: 'Equipment' }];
  else if (q === 'that dealt damage to you this turn') r.filter.dealtDamageToYouThisTurn = true;
  else if (/^that (?:aren't|are not|isn't|is not) legendary$/.test(q)) r.filter.legendary = false;
  else if ((m = q.match(/^that (?:have|has) (?:a |an )?([+\-\w\/]+) counters? on (?:it|them)$/))) r.filter.counterAtLeast = { counter: m[1], n: 1 };
  else if (/^(?:that (?:is|are) )?attacking you or (?:a )?planeswalkers? you control$/.test(q)) r.filter.custom = 'attackingYouOrYourPlaneswalker';
  else if ((m = q.match(/^with (power|toughness|mana value) (greater|less) than or equal to your life total$/))) {
    const a: import('@commander/engine').Amount = { kind: 'life', ref: { ref: 'controller' } };
    if (m[1] === 'power') { if (m[2] === 'greater') r.filter.powerGEAmount = a; else r.filter.powerLEAmount = a; }
    else if (m[1] === 'toughness') { if (m[2] === 'greater') r.filter.toughnessGEAmount = a; else r.filter.toughnessLEAmount = a; }
    else if (m[2] === 'greater') r.filter.cmcGEAmount = a; else r.filter.cmcLEAmount = a;
  }
  else if ((m = q.match(/^with (power|toughness|mana value) (greater|less) than the number of cards in your hand$/))) {
    const a: import('@commander/engine').Amount = { kind: 'handSize', ref: { ref: 'controller' } };
    if (m[1] === 'power') { if (m[2] === 'greater') r.filter.powerGEAmount = a; else r.filter.powerLEAmount = a; }
    else if (m[1] === 'toughness') { if (m[2] === 'greater') r.filter.toughnessGEAmount = a; else r.filter.toughnessLEAmount = a; }
    else if (m[2] === 'greater') r.filter.cmcGEAmount = a; else r.filter.cmcLEAmount = a;
  }
  else if (/^with the greatest power among creatures on the battlefield$/.test(q)) r.filter.custom = 'highestPower';
  else if ((m = q.match(/^with the greatest (power|toughness|mana value) among [\w ,]+ on the battlefield$/))) r.filter.custom = m[1] === 'mana value' ? 'highestManaValue' : m[1] === 'power' ? 'highestPower' : 'highestToughness';
  else if (q === 'you own or control') r.filter.anyOf = [{ owner: 'you' }, { controller: 'you' }];
  else if (q === 'that had counters put on it this way') r.filter.custom = 'countersPutThisWay';
  else if (/^that blocked or (?:was|were) blocked by (?:it|~) this turn$/.test(q)) r.filter.custom = 'blockedRelatedSource';
  else if ((m = q.match(/^that blocked or (?:was|were) blocked by (?:a|an) ([\w' -]+) this turn$/))) r.filter.custom = 'blockedRelated';
  else if (q === 'that blocked this turn') r.filter.blocking = true;
  else if (q === 'that attacked this turn') r.filter.attackedThisTurn = true;
  else if (/^that (?:is|are) attacking one of your opponents$/.test(q)) r.filter.custom = 'attackingOpponent';
  else if (q === 'except for ~') r.filter.other = true;
  else if (q === 'except for commanders') r.filter.isCommander = false;
  else if (q === 'except for legendary creatures') r.filter.legendary = false;
  else if (/^that (?:is|are) attacking or blocking$/.test(q)) r.filter.attackingOrBlocking = true;
  else if ((m = q.match(/^that (?:is|are) ((?:white|blue|black|red|green)(?:(?:,? or | and\/or |, )(?:white|blue|black|red|green))+)$/))) {
    const map: Record<string, 'W' | 'U' | 'B' | 'R' | 'G'> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    r.filter.colors = m[1].split(/,? or | and\/or |, /).map((w) => map[w.trim()]).filter(Boolean) as ('W' | 'U' | 'B' | 'R' | 'G')[];
  }
  else if ((m = q.match(/^(?:with|that (?:has|have)) (awaken|warp|suspend|disturb|flashback|madness|embalm|eternalize|bestow|evoke|emerge|escape|plot|rebound|aftermath|retrace|dredge|haunt|miracle|encore|jump-start|adventure|unearth|mutate|prototype|casualty)$/))) r.filter.keywords = [...(r.filter.keywords ?? []), m[1].replace(/^\w/, (c) => c.toUpperCase())];
  else if ((m = q.match(/^with (plains|island|swamp|mountain|forest)walk$/))) r.filter.keywords = [...(r.filter.keywords ?? []), `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}walk`];
  else if ((m = q.match(/^with (mana value|power|toughness) (less|greater) than ~'s (?:mana value|power|toughness)$/))) {
    r.filter.custom = `${m[1] === 'mana value' ? 'cmc' : m[1]}${m[2] === 'less' ? 'LT' : 'GT'}Source`;
  }
  else if ((m = q.match(/^with an (odd|even) mana value$/))) r.filter.custom = m[1] === 'odd' ? 'oddManaValue' : 'evenManaValue';
  else if (/^(?:in exile and in your graveyard|in your graveyard and in exile)$/.test(q)) {
    r.filter.zone = ['exile', 'graveyard'];
    r.filter.owner = 'you';
  } else if (q === 'that entered the battlefield under your control this turn') {
    r.filter.enteredThisTurn = true;
    r.filter.controller = 'you';
  } else if ((m = q.match(/^with (\w+(?:(?:,|,? and\/or|,? or) \w+)+)$/)) && m[1].split(/,? and\/or |,? or |, /).every((w) => KEYWORD_QUALS.has(w))) {
    r.filter.keywords = m[1].split(/,? and\/or |,? or |, /).map((w) => w.replace(/\b\w/g, (c) => c.toUpperCase()));
  } else if (/^with the chosen name$/.test(q)) r.filter.nameIsChosen = 'cardName';
  else if ((m = q.match(/^with (flanking|banding|exalted|bushido|soulbond|exploit|melee|mentor|myriad|extort|afterlife|training|backup|decayed|toxic|annihilator|rampage|fading|vanishing|phasing|echo)$/))) r.filter.keywords = [m[1].replace(/^\w/, (c) => c.toUpperCase())];
  else if (/^(?:with|that (?:has|have)) (?:a|an) basic land type$/.test(q)) r.filter.subtypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  else if (/^with the greatest power or tied for greatest power$/.test(q)) r.filter.highestPower = true;
  else if ((m = q.match(/^without (?:a|an) ([+\-\w\/]+) counters? on (?:it|them)$/))) r.filter.withoutCounter = m[1];
  else if (/^that (?:is|are) not historic$/.test(q)) r.filter.notHistoric = true;
  else if (/^that (?:is|are) historic$/.test(q)) r.filter.historic = true;
  else if ((m = q.match(/^with power, toughness, or mana value (\d+)$/))) { const v = parseInt(m[1], 10); r.filter.anyOf = [{ powerEQ: v }, { toughnessEQ: v }, { cmcEQ: v }]; }
  else if ((m = q.match(/^with mana value (\d+) or (\d+)$/))) r.filter.anyOf = [{ cmcEQ: parseInt(m[1], 10) }, { cmcEQ: parseInt(m[2], 10) }];
  else if ((m = q.match(/^that (?:is|are) not (?:a|an) ([A-Za-z][a-z]+)$/))) (r.filter.notSubtypes ??= []).push(m[1].replace(/^\w/, (ch) => ch.toUpperCase()));
  else if ((m = q.match(/^that (?:is|are) ([\w-]+ cards?(?:, [\w-]+ cards?)*(?:,? (?:and\/or|or|and) (?:[\w-]+ cards?|have an Adventure))?)$/))) {
    const words = m[1].replace(/,? (?:and\/or|or|and) /g, ', ').split(/,\s*/).map((w) => w.replace(/ cards?$/i, '').trim()).filter(Boolean);
    const alts = words.map((w) => (/^have an Adventure$/i.test(w) ? ({ hasAdventure: true } as ObjectFilter) : parseNoun(`a ${w} card`)?.filter)).filter((f): f is ObjectFilter => !!f);
    if (alts.length === words.length && alts.length > 1) r.filter.anyOf = alts;
    else r.confident = false;
  }
  else if (/^with mana value of (?:the chosen|that) quality$/.test(q)) r.filter.manaValueParityChosen = 'choice';
  else if (/^that (?:do not|don't|does not|doesn't) have a name$/.test(q)) r.filter.custom = 'noName';
  else if (/^that convoked (?:it|~)$/.test(q)) r.filter.convokedSource = true;
  else if (/^that (?:crewed|saddled) (?:it|~)(?: this turn)?$/.test(q)) r.filter.custom = 'crewedSource';
  else if (/^that attacked during (?:their controller's|your) last turn$/.test(q)) r.filter.custom = 'attackedLastTurn';
  else if (q === 'with no abilities') r.filter.noAbilities = true;
  else if (q === 'of the chosen color' || /^of the colou?r of your choice$/.test(q)) r.filter.chosenColorKey = 'color';
  else if ((m = q.match(/^without (\w+(?: or \w+)+)$/))) r.filter.withoutKeywords = m[1].split(/ or /).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  else if ((m = q.match(/^that (?:is|are) ([A-Z][a-z]+)s? or tokens$/))) r.filter.anyOf = [{ subtypes: [singularize(m[1])] }, { isToken: true }];
  else if (/^attached to (?:that|target) creature$/.test(q)) r.filter.attachedToRef = { ref: 'target' };
  else if (q === 'with different controllers') { /* a targeting restriction the engine does not model */ }
  else if (q === 'your team controls') r.filter.controller = 'you';
  else if (q === 'it is blocking') r.filter.blockingSource = true;
  else if (/^of (?:that|the chosen) colou?r$/.test(q)) r.filter.chosenColorKey = 'color';
  else if (/^cast from (?:a|your) graveyard$/.test(q)) r.filter.castFromZone = 'graveyard';
  else if (/^cast from exile$/.test(q)) r.filter.castFromZone = 'exile';
  else if (/^cast from (?:a|your) hand$/.test(q)) r.filter.castFromZone = 'hand';
  else if (/^that (?:wasn't|was not) cast from (?:its owner's|their|a) hand$/.test(q)) r.filter.notCastFromZone = 'hand';
  else if (/^that (?:wasn't cast|was not cast|were not cast)$/.test(q)) r.filter.custom = 'notCast';
  else if (/^created with (?:~|it)$/.test(q)) r.filter.custom = 'createdBySource';
  else if (/^that (?:is|are) attacking you$/.test(q)) r.filter.custom = 'attackingYou';
  else if (/^that (?:aren't|are not|isn't|is not) on the battlefield$/.test(q)) r.filter.zoneIn = ['hand', 'library', 'graveyard', 'exile'];
  else if (/^except for tokens(?: you control)?$/.test(q)) r.filter.nonToken = true;
  else if (/^of (?:their|your|its controller's|his or her|an opponent's|that player's|defending player's) choice$/.test(q)) {
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
  } else if (/^without flanking blocking (?:~|it)$/.test(q)) { r.filter.blockingSource = true; r.filter.withoutKeywords = [...(r.filter.withoutKeywords ?? []), 'Flanking']; }
  else if (q === 'without flying') r.filter.withoutKeywords = ['Flying'];
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
  } else if (q === 'of the chosen type' || q === 'of that type' || q === 'of the chosen creature type' || q === 'of the creature type of your choice') r.filter.chosenSubtypeKey = 'creatureType';
  else if ((m = q.match(/^with total power and toughness (\d+) or less$/))) r.filter.ptSumLE = parseInt(m[1], 10);
  else if (q === 'with the greatest power') r.filter.highestPower = true;
  else if (q === 'with the greatest mana value') r.filter.highestManaValue = true;
  else if (q === 'with the least toughness') r.filter.lowestToughness = true;
  else if (q === 'with the least power') r.filter.lowestPower = true;
  else if (q === 'with the greatest toughness') r.confident = false;
  else if (/^with the greatest power among creatures/.test(q)) r.filter.highestPower = true;
  else if (/^with the greatest mana value among /.test(q)) r.filter.highestManaValue = true;
  else if ((m = q.match(/^with mana value (\d+|x)$/))) {
    if (m[1] === 'x') r.confident = false;
    else r.filter.cmcEQ = parseInt(m[1], 10);
  } else if ((m = q.match(/^with a (\+1\/\+1|-1\/-1|loyalty|charge) counter on (?:it|them)$/))) r.filter.hasCounter = m[1];
  else if (q === 'that dealt damage this turn') r.filter.dealtDamageThisTurn = true;
  else if (q === 'that entered this turn' || q === 'that entered the battlefield this turn') r.filter.enteredThisTurn = true;
  else if (q === 'exiled with ~' || q === 'exiled with it') {
    r.filter.exiledWithSource = true;
    r.filter.zone = 'exile';
    r.isCard = true;
  } else if (q === 'with counters on it' || q === 'with counters on them') r.filter.custom = 'hasAnyCounter';
  else if ((m = q.match(/^other than (?:a|an) ([\w -]+) card$/))) {
    const inner = parseNoun(`a ${m[1]} card`);
    if (!inner) r.confident = false;
    else if (inner.filter.types?.length) r.filter.notTypes = [...(r.filter.notTypes ?? []), ...inner.filter.types];
    else if (inner.filter.supertypes?.length) r.filter.custom = 'nonbasic';
    else r.confident = false;
  } else if (q === 'that blocked or was blocked this turn' || q === 'that blocked or were blocked this turn') r.filter.custom = 'blockedOrWasBlockedThisTurn';
  else if (q === 'with that name') r.filter.nameIsChosen = 'cardName';
  else if (q === 'with one or more counters on it' || q === 'with one or more counters on them') r.filter.hasAnyCounter = true;
  else if (q === 'that is all colors' || q === 'are all colors') r.filter.allColors = true;
  else if (q === 'that is not all colors' || q === 'are not all colors') r.filter.notAllColors = true;
  else if (q === 'attached to permanents you control' || q === 'attached to creatures you control') {
    r.filter.attachedToFilter = { controller: 'you', ...(q.includes('creatures') ? { types: ['Creature'] } : {}) };
  } else if (q === 'you both own and control') {
    r.filter.controller = 'you';
    r.filter.owner = 'you';
  } else if (/^that (?:was|were) blocked by that creature this (?:turn|combat)$/.test(q)) r.filter.blockedBySource = true;
  else if (q === 'blocking it' || q === 'blocking ~' || q === 'that blocked ~ this turn' || q === 'that blocked it this turn') r.filter.blockingSource = true;
  else if (q === 'blocked by it' || q === 'blocked by ~' || q === '~ is blocking' || q === 'it is blocking') r.filter.blockedBySource = true;
  else if ((m = q.match(/^with (power|toughness) (\d+|X)$/))) {
    const v = m[2] === 'X' ? ('X' as const) : parseInt(m[2], 10);
    if (m[1] === 'power') r.filter.powerEQ = v;
    else r.filter.toughnessEQ = v;
  }
  else if (q === 'blocking or blocked by it' || q === 'blocking or blocked by ~') r.filter.blockingOrBlockedBySource = true;
  else if (q === 'other than ~' || q === 'not named ~') r.filter.other = true;
  else if (q === 'that is one or more colors' || q === 'that are one or more colors') r.filter.custom = 'colored';
  else if (q === 'that was put there from anywhere this turn') r.filter.enteredZoneThisTurn = true;
  else if (q === 'that was put there this turn' || q === 'that were put there this turn' || q === 'that was put there from the battlefield this turn' || q === 'that were put there from the battlefield this turn') r.filter.enteredZoneThisTurn = true;
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
  if (n.playerCondition) spec.playerCondition = n.playerCondition;
  if (n.playerTurnStat) spec.playerTurnStat = n.playerTurnStat;
  if (n.kind === 'object' || n.kind === 'objectOrPlayer' || n.kind === 'any' || n.kind === 'spell' || n.kind === 'objectOrSpell') {
    const f: ObjectFilter = { ...n.filter };
    if (n.kind !== 'spell' && !f.zone) f.zone = 'battlefield';
    if (n.kind === 'objectOrSpell') f.zone = 'battlefield';
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
