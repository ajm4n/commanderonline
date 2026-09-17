/** Sentence → Effect[] parser. */
import type { Effect, Ref, TargetSpec, TokenSpec, Duration, Color, ObjectFilter, Amount, Condition } from '@commander/engine';
import { TOKEN_PRESETS, parseAddManaText } from '@commander/engine';
import { wordToNumber, sentences, lc } from './text.js';
import { parseNoun, toTargetSpec, type ParsedNoun } from './nouns.js';
import { parseAmount } from './amounts.js';
import { parseCondition } from './conditions.js';
import { parseTriggerHead } from './triggers.js';
import { parseCost } from './costs.js';
import { parseStatic } from './statics.js';
import { damageSourceFilter, damageDestFilter, damageModifier } from './damage.js';

export interface ParseCtx {
  targets: TargetSpec[];
  lastObj: Ref | null;
  lastPlayer: Ref | null;
  /** Inside a trigger whose event carries an object / player. */
  triggerHasObject: boolean;
  triggerHasPlayer: boolean;
  /** The line is on an instant/sorcery (affects "~" meaning for return-to-hand etc.). */
  isSpell: boolean;
  /** Inside a trigger whose subject is the event's source (damage dealer) rather than its object. */
  triggerObjectIsSource?: boolean;
  /** Memory key of a looked-at / revealed pool of library cards that "the rest" refers to. */
  restKey?: string;
  /** The creature that just explored (for "Whenever a creature you control explores"). */
  exploreRef?: Ref;
}

export function newCtx(partial: Partial<ParseCtx> = {}): ParseCtx {
  return { targets: [], lastObj: null, lastPlayer: null, triggerHasObject: false, triggerHasPlayer: false, isSpell: false, ...partial };
}

const SELF: Ref = { ref: 'self' };
const YOU: Ref = { ref: 'controller' };

const EXTRA_KEYWORDS = ['mentor', 'exalted', 'banding', 'melee', 'flanking', 'bushido', 'decayed', 'training', 'backup', 'plainswalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'forestwalk', 'landwalk', 'phasing', 'rampage', 'annihilator', 'afflict', 'battle cry', 'dethrone', 'myriad', 'extort', 'ingest', 'devoid', 'wither', 'toxic', 'riot', 'unleash', 'undying', 'persist', 'protection from the chosen color', 'protection from all colors', 'hexproof from each color', 'ward {1}', 'ward {2}', 'ward {3}', 'ward {4}', 'ward—pay 2 life', 'ward—pay 3 life', 'cumulative upkeep', 'cascade', 'storm', 'prowess', 'evolve', 'skulk', 'shadow', 'horsemanship', 'fear', 'intimidate', 'convoke', 'delve', 'improvise', 'ravenous', 'daybound', 'nightbound', 'squad', 'enlist', 'sunburst', 'modular', 'vanishing', 'fading', 'echo', 'living weapon', 'reconfigure', 'compleated', 'for mirrodin!', 'jump-start', 'afterlife', 'ascend', 'exert', 'crew', 'partner', 'changeling'];
const KEYWORD_WORDS = ['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance', 'haste', 'flash', 'defender', 'reach', 'menace', 'hexproof', 'indestructible', 'shroud', 'fear', 'intimidate', 'skulk', 'horsemanship', 'shadow', 'infect', 'wither', 'prowess', 'undying', 'persist', 'changeling', 'protection from white', 'protection from blue', 'protection from black', 'protection from red', 'protection from green', 'protection from all colors', 'protection from each color', 'protection from creatures', 'protection from artifacts', 'protection from everything', 'protection from instants', 'protection from sorceries', 'protection from planeswalkers', 'protection from colorless', 'protection from multicolored', 'protection from monocolored', 'hexproof from white', 'hexproof from blue', 'hexproof from black', 'hexproof from red', 'hexproof from green'];

export function parseKeywordList(text: string): string[] | null {
  const parts = text
    .toLowerCase()
    .replace(/ and from /g, ', protection from ')
    .replace(/,? and /g, ', ')
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    const q = p.replace(/^(?:your choice of )/, '');
    if (!KEYWORD_WORDS.includes(q) && !EXTRA_KEYWORDS.includes(q) && !/^(?:protection from [a-z ]+|hexproof from [a-z ]+|ward \{[^}]+\}|[a-z]+walk|(?:annihilator|bushido|rampage|toxic|afflict|fabricate|modular|absorb|ripple|poisonous|frenzy|renown|backup|squad|crew|reinforce|bloodthirst|graft|amplify|soulshift|firebending|waterbending|earthbending|airbending|mobilize|devour|training|spectacle|afterlife|vanishing|fading|dredge|ripple|frenzy|poisonous|absorb|level up|tribute) \d+|(?:unearth|cycling|flashback|escape|scavenge|replicate|conspire|retrace|miracle|madness|outlast|encore|bestow|embalm|eternalize|evoke|emerge|prowl|blitz|dash|foretell|disturb|spectacle|surge|overload|aftermath|transmute|buyback|entwine|splice|awaken|kicker|multikicker|slivercycling|landcycling|typecycling|basic landcycling|plainscycling|islandcycling|swampcycling|mountaincycling|forestcycling|wizardcycling|slivercycling|reconfigure|equip|fortify|ninjutsu|commander ninjutsu|freerunning|impending|offspring|gift|craft|discover|plot|squad|casualty|cleave|escalate|prototype) (?:(?:\{[^}]+\})+|\d+|—.+)|(?:flashback|escape|scavenge|replicate|conspire|retrace|unearth|embalm|eternalize|miracle|madness|outlast|encore|bestow|aftermath|retrace|dredge|haunt|epic|evoke|emerge|prowl|blitz|dash|foretell|disturb|jump-start|spectacle|surge|overload|entwine|buyback|awaken|cascade|storm|delve|discover|plot|craft|forage|cloak|manifest dread|read ahead|hope|exploit|mono|continuous|flanking|banding|soulbond|melee|ascend|myriad|extort|convoke|improvise|riot|exalted|fear|intimidate|totem armor|split second|devoid|ingest|skulk|partner|mutate|boast|will of the council|council's dilemma|goaded|decayed|toxic|for mirrodin!|living weapon|reconfigure|compleated|daybound|nightbound|start your engines!|max speed|tap to attack))$/.test(q)) return null;
    out.push(q.charAt(0).toUpperCase() + q.slice(1));
  }
  return out;
}

function duration(text: string): { rest: string; duration: Duration | undefined } {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^(.*?)\s+until end of turn$/i))) return { rest: m[1], duration: 'endOfTurn' };
  if ((m = text.match(/^(.*?)\s+until your next turn$/i))) return { rest: m[1], duration: 'untilYourNextTurn' };
  if ((m = text.match(/^(.*?)\s+until end of combat$/i))) return { rest: m[1], duration: 'endOfCombat' };
  if ((m = text.match(/^(.*?)\s+this turn$/i))) return { rest: m[1], duration: 'endOfTurn' };
  return { rest: text, duration: undefined };
}

/** Resolve an object phrase to a Ref, registering targets. */
export function objRef(phrase: string, ctx: ParseCtx): Ref | null {
  const t = phrase.trim().replace(/[.,]$/, '').replace(/^a second target /i, 'another target ');
  const l = t.toLowerCase();
  let m0: RegExpMatchArray | null;
  if (l === '~' || l === 'this') {
    ctx.lastObj = SELF;
    return SELF;
  }
  if (/^each of (?:them|those (?:creatures|permanents|cards|tokens|lands))$/.test(l)) return ctx.lastObj ?? { ref: 'lastMoved' };
  if ((m0 = l.match(/^the player or planeswalker (it|that creature|~) is attacking$/))) return { ref: 'defenderOf', of: m0[1] === '~' ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  if (/^(each creature|all creatures|creatures) blocking (?:it|~|that creature)$/.test(l)) return { ref: 'blockersOf', of: l.endsWith('~') ? SELF : ctx.lastObj ?? SELF };
  if (/^(?:the|a|an|one of the) (?:card|creature card|permanent card)s? exiled with ~$/.test(l) || /^the exiled cards?$/.test(l) || /^cards exiled with ~$/.test(l) || /^(?:a|the) card (?:you )?exiled with cards named ~$/.test(l)) return { ref: 'chosen', key: 'exiled' };
  if (/^the creature that attacked$/.test(l)) return ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF;
  if (/^(it|them|they|that (creature|permanent|card|artifact|enchantment|land|planeswalker|token|spell)|those (creatures|permanents|cards|tokens|lands|artifacts|enchantments|planeswalkers|spells)|the (creature|permanent|card)|that object|the (?:returned|chosen) cards?)$/.test(l) || /^that [A-Z]\w+$/i.test(t)) {
    if (l.includes('token') && !ctx.lastObj) return { ref: 'lastCreated' };
    // On a permanent, a bare "it" with nothing else in scope means the permanent itself ("if ~ is tapped, put a counter on it").
    // With no antecedent in scope, fall back to the last object this script moved ("put that card onto the battlefield").
    return ctx.lastObj ?? (ctx.triggerHasObject ? (ctx.triggerObjectIsSource ? { ref: 'triggerSource' } : { ref: 'triggerObject' }) : l === 'it' ? SELF : { ref: 'lastMoved' });
  }
  if (/^(enchanted|equipped|fortified) (creature|permanent|land|player|artifact|planeswalker|enchantment)$/.test(l) || /^(?:enchanted|equipped) [A-Z]\w+$/i.test(t)) return { ref: 'attachedTo' };

  if (/^each (?:\w+ )?(?:permanent|card|creature|player)s? with the most votes(?: or tied for most votes)?$/.test(l)) return { ref: 'chosen', key: 'votes' };
  if (/^(that|those) tokens?$/.test(l) || l === 'the tokens' || l === 'the token') return { ref: 'lastCreated' };
  if (/^(that|the) spell$/.test(l)) return ctx.lastObj ?? { ref: 'stackTarget' };
  if (l === 'the chosen creature' || l === 'the chosen permanent') return { ref: 'chosen', key: 'chosen' };
  const gy = t.match(/^~ from your graveyard$/i);
  if (gy) return SELF;
  const noun = parseNoun(t);
  if (!noun) return null;
  if (noun.controllerPhrase) {
    const pr = playerRef(noun.controllerPhrase, ctx);
    if (!pr) return null;
    noun.filter.controllerRef = pr;
  }
  if (noun.target) {
    const spec = toTargetSpec(noun);
    ctx.targets.push(spec);
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    if (noun.kind !== 'player') ctx.lastObj = ref;
    if (noun.kind !== 'object') ctx.lastPlayer = ref;
    return ref;
  }
  if (noun.each || (noun.plural && !noun.indefinite)) {
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone) f.zone = 'battlefield';
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return ref;
  }
  return null;
}

/** For indefinite nouns ("a land you control"): produce a choose effect and a ref to the choice. */
export function chooseRef(phrase: string, ctx: ParseCtx, who: Ref = YOU, upTo = false): { pre: Effect[]; ref: Ref } | null {
  const noun = parseNoun(phrase.trim());
  if (!noun || noun.target || noun.each) return null;
  if (noun.controllerPhrase) {
    const pr = playerRef(noun.controllerPhrase, ctx);
    if (!pr) return null;
    noun.filter.controllerRef = pr;
  }
  const f: ObjectFilter = { ...noun.filter };
  if (!f.zone) f.zone = 'battlefield';
  if (f.zone === 'battlefield' && !f.controller && who.ref === 'controller') f.controller = 'you';
  const key = `chosen${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
  const n = noun.count === 'X' ? 'X' : noun.count;
  const ref: Ref = { ref: 'chosen', key };
  ctx.lastObj = ref;
  return { pre: [{ kind: 'chooseObjects', who, filter: f, count: n, key, upTo }], ref };
}

export function playerRef(phrase: string, ctx: ParseCtx): Ref | null {
  const l = phrase.trim().toLowerCase().replace(/[.,]$/, '');
  if (l === 'you') return YOU;
  if (l === 'each opponent' || l === 'your opponents' || l === 'each of your opponents') return { ref: 'eachOpponent' };
  if (l === 'each player' || l === 'all players') return { ref: 'eachPlayer' };
  // With no antecedent, "that player" means whoever controls the object this script last touched.
  if (l === 'that player' || l === 'that opponent' || l === 'they' || l === 'the player') return ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' } : ctx.triggerHasObject ? { ref: 'triggerController' } : { ref: 'controllerOf', of: { ref: 'lastMoved' } });
  if (l === 'each other player' || l === 'all other players' || l === 'each of your opponents') return { ref: 'eachOpponent' };
  // "Each player other than its controller" / "... other than target player"
  {
    const ot = phrase.trim().match(/^each (?:player|other player) other than (.+)$/i);
    if (ot) {
      const except = playerRef(ot[1], ctx);
      if (except) return { ref: 'playersExcept', except };
    }
  }
  if (l === 'each other opponent' || l === 'each of their opponents' || l === 'each other player who is an opponent') return { ref: 'eachOtherOpponent' };
  if (l === 'its controller' || /^(?:that|the) [\w ]+'s controller$/.test(l) || l === 'the controller of that creature' || l === 'the controller of that permanent') return { ref: 'controllerOf', of: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  if (l === "~'s controller") return { ref: 'controllerOf', of: SELF };
  if (/^(?:enchanted|equipped) \w+'s controller$/.test(l)) return { ref: 'controllerOf', of: { ref: 'attachedTo' } };
  if (l === 'its owner' || l === "that card's owner") return { ref: 'ownerOf', of: ctx.lastObj ?? { ref: 'triggerObject' } };
  if (l === 'defending player' || l === 'the defending player') return { ref: 'defendingPlayer' };
  if (l === 'the active player') return { ref: 'activePlayer' };
  if (l === "enchanted player" || l === "that player's controller") return { ref: 'attachedTo' };
  if (l === 'the chosen player' || l === 'the chosen opponent') return { ref: 'chosen', key: 'opponent' };
  if (/^the player or planeswalker (?:it|that creature|~) is attacking$/.test(l)) return { ref: 'defenderOf', of: /~ is attacking$/.test(l) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  const noun = parseNoun(phrase);
  if (noun && noun.kind === 'player' && noun.target) {
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastPlayer = ref;
    return ref;
  }
  return null;
}

/** "An opponent" as an actor (piles, choices): one opponent, not each. */
function actorRef(phrase: string, ctx: ParseCtx): Ref | null {
  if (/^(?:an opponent|a player|an opponent of your choice|one of your opponents)$/i.test(phrase.trim())) return { ref: 'eachOpponent' };
  return playerRef(phrase, ctx);
}

/** Object-or-player phrase (damage targets, "any target"). */
function anyRef(phrase: string, ctx: ParseCtx): Ref | null {
  const l = phrase.trim().toLowerCase();
  if (l === 'each creature and each player' || l === 'each creature and each planeswalker and each player') return null; // handled by caller
  // "that permanent or player" refers back to an "any target" already chosen.
  if (/^that (?:permanent or player|creature, player, or planeswalker|permanent, player or planeswalker)$/i.test(l) && ctx.lastObj) return ctx.lastObj;
  return playerRef(phrase, ctx) ?? objRef(phrase, ctx);
}

const COLOR_MAP: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/** Parse "a 1/1 white Soldier creature token with vigilance" etc. */
export function parseTokenPhrase(text: string): { count: Amount; token: TokenSpec; tapped?: boolean; attacking?: boolean } | null {
  {
    // "Guenhwyvar, a legendary 4/1 green Cat creature token with trample"
    const nm = text.trim().match(/^([A-Z][\w' -]*(?:, [A-Z][\w' -]*)?), ((?:a|an) .+ token.*)$/);
    if (nm && !/^(?:a|an|two|three|four|five|X)\b/i.test(nm[1])) {
      const inner = parseTokenPhrase(nm[2]);
      if (inner) return { ...inner, token: { ...inner.token, name: nm[1], legendary: true } };
    }
  }
  let t = text.trim().replace(/\.$/, '');
  let tapped = false;
  let attacking = false;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(.*?)(?:,| and)? (?:that is|that are) tapped and attacking$/))) {
    t = m[1];
    tapped = attacking = true;
  } else if ((m = t.match(/^(.*?) tapped and attacking$/))) {
    t = m[1];
    tapped = attacking = true;
  } else if ((m = t.match(/^(.*?)(?:,)? (?:that is|that are) attacking$/))) {
    t = m[1];
    attacking = true;
  } else if ((m = t.match(/^(.*?) tapped$/))) {
    t = m[1];
    tapped = true;
  }
  // Copy tokens
  if ((m = t.match(/^(a|an|\w+|X) (?:tapped and attacking |tapped )?tokens? that (?:is|are) (?:a )?cop(?:y|ies) of (.+)$/i))) {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    if (/^(?:a|an|\w+|X) tapped/i.test(t)) tapped = true;
    if (/^(?:a|an|\w+|X) tapped and attacking/i.test(t)) attacking = true;
    const ctx = newCtx({ triggerHasObject: true });
    const ref = objRef(m[2], ctx);
    if (!ref || ctx.targets.length) return null; // copy targets are handled by the caller pattern
    return { count: n, token: { name: 'Copy', typeLine: '', colors: [], copyOf: ref }, tapped, attacking };
  }
  // "a 2/2 red Dragon creature token with flying and \"{R}: ~ gets +1/+0 until end of turn.\""
  {
    const qm = t.match(/^(.+? token(?: named (?:~'s |[A-Z])[\w' ,-]*?)?(?: with [^"]+?)?)(?:,| and| with) "(.+)"$/i);
    if (qm) {
      const base = parseTokenPhrase(qm[1].replace(/,$/, '').replace(/ and$/, '').replace(/ with$/, ''));
      if (base) {
        const text2 = base.token.oracleText ? `${base.token.oracleText}\n${qm[2]}` : qm[2];
        return { ...base, token: { ...base.token, oracleText: text2 } };
      }
    }
  }
  // "a 0/1 green Wall creature token with defender named Wood" → move the name ahead of the "with" clause
  {
    const rm = t.match(/^(.+? tokens?) (with .+?) (named (?:~'s |[A-Z])[\w' ,-]*)$/i);
    if (rm) t = `${rm[1]} ${rm[3]} ${rm[2]}`;
  }
  m = t.match(/^(a|an|twice that many|that many|\w+|X) (.+?) tokens?(?: named ((?:~'s |[A-Z])[\w' ,-]*?))?(?: with (.+))?$/i);
  if (!m) return null;
  const n: Amount | null = /that many/i.test(m[1]) ? (/twice/i.test(m[1]) ? { kind: 'times', a: { kind: 'triggerAmount' }, b: 2 } : { kind: 'triggerAmount' }) : wordToNumber(m[1]);
  if (n === null) return null;
  let body = m[2];
  if (/^tapped /i.test(body)) {
    tapped = true;
    body = body.replace(/^tapped /i, '');
  }
  const name = m[3];
  const withText = m[4];
  const spec: TokenSpec = { name: '', typeLine: '', colors: [] };
  if ((/^legendary /i).test(body)) {
    spec.legendary = true;
    body = body.replace(/^legendary /i, '');
  }
  const pt = body.match(/^([\dX*]+)\/([\dX*]+) (.+)$/);
  if (pt) {
    spec.power = pt[1];
    spec.toughness = pt[2];
    body = pt[3];
  }
  // colors
  const colorRe = /^((?:white|blue|black|red|green|colorless)(?:(?:,| and| or) (?:white|blue|black|red|green))*) (.+)$/i;
  const cm = body.match(colorRe);
  if (cm) {
    for (const w of cm[1].toLowerCase().split(/,? and |, | or /)) if (COLOR_MAP[w]) spec.colors.push(COLOR_MAP[w]);
    body = cm[2];
  }
  // remaining: subtype words + card types
  const words = body.split(/\s+/);
  const types: string[] = [];
  const subtypes: string[] = [];
  for (const w of words) {
    const l = w.toLowerCase();
    if (l === 'creature') types.push('Creature');
    else if (l === 'artifact') types.push('Artifact');
    else if (l === 'enchantment') types.push('Enchantment');
    else if (l === 'land') types.push('Land');
    else if (/^[A-Z]/.test(w)) subtypes.push(w);
    else return null;
  }
  if (!types.length && subtypes.length === 1 && TOKEN_PRESETS[subtypes[0]] && !spec.power) {
    const preset = TOKEN_PRESETS[subtypes[0]];
    return { count: n, token: { ...preset, preset: subtypes[0] }, tapped, attacking };
  }
  if (!types.length) types.push(spec.power ? 'Creature' : 'Artifact');
  spec.typeLine = types.join(' ') + (subtypes.length ? ` — ${subtypes.join(' ')}` : '');
  spec.name = name ?? (subtypes.length ? subtypes.join(' ') : types.join(' '));
  if (withText) {
    // 'with flying' / 'with "..."' / 'with haste and trample'
    const kws = parseKeywordList(withText.replace(/"/g, ''));
    if (kws) spec.keywords = kws;
    else if (/^"/.test(withText)) spec.oracleText = withText.replace(/^"|"$/g, '');
    else return null;
  }
  return { count: n, token: spec, tapped, attacking };
}

type Pattern = [RegExp, (m: RegExpMatchArray, ctx: ParseCtx) => Effect[] | null];

function amt(text: string, ctx: ParseCtx) {
  // "target creature's power": register the target here, since the amount parser cannot.
  const tm = text.trim().match(/^(?:the )?(target [\w' -]+?)'s (power|toughness|mana value)$/i);
  if (tm) {
    const ref = objRef(tm[1], ctx);
    if (ref) return { kind: tm[2].toLowerCase() === 'power' ? 'power' : tm[2].toLowerCase() === 'toughness' ? 'toughness' : 'manaValue', ref } as Amount;
  }
  const hm = text.trim().match(/^the number of cards in (target (?:player|opponent))'s (hand|graveyard)$/i);
  if (hm) {
    const who = playerRef(hm[1], ctx);
    if (who) return (hm[2].toLowerCase() === 'hand' ? { kind: 'handSize', ref: who } : { kind: 'graveyardSize', ref: who }) as Amount;
  }
  return parseAmount(text, { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer, resolvePlayer: (p) => playerRef(p, ctx) });
}

/** "for each X": a count of matching objects, or any other amount phrase. */
function perEach(phrase: string, ctx: ParseCtx): Amount | null {
  const both = phrase.match(/^(.+?) and (?:each |for each )?(.+)$/i);
  if (both && !/\b(and|or)\b/i.test(both[1])) {
    const a = perEach(both[1], ctx);
    const b = a ? perEach(both[2], ctx) : null;
    if (a && b) return { kind: 'sum', parts: [a, b] };
  }
  const noun = parseNoun(phrase);
  if (noun && noun.kind !== 'player') {
    const f: ObjectFilter = noun.filter.zone ? { ...noun.filter } : { ...noun.filter, zone: 'battlefield' };
    if (noun.controllerPhrase) {
      const pr = playerRef(noun.controllerPhrase, ctx);
      if (!pr) return null;
      f.controllerRef = pr;
    }
    return { kind: 'count', filter: f };
  }
  return amt(`the number of ${phrase}`, ctx) ?? amt(phrase, ctx);
}

/** Subject-verb helpers */
function subjectPlayer(subj: string | undefined, ctx: ParseCtx): Ref | null {
  if (subj === undefined || subj.trim() === '') return ctx.lastPlayer ?? YOU;
  const who = playerRef(subj, ctx);
  if (who && who.ref !== 'controller') ctx.lastPlayer = who;
  return who;
}


const DEST_RE = String.raw`(into (?:your|their) hand|into (?:your|their) graveyard|onto the battlefield(?: tapped)?(?: and attacking)?(?: under your control)?|on the bottom of (?:your|their) library(?: in (?:a random|any) order)?|on top of (?:your|their) library(?: in any order)?|into exile)`;
/** Effects that move a chosen ref to a destination phrase (see DEST_RE). */
function moveChosen(ref: Ref, dest: string): Effect | null {
  const d = dest.toLowerCase();
  if (/^into (?:your|their) hand$/.test(d)) return { kind: 'putIntoHand', what: ref };
  if (/^into (?:your|their) graveyard$/.test(d)) return { kind: 'moveToZone', what: ref, zone: 'graveyard' };
  if (/^onto the battlefield/.test(d)) return { kind: 'returnToBattlefield', what: ref, tapped: /tapped/.test(d), attacking: /attacking/.test(d) || undefined };
  if (/^on the bottom/.test(d)) return { kind: 'putOnLibrary', what: ref, position: 'bottom' };
  if (/^on top/.test(d)) return { kind: 'putOnLibrary', what: ref, position: 'top' };
  if (/^into exile$/.test(d)) return { kind: 'exile', what: ref };
  return null;
}
function restDest(dest: string): Extract<Effect, { kind: 'moveRest' }>['to'] | null {
  const d = dest.toLowerCase();
  if (/^into (?:your|their) hand$/.test(d)) return 'hand';
  if (/^into (?:your|their) graveyard$/.test(d)) return 'graveyard';
  if (/^on the bottom/.test(d)) return /random/.test(d) ? 'bottomRandom' : 'bottom';
  if (/^on top/.test(d)) return 'top';
  if (/^into exile$/.test(d) || d === 'exile') return 'exile';
  return null;
}
/** Follow-up clauses after "Look at the top N cards of your library" (the pool is remembered under ctx.restKey). */
/** The pool that "them" / "the rest" refers to: a held look/search pool, else the cards just moved. */
function poolRef(ctx: ParseCtx): Ref {
  return ctx.restKey ? { ref: 'chosen', key: ctx.restKey } : { ref: 'lastMoved' };
}

const POOL_PATTERNS: Pattern[] = [
  // "Put the revealed cards on the bottom of your library in a random order" / "exile all other cards revealed this way"
  [new RegExp(String.raw`^(?:then )?(?:and )?(?:put|exile) (?:the revealed cards|all other cards revealed this way|all cards revealed this way|the other cards revealed this way|the rest of the revealed cards)(?: ${DEST_RE})?$`, 'i'), (m, ctx) => {
    if (!ctx.restKey) return null;
    const to = restDest(m[1] ?? 'into exile');
    return to ? [{ kind: 'moveRest', key: ctx.restKey, to }] : null;
  }],
  // "Put the nonland cards revealed this way into your hand" (the matches held by a reveal-until)
  [new RegExp(String.raw`^(?:you may )?put (?:those|the) ((?!rest\b)[\w -]+?) (?:cards? )?(?:revealed this way |from among them )?${DEST_RE}$`, 'i'), (m, ctx) => {
    if (!ctx.restKey) return null;
    const mv = moveChosen({ ref: 'chosen', key: ctx.restKey }, m[2]);
    return mv ? [mv] : null;
  }],
  // "Put one of them into your hand (and the rest on the bottom of your library in a random order)"
  [new RegExp(String.raw`^(you may )?(put|exile) (one|the other|(\w+)|up to (\w+)|any number|all|the rest)(?: of (?:them|those cards))?(?: ${DEST_RE})?(?: and (?:put )?the rest ${DEST_RE})?$`, 'i'), (m, ctx) => {
    const pool: Ref = poolRef(ctx);
    const out: Effect[] = [];
    const isRest = /^(all|the rest)$/i.test(m[3]);
    const dest = m[2].toLowerCase() === 'exile' ? 'into exile' : m[6];
    if (!dest) return null;
    if (isRest) {
      const to = restDest(dest);
      if (!to) return null;
      out.push({ kind: 'moveRest', key: ctx.restKey ?? 'lastMoved', to });
    } else {
      const n = /^(one|the other)$/i.test(m[3]) ? 1 : m[4] ? wordToNumber(m[4]) : m[5] ? wordToNumber(m[5]) : 'X';
      if (n === null) return null;
      const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
      const anyNumber = /^any number$/i.test(m[3]);
      out.push({ kind: 'chooseObjects', from: pool, filter: {}, count: anyNumber ? 99 : n, key, upTo: !!m[1] || !!m[5] || anyNumber });
      const mv = moveChosen({ ref: 'chosen', key }, dest);
      if (!mv) return null;
      out.push(mv);
      ctx.lastObj = { ref: 'chosen', key };
    }
    if (m[7]) {
      const to = restDest(m[7]);
      if (!to) return null;
      out.push({ kind: 'moveRest', key: ctx.restKey ?? 'lastMoved', to });
    }
    return out;
  }],
  // "You may reveal a creature card from among them and put it into your hand" / "Put all land cards revealed this way onto the battlefield tapped"
  [new RegExp(String.raw`^(you may )?(reveal|put|exile) (a|an|all|up to (\w+)|any number of|(\w+)) (.+?) (?:from among (?:them|those cards)|revealed this way|milled this way|from among the revealed cards|from among the cards milled this way)(?:,? and put (?:it|them|that card|those cards) ${DEST_RE}| ${DEST_RE})?(?: and (?:put )?the rest ${DEST_RE})?$`, 'i'), (m, ctx) => {
    const pool: Ref = poolRef(ctx);
    const phrase = /\bcards?\b/i.test(m[6]) ? m[6].replace(/\bcards\b/i, 'card') : `${m[6]} card`;
    const noun = parseNoun(`a ${phrase}`);
    if (!noun) return null;
    const all = /^(all|any number of)$/i.test(m[3]);
    const n = /^(a|an)$/i.test(m[3]) ? 1 : m[4] ? wordToNumber(m[4]) : m[5] ? wordToNumber(m[5]) : 99;
    if (n === null) return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const out: Effect[] = [{ kind: 'chooseObjects', from: pool, filter: noun.filter, count: all ? 99 : n, key, upTo: !!m[1] || !!m[4] || /any number/i.test(m[3]) }];
    const dest = m[2].toLowerCase() === 'exile' ? 'into exile' : m[7] ?? m[8];
    if (dest) {
      const mv = moveChosen({ ref: 'chosen', key }, dest);
      if (!mv) return null;
      out.push(mv);
    } else if (m[2].toLowerCase() === 'put') return null;
    ctx.lastObj = { ref: 'chosen', key };
    if (m[9]) {
      const to = restDest(m[9]);
      if (!to) return null;
      out.push({ kind: 'moveRest', key: ctx.restKey ?? 'lastMoved', to });
    }
    return out;
  }],
  // "Put the rest on the bottom of your library in a random order" / "Exile the rest" / "and the rest into your graveyard"
  [new RegExp(String.raw`^(?:then )?(?:and )?(?:put )?the rest ${DEST_RE}$|^(?:then )?exile the rest$|^(?:then )?put the rest into exile$`, 'i'), (m, ctx) => {
    if (!ctx.restKey) return null;
    const to = restDest(m[1] ?? 'exile');
    return to ? [{ kind: 'moveRest', key: ctx.restKey, to }] : null;
  }],
  // "Look at the top five cards of your library, put one of them into your hand, and exile the rest" / bare "Look at the top N cards of your library"
  [/^(look at|reveal) the top (\w+|X) cards? of your library(?:, where X is (.+?))?(?:, (.+))?$/i, (m, ctx) => {
    const n = m[2] === 'X' ? 'X' : wordToNumber(m[2]);
    if (n === null) return null;
    let amount: Amount = n;
    if (m[3]) {
      const a = amt(m[3], ctx);
      if (!a) return null;
      amount = a;
    }
    const key = `looked${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.restKey = key;
    ctx.lastObj = { ref: 'chosen', key };
    const out: Effect[] = [{ kind: 'lookAtTop', amount, then: 'hold', key, reveal: /^reveal/i.test(m[1]) }];
    if (m[4]) {
      for (const clause of m[4].split(/, (?:and |then )?|,? and then |,? then /i)) {
        const r = parseSentence(clause, ctx);
        if (!r) return null;
        out.push(...r);
      }
    }
    return out;
  }],
];


/** "up to two basic land cards" / "a creature card" / "three cards" → count and filter for a library search. */
function searchTarget(phrase: string, ctx: ParseCtx): { count: Amount; upTo: boolean; filter: ObjectFilter } | null {
  let t = phrase.trim().replace(/[.,]$/, '');
  let upTo = false;
  let count: Amount = 1;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^up to (that many|X|\w+) (.+)$/i))) {
    upTo = true;
    const n = /that many/i.test(m[1]) ? 'X' : m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    if (n === null) return null;
    count = n;
    t = m[2];
  } else if ((m = t.match(/^(?:a|an) (.+)$/i))) {
    t = m[1];
  } else if ((m = t.match(/^any number of (.+)$/i))) {
    count = 99;
    upTo = true;
    t = m[1];
  } else if ((m = t.match(/^(X|\w+) (.+)$/i)) && (m[1].toUpperCase() === 'X' || typeof wordToNumber(m[1]) === 'number')) {
    count = m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as number);
    t = m[2];
  }
  const noun = parseNoun(/\bcards?\b/i.test(t) ? t.replace(/\bcards\b/i, 'card') : `${t.replace(/s$/i, '')} card`);
  if (!noun) return null;
  const filter: ObjectFilter = { ...noun.filter, zone: 'library' };
  if (noun.controllerPhrase) {
    const pr = playerRef(noun.controllerPhrase, ctx);
    if (!pr) return null;
    filter.controllerRef = pr;
  }
  return { count, upTo, filter };
}

/** Library searches whose destination comes in a later sentence ("Search your library for two cards and reveal them. Put one ..."). */
const SEARCH_PATTERNS: Pattern[] = [
  [/^search (your|their|that player's|target player's|target opponent's) library for (.+?)(?:,? and reveal (?:it|them|those cards)| and reveal them)?(?:, then shuffle| and shuffle|,? then shuffle your library)?$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx);
    if (!who) return null;
    const tgt = searchTarget(m[2], ctx);
    if (!tgt) return null;
    const key = `searched${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.restKey = key;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'searchLibrary', who: who.ref === 'controller' ? undefined : who, filter: tgt.filter, count: tgt.count, destination: 'hold', key, reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
];


/** "Reveal cards from the top of your library until you reveal a nonland card" — the destination may come later. */
const REVEAL_UNTIL_PATTERNS: Pattern[] = [
  [/^reveal cards from the top of your library until you reveal (?:(?:a|an) |(X|\w+) )?(.+?)(?:, where X is (.+?))?$/i, (m, ctx) => {
    const plural = /^(?:X|two|three|four|five|\w+)$/i.test(m[1] ?? '') && !!m[1];
    let count: Amount = 1;
    if (plural) {
      const n = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
      if (n === null) return null;
      count = n;
    }
    // "a Doctor card, a card with doctor's companion, or a Vehicle card" → any of these
    const alts = m[2].split(/,\s*(?:or\s+)?|\s+or\s+/i).map((x) => x.trim().replace(/^(?:a|an) /i, '')).filter(Boolean);
    const filters: ObjectFilter[] = [];
    for (const a of alts) {
      const noun = parseNoun(/\bcards?\b/i.test(a) ? a.replace(/\bcards\b/i, 'card') : `${a.replace(/s$/i, '')} card`);
      if (!noun) return null;
      filters.push({ ...noun.filter, zone: undefined });
    }
    const filter: ObjectFilter = filters.length === 1 ? filters[0] : { anyOf: filters };
    if (m[3]) {
      const a = amt(m[3], ctx);
      if (a === null) return null;
      count = a;
    }
    const key = `revealed${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.restKey = key;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'revealUntil', filter, destination: 'hold', rest: 'bottom', count: plural || m[3] ? count : undefined, key }];
  }],
];

const PATTERNS: Pattern[] = [
  // Voting: "Starting with you, each player votes for death or taxes."
  [/^(?:starting with you, )?each player (?:secretly )?votes for (.+?)(?:, then those votes are revealed)?$/i, (m, ctx) => {
    const list = m[1];
    // "a nonland permanent you don't control" / "an artifact, creature, or enchantment card in your graveyard"
    const noun = parseNoun(list);
    if (noun && !noun.target) {
      const f: ObjectFilter = { ...noun.filter };
      if (!f.zone) f.zone = 'battlefield';
      if (noun.controllerPhrase) {
        const pr = playerRef(noun.controllerPhrase, ctx);
        if (!pr) return null;
        f.controllerRef = pr;
      }
      ctx.lastObj = { ref: 'chosen', key: 'votes' };
      return [{ kind: 'voteObjects', filter: f, key: 'votes' }];
    }
    const options = list.split(/,\s*(?:or\s+)?|\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
    if (options.length < 2 || options.some((o) => !/^[\w' -]+$/.test(o))) return null;
    return [{ kind: 'vote', options }];
  }],
  // "For each death vote, each opponent sacrifices a creature."
  [/^for each ([\w' -]+?) vote, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[2], ctx);
    return inner ? [{ kind: 'repeat', times: { kind: 'voteCount', option: m[1].toLowerCase() }, effects: inner }] : null;
  }],
  // "If dominion gets more votes, the Ring tempts you."
  [/^if ([\w' -]+?) gets? more votes, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[2], ctx);
    return inner ? [{ kind: 'conditional', if: { kind: 'voteMost', option: m[1].toLowerCase() }, then: inner }] : null;
  }],
  // "You and target opponent each draw two cards" → for each of those players
  [/^you and (target opponent|target player|that player|each opponent|each other player|the chosen player|defending player) each (\w+) (.+)$/i, (m, ctx) => {
    const other = playerRef(m[1], ctx);
    if (!other) return null;
    const verb = m[2].toLowerCase();
    const third = /(ch|sh|s|x|z)$/.test(verb) ? `${verb}es` : verb === 'may' ? 'may' : `${verb}s`;
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(`that player ${third} ${m[3]}`, sub);
    if (!inner) return null;
    ctx.lastPlayer = other;
    return [{ kind: 'forEach', over: { ref: 'players', of: [YOU, other] }, effects: inner }];
  }],
  // Draw
  [/^(?:(.+?) )?draws? (?:(\w+|X) cards?|a card)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    if (!who) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    return [{ kind: 'draw', amount: n, who }];
  }],
  [/^(?:(.+?) )?draws? (that many cards(?: minus one| plus one)?)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = /minus one/i.test(m[2]) ? amt(m[2], ctx) : /plus one/i.test(m[2]) ? { kind: 'sum' as const, parts: [{ kind: 'discardedThisWay' as const, ref: { ref: 'iter' as const } }, 1] } : { kind: 'discardedThisWay' as const, ref: { ref: 'iter' as const } };
    return who && a !== null ? [{ kind: 'draw', amount: a, who }] : null;
  }],
  [/^(?:(.+?) )?draws? cards equal to (.+)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    const a = amt(m[2], ctx);
    return who && a !== null ? [{ kind: 'draw', amount: a, who }] : null;
  }],
  // Life
  [/^(?:(.+?) )?(gains?|loses?) (\w+|X) life$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[3]);
    if (!who || n === null) return null;
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: n, who } as Effect];
  }],
  [/^(?:(.+?) )?(gains?|loses?) life equal to (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = amt(m[3], ctx);
    if (!who || a === null) return null;
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: a, who } as Effect];
  }],
  [/^(?:(.+?) )?(gains?|loses?) (\w+|X) life for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[3]);
    if (!who || n === null) return null;
    const per = perEach(m[4].replace(/^of /i, ''), ctx);
    if (per === null) return null;
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: { kind: 'times', a: n, b: per }, who } as Effect];
  }],
  [/^(?:(.+?) )?discards? a card for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const per: Amount | null = perEach(m[2], ctx);
    return who && per !== null ? [{ kind: 'discard', amount: per, who }] : null;
  }],
  [/^(?:(.+?) )?reveals? (?:their|your) hand and discards? all (.+?) cards$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    return who && noun ? [{ kind: 'revealHand', who }, { kind: 'discard', amount: 'hand', who, filter: noun.filter }] : null;
  }],
  [/^(?:(.+?) )?exiles? (?:a|an|(\w+)) (?:(.+?) )?cards? from (?:their|your) (graveyard|hand)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    const noun = m[3] ? parseNoun(`a ${m[3]} card`) : { filter: {} as ObjectFilter };
    if (!who || n === null || !noun) return null;
    const key = `exiled${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: m[4] as 'graveyard' | 'hand' }, owner: who, count: n, key }, { kind: 'exile', what: { ref: 'chosen', key } }];
  }],
  [/^(?:(.+?) )?mills? half (?:their|your) library(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'mill', amount: { kind: 'half', a: { kind: 'librarySize', ref: who }, round: m[2] === 'up' ? 'up' : 'down' }, who }] : null;
  }],
  [/^look at (.+?)'s hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'revealHand', who }] : null;
  }],
  [/^put a number of ([+-]\d\/[+-]\d|\w+) counters on (.+?) equal to (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    const a = ref ? amt(m[3], ctx) : null;
    return ref && a !== null ? [{ kind: 'addCounters', counter: m[1], amount: a, on: ref }] : null;
  }],
  [/^(.+?) reveals cards from the top of their library until (?:they reveal|revealing) (?:a|an) (.+?) card\.? (?:put|that player puts|they put) (?:that card|it) (into their hand|onto the battlefield( tapped)?|into their graveyard)(?: and (?:put )?the rest|\. put the rest| and the rest) (on the bottom of their library in (?:a random|any) order|into their graveyard)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    if (!who || !noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealUntil', who, filter: noun.filter, destination: /hand/.test(m[3]) ? 'hand' : /battlefield/.test(m[3]) ? 'battlefield' : 'graveyard', tapped: !!m[4], rest: /graveyard/.test(m[5]) ? 'graveyard' : 'bottom' }];
  }],
  [/^(?:(.+?) )?exiles? cards from the top of (?:their|your) library until (?:they|you) exile (?:a|an) (.+?) card$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    if (!who || !noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealUntil', who, filter: noun.filter, destination: 'exile', rest: 'exile' }];
  }],
  [/^(?:(.+?) )?(gains?|loses?) life equal to (.+?)(?:, but not more life than .+)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = amt(m[3], ctx);
    return who && a !== null ? [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: a, who } as Effect] : null;
  }],
  [/^(?:(.+?) )?(gains?|loses?) that much life$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: { kind: 'triggerAmount' }, who } as Effect] : null;
  }],
  [/^(?:(.+?) )?loses? half (?:their|your) life(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'loseLife', amount: { kind: 'half', a: { kind: 'life', ref: who }, round: m[2] === 'down' ? 'down' : 'up' }, who }] : null;
  }],
  [/^(?:(.+?) )?loses? (\w+) life for each card fewer than (\w+) in (?:their|your) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const per = wordToNumber(m[2]);
    const lim = wordToNumber(m[3]);
    if (!who || typeof per !== 'number' || typeof lim !== 'number') return null;
    return [{ kind: 'loseLife', who, amount: { kind: 'times', a: per, b: { kind: 'max', a: { kind: 'sum', parts: [lim, { kind: 'times', a: { kind: 'handSize', ref: who }, b: -1 }] }, b: 0 } } }];
  }],
  [/^move (?:a|an|(\w+|X)) ([+-]\d\/[+-]\d|\w+) counters? from (.+?) onto (.+)$/i, (m, ctx) => {
    const from = objRef(m[3], ctx);
    const to = from ? objRef(m[4], ctx) : null;
    if (!from || !to) return null;
    const n = m[1] ? (m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1])) : 1;
    if (n === null) return null;
    return [{ kind: 'moveCounters', from, to, counter: m[2] as import('@commander/engine').CounterType, amount: n as Amount }];
  }],
  [/^flip (~|it)$/i, () => [{ kind: 'transform', what: SELF }]],
  [/^convert (~|it|that creature|target creature)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'transform', what: ref }] : null;
  }],
  [/^(.+?) reveals (\w+) cards? from their hand and you choose one of them$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    const key = `revealed${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key: `${key}pick` };
    return [{ kind: 'chooseObjects', who, filter: { zone: 'hand' }, owner: who, count: n, key }, { kind: 'chooseObjects', who: YOU, filter: {}, from: { ref: 'chosen', key }, count: 1, key: `${key}pick` }];
  }],
  [/^look at (.+?)'s hand and choose (\w+|X) cards? from it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    const key = `looked${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'revealHand', who }, { kind: 'chooseObjects', who: YOU, filter: { zone: 'hand' }, owner: who, count: n, key }];
  }],
  [/^(?:that player|they) discards? those cards$/i, (m, ctx) => (ctx.lastObj ? [{ kind: 'discardObjects', what: ctx.lastObj }] : null)],
  [/^discover (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'discover', amount: n }];
  }],
  [/^incubate (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'createToken', token: { name: 'Incubator', typeLine: 'Artifact — Incubator', colors: [], preset: 'Incubator' }, count: 1 }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'lastCreated' } }];
  }],
  [/^damage cannot be prevented this turn$/i, () => [{ kind: 'turnFlag', flag: 'noPrevention' }]],
  [/^(?:(.+?) )?shuffles? (?:their|your) graveyard into (?:their|your) library$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'library' }, { kind: 'shuffle', who }] : null;
  }],
  [/^reveal cards from the top of your library until you reveal (?:a|an) (.+?) card\.? (?:put|you may put) (?:that card|it) (into your hand|onto the battlefield( tapped)?|into your graveyard)(?: and (?:put )?the rest|\. put the rest| and the rest) (on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealUntil', filter: noun.filter, destination: /hand/.test(m[2]) ? 'hand' : /battlefield/.test(m[2]) ? 'battlefield' : 'graveyard', tapped: !!m[3], rest: /graveyard/.test(m[4]) ? 'graveyard' : 'bottom' }];
  }],
  [/^(.+?) deals damage to itself equal to its power$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'dealsDamageEqualToPower', source: ref, to: ref }] : null;
  }],
  [/^(.+?) cannot block ~ this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantBlockSource', data: '__self__' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) blocks (?:~|it) this (?:turn|combat) if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlock', data: '__self__' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(?:all creatures able to block (.+?) this turn do so|(.+?) must be blocked this turn if able)$/i, (m, ctx) => {
    const ref = objRef(m[1] ?? m[2], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: m[1] ? 'lure' : 'mustBeBlocked' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) can attack this turn as though (?:it|they) did not have defender$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(?:they|it|those tokens|that token) (?:have|has) "(.+)"$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? { ref: 'lastCreated' as const };
    return [{ kind: 'grantAbility', text: m[1], on: ref, duration: 'permanent' }];
  }],
  [/^you get an emblem with "(.+?)"?$/i, (m) => [{ kind: 'emblem', text: m[1] }]],
  [/^(.+?) gets an emblem with "(.+)"$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'emblem', text: m[2], who }] : null;
  }],
  [/^amass (\w+) (\w+)$/i, (m) => {
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    const type = m[1];
    return [{ kind: 'conditional', if: { kind: 'count', filter: { subtypes: ['Army'], controller: 'you', zone: 'battlefield' }, op: '>=', value: 1 }, then: [{ kind: 'chooseObjects', filter: { subtypes: ['Army'], controller: 'you', zone: 'battlefield' }, count: 1, key: 'army' }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'chosen', key: 'army' } }], else: [{ kind: 'createToken', token: { name: `${type} Army`, typeLine: `Creature — ${type} Army`, power: '0', toughness: '0', colors: ['B'] }, count: 1 }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'lastCreated' } }] }];
  }],
  [/^bolster (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'chooseObjects', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield', lowestToughness: true }, count: 1, key: 'bolster' }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'chosen', key: 'bolster' } }];
  }],
  [/^if (that creature|that creature or planeswalker|it|those creatures|that permanent) would die this turn, exile it instead$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^if a creature dealt damage this way would die this turn, exile it instead$/i, () => [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  [/^look at the top (?:card|(\w+|X) cards) of (.+?)'s library(?:, then put them back in any order| in any order)?$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    return who && n !== null ? [{ kind: 'lookAtTop', amount: n, who, then: 'reorder' }] : null;
  }],
  [/^(?:until end of turn, )?(.+?) gains? (.+?) and gets? ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    if (!kws || !ref) return null;
    const p = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[3], 10);
    const t = m[4].toUpperCase().includes('X') ? (m[4].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[4], 10);
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }, { kind: 'pump', power: p, toughness: t, on: ref, duration: 'endOfTurn' }];
  }],
  [/^reveal the top (\w+|X) cards of your library\.? (?:put|you may put) (all|any number of|a|an|up to (\w+)) (.+?) cards? (?:revealed this way |from among them )?(into your hand|onto the battlefield( tapped)?)(?:,| and|\.)(?: put)? the rest (on the bottom of your library in (?:a random|any) order|into your graveyard|on top of your library in any order)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[4]} card`);
    if (n === null || !noun) return null;
    const pick = m[3] ? wordToNumber(m[3]) : /^(all|any number)/i.test(m[2]) ? n : 1;
    if (pick === null) return null;
    const rest = /graveyard/.test(m[7]) ? 'Graveyard' : /bottom/.test(m[7]) ? 'Bottom' : 'Top';
    if (/battlefield/.test(m[5]) && rest !== 'Bottom') return null;
    const then = /battlefield/.test(m[5]) ? 'battlefieldRestBottom' : (`handRest${rest}` as 'handRestBottom' | 'handRestGraveyard' | 'handRestTop');
    return [{ kind: 'lookAtTop', amount: n, then, filter: noun.filter, pick }];
  }],
  [/^exile all graveyards$/i, () => [{ kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'exile' }]],
  [/^exile (.+?)'s graveyard$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'exile' }] : null;
  }],
  [/^(?:(.+?) )?exiles? (?:their|your) graveyard$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'exile' }] : null;
  }],
  [/^(.+?) gains? control of (.+?)( until end of turn)?$/i, (m, ctx) => {
    if (/^(?:you|an opponent)$/i.test(m[1])) return null;
    const who = playerRef(m[1], ctx);
    const ref = who ? objRef(m[2], ctx) : null;
    return who && ref ? [{ kind: 'gainControl', what: ref, who, duration: m[3] ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^(.+?) chooses? (?:a|an) (.+?) (?:they|that player) controls?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = who ? parseNoun(`a ${m[2]}`) : null;
    if (!who || !noun) return null;
    const key = `chosen${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: 1, key }];
  }],
  [/^an opponent gains control of (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }, { kind: 'gainControl', what: ref, who: { ref: 'chosen', key: 'opponent' } }] : null;
  }],
  [/^choose an opponent$/i, () => [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }]],
  [/^choose a nonland card name$/i, () => [{ kind: 'nameCard', key: 'cardName' }]],
  [/^switch (.+?)'s power and toughness(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'switchPT', on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^you may tap or untap (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'chooseMode', options: [{ text: 'Tap it', effects: [{ kind: 'tap', what: ref }] }, { text: 'Untap it', effects: [{ kind: 'untap', what: ref }] }, { text: 'Do nothing', effects: [] }] }] : null;
  }],
  [/^(.+?) attacks? this turn if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^you may play an additional land this turn$/i, () => [{ kind: 'extraLandThisTurn' }]],
  [/^(.+?) (?:does|do) not untap during (?:its|their) controller'?s'? next untap step$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilNextUntap' }] : null;
  }],
  [/^(.+?) (?:does not|do not|doesn't|don't) untap during (?:your|its controller's|their controllers'|their controller's) next untap steps?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilNextUntap' }] : null;
  }],
  [/^for each (.+?) card put into (?:a|your|their) graveyard this way, (?:you )?create (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    const t = parseTokenPhrase(m[2]);
    if (!noun || !t) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: { kind: 'countRef', ref: { ref: 'lastMoved' }, filter: noun.filter }, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^(?:until end of turn, )?(.+?) gains? "(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'grantAbility', text: m[2], on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) gains? "(.+)" for as long as (.+)$/i, () => null],
  [/^adapt (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'conditional', if: { kind: 'not', c: { kind: 'hasCounter', ref: SELF, counter: '+1/+1' } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: n, on: SELF }] }];
  }],
  [/^support (\w+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `up to ${n} other target creatures`, kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], other: true }, min: 0, max: n });
    return [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^(?:it|~|that creature|this creature) connives?$/i, () => [{ kind: 'log', text: 'connives', event: 'connived', objectRef: SELF }, { kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }, { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'chosen', key: 'lastDiscarded' }, filter: { nonland: true } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: SELF }] }]],
  [/^(.+?) connives?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'log', text: 'connives', event: 'connived', objectRef: ref }, { kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }, { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'chosen', key: 'lastDiscarded' }, filter: { nonland: true } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }] }] : null;
  }],
  // Damage
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals (\w+|X) damage to (.+?)(?: for each (.+))?$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    if (!src) return null;
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    let amount: Amount = n;
    if (m[4]) {
      const per = perEach(m[4], ctx);
      if (!per) return null;
      amount = { kind: 'times', a: n, b: per };
    }
    return damageTo(m[3], amount, ctx, src);
  }],
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals that much damage to (.+)$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    return src ? damageTo(m[2], { kind: 'triggerAmount' }, ctx, src) : null;
  }],
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals (\w+|X) damage to (.+?) and (\w+|X) damage to (.+)$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    const n1 = wordToNumber(m[2]);
    const n2 = wordToNumber(m[4]);
    if (!src || n1 === null || n2 === null) return null;
    const a = damageTo(m[3], n1, ctx, src);
    const b = damageTo(m[5], n2, ctx, src);
    return a && b ? [...a, ...b] : null;
  }],
  [/^(~|it|that creature|.+?) deals damage equal to (.+?) to (.+)$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    if (!src) return null;
    const a = amt(m[2], ctx);
    if (a === null) return null;
    return damageTo(m[3], a, ctx, src);
  }],
  [/^(~|it|that creature|.+?) deals (\w+|X) damage divided as you choose among (.+)$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    const n = wordToNumber(m[2]);
    if (!src || n === null) return null;
    return damageTo(`${m[2]} damage, divided as you choose among ${m[3]}`.replace(/^.*?, divided/, 'x, divided'), n, ctx, src);
  }],
  [/^each player shuffles their hand and graveyard into their library, then draws (\w+) cards$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'hand', to: 'library' }, { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'library' }, { kind: 'shuffle', who: { ref: 'eachPlayer' } }, { kind: 'draw', amount: n, who: { ref: 'eachPlayer' } }];
  }],
  [/^(~|it|that creature|.+?) deals damage to (.+?) equal to (.+)$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    if (!src) return null;
    const a = amt(m[3], ctx);
    if (a === null) return null;
    return damageTo(m[2], a, ctx, src);
  }],
  // Destroy / exile / sacrifice
  [/^destroy (.+?)(?:\. (?:It|They) cannot be regenerated)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'destroy', what: ref, cantRegenerate: /regenerat/i.test(m[0]) }] : null;
  }],
  [/^exile (.+?)(?: from (?:their|your|its owner's|that player's) graveyard)?(?: with (?:a|an|(\w+)) (\w+) counters? on (?:it|them))?(?: until ~ leaves the battlefield)?$/i, (m, ctx) => {
    const until = / until ~ leaves the battlefield$/i.test(m[0]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const e: Effect = { kind: 'exile', what: ref, untilSourceLeaves: until, remember: 'exiled' };
    if (m[3]) e.counters = { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) ?? 1) : 1 };
    ctx.lastObj = { ref: 'lastMoved' };
    return [e];
  }],
  [/^(?:(.+?) )?sacrifices? (~|it|them|that creature|that permanent|the creature|the permanent|that token|the token|those creatures|those tokens|enchanted creature|equipped creature)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'sacrifice', what: ref }] : null;
  }],
  [/^(?:(.+?) )?sacrifices? (?:a|an|another|any number of|(\w+)) (.+?)(?: of (?:their|your) choice)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const anyNumber = /sacrifices? any number of /i.test(m[0]);
    const noun = parseNoun(`a ${m[3]}`) ?? (anyNumber ? parseNoun(`a ${m[3].replace(/^(\w+?)s\b/i, '$1')}`) : null);
    if (!who || !noun) return null;
    const n = anyNumber ? 99 : m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    return [{ kind: 'sacrificeChoice', who, filter: { ...noun.filter, zone: 'battlefield', other: /another/i.test(m[0]) || undefined }, count: n, upTo: anyNumber || undefined }];
  }],
  // Indefinite choices: "return a land you control to its owner's hand", "tap an untapped creature you control", "exile a card from your graveyard"
  [/^(return|tap|untap|exile|destroy) (?:a|an|another|up to (\w+)|(any number of)) (.+?)(?: to (?:its|their) owner'?s'? hands?| to your hand)?( until ~ leaves the battlefield)?$/i, (m, ctx) => {
    if (/target|each/i.test(m[4])) return null;
    const c = chooseRef(`a ${m[4].replace(/s$/, '')}`, ctx, YOU, !!m[2] || !!m[3]);
    if (!c) return null;
    if (/^(return|tap|untap|exile|destroy) another /i.test(m[0])) (c.pre[0] as { filter: ObjectFilter }).filter.other = true;
    if (m[3]) (c.pre[0] as { count: number }).count = 20;
    const verb = m[1].toLowerCase();
    const eff: Effect = verb === 'return' ? { kind: 'returnToHand', what: c.ref } : verb === 'tap' ? { kind: 'tap', what: c.ref } : verb === 'untap' ? { kind: 'untap', what: c.ref } : verb === 'exile' ? { kind: 'exile', what: c.ref, untilSourceLeaves: !!m[5], remember: 'exiled' } : { kind: 'destroy', what: c.ref };
    if (verb === 'return' && !/ to (?:its|their) owner'?s'? hands?| to your hand/i.test(m[0])) return null;
    if (verb === 'exile' && m[5]) ctx.lastObj = { ref: 'lastMoved' };
    return [...c.pre, eff];
  }],
  [/^put (?:a|an|(\w+)) (?:(.+?) )?cards? from your hand (on top of|on the bottom of) your library(?: in any order)?$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const noun = m[2] ? parseNoun(`a ${m[2]} card`) : { filter: {} as ObjectFilter };
    if (!noun) return null;
    const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n, key }, { kind: 'putOnLibrary', what: { ref: 'chosen', key }, position: /top/.test(m[3]) ? 'top' : 'bottom' }];
  }],
  [/^(?:you may )?put (?:a|an|up to (\w+)) (.+?) from your hand onto the battlefield(?: (tapped)(?: and (attacking))?)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${/\bcards?\b/i.test(m[2]) ? m[2].replace(/ cards$/i, ' card') : `${m[2]} card`} from your hand`, ctx, YOU, true);
    if (!c) return null;
    return [...c.pre, { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3], attacking: m[4] ? true : undefined }];
  }],
  [/^(?:you may )?put (?:a|an|up to (\w+)) (.+?) cards? from your graveyard (?:onto the battlefield|into your hand)( tapped)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]} card from your graveyard`, ctx, YOU, true);
    if (!c) return null;
    return [...c.pre, /battlefield/i.test(m[0]) ? { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3] } : { kind: 'putIntoHand', what: c.ref }];
  }],
  [/^return (?:a|an|up to (\w+)) (.+?) cards? from your graveyard to (?:your hand|the battlefield)( tapped)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]} card from your graveyard`, ctx, YOU, !!m[1]);
    if (!c) return null;
    return [...c.pre, /battlefield/i.test(m[0]) ? { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3] } : { kind: 'putIntoHand', what: c.ref }];
  }],
  [/^look at the top card of your library$/i, () => [{ kind: 'lookAtTop', amount: 1, then: 'reorder' }]],
  [/^choose a card name$/i, () => [{ kind: 'nameCard', key: 'cardName' }]],
  // Return
  [/^return (.+?) and (.+?) to their owners'? hands$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = a ? objRef(m[2], ctx) : null;
    return a && b ? [{ kind: 'returnToHand', what: a }, { kind: 'returnToHand', what: b }] : null;
  }],
  [/^return (.+?) to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  [/^return (.+?) to (?:your|their) hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  [/^return (.+?) to the battlefield( tapped)?(?: under (your|its owner's|their owner's|their owners') control)?( tapped)?(?: with (?:a|an|\w+) ([+-]\d\/[+-]\d|\w+) counters? on (?:it|them))?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const e: Effect = { kind: 'returnToBattlefield', what: ref, tapped: !!(m[2] || m[4]), controller: m[3] && /owner/.test(m[3]) ? 'owner' : 'you' };
    if (m[5]) e.counters = { counter: m[5], amount: 1 };
    return [e];
  }],
  [/^put (.+?) (?:into (?:its|their) owner'?s'? hands?|into your hand)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putIntoHand', what: ref }] : null;
  }],
  [/^put (.+?) (?:onto|on) the battlefield(?: under (your|its owner's) control)?( tapped)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToBattlefield', what: ref, tapped: !!m[3], controller: m[2] === "its owner's" ? 'owner' : 'you' }] : null;
  }],
  [/^put (.+?) on (?:the )?(top|bottom) of (?:its|their) owner'?s'? librar(?:y|ies)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: m[2].toLowerCase() as 'top' | 'bottom' }] : null;
  }],
  [/^put (.+?) on (?:the )?(top|bottom) of your library$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: m[2].toLowerCase() as 'top' | 'bottom' }] : null;
  }],
  [/^(?:(.+?) )?shuffles? (.+?) into (?:its|their|your) (?:owner'?s'? )?librar(?:y|ies)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'library' }, { kind: 'shuffle', who: m[1] ? playerRef(m[1], ctx) ?? undefined : undefined }] : null;
  }],
  // Tokens
  [/^create (.+)$/i, (m, ctx) => {
    // copies of a target
    const copy = m[1].match(/^(a|an|\w+|X) ((?:tapped and attacking |tapped )?)tokens? that (?:is|are) (?:a )?cop(?:y|ies) of (.+?)(?:,? except (.+?))?((?:,| and)? (?:that is|that are|that's) (?:tapped and attacking|attacking|tapped))?$/i);
    if (copy) {
      const n = wordToNumber(copy[1]);
      const pre: Effect[] = [];
      let ref = objRef(copy[3], ctx);
      if (!ref) {
        const ch = chooseRef(copy[3], ctx);
        if (ch) {
          pre.push(...ch.pre);
          ref = ch.ref;
        }
      }
      if (n === null || !ref) return null;
      if (copy[5]) copy[2] = `${copy[2]} ${copy[5]}`;
      const token: TokenSpec = { name: 'Copy', typeLine: '', colors: [], copyOf: ref };
      if (copy[4]) {
        const ex = parseCopyExceptions(copy[4]);
        if (!ex) return null;
        token.exceptions = ex;
      }
      ctx.lastObj = { ref: 'lastCreated' };
      return [...pre, { kind: 'createToken', token, count: n, tapped: /tapped/i.test(copy[2]), attacking: /attacking/i.test(copy[2]) }];
    }
    // Role tokens attached to something
    const role = m[1].match(/^(?:a|an) ((?:Wicked|Monster|Royal|Sorcerer|Cursed|Virtuous|Young Hero) Role) token attached to (.+)$/i);
    if (role) {
      const host = objRef(role[2], ctx);
      if (!host) return null;
      return [{ kind: 'createToken', token: { name: role[1].replace(/ Role$/, ''), typeLine: '', colors: [], preset: role[1] }, count: 1, attachTo: host }];
    }
    const t = parseTokenPhrase(m[1]);
    if (!t) {
      // "Create a 1/1 green Snake creature token, a 2/2 green Wolf creature token, and a 3/3 green Elephant creature token."
      const parts = m[1].split(/, and |, (?=(?:a|an|two|three|four|X) )/i).map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1) {
        const specs = parts.map((x) => parseTokenPhrase(x));
        if (specs.every((x) => x)) {
          ctx.lastObj = { ref: 'lastCreated' };
          return specs.map((x) => ({ kind: 'createToken', token: x!.token, count: x!.count, tapped: x!.tapped, attacking: x!.attacking }) as Effect);
        }
      }
      return null;
    }
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: t.count, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^(.+?) creates? (.+)$/i, (m, ctx) => {
    if (/^(?:you|create)$/i.test(m[1])) return null;
    const who = playerRef(m[1], ctx);
    const t = parseTokenPhrase(m[2]);
    if (!who || !t) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: t.count, tapped: t.tapped, attacking: t.attacking, who }];
  }],
  [/^create (.+?) for each (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(m[1]);
    if (!t || t.count !== 1) return null;
    const a: Amount | null = perEach(m[2], ctx) ?? amt(`the number of ${m[2].replace(/^(\w+) /, (w) => (/s$/.test(w.trim()) ? w : `${w.trim()}s `))}`, ctx);
    if (a === null) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: a, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^create a number of (.+?) tokens? equal to (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(`a ${m[1]} token`);
    const a = amt(m[2], ctx);
    if (!t || a === null) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: a }];
  }],
  [/^(?:you )?gets? ((?:\{E\})+) for each (.+)$/i, (m, ctx) => {
    const noun = parseNoun(m[2]);
    if (!noun) return null;
    return [{ kind: 'addCounters', counter: 'energy', amount: { kind: 'times', a: (m[1].match(/\{E\}/g) ?? []).length, b: { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } } }, on: YOU }];
  }],
  [/^investigate$/i, () => [{ kind: 'investigate' }]],
  [/^investigate (twice|three times|(\w+) times)$/i, (m) => {
    const n = /twice/i.test(m[1]) ? 2 : /three times/i.test(m[1]) ? 3 : wordToNumber(m[2] ?? '');
    return n === null ? null : [{ kind: 'investigate', count: n }];
  }],
  [/^exile all (?:opponents'|your opponents') graveyards$/i, () => [{ kind: 'moveAll', who: { ref: 'eachOpponent' }, from: 'graveyard', to: 'exile' }]],
  [/^(~|it|that creature) attacks that (player|opponent) this combat if able$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : ctx.lastObj ?? SELF;
    return [{ kind: 'applyRule', on: ref, rule: { kind: 'mustAttack' }, duration: 'endOfTurn' }];
  }],
  // "Put those counters on target creature you control." (after "remove ... counters")
  [/^put those counters on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'moveCounters', from: SELF, to: ref }] : null;
  }],
  // "An opponent chooses two of those cards."
  [/^(.+?) chooses (\w+) of those cards$/i, (m, ctx) => {
    const by = actorRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!by || n === null) return null;
    ctx.lastObj = { ref: 'chosen', key: 'chosen' };
    return [{ kind: 'chooseObjects', from: { ref: 'lastMoved' }, filter: {}, count: n, key: 'chosen', who: by }];
  }],

  [/^(?:(.+?) )?exiles? the top (?:card|(\w+|X) cards) of (?:your|their) library(?: face down)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exileTop', amount: n, who, faceDown: / face down$/i.test(m[0]) }];
  }],
  [/^reveal (?:any number of|(\w+)) (.+?) (?:cards? )?(?:in|from) your hand$/i, (m, ctx) => {
    void ctx;
    const noun = parseNoun(`a ${m[2].replace(/ cards?$/i, '')} card`) ?? parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 99;
    if (n === null) return null;
    const key = 'revealedFromHand';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n as Amount, key, upTo: true }, { kind: 'revealHand', who: YOU }];
  }],
  [/^(?:(.+?) )?reveals? (?:their|your) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'revealHand', who }] : null;
  }],
  [/^you may (?:play|cast) (?:that card|those cards|it|them) (?:this turn|until end of turn|until the end of your next turn|for as long as (?:it remains|they remain) exiled)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? { ref: 'lastMoved' as const };
    return [{ kind: 'playFromExile', what: ref, duration: /this turn|until end of turn/i.test(m[0]) ? 'thisTurn' : 'permanent' }];
  }],
  [/^add (\w+|X) mana of the chosen color$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'addMana', mana: 'chosenColor', amount: n }];
  }],
  [/^add one mana of the chosen color$/i, () => [{ kind: 'addMana', mana: 'chosenColor' }]],
  [/^(?:you )?(?:gets?|gain) ((?:\{E\})+)$/i, (m) => [{ kind: 'addCounters', counter: 'energy', amount: (m[1].match(/\{E\}/g) ?? []).length, on: YOU }]],
  // Counters
  // "Put a +1/+1 counter and a trample counter on target creature"
  [/^put ((?:a|an|\w+) (?:[+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters?(?:,? (?:and )?(?:a|an|\w+) (?:[+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters?)+) on (.+)$/i, (m, ctx) => {
    const parts = m[1].split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    const items: { counter: string; amount: Amount }[] = [];
    for (const part of parts) {
      const pm = part.trim().match(/^(?:a|an|(\w+|X)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters?$/i);
      if (!pm) return null;
      const n: Amount | null = pm[1] ? wordToNumber(pm[1]) : 1;
      if (n === null) return null;
      items.push({ counter: pm[2], amount: n });
    }
    const isPlayer = /^(you|each player|each opponent|target player|target opponent|that player|its controller)$/i.test(m[2]);
    const ref = isPlayer ? playerRef(m[2], ctx) : objRef(m[2], ctx);
    if (!ref) return null;
    return items.map((it) => ({ kind: 'addCounters', counter: it.counter, amount: it.amount, on: ref }) as Effect);
  }],
  // "counter that spell or ability unless its controller pays {2}"
  [/^counter that (?:spell or ability|ability|spell)(?: unless its controller pays ((?:\{[^}]+\})+))?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'triggerObject' } as Ref);
    return [{ kind: 'counterSpell', what: ref, unlessPays: m[1] }];
  }],
  // "~ cannot be blocked by creatures with power 2 or less this turn"
  [/^(.+?) cannot be blocked by creatures with power (\d+) or (less|greater) this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const n = parseInt(m[2], 10);
    return [{ kind: 'applyRule', rule: /less/i.test(m[3]) ? { kind: 'cantBeBlockedByPowerLE', power: n } : { kind: 'cantBeBlockedByPowerGE', power: n }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Double / Switch the power and toughness of target creature until end of turn"
  [/^(double|switch) the power and toughness of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [/^double$/i.test(m[1]) ? { kind: 'doubleStat', on: ref, stat: 'both', duration: dur } : { kind: 'switchPT', on: ref, duration: dur }];
  }],
  // "Its power is equal to that creature's power and its toughness is equal to that creature's toughness"
  [/^(its|~'s) power is equal to (.+?) and (?:its|~'s) toughness is equal to (.+)$/i, (m, ctx) => {
    const pw = amt(m[2], ctx);
    const tg = amt(m[3], ctx);
    if (pw == null || tg == null) return null;
    const ref = /^its$/i.test(m[1]) ? ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref) : ({ ref: 'self' } as Ref);
    return [{ kind: 'setPT', power: pw, toughness: tg, on: ref, duration: 'permanent' }];
  }],
  // "Any player may have ~ deal 6 damage to them"
  [/^any player may have ~ deal (\d+|X) damage to (?:them|him or her)$/i, (m) => {
    const n: Amount = m[1] === 'X' ? 'X' : parseInt(m[1], 10);
    return [{ kind: 'anyPlayerMay', prompt: `Have ~ deal ${m[1]} damage to you?`, effects: [{ kind: 'damage', amount: n, to: { ref: 'controller' }, source: { ref: 'self' } }] }];
  }],
  // "draw three cards, then discard one of them"
  [/^(?:(.+?) )?draws? (\w+|X) cards?, then discards? (\w+|X) of them$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = m[2] === 'X' ? ('X' as Amount) : wordToNumber(m[2]);
    const b = m[3] === 'X' ? ('X' as Amount) : wordToNumber(m[3]);
    if (!who || a === null || b === null) return null;
    return [{ kind: 'draw', amount: a, who }, { kind: 'discard', amount: b, who }];
  }],
  // "You may put a permanent card from among the milled cards into your hand"
  [/^(?:you may )?put (?:a|an|(\w+)) (.+?) from among the milled cards into your hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const c = chooseRef(`a ${m[2]}`, ctx, YOU, true);
    if (!c) return null;
    (c.pre[0] as { filter: ObjectFilter }).filter = { ...noun.filter, zone: 'graveyard', owner: 'you' };
    return [...c.pre, { kind: 'putIntoHand', what: c.ref }];
  }],
  [/^put (?:a|an|another|(\w+|X|twice X|that many|twice that many)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? on (.+)$/i, (m, ctx) => {
    const n: Amount | null = m[1] ? (/that many/i.test(m[1]) ? amt(m[1], ctx) : /^twice x$/i.test(m[1]) ? { kind: 'times', a: 'X', b: 2 } : wordToNumber(m[1])) : 1;
    if (n === null) return null;
    const isObjectTarget = !/^(you|each player|each opponent|target player|target opponent|that player|defending player|its controller|that creature's controller|the chosen player|the chosen opponent)$/i.test(m[3]);
    const ref = isObjectTarget ? objRef(m[3], ctx) : playerRef(m[3], ctx);
    if (!ref && isObjectTarget && /^(?:a|an) /i.test(m[3])) {
      const c = chooseRef(m[3], ctx);
      if (c) return [...c.pre, { kind: 'addCounters', counter: m[2], amount: n, on: c.ref }];
    }
    return ref ? [{ kind: 'addCounters', counter: m[2], amount: n, on: ref }] : null;
  }],
  [/^distribute (\w+|X) ([+-]\d+\/[+-]\d+|\w+) counters among (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = objRef(m[3], ctx);
    return n !== null && ref ? [{ kind: 'addCounters', counter: m[2], amount: n, on: ref, divided: true }] : null;
  }],
  [/^(?:(.+?) )?draws? a card for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    if (!who) return null;
    const noun = parseNoun(m[2]);
    const a: Amount | null = perEach(m[2], ctx);
    if (a === null) return null;
    return [{ kind: 'draw', amount: a, who }];
  }],
  [/^put (?:a|an|(\w+|X)) ([+-]\d+\/[+-]\d+|\w+) counters? on (.+?) for each (.+)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const per: Amount | null = perEach(m[4], ctx);
    if (per === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[2], amount: { kind: 'times', a: n, b: per }, on: ref }] : null;
  }],
  [/^remove (a|all|(\w+|X)) counters? from (.+)$/i, (m, ctx) => {
    const n: Amount | 'all' | null = /^all$/i.test(m[1]) ? 'all' : m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'removeCounters', counter: 'any', amount: n, on: ref }] : null;
  }],
  [/^remove (?:a|an|all|(\w+|X|twice X|that many)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? from (.+)$/i, (m, ctx) => {
    const n: Amount | 'all' | null = /all/i.test(m[0].split(' ')[1]) ? 'all' : m[1] ? (/that many/i.test(m[1]) ? { kind: 'triggerAmount' } : /^twice x$/i.test(m[1]) ? { kind: 'times', a: 'X', b: 2 } : wordToNumber(m[1])) : 1;
    if (n === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'removeCounters', counter: m[2], amount: n, on: ref }] : null;
  }],
  [/^(?:you )?gets? (?:a|an|(\w+)) (poison|experience) counters?$/i, (m) => [{ kind: 'addCounters', counter: m[2].toLowerCase(), amount: m[1] ? (wordToNumber(m[1]) ?? 1) : 1, on: YOU }]],
  [/^(?:you )?gets? ((?:\{E\})+)$/i, (m) => [{ kind: 'addCounters', counter: 'energy', amount: (m[1].match(/\{E\}/g) ?? []).length, on: YOU }]],
  [/^(.+?) gets? (?:a|an|(\w+)) (poison|rad|ticket|experience|energy) counters?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'addCounters', counter: m[3].toLowerCase(), amount: m[2] ? (wordToNumber(m[2]) ?? 1) : 1, on: who }] : null;
  }],
  [/^proliferate$/i, () => [{ kind: 'proliferate' }]],
  [/^populate$/i, () => [{ kind: 'populate' }]],
  // Pump / keywords
  [/^(.+?) (?:gets?|get) ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: and (?:gains?|has|have) (.+?))?(?: until end of turn| until your next turn)?$/i, (m, ctx) => {
    const { duration: dur } = duration(m[0]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const p = m[2].toUpperCase().includes('X') ? (m[2].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[2], 10);
    const t = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[3], 10);
    const out: Effect[] = [{ kind: 'pump', power: p, toughness: t, on: ref, duration: dur ?? 'endOfTurn' }];
    if (m[4]) {
      const kws = parseKeywordList(m[4].replace(/ until end of turn$/i, ''));
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur ?? 'endOfTurn' });
    }
    return out;
  }],
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+) for each (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const a: Amount | null = perEach(m[4], ctx);
    if (a === null) return null;
    const p = parseInt(m[2], 10);
    const t = parseInt(m[3], 10);
    return [{ kind: 'pump', power: { kind: 'times', a: p, b: a }, toughness: { kind: 'times', a: t, b: a }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+) until end of turn for each (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const a: Amount | null = perEach(m[4], ctx);
    if (a === null) return null;
    return [{ kind: 'pump', power: { kind: 'times', a: parseInt(m[2], 10), b: a }, toughness: { kind: 'times', a: parseInt(m[3], 10), b: a }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^(.+?) (?:gets?|get) ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X) and gains? ((?:[\w' ]+ )?and )?"(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const p = m[2].toUpperCase().includes('X') ? (m[2].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[2], 10);
    const t = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[3], 10);
    const out: Effect[] = [{ kind: 'pump', power: p, toughness: t, on: ref, duration: 'endOfTurn' }];
    // "gains trample and \"Whenever …\"": the words before the quote are keywords.
    if (m[4]) {
      const kws = parseKeywordList(m[4].replace(/ and $/i, ''));
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' });
    }
    out.push({ kind: 'grantAbility', text: m[5], on: ref, duration: 'endOfTurn' });
    return out;
  }],
  [/^(.+?) (?:loses? all abilities and )?becomes? (?:a|an) (.+?)(?: creature)? with base power and toughness (\d+|X)\/(\d+|X)(?:,? and (?:gains )?(.+?)|, (.+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = m[2].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const out: Effect[] = [];
    if (/loses all abilities and/i.test(m[0])) out.push({ kind: 'loseAllAbilities', on: ref, duration: dur });
    out.push({ kind: 'setPT', power: m[3] === 'X' ? 'X' : parseInt(m[3], 10), toughness: m[4] === 'X' ? 'X' : parseInt(m[4], 10), on: ref, duration: dur });
    out.push({ kind: 'addTypes', types, subtypes, on: ref, duration: dur });
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    const kwText = m[5] ?? m[6];
    if (kwText) {
      const kws = parseKeywordList(kwText);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    return out;
  }],
  // "it becomes a 0/0 Robot creature in addition to its other types"
  [/^(.+?) becomes? an? (\d+)\/(\d+) ([A-Za-z][\w' -]*?) creature(?: with ([\w ,]+?))?(?: in addition to its other types)?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const noun = parseNoun(`a ${m[4]} creature`);
    if (!noun) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const kws = m[5] ? parseKeywordList(m[5]) : [];
    if (m[5] && !kws) return null;
    const out: Effect[] = [
      { kind: 'addTypes', types: ['Creature'], subtypes: noun.filter.subtypes, on: ref, duration: dur },
      { kind: 'setPT', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: dur },
    ];
    if (kws?.length) out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    return out;
  }],
  [/^(.+?) becomes? an? (artifact creature|artifact|creature|enchantment creature|enchantment)(?: in addition to its other types)?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const types = m[2].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    return [{ kind: 'addTypes', types, on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(.+?) (?:has|have) base (power|toughness) (\d+|X)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const v: Amount = m[3] === 'X' ? 'X' : parseInt(m[3], 10);
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'setPT', ...(m[2].toLowerCase() === 'power' ? { power: v } : { toughness: v }), on: ref, duration: dur }];
  }],
  // "becomes an Avatar in addition to its other types" / "becomes blue Illusions in addition to their other types"
  [/^(.+?) becomes? (?:a |an )?([A-Za-z][\w' -]*?)(?: in addition to (?:its|their) other types)?(?: until end of turn)?$/i, (m, ctx) => {
    const inAddition = /in addition to (?:its|their) other types/i.test(m[0]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = m[2].split(/\s+/).filter((w) => !/^and$/i.test(w));
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = words.filter((w) => /^(artifact|creature|enchantment|land|planeswalker)s?$/i.test(w)).map((w) => w.replace(/s$/i, '')).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w)).map((w) => w.replace(/s$/, ''));
    if (!types.length && !subtypes.length && !colors.length) return null;
    const out: Effect[] = [];
    if (!inAddition && subtypes.length && !types.length && !colors.length) out.push({ kind: 'setSubtypes', on: ref, subtypes, duration: dur });
    else if (types.length || subtypes.length) out.push({ kind: 'addTypes', types, subtypes, on: ref, duration: dur });
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    return out.length ? out : null;
  }],
  // "gains your choice of flying, vigilance, deathtouch, or haste"
  [/^(.+?) gains? your choice of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const kws = parseKeywordList(m[2].replace(/,? or /gi, ', '));
    if (!kws || kws.length < 2) return null;
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent', choose: 1 }];
  }],
  // "Until end of turn, ~ becomes a 3/2 red Goblin creature with \"…\". It is still a land."
  [/^(.+?) becomes? (?:a|an) ([\dX]+\/[\dX]+ .*?creature) with "(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const base = parseSentence(`${m[1]} becomes a ${m[2]} until end of turn`, ctx);
    if (!base) return null;
    const ref = ctx.lastObj ?? objRef(m[1], ctx);
    if (!ref) return null;
    return [...base, { kind: 'grantAbility', text: m[3], on: ref, duration: 'endOfTurn' }];
  }],
  // "target land becomes a 3/3 creature that is still a land"
  [/^(.+?) (?:loses? all abilities and )?becomes? (?:a|an) ([\dX]+)\/([\dX]+) (.*?)?creature(?: that(?:'s| is) still (?:a |an )?(\w+))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = (m[4] ?? '').trim().split(/\s+/).filter(Boolean).filter((w) => !/^and$/i.test(w));
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    if (words.some((w) => !/^(white|blue|black|red|green|artifact|enchantment|land|colorless)$/i.test(w) && !/^[A-Z]/.test(w))) return null;
    const out: Effect[] = [];
    if (/loses all abilities and/i.test(m[0])) out.push({ kind: 'loseAllAbilities', on: ref, duration: dur });
    ctx.lastObj = ref;
    out.push({ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur });
    out.push({ kind: 'addTypes', types, subtypes, on: ref, duration: dur });
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    return out;
  }],
  [/^(.+?) (?:loses? all abilities and )?(?:has|have) base power and toughness (\d+|X)\/(\d+|X)(?: and gains? ([\w ,]+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [];
    if (/loses all abilities and/i.test(m[0])) out.push({ kind: 'loseAllAbilities', on: ref, duration: dur });
    out.push({ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur });
    if (m[4]) {
      const kws = parseKeywordList(m[4]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    return out;
  }],
  [/^(.+?) loses? (.+?) until end of turn$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    return kws && ref ? [{ kind: 'removeKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) becomes? (white|blue|black|red|green|colorless)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[2].toLowerCase() as 'white'];
    return [{ kind: 'setColors', colors: c ? [c] : [], on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(.+?) blocks this turn if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlockAny' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^reveal the top card of your library and put (?:it|that card) into your hand$/i, () => [{ kind: 'draw', amount: 1 }]],
  [/^(?:(.+?) )?draws? an additional card$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'draw', amount: 1, who }] : null;
  }],
  [/^(.+?) (?:gains?|has|have) (.+?)(?: until end of turn| until your next turn)?$/i, (m, ctx) => {
    const { duration: dur } = duration(m[0]);
    const kws = parseKeywordList(m[2]);
    if (!kws) return null;
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur ?? 'endOfTurn' }] : null;
  }],
  [/^(.+?) loses? all abilities(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'loseAllAbilities', on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^(.+?) (?:cannot|can't) (attack|block|attack or block|be blocked)(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const kinds = m[2] === 'attack or block' ? ['cantAttack', 'cantBlock'] : m[2] === 'be blocked' ? ['cantBeBlocked'] : [m[2] === 'attack' ? 'cantAttack' : 'cantBlock'];
    return kinds.map((k) => ({ kind: 'applyRule', rule: { kind: k as 'cantAttack' }, on: ref, duration: dur }));
  }],
  [/^(.+?) becomes? (?:a|an) (?:legendary |snow )?([\dX]+)\/([\dX]+) (.+?) (?:creature|artifact creature)s?(?: with (.+?))?(?: and loses (.+?))?(?: that (?:is|are) (?:still|no longer) (?:a |an )?[\w ]+)?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = m[4].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...(/artifact creature$/i.test(m[0].split(' with ')[0]) || words.some((w) => /^artifact$/i.test(w)) ? ['Artifact'] : [])];
    const out: Effect[] = [{ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur }, { kind: 'addTypes', types, subtypes: words.filter((w) => /^[A-Z]/.test(w)), on: ref, duration: dur }];
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    if (m[6]) {
      const kws = parseKeywordList(m[6]);
      if (!kws) return null;
      out.push({ kind: 'removeKeywords', keywords: kws, on: ref, duration: dur });
    }
    return out;
  }],
  // Tap / untap
  [/^(tap|untap) (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: m[1].toLowerCase() as 'tap' | 'untap', what: ref }] : null;
  }],
  // Scry / surveil / mill
  [/^scry (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'scry', amount: n }];
  }],
  [/^surveil (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'surveil', amount: n }];
  }],
  [/^(?:(.+?) )?mills? (\w+|X|that many|half that many) cards?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[2]) ?? amt(m[2], ctx);
    return who && n !== null ? [{ kind: 'mill', amount: n, who }] : null;
  }],
  [/^(?:(.+?) )?mills? cards equal to (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = amt(m[2], ctx);
    return who && a !== null ? [{ kind: 'mill', amount: a, who }] : null;
  }],
  // "choose target X." → just registers the target for the following sentences
  [/^choose (target .+|up to \w+ target .+)$/i, (m, ctx) => {
    const parts = m[1].split(/ and (?=target |up to \w+ target )/i);
    for (const p of parts) if (!(objRef(p, ctx) ?? playerRef(p, ctx))) return null;
    return [];
  }],
  // Reveal-and-discard: "You choose a nonland card from it. That player discards that card."
  [/^you (?:may )?choose (?:a|an|up to (\w+)) (?:(.+?) )?cards?(?: of that color| of the chosen color)? from (?:it|among them|that hand)$/i, (m, ctx) => {
    const owner = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : null);
    if (!owner) return null;
    const noun = !m[2] || m[2] === 'card' ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[2]} card`);
    if (!noun) return null;
    const key = `revealed${ctx.targets.length}`;
    const n = m[1] ? (wordToNumber(m[1]) ?? 1) : 1;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand' }, owner, count: n, key, upTo: !!m[1] }];
  }],
  [/^(?:that player|they|target player|each of those players) discards? (?:that card|those cards|it|them|the chosen cards?)$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    return ref ? [{ kind: 'discardObjects', what: ref }] : null;
  }],
  // "each opponent with no cards in hand loses 10 life" style
  [/^each (opponent|player) (?:with|who has) (no cards in hand|(\w+) or more cards in hand|(\w+) or fewer cards in hand|more life than you|less life than you) (.+)$/i, (m, ctx) => {
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(m[5].replace(/^(loses?|gains?|draws?|discards?|sacrifices?|mills?)/i, (v) => v), sub);
    if (!inner) return null;
    let cond: Condition;
    if (/^no cards/i.test(m[2])) cond = { kind: 'handSize', ref: { ref: 'iter' }, op: '==', value: 0 };
    else if (m[3]) cond = { kind: 'handSize', ref: { ref: 'iter' }, op: '>=', value: wordToNumber(m[3]) as number };
    else if (m[4]) cond = { kind: 'handSize', ref: { ref: 'iter' }, op: '<=', value: wordToNumber(m[4]) as number };
    else cond = { kind: 'amount', a: { kind: 'life', ref: { ref: 'iter' } }, op: /more/i.test(m[2]) ? '>' : '<', b: { kind: 'life', ref: YOU } };
    return [{ kind: 'forEach', over: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: [{ kind: 'conditional', if: cond, then: inner }] }];
  }],
  [/^the ring tempts you$/i, () => [{ kind: 'ringTempts' }]],
  [/^you take the initiative$/i, () => [{ kind: 'takeInitiative' }]],
  [/^(.+?) takes the initiative$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'takeInitiative', who }] : null;
  }],
  [/^roll a (?:d(\d+)|six-sided die|twenty-sided die)$/i, (m) => [{ kind: 'rollDie', sides: m[1] ? parseInt(m[1], 10) : /six/i.test(m[0]) ? 6 : 20, results: [] }]],
  [/^exile this saga, then return it to the battlefield transformed under your control$/i, () => [{ kind: 'exile', what: SELF }, { kind: 'returnToBattlefield', what: SELF, transformed: true }]],
  [/^(?:you may )?cast (.+?)(?:, and mana of any type can be spent to cast (?:that spell|it))?$/i, (m, ctx) => {
    if (/without paying/i.test(m[0])) return null;
    const anyMana = /mana of any type/i.test(m[0]);
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'castFrom', what: ref, anyManaType: anyMana }] : null;
  }],
  // Discard
  [/^(?:(.+?) )?discards? (?:a|an|one or more|(\w+|X)) ((?:[\w-]+ )+cards?)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n: Amount = /one or more/i.test(m[0]) ? 1 : m[2] ? (m[2] === 'X' ? 'X' : wordToNumber(m[2]) ?? 1) : 1;
    return [{ kind: 'discard', amount: n, who, filter: { ...noun.filter, zone: undefined } }];
  }],
  [/^(?:(.+?) )?discards? (?:(\w+|X) cards?|a card)( at random)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    return who && n !== null ? [{ kind: 'discard', amount: n, who, random: !!m[3] }] : null;
  }],
  [/^(?:(.+?) )?discards? (?:all (?:the )?cards in (?:their|your) hand|their hands)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'discard', amount: 'hand', who }] : null;
  }],
  [/^(?:(.+?) )?discards? (?:their|your) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'discard', amount: 'hand', who }] : null;
  }],
  [/^(.+?) adds? (?:an additional )?(.+)$/i, (m, ctx) => {
    if (/^add$/i.test(m[1])) return null;
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const inner = parseSentence(`add ${m[2]}`, ctx);
    if (!inner || !inner.every((e) => e.kind === 'addMana' || e.kind === 'chooseMode')) return null;
    return inner.map((e) => (e.kind === 'addMana' ? { ...e, who } : e));
  }],
  [/^add an additional (.+)$/i, (m, ctx) => parseSentence(`add ${m[1]}`, ctx)],
  [/^add (?:an additional )?one mana of any type that (?:land|permanent|creature|artifact) produced$/i, () => [{ kind: 'addMana', mana: 'triggerMana' }]],
  [/^(.+?) adds? (?:an additional )?one mana of any type that (?:land|permanent|creature|artifact) produced$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'addMana', mana: 'triggerMana', who }] : null;
  }],
  // "Add one mana of any type that a land you control could produce."
  [/^add (\w+|X) mana of any type that (?:a|an) .+? could produce$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'addMana', mana: 'anyColor', amount: n }];
  }],
  // Mana
  [/^add (.+)$/i, (m) => {
    const body = m[1];
    let mm: RegExpMatchArray | null;
    if ((mm = body.match(/^(\w+|X) mana of any one color$/i)) || (mm = body.match(/^(\w+|X) mana in any combination of colors$/i))) {
      const n = wordToNumber(mm[1]);
      return n === null ? null : [{ kind: 'addMana', mana: 'anyColor', amount: n }];
    }
    if ((mm = body.match(/^(\w+|X) mana of any color$/i))) {
      const n = wordToNumber(mm[1]);
      return n === null ? null : [{ kind: 'addMana', mana: 'anyColor', amount: n }];
    }
    if (/^(?:\w+|X) mana of any of ~'s colors$/i.test(body) || /mana of any color in your commander's color identity/i.test(body)) return [{ kind: 'addMana', mana: 'commanderColors' }];
    const alts = parseAddManaText(`Add ${body}.`);
    if (alts.length === 1) return [{ kind: 'addMana', mana: alts[0] }];
    if (alts.length > 1) {
      // "Add {G} or {W}" → choose among alternatives
      return [{ kind: 'chooseMode', options: alts.map((a) => ({ text: `Add ${a.map((c) => `{${c}}`).join('')}`, effects: [{ kind: 'addMana', mana: a }] })) }];
    }
    return null;
  }],
  // Counter
  [/^counter (that spell|it)(?: unless (?:its controller|that player|they|the controller|that spell's controller) pays? (\{.+\}|\d+))?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' as const } : null);
    if (!ref) return null;
    const pays = m[2] ? (/^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2]) : undefined;
    return [{ kind: 'counterSpell', what: ref, unlessPays: pays }];
  }],
  [/^counter (.+?)(?: unless (?:its controller|that player|they|the controller|that spell's controller) pays? (\{.+\}|\d+))?$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    if (noun.kind !== 'spell' && noun.kind !== 'activatedOrTriggered' && noun.kind !== 'spellOrAbility') return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    const pays = m[2] ? (/^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2]) : undefined;
    return [{ kind: 'counterSpell', what: ref, unlessPays: pays }];
  }],
  // Search
  [/^search (your|their|that player's|target player's|target opponent's) library for (?:a|an|up to (that many|\w+)|(?:any number of)) (.+?)(?:, reveal (?:it|them|that card|those cards))?,?(?: and| then)? (?:(?:reveal (?:it|them),? )?(?:then )?shuffle,? and )?(?:put (?:it|them|that card|those cards|the rest) (into (?:your|their) hand|onto the battlefield(?: under your control)?( tapped)?|on top(?: of (?:your|their) library)?|into (?:your|their) graveyard)|(exile) (?:it|them|that card|those cards)(?: face down)?)(?:, then shuffle| and shuffle|, then shuffle (?:your|their) library)?(?:\. then shuffle)?$/i, (m, ctx) => {
    const nounText = m[3].replace(/ cards$/i, ' card');
    const noun = /^cards?$/i.test(m[3]) ? { filter: {} as ObjectFilter } : parseNoun(/\bcards?\b/i.test(nounText) ? nounText : `${nounText} card`);
    ctx.lastObj = { ref: 'lastMoved' };
    if (!noun) return null;
    const n: Amount | null = m[2] ? (/that many/i.test(m[2]) ? { kind: 'triggerAmount' } : wordToNumber(m[2])) : /any number of/i.test(m[0]) ? 20 : 1;
    if (n === null) return null;
    const whose = m[1].toLowerCase();
    let who: Ref | undefined;
    if (whose.startsWith('target')) {
      who = playerRef(whose.replace(/'s$/, ''), ctx) ?? undefined;
      if (!who) return null;
    } else if (whose !== 'your') {
      who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : undefined);
      if (!who) return null;
    }
    const dest = m[6] ? 'exile' : /hand/.test(m[4]) ? 'hand' : /battlefield/.test(m[4]) ? 'battlefield' : /top/.test(m[4]) ? 'top' : 'graveyard';
    return [{ kind: 'searchLibrary', who, filter: { ...noun.filter, zone: 'library' }, count: n, destination: dest, tapped: !!m[5], reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
  [/^search your ((?:library|graveyard|hand)(?:(?:,|,? and|,? and\/or|,? or|\/or) (?:your )?(?:library|graveyard|hand))*) for (?:a|an) (.+?)(?:, reveal (?:it|them|that card),?)?(?:,? and| then)? put (?:it|that card) (into your hand|onto the battlefield( tapped)?)(?:\. if you search your library this way, shuffle| and shuffle| then shuffle|, then shuffle|, then shuffle your library)?$/i, (m, ctx) => {
    const zones = [...new Set((m[1].match(/library|graveyard|hand/gi) ?? []).map((z) => z.toLowerCase()))] as ('library' | 'graveyard' | 'hand')[];
    const nounText = /\bcards?\b/i.test(m[2]) ? m[2] : `${m[2]} card`;
    const noun = parseNoun(nounText.replace(/ cards$/i, ' card'));
    if (!noun || !zones.length) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'searchLibrary', filter: f, count: 1, destination: /hand/.test(m[3]) ? 'hand' : 'battlefield', tapped: !!m[4], reveal: true, shuffle: true, zones }];
  }],
  [/^search your library for up to two (.+?) cards, reveal (?:them|those cards), put one onto the battlefield( tapped)? and the other into your hand(?:, then shuffle)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'battlefield', tapped: !!m[2], reveal: true, shuffle: false }, { kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'hand', reveal: true, shuffle: true }];
  }],
  [/^search your library for (two|\w+) cards, put one into your hand and the other (into your graveyard|onto the battlefield|on top of your library)(?:, then shuffle)?$/i, (m) => {
    ctx0();
    const dest = /graveyard/.test(m[2]) ? 'graveyard' : /battlefield/.test(m[2]) ? 'battlefield' : 'top';
    return [{ kind: 'searchLibrary', filter: { zone: 'library' }, count: 1, destination: 'hand', shuffle: false }, { kind: 'searchLibrary', filter: { zone: 'library' }, count: 1, destination: dest, shuffle: true }];
  }],
  // ---- Round 105 search variants ----
  // "search your library for a Curse card, put it onto the battlefield attached to target player, then shuffle"
  [/^search your library for (?:a|an) (.+?), put (?:it|that card) onto the battlefield attached to (.+?)(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1] : `a ${m[1]} card`);
    if (!noun) return null;
    const host = objRef(m[2], ctx);
    if (!host) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [
      { kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'battlefield', shuffle: true },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host },
    ];
  }],
  // "Search your library for X cards, then shuffle and put those cards on top in any order"
  [/^search your library for (any number of|up to \w+|X|\w+) (.*?)cards?(?:, reveal (?:it|them))?,? (?:then )?shuffle and put (?:them|those cards|it) on top(?: of your library)?(?: in any order)?$/i, (m, ctx) => {
    const nounText = m[2].trim();
    const noun = nounText ? parseNoun(`a ${nounText} card`) : { filter: {} as ObjectFilter };
    if (!noun) return null;
    const n: Amount | null = /any number of/i.test(m[1]) ? 20 : m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1].replace(/^up to /i, '')) as Amount | null);
    if (n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: n, destination: 'top', reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
  // "Search your library for a Zombie card and a Swamp card, reveal them, put them into your hand, then shuffle"
  // "Search your library for a white card, a blue card, ... and a green card, reveal them, put them into your hand, then shuffle"
  [/^search your library (?:and(?:\/or)? graveyard )?for ((?:a|an) [^,]+?(?:, (?:a|an) [^,]+?)*,? and (?:a|an) [^,]+?)(?:, reveal (?:it|them|those cards))?(?:,? (?:and )?put (?:it|them|those cards) (into your hand|onto the battlefield( tapped)?))?(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const zones: ('library' | 'graveyard')[] | undefined = /graveyard/i.test(m[0]) ? ['library', 'graveyard'] : undefined;
    const items = m[1].split(/,\s*and\s+|\s+and\s+|,\s*/i).map((x) => x.trim()).filter(Boolean);
    if (items.length < 2 || items.length > 6) return null;
    const out: Effect[] = [];
    for (let i = 0; i < items.length; i++) {
      const noun = parseNoun(/\bcards?\b/i.test(items[i]) ? items[i] : `${items[i]} card`);
      if (!noun || !noun.confident) return null;
      const dest = m[2] && /battlefield/i.test(m[2]) ? 'battlefield' : 'hand';
      out.push({ kind: 'searchLibrary', filter: { ...noun.filter, zone: zones ? undefined : 'library' }, zones, count: 1, destination: dest, tapped: m[3] ? true : undefined, reveal: /reveal/i.test(m[0]), shuffle: i === items.length - 1 });
    }
    ctx.lastObj = { ref: 'lastMoved' };
    return out;
  }],
  // "Search your library for a creature card, reveal it, put it into your hand or graveyard, then shuffle"
  [/^search your library for (?:a|an) (.+?), reveal it, put it into your (hand|graveyard) or (?:hand|graveyard)(?:, then shuffle)?$/i, (m, ctx) => {
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1] : `a ${m[1]} card`);
    if (!noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: m[2].toLowerCase() as 'hand', reveal: true, shuffle: true }];
  }],
  // "Search your library for a card with the same name as that card, reveal it, put it into your hand, then shuffle"
  [/^search your library for (?:a|an) (.*?)card with the same name as (.+?)(?:, reveal (?:it|that card))?,? put (?:it|that card) (into your hand|onto the battlefield( tapped)?)(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const base = m[1].trim();
    const noun = base ? parseNoun(`a ${base} card`) : { filter: {} as ObjectFilter };
    if (!noun) return null;
    const of = objRef(m[2], ctx);
    if (!of) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library', sameNameAs: of }, count: 1, destination: /battlefield/i.test(m[3]) ? 'battlefield' : 'hand', tapped: m[4] ? true : undefined, reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
  [/^(?:then )?shuffle(?: your library)?$/i, () => [{ kind: 'shuffle' }]],
  [/^(?:then )?(.+?) shuffles?(?: their library)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'shuffle', who }] : null;
  }],
  // Control
  [/^gain control of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'gainControl', what: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^exchange control of (.+?) and (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = objRef(m[2], ctx);
    return a && b ? [{ kind: 'exchangeControl', a, b }] : null;
  }],
  // Fight / bite
  [/^(.+?) fights (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = objRef(m[2], ctx);
    return a && b ? [{ kind: 'fight', a, b }] : null;
  }],
  // Copy
  [/^copy (target (?:activated or triggered|activated|triggered) ability(?: you control| an opponent controls| you do ?n[o']t control)?(?: from an? \w+ source)?)(?:\. You may choose new targets for the copy)?$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || noun.kind !== 'activatedOrTriggered') return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'copySpell', what: ref }];
  }],
  // "Change the target of target spell with a single target."
  [/^change the targets? of (target (?:spell|spell or ability|activated or triggered ability)(?: with a single target)?)$/i, (m, ctx) => {
    const noun = parseNoun(m[1].replace(/ with a single target$/i, ''));
    if (!noun || !noun.target) return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'changeTargets', what: ref }];
  }],
  [/^copy (.+?)(?:\. You may choose new targets for the copy)?$/i, (m, ctx) => {
    const isCard = /\bcards?\b|^(?:the exiled card|that card|the revealed card|it)$/i.test(m[1]) && !/\bspell\b/i.test(m[1]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    if (isCard) {
      ctx.lastObj = { ref: 'lastCreated' };
      return [{ kind: 'copyCard', what: ref }];
    }
    return [{ kind: 'copySpell', what: ref }];
  }],
  [/^(?:you may )?cast the cop(?:y|ies)(?: without paying (?:its|their) mana costs?)?$/i, (m) => [{ kind: 'may', effects: [/without paying/i.test(m[0]) ? { kind: 'castWithoutPaying', what: { ref: 'lastCreated' } } : { kind: 'castFrom', what: { ref: 'lastCreated' } }] }]],
  // Attach
  [/^attach (.+) to (.+?)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = a ? objRef(m[2], ctx) : null;
    return a && b ? [{ kind: 'attach', what: a, to: b }] : null;
  }],
  [/^transform (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'transform', what: ref }] : null;
  }],
  [/^goad (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'goad', what: ref }] : null;
  }],
  [/^regenerate (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'regenerate', what: ref }] : null;
  }],
  [/^(.+?) phases? out$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'phaseOut', what: ref }] : null;
  }],
  [/^you become the monarch$/i, () => [{ kind: 'becomeMonarch' }]],
  [/^(.+?) becomes the monarch$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'becomeMonarch', who }] : null;
  }],
  [/^(?:you )?take an extra turn after this one$/i, () => [{ kind: 'extraTurn' }]],
  [/^(.+?) takes an extra turn after this one$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'extraTurn', who }] : null;
  }],
  [/^you win the game$/i, () => [{ kind: 'winGame' }]],
  [/^you lose the game$/i, () => [{ kind: 'loseGame' }]],
  [/^(.+?) loses the game$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'loseGame', who }] : null;
  }],
  // Prevention
  [/^prevent all (combat |noncombat )?damage that would be dealt(?: to (.+?))? this turn(?: by (.+))?$/i, (m, ctx) => {
    const combat = /^combat/i.test(m[1] ?? '');
    let source: ObjectFilter | undefined;
    const pre: Effect[] = [];
    if (m[3] && /^sources of the color of your choice$/i.test(m[3])) {
      pre.push({ kind: 'chooseColor', key: 'color' });
      source = { chosenColor: true };
    } else if (m[3] && /^creatures blocking (?:it|~)$/i.test(m[3])) source = { types: ['Creature'], blockingSource: true };
    else if (m[3]) {
      const st = m[3].replace(/\bsources\b/i, 'permanents').replace(/\bsource\b/i, 'permanent');
      const sn = parseNoun(st) ?? parseNoun(`a ${st}`);
      if (!sn) return null;
      source = { ...sn.filter, zone: undefined };
    }
    let to: Extract<Effect, { kind: 'preventAll' }>['to'] = 'all';
    if (m[2]) {
      const l = m[2].toLowerCase();
      if (l === 'you') to = 'you';
      else if (l === 'you and planeswalkers you control' || l === 'you and each planeswalker you control') to = 'youAndPlaneswalkersYouControl';
      else if (l === 'you and creatures you control' || l === 'you and permanents you control') to = 'youAndCreaturesYouControl';
      else if (l === 'creatures you control') to = 'creaturesYouControl';
      else if (l === 'players' || l === 'each player') to = 'players';
      else if (l === 'creatures') to = 'creatures';
      else {
        const noun = parseNoun(m[2]);
        if (noun && (noun.each || noun.plural)) to = noun.filter;
        else {
          const ref = anyRef(m[2], ctx);
          if (!ref) return null;
          if (source || combat) return [...pre, { kind: 'preventAll', combat, source, to: 'all', toRef: ref }];
          return [{ kind: 'preventDamage', amount: 'all', to: ref, duration: 'endOfTurn' }];
        }
      }
    }
    if (/^noncombat/i.test(m[1] ?? '')) return null;
    return [...pre, { kind: 'preventAll', combat, source, to }];
  }],
  [/^prevent all (combat )?damage that would be dealt by (.+?) this turn$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^prevent all (combat )?damage (?:that )?(.+?) would deal this turn$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    // Source-specific: remember the object as the prevention's source filter via a chosen ref is not expressible; use a rule on the source.
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^the next time (?:a|an) (?:(\w+) )?source of your choice would deal damage to you this turn, prevent that damage$/i, (m) => {
    const c = m[1] ? ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1].toLowerCase() as 'white'] : undefined;
    const source: ObjectFilter | undefined = m[1] ? (c ? { colors: [c] } : /^artifact$/i.test(m[1]) ? { types: ['Artifact'] } : undefined) : undefined;
    if (m[1] && !source) return null;
    return [{ kind: 'preventAll', to: 'you', source, once: true }];
  }],
  [/^the next time (.+?) would deal damage this turn, prevent that damage$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'preventAll', to: 'all', sourceRef: ref, once: true }] : null;
  }],
  // "Until end of turn, target player cannot cast instant or sorcery spells"
  [/^(.+?) cannot cast (.+?)(?: until end of turn| this turn)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const data: Record<string, unknown> = {};
    if (!/^spells$/i.test(m[2])) {
      const noun = /^spells? /i.test(m[2]) ? parseNoun(`a spell ${m[2].replace(/^spells? /i, '')}`) : parseNoun(`a ${m[2].replace(/ spells?$/i, '')} spell`);
      if (!noun) return null;
      data.filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantCastSpells', data }, on: who, duration: / until end of turn$| this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(.+?) cannot activate abilities(?: that are not mana abilities| that aren't mana abilities)?(?: until end of turn| this turn)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantActivateAbilities', data: /mana abilities/i.test(m[0]) ? { exceptMana: true } : {} }, on: who, duration: / until end of turn$| this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  // "you may pay {1}. If you do, copy that ability."
  [/^copy (?:that|the) (?:ability|spell or ability)(?: for each (.+))?$/i, (m, ctx) => {
    void ctx;
    if (m[1]) return null;
    return [{ kind: 'copySpell', what: { ref: 'triggerStackItem' } }];
  }],
  [/^copy (?:that|the) (?:activated or triggered )?ability\. you may choose new targets for the copy$/i, () => [{ kind: 'copySpell', what: { ref: 'triggerStackItem' } }]],
  [/^(?:you )?choose (?:one|(\w+)) of (?:them|those cards|those creatures|the exiled cards)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const pool = ctx.restKey ? { ref: 'chosen' as const, key: ctx.restKey } : ctx.lastObj ?? { ref: 'lastMoved' as const };
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', from: pool, filter: {}, count: n as Amount, key }];
  }],
  [/^choose another player$/i, () => [{ kind: 'choosePlayer', key: 'player', who: 'opponent' }]],
  [/^choose (?:a|an) (?:card|creature card|artifact card|nonland card|land card) name(?: other than .+)?$/i, () => [{ kind: 'nameCard', key: 'cardName' }]],
  [/^choose a permanent type$/i, () => [{ kind: 'chooseCreatureType', key: 'cardType', pool: 'cardType' }]],
  // "Choose a Dwarf you control." / "Choose a nonlegendary creature on the battlefield."
  [/^choose (?:a|an|(\w+)) ((?:(?!counter\b)[\w' -])+?)(?: on the battlefield)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || !noun.confident || noun.target || noun.isCard || n === null) return null;
    ctx.lastObj = { ref: 'chosen', key: 'chosen' };
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' }, count: n, key: 'chosen' }];
  }],
  [/^end the turn$/i, () => [{ kind: 'endTurn' }]],
  // "Choose any target." (a later sentence refers to it)
  [/^choose (?:any target|another target)$/i, (m, ctx) => {
    ctx.targets.push({ description: 'any target', kind: 'any', playerFilter: 'any' });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "Double ~'s power until end of turn."
  [/^double (~'s|its|that creature's|target creature's) (power|toughness|power and toughness)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^(?:~'s|its)$/i.test(m[1]) ? SELF : objRef(m[1].replace(/'s$/, ''), ctx);
    if (!ref) return null;
    const stat = /and/i.test(m[2]) ? 'both' : (m[2].toLowerCase() as 'power' | 'toughness');
    return [{ kind: 'doubleStat', on: ref, stat, duration: 'endOfTurn' }];
  }],
  // "You may cast spells this turn as though they had flash."
  [/^you may cast (.+?) this turn as though (?:they|it) had flash$/i, (m) => {
    if (/^spells$/i.test(m[1])) return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash' } }];
    const parts = m[1].split(/ and /i).map((x) => parseNoun(x.replace(/ spells?$/i, ' spell')));
    if (!parts.every((x) => x)) return null;
    const f = parts.length === 1 ? { ...parts[0]!.filter, zone: undefined } : { anyOf: parts.map((x) => ({ ...x!.filter, zone: undefined })) };
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: f } } }];
  }],
  // "Any player may sacrifice a land of their choice. If a player does, X"
  [/^any (?:player|opponent) may sacrifice (?:a|an) (.+?) of (?:their|his or her) choice$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    return noun ? [{ kind: 'anyPlayerMaySacrifice', filter: { ...noun.filter, zone: 'battlefield' } }] : null;
  }],
  // "Target creature cannot be regenerated this turn."
  [/^(.+?) cannot be regenerated this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'cantRegenerate' }, duration: 'endOfTurn' }] : null;
  }],
  // "if you have fewer than seven cards in hand, draw cards equal to the difference"
  [/^if you have fewer than (\w+) cards in hand,? draw cards equal to the difference$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'draw', amount: { kind: 'minus', a: n, b: { kind: 'handSize', ref: YOU } } }];
  }],
  // "you get six {E}"
  [/^(?:you|that player|target player|each player|each opponent) gets? ((?:\{E\})+|\w+|that many) \{E\}$/i, (m, ctx) => {
    const n = /^\{E\}/.test(m[1]) ? (m[1].match(/\{E\}/g) ?? []).length : /that many/i.test(m[1]) ? ({ kind: 'triggerAmount' } as Amount) : wordToNumber(m[1]);
    if (n === null) return null;
    const who = playerRef(m[0].replace(/ gets? .*$/i, ''), ctx) ?? YOU;
    return [{ kind: 'addCounters', counter: 'energy', amount: n, on: who }];
  }],
  // "Exile that many cards from the top of your library." / "look at that many cards from the top of your library"
  [/^(exile|look at|mill|reveal) (that many|\w+|X) cards? from the top of (your|their|that player's) library$/i, (m, ctx) => {
    const n: Amount | null = /that many/i.test(m[2]) ? { kind: 'triggerAmount' } : wordToNumber(m[2]);
    if (n === null) return null;
    const who: Ref = /^your$/i.test(m[3]) ? YOU : ctx.lastPlayer ?? YOU;
    const v = m[1].toLowerCase();
    if (v === 'mill') return [{ kind: 'mill', amount: n, who }];
    if (v === 'exile') {
      ctx.lastObj = { ref: 'lastMoved' };
      return [{ kind: 'exileTop', amount: n, who }];
    }
    ctx.lastObj = { ref: 'memory', key: 'looked' };
    return [{ kind: 'lookAtTop', amount: n, who, reveal: v === 'reveal', then: 'hold', key: 'looked' }];
  }],
  // "sacrifice all Dragons you control"
  [/^sacrifice all (.+)$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(m[1]);
    if (!noun) return null;
    return [{ kind: 'sacrifice', what: { ref: 'all', filter: { ...noun.filter, controller: noun.filter.controller ?? 'you', zone: 'battlefield' } } }];
  }],
  // "Target land gains \"{T}: Add {C}{C}\" until ~ is cast from exile."
  [/^(.+?) gains? "(.+)" until ~ is cast from exile$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'grantAbility', text: m[2], on: ref, duration: 'permanent' }] : null;
  }],
  [/^discard any number of cards$/i, () => [{ kind: 'discard', amount: 'hand', who: YOU }]],
  [/^(?:you )?discard up to (\w+) cards?, then draw that many cards$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    return [{ kind: 'discard', amount: n, who: YOU }, { kind: 'draw', amount: { kind: 'discardedThisWay', ref: YOU } }];
  }],
  [/^suspect (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'suspect', what: ref }] : null;
  }],
  [/^add (\w+) mana of different colors$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'addManaDifferentColors', amount: n }];
  }],
  [/^untap (~|it|that creature|that permanent) and remove it from combat$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? ctx.lastObj;
    return ref ? [{ kind: 'untap', what: ref }, { kind: 'removeFromCombat', what: ref }] : null;
  }],
  [/^~ has all activated abilities of (.+)$/i, (m) => {
    const noun = parseNoun(m[1]);
    return noun ? [{ kind: 'grantAllActivatedAbilities', on: SELF, from: { ...noun.filter, zone: 'battlefield' }, duration: 'permanent' }] : null;
  }],
  [/^you have no maximum hand size for the rest of the game$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'noMaxHandSize' } }]],
  // "Prevent all damage that would be dealt this turn to creatures you control."
  [/^prevent all damage that would be dealt this turn to (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    if (ref) return [{ kind: 'preventAll', to: 'all', toRef: ref }];
    const noun = parseNoun(m[1]);
    return noun ? [{ kind: 'preventAll', to: { ...noun.filter, zone: 'battlefield' } }] : null;
  }],
  // "Prevent all damage a red source of your choice would deal this turn."
  [/^prevent all damage (?:a|an) (.+?) of your choice would deal this turn$/i, (m) => {
    const st = m[1].replace(/\bsources?\b/i, 'permanent');
    const noun = /^permanent$/i.test(st) ? { filter: {} } : parseNoun(st) ?? parseNoun(`a ${st}`);
    return noun ? [{ kind: 'preventAll', to: 'all', source: { ...noun.filter, zone: undefined } }] : null;
  }],
  // "The next time a creature of the chosen type would deal damage to you this turn, prevent that damage."
  [/^the next time (?:a|an) (.+?) would deal damage to (.+?) this turn, prevent that damage$/i, (m, ctx) => {
    const to = objRef(m[2], ctx) ?? playerRef(m[2], ctx);
    return to ? [{ kind: 'preventAll', to: 'all', toRef: to, once: true }] : null;
  }],
  // "Target player reveals a number of cards from their hand equal to X."
  [/^(.+?) reveals? a number of cards from (?:their|his or her) hand equal to (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const a = amt(m[2], ctx);
    if (!who || a === null) return null;
    return [{ kind: 'revealHand', who }];
  }],
  // "The owner of target nonland permanent puts it into their library second from the top or on the bottom."
  [/^the owner of (.+?) puts it into (?:their|his or her) library second from the top or on the bottom$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'topOrBottom', what: ref, second: true }] : null;
  }],
  // "That player shuffles, then draws a card for each card exiled from their hand this way."
  [/^(?:that player|they) shuffles?, then draws a card for each card exiled from (?:their|his or her) hand this way$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    return who ? [{ kind: 'draw', amount: { kind: 'countRef', ref: { ref: 'lastMoved' } }, who }] : null;
  }],
  // "You may choose new targets for target spell or ability."
  [/^(?:you may )?choose new targets for (target spell(?: or ability)?|that spell|it)$/i, (m, ctx) => {
    if (/^(?:that spell|it)$/i.test(m[1])) {
      const r = ctx.lastObj;
      return r ? [{ kind: 'changeTargets', what: r }] : null;
    }
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'changeTargets', what: ref }];
  }],
  // "Prevent all combat damage that would be dealt to and dealt by enchanted creature."
  [/^prevent all (combat )?damage that would be dealt to and dealt by (.+?)(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    return [
      { kind: 'preventAll', combat: !!m[1], to: 'all', toRef: ref },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: / this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' },
    ];
  }],
  // "Destroy target enchantment and all other enchantments with the same name as that enchantment."
  [/^destroy (target (\w+)) and all other \2s with the same name as that \2$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    const inner = parseNoun(`a ${m[2]}`);
    if (!inner) return null;
    return [
      { kind: 'destroy', what: { ref: 'all', filter: { ...inner.filter, zone: 'battlefield', sameNameAs: ref } } },
      { kind: 'destroy', what: ref },
    ];
  }],
  // "All lands target player controls become 3/3 creatures until end of turn."
  [/^(all|each) (.+?) become (\d+)\/(\d+) (.*?)creatures?(?: that are still lands)?(?: until end of turn)?$/i, (m, ctx) => {
    const noun = parseNoun(`all ${m[2]}`) ?? parseNoun(m[2]);
    if (!noun) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = (m[5] ?? '').trim().split(/\s+/).filter(Boolean);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    if (words.some((w) => !/^(white|blue|black|red|green|colorless|artifact|enchantment|land)$/i.test(w) && !/^[A-Z]/.test(w))) return null;
    const on: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    const out: Effect[] = [
      { kind: 'setPT', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on, duration: dur },
      { kind: 'addTypes', types: ['Creature'], subtypes, on, duration: dur },
    ];
    if (colors.length) out.push({ kind: 'setColors', colors, on, duration: dur });
    return out;
  }],
  // "~ deals twice X damage to target creature."
  [/^(.+?) deals twice (X|\w+) damage to (.+)$/i, (m, ctx) => {
    const a: Amount | null = m[2].toUpperCase() === 'X' ? 'X' : wordToNumber(m[2]);
    if (a === null) return null;
    const r = parseSentence(`${m[1]} deals X damage to ${m[3]}`, ctx);
    return r ? r.map((e) => substituteX(e, { kind: 'times', a, b: 2 })) : null;
  }],
  // Piles ------------------------------------------------------------------
  // "look at the top five cards of your library and separate them into a face-down pile and a face-up pile"
  [/^(?:(.+?) )?looks? at the top (\w+|X) cards of (your|their) library and separates? them into (?:a face-down pile and a face-up pile|two piles)$/i, (m, ctx) => {
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    const by = m[1] ? actorRef(m[1], ctx) : YOU;
    if (!by) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [
      { kind: 'lookAtTop', amount: n, who: YOU, then: 'hold', key: 'piled' },
      { kind: 'separatePiles', what: { ref: 'memory', key: 'piled' }, by, faceUpDown: /face-down/i.test(m[0]) },
    ];
  }],
  // "Reveal the top X plus one cards of your library and separate them into two piles"
  [/^reveal the top (\w+|X)(?: plus one)? cards of your library and separate them into two piles$/i, (m, ctx) => {
    const base = wordToNumber(m[1]);
    if (base === null) return null;
    const n: Amount = / plus one/i.test(m[0]) ? { kind: 'sum', parts: [base, 1] } : base;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [
      { kind: 'lookAtTop', amount: n, who: YOU, reveal: true, then: 'hold', key: 'piled' },
      { kind: 'separatePiles', what: { ref: 'memory', key: 'piled' }, by: YOU },
    ];
  }],
  // "Separate all creature cards in your graveyard into two piles." / "Separate all creatures target player controls into two piles."
  [/^(?:(.+?) )?separates? (?:all|those) (.+?) into two piles$/i, (m, ctx) => {
    const by = m[1] ? actorRef(m[1], ctx) : YOU;
    if (!by) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    if (/^(?:cards|them|those cards)$/i.test(m[2])) return [{ kind: 'separatePiles', what: ctx.lastObj?.ref === 'memory' ? ctx.lastObj : { ref: 'lastMoved' }, by }];
    const noun = parseNoun(`all ${m[2]}`) ?? parseNoun(m[2]);
    if (!noun) return null;
    return [{ kind: 'separatePiles', what: { ref: 'all', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } }, by }];
  }],
  // "An opponent chooses one of those piles." / "the pile of that player's choice"
  [/^(.+?) chooses one of those piles$/i, (m, ctx) => {
    const by = actorRef(m[1], ctx);
    if (!by) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }];
  }],
  // "Put that pile into your hand and the other into your graveyard."
  [/^put (?:that|one) pile into (your hand|your graveyard|the battlefield)(?: and the (?:other|rest) into (your hand|your graveyard|their owners'? graveyards?))?$/i, (m, ctx) => {
    const dest = (t: string): Effect['kind'] | null => (/hand/i.test(t) ? 'putIntoHand' : /graveyard/i.test(t) ? 'putIntoGraveyard' : 'returnToBattlefield');
    const out: Effect[] = [];
    if (/^one pile/i.test(m[0])) out.push({ kind: 'choosePile', by: YOU });
    const d1 = dest(m[1]);
    if (!d1) return null;
    out.push({ kind: d1, what: { ref: 'memory', key: 'chosenPile' } } as Effect);
    if (m[2]) {
      const d2 = dest(m[2]);
      if (!d2) return null;
      out.push({ kind: d2, what: { ref: 'memory', key: 'otherPile' } } as Effect);
    }
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return out;
  }],
  // "Look at the cards in the other pile."
  [/^look at the cards in the other pile$/i, (m, ctx) => {
    ctx.lastObj = { ref: 'memory', key: 'otherPile' };
    return [{ kind: 'setMemory', key: 'lookedOther', value: 1 }];
  }],
  // "Destroy all creatures in the pile of that player's choice."
  [/^(destroy|exile|tap) all (?:.+?) in the pile of (that player's|your|an opponent's|its controller's) choice$/i, (m, ctx) => {
    const by = /^your$/i.test(m[2]) ? YOU : m[2].toLowerCase().startsWith('an opponent') ? ({ ref: 'eachOpponent' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const k = m[1].toLowerCase() === 'destroy' ? 'destroy' : m[1].toLowerCase() === 'exile' ? 'exile' : 'tap';
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }, { kind: k, what: { ref: 'memory', key: 'chosenPile' } } as Effect];
  }],
  // "Exile the pile of an opponent's choice and return the other to the battlefield."
  [/^(exile|destroy|tap) the pile of (an opponent's|that player's|your) choice and (?:return|put) the other (?:to|onto) the battlefield$/i, (m, ctx) => {
    const by = /^your$/i.test(m[2]) ? YOU : m[2].toLowerCase().startsWith("an opponent") ? ({ ref: 'eachOpponent' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const k = m[1].toLowerCase() === 'exile' ? 'exile' : m[1].toLowerCase() === 'destroy' ? 'destroy' : 'tap';
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }, { kind: k, what: { ref: 'memory', key: 'chosenPile' } } as Effect, { kind: 'returnToBattlefield', what: { ref: 'memory', key: 'otherPile' }, controller: 'you' }];
  }],
  // "Put all cards from the pile of your choice onto the battlefield under your control and the rest into their owners' graveyards."
  [/^put all cards from the pile of (your|an opponent's|that player's) choice onto the battlefield under your control and the rest into their owners'? graveyards$/i, (m, ctx) => {
    const by = /^your$/i.test(m[1]) ? YOU : m[1].toLowerCase().startsWith("an opponent") ? ({ ref: 'eachOpponent' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }, { kind: 'returnToBattlefield', what: { ref: 'memory', key: 'chosenPile' }, controller: 'you' }, { kind: 'putIntoGraveyard', what: { ref: 'memory', key: 'otherPile' } }];
  }],
  // "Double the number of each kind of counter on target permanent."
  [/^double the number of each kind of counter on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'doubleCounters', on: ref }] : null;
  }],
  [/^double the number of each kind of counter (?:you|that player|target player) ha(?:ve|s)$/i, (m, ctx) => {
    const who = playerRef(m[0].replace(/^double the number of each kind of counter /i, '').replace(/ ha(?:ve|s)$/i, ''), ctx) ?? YOU;
    return [{ kind: 'doubleCounters', on: who }];
  }],
  // Licids: "~ loses this ability and becomes an Aura enchantment with enchant creature."
  [/^~ loses this ability and becomes an aura enchantment with enchant (creature|land|permanent|player|artifact)$/i, () => [
    { kind: 'addTypes', types: ['Enchantment'], setTypes: ['Enchantment'], subtypes: ['Aura'], on: SELF, duration: 'permanent' },
  ]],
  // The matching "You may pay {W} to end this effect." is compiled as a separate ability.
  [/^you may pay ((?:\{[^}]+\})+) to end this effect$/i, () => []],
  // "Exile the top three cards of your library. Choose one. You may play that card this turn."
  [/^choose one$/i, (m, ctx) => {
    const from = ctx.lastObj;
    if (!from || (from.ref !== 'lastMoved' && from.ref !== 'memory')) return null;
    ctx.lastObj = { ref: 'chosen', key: 'chosen' };
    return [{ kind: 'chooseObjects', from, filter: {}, count: 1, key: 'chosen' }];
  }],
  // "Your life total becomes 10."
  [/^(your|that player's|target player's|each player's) life total becomes (\d+)$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx);
    return who ? [{ kind: 'setLife', amount: parseInt(m[2], 10), who }] : null;
  }],
  // "Then those creatures fight each other."
  [/^(?:then )?those creatures fight each other$/i, (m, ctx) => {
    if (ctx.targets.length < 2) return null;
    return [{ kind: 'fight', a: { ref: 'target', slot: ctx.targets.length - 2 }, b: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "The player discards that card." (after "choose a card from it")
  [/^(?:the player|that player|they) discards that card$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    const what = ctx.lastObj;
    if (!who || !what) return null;
    return [{ kind: 'discardObjects', what }];
  }],
  // "choose an opponent at random"
  [/^choose an opponent at random$/i, () => [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent', random: true }]],
  // "exile all cards from your hand face down"
  [/^exile all cards from your hand face down$/i, () => [{ kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', owner: 'you' } }, faceDown: true, withSource: true }]],
  // "return all cards you own exiled with ~ to your hand"
  [/^return all cards (?:you own )?exiled with ~ to (?:your|their) hand$/i, () => [{ kind: 'putIntoHand', what: { ref: 'memory', key: 'exiledWith' } }]],
  // "the creature you control gets +1/+0 and gains indestructible until end of turn"
  [/^the creature you (?:control|do not control) (gets?.+)$/i, (m, ctx) => {
    const slot = /do not control/i.test(m[0]) ? ctx.targets.findIndex((t) => t.filter?.controller === 'opponent') : ctx.targets.findIndex((t) => t.filter?.controller === 'you');
    if (slot < 0) return null;
    const sub = { ...ctx, lastObj: { ref: 'target', slot } as Ref };
    return parseSentence(`it ${m[1]}`, sub);
  }],
  // "If that spell would be put into a graveyard, exile it instead."
  [/^if (?:that|a|an) (?:spell|card|instant or sorcery spell)(?: cast this way)? would be put into (?:your|a|its owner's) graveyard, exile it instead$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'exileInsteadOfGraveyard' }, duration: 'permanent' }];
  }],
  // "You may cast a spell from among them without paying its mana cost."
  [/^(?:you may )?cast (?:a|an) (.+?) from among them without paying its mana cost$/i, (m, ctx) => {
    const pool = poolRef(ctx);
    const noun = /^spell$/i.test(m[1]) ? { filter: { nonland: true } as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spell$/i, '')} card`);
    if (!noun) return null;
    const key = `amid${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'may', effects: [{ kind: 'chooseObjects', from: pool, filter: { ...noun.filter, nonland: true }, count: 1, key }, { kind: 'castWithoutPaying', what: { ref: 'chosen', key } }] }];
  }],
  // "You may cast it this turn, and mana of any type can be spent to cast that spell."
  [/^you may cast it this turn(?:, and mana of any type can be spent to cast that spell)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', anyMana: /any type/i.test(m[0]) || undefined }];
  }],
  // "The next sorcery spell you cast this turn can be cast as though it had flash"
  [/^the next (.+?) you cast this turn can be cast as though it had flash$/i, (m) => {
    const noun = parseNoun(`a ${m[1].replace(/ spells?$/i, ' spell')}`);
    if (!noun) return null;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: f } } }];
  }],
  // "you get {E}" with no count
  [/^you get \{E\}$/i, () => [{ kind: 'addCounters', counter: 'energy', amount: 1, on: YOU }]],
  // "You get an amount of {E} equal to its mana value"
  [/^you get an amount of \{E\} equal to (.+)$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a == null ? null : [{ kind: 'addCounters', counter: 'energy', amount: a, on: YOU }];
  }],
  // "Exchange control of two target nonlegendary creatures"
  [/^exchange control of two target (.+?)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/^(\w+)s\b/, '$1')}`) ?? parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const spec = toTargetSpec(noun);
    if (!spec) return null;
    const a = ctx.targets.length;
    ctx.targets.push(spec, { ...spec });
    return [{ kind: 'exchangeControl', a: { ref: 'target', slot: a }, b: { ref: 'target', slot: a + 1 } }];
  }],
  // "Unattach all Equipment from target creature"
  [/^unattach all (Equipment|Auras) from (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'unattach', what: ref }] : null;
  }],
  // "You may put one of those cards back on top of your library"
  [/^(?:you may )?put (?:one|a card) of those cards back on top of your library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'top' }];
  }],
  // "Exile the top four cards of your library in a face-down pile, then exile the top four cards of your library in a face-up pile."
  [/^exile the top (\w+) cards of your library in a face-down pile, then exile the top \1 cards of your library in a face-up pile$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [
      { kind: 'exileTop', amount: { kind: 'times', a: n, b: 2 } as Amount, key: 'piled' },
      { kind: 'separatePiles', what: { ref: 'memory', key: 'piled' }, by: YOU, faceUpDown: true },
    ];
  }],
  // "choose artifact, creature, enchantment, instant, or sorcery" (a card type from a fixed list)
  [/^choose ((?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)(?:, (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle))*(?:,? or (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)))$/i, () => [{ kind: 'chooseCreatureType', key: 'cardType', pool: 'cardType' }]],
  [/^choose a planeswalker type$/i, () => [{ kind: 'chooseCreatureType', key: 'planeswalkerType' }]],
  // "create a number of 1/1 black Harpy creature tokens with flying equal to your devotion to black"
  [/^create a number of (.+? tokens?(?: named [^,]+?)?(?: with .+?)?) equal to (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(`a ${m[1].replace(/ tokens$/i, ' token')}`);
    const a = amt(m[2], ctx);
    if (!t || a === null) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: a }];
  }],
  // "put a number of +1/+1 counters equal to its power on each creature you control named ~"
  [/^put a number of ([+-]\d\/[+-]\d|\w+) counters equal to (.+?) on (.+)$/i, (m, ctx) => {
    const a = amt(m[2], ctx);
    const on = objRef(m[3], ctx);
    if (a === null || !on) return null;
    return [{ kind: 'addCounters', counter: m[1], amount: a, on }];
  }],
  // "put it into its owner's library third from the top"
  [/^(?:you may )?put it into its owner's library (second|third|fourth) from the top$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? SELF;
    const pos = ({ second: 1, third: 2, fourth: 3 } as Record<string, number>)[m[1].toLowerCase()];
    const e: Effect = { kind: 'putOnLibrary', what: ref, position: 'top', depth: pos };
    return [/^you may /i.test(m[0]) ? { kind: 'may', effects: [e] } : e];
  }],
  [/^put up to (X|\w+) ([+-]\d\/[+-]\d|\w+) counters on (.+)$/i, (m, ctx) => {
    const n: Amount | null = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    const on = /^~$/i.test(m[3]) ? SELF : objRef(m[3], ctx);
    if (n === null || !on) return null;
    return [{ kind: 'addCounters', counter: m[2], amount: n, on, upTo: true }];
  }],
  [/^put your commander into your hand from the command zone$/i, () => [{ kind: 'putIntoHand', what: { ref: 'all', filter: { zone: 'command', owner: 'you', isCommander: true } } }]],
  [/^each player shuffles their hand and graveyard into their library$/i, () => [
    { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'hand', to: 'library' },
    { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'library' },
    { kind: 'shuffle', who: { ref: 'eachPlayer' } },
  ]],
  [/^(.+?) becomes blocked$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'becomesBlocked' }, duration: 'endOfTurn' }] : null;
  }],
  // "~ gets +1/-1 or -1/+1 until end of turn."
  [/^(.+?) gets? ([+-]\d+)\/([+-]\d+) or ([+-]\d+)\/([+-]\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'chooseMode', options: [
      { text: `${m[2]}/${m[3]}`, effects: [{ kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' }] },
      { text: `${m[4]}/${m[5]}`, effects: [{ kind: 'pump', power: parseInt(m[4], 10), toughness: parseInt(m[5], 10), on: ref, duration: 'endOfTurn' }] },
    ] }];
  }],
  // "You choose a nonland card from that player's graveyard or hand and exile it."
  [/^choose (?:a|an) (.+?) from (that player's|target player's|their) (?:graveyard or hand|hand or graveyard) and exile it$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const owner = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    if (!owner) return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', filter: { ...noun.filter, anyOf: [{ zone: 'graveyard' }, { zone: 'hand' }] }, owner, count: 1, key },
      { kind: 'exile', what: { ref: 'chosen', key } },
    ];
  }],
  [/^choose odd or even$/i, () => [{ kind: 'chooseOption', key: 'choice', options: ['odd', 'even'] }]],
  [/^turn (~|it|that creature|that permanent) face down$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? SELF;
    return [{ kind: 'turnFaceDown', what: ref }];
  }],
  [/^exile any number of target players' graveyards$/i, (m, ctx) => {
    ctx.targets.push({ description: 'any number of target players', kind: 'player', playerFilter: 'any', min: 0, max: 6 });
    return [{ kind: 'moveAll', who: { ref: 'target', slot: ctx.targets.length - 1 }, from: 'graveyard', to: 'exile' }];
  }],
  [/^(.+?) cannot play lands this turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'cantPlayLands' } }] : null;
  }],
  [/^your opponents cannot gain life this turn$/i, () => [{ kind: 'grantPlayerRule', who: { ref: 'eachOpponent' }, rule: { kind: 'cantGainLife' } }]],
  [/^untap all creatures that attacked this turn$/i, () => [{ kind: 'untap', what: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', attackedThisTurn: true } } }]],
  [/^destroy target creature that dealt damage to you this turn$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target creature that dealt damage to you this turn', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield', dealtDamageToYouThisTurn: true } });
    return [{ kind: 'destroy', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^each player shuffles the cards from their hand into their library, then draws that many cards$/i, () => [{ kind: 'shuffleHandIntoLibraryAndDraw', who: { ref: 'eachPlayer' } }]],
  [/^shuffle the cards from your hand into your library, then draw that many cards$/i, () => [{ kind: 'shuffleHandIntoLibraryAndDraw', who: YOU }]],
  [/^its owner puts it on (?:their|his or her) choice of the top or bottom of (?:their|his or her) library$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    return ref ? [{ kind: 'topOrBottom', what: ref }] : null;
  }],
  [/^look at target face-down creature$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target face-down creature', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield', faceDown: true } });
    return [{ kind: 'log', text: 'looks at a face-down creature' }];
  }],
  // "You get {E}{E}, then you may pay any amount of {E}." — the follow-up sentence uses "{E} paid this way".
  [/^(?:you )?gets? ((?:\{E\})+), then you may pay (any amount of|one or more|(?:\w+)) \{E\}$/i, (m) => {
    const got = (m[1].match(/\{E\}/g) ?? []).length;
    const max = /any amount|one or more/i.test(m[2]) ? 99 : wordToNumber(m[2]);
    if (max === null || typeof max !== 'number') return null;
    return [{ kind: 'addCounters', counter: 'energy', amount: got, on: YOU }, { kind: 'payEnergy', max, key: 'energyPaid' }];
  }],
  [/^choose a color of a card in your graveyard$/i, () => [{ kind: 'chooseColor', key: 'color', fromGraveyard: true }]],
  [/^add one mana of that color$/i, () => [{ kind: 'addMana', mana: 'chosenColor' }]],
  [/^for each color among permanents you control, add one mana of that color$/i, () => [{ kind: 'addManaPerColor', filter: { controller: 'you', zone: 'battlefield' } }]],
  [/^players cannot gain life this turn$/i, () => [{ kind: 'grantPlayerRule', who: { ref: 'eachPlayer' }, rule: { kind: 'cantGainLife' } }]],
  [/^put all cards exiled with ~ into their owners'? hands?$/i, () => [{ kind: 'putIntoHand', what: { ref: 'memory', key: 'exiled' } }]],
  [/^exile all (.+?) from (target player's|that player's|each player's|your) graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(m[1]);
    if (!noun) return null;
    const owner = /^your$/i.test(m[2]) ? YOU : m[2].toLowerCase().startsWith('each') ? ({ ref: 'eachPlayer' } as Ref) : playerRef(m[2].replace(/'s$/, ''), ctx);
    if (!owner) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exile', what: { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', ownerRef: owner } } }];
  }],
  // "Until end of turn, ~ loses defender and gains flying."
  [/^(~|it|that creature|target creature|enchanted creature|equipped creature) loses (.+?) and gains (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? ctx.lastObj;
    const lose = parseKeywordList(m[2]);
    const gain = parseKeywordList(m[3]);
    if (!ref || !lose || !gain) return null;
    return [
      { kind: 'grantKeywords', keywords: gain, on: ref, duration: 'endOfTurn' },
      { kind: 'loseKeywords', keywords: lose, on: ref, duration: 'endOfTurn' },
    ];
  }],
  [/^(~|it|that creature|target creature|enchanted creature|equipped creature) loses ((?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|shroud)(?:,? and .+)?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? ctx.lastObj;
    const lose = parseKeywordList(m[2]);
    if (!ref || !lose) return null;
    return [{ kind: 'loseKeywords', keywords: lose, on: ref, duration: 'endOfTurn' }];
  }],
  // "Two target players each draw a card."
  [/^(\w+) target players each (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `${m[1]} target players`, kind: 'player', playerFilter: 'any', min: n, max: n, distinct: true });
    const who: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const sub = { ...ctx, lastPlayer: who };
    const inner = parseSentence(`they ${m[2]}`, sub);
    return inner;
  }],
  // "Each player chooses a creature type."
  [/^each player chooses a creature type$/i, () => [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'chooseCreatureType', key: 'creatureType' }] }]],
  // "Then you may discard a nonland card."
  [/^(?:then )?you may discard (?:a|an) (.+?) card$/i, (m) => {
    const noun = parseNoun(`a ${m[1]} card`);
    return noun ? [{ kind: 'may', effects: [{ kind: 'discard', amount: 1, who: YOU, filter: { ...noun.filter, zone: 'hand' } }] }] : null;
  }],
  // "Target opponent puts the cards from their hand on top of their library."
  [/^(.+?) puts the cards from (?:their|his or her) hand on top of (?:their|his or her) library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'hand', to: 'library' }] : null;
  }],
  [/^counter all other spells$/i, (m, ctx) => [{ kind: 'counterSpell', what: { ref: 'all', filter: { zone: 'stack', other: true } } }]],
  [/^destroy target (Aura|Equipment) attached to (?:a|an) (\w+)$/i, (m, ctx) => {
    const host = parseNoun(`a ${m[2]}`);
    if (!host) return null;
    ctx.targets.push({ description: `target ${m[1]} attached to a ${m[2]}`, kind: 'object', filter: { subtypes: [m[1]], zone: 'battlefield', attachedToFilter: { ...host.filter, zone: undefined } } });
    return [{ kind: 'destroy', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^(\w+) target players exchange life totals$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `${m[1]} target players`, kind: 'player', playerFilter: 'any', min: n, max: n, distinct: true });
    const slot = ctx.targets.length - 1;
    return [{ kind: 'exchangeLife', a: { ref: 'target', slot }, b: { ref: 'target', slot } }];
  }],
  [/^flip (\w+) coins$/i, (m) => {
    const n = wordToNumber(m[1]);
    return typeof n === 'number' ? [{ kind: 'repeat', times: n, effects: [{ kind: 'flipCoin', win: [] }] }] : null;
  }],
  [/^destroy the chosen (?:creatures?|permanents?|cards?)$/i, () => [{ kind: 'destroy', what: { ref: 'chosen', key: 'chosen' } }]],
  [/^attach (~|it) to up to one target (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`target ${m[2]}`);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), min: 0, max: 1 });
    return [{ kind: 'attach', what: SELF, to: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^you may attach (?:a|an) (.+?) you control to it$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const host = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    if (!noun) return null;
    const key = `att${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'may', effects: [{ kind: 'chooseObjects', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, count: 1, key }, { kind: 'attach', what: { ref: 'chosen', key }, to: host }] }];
  }],
  // "Choose two target creatures controlled by the same player."
  [/^choose (\w+) target (.+?) controlled by the same (player|opponent)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[1]} target ${m[2]}`);
    if (typeof n !== 'number' || !noun) return null;
    ctx.targets.push({ description: `${m[1]} target ${m[2]} controlled by the same ${m[3]}`, kind: 'object', filter: { ...noun.filter, zone: 'battlefield', controller: m[3] === 'opponent' ? 'opponent' : undefined }, min: n, max: n, sameController: true });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "Turn target face-down creature face up."
  [/^turn (target face-down .+?) face up$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'turnFaceUp', what: ref }] : null;
  }],
  // "Return target creature card with total mana value 3 or less from your graveyard to the battlefield."
  [/^return (?:up to (\w+)|any number of|(\w+)) target (.+?) with total mana value (\d+) or less from your graveyard to (?:the battlefield|your hand)$/i, (m, ctx) => {
    const n = /any number of/i.test(m[0]) ? 20 : wordToNumber(m[1] ?? m[2]);
    const noun = parseNoun(`a ${m[3].replace(/s$/, '')}`);
    if (typeof n !== 'number' || !noun) return null;
    if (/to your hand$/i.test(m[0])) {
      ctx.targets.push({ description: `target ${m[3]} from your graveyard`, kind: 'object', filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, min: m[1] || /any number of/i.test(m[0]) ? 0 : n, max: n, totalManaValueLE: parseInt(m[4], 10) });
      return [{ kind: 'returnToHand', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
    }
    ctx.targets.push({ description: `target ${m[3]} from your graveyard`, kind: 'object', filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, min: m[1] || /any number of/i.test(m[0]) ? 0 : n, max: n, totalManaValueLE: parseInt(m[4], 10) });
    return [{ kind: 'returnToBattlefield', what: { ref: 'target', slot: ctx.targets.length - 1 }, controller: 'you' }];
  }],
  // "Destroy all Equipment attached to that creature."
  [/^destroy all (.+?) attached to (that creature|that permanent|it)$/i, (m, ctx) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(m[1]);
    const host = ctx.lastObj;
    if (!noun || !host) return null;
    return [{ kind: 'destroy', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', attachedToRef: host } } }];
  }],
  // "Destroy each creature chosen this way." / "Destroy the creatures chosen this way."
  [/^destroy (?:each|all|the) (?:creatures?|permanents?) chosen this way$/i, () => [{ kind: 'destroy', what: { ref: 'chosen', key: 'chosen' } }]],
  [/^forage$/i, () => [{ kind: 'forage' }]],
  // "Flip a coin until you lose a flip."
  [/^flip a coin until you lose a flip$/i, () => [{ kind: 'flipUntilLose' }]],
  // "~ enters under the control of an opponent of your choice."
  [/^~ enters under the control of an opponent of your choice$/i, () => [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }, { kind: 'gainControl', what: SELF, who: { ref: 'chosen', key: 'opponent' }, duration: 'permanent' }]],
  // "Return it to the battlefield tapped and transformed under its owner's control."
  [/^return it to the battlefield tapped and transformed under its owner's control$/i, (m, ctx) => [{ kind: 'returnToBattlefield', what: ctx.lastObj ?? SELF, tapped: true, transformed: true, controller: 'owner' }]],
  // "Look at the top card of that player's library, then exile it face down."
  [/^look at the top card of (that player's|target player's|their) library, then exile it face down$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    if (!who) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exileTop', amount: 1, who, faceDown: true }];
  }],
  [/^choose a player$/i, () => [{ kind: 'choosePlayer', key: 'player', who: 'any' }]],
  [/^discard (it|that card|them|those cards)$/i, (m, ctx) => (ctx.lastObj ? [{ kind: 'discardObjects', what: ctx.lastObj }] : null)],
  [/^(?:they|that player|you) puts? (it|that card|them|those cards) onto the battlefield( tapped)?(?: under (?:their|your) control)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToBattlefield', what: ref, tapped: !!m[2], controller: 'owner' }] : null;
  }],
  [/^prevent the next (\d+|X) damage that would be dealt to (.+?) this turn$/i, (m, ctx) => {
    const ref = anyRef(m[2], ctx);
    return ref ? [{ kind: 'preventDamage', amount: parseInt(m[1], 10), to: ref, duration: 'endOfTurn' }] : null;
  }],
  // Look at top
  [/^look at the top (\w+|X) cards of your library(?:\.|,)? (?:then )?put (?:one|(\w+)) of (?:them|those cards) into your hand and (?:put )?the rest (?:on the bottom of your library in a random order|into your graveyard|on the bottom of your library in any order)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null || pick === null) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard/i.test(m[0]) ? 'handRestGraveyard' : 'handRestBottom', pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? put (?:up to one|one) of them on top of your library and the rest into your graveyard$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'lookAtTop', amount: n, then: 'topRestGraveyard', pick: 1 }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? put any number of them into your graveyard and the rest (?:back )?on top of your library in any order$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'lookAtTop', amount: n, then: 'graveyardRestTop' }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?put (?:one|(\w+)|up to (\w+)|any number) of them into your hand and the rest (?:on the bottom of your library in (?:a random|any) order|into your graveyard|(?:back )?on top of your library in any order)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : m[3] ? wordToNumber(m[3]) : /any number/i.test(m[0]) ? n : 1;
    if (n === null || pick === null) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard/i.test(m[0]) ? 'handRestGraveyard' : /on top/i.test(m[0]) ? 'handRestTop' : 'handRestBottom', pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?(?:reveal|put) (?:a|an|up to (\w+)|any number of) ([^.]+?) from among them(?: and put (?:it|them) into your hand)?(?:\.? put (?:it|them) into your hand)?\.? (?:then )?(?:put the rest|and the rest) (?:on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : /any number of/i.test(m[0]) ? n : 1;
    const noun = parseNoun(/\bcards?\b/i.test(m[3]) ? m[3].replace(/ cards$/i, ' card') : `${m[3]} card`);
    if (n === null || pick === null || !noun) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard$/i.test(m[0]) ? 'handRestGraveyard' : 'handRestBottom', filter: noun.filter, pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?put (?:a|an|up to (\w+)) ([^.]+?) from among them onto the battlefield( tapped)?(?: and the rest|\.? put the rest) (?:on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(/\bcards?\b/i.test(m[3]) ? m[3].replace(/ cards$/i, ' card') : `${m[3]} card`);
    if (n === null || !noun) return null;
    return [{ kind: 'lookAtTop', amount: n, then: 'battlefieldRestBottom', filter: noun.filter, pick: m[2] ? (wordToNumber(m[2]) ?? 1) : 1 }];
  }],
  [/^look at the top (\w+|X) cards of your library, then put them back in any order$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'lookAtTop', amount: n, then: 'reorder' }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? you may reveal (?:a|an) (.+?) card from among them and put it into your hand\.? put the rest on the bottom of your library in (?:a random|any) order$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[2]} card`);
    return n === null || !noun ? null : [{ kind: 'lookAtTop', amount: n, then: 'handRestBottom', filter: noun.filter, pick: 1 }];
  }],
  [/^reveal the top card of your library\.? if it is (?:a|an) (.+?) card, put it into your hand\.? otherwise, put it (into your graveyard|on the bottom of your library)$/i, (m) => {
    const noun = parseNoun(`${m[1]} card`);
    return noun ? [{ kind: 'revealTop', ifMatches: noun.filter, then: [{ kind: 'putIntoHand', what: { ref: 'lastMoved' } }], destination: /graveyard/.test(m[2]) ? 'graveyard' : 'bottom' }] : null;
  }],
  // "If a creature would die this turn, exile it instead"
  [/^if (?:a|an) (.+?) would die this turn, exile it instead$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: 'endOfTurn' }];
  }],
  // "return all permanents to their owners' hands except for Giants, Wizards, and lands"
  [/^return all (.+?) to (?:their|its) owners'? hands? except for (.+)$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(`a ${m[1].replace(/s$/i, '')}`);
    if (!noun) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
    for (const raw of m[2].split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean)) {
      const w = raw.trim().replace(/[.,]$/, '');
      const inner = parseNoun(`a ${w.replace(/s$/i, '')}`);
      if (!inner) return null;
      if (inner.filter.types?.length) f.notTypes = [...(f.notTypes ?? []), ...inner.filter.types];
      else if (inner.filter.subtypes?.length) f.notSubtypes = [...(f.notSubtypes ?? []), ...inner.filter.subtypes];
      else return null;
    }
    return [{ kind: 'returnToHand', what: { ref: 'all', filter: f } }];
  }],
  // "Exchange control of two target permanents that share a card type"
  [/^exchange control of two target (.+?)s that share (?:a|an) (?:card|permanent) type$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const spec = toTargetSpec(noun);
    if (!spec) return null;
    const a = ctx.targets.length;
    ctx.targets.push(spec, { ...spec });
    return [{ kind: 'exchangeControl', a: { ref: 'target', slot: a }, b: { ref: 'target', slot: a + 1 } }];
  }],
  // "You control enchanted Equipment."
  [/^you control (enchanted .+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'gainControl', what: ref, duration: 'permanent' }] : null;
  }],
  // "that player returns a land they control to its owner's hand"
  [/^(each player|that player|target player|target opponent|each opponent|its controller|they) returns? (?:a|an|(\w+)) (.+?)(?: (?:they|you) control)? to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const c = chooseRef(`a ${m[3]}`, ctx, who, false);
    if (!c) return null;
    const pre0 = c.pre[0] as { filter: ObjectFilter };
    pre0.filter = { ...pre0.filter, controllerRef: who };
    return [...c.pre, { kind: 'returnToHand', what: c.ref }];
  }],
  // "Each player returns all artifact cards from their graveyard to the battlefield"
  [/^(each player|each opponent|that player|target player) returns? all (.+?) from (?:their|his or her) graveyard to the battlefield$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!who || !noun) return null;
    return [{ kind: 'returnToBattlefield', what: { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', ownerRef: who } }, controller: 'owner' }];
  }],
  // "~ gets +3/-1 until end of turn and can attack this turn as though it didn't have defender"
  [/^(.+? gets? [+-]\d+\/[+-]\d+(?: until end of turn)?) and can attack this turn as though it (?:didn't|did not) have defender$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    if (!inner) return null;
    const ref = ctx.lastObj ?? SELF;
    return [...inner, { kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "You may cast a creature spell from your graveyard this turn."
  [/^you may cast (.+?) from your graveyard this turn$/i, (m) => {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(m[1].replace(/ spells?$/i, ' spell'));
    if (!noun) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }],
  // "Artifact spells you cast this turn cost {1} less to cast."
  [/^(.+?) you cast this turn cost \{(\d+)\} less to cast$/i, (m) => {
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'grantPlayerRule', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter } }];
  }],
  // "Destroy all lands or all creatures."
  [/^destroy all (.+?) or all (.+)$/i, (m, ctx) => {
    const a = parseNoun(`all ${m[1]}`);
    const b = parseNoun(`all ${m[2]}`);
    if (!a || !b) return null;
    return [{ kind: 'chooseMode', options: [
      { text: `Destroy all ${m[1]}`, effects: [{ kind: 'destroy', what: { ref: 'all', filter: { ...a.filter, zone: 'battlefield' } } }] },
      { text: `Destroy all ${m[2]}`, effects: [{ kind: 'destroy', what: { ref: 'all', filter: { ...b.filter, zone: 'battlefield' } } }] },
    ], count: 1 }];
  }],
  // "You may cast red spells from among them this turn."
  [/^you may (?:cast|play) (.+?) from among them(?: this turn)?$/i, (m, ctx) => {
    const noun = /^(?:them|cards|spells)$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(m[1].replace(/ spells?$/i, ' spell').replace(/ cards?$/i, ' card'));
    if (!noun) return null;
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', filter: { ...noun.filter, zone: undefined } }];
  }],
  // "Those creatures fight each other."
  [/^(?:those|the two) creatures fight each other$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'fight', a: ref, b: ref }];
  }],
  // "Destroy target land unless its controller has ~ deal 2 damage to them"
  [/^(.+?) unless (its controller|that creature's controller|that player|they) has ~ deal (\d+) damage to (?:them|him or her|that player)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (!inner || !who) return null;
    return [{ kind: 'may', who, prompt: `Have ~ deal ${m[3]} damage to you instead?`, effects: [{ kind: 'damage', amount: parseInt(m[3], 10), to: who, source: { ref: 'self' } }], else: inner }];
  }],
  // "target opponent puts a card from their hand on top of their library"
  [/^(.+?) puts? (?:a|an|(\w+)) (.+?) from their hand on (?:the )?(top|bottom) of their library$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'hand', ownerRef: who }, count: n, key },
      { kind: 'putOnLibrary', what: { ref: 'chosen', key }, position: m[4].toLowerCase() === 'top' ? 'top' : 'bottom' },
    ];
  }],
  // "each opponent may put a legendary creature card from their hand onto the battlefield"
  [/^(each player|each opponent|target player|target opponent|that player) may put (?:a|an|(\w+)) (.+?) from their hand onto the battlefield$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const key = `hb${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'may', who: { ref: 'iter' }, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'hand', ownerRef: { ref: 'iter' } }, count: 1, key },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'owner' },
    ] }] }];
  }],
  // "You may look at and play those cards for as long as they remain exiled"
  [/^you may look at and (?:play|cast) those cards for as long as they remain exiled$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent' }];
  }],
  // "Target player returns an artifact, instant, or sorcery card from their graveyard to their hand"
  [/^(.+?) returns? (?:a|an|(\w+)) (.+?) from (?:their|his or her) graveyard to (?:their|his or her) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const key = `gy${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'graveyard', ownerRef: who }, count: n, key },
      { kind: 'putIntoHand', what: { ref: 'chosen', key } },
    ];
  }],
  // "put all cards exiled with ~ into their owner's graveyard"
  [/^put (.+?) into (?:their|its) owners'? graveyards?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putIntoGraveyard', what: ref }] : null;
  }],
  // "return three creatures you control to their owner's hand"
  [/^return (\w+) (.+?) to (?:their|its) owners'? hands?$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const c = chooseRef(`a ${m[2].replace(/s$/i, '')}`, ctx, YOU, false);
    if (!c) return null;
    (c.pre[0] as { count: number }).count = n;
    return [...c.pre, { kind: 'returnToHand', what: c.ref }];
  }],
  // "Destroy all permanents except for artifacts and lands"
  [/^destroy all (?:other )?(.+?) except for (.+)$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(`a ${m[1].replace(/s$/i, '')}`);
    if (!noun) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
    for (const raw of m[2].split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean)) {
      const inner = parseNoun(`a ${raw.trim().replace(/[.,]$/, '').replace(/s$/i, '')}`);
      if (!inner) return null;
      if (inner.filter.types?.length) f.notTypes = [...(f.notTypes ?? []), ...inner.filter.types];
      else if (inner.filter.subtypes?.length) f.notSubtypes = [...(f.notSubtypes ?? []), ...inner.filter.subtypes];
      else return null;
    }
    if (/^destroy all other /i.test(m[0])) f.other = true;
    return [{ kind: 'destroy', what: { ref: 'all', filter: f } }];
  }],
  // "investigate that many times" / "sacrifice that many permanents"
  [/^investigate that many times$/i, (m, ctx) => [{ kind: 'investigate', count: { kind: 'triggerAmount' } }]],
  [/^sacrifice that many (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/s$/i, '')}`);
    return noun ? [{ kind: 'sacrificeChoice', who: YOU, filter: { ...noun.filter, zone: 'battlefield' }, count: { kind: 'triggerAmount' } }] : null;
  }],
  // "destroy both creatures"
  [/^destroy both (?:creatures|permanents|of them)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'destroy', what: ref }];
  }],
  // "create a Food token or a Treasure token"
  [/^create (?:a|an) (.+?) token or (?:a|an) (.+?) token$/i, (m) => {
    const a = parseTokenPhrase(`a ${m[1]} token`);
    const b = parseTokenPhrase(`a ${m[2]} token`);
    if (!a || !b) return null;
    return [{ kind: 'chooseMode', options: [
      { text: `Create a ${m[1]} token`, effects: [{ kind: 'createToken', token: a.token, count: 1 }] },
      { text: `Create a ${m[2]} token`, effects: [{ kind: 'createToken', token: b.token, count: 1 }] },
    ], count: 1 }];
  }],
  // "Target creature and all other creatures with the same name as that creature get -3/-3 until end of turn"
  [/^(target .+?) and all other (.+?) with the same name as that \w+ (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!ref || !noun) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [
      { kind: 'pump', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: ref, duration: dur },
      { kind: 'pump', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', sameNameAs: ref } }, duration: dur },
    ];
  }],
  // "Each player's life total becomes the number of creatures they control"
  [/^(each player|each opponent|your|target player|that player)(?:'s)? life totals? becomes? (.+)$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1], ctx);
    const a = amt(m[2], ctx);
    return who && a != null ? [{ kind: 'setLife', amount: a, who }] : null;
  }],
  // "attach target Equipment you control to up to one target creature you control"
  [/^attach (.+?) to (.+)$/i, (m, ctx) => {
    const what = objRef(m[1], ctx);
    const to = what ? objRef(m[2], ctx) : null;
    return what && to ? [{ kind: 'attach', what, to }] : null;
  }],
  // "You may play that card for as long as it remains exiled, and mana of any type can be spent to cast it"
  [/^you may (?:play|cast) (.+?) for as long as it remains exiled, and mana of any type can be spent to cast it$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'playFromExile', what: ref, duration: 'permanent', anyMana: true }] : null;
  }],
  // "sacrifice it unless you tap an untapped permanent you control"
  [/^(.+?) unless you tap (?:a|an) (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const noun = inner ? parseNoun(`a ${m[2]}`) : null;
    if (!inner || !noun) return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { tap: { ...noun.filter, zone: 'battlefield' } }, effects: inner }];
  }],
  // "Exile target creature and all other creatures its controller controls with the same name as that creature"
  [/^exile (target .+?) and all other (.+?)(?: (?:its controller|that player) controls| your opponents control)? with the same name as that \w+$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!ref || !noun) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', sameNameAs: ref, other: true };
    if (/its controller controls|that player controls/i.test(m[0])) f.controllerRef = { ref: 'controllerOf', of: ref };
    if (/your opponents control/i.test(m[0])) f.controller = 'opponent';
    return [{ kind: 'exile', what: ref }, { kind: 'exile', what: { ref: 'all', filter: f } }];
  }],
  // "Destroy one of them at random" / "destroy one of those permanents at random"
  [/^(destroy|exile|sacrifice|tap) (?:one|(\w+)) of (?:them|those (?:creatures|permanents|cards|lands|tokens)) at random$/i, (m, ctx) => {
    const src = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const key = `rnd${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const verb = m[1].toLowerCase();
    const pick: Effect = { kind: 'chooseObjects', who: YOU, filter: {}, count: n, key, from: src, random: true };
    const ref: Ref = { ref: 'chosen', key };
    const act: Effect = verb === 'destroy' ? { kind: 'destroy', what: ref } : verb === 'exile' ? { kind: 'exile', what: ref } : verb === 'tap' ? { kind: 'tap', what: ref } : { kind: 'sacrifice', what: ref };
    return [pick, act];
  }],
  // "Remove up to three counters from target permanent"
  [/^remove up to (\w+) counters? from (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = n === null ? null : objRef(m[2], ctx);
    return ref && n !== null ? [{ kind: 'removeCounters', counter: 'any', amount: n, on: ref, upTo: true }] : null;
  }],
  [/^remove up to (\w+) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? from (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = n === null ? null : objRef(m[3], ctx);
    return ref && n !== null ? [{ kind: 'removeCounters', counter: m[2], amount: n, on: ref, upTo: true }] : null;
  }],
  // "double the power of target creature you control until end of turn"
  [/^double the (power|toughness) of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'doubleStat', on: ref, stat: m[1].toLowerCase() === 'power' ? 'power' : 'toughness', duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  // "Return target creature card from your graveyard to the battlefield with an additional +1/+1 counter on it"
  [/^return (.+?) from your graveyard to the battlefield with (?:an additional|(\w+) additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!ref) return null;
    return [{ kind: 'returnToBattlefield', what: ref, counters: { counter: m[3], amount: typeof n === 'number' ? n : 1 } }];
  }],
  // "Creatures target player controls do not untap during that player's next untap step"
  [/^(.+?) (?:do not|don't|doesn't|does not) untap during (?:that player's|target player's|their|your) next untap step$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilYourNextTurn' }] : null;
  }],
  // "Kithkin creatures you control also gain first strike until end of turn"
  [/^(.+?) also (gains?|get) (.+)$/i, (m, ctx) => parseSentence(`${m[1]} ${m[2]} ${m[3]}`, ctx)],
  // "If that creature would leave the battlefield, exile it instead of putting it anywhere else"
  [/^if (?:that|the) (\w+) would leave the battlefield, exile it instead of putting it anywhere else$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfLeaves' }, on: ref, duration: 'permanent' }];
  }],
  [/^if it would leave the battlefield, exile it instead of putting it anywhere else$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfLeaves' }, on: ref, duration: 'permanent' }];
  }],
  // "Copy target instant or sorcery spell twice."
  [/^copy (.+?) (twice|three times|(\w+) times)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const n = /twice/i.test(m[2]) ? 2 : /three times/i.test(m[2]) ? 3 : wordToNumber(m[3]);
    if (n === null) return null;
    return [{ kind: 'copySpell', what: ref, count: n }];
  }],
  // "Proliferate X times" / "Populate X times"
  [/^(proliferate|populate|investigate) (?:(X|\w+) times|(twice|three times))$/i, (m, ctx) => {
    const n: Amount | null = m[3] ? (/twice/i.test(m[3]) ? 2 : 3) : m[2] === 'X' ? 'X' : wordToNumber(m[2]);
    if (n === null) return null;
    if (/investigate/i.test(m[1])) return [{ kind: 'investigate', count: n }];
    const one: Effect = /proliferate/i.test(m[1]) ? { kind: 'proliferate' } : { kind: 'populate' };
    return [{ kind: 'repeat', times: n, effects: [one] }];
  }],
  // "Move all counters from target creature onto another target creature"
  [/^move (all|any number of|(\w+)) (?:([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) )?counters? from (.+?) onto (.+?)(?: with the same controller)?$/i, (m, ctx) => {
    const from = objRef(m[4], ctx);
    const to = from ? objRef(m[5], ctx) : null;
    if (!from || !to) return null;
    const amount: Amount | undefined = /^all$/i.test(m[1]) ? undefined : /any number of/i.test(m[1]) ? undefined : (wordToNumber(m[2]) ?? undefined);
    return [{ kind: 'moveCounters', from, to, counter: m[3] ? m[3].trim() : undefined, amount }];
  }],
  // "Its controller manifests dread"
  [/^(.+?) manifests? dread$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'manifest', amount: 1, dread: true, who }] : null;
  }],
  // "Target opponent skips all combat phases of their next turn" — no combat is close enough to a skipped turn's combat.
  [/^(.+?) skips (?:all combat phases of (?:their|his or her) next turn|their next combat phase)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'skipCombat' } }] : null;
  }],
  // "Shuffle ~ and target creature with a stun counter on it into their owners' libraries"
  [/^shuffle (~|it) and (.+?) into their owners'? libraries$/i, (m, ctx) => {
    const other = objRef(m[2], ctx);
    if (!other) return null;
    return [{ kind: 'moveToZone', what: SELF, zone: 'library' }, { kind: 'moveToZone', what: other, zone: 'library' }, { kind: 'shuffle' }];
  }],
  // "Until end of turn, it gains haste and \"<ability>\""
  [/^(.+?) gains? ([\w ,]+?) and "(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    if (!kws || !ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur }, { kind: 'grantAbility', text: m[3], on: ref, duration: dur }];
  }],
  // "If it is not a land card, discard it"
  [/^if it is not (?:a|an) (.+?), (discard|exile|sacrifice) it$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    if (!noun) return null;
    const act: Effect = /discard/i.test(m[2]) ? { kind: 'moveToZone', what: ref, zone: 'graveyard' } : /exile/i.test(m[2]) ? { kind: 'exile', what: ref } : { kind: 'sacrifice', what: ref };
    return [{ kind: 'conditional', if: { kind: 'not', c: { kind: 'amount', a: { kind: 'countRef', ref, filter: { ...noun.filter, zone: undefined } }, op: '>=', b: 1 } }, then: [act] }];
  }],
  // "have target creature block it this turn if able"
  [/^have (.+?) blocks? (?:it|~) this (?:turn|combat) if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlock', data: '__self__' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Exile ~ and target creature without flying that is attacking you"
  [/^exile (~|it) and (.+)$/i, (m, ctx) => {
    const other = objRef(m[2], ctx);
    return other ? [{ kind: 'exile', what: SELF }, { kind: 'exile', what: other }] : null;
  }],
  // "~ deals 2 damage to itself"
  [/^(.+?) deals (\d+|X) damage to itself$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'damage', amount: m[2] === 'X' ? 'X' : parseInt(m[2], 10), to: ref, source: ref }];
  }],
  // "Prevent all damage that ~ would deal to snow creatures"
  [/^prevent all (combat )?damage that (~|it) would deal(?: to (.+))?$/i, (m) => {
    const to = m[3] ? parseNoun(m[3]) ?? parseNoun(`a ${m[3]}`) : null;
    if (m[3] && !to) return null;
    return [{ kind: 'preventAll', combat: m[1] ? true : undefined, sourceRef: SELF, to: to ? { ...to.filter, zone: 'battlefield' } : 'all' }];
  }],
  // "For each of those tokens, you may attach an Equipment you control to it"
  [/^for each of (?:them|those (?:tokens|creatures|permanents|cards|lands|artifacts|players|opponents)), (.+)$/i, (m, ctx) => {
    const src = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastObj = { ref: 'iter' };
    sub.lastPlayer = { ref: 'controllerOf', of: { ref: 'iter' } };
    for (const body of [m[1], m[1].replace(/\bto it\b/i, 'to that permanent'), m[1].replace(/\b(?:that|this) (?:creature|permanent|card|token|land|artifact)\b/gi, 'it')]) {
      const saved = sub.targets.length;
      const inner = parseSentence(body, sub);
      if (inner) return [{ kind: 'forEach', over: src, effects: inner }];
      sub.targets.length = saved;
    }
    return null;
  }],
  // "Then you may put an instant, sorcery, or battle card from your graveyard on top of your library"
  [/^(?:then )?(?:you may )?put (?:a|an|(\w+)) (.+?) from your graveyard on (?:the )?(top|bottom) of your library$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `gyl${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const eff: Effect[] = [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: n, key, upTo: /you may/i.test(m[0]) },
      { kind: 'putOnLibrary', what: { ref: 'chosen', key }, position: m[3].toLowerCase() === 'top' ? 'top' : 'bottom' },
    ];
    return eff;
  }],
  // "that player untaps a land they control"
  [/^(that player|each player|target player|target opponent|each opponent|its controller) (untaps|taps) (?:a|an|(\w+)) (.+?)(?: (?:they|you) control)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[4]}`);
    if (!who || !noun) return null;
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (n === null) return null;
    const key = `ut${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: n, key },
      /untaps/i.test(m[2]) ? { kind: 'untap', what: { ref: 'chosen', key } } : { kind: 'tap', what: { ref: 'chosen', key } },
    ];
  }],
  // "that player discards that many cards"
  [/^(.+?) discards? that many cards$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'discard', amount: { kind: 'triggerAmount' }, who }] : null;
  }],
  // "For as long as that card remains exiled, its owner may play it"
  [/^for as long as that card remains exiled, its owner may play it$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', controller: 'owner' }];
  }],
  // "You may exile a nonland card from it" (from a hand just looked at)
  [/^(?:you may )?exile (?:a|an|(\w+)) (.+?) from (?:it|their hand|that player's hand)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `hx${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const owner = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand', ownerRef: owner }, count: n, key, upTo: /you may/i.test(m[0]) },
      { kind: 'exile', what: { ref: 'chosen', key }, remember: 'exiled' },
    ];
  }],
  // "Reveal target face-down permanent" — information only.
  [/^reveal (target .+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'log', text: `Reveal ${m[1]}.`, objectRef: ref }] : null;
  }],
  // "Choose a creature card exiled with ~"
  [/^choose (?:a|an|(\w+)) (.+? exiled with ~)$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]}`, ctx, YOU, false);
    if (!c) return null;
    if (m[1]) {
      const n = wordToNumber(m[1]);
      if (typeof n !== 'number') return null;
      (c.pre[0] as { count: number }).count = n;
    }
    return c.pre;
  }],
  // "put a creature card exiled with ~ onto the battlefield under your control with a finality counter on it"
  [/^put (?:a|an|(\w+)) (.+?) onto the battlefield(?: under your control)?(?: with (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]}`, ctx, YOU, false);
    if (!c) return null;
    if (m[1]) {
      const n = wordToNumber(m[1]);
      if (typeof n !== 'number') return null;
      (c.pre[0] as { count: number }).count = n;
    }
    const counters = m[4] ? { counter: m[4], amount: (m[3] ? wordToNumber(m[3]) : 1) ?? 1 } : undefined;
    return [...c.pre, { kind: 'returnToBattlefield', what: c.ref, counters }];
  }],
  // "Return up to one target creature card and up to one target land card from your graveyard to your hand"
  [/^return (up to one target .+?) and (up to one target .+?) from your graveyard to your hand$/i, (m, ctx) => {
    const a = objRef(`${m[1]} in your graveyard`, ctx);
    const b = a ? objRef(`${m[2]} in your graveyard`, ctx) : null;
    return a && b ? [{ kind: 'putIntoHand', what: a }, { kind: 'putIntoHand', what: b }] : null;
  }],
  // "Each opponent attacking that player does the same" — repeat the previous sentence for each of them.
  // "They block this turn if able"
  [/^(?:they|those creatures) blocks? this turn if able$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlockAny' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Target creature blocks target creature this turn if able"
  [/^(target .+?) blocks (target .+?) this turn if able$/i, (m, ctx) => {
    const blocker = objRef(m[1], ctx);
    const attacker = blocker ? objRef(m[2], ctx) : null;
    if (!blocker || !attacker) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlock', data: '__target__' }, on: blocker, duration: 'endOfTurn' }];
  }],
  // "Target creature attacks target opponent this turn if able"
  [/^(target .+?) attacks (target opponent|target player|you) this turn if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    if (/^target/i.test(m[2])) playerRef(m[2], ctx);
    return [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Its activated abilities cannot be activated this turn" / "it assigns no combat damage this turn"
  [/^(?:its|their) activated abilities cannot be activated(?: this turn)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantActivateOwnAbilities' }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^(?:it|that creature) assigns no combat damage this turn$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'assignsNoDamage' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "That player skips their next untap step"
  [/^(.+?) skips (?:their|his or her|your) next untap step$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'skipUntapStep' } }] : null;
  }],
  // "double your life total"
  [/^double (your|that player's|each player's) life totals?$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx) ?? YOU;
    return [{ kind: 'setLife', amount: { kind: 'times', a: 2, b: { kind: 'life', ref: who } }, who }];
  }],
  // "You may put that card on the bottom of that player's library" / "into their graveyard"
  [/^(?:you may )?put that card (?:on the bottom of (?:that player's|their|your) library|into (?:their|its owner's) graveyard)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const eff: Effect = /graveyard/i.test(m[0]) ? { kind: 'putIntoGraveyard', what: ref } : { kind: 'putOnLibrary', what: ref, position: 'bottom' };
    return /you may/i.test(m[0]) ? [{ kind: 'may', effects: [eff] }] : [eff];
  }],
  // "Put the exiled cards not cast this way on the bottom of your library in a random order"
  [/^(?:then )?put (?:the exiled cards not cast this way|all cards revealed this way that weren't put onto the battlefield|the exiled cards that weren't cast this way) (?:on the bottom of (?:your|their) library in a random order|into your graveyard)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [/graveyard/i.test(m[0]) ? { kind: 'putIntoGraveyard', what: ref } : { kind: 'putOnLibrary', what: ref, position: 'bottom' }];
  }],
  // "You may play those cards this turn, and you may spend mana as though it were mana of any color to cast those spells"
  [/^(?:you may )?(?:play|cast) (?:those cards|that card|spells from among those cards|spells from among cards exiled with ~|any number of spells from among cards exiled this way)(?: (?:this turn|until your next end step|until the beginning of your next upkeep|for as long as (?:they remain|it remains) exiled|for as long as you control ~))?(?: without paying (?:its|their) mana costs?)?(?:,? and (?:you may spend mana as though it were mana of any color to cast (?:those spells|it|them)|mana of any type can be spent to cast (?:those spells|that spell|them)))?(?: without paying their mana costs)?(?: for as long as (?:they remain|it remains) exiled)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const dur: 'thisTurn' | 'permanent' = /this turn|until your next end step|next upkeep/i.test(m[0]) ? 'thisTurn' : 'permanent';
    return [{ kind: 'playFromExile', what: ref, duration: dur, anyMana: /any color|any type/i.test(m[0]) || undefined, free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "that player draws two additional cards"
  [/^(.+?) draws? (\w+) additional cards?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[2]);
    return who && typeof n === 'number' ? [{ kind: 'draw', amount: n, who }] : null;
  }],
  // "If you do, discard that many cards"
  [/^discard that many cards$/i, () => [{ kind: 'discard', amount: { kind: 'triggerAmount' } }]],
  // "remove target attacking or blocking creature from combat"
  [/^remove (.+?) from combat$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'removeFromCombat', what: ref }] : null;
  }],
  // "~ deals 4 damage to target creature and each other creature with the same name as that creature"
  [/^(~|it) deals (\d+|X) damage to (target .+?) and each other (.+?) (?:with the same name as that \w+|that shares a color with it)$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx);
    const noun = parseNoun(`all ${m[4]}`);
    if (!ref || !noun) return null;
    const amount: Amount = m[2] === 'X' ? 'X' : parseInt(m[2], 10);
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', other: true };
    if (/same name/i.test(m[0])) f.sameNameAs = ref;
    else f.sharesColorWith = ref;
    return [{ kind: 'damage', amount, to: ref, source: SELF }, { kind: 'damage', amount, to: { ref: 'all', filter: f }, source: SELF }];
  }],
  // "If a creature an opponent controls would die, exile it instead" on a spell
  [/^if (?:a|an) (.+?) would die, exile it instead$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    return noun ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: 'permanent' }] : null;
  }],
  // "Attach target Aura attached to a creature to another creature"
  [/^attach (target .+?) to (another .+|target .+)$/i, (m, ctx) => {
    const what = objRef(m[1], ctx);
    const to = what ? objRef(m[2].replace(/^another /i, 'another target '), ctx) : null;
    return what && to ? [{ kind: 'attach', what, to }] : null;
  }],
  // "Exile a card from your hand face down"
  [/^exile (?:a|an|(\w+)) cards? from your hand face down$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `fd${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { zone: 'hand', owner: 'you' }, count: n, key }, { kind: 'exile', what: { ref: 'chosen', key }, faceDown: true, remember: 'exiled' }];
  }],
  // "defending player may draw a card"
  [/^(defending player|that player|target player|each opponent) may (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = who;
    const inner = parseSentence(`${m[1]} ${m[2]}`, sub);
    return inner ? [{ kind: 'may', who, effects: inner }] : null;
  }],
  // "change ~'s base power and toughness to that creature's power and toughness until end of turn"
  [/^change (~|its|that creature)'s base power and toughness to (.+?)'s power and toughness(?: until end of turn)?$/i, (m, ctx) => {
    const target = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? SELF;
    const other = objRef(m[2], ctx);
    if (!other) return null;
    return [{ kind: 'setPT', power: { kind: 'power', ref: other }, toughness: { kind: 'toughness', ref: other }, on: target, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  // "It is a 2/2 Cyberman artifact creature"
  [/^(?:it|that permanent|that card) is (?:a|an) (\d+)\/(\d+) (.+?) creature$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const noun = parseNoun(`a ${m[3]} creature`);
    if (!noun) return null;
    const types = ['Creature', ...(noun.filter.types ?? []).filter((t) => t !== 'Creature')];
    return [
      { kind: 'addTypes', types, subtypes: noun.filter.subtypes, on: ref, duration: 'permanent' },
      { kind: 'setPT', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: ref, duration: 'permanent' },
    ];
  }],
  // "Search that player's library for that many cards"
  [/^search (that player's|target player's|their|your) library for that many cards$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx) ?? YOU;
    return [{ kind: 'searchLibrary', who, filter: {}, count: { kind: 'triggerAmount' }, destination: 'hand', shuffle: true }];
  }],
  // "Your life total becomes that number"
  [/^(your|that player's|each player's) life totals? becomes? that number$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx) ?? YOU;
    return [{ kind: 'setLife', amount: { kind: 'memory', key: 'number' }, who }];
  }],
  // "The tokens are goaded for the rest of the game"
  [/^(?:the tokens|they|those creatures|it) (?:are|is) goaded(?: for the rest of the game)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'goaded', data: '__you__' }, on: ref, duration: 'permanent' }];
  }],
  // "any opponent may have it deal 5 damage to them"
  [/^any (?:player|opponent) may have (?:it|~) deal (\d+|X) damage to (?:them|him or her)$/i, (m) => {
    const n: Amount = m[1] === 'X' ? 'X' : parseInt(m[1], 10);
    return [{ kind: 'anyPlayerMay', prompt: `Have it deal ${m[1]} damage to you?`, effects: [{ kind: 'damage', amount: n, to: { ref: 'controller' }, source: SELF }] }];
  }],
  // "choose a card in your hand"
  [/^choose (?:a|an|(\w+)) (.+?) in your hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `ch${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n, key }];
  }],
  // "The next spell you cast this turn cannot be countered"
  [/^the next spell you cast this turn cannot be countered$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'nextSpellUncounterable' } }]],
  // "change a target of target spell or ability to ~"
  [/^change a target of (target spell or ability|target spell|that spell) to ~$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'changeTargets', what: ref, to: SELF }] : null;
  }],
  // "target opponent reveals cards from the top of their library until they reveal a creature card"
  [/^(.+?) reveals? cards from the top of (?:their|his or her) library until (?:they|he or she) reveals? (?:a|an) (.+?)(?:, then puts? those cards into (?:their|his or her) graveyard)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    return [{ kind: 'revealUntil', filter: { ...noun.filter, zone: undefined }, destination: 'hold', rest: /graveyard/i.test(m[0]) ? 'graveyard' : 'bottom', who }];
  }],
  // "You may have that player shuffle"
  [/^(?:you may )?have (that player|target player|each player|each opponent) shuffle$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const eff: Effect = { kind: 'shuffle', who };
    return /you may/i.test(m[0]) ? [{ kind: 'may', effects: [eff] }] : [eff];
  }],
  // "each player returns to the battlefield all cards they own exiled with it"
  [/^(each player|each opponent|that player) returns? to the battlefield all cards they own exiled with (?:it|~)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'returnToBattlefield', what: { ref: 'all', filter: { exiledWithSource: true, zone: 'exile', ownerRef: who } }, controller: 'owner' }] : null;
  }],
  // "~ deals 2 damage to any target and 3 damage to itself"
  [/^(~|it) deals (\d+|X) damage to (.+?) and (\d+|X) damage to itself$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx) ?? playerRef(m[3], ctx);
    if (!ref) return null;
    const a: Amount = m[2] === 'X' ? 'X' : parseInt(m[2], 10);
    const b: Amount = m[4] === 'X' ? 'X' : parseInt(m[4], 10);
    return [{ kind: 'damage', amount: a, to: ref, source: SELF }, { kind: 'damage', amount: b, to: SELF, source: SELF }];
  }],
  // "It has trample, haste, and \"At the beginning of the end step, sacrifice ~.\""
  [/^(?:it|they|that creature|those creatures) (?:has|have) ([\w ,]+?),? and "(.+)"$/i, (m, ctx) => {
    const kws = parseKeywordList(m[1]);
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    if (!kws) return null;
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'permanent' }, { kind: 'grantAbility', text: m[2], on: ref, duration: 'permanent' }];
  }],
  // "destroy all tokens created with ~"
  // "Choose a number" / "Choose a player at random"
  [/^choose a player at random$/i, () => [{ kind: 'choosePlayer', key: 'player', who: 'any', random: true }]],
  // "draw two additional cards"
  [/^draws? (\w+) additional cards?$/i, (m) => {
    const n = wordToNumber(m[1]);
    return typeof n === 'number' ? [{ kind: 'draw', amount: n }] : null;
  }],
  // "Put ~ from your hand onto the battlefield"
  [/^put ~ from your hand onto the battlefield$/i, () => [{ kind: 'returnToBattlefield', what: SELF }]],
  // "Shuffle your library, then reveal the top card"
  [/^shuffle your library, then reveal the top card$/i, () => [{ kind: 'shuffle', who: YOU }, { kind: 'revealTop' }]],
  // "They may cast that card without paying its mana cost"
  [/^(?:they|its owner|that player) may (?:cast|play) that card(?: without paying its mana cost)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', controller: 'owner', free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "Prevent all damage that would be dealt to ~ by creatures it is blocking"
  [/^prevent all (combat )?damage that would be dealt to (~|it) by (.+)$/i, (m) => {
    const noun = parseNoun(m[3]) ?? parseNoun(`a ${m[3]}`);
    if (!noun) return null;
    return [{ kind: 'preventAll', combat: m[1] ? true : undefined, toRef: SELF, to: 'all', source: { ...noun.filter, zone: 'battlefield' } }];
  }],
  // "Target creature gains all creature types until end of turn"
  [/^(.+?) (?:gains?|loses?) all creature types(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [/loses/i.test(m[0]) ? { kind: 'addTypes', types: [], setSubtypes: [], on: ref, duration: dur } : { kind: 'grantKeywords', keywords: ['Changeling'], on: ref, duration: dur }];
  }],
  // "They are Zombies in addition to their other types"
  [/^(?:they are|it is|those creatures are) ([A-Z][\w-]+?)s?(?: creatures?)? in addition to (?:their|its) other types$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'addTypes', types: noun.filter.types ?? [], subtypes: noun.filter.subtypes, on: ref, duration: 'permanent' }];
  }],
  // "move any number of +1/+1 counters from other permanents you control onto ~"
  [/^move (all|any number of|(\w+)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? from (.+?) onto (?:~|it)$/i, (m, ctx) => {
    const from = objRef(m[4], ctx);
    if (!from) return null;
    const amount: Amount | undefined = /^all$/i.test(m[1]) || /any number of/i.test(m[1]) ? undefined : (wordToNumber(m[2]) ?? undefined);
    return [{ kind: 'moveCounters', from, to: SELF, counter: m[3], amount }];
  }],
  // "Put a stun counter on one of them"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? on one of them$/i, (m, ctx) => {
    const src = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `one${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key, from: src }, { kind: 'addCounters', counter: m[2], amount: n, on: { ref: 'chosen', key } }];
  }],
  // "Put them on top of that player's library in any order"
  [/^put them on (?:the )?(top|bottom) of (?:that player's|their|your) library(?: in any order| in a random order)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: /top/i.test(m[1]) ? 'top' : 'bottom' }];
  }],
  // "Prevent all combat damage a creature of your choice would deal this turn"
  [/^prevent all (combat )?damage (?:a|an) (.+?) of your choice would deal this turn$/i, (m) => {
    const noun = parseNoun(`a ${m[2]}`);
    return noun ? [{ kind: 'preventAll', combat: m[1] ? true : undefined, source: { ...noun.filter, zone: 'battlefield' }, to: 'all', once: true }] : null;
  }],
  // "there is an additional combat phase after this phase followed by an additional main phase"
  [/^there is an additional combat phase after this phase(?: followed by an additional main phase)?$/i, () => [{ kind: 'extraCombat' }]],
  // "~ and another target creature each get +1/+0 until end of turn"
  [/^(?:~|it) and (another target .+?|target .+?) each (?:gets?|get) ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: until end of turn)?$/i, (m, ctx) => {
    const other = objRef(m[1], ctx);
    if (!other) return null;
    const pw: Amount = m[2] === '+X' ? 'X' : parseInt(m[2], 10);
    const tg: Amount = m[3] === '+X' ? 'X' : parseInt(m[3], 10);
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'pump', power: pw, toughness: tg, on: SELF, duration: dur }, { kind: 'pump', power: pw, toughness: tg, on: other, duration: dur }];
  }],
  // "That opponent may cast the exiled card without paying its mana cost"
  [/^(?:that opponent|that player|they) may cast the exiled card(?: without paying its mana cost)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', controller: 'owner', free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "~ must be blocked each combat this turn if able"
  [/^(.+?) must be blocked(?: each combat)?(?: this turn)? if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBeBlocked' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Target snow land is no longer snow" / "Target nonsnow basic land becomes snow"
  [/^(.+?) (?:is no longer snow|becomes snow)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [/no longer/i.test(m[0]) ? { kind: 'addTypes', types: [], removeSupertypes: ['Snow'], on: ref, duration: 'permanent' } : { kind: 'addTypes', types: [], addSupertypes: ['Snow'], on: ref, duration: 'permanent' }];
  }],
  // "You may put a creature card exiled this way onto the battlefield"
  [/^(?:you may )?put (?:a|an|(\w+)) (.+?) exiled this way onto the battlefield(?: (tapped))?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `ex${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const pre: Effect = { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'exile', exiledWithSource: true }, count: n, key, upTo: /you may/i.test(m[0]) };
    ctx.lastObj = { ref: 'chosen', key };
    return [pre, { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, tapped: !!m[3] }];
  }],
  // "return it to the battlefield face down under your control"
  [/^return (?:it|that card|~) to the battlefield face down(?: under your control)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'returnToBattlefield', what: ref, faceDown: true }];
  }],
  // "put it on your choice of the top or bottom of its owner's library"
  [/^(?:you may )?put (?:it|that card|them|those cards) on (?:your|their|its owner's) choice of the top or bottom of (?:its owner's|their|your) librar(?:y|ies)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'ownerChoice' }];
  }],
  // "each player's life total becomes the highest life total among all players"
  // "The next spell you cast this turn has improvise"
  [/^the next spell you cast this turn has (convoke|improvise|delve)$/i, (m) => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'grantSpellKeyword', data: { keyword: m[1].toLowerCase() } } }]],
  // "roll a four-sided die" / "Roll two d8 and choose one result"
  [/^rolls? (?:a|an) (four|six|eight|ten|twelve|twenty)-sided die$/i, (m) => {
    const sides = ({ four: 4, six: 6, eight: 8, ten: 10, twelve: 12, twenty: 20 } as Record<string, number>)[m[1].toLowerCase()];
    return [{ kind: 'rollDie', sides, results: [] }];
  }],
  // "It gets +2/+2 until end of turn and can block an additional creature this turn"
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)? and can block an additional creature(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [
      { kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'extraBlock' }, on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "Each creature dealt damage this way attacks this turn if able"
  [/^each (.+?) dealt damage this way attacks this turn if able$/i, () => [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  // "You may unattach an Equipment from a creature you control"
  [/^(?:you may )?unattach (?:a|an) (Equipment|Aura) from (?:a|an) (.+)$/i, (m, ctx) => {
    const c = chooseRef(`an ${m[1]} attached to a ${m[2]}`, ctx, YOU, /you may/i.test(m[0]));
    if (!c) return null;
    return [...c.pre, { kind: 'unattach', what: c.ref }];
  }],
  // "An opponent chooses a creature card from among them"
  [/^(an opponent|target opponent|that player|target player|each opponent) chooses (?:a|an|(\w+)) (.+?) from among them$/i, (m, ctx) => {
    const who = playerRef(m[1] === 'an opponent' ? 'each opponent' : m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (typeof n !== 'number') return null;
    const src = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const key = `opp${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: undefined }, count: n, key, from: src }];
  }],
  // "double the number of +1/+1 counters on it"
  [/^double the number of ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'doubleCounters', counter: m[1], on: ref }] : null;
  }],
  // "Roll two d8 and choose one result"
  [/^roll (\w+) d(\d+)(?: and choose one result)?$/i, (m) => {
    const sides = parseInt(m[2], 10);
    return [{ kind: 'rollDie', sides, results: [] }];
  }],
  // "If that spell would be put into their graveyard, exile it instead"
  [/^if that (?:spell|card|creature|permanent) would be put into (?:their|its owner's|your) graveyard, exile it instead$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: ref, duration: 'permanent' }];
  }],
  // "Until end of turn, creatures your opponents control lose hexproof and shroud and cannot have hexproof or shroud"
  [/^(.+?) lose ([\w ]+?)(?: and ([\w ]+?))? and cannot (?:have or gain|have) [\w ]+?(?: or [\w ]+?)?(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList([m[2], m[3]].filter(Boolean).join(', '));
    const ref = kws ? objRef(m[1], ctx) : null;
    return kws && ref ? [{ kind: 'removeKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Exile all cards from all opponents' hands and graveyards"
  [/^exile all cards from all opponents'? (hands and graveyards|hands|graveyards)$/i, (m) => {
    const out: Effect[] = [];
    if (/hand/i.test(m[1])) out.push({ kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', owner: 'opponent' } } });
    if (/graveyard/i.test(m[1])) out.push({ kind: 'exile', what: { ref: 'all', filter: { zone: 'graveyard', owner: 'opponent' } } });
    return out;
  }],
  // "Turn target creature with a morph ability face down"
  [/^turn (target .+?) face down$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'turnFaceDown', what: ref }] : null;
  }],
  // "You skip your next untap step"
  [/^(?:you|that player|each opponent|target player) skips? (?:your|their) next untap step$/i, (m, ctx) => {
    const who = /^you /i.test(m[0]) ? YOU : playerRef(m[0].split(' ')[0] === 'each' ? 'each opponent' : m[0].split(' ').slice(0, 2).join(' '), ctx) ?? YOU;
    return [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'skipUntapStep' } }];
  }],
  // "each opponent cannot cast instant or sorcery spells during that player's next turn"
  [/^(each opponent|each player|target opponent|target player|that player) cannot cast (.+?) during (?:that player's|their) next turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = /^spells$/i.test(m[2]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[2].replace(/ spells?$/i, '')} spell`);
    if (!who || !noun) return null;
    return [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'cantCastSpells', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }],
  // "A creature dealt damage this way cannot block this turn"
  [/^(?:a|each) (.+?) dealt damage this way cannot (block|attack)(?: this turn)?$/i, (m) => [{ kind: 'applyRule', rule: /block/i.test(m[2]) ? { kind: 'cantBlock' } : { kind: 'cantAttack' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  // "Prevent the next 1 damage that would be dealt by ~ this turn"
  [/^prevent the next (\d+) damage that would be dealt by (~|it) this turn$/i, (m) => [{ kind: 'preventAll', amount: parseInt(m[1], 10), sourceRef: SELF, to: 'all', once: true }]],
  // "Prevent all combat damage that would be dealt by target blocked creature this turn"
  [/^prevent all (combat )?damage that would be dealt by (target .+?) this turn$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'preventAll', combat: m[1] ? true : undefined, sourceRef: ref, to: 'all' }] : null;
  }],
  // "Double target player's life total"
  [/^double (target player|target opponent|that player|each player|each opponent)'s life totals?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'setLife', amount: { kind: 'times', a: 2, b: { kind: 'life', ref: who } }, who }] : null;
  }],
  // "Untap and goad that creature"
  [/^untap and goad (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'untap', what: ref }, { kind: 'applyRule', rule: { kind: 'custom', tag: 'goaded', data: '__you__' }, on: ref, duration: 'permanent' }] : null;
  }],
  // "have it connive"
  [/^have (it|that creature|~) connives?$/i, (m, ctx) => parseSentence(`${m[1]} connives`, ctx)],
  // "You gain hexproof until your next turn"
  [/^(?:you|that player|target player) gains? (hexproof|shroud|protection from everything)(?: until your next turn| until end of turn)?$/i, (m, ctx) => {
    const who = /^you /i.test(m[0]) ? YOU : ctx.lastPlayer ?? YOU;
    return [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: m[1].toLowerCase().replace(/ /g, '') } }];
  }],
  // "Put ~ from your graveyard into your library third from the top"
  [/^put (~|it|that card) from your graveyard into your library (\w+) from the top$/i, (m, ctx) => {
    const depth = wordToNumber(m[2].replace(/^(first|second|third|fourth|fifth|sixth|seventh)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five', sixth: 'six', seventh: 'seven' } as Record<string, string>)[w.toLowerCase()] ?? w));
    if (typeof depth !== 'number') return null;
    const ref = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'top', depth: depth - 1 }];
  }],
  // "Put up to four target cards from your graveyard on the bottom of your library in any order"
  [/^put (up to \w+ target .+?|target .+?) from your graveyard on (?:the )?(top|bottom) of your library(?: in any order)?$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} in your graveyard`, ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: /top/i.test(m[2]) ? 'top' : 'bottom' }] : null;
  }],
  // "Destroy up to one target artifact, up to one target creature, and up to one target land"
  [/^(destroy|exile|tap) ((?:up to one target|target) [\w -]+?), ((?:up to one target|target) [\w -]+?),? and ((?:up to one target|target) [\w -]+)$/i, (m, ctx) => {
    const refs = [m[2], m[3], m[4]].map((t) => objRef(t, ctx));
    if (refs.some((r) => !r)) return null;
    const verb = m[1].toLowerCase();
    return refs.map((r) => (verb === 'destroy' ? { kind: 'destroy', what: r! } : verb === 'exile' ? { kind: 'exile', what: r! } : { kind: 'tap', what: r! }) as Effect);
  }],
  // "Simultaneously untap all tapped creatures and tap all untapped creatures"
  [/^simultaneously untap all tapped (.+?) and tap all untapped (.+)$/i, (m) => {
    const a = parseNoun(`all ${m[1]}`);
    const b = parseNoun(`all ${m[2]}`);
    if (!a || !b) return null;
    return [
      { kind: 'untap', what: { ref: 'all', filter: { ...a.filter, zone: 'battlefield', tapped: true } } },
      { kind: 'tap', what: { ref: 'all', filter: { ...b.filter, zone: 'battlefield', untapped: true } } },
    ];
  }],
  // "Counter target instant spell if it is blue"
  [/^counter (target .+?) if it is (white|blue|black|red|green)$/i, (m, ctx) => {
    const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, 'W' | 'U' | 'B' | 'R' | 'G'>)[m[2].toLowerCase()];
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'conditional', if: { kind: 'objectMatches', ref, filter: { colors: [cn] } }, then: [{ kind: 'counterSpell', what: ref }] }];
  }],
  // "Target player scries 3" / "Target player puts the bottom card of their library into their graveyard"
  [/^(.+?) scries (\d+|X)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'scry', amount: m[2] === 'X' ? 'X' : parseInt(m[2], 10), who }] : null;
  }],
  [/^(.+?) puts the bottom card of their library into their graveyard$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'mill', amount: 1, who, fromBottom: true }] : null;
  }],
  // "Exile one of those creatures and put two +1/+1 counters on the other"
  [/^exile one of those (.+?) and put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? on the other$/i, (m, ctx) => {
    const src = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key, from: src },
      { kind: 'exile', what: { ref: 'chosen', key } },
      { kind: 'addCounters', counter: m[3], amount: n, on: src },
    ];
  }],
  // "You may have any number of them phase out"
  [/^(?:you may have )?any number of them phase out$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'may', effects: [{ kind: 'phaseOut', what: ref }] }];
  }],
  // "Players cannot cast noncreature spells this turn"
  [/^players cannot cast (.+?)(?: this turn)?$/i, (m) => {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spells?$/i, '')} spell`);
    if (!noun) return null;
    return [{ kind: 'grantPlayerRule', who: { ref: 'eachPlayer' }, rule: { kind: 'custom', tag: 'cantCastSpells', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }],
  // "Prevent all damage that creatures would deal to players this turn"
  [/^prevent all (combat )?damage that (.+?) would deal to (players|creatures|you)(?: this turn)?$/i, (m) => {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    return [{ kind: 'preventAll', combat: m[1] ? true : undefined, source: { ...noun.filter, zone: 'battlefield' }, to: /players/i.test(m[3]) ? 'players' : /creatures/i.test(m[3]) ? 'creatures' : 'you' }];
  }],
  // "Target opponent blights 2"
  [/^(.+?) blights (\d+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'addCounters', counter: '-1/-1', amount: parseInt(m[2], 10), on: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', controllerRef: who } } }] : null;
  }],
  // "That creature is black and is a Nightmare in addition to its other creature types"
  [/^(?:that creature|it) is (white|blue|black|red|green) and is (?:a|an) ([A-Z][\w-]+) in addition to its other creature types$/i, (m, ctx) => {
    const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, 'W' | 'U' | 'B' | 'R' | 'G'>)[m[1].toLowerCase()];
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'setColors', colors: [cn], on: ref, duration: 'permanent' }, { kind: 'addTypes', types: [], subtypes: [m[2]], on: ref, duration: 'permanent' }];
  }],
  // "Until your next turn, creatures cannot attack you"
  [/^creatures cannot attack you(?: until your next turn)?$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'cantBeAttacked', data: { filter: { types: ['Creature'] } } } }]],
  // "Until your next turn, creatures your opponents control enter tapped"
  [/^creatures your opponents control enter tapped(?: until your next turn)?$/i, () => [{ kind: 'grantPlayerRule', who: { ref: 'eachOpponent' }, rule: { kind: 'entersTapped' } }]],
  // "~ deals 1 damage to any target, 2 damage to another target, and 3 damage to a third target"
  [/^(?:~|it) deals (\d+) damage to (any target|target [\w -]+?), (\d+) damage to (another target|target [\w -]+?),? and (\d+) damage to (?:a third target|another target|target [\w -]+)$/i, (m, ctx) => {
    const a = objRef(m[2], ctx) ?? playerRef(m[2], ctx);
    const b = a ? objRef(m[4] === 'another target' ? 'any target' : m[4], ctx) ?? playerRef(m[4], ctx) : null;
    const c = b ? objRef('any target', ctx) : null;
    if (!a || !b || !c) return null;
    return [
      { kind: 'damage', amount: parseInt(m[1], 10), to: a, source: SELF },
      { kind: 'damage', amount: parseInt(m[3], 10), to: b, source: SELF },
      { kind: 'damage', amount: parseInt(m[5], 10), to: c, source: SELF },
    ];
  }],
  // "Target legendary creature card in your graveyard gains escape until end of turn"
  [/^(target .+? in (?:your|a) graveyard) gains ([\w ]+?)(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    return kws && ref ? [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Put target spell or nonland permanent into its owner's library second from the top"
  [/^put (target .+?) into (?:its owner's|their owner's) library (\w+) from the top$/i, (m, ctx) => {
    const depth = wordToNumber(m[2].replace(/^(first|second|third|fourth|fifth|sixth|seventh)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five', sixth: 'six', seventh: 'seven' } as Record<string, string>)[w.toLowerCase()] ?? w));
    const ref = typeof depth === 'number' ? objRef(m[1], ctx) : null;
    return ref && typeof depth === 'number' ? [{ kind: 'putOnLibrary', what: ref, position: 'top', depth: depth - 1 }] : null;
  }],
  // "Search your library for up to three creature cards, reveal them, then shuffle and put those cards on top in any order"
  [/^search your library for (?:up to (\w+)|(\w+)) (.+?), reveal them, then shuffle and put those cards on top in any order$/i, (m) => {
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    const n = wordToNumber(m[1] ?? m[2]);
    if (!noun || typeof n !== 'number') return null;
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: undefined }, count: n, destination: 'top', reveal: true, shuffle: true }];
  }],
  // "Create two tokens that are copies of the sacrificed creature"
  [/^create (\w+) tokens? that (?:is|are) cop(?:y|ies) of the sacrificed creature$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'createToken', token: { name: 'Copy', typeLine: 'Creature', colors: [], copyOf: { ref: 'chosen', key: 'sacrificed' } }, count: n }];
  }],
  // "Enchanted creature and other creatures that share a creature type with it get +1/+1 until end of turn"
  [/^(?:enchanted|equipped) creature and other creatures that share a creature type with it (?:(?:gets?|get) ([+-]\d+)\/([+-]\d+))?(?:and )?(?:gains? ([\w ,]+?))?(?: and gain ([\w ,]+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const host: Ref = { ref: 'attachedTo' };
    const others: Ref = { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', other: true, sharesCreatureTypeWithSource: true } };
    const out: Effect[] = [];
    if (m[1]) {
      out.push({ kind: 'pump', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: host, duration: 'endOfTurn' });
      out.push({ kind: 'pump', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: others, duration: 'endOfTurn' });
    }
    const kwText = [m[3], m[4]].filter(Boolean).join(', ');
    if (kwText) {
      const kws = parseKeywordList(kwText.replace(/\bfrom /g, ''));
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: host, duration: 'endOfTurn' });
      out.push({ kind: 'grantKeywords', keywords: kws, on: others, duration: 'endOfTurn' });
    }
    return out.length ? out : null;
  }],
  // "prevent the next 5 damage that would be dealt this turn to any number of targets, divided as you choose"
  [/^prevent the next (\d+) damage that would be dealt this turn to any number of targets, divided as you choose$/i, (m) => [{ kind: 'preventAll', amount: parseInt(m[1], 10), to: 'all', once: true }]],
  // "If a permanent dealt damage this way would die this turn, exile it instead"
  [/^if (?:a|an) (.+?) dealt damage this way would (?:die|be destroyed) this turn, exile it instead$/i, () => [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  // "If a card would be put into your graveyard from anywhere this turn, exile that card instead"
  [/^if (?:a|an) (.+?) would be put into your graveyard from anywhere this turn, exile that \w+ instead$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'exileInsteadOfGraveyard' } }]],
  // "If you would roll one or more dice, roll that many dice plus one and ignore the lowest roll instead"
  [/^if you would roll one or more dice, (?:instead )?roll that many dice plus (\w+) and ignore the lowest roll(?: instead)?$/i, (m) => {
    const n = wordToNumber(m[1]);
    return typeof n === 'number' ? [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraDice', data: n } }] : null;
  }],
  // "copy it, except the copy is not legendary"
  [/^copy it, except the copy is not legendary$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'copySpell', what: ref, count: 1 }];
  }],
  // "Put the rest on the bottom in a random order"
  [/^put the rest on the bottom(?: of your library)?(?: in a random order| in any order)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'bottom' }];
  }],
  // "for each kind of counter on target permanent, put another counter of that kind on it" — proliferate, spelled out.
  [/^for each kind of counter on (target permanent(?: or player)?|it|that permanent), (?:put another counter of that kind on it(?: or remove one from it)?|give that permanent or player another counter of that kind)$/i, (m, ctx) => {
    if (/^target/i.test(m[1])) objRef('target permanent', ctx);
    return [{ kind: 'proliferate' }];
  }],
  // "~ gets +3/-1 until end of turn and can attack this turn as though it didn't have defender"
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)? and can attack(?: this turn)? as though it (?:didn't|did not) have defender$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [
      { kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' },
    ];
  }],
  // Extra combat
  [/^(?:after this main phase, there is an additional combat phase followed by an additional main phase|untap all creatures you control\. after this phase, there is an additional combat phase)$/i, () => [{ kind: 'untap', what: { ref: 'all', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' } } }, { kind: 'extraCombat' }]],
  // Play from exile
  [/^(?:you may (?:play|cast) (.+?) (?:this turn|until end of turn|for as long as (?:it remains|they remain) exiled))$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'playFromExile', what: ref, duration: /this turn|until end of turn/i.test(m[0]) ? 'thisTurn' : 'permanent' }] : null;
  }],
  [/^(?:you may cast|cast) (.+?) without paying (?:its|their) mana costs?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'may', effects: [{ kind: 'castWithoutPaying', what: ref }] }] : null;
  }],
  // Choices
  [/^choose any number of (.+)$/i, (m, ctx) => {
    const ch = chooseRef(`any number of ${m[1]}`, ctx);
    return ch ? ch.pre : null;
  }],
  [/^(you|that player|target player|target opponent|each opponent|its controller) skips? (?:your|their|his or her) next turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'skipTurn', who }] : null;
  }],
  // "Return an instant or sorcery card at random from your graveyard to your hand."
  [/^exile (?:a|an|(\w+)) (.+?) at random from (?:your|their) graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `rand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: n, key, random: true }, { kind: 'exile', what: { ref: 'chosen', key }, remember: 'exiled' }];
  }],
  [/^return (?:a|an|(\w+)) (.+?) at random from (your|that player's|their) graveyard to (?:your|their) hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || n === null) return null;
    const who: Ref = /^your$/i.test(m[3]) ? YOU : ctx.lastPlayer ?? YOU;
    return [{ kind: 'searchLibrary', who, filter: { ...noun.filter, zone: 'graveyard' }, zones: ['graveyard'], count: n, destination: 'hand', random: true }];
  }],
  // "Target creature becomes that type until end of turn." (after "choose a creature type")
  [/^(.+?) becomes? that type until end of turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'setSubtypes', on: ref, choose: 'creatureType', duration: 'endOfTurn' }];
  }],
  // "The next 1 damage that would be dealt to ~ this turn is dealt to target creature you control instead."
  [/^the next (\w+) damage that would be dealt to (~|it|you|equipped creature|enchanted creature) this turn is dealt to (.+?) instead$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const to = objRef(m[3], ctx) ?? playerRef(m[3], ctx);
    if (!to) return null;
    const victim = /^you$/i.test(m[2]) ? YOU : objRef(m[2], ctx) ?? SELF;
    return [{ kind: 'preventAll', to: 'all', toRef: victim, amount: n, effects: [{ kind: 'damage', amount: { kind: 'triggerAmount' }, to, source: SELF }] }];
  }],
  // "The next time a source of your choice would deal damage to target creature this turn, prevent that damage."
  [/^the next time (?:a source of your choice|a source of your choice|any source) would deal damage to (.+?) this turn, prevent that damage$/i, (m, ctx) => {
    const to = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    return to ? [{ kind: 'preventAll', to: 'all', toRef: to, once: true }] : null;
  }],
  // Ability words with fixed meanings whose reminder text is stripped.
  [/^recruit$/i, () => {
    const nonland = parseNoun('a nonland card');
    if (!nonland) return null;
    return [
      { kind: 'draw', amount: 1 },
      { kind: 'discard', amount: 1 },
      { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'lastDiscarded' }, filter: nonland.filter }, then: [{ kind: 'createToken', token: { name: 'Human Soldier', typeLine: 'Creature — Human Soldier', power: '1', toughness: '1', colors: ['W'] }, count: 1 }] },
    ];
  }],
  // "learn": the Lesson sideboard is not modelled, so only the discard-to-draw half applies.
  [/^learn$/i, () => [{ kind: 'may', effects: [{ kind: 'discard', amount: 1 }, { kind: 'draw', amount: 1 }] }]],
  // "It's an enchantment." / "It is a Spirit in addition to its other types."
  [/^(?:it|that permanent|that creature|that card) is (?:a|an) ([A-Za-z][\w' -]*?)(?: in addition to its other types)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const replace = !/in addition to/i.test(m[0]);
    const words = m[1].split(/\s+/).filter((w) => w.length);
    const types = words.filter((w) => /^(artifact|creature|enchantment|land|planeswalker|battle)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    if (!types.length && !subtypes.length) return null;
    if (replace && !types.length) return null;
    return [{ kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, setTypes: replace ? types : undefined, on: ref, duration: 'permanent' }];
  }],
  // "If that creature or planeswalker would die this turn, exile it instead."
  [/^if (?:that|the) (.+?) would die this turn, exile it instead$/i, (_m, ctx) => {
    const ref = ctx.lastObj;
    return ref ? [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'exileIfDies' }, duration: 'endOfTurn' }] : null;
  }],
  // "Up to two target creatures you control each deal damage equal to their power to target creature an opponent controls."
  [/^(.+?) (?:each )?deals? damage equal to their power to (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = a ? objRef(m[2], ctx) ?? playerRef(m[2], ctx) : null;
    if (!a || !b) return null;
    return [{ kind: 'forEach', over: a, effects: [{ kind: 'damage', amount: { kind: 'power', ref: { ref: 'iter' } as Ref }, to: b, source: { ref: 'iter' } as Ref }] }];
  }],
  // "it endures 3"
  [/^(~|it|that creature|equipped creature|enchanted creature|.+?) endures (\w+|X)$/i, (m, ctx) => {
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    const ref = /^(?:~|it)$/i.test(m[1]) ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'endure', on: ref, amount: n }] : null;
  }],
  // "Target opponent exiles a creature they control."
  [/^(.+?) exiles? (?:a|an|(\w+)) (.+?) (?:they|it|that player) controls?(?: of (?:their|its) choice)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || !noun || n === null) return null;
    return [{ kind: 'exileChoice', who, filter: { ...noun.filter, zone: 'battlefield' }, count: n }];
  }],
  // "Target player reveals a card at random from their hand."
  [/^(.+?) reveals? (?:a|an|(\w+)) cards? at random from (?:their|his or her|your) hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealRandomFromHand', who, count: n }];
  }],
  // "The owner of target nonland permanent puts it on their choice of the top or bottom of their library."
  [/^the owner of (.+?) puts it on (?:their|his or her) choice of the top or bottom of (?:their|his or her) library$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'topOrBottom', what: ref }] : null;
  }],
  // "Each player gains control of all nontoken permanents they own."
  [/^each player gains control of all (.+?) they own$/i, (m) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    return [{ kind: 'forEach', over: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, effects: [{ kind: 'gainControl', what: { ref: 'iter' }, who: { ref: 'ownerOf', of: { ref: 'iter' } }, duration: 'permanent' }] }];
  }],
  // "Put a card an opponent owns from exile into that player's graveyard."
  [/^put (?:a|an|(\w+)) (.+?) from exile into (?:that player's|their|its owner's) graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]} from exile`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || n === null) return null;
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: 'exile' }, count: n, key: 'fromExile' }, { kind: 'putIntoGraveyard', what: { ref: 'chosen', key: 'fromExile' } }];
  }],
  // "Another target creature you control cannot be blocked this turn except by Spirits."
  [/^(.+?) cannot be blocked this turn except by (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const by = parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (!ref || !by) return null;
    return [{ kind: 'applyRule', on: ref, rule: { kind: 'cantBeBlockedExceptBy', filter: { ...by.filter, zone: undefined } }, duration: 'endOfTurn' }];
  }],
  [/^choose a color$/i, () => [{ kind: 'chooseColor', key: 'color' }]],
  [/^choose a creature type(?: other than \w+)?$/i, () => [{ kind: 'chooseCreatureType', key: 'creatureType' }]],
  [/^choose a (?:basic )?land type$/i, () => [{ kind: 'chooseCreatureType', key: 'landType', pool: 'land' }]],
  [/^choose a card type$/i, () => [{ kind: 'chooseCreatureType', key: 'cardType', pool: 'cardType' }]],
  [/^exchange life totals with (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'exchangeLife', a: YOU, b: who }] : null;
  }],
  [/^(.+?) explores?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (ref) ctx.exploreRef = ref;
    return ref ? [{ kind: 'log', text: 'explored', event: 'explored', objectRef: ref }, { kind: 'revealTop', ifMatches: { types: ['Land'] }, then: [{ kind: 'putIntoHand', what: { ref: 'lastMoved' } }], else: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }, { kind: 'may', prompt: 'Put the revealed card into your graveyard?', effects: [{ kind: 'moveToZone', what: { ref: 'lastMoved' }, zone: 'graveyard' }] }] }] : null;
  }],
  [/^empower (\w+) (\w+)$/i, (m) => {
    const n = wordToNumber(m[2]);
    return n === null ? null : [{ kind: 'empower', token: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), amount: n }];
  }],
  [/^airbend (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'exile', what: ref, remember: 'airbended' }, { kind: 'playFromExile', what: { ref: 'chosen', key: 'airbended' }, duration: 'permanent', forCost: '{2}', owner: true }];
  }],
  [/^(that card|it) gains? flashback (\{[^}]+\})(?: until end of turn)? instead if (.+)$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    const cond = parseCondition(m[3], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, triggerHasPlayer: ctx.triggerHasPlayer });
    if (!cond || cond.kind === 'manual') return null;
    return [{ kind: 'conditional', if: cond, then: [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', forCost: m[2], fromGraveyard: true, exileAfter: true }] }];
  }],
  [/^(.+?) gains? flashback(?: (\{[^}]+\}))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', forCost: m[2], fromGraveyard: true, exileAfter: true }];
  }],
  // "Search target opponent's graveyard, hand, and library for any number of cards with the chosen name and exile them."
  [/^search (?:its controller's|that player's|target (player|opponent)'s) graveyard, hand, and library for (?:all|any number of|up to (?:\w+)) cards with the chosen name and exile them$/i, (m, ctx) => {
    ctx.targets.push({ description: `target ${m[1] ?? 'player'}`, kind: 'player', playerFilter: m[1] === 'opponent' ? 'opponent' : 'any' });
    const who: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastPlayer = who;
    return [{ kind: 'searchLibrary', who, filter: { nameIsChosen: 'cardName', zone: 'library' }, zones: ['library', 'graveyard'], count: 99, destination: 'exile', shuffle: true }];
  }],
  [/^(?:then )?search (?:its controller's|its owner's|that player's|target (?:player|opponent)'s) graveyard, hand, and library for (?:all|any number of|up to (?:\w+)) cards with (?:the same name as that (?:spell|card|land|creature|permanent)|that name) and exile them$/i, (m, ctx) => {
    void m;
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : { ref: 'controllerOf' as const, of: ctx.lastObj ?? { ref: 'stackTarget' as const } });
    const same = ctx.lastObj ?? { ref: 'stackTarget' as const };
    return [{ kind: 'searchLibrary', who, filter: { sameNameAs: same, zone: 'library' }, zones: ['library', 'graveyard'], count: 99, destination: 'exile', shuffle: true }];
  }],
  [/^venture into the dungeon$/i, () => [{ kind: 'ventureIntoDungeon' }]],
  [/^tap or untap (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'chooseMode', options: [{ text: 'Tap it', effects: [{ kind: 'tap', what: ref }] }, { text: 'Untap it', effects: [{ kind: 'untap', what: ref }] }], count: 1 }] : null;
  }],
  [/^(~|it|that creature|.+?) becomes (prepared|unprepared)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'setMemory', key: 'prepared', value: /^unprepared$/i.test(m[2]) ? 0 : 1, on: ref }] : null;
  }],
  [/^it becomes (day|night)$/i, (m) => [{ kind: 'setDayNight', to: m[1].toLowerCase() as 'day' | 'night' }]],
  [/^if it is neither day nor night, it becomes (day|night)(?: as ~ enters)?$/i, (m) => [{ kind: 'setDayNight', to: m[1].toLowerCase() === 'day' ? 'startDay' : 'startNight' }]],
  // Manifest / manifest dread / cloak
  [/^manifest(?: the top card of your library| the top (\w+|X) cards of your library)?$/i, (m, ctx) => {
    void ctx;
    const n = m[1] ? (m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1])) : 1;
    return n === null ? null : [{ kind: 'manifest', amount: n as Amount }];
  }],
  [/^manifest dread$/i, () => [{ kind: 'manifest', amount: 1, dread: true }]],
  [/^cloak the top card of your library$/i, () => [{ kind: 'manifest', amount: 1, ward: '{2}' }]],
  [/^(?:you may )?turn (~|it|that creature|that permanent|equipped creature|enchanted creature|.+?) face up$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const eff: Effect = { kind: 'turnFaceUp', what: ref };
    return /^you may /i.test(m[0]) ? [{ kind: 'may', effects: [eff] }] : [eff];
  }],
  [/^monstrosity (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'monstrosity', amount: n }];
  }],
  [/^flip a coin$/i, () => [{ kind: 'flipCoin', win: [] }]],
  // ---- Round 103 ----
  // "Target unblocked attacking creature becomes blocked."
  [/^(.+?) becomes blocked$/i, (m, ctx) => {
    const r = objRef(m[1], ctx);
    return r ? [{ kind: 'becomeBlocked', what: r }] : null;
  }],
  // "Return the top creature card of your graveyard to the battlefield."
  [/^return the top (.+?) of your graveyard to the battlefield( tapped)?$/i, (m) => {
    const noun = parseNoun(`the top ${m[1]} of your graveyard`);
    if (!noun) return null;
    return [{ kind: 'returnToBattlefield', what: { ref: 'all', filter: noun.filter }, tapped: m[2] ? true : undefined }];
  }],
  // "Each opponent who has three or more poison counters loses 3 life."
  [/^each opponent who has (\w+) or more (poison|experience|energy) counters loses (\w+) life$/i, (m) => {
    const n = wordToNumber(m[1]);
    const l = wordToNumber(m[3]);
    if (typeof n !== 'number' || typeof l !== 'number') return null;
    return [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'conditional', if: { kind: 'playerStat', stat: m[2].toLowerCase() as 'poison', ref: { ref: 'iter' }, op: '>=', value: n }, then: [{ kind: 'loseLife', amount: l, who: { ref: 'iter' } }] }] }];
  }],
  // "each opponent loses life equal to the life they lost this turn"
  [/^each opponent loses life equal to the life they lost this turn$/i, () => [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'loseLife', amount: { kind: 'playerTurnStat', key: 'lifeLostAmount', ref: { ref: 'iter' } }, who: { ref: 'iter' } }] }]],
  // "Add an amount of mana of that color equal to your devotion to that color." (after "Choose a color")
  [/^add an amount of mana of that color equal to your devotion to that color$/i, () => [{ kind: 'addMana', mana: 'chosenColor', amount: { kind: 'devotion', colors: [], chosenKey: 'color' } }]],
  // "~ deals damage to target spell's controller equal to that spell's mana value."
  [/^~ deals damage to target spell's controller equal to that spell's mana value$/i, (ctxm, ctx) => {
    void ctxm;
    ctx.targets.push({ description: 'target spell', kind: 'spell' });
    const slot = ctx.targets.length - 1;
    return [{ kind: 'damage', amount: { kind: 'manaValue', ref: { ref: 'target', slot } }, to: { ref: 'controllerOf', of: { ref: 'target', slot } } }];
  }],
  // "Artifacts you control become artifact creatures with base power and toughness 5/5 until end of turn."
  // "Forests you control become 2/3 creatures until end of turn."
  [/^(.+?) becomes? (\d+)\/(\d+) (?:(\w+) )?creatures?(?: with (.+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const types = ['Creature'];
    const subtypes: string[] = [];
    if (m[4]) {
      const extra = m[4].charAt(0).toUpperCase() + m[4].slice(1).toLowerCase();
      if (['Artifact', 'Enchantment', 'Land'].includes(extra)) types.unshift(extra);
      else if (/^[A-Z][a-z]+$/.test(m[4])) subtypes.push(m[4]);
      else return null;
    }
    const out: Effect[] = [
      { kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, on: ref, duration: 'endOfTurn' },
      { kind: 'setPT', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
    ];
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' });
    }
    return out;
  }],
  // "Exile the bottom card of target player's graveyard."
  [/^(exile|destroy|return) the (top|bottom) (.+?) of target (player|opponent)'s graveyard(?: to their hand)?$/i, (m, ctx) => {
    const inner = parseNoun(`a ${m[3]}`);
    if (!inner) return null;
    const who = playerRef(`target ${m[4]}`, ctx);
    if (!who) return null;
    const f: ObjectFilter = { ...inner.filter, zone: 'graveyard', ownerRef: who, custom: m[2].toLowerCase() === 'top' ? 'topOfGraveyard' : 'bottomOfGraveyard' };
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return [m[1].toLowerCase() === 'exile' ? { kind: 'exile', what: ref } : m[1].toLowerCase() === 'destroy' ? { kind: 'destroy', what: ref } : { kind: 'returnToHand', what: ref }];
  }],
  [/^(.+?) become (?:(\w+) )?creatures with base power and toughness (\d+)\/(\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const types = ['Creature'];
    if (m[2]) {
      const extra = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
      if (!['Artifact', 'Enchantment', 'Land'].includes(extra)) return null;
      types.unshift(extra);
    }
    return [
      { kind: 'addTypes', types, on: ref, duration: 'endOfTurn' },
      { kind: 'setPT', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "Target creature gains protection from the color of its controller's choice until end of turn."
  [/^(.+?) gains protection from the color of (its controller's|your|their) choice until end of turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const who: Ref | undefined = /its controller's/i.test(m[2]) ? { ref: 'controllerOf', of: ref } : undefined;
    return [
      { kind: 'chooseColor', key: 'protColor', who },
      { kind: 'grantKeywords', keywords: ['protection from the chosen color'], on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "put the cards in your hand on the bottom of your library in any order, then draw that many cards"
  [/^put the cards in your hand on the bottom of your library in any order, then draw that many cards$/i, () => [{ kind: 'shuffleHandIntoLibraryAndDraw', who: YOU, bottom: true }]],
  // "Then you may attach an Equipment you control to ~."
  [/^(?:then )?you may attach (?:a|an) (.+?) you control to (~|it|that creature|enchanted creature|equipped creature)$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[1]} you control`, ctx);
    const to = /^~$/.test(m[2]) ? SELF : objRef(m[2], ctx);
    if (!c || !to) return null;
    return [{ kind: 'may', effects: [...c.pre, { kind: 'attach', what: c.ref, to }] }];
  }],
  // "If target opponent has more cards in hand than you, draw cards equal to the difference."
  [/^if (that player|target opponent|target player|an opponent) has more cards in hand than you, draw cards equal to the difference$/i, (m, ctx) => {
    const who = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    if (!who) return null;
    return [{ kind: 'draw', amount: { kind: 'minus', a: { kind: 'handSize', ref: who }, b: { kind: 'handSize', ref: YOU } }, who: YOU }];
  }],
  // "This turn, each creature you control enters with an additional +1/+1 counter on it."
  [/^this turn, (?:each|all) (.+?) enters? with an additional ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on (?:it|them)$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: { ...noun.filter, zone: undefined }, counter: m[2], amount: 1 } }, duration: 'thisTurn' }];
  }],
  // "it gets -2/-1 until end of turn for each creature blocking it beyond the first"
  [/^(.+?) gets ([+-]\d+)\/([+-]\d+) until end of turn for each creature blocking it beyond the first$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const n: Amount = { kind: 'minus', a: { kind: 'count', filter: { blockingSource: true, zone: 'battlefield' } }, b: 1 };
    return [{ kind: 'pump', power: { kind: 'times', a: parseInt(m[2], 10), b: n }, toughness: { kind: 'times', a: parseInt(m[3], 10), b: n }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Exile ~ and target creature without flying that is attacking you."
  [/^exile ~ and (target .+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'exile', what: SELF }, { kind: 'exile', what: ref }];
  }],
  // Time travel / collect evidence as effects.
  [/^time travel$/i, () => [{ kind: 'timeTravel' }]],
  [/^time travel, then time travel$/i, () => [{ kind: 'timeTravel' }, { kind: 'timeTravel' }]],
  [/^collect evidence (\d+)$/i, (m) => [{ kind: 'collectEvidence', n: parseInt(m[1], 10) }]],
  // "Until your next end step, you may play that card." — the duration leads instead of trailing.
  [/^until (?:your next (?:end step|turn)|the beginning of your next upkeep|end of combat on your next turn|end of turn), ((?:you may )?(?:play|cast) (?:that card|those cards|it|them)(?: without paying (?:its|their) mana costs?)?)$/i, (m, ctx) => parseSentence(`${m[1]} this turn`, ctx)],
  // "Search your library for an Equipment card, put it onto the battlefield, attach it to a creature you control, then shuffle."
  [/^search your library for (?:a|an) (.+?), put it onto the battlefield, attach it to (.+?), then shuffle$/i, (m, ctx) => {
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1] : `a ${m[1]} card`);
    if (!noun) return null;
    const host = chooseRef(m[2], ctx);
    if (!host) return null;
    return [
      { kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'battlefield', shuffle: true },
      ...host.pre,
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host.ref },
    ];
  }],
  // "Return to the battlefield tapped all artifact and creature cards in your graveyard that were put there from the battlefield this turn."
  [/^return to (your hand|the battlefield)( tapped)? (all .+)$/i, (m, ctx) => {
    const noun = parseNoun(m[3]);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone && !f.zoneIn) f.zone = 'graveyard';
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return /hand/i.test(m[1])
      ? [{ kind: 'returnToHand', what: ref }]
      : [{ kind: 'returnToBattlefield', what: ref, tapped: m[2] ? true : undefined, controller: 'owner' }];
  }],
  // "return to your hand all creature cards in your graveyard that were put there from the battlefield this turn"
  // "Draw cards equal to the power of target creature you control."
  [/^(?:you )?draw cards equal to (?:the )?(power|toughness|mana value|loyalty) of (target .+?|~|it)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[2]) ? SELF : objRef(m[2], ctx);
    if (!ref) return null;
    const a: Amount = m[1].toLowerCase() === 'mana value' ? { kind: 'manaValue', ref } : m[1].toLowerCase() === 'loyalty' ? { kind: 'countersOn', ref, counter: 'loyalty' } : { kind: m[1].toLowerCase() as 'power', ref };
    return [{ kind: 'draw', amount: a }];
  }],
  // "Draw another card if you've completed a dungeon."
  [/^draw another card$/i, () => [{ kind: 'draw', amount: 1 }]],
  // "Each opponent chooses a creature card in their graveyard."
  [/^each (player|opponent) chooses (?:a|an) (.+?) in their graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const key = `pick_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'graveyard', ownerRef: { ref: 'iter' } }, count: 1, key }] }];
  }],
  // "You lose all poison counters." / "Target player loses all rad counters."
  [/^(?:you )?loses? all ([\w'-]+) counters$/i, (m) => [{ kind: 'loseAllCounters', counter: m[1].toLowerCase(), who: YOU }]],
  // "You skip your next draw step." / "Target player skips their next combat phase this turn."
  [/^(?:you )?skips? (?:your|their) next (untap|upkeep|draw|combat|end|first main|second main) (?:step|phase)(?: this turn)?$/i, (m) => [{ kind: 'skipStep', step: m[1].toLowerCase().replace(/ /g, ''), who: YOU }]],
  // "Target player takes two extra turns after this one."
  [/^(?:you )?takes? (\w+) extra turns? after this one$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const out: Effect[] = [];
    for (let i = 0; i < n; i++) out.push({ kind: 'extraTurn', who: YOU });
    return out;
  }],
  // "You gain X plus 3 life." / "Target player gains twice X life."
  [/^(?:you )?gains? (.+?) life$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a === null ? null : [{ kind: 'gainLife', amount: a, who: YOU }];
  }],
  [/^(?:you )?loses? (.+?) life$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a === null ? null : [{ kind: 'loseLife', amount: a, who: YOU }];
  }],
  // "Triple target creature's power and toughness until end of turn."
  [/^(double|triple) (.+?)'s power and toughness(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    const f = /triple/i.test(m[1]) ? 2 : 1;
    return [{ kind: 'pump', power: { kind: 'times', a: f, b: { kind: 'power', ref } }, toughness: { kind: 'times', a: f, b: { kind: 'toughness', ref } }, on: ref, duration: 'endOfTurn' }];
  }],
  // "That creature cannot block this combat."
  [/^(.+?) cannot (block|attack|attack or block) (?:this combat|this turn)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const kinds: ('cantAttack' | 'cantBlock')[] = /attack or block/i.test(m[2]) ? ['cantAttack', 'cantBlock'] : /attack/i.test(m[2]) ? ['cantAttack'] : ['cantBlock'];
    return kinds.map((k) => ({ kind: 'applyRule' as const, rule: { kind: k }, on: ref, duration: 'endOfTurn' as const }));
  }],
  // "That creature explores, then it explores again."
  [/^(.+?) explores, then it explores again$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'explore', what: ref }, { kind: 'explore', what: ref }];
  }],
  // "That spell's controller may draw a card."
  [/^(?:that|the) (?:spell|permanent|creature|card)'s (controller|owner) (.+)$/i, (m, ctx) => {
    const who: Ref = m[1].toLowerCase() === 'controller' ? { ref: 'controllerOf', of: ctx.lastObj ?? { ref: 'stackTarget' } } : { ref: 'ownerOf', of: ctx.lastObj ?? { ref: 'stackTarget' } };
    const prev = ctx.lastPlayer;
    ctx.lastPlayer = who;
    const inner = parseSentence(`that player ${m[2]}`, ctx);
    ctx.lastPlayer = prev;
    return inner;
  }],
  // "You get an additional poison counter." / "That player gets a rad counter."
  [/^(?:you )?gets? (?:an additional|a|an|(\w+)) ([\w'-]+) counters?$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'addCounters', counter: m[2].toLowerCase(), amount: n, on: YOU }];
  }],
  // "That player flips a coin."
  [/^(?:you )?flips? a coin$/i, () => [{ kind: 'flipCoin', win: [] }]],
  // "Sacrifice ~ unless you remove a +1/+1 counter from it." / "unless any player pays {3}"
  [/^sacrifice (~|it|that creature|that permanent) unless (you|any player|its controller|that player) (.+)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const who = playerRef(m[2] === 'any player' ? 'each player' : m[2], ctx);
    if (!who) return null;
    const pay = m[3].match(/^pays? ((?:\{[^}]+\})+|\d+ life)$/i);
    const sac: Effect[] = [{ kind: 'sacrifice', what: ref }];
    if (pay) {
      const lm = pay[1].match(/^(\d+) life$/i);
      const eff: Effect = lm ? { kind: 'unlessPays', who, cost: { payLife: parseInt(lm[1], 10) }, effects: sac } : { kind: 'unlessPays', who, cost: pay[1], effects: sac };
      return [eff];
    }
    const spec = parseCost(m[3].replace(/^[a-z]/, (c) => c.toUpperCase()));
    if (!spec) return null;
    if (spec.mana) { const e2: Effect = { kind: 'unlessPays', who, cost: spec.mana, effects: sac }; return [e2]; }
    if (spec.payLife !== undefined && typeof spec.payLife === 'number') { const e2: Effect = { kind: 'unlessPays', who, cost: { payLife: spec.payLife }, effects: sac }; return [e2]; }
    if (spec.sacrifice) { const e2: Effect = { kind: 'unlessPays', who, cost: { sacrifice: spec.sacrifice.filter, count: typeof spec.sacrifice.count === 'number' ? spec.sacrifice.count : 1 }, effects: sac }; return [e2]; }
    if (spec.discard && typeof spec.discard === 'object') { const e2: Effect = { kind: 'unlessPays', who, cost: { discard: typeof spec.discard.count === 'number' ? spec.discard.count : 1, random: spec.discard.random, filter: spec.discard.filter }, effects: sac }; return [e2]; }
    if (spec.mill !== undefined) { const e2: Effect = { kind: 'unlessPays', who, cost: { discard: spec.mill }, effects: sac }; return [e2]; }
    return null;
  }],
  // "Counter target spell unless its controller discards their hand."
  [/^counter (target .+?) unless (?:its controller|that player|they|the controller|that spell's controller) (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const who: Ref = { ref: 'controllerOf', of: ref };
    const body = m[2].trim();
    const counter: Effect[] = [{ kind: 'counterSpell', what: ref }];
    const pay = body.match(/^pays? ((?:\{[^}]+\})+)$/i);
    if (pay) { const e2: Effect = { kind: 'unlessPays', who, cost: pay[1], effects: counter }; return [e2]; }
    const life = body.match(/^pays? (\d+) life$/i);
    if (life) { const e2: Effect = { kind: 'unlessPays', who, cost: { payLife: parseInt(life[1], 10) }, effects: counter }; return [e2]; }
    if (/^discards their hand$/i.test(body)) { const e2: Effect = { kind: 'unlessPays', who, cost: { discard: 99 }, effects: counter }; return [e2]; }
    const sac = body.match(/^sacrifices (?:a|an) (.+)$/i);
    if (sac) {
      const noun = parseNoun(`a ${sac[1]}`);
      if (!noun) return null;
      const e2: Effect = { kind: 'unlessPays', who, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' }, count: 1 }, effects: counter };
      return [e2];
    }
    return null;
  }],
  // ---- Round 145 ----
  // "Search your graveyard, hand, and/or library for an Aura card and put it onto the battlefield attached to ~."
  [/^search your ((?:library|graveyard|hand)(?:(?:,|,? and|,? and\/or|,? or|\/or) (?:your )?(?:library|graveyard|hand))*) for (?:a|an) (.+?)(?:, reveal (?:it|that card),?)?(?:,? and| then)? put (?:it|that card) onto the battlefield attached to (.+?)(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const zones = [...new Set((m[1].match(/library|graveyard|hand/gi) ?? []).map((z) => z.toLowerCase()))] as ('library' | 'graveyard' | 'hand')[];
    const noun = parseNoun(/\bcards?\b/i.test(m[2]) ? m[2].replace(/ cards$/i, ' card') : `${m[2]} card`);
    const host = /^~$/.test(m[3].trim()) ? SELF : objRef(m[3], ctx);
    if (!noun || !host || !zones.length) return null;
    const f = { ...noun.filter };
    delete f.zone;
    const key = 'searchedAttach';
    return [
      { kind: 'searchLibrary', filter: f, count: 1, destination: 'hold', key, reveal: true, shuffle: true, zones },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'battlefield' },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host },
    ];
  }],
  // "Put an Aura or Equipment card from your hand or graveyard onto the battlefield attached to ~."
  [/^(?:you may )?put (?:a|an) (.+?) from your (hand|graveyard|hand or graveyard|graveyard or hand) onto the battlefield attached to (.+?)$/i, (m, ctx) => {
    const zones: ('hand' | 'graveyard')[] = /hand or graveyard|graveyard or hand/i.test(m[2]) ? ['hand', 'graveyard'] : /graveyard/i.test(m[2]) ? ['graveyard'] : ['hand'];
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1].replace(/ cards$/i, ' card') : `${m[1]} card`);
    const host = /^~$/.test(m[3].trim()) ? SELF : objRef(m[3], ctx);
    if (!noun || !host) return null;
    const f = { ...noun.filter, zone: zones.length === 1 ? zones[0] : zones, owner: 'you' as const };
    const key = 'handAttach';
    return [
      { kind: 'chooseObjects', who: YOU, filter: f, count: 1, key, upTo: true },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'battlefield' },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host },
    ];
  }],
  // ---- Round 143 ----
  // "You may draw up to three cards."
  [/^(?:(.+?) )?draws? up to (\w+|X) cards?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer ?? YOU;
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    return [{ kind: 'may', who, effects: [{ kind: 'draw', amount: n as Amount, who }] }];
  }],
  // "That player puts a creature card from their hand onto the battlefield."
  [/^(.+?) puts? (?:a|an|(\w+)) (.+?) from their (hand|graveyard) (onto the battlefield|into their hand)( tapped)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || !noun || !noun.confident || typeof n !== 'number') return null;
    const key = `plrPut${ctx.targets.length}`;
    const zone = m[4].toLowerCase() === 'hand' ? 'hand' : 'graveyard';
    const eff: Effect[] = [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone, ownerRef: who }, count: n, key, upTo: true }];
    eff.push(/battlefield/i.test(m[5]) ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'owner', tapped: !!m[6] } : { kind: 'putIntoHand', what: { ref: 'chosen', key } });
    return eff;
  }],
  // "That player returns a creature card from their graveyard to the battlefield."
  [/^(.+?) returns? (?:a|an|(\w+)) (.+?) from their graveyard to (the battlefield|their hand)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || !noun || !noun.confident || typeof n !== 'number') return null;
    const key = `plrRet${ctx.targets.length}`;
    const eff: Effect[] = [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'graveyard', ownerRef: who }, count: n, key, upTo: true }];
    eff.push(/battlefield/i.test(m[4]) ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'owner' } : { kind: 'putIntoHand', what: { ref: 'chosen', key } });
    return eff;
  }],
  // "Put it into its owner's library third from the top."
  [/^(?:(.+?) )?puts? (.+?) into (?:its owner's|their|your|that player's) library (\w+) from the top$/i, (m, ctx) => {
    const ORD: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9 };
    const depth = ORD[m[3].toLowerCase()];
    if (depth === undefined) return null;
    const ref = objRef(m[2], ctx) ?? (/^~$/.test(m[2].trim()) ? SELF : null);
    if (!ref) return null;
    return [{ kind: 'putOnLibrary', what: ref, position: depth === 0 ? 'top' : depth === 1 ? 'secondFromTop' : 'top', depth }];
  }],
  // "Each other player may draw up to three cards."
  [/^each other player may (.+)$/i, (m, ctx) => {
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(`that player ${m[1]}`, sub) ?? parseSentence(m[1], sub);
    if (!inner) return null;
    return [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'may', who: { ref: 'iter' }, effects: inner }] }];
  }],
  // "Each opponent sacrifices a tenth of the creatures they control of their choice, rounded up."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?sacrifices? (half|a third|a quarter|a tenth) (?:of )?the (.+?) (?:they|you) control of (?:their|your) choice(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    const noun = parseNoun(`a ${m[3].replace(/s$/i, '')}`) ?? parseNoun(`a ${m[3]}`);
    if (!who || !noun || !noun.confident) return null;
    const round: 'up' | 'down' = m[4]?.toLowerCase() === 'up' ? 'up' : 'down';
    const by = m[2].toLowerCase() === 'half' ? 2 : m[2].toLowerCase() === 'a third' ? 3 : m[2].toLowerCase() === 'a quarter' ? 4 : 10;
    const filter: ObjectFilter = { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' };
    const n: Amount = { kind: 'count', filter };
    const count: Amount = by === 2 ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by, round };
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter, count }] }];
  }],
  // "Counter up to one target activated or triggered ability."
  [/^counter up to one target (activated or triggered|activated|triggered) ability$/i, (m, ctx) => {
    ctx.targets.push({ description: `target ${m[1]} ability`, kind: m[1].toLowerCase() === 'activated or triggered' ? 'activatedOrTriggered' : 'activatedOrTriggered', min: 0, max: 1 });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Counter target instant spell, sorcery spell, activated ability, or triggered ability."
  [/^counter target (?:instant spell, sorcery spell, activated ability, or triggered ability|spell or ability)$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target spell or ability', kind: 'spellOrAbility', min: 1, max: 1 });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Create half X Food tokens, rounded up."
  [/^create (half|a third) (X|\w+) (.+? tokens?(?: with .+)?)(?:, rounded (up|down))?$/i, (m) => {
    const tok = parseTokenPhrase(`a ${m[3].replace(/ tokens\b/i, ' token')}`);
    if (!tok) return null;
    const base: Amount = m[2].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[2]) as Amount);
    if (base === null) return null;
    const round: 'up' | 'down' = m[4]?.toLowerCase() === 'up' ? 'up' : 'down';
    const count: Amount = m[1].toLowerCase() === 'half' ? { kind: 'half', a: base, round } : { kind: 'divide', a: base, by: 3, round };
    return [{ kind: 'createToken', token: tok.token, count }];
  }],
  // ---- Round 141 ----
  // "The next time a black or red source of your choice would deal damage this turn, prevent that damage."
  [/^the next time (.+?) would deal (combat |noncombat )?damage(?: to (.+?))?(?: this turn)?, (?:prevent that damage|prevent all of that damage)$/i, (m, ctx) => {
    const src = preventionSource(m[1], ctx);
    if (!src) return null;
    const dst = m[3] ? preventionTo(m[3], ctx) : { to: 'all' as const };
    if (!dst) return null;
    return [{ kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, once: true, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined }];
  }],
  // "The next time damage would be dealt to target creature this turn, prevent that damage."
  [/^the next time (combat |noncombat )?damage would be dealt to (.+?)(?: this turn)?, prevent (?:that damage|all of that damage)$/i, (m, ctx) => {
    const dst = preventionTo(m[2], ctx);
    if (!dst) return null;
    return [{ kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, once: true, combat: m[1] && /^combat/i.test(m[1]) ? true : undefined }];
  }],
  // "The next time a source of your choice would deal damage to you this turn, that damage is dealt to ~ instead."
  [/^the next time (.+?) would deal (combat |noncombat )?damage(?: to (.+?))?(?: this turn)?, (?:instead )?(?:that damage|that source deals that (?:much )?damage|that spell deals that damage|that creature deals that damage|that source deals that damage)(?: is dealt)? to (.+?)(?: instead)?$/i, (m, ctx) => {
    const src = preventionSource(m[1], ctx);
    if (!src) return null;
    const dst = m[3] ? preventionTo(m[3], ctx) : { to: 'all' as const };
    if (!dst) return null;
    const spec: Effect = { kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, once: true, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined };
    const target = m[4].trim();
    if (/^(?:its|that source's|that spell's|that creature's) controller$/i.test(target)) spec.redirectToSourceController = true;
    else if (/^itself$/i.test(target) && src.sourceRef) spec.redirectTo = src.sourceRef;
    else {
      const r = anyRef(target, ctx);
      if (!r) return null;
      spec.redirectTo = r;
    }
    return [spec];
  }],
  // "The next time damage would be dealt to ~ and/or you this turn, that damage is dealt to any target instead."
  [/^the next time (combat |noncombat )?damage would be dealt to (.+?)(?: this turn)?, that damage is dealt to (.+?) instead$/i, (m, ctx) => {
    const dst = preventionTo(m[2], ctx);
    if (!dst) return null;
    const spec: Effect = { kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, once: true, combat: m[1] && /^combat/i.test(m[1]) ? true : undefined };
    const r = anyRef(m[3], ctx);
    if (!r) return null;
    spec.redirectTo = r;
    return [spec];
  }],
  // "The next 2 damage that a source of your choice would deal to you and/or permanents you control this turn is dealt to ~ instead."
  [/^the next (\d+|X) (combat |noncombat )?damage that (.+?) would deal to (.+?)(?: this turn)? is dealt to (.+?) instead$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? undefined : parseInt(m[1], 10);
    const src = preventionSource(m[3], ctx);
    const dst = preventionTo(m[4], ctx);
    if (!src || !dst) return null;
    const spec: Effect = { kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, amount: n, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined };
    const r = anyRef(m[5], ctx);
    if (!r) return null;
    spec.redirectTo = r;
    return [spec];
  }],
  // "Prevent the next 3 damage that a source of your choice would deal to you and/or permanents you control this turn."
  [/^prevent the next (\d+|X) (combat |noncombat )?damage that (.+?) would deal to (.+?)(?: this turn)?$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? undefined : parseInt(m[1], 10);
    const src = preventionSource(m[3], ctx);
    const dst = preventionTo(m[4], ctx);
    if (!src || !dst) return null;
    return [{ kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, amount: n, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined }];
  }],
  // "The next time you would draw a card this turn, you gain 5 life instead."
  [/^the next time you would draw a card this turn, (?:instead )?(.+?)(?: instead)?$/i, (m, ctx) => {
    const pe = parseEffects(m[1], newCtx({ ...ctx, targets: ctx.targets }));
    if (pe.unhandled.length || !pe.effects.length) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'drawReplacement', data: { effects: pe.effects, once: true } } }];
  }],
  // ---- Round 140 ----
  // "Return to their owners' hands all creatures with toughness 2 or less."
  [/^return to (?:their owners'|its owner's|your|their) hands? (all .+|each .+)$/i, (m, ctx) => parseSentence(`return ${m[1]} to their owners' hands`, ctx)],
  // "Return two target creature cards that share a creature type from your graveyard to your hand."
  [/^return (\w+) target (.+?) that share (?:a|an) (creature type|card type|colou?r) from your graveyard to (your hand|the battlefield)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (typeof n !== 'number' || !noun) return null;
    ctx.targets.push({ description: `target ${m[2]} from your graveyard`, kind: 'object', filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, min: n, max: n, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return /your hand/i.test(m[4]) ? [{ kind: 'returnToHand', what: ref }] : [{ kind: 'returnToBattlefield', what: ref, controller: 'you' }];
  }],
  // "Return target creature card and all other cards with the same name as that card from your graveyard to your hand."
  [/^return (target .+?) and all other (.+?) with the same name as that \w+ from your graveyard to (your hand|the battlefield)$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} in your graveyard`, ctx) ?? objRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (!ref || !noun) return null;
    const others: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', owner: 'you', sameNameAs: ref, other: true } };
    return /your hand/i.test(m[3])
      ? [{ kind: 'returnToHand', what: ref }, { kind: 'returnToHand', what: others }]
      : [{ kind: 'returnToBattlefield', what: ref, controller: 'you' }, { kind: 'returnToBattlefield', what: others, controller: 'you' }];
  }],
  // "Return target nonland permanent and all other permanents with the same name as that permanent to their owners' hands."
  [/^return (target .+?) and (?:all other|each other) (.+?) with the same name as that \w+ to (?:their owners'|its owner's) hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (!ref || !noun) return null;
    return [
      { kind: 'returnToHand', what: ref },
      { kind: 'returnToHand', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', sameNameAs: ref, other: true } } },
    ];
  }],
  // "Return target commander you own from the battlefield to your hand."
  [/^return (target .+?) from the battlefield to (your hand|its owner's hand)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  // "Return that many creature cards from your graveyard to the battlefield."
  [/^return that many (.+?) from your graveyard to (the battlefield|your hand)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/s$/, '')}`);
    if (!noun) return null;
    const key = 'retGy';
    const eff: Effect[] = [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: { kind: 'triggerAmount' }, key, upTo: true }];
    eff.push(/the battlefield/i.test(m[2]) ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'you' } : { kind: 'returnToHand', what: { ref: 'chosen', key } });
    return eff;
  }],
  // "Return half the creatures they control to their owner's hand, rounded up."
  [/^return (half|a third) the (.+?) (?:they|you) control to (?:their|its) owners?'? hands?(?:, rounded (up|down))?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/s$/i, '')}`) ?? parseNoun(`a ${m[2]}`);
    const who = ctx.lastPlayer;
    if (!noun || !who) return null;
    const round: 'up' | 'down' = m[3]?.toLowerCase() === 'up' ? 'up' : 'down';
    const filter: ObjectFilter = { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' };
    const n: Amount = { kind: 'count', filter };
    const count: Amount = m[1].toLowerCase() === 'half' ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by: 3, round };
    const key = 'retHalf';
    return [{ kind: 'forEach', over: who, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter, count, key },
      { kind: 'returnToHand', what: { ref: 'chosen', key } },
    ] }];
  }],
  // ---- Round 139 ----
  // "Put target face-up exiled card into its owner's graveyard."
  [/^put (.+?) into (?:its|their) owners?'? graveyards?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx) ?? (/^(?:a|an|each) card exiled with ~$/i.test(m[1]) ? ({ ref: 'all', filter: { zone: 'exile', exiledWithSource: true } } as Ref) : null);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] : null;
  }],
  // "Put ~ and target creature on top of their owners' libraries, then those players shuffle their libraries."
  [/^put (.+?) on top of their owners'? libraries$/i, (m, ctx) => {
    const parts = m[1].split(/ and (?=~|target |each )/i).map((x) => x.trim()).filter(Boolean);
    const refs = parts.map((x) => (x === '~' ? SELF : objRef(x, ctx)));
    if (!refs.length || refs.some((r) => !r)) return null;
    return refs.map((r) => ({ kind: 'putOnLibrary' as const, what: r as Ref, position: 'top' as const }));
  }],
  // ---- Round 137 ----
  // "Prevent the next 3 damage that would be dealt to any target this turn by a source of your choice."
  [/^prevent the next (\d+|X) (combat |noncombat )?damage that would be dealt to (.+?)(?: this turn)?(?: by (.+?))?(?: this turn)?$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? null : parseInt(m[1], 10);
    let source: ObjectFilter | undefined;
    if (m[4] && !/^a source of your choice$/i.test(m[4])) {
      const st = m[4].replace(/\bsources\b/i, 'permanents').replace(/\bsource\b/i, 'permanent');
      const sn = parseNoun(st) ?? parseNoun(`a ${st}`);
      if (!sn) return null;
      source = { ...sn.filter, zone: undefined };
    }
    const spec: Effect = { kind: 'preventAll', to: 'all', combat: m[2] && /^combat/i.test(m[2]) ? true : undefined, source, amount: n ?? undefined };
    const l = m[3].trim().toLowerCase();
    if (l === 'you') spec.to = 'you';
    else if (l === 'you and/or permanents you control' || l === 'you and permanents you control' || l === 'you and/or creatures you control' || l === 'you and creatures you control') spec.to = 'youAndCreaturesYouControl';
    else if (l === 'any target') spec.to = 'all';
    else {
      const ref = anyRef(m[3], ctx);
      if (!ref) return null;
      spec.toRef = ref;
    }
    if (n === null) spec.amount = undefined;
    return [spec];
  }],
  // "The next 1 damage that would be dealt to target creature this turn is dealt to another target creature instead."
  [/^the next (\d+|X) (combat |noncombat )?damage that would be dealt(?: this turn)? to (.+?)(?: this turn)? is dealt to (.+?) instead$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? undefined : parseInt(m[1], 10);
    const toRef = anyRef(m[3], ctx);
    if (!toRef) return null;
    const redirectTo = /^its controller$/i.test(m[4].trim()) ? null : anyRef(m[4], ctx);
    if (!redirectTo && !/^its controller$/i.test(m[4].trim())) return null;
    const spec: Effect = { kind: 'preventAll', to: 'all', toRef, amount: n, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined };
    if (redirectTo) spec.redirectTo = redirectTo;
    else spec.redirectToSourceController = true;
    return [spec];
  }],
  // "The next time a source of your choice would deal damage to you this turn, that damage is dealt to ~ instead."
  [/^the next time (?:(?:a|an) source of your choice|damage) would (?:deal damage to|be dealt to) (.+?) this turn, (?:that damage is dealt to|instead that source deals that much damage to) (.+?) instead$/i, (m, ctx) => {
    const toRef = anyRef(m[1], ctx);
    if (!toRef) return null;
    const redirectTo = /^its controller$/i.test(m[2].trim()) ? null : anyRef(m[2], ctx);
    const spec: Effect = { kind: 'preventAll', to: 'all', toRef, once: true };
    if (redirectTo) spec.redirectTo = redirectTo;
    else spec.redirectToSourceController = true;
    return [spec];
  }],
  // "Prevent all damage a source of your choice would deal to you this turn."
  [/^prevent all (combat |noncombat )?damage (?:a|an) source of your choice would deal to (.+?) this turn$/i, (m, ctx) => {
    const spec: Effect = { kind: 'preventAll', to: 'all', once: true, combat: m[1] && /^combat/i.test(m[1]) ? true : undefined };
    if (/^you$/i.test(m[2].trim())) spec.to = 'you';
    else {
      const ref = anyRef(m[2], ctx);
      if (!ref) return null;
      spec.toRef = ref;
    }
    return [spec];
  }],
  // "If a source you control would deal damage this turn, it deals double that damage instead."
  [/^if (.+?) would deal (?:(\d+) or more )?(combat |noncombat )?damage(?: this turn)?(?: to (.+?))?(?: this turn)?, (?:instead )?(?:it|that source|that spell|that creature|that permanent) deals (.+)$/i, (m) => {
    const srcSpec = damageSourceFilter(m[1]);
    const dest = m[4] ? damageDestFilter(m[4]) : {};
    const mod = damageModifier(m[5]);
    if (!srcSpec || srcSpec.selfOnly || !dest || dest.host || !mod || !/ this turn[, ]/i.test(m[0])) return null;
    const data: Record<string, unknown> = { ...srcSpec, ...dest, ...mod };
    delete data.host;
    if (m[2]) data.ifAtLeast = parseInt(m[2], 10);
    if (m[3] && /^combat/i.test(m[3])) data.combatOnly = true;
    if (m[3] && /^noncombat/i.test(m[3])) data.noncombatOnly = true;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'damageModify', data } }];
  }],
  // ---- Round 135 ----
  // "That player shuffles their hand into their library."
  [/^(.+?) shuffles? (?:their|his or her) (graveyard|hand)(?: and (?:their )?(graveyard|hand))? into (?:their|his or her) library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const zones = [m[2], m[3]].filter(Boolean).map((z) => (z.toLowerCase() === 'hand' ? 'hand' : 'graveyard')) as ('hand' | 'graveyard')[];
    return zones.map((z) => ({ kind: 'shuffleZoneIntoLibrary' as const, zone: z, who }));
  }],
  // "Exile X target cards from target player's graveyard." / "Exile up to twice X target cards from graveyards."
  [/^exile (?:up to )?(twice X|X|\w+) target cards? from (graveyards|a graveyard|.+?'s graveyard)$/i, (m, ctx) => {
    const isX = /X/i.test(m[1]);
    const n = isX ? null : wordToNumber(m[1]);
    if (!isX && typeof n !== 'number') return null;
    const pm = m[2].match(/^(target (?:player|opponent))'s graveyard$/i);
    let ownerRef: Ref | undefined;
    if (pm) {
      const who = playerRef(pm[1], ctx);
      if (!who) return null;
      ownerRef = who;
    }
    const base = pm || /^(?:graveyards|a graveyard)$/i.test(m[2]) ? parseNoun('a card in a graveyard') : parseNoun(`a card in ${m[2]}`);
    if (!base) return null;
    const spec = toTargetSpec(base);
    if (!spec) return null;
    if (ownerRef) spec.filter = { ...spec.filter, ownerRef };
    const upTo = /^exile up to /i.test(m[0]) || undefined;
    ctx.targets.push(isX
      ? { ...spec, countX: { times: /twice/i.test(m[1]) ? 2 : 1, upTo }, distinct: true }
      : { ...spec, min: upTo ? 0 : (n as number), max: n as number, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'exile', what: ref }];
  }],
  // "Choose a creature or planeswalker card in that player's graveyard."
  [/^(?:you )?choose (?:a|an|(\w+)) (.+? (?:in|from) (?:a graveyard|graveyards|[\w' ]+?'s graveyard|your graveyard))$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun || !noun.confident || typeof n !== 'number') return null;
    const key = 'chosenCards';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: noun.filter, count: n, key }];
  }],
  // "Exile all cards from target player's hand and graveyard." / "... from all hands and graveyards."
  [/^exile all (.+?) from (all hands and graveyards|.+?'s hand and graveyard|.+? hand and graveyard)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/ cards$/i, ' card').replace(/^cards$/i, 'card')}`);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter, zone: ['hand', 'graveyard'] };
    if (!/^all hands/i.test(m[2])) {
      const who = playerRef(m[2].replace(/'s hand and graveyard$/i, '').replace(/ hand and graveyard$/i, ''), ctx);
      if (!who) return null;
      f.ownerRef = who;
    }
    return [{ kind: 'exile', what: { ref: 'all', filter: f } }];
  }],
  // "Exile all cards from target player's library, then that player shuffles their hand into their library."
  [/^exile all cards from (.+?)'s library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'exile', what: { ref: 'all', filter: { zone: 'library', ownerRef: who } } }] : null;
  }],
  // "Exile all the cards from your hand, then draw that many cards."
  [/^exile all (?:the )?cards from your hand, then draw that many cards$/i, () => [
    { kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', owner: 'you' } } },
    { kind: 'draw', amount: { kind: 'ctxMemory', key: 'lastMoved' } },
  ]],
  // "For each color, return up to one target card of that color from your graveyard to your hand."
  [/^for each (color|permanent type), return up to one (?:target )?(.*?)card of that (?:color|type) from your graveyard to (your hand|the battlefield)$/i, (m) => {
    const extra = m[2].trim() ? parseNoun(`a ${m[2].trim()} card`) : null;
    if (m[2].trim() && (!extra || !extra.confident)) return null;
    const groups: ObjectFilter[] = /color/i.test(m[1])
      ? (['W', 'U', 'B', 'R', 'G'] as Color[]).map((c) => ({ colors: [c] }))
      : ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].map((t) => ({ types: [t] }));
    const key = 'byGroup';
    const effects: Effect[] = groups.map((gf) => ({
      kind: 'chooseObjects',
      who: YOU,
      filter: { ...(extra ? { ...extra.filter } : {}), ...gf, zone: 'graveyard', owner: 'you' },
      count: 1,
      key,
      upTo: true,
    }));
    effects.push(/your hand/i.test(m[3]) ? { kind: 'returnToHand', what: { ref: 'chosen', key } } : { kind: 'returnToBattlefield', what: { ref: 'chosen', key } });
    return effects;
  }],
  // ---- Round 134 ----
  // "Each player discards all the cards in their hand, then creates that many 2/2 black Zombie creature tokens."
  [/^each (player|opponent) discards (?:all the cards in their hand|their hand), then creates that many (.+? tokens?(?: with .+)?)$/i, (m) => {
    const tok = parseTokenPhrase(`a ${m[2].replace(/ tokens\b/i, ' token')}`);
    if (!tok) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [
      { kind: 'discard', amount: 'hand', who: { ref: 'iter' } },
      { kind: 'createToken', token: tok.token, count: { kind: 'ctxMemory', key: 'discardedCount' }, who: { ref: 'iter' } },
    ] }];
  }],
  // "Each opponent loses all counters."
  [/^(each player|each opponent|you|that player|they|target player|target opponent) loses? all counters$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'loseAllCounters', counter: 'all', who }] : null;
  }],
  // "Each player discards half the cards in their hand, rounded down."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?discards? (half|a third|a quarter) (?:of )?the cards in (?:their|your) hand(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    if (!who) return null;
    const round: 'up' | 'down' = m[3]?.toLowerCase() === 'up' ? 'up' : 'down';
    const n: Amount = { kind: 'handSize', ref: { ref: 'iter' } };
    const amount: Amount = m[2].toLowerCase() === 'half' ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by: m[2].toLowerCase() === 'a third' ? 3 : 4, round };
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'discard', amount, who: { ref: 'iter' } }] }];
  }],
  // "Each player sacrifices half the creatures they control, rounded down."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?sacrifices? (half|a third|a quarter) (?:of )?the (.+?) (?:they|you) control(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    const noun = parseNoun(`a ${m[3].replace(/s$/i, '')}`) ?? parseNoun(`a ${m[3]}`);
    if (!who || !noun || !noun.confident) return null;
    const round: 'up' | 'down' = m[4]?.toLowerCase() === 'up' ? 'up' : 'down';
    const filter: ObjectFilter = { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' };
    const n: Amount = { kind: 'count', filter };
    const count: Amount = m[2].toLowerCase() === 'half' ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by: m[2].toLowerCase() === 'a third' ? 3 : 4, round };
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter, count }] }];
  }],
  // "Each player loses a third of their life."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?loses? (a third|a quarter) of (?:their|your) life(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    if (!who) return null;
    const round: 'up' | 'down' = m[3]?.toLowerCase() === 'up' ? 'up' : 'down';
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'loseLife', amount: { kind: 'divide', a: { kind: 'life', ref: { ref: 'iter' } }, by: m[2].toLowerCase() === 'a third' ? 3 : 4, round }, who: { ref: 'iter' } }] }];
  }],
  // "Each opponent chooses two cards in their graveyard and exiles the rest."
  [/^each (player|opponent) chooses (?:up to )?(\w+) (.+?) (they control|in their graveyard|in their hand)(?:, then | and )(sacrifices|exiles|discards) (?:the rest|all (?:the )?others|all other .+)$/i, (m) => {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${m[3].replace(/s$/i, '')}`) ?? parseNoun(`a ${m[3]}`);
    if (!noun || !noun.confident || typeof n !== 'number') return null;
    const where = m[4].toLowerCase();
    const base: ObjectFilter = where === 'they control'
      ? { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }
      : { ...noun.filter, ownerRef: { ref: 'iter' }, zone: where === 'in their graveyard' ? 'graveyard' : 'hand' };
    const key = `keep_${m[5].toLowerCase()}_${n}`;
    const rest: Ref = { ref: 'all', filter: { ...base, notChosenKey: key } };
    const act = m[5].toLowerCase();
    const doIt: Effect = act === 'sacrifices' ? { kind: 'sacrifice', what: rest } : act === 'exiles' ? { kind: 'exile', what: rest } : { kind: 'discardObjects', what: rest };
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter: base, count: n, key, upTo: true },
      doIt,
    ] }];
  }],
  // "Each player chooses from among the permanents they control an artifact, a creature, an enchantment, and a land, then sacrifices the rest."
  [/^each (player|opponent) chooses (?:from among |from )(?:the )?(.+?) they control ((?:a|an) .+?), then (sacrifices|exiles) the rest$/i, (m) => buildKeepList(m[1], m[2], m[3], m[4])],
  // "Each opponent chooses an artifact, a creature, an enchantment, and a planeswalker from among the nonland permanents they control, then sacrifices the rest."
  [/^each (player|opponent) chooses ((?:a|an) .+?) from among (?:the )?(.+?) they control, then (sacrifices|exiles) the rest$/i, (m) => buildKeepList(m[1], m[3], m[2], m[4])],
  // "Each player chooses a land they control of each basic land type, then sacrifices the rest."
  [/^each (player|opponent) chooses (?:from )?(?:the )?(?:a |an )?(.+?) they control of each basic land type, then (sacrifices|exiles) the rest$/i, (m) => buildKeepList(m[1], m[2], 'a Plains, an Island, a Swamp, a Mountain, and a Forest', m[3])],
  // "Each player sacrifices an artifact, a creature, an enchantment, a land, and a planeswalker of their choice."
  [/^each (player|opponent) (sacrifices|exiles) ((?:a|an) [\w -]+(?:, (?:a|an) [\w -]+)*,? and (?:a|an) [\w -]+)(?: of (?:their|its) choice)?$/i, (m) => {
    const items = splitItemList(m[3]);
    const nouns = items.map((x) => parseNoun(x));
    if (!nouns.length || nouns.some((n) => !n || !n.confident)) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const effects: Effect[] = nouns.map((n) => ({ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter: { ...n!.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, count: 1 }));
    return [{ kind: 'forEach', over, effects }];
  }],
  // "Each player returns all black and all red creature cards from their graveyard to the battlefield."
  [/^each (player|opponent) returns all (.+?) and all (.+?) cards? from their graveyard to the battlefield$/i, (m) => {
    const a = parseNoun(`a ${m[2]} card`);
    const b = parseNoun(`a ${m[3]} card`);
    if (!a || !b || !a.confident || !b.confident) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const filter: ObjectFilter = { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }], ownerRef: { ref: 'iter' }, zone: 'graveyard' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'returnToBattlefield', what: { ref: 'all', filter }, controller: 'owner' }] }];
  }],
  // ---- Round 131 ----
  // "Return ~ and target creature you control to their owner's hand."
  [/^return ~ and (.+?) to (?:their|its) owners?'? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'returnToHand', what: SELF }, { kind: 'returnToHand', what: ref }];
  }],
  // "Return ~ from your graveyard to the battlefield transformed."
  [/^return ~ from (?:your graveyard|exile|your graveyard or from exile) to the battlefield( tapped)?( transformed)?$/i, (m) => [
    { kind: 'returnToBattlefield', what: SELF, tapped: m[1] ? true : undefined, transformed: m[2] ? true : undefined },
  ]],
  // "Put ~ from exile onto the battlefield tapped." / "Put ~ onto the battlefield from the command zone."
  [/^put ~ (?:from (?:exile|your graveyard|your hand|the command zone) )?onto the battlefield( tapped)?( and attacking)?( transformed)?(?: from the command zone)?$/i, (m) => [
    { kind: 'returnToBattlefield', what: SELF, tapped: m[1] ? true : undefined, attacking: m[2] ? true : undefined, transformed: m[3] ? true : undefined },
  ]],
  // "Shuffle a card from your hand into your library."
  [/^shuffle (?:a|an|(\w+)) cards? from your hand into your library$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'handToLibrary', count: n, shuffle: true }];
  }],
  // "Shuffle your graveyard and hand into your library, then draw seven cards."
  [/^shuffle your (graveyard|hand)(?: and (graveyard|hand))? into your library$/i, (m) => {
    const zones = [m[1], m[2]].filter(Boolean).map((z) => (z === 'hand' ? 'hand' : 'graveyard')) as ('hand' | 'graveyard')[];
    return zones.map((z) => ({ kind: 'shuffleZoneIntoLibrary' as const, zone: z, who: YOU }));
  }],
  [/^shuffle ~ into your library(?: from your graveyard)?$/i, () => [{ kind: 'moveToZone', what: SELF, zone: 'library' }, { kind: 'shuffle' }]],
  // "Put the bottom card of your library into your graveyard."
  [/^put the bottom card of your library into your graveyard$/i, () => [{ kind: 'millBottom', amount: 1, who: YOU }]],
  // "Put the top card of your graveyard on the bottom of your library."
  [/^put the top card of your graveyard on the bottom of your library$/i, () => [{ kind: 'moveToZone', what: { ref: 'all', filter: { zone: 'graveyard', owner: 'you', custom: 'topOfGraveyard' } }, zone: 'library', position: 'bottom' }]],
  // "Put that card on top of that player's library."
  [/^put (?:that card|it|them|those cards) on (?:top|the bottom) of (?:that player's|its owner's|their owner's|your) library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'library', position: /bottom/i.test(m[0]) ? 'bottom' : 'top' }];
  }],
  // "Put a card exiled with ~ into its owner's graveyard."
  [/^put (?:a|an|(\w+)|all|target) (?:cards?|face-up exiled cards?) exiled with ~ into (?:its|their) owners?'? graveyards?$/i, () => [
    { kind: 'moveToZone', what: { ref: 'all', filter: { exiledWithSource: true, zone: 'exile' } }, zone: 'graveyard' },
  ]],
  // "Remove any number of counters from target creature you control."
  [/^remove any number of ([+-]\d+\/[+-]\d+|[\w'-]+ )?counters? from (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    return [{ kind: 'removeCounters', counter: (m[1] ?? 'any').trim(), amount: 'all', on: ref, upTo: true }];
  }],
  // "Spells with the chosen name cost {3} more to cast."
  [/^spells with the chosen name cost \{(\d+)\} (less|more) to cast(?: this turn)?$/i, (m) => [
    { kind: 'grantPlayerRule', rule: { kind: m[2].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[1], 10), filter: { nameIsChosen: 'cardName' } }, who: { ref: 'eachPlayer' }, duration: /this turn/i.test(m[0]) ? 'thisTurn' : 'permanent' },
  ]],
  // ---- Round 130 ----
  // "Unattach it." / "Unattach ~."
  [/^unattach (it|~|that Equipment|equipped \w+)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx) ?? SELF;
    return [{ kind: 'unattach', what: ref }];
  }],
  // "Prevent the next 2 damage." / "Prevent the next 2 damage that would be dealt to it this turn."
  [/^prevent the next (\d+|X) damage$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? 'X' : parseInt(m[1], 10);
    const ref = ctx.lastObj ?? SELF;
    return [{ kind: 'preventAll', to: 'all', toRef: ref, amount: typeof n === 'number' ? n : undefined, once: true }];
  }],
  // "It also gets +3/+0 until end of turn." / "~ also deals 3 damage to X."
  [/^(.+?) also (gets?|gains?|deals?|has|have|draws?|loses?) (.+)$/i, (m, ctx) => parseSentence(`${m[1]} ${m[2]} ${m[3]}`, ctx)],
  // "They are no longer suspected."
  [/^(?:they|it|those creatures) (?:is|are) no longer suspected$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? SELF;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'clearSuspected' }, on: ref, duration: 'permanent' }];
  }],
  // ---- Round 127 ----
  // "Choose a creature at random, then destroy the rest."
  [/^choose (?:a|an|(\w+)) (.+?) at random$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || typeof n !== 'number') return null;
    const key = `rnd_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone) f.zone = 'battlefield';
    return [{ kind: 'chooseObjects', filter: f, count: n, key, random: true }];
  }],
  // "An opponent chooses one of them." / "An opponent chooses a creature card from among them."
  [/^(an opponent|target opponent|each opponent|that player|target player) chooses (?:a|an|one|(\w+)) (?:of (?:them|those cards|the piles)|(.+?) from among them)$/i, (m, ctx) => {
    const who = playerRef(m[1] === 'an opponent' ? 'target opponent' : m[1], ctx);
    if (!who) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (typeof n !== 'number') return null;
    const pool = ctx.restKey ? ({ ref: 'chosen', key: ctx.restKey } as Ref) : ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const key = `opp_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, from: pool, filter: {}, count: n, key }];
  }],
  // "All creatures able to block ~ do so."
  [/^all (.+?) able to block (~|it|that creature|equipped creature|enchanted creature)(?: this turn)? do so$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    const on: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    void ctx;
    return [{ kind: 'applyRule', rule: { kind: 'mustBlock' }, on, duration: 'endOfTurn' }];
  }],
  // ---- Round 123 ----
  // "You may play up to two additional lands this turn."
  [/^(?:you may )?play up to (\w+) additional lands?(?: on each of your turns| this turn)?$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'extraLandDrop', count: n }, duration: / this turn$/i.test(m[0]) ? 'thisTurn' : 'permanent' }];
  }],
  [/^(?:you may )?play any number of lands on each of your turns$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'extraLandDrop', count: 99 } }]],
  // "You may play lands and cast spells from your graveyard." / "You may play Forests from your graveyard."
  [/^(?:you may )?(?:play|cast) (?:lands and cast |)(.+?) from your graveyard(?: as long as (.+))?$/i, (m, ctx) => {
    void ctx;
    const what = m[1].trim();
    let filter: ObjectFilter | undefined;
    if (!/^(?:spells|cards)$/i.test(what)) {
      const noun = parseNoun(what.replace(/ spells$/i, ' spell'));
      if (!noun || !noun.confident) return null;
      filter = { ...noun.filter, zone: undefined };
    }
    if (/^you may (?:play lands and cast|play lands)/i.test(m[0])) filter = undefined;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'playFromGraveyard', data: { filter } } }];
  }],
  // "You may play cards exiled this way until the end of your next turn."
  [/^(?:you may )?(?:play|cast) (it|them|that card|those cards|the exiled cards?|cards exiled this way|cards exiled with ~|up to \w+ of those cards|lands from among those cards|lands and cast spells from among cards exiled with ~|lands and cast spells from among the exiled cards)(?: (?:this turn|until the end of your next turn|until your next end step|until your next turn|until the beginning of your next upkeep|for as long as (?:it remains|they remain) exiled|for as long as you control ~|until you exile another card with ~))?(?: without paying (?:its|their) mana costs?)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const dur: 'thisTurn' | 'permanent' = /this turn|next end step|next turn|next upkeep/i.test(m[0]) ? 'thisTurn' : 'permanent';
    return [{ kind: 'playFromExile', what: ref, duration: dur, free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "cast it from your graveyard this turn"
  [/^cast (it|that card|them) from your graveyard(?: this turn| as an Adventure until the end of your next turn| until the end of your next turn)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: /this turn|next turn/i.test(m[0]) ? 'thisTurn' : 'permanent', fromGraveyard: true }];
  }],
  // "destroy all Auras attached to target land"
  [/^destroy all (.+?) attached to (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/s$/i, '')}`);
    if (!noun) return null;
    const host = /^you$/i.test(m[2]) ? null : objRef(m[2], ctx);
    if (!host && !/^you$/i.test(m[2])) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', ...(host ? { attachedToRef: host } : { attachedToRef: YOU }) };
    return [{ kind: 'destroy', what: { ref: 'all', filter: f } }];
  }],
  // ---- Round 117 ----
  // "You skip your draw step this turn." / "you cannot cast spells until your next turn"
  [/^(?:you )?skip your (draw|untap|combat|end|upkeep|first main|second main) (?:step|phase)(?: this turn)?$/i, (m) => [{ kind: 'skipStep', step: m[1].toLowerCase().replace(/ /g, ''), who: YOU }]],
  [/^you cannot cast (?:additional )?spells(?: this turn| until your next turn)?$/i, (m) => [{ kind: 'applyRule', rule: { kind: 'cantCast', filter: {} }, on: YOU, duration: /until your next turn/i.test(m[0]) ? 'untilYourNextTurn' : 'endOfTurn' }]],
  // "Its controller investigates." / "Its controller loses life equal to its power plus its toughness."
  [/^(?:its|their) controller (.+)$/i, (m, ctx) => {
    const who: Ref = { ref: 'controllerOf', of: ctx.lastObj ?? { ref: 'lastMoved' } };
    const prev = ctx.lastPlayer;
    ctx.lastPlayer = who;
    const inner = parseSentence(`that player ${m[1]}`, ctx);
    ctx.lastPlayer = prev;
    return inner;
  }],
  // "It does not untap during its controller's next two untap steps."
  [/^(.+?) (?:does not|doesn't) untap during (?:its controller's|your|their) next (\w+ )?untap steps?$/i, (m, ctx) => {
    const ref = /^(?:it|~|that creature|that permanent)$/i.test(m[1]) ? (ctx.lastObj ?? SELF) : objRef(m[1], ctx);
    if (!ref) return null;
    const n = m[2] ? wordToNumber(m[2].trim()) : 1;
    if (typeof n !== 'number') return null;
    const out: Effect[] = [];
    for (let i = 0; i < n; i++) out.push({ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilNextUntap' });
    return out;
  }],
  // "Look at the top card of your library, then exile it face down."
  [/^look at the top (\w+ )?cards? of your library, then exile (?:it|them)(?: face down)?$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1].trim()) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'exileTop', amount: n, faceDown: /face down/i.test(m[0]) || undefined }];
  }],
  // "Look at a card at random in target player's hand."
  [/^look at (?:a|an|(\w+)) cards? at random in (.+?)(?:'s)? hand$/i, (m, ctx) => {
    const who = playerRef(m[2].replace(/'s$/, ''), ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!who || typeof n !== 'number') return null;
    return [{ kind: 'revealHand', who, count: n, random: true }];
  }],
  // "Manifest a card from your hand."
  [/^manifest (?:a|an|(\w+)) cards? from your hand$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'manifest', amount: n, fromHand: true }];
  }],
  // "Lands you control gain all basic land types until end of turn."
  [/^(.+?) (?:gain|gains|become) all basic land types(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'addTypes', types: [], subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'], on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  // ---- Round 113 ----
  // "Each opponent may sacrifice a creature. For each opponent who doesn't, you draw a card."
  [/^for each (?:opponent|player) who (cannot|does not|doesn't|didn't [^,]*|does|did), (.+)$/i, (m, ctx) => {
    const negative = /^(?:cannot|does not|doesn't|didn't)/i.test(m[1]);
    const inner = parseSentence(m[2], ctx);
    if (!inner) return null;
    return [{ kind: 'repeat', times: { kind: 'ctxMemory', key: negative ? 'declinedCount' : 'acceptedCount' }, effects: inner }];
  }],
  // "If damage would be dealt to ~, put that many +1/+1 counters on it instead."
  [/^if damage would be dealt to (~|it), put that many ([+-]\d+\/[+-]\d+|[\w'-]+) counters on it instead$/i, (m) => [
    { kind: 'applyRule', rule: { kind: 'custom', tag: 'damageToCounters', data: { counter: m[2] } }, on: SELF, duration: 'permanent' },
  ]],
  // "If a creature enters this way, it enters with an additional +1/+1 counter on it."
  [/^if (?:a|an) (.+?) enters this way, it enters with (?:an additional|(\w+) additional|two additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    const n = m[2] ? wordToNumber(m[2]) : /two additional/i.test(m[0]) ? 2 : 1;
    if (!noun || typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: { ...noun.filter, zone: undefined }, counter: m[3], amount: n } }, duration: 'thisTurn' }];
  }],
  // "For as long as that card remains exiled, you may play it."
  [/^for as long as (?:that card|those cards|it|they) remains? exiled, (?:you|its owner) may (?:play|cast) (?:it|them)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', owner: /its owner/i.test(m[0]) || undefined }];
  }],
  // "Exchange your life total with ~'s power."
  [/^exchange your life total with ~'s (power|toughness)$/i, (m) => [{ kind: 'exchangeLifeWith', what: SELF, stat: m[1].toLowerCase() as 'power' }]],
  [/^exchange target opponent's life total with ~'s (power|toughness)$/i, (m, ctx) => {
    const who = objRef('target opponent', ctx);
    if (!who) return null;
    return [{ kind: 'exchangeLifeWith', what: SELF, stat: m[1].toLowerCase() as 'power', who }];
  }],
  // "Exchange your hand and graveyard." / "Exchange your graveyard and library."
  [/^exchange your (hand|graveyard|library) and (?:your )?(hand|graveyard|library)(?:, then shuffle)?$/i, (m) => [
    { kind: 'exchangeZones', a: m[1].toLowerCase() as 'hand', b: m[2].toLowerCase() as 'hand', shuffle: /shuffle/i.test(m[0]) || undefined },
  ]],
  // ---- Round 112 ----
  // "Each player who controls a multicolored creature draws a card."
  [/^each (player|opponent) who (controls .+?|discarded a card this way|drew a card this way|drew a card this turn|lost life this turn|gained life this turn) ((?:draws|loses|gains|discards|sacrifices|mills|investigates|creates|exiles|puts|returns|taps|untaps|may)\b.*)$/i, (m, ctx) => {
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    let cond: Condition | null = null;
    const cm = m[2].match(/^controls (.+)$/i);
    if (cm) {
      const most = cm[1].match(/^the most (.+)$/i);
      const noun = parseNoun(most ? `a ${most[1].replace(/s$/i, '')}` : cm[1]) ?? parseNoun(`a ${cm[1]}`);
      if (!noun || !noun.confident) return null;
      cond = most
        ? { kind: 'controlsMost', filter: { ...noun.filter, zone: 'battlefield' }, who: { ref: 'iter' } }
        : { kind: 'count', filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, op: '>=', value: 1 };
    } else if (/discarded a card this way/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'discard', who: { ref: 'iter' } };
    else if (/drew a card this (?:turn|way)/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'drawCard', who: { ref: 'iter' } };
    else if (/lost life this turn/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'lifeLost', who: { ref: 'iter' } };
    else if (/gained life this turn/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'lifeGained', who: { ref: 'iter' } };
    if (!cond) return null;
    const saved = ctx.targets.length;
    const prevPlayer = ctx.lastPlayer;
    ctx.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(`that player ${m[3]}`, ctx) ?? parseSentence(m[3], ctx);
    ctx.lastPlayer = prevPlayer;
    if (!inner) {
      ctx.targets.length = saved;
      return null;
    }
    return [{ kind: 'forEach', over, effects: [{ kind: 'conditional', if: cond, then: inner }] }];
  }],
  // "Each player chooses three permanents they control, then sacrifices the rest."
  [/^each (player|opponent) chooses (?:up to )?(\w+) (.+?) they control, then sacrifices the rest$/i, (m) => {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${m[3].replace(/s$/i, '')}`) ?? parseNoun(`a ${m[3]}`);
    if (!noun || typeof n !== 'number') return null;
    const key = `keep_${Math.random().toString(36).slice(2, 6)}`;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, count: n, key, upTo: /up to /i.test(m[0]) || undefined },
      { kind: 'sacrifice', what: { ref: 'all', filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield', notChosenKey: key } } },
    ] }];
  }],
  // "Each player discards any number of cards, then draws that many cards."
  [/^each (player|opponent) discards any number of cards, then draws that many cards$/i, (m) => {
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'discard', amount: 99, upTo: true, who: { ref: 'iter' } }, { kind: 'draw', amount: { kind: 'ctxMemory', key: 'discardedCount' }, who: { ref: 'iter' } }] }];
  }],
  // "Each player returns all creature cards from their graveyard to their hand."
  [/^each (player|opponent) (?:returns?|puts?) (.+?) from their graveyard (?:to|onto) (their hand|the battlefield)$/i, (m) => {
    const noun = parseNoun(m[2]);
    if (!noun || !noun.confident || noun.target) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const f: ObjectFilter = { ...noun.filter, zone: 'graveyard', ownerRef: { ref: 'iter' } };
    const all = noun.each || (noun.plural && !noun.indefinite && noun.count === 1);
    const inner: Effect[] = [];
    let what: Ref;
    if (all) what = { ref: 'all', filter: f };
    else {
      const key = `gy_${Math.random().toString(36).slice(2, 6)}`;
      inner.push({ kind: 'chooseObjects', who: { ref: 'iter' }, filter: f, count: noun.count, key, upTo: noun.upTo || undefined });
      what = { ref: 'chosen', key };
    }
    inner.push(/hand/i.test(m[3]) ? { kind: 'returnToHand', what } : { kind: 'returnToBattlefield', what, controller: 'owner' });
    return [{ kind: 'forEach', over, effects: inner }];
  }],
  // "Each player's life total becomes the lowest life total among all players."
  [/^each player's life total becomes the (lowest|highest) life total among all players$/i, (m) => [{ kind: 'setLife', amount: { kind: m[1].toLowerCase() === 'lowest' ? 'lowestLife' : 'highestLife' }, who: { ref: 'eachPlayer' } }]],
  // "Counter target spell if its mana value is 3 or less\"
  [/^counter (target .+?) if (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const cond = parseCondition(m[2], { self: SELF, lastObj: ref, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
    if (!cond || cond.kind === 'manual') return null;
    return [{ kind: 'conditional', if: cond, then: [{ kind: 'counterSpell', what: ref }] }];
  }],
  // "~ deals X damage divided evenly, rounded down, among all creatures target opponent controls"
  [/^(.+?) deals (\d+|X) damage divided (?:evenly, rounded down,|as you choose) among (.+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? undefined : (objRef(m[1], ctx) ?? undefined);
    if (!/^~$/.test(m[1]) && !src) return null;
    const to = objRef(m[3], ctx);
    if (!to) return null;
    const a: Amount = /^X$/i.test(m[2]) ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: a, to, source: src, divided: true }];
  }],
  // "~ deals 1 damage to any target and 1 damage to any target of an opponent's choice\"
  // "~ deals X damage to target creature and 1 damage to each other creature with the same controller"
  [/^(.+?) deals (\d+|X) damage to (.+?) and (\d+|X|half X, rounded (?:up|down)) damage to (.+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? undefined : (objRef(m[1], ctx) ?? undefined);
    if (!/^~$/.test(m[1]) && !src) return null;
    const amtOf = (w: string): Amount | null => {
      if (/^\d+$/.test(w)) return parseInt(w, 10);
      if (/^X$/i.test(w)) return 'X';
      const half = w.match(/^half X, rounded (up|down)$/i);
      if (half) return { kind: 'half', a: 'X', round: half[1].toLowerCase() as 'up' | 'down' };
      return null;
    };
    const a1 = amtOf(m[2]);
    const a2 = amtOf(m[4]);
    if (a1 === null || a2 === null) return null;
    const t1 = objRef(m[3], ctx);
    if (!t1) return null;
    const t2 = objRef(m[5], ctx);
    if (!t2) return null;
    return [
      { kind: 'damage', amount: a1, to: t1, source: src },
      { kind: 'damage', amount: a2, to: t2, source: src },
    ];
  }],
  // "~ deals 3 damage to target creature and each other creature that shares a creature type with it"
  [/^(.+?) deals (\d+|X) damage to (.+?) and (each other .+|each .+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? undefined : (objRef(m[1], ctx) ?? undefined);
    if (!/^~$/.test(m[1]) && !src) return null;
    const a: Amount = /^X$/i.test(m[2]) ? 'X' : parseInt(m[2], 10);
    const t1 = objRef(m[3], ctx);
    if (!t1) return null;
    const t2 = objRef(m[4], ctx);
    if (!t2) return null;
    return [
      { kind: 'damage', amount: a, to: t1, source: src },
      { kind: 'damage', amount: a, to: t2, source: src },
    ];
  }],
  [/^return (all .+?) to your hand$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone && !f.zoneIn) f.zone = 'graveyard';
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return [{ kind: 'returnToHand', what: ref }];
  }],
];

function damageTo(targetText: string, amount: Amount, ctx: ParseCtx, source: Ref): Effect[] | null {
  let t = targetText.trim();
  let divided = false;
  const dm = t.match(/^(.+?),? divided as you choose among (.+)$/i);
  if (dm) {
    divided = true;
    t = dm[2];
  }
  const l = t.toLowerCase();
  const out: Effect[] = [];
  const mk = (to: Ref): Effect => ({ kind: 'damage', amount, to, source: source.ref === 'self' ? undefined : source, divided });
  if (l === 'each creature and each player' || l === 'each creature and each opponent' || l === 'each creature and each planeswalker') {
    out.push(mk({ ref: 'all', filter: { types: ['Creature'], zone: 'battlefield' } }));
    if (l.includes('player')) out.push(mk({ ref: 'eachPlayer' }));
    else if (l.includes('opponent')) out.push(mk({ ref: 'eachOpponent' }));
    else out.push(mk({ ref: 'all', filter: { types: ['Planeswalker'], zone: 'battlefield' } }));
    return out;
  }
  if (l === 'each opponent and each creature they control') return [mk({ ref: 'eachOpponent' }), mk({ ref: 'all', filter: { types: ['Creature'], controller: 'opponent', zone: 'battlefield' } })];
  if (l === 'each creature without flying') return [mk({ ref: 'all', filter: { types: ['Creature'], withoutKeywords: ['Flying'], zone: 'battlefield' } })];
  if (l === 'each other creature') return [mk({ ref: 'all', filter: { types: ['Creature'], other: true, zone: 'battlefield' } })];
  if (l === 'each creature and each player' ) return null;
  // "X and Y" pairs of refs
  const parts = t.split(/ and /i);
  if (parts.length === 2 && !/target/i.test(parts[1]) && !/target/i.test(parts[0])) {
    const a = anyRef(parts[0], ctx);
    const b = anyRef(parts[1], ctx);
    if (a && b) return [mk(a), mk(b)];
  }
  // "each of up to six targets" / "each of two targets" / "each of one or two targets"
  let em: RegExpMatchArray | null;
  if ((em = t.match(/^each of (?:(up to) )?(?:(\w+) or (\w+)|(X|\w+)) targets$/i))) {
    const lo = em[3] ? wordToNumber(em[2]) : em[1] ? 0 : null;
    const hiRaw = em[3] ?? em[4];
    const hi = hiRaw.toUpperCase() === 'X' ? 'X' : wordToNumber(hiRaw);
    if (hi === null) return null;
    const max = hi === 'X' ? 20 : hi;
    ctx.targets.push({ description: t, kind: 'any', min: lo === null || lo === 'X' ? max : lo, max, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [mk(ref)];
  }
  if (/^any other target$/i.test(t)) {
    ctx.targets.push({ description: t, kind: 'any', min: 1, max: 1, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return [mk(ref)];
  }
  if (/^(?:any number of|up to \w+) targets?$/i.test(t) || /^any target$/i.test(t) || /^up to (\w+) targets?$/i.test(t) || /^one or two targets$/i.test(t) || /^one, two, or three targets$/i.test(t)) {
    const um = t.match(/^up to (\w+) targets?$/i);
    const n = um ? wordToNumber(um[1]) : /^one or two/i.test(t) ? 2 : /^one, two, or three/i.test(t) ? 3 : 1;
    ctx.targets.push({ description: t, kind: 'any', min: um ? 0 : 1, max: typeof n === 'number' ? n : 10 });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [mk(ref)];
  }
  const ref = anyRef(t, ctx);
  return ref ? [mk(ref)] : null;
}

/** "except it has haste and it is a Nightmare in addition to its other types" → token copy exceptions. */
export function parseCopyExceptions(text: string): TokenSpec['exceptions'] | null {
  const ex: NonNullable<TokenSpec['exceptions']> = {};
  // Split on commas/ands outside quoted rules text.
  const masked = text.replace(/"[^"]*"/g, (q) => '\u0001'.repeat(q.length));
  const bounds: number[] = [];
  for (const bm of masked.matchAll(/,? and (?=(?:it|they|its|is|has|have|are)\b)|, /gi)) bounds.push(bm.index!, bm.index! + bm[0].length);
  const parts: string[] = [];
  let at = 0;
  for (let bi = 0; bi < bounds.length; bi += 2) {
    parts.push(text.slice(at, bounds[bi]));
    at = bounds[bi + 1];
  }
  parts.push(text.slice(at));
  for (const part of parts) {
    const p = part.trim();
    let m: RegExpMatchArray | null;
    const p2 = p.replace(/^and /i, '').replace(/^(?:the token|the copy|that token|those tokens) /i, 'it ').replace(/^(?=(?:is|has|have|are) )/i, 'it ');
    if (/^(?:it|they) (?:has|have) this ability$/i.test(p2)) {
      ex.thisAbility = true;
      continue;
    }
    if ((m = p2.match(/^its name is (.+)$/i))) {
      ex.name = m[1].replace(/^~'s /, '');
      continue;
    }
    if ((m = p2.match(/^(?:it|they) (?:has|have) (.+)$/i))) {
      // "it has haste and \"At the beginning of the end step, sacrifice ~.\"" — keywords and quoted text mixed.
      const body = m[1];
      const maskedBody = body.replace(/"[^"]*"/g, (q) => '\u0001'.repeat(q.length));
      const cuts: number[] = [];
      for (const cm of maskedBody.matchAll(/,? and /gi)) cuts.push(cm.index!, cm.index! + cm[0].length);
      const pieces: string[] = [];
      let at2 = 0;
      for (let ci = 0; ci < cuts.length; ci += 2) {
        pieces.push(body.slice(at2, cuts[ci]));
        at2 = cuts[ci + 1];
      }
      pieces.push(body.slice(at2));
      for (const piece of pieces) {
        const q = piece.trim().match(/^"(.+)"$/);
        if (q) {
          ex.abilities = [...(ex.abilities ?? []), q[1]];
          continue;
        }
        const kws = parseKeywordList(piece.trim());
        if (!kws) return null;
        ex.keywords = [...(ex.keywords ?? []), ...kws];
      }
    } else if (/^(?:it|they) (?:is|are) not legendary$/i.test(p2)) ex.notLegendary = true;
    else if (/^(?:it|they) (?:is|are) legendary$/i.test(p2)) ex.legendary = true;
    else if ((m = p2.match(/^(?:it|they) (?:is|are) (?:a|an) (.+?)(?: in addition to its other types)?$/i)) && /^(?:artifact|creature|enchantment|land|legendary|[A-Z]\w+)(?: \w+)*$/.test(m[1]) && !/\d\/\d/.test(m[1])) {
      const words = m[1].split(/\s+/);
      ex.addTypes = [...(ex.addTypes ?? []), ...words.filter((w) => /^(artifact|creature|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
      ex.addSubtypes = [...(ex.addSubtypes ?? []), ...words.filter((w) => /^[A-Z]/.test(w))];
    } else if ((m = p2.match(/^(?:it|they) (?:is|are) (\d+)\/(\d+)$/i))) {
      ex.power = m[1];
      ex.toughness = m[2];
    } else if ((m = p2.match(/^(?:it|they) (?:is|are) (?:a|an) (\d+)\/(\d+) (.+?)(?: creatures?)?(?: in addition to its other (?:types|colors|colors and types))?$/i))) {
      ex.power = m[1];
      ex.toughness = m[2];
      for (const w of m[3].split(/\s+/)) {
        const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white'];
        if (c) ex.colors = [...(ex.colors ?? []), c];
        else if (/^colorless$/i.test(w)) ex.colors = [];
        else if (/^and$/i.test(w)) continue;
        else if (/^(artifact|creature|enchantment|land)$/i.test(w)) ex.addTypes = [...(ex.addTypes ?? []), w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()];
        else if (/^legendary$/i.test(w)) ex.legendary = true;
        else if (/^[A-Z]/.test(w)) ex.addSubtypes = [...(ex.addSubtypes ?? []), w];
        else return null;
      }
    } else if ((m = p2.match(/^(?:it|they) (?:is|are) (white|blue|black|red|green|colorless)$/i))) {
      const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1].toLowerCase() as 'white'];
      ex.colors = c ? [c] : [];
    } else return null;
  }
  return ex;
}

/**
 * Trailing sentences that add nothing the rest of the line needs and that no other
 * compiler branch consumes, so they can be trimmed off before a line is parsed.
 */
export function isTrailingNoise(text: string): boolean {
  const t = text.trim().replace(/\.$/, '').replace(/^until (?:end of (?:turn|combat)|your next turn)(?: on your next turn)?, /i, '');
  return /^(x cannot be 0|this effect cannot reduce the mana in that cost to less than one mana|you do not lose this mana as steps end|(?:the|its) (?:replicate|foretell|escape|casualty|cycling|flashback|buyback|scavenge|unearth|embalm|eternalize|transmute) cost is .+|x cannot be (?:greater|less) than .+|(?:the )?damage cannot be prevented|counters remain on ~ as it moves to any zone other than a player's hand or library|a creature dealt damage this way cannot be regenerated this turn|this ability cannot cause .+|spend only \w+ mana on x|you may look at cards exiled with ~|each mode must target a different \w+|each copy targets a different one of those \w+|the same is true for .+|th(?:is|at) mana cannot be spent to cast .+|(?:then )?(?:that|each) player shuffles(?: their library)?|reveal (?:it|them|that card|those cards)|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|(?:it|they) cannot be regenerated)$/i.test(t);
}

/** Informational text the engine needs no code for (or that players handle trivially by hand). */
export function isNoOpSentence(text: string): boolean {
  if (/^(?:then )?(?:that|each) player shuffles(?: their library)?\.?$/i.test(text.trim())) return true;
  if (/^the same is true for .+$/i.test(text.trim())) return true;
  if (/^you may reveal (?:a|an) .+? (?:you own )?from outside the game and put it into your hand$/i.test(text.trim())) return true;
  if (/^th(?:is|at) mana cannot be spent to cast .+$/i.test(text.trim())) return true;
  if (/^the flashback cost is equal to its mana cost\.?$/i.test(text.trim())) return true;
  if (/^(?:then )?each player who searched their library this way shuffles\.?$/i.test(text.trim())) return true;
  if (/^[\w' -]+(?: destroyed| exiled| sacrificed)? (?:this way )?cannot be regenerated\.?$/i.test(text.trim())) return true;
  if (/\bdraft(ed|ing)?\b/i.test(text) || /^x cannot be 0\.?$/i.test(text.trim())) return true;
  if (/^th(?:is|at) ability cannot cause .+$/i.test(text.trim())) return true;
  if (/^th(?:is|at) effect reduces only the amount of (?:colored|\w+) mana you pay\.?$/i.test(text.trim())) return true;
  if (/^mana of any type can be spent to cast (?:it|that spell|this spell|those spells) this way\.?$/i.test(text.trim())) return true;
  if (/^if it does ?n[o']t have suspend, it gains suspend\.?$/i.test(text.trim())) return true;
  if (/^(?:players|your opponents|each opponent) play with (?:their hands|the top card of their libraries) revealed\.?$/i.test(text.trim())) return true;
  if (/^spend only \w+ mana on x\.?$/i.test(text.trim())) return true;
  if (/^you may look at cards exiled with ~\.?$/i.test(text.trim())) return true;
  if (/^you cannot cast ~ during your (?:first|second|third)(?:, (?:first|second|third))*(?:,? or (?:first|second|third))? turns? of the game\.?$/i.test(text.trim())) return true;
  if (/^~ saddles mounts and crews vehicles as though its power were \d+ greater\.?$/i.test(text.trim())) return true;
  return /^(if you cast a spell this way, mana of any type can be spent to cast it|draft ~ face up|play with the top card of your library revealed|spend this mana only to .+|you may spend mana as though it were mana of any color|mana of any type can be spent to cast (?:spells|a spell) this way|you may spend mana as though it were mana of any color to activate those abilities|you may look at (?:it|that card|those cards) for as long as (?:it remains|they remain) exiled|reveal the first card you draw each turn|this change in ownership is permanent|the new target must be a player|you may reveal the first card you draw each turn as you draw it|a spell cast this way costs .+|spend this mana only on costs that contain .+|it is still a land|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|it cannot be regenerated|they cannot be regenerated|you may choose the same mode more than once|~ can be your commander|any player may activate this ability(?: but only as a sorcery)?|you may look at the top card of your library any time|you may choose not to untap ~ during your untap step|~'s power and toughness are each equal to .+|doctor's companion|fuse|~ enters prepared|partner|friends forever|choose a background|this spell cannot be countered|~ cannot be countered|this ability triggers only once each turn|do this only once each turn|reveal it|reveal them|reveal that card|reveal those cards)\.?$/i.test(text.trim());
}

/** Rewrite an effect compiled for "you" so it applies to another player instead. */
function retargetToPlayer<T>(value: T, who: Ref): T {
  if (Array.isArray(value)) return value.map((v) => retargetToPlayer(v, who)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'owner' && v === 'you') {
      out.ownerRef = who;
      continue;
    }
    if (k === 'controller' && v === 'you') {
      out.controllerRef = who;
      continue;
    }
    if (k === 'who' && (v === undefined || (typeof v === 'object' && v !== null && (v as { ref?: string }).ref === 'controller'))) {
      out.who = who;
      continue;
    }
    out[k] = retargetToPlayer(v, who);
  }
  if (typeof src.kind === 'string' && !('who' in src) && ['draw', 'gainLife', 'loseLife', 'setLife', 'discard', 'mill', 'millBottom', 'scry', 'surveil', 'investigate', 'treasure', 'createToken', 'shuffle', 'skipTurn', 'skipStep', 'extraTurn', 'revealHand', 'manifest', 'searchLibrary', 'exileTop', 'loseAllCounters', 'handToLibrary', 'shuffleZoneIntoLibrary', 'chooseObjects', 'lookAtTop'].includes(src.kind as string)) {
    out.who = who;
  }
  return out as unknown as T;
}

/** Parse one sentence; returns null if not understood. */
export function parseSentence(s: string, ctx: ParseCtx): Effect[] | null {
  let text = s.trim().replace(/\.$/, '');
  if (!text) return [];
  text = text.replace(/^then,? /i, '');
  text = text.replace(/^you (create|tap|untap|flip a coin)\b/i, '$1');
  text = text.replace(/\bthat player or that planeswalker's controller controls\b/gi, 'that player controls');
  text = text.replace(/^(for each (?:opponent|player)), you (create|draw|gain|lose|put|exile|destroy|sacrifice|mill|scry|return)\b/i, '$1, $2');
  text = rephraseFirstPerson(text);
  let m: RegExpMatchArray | null;
  // "~ gets +3/-1 until end of turn and can attack this turn as though it didn't have defender"
  if ((m = text.match(/^(.+? (?:gets?|get) [+-]\d+\/[+-]\d+(?: until end of turn)?) and can attack(?: this turn)? as though it (?:didn't|did not) have defender$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) {
      const ref = ctx.lastObj ?? SELF;
      return [...inner, { kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }];
    }
  }
  // "put all cards exiled with ~ into their owner's graveyard"
  if ((m = text.match(/^put (all cards exiled with ~|all .+? exiled with ~) into (?:their|its) owners'? graveyards?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'putIntoGraveyard', what: ref }];
  }
  // "destroy the creature with the least power"
  if ((m = text.match(/^(destroy|exile|tap) the (.+? with the (?:least|greatest) (?:power|toughness))$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) {
      const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
      const verb = m[1].toLowerCase();
      return [verb === 'destroy' ? { kind: 'destroy', what: { ref: 'all', filter: f } } : verb === 'exile' ? { kind: 'exile', what: { ref: 'all', filter: f } } : { kind: 'tap', what: { ref: 'all', filter: f } }];
    }
  }
  // Cards that pick a colour before the game and then are that colour.
  if (/^if ~ is your commander, choose a color before the game begins$/i.test(text)) return [{ kind: 'chooseColor', key: 'color' }];
  if (/^~ is the chosen color$/i.test(text)) return [{ kind: 'setColors', colors: [], chosenKey: 'color', on: SELF, duration: 'permanent' }];
  // "each player searches their library for up to two basic land cards, puts them onto the battlefield, then shuffles"
  if ((m = text.match(/^(each player|each opponent|that player|target player|target opponent|its controller) searches their library for (.+?), (?:reveals? (?:it|them), )?puts? (.+?)(?:, then shuffles?)?$/i))) {
    const who = playerRef(m[1], ctx);
    if (who) {
      const saved = ctx.lastPlayer;
      ctx.lastPlayer = who;
      const r = parseSentence(`search their library for ${m[2]}, put ${m[3]}, then shuffle`, ctx);
      if (r) return r;
      ctx.lastPlayer = saved;
    }
  }
  if ((m = text.match(/^(.+?) (?:does not|doesn't|do not|don't) untap during (?:its controller's|their controller's|its controllers'|your|their) untap steps?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'permanent' }];
  }
  // "have target creature get -2/-2 until end of turn" → "target creature gets -2/-2 until end of turn"
  if ((m = text.match(/^have (.+?) (get|gain|lose|become) (.+)$/i))) {
    const r = parseSentence(`${m[1]} ${m[2]}s ${m[3]}`, ctx);
    if (r) return r;
  }
  // "put your choice of a +1/+1, first strike, or trample counter on that creature"
  if ((m = text.match(/^put your choice of (?:a|an) (.+?) counter on (.+)$/i))) {
    const options = m[1].split(/,? or |, /).map((x) => x.replace(/^(?:a|an) /i, '').trim()).filter(Boolean);
    const ref = objRef(m[2], ctx);
    return ref && options.length > 1 ? [{ kind: 'addCounters', counter: options[0], counterOptions: options, amount: 1, on: ref }] : null;
  }
  // "return target creature card from your graveyard to the battlefield tapped and attacking"
  if ((m = text.match(/^(return .+? to the battlefield) tapped and attacking$/i))) {
    const inner = parseSentence(`${m[1]} tapped`, ctx);
    if (inner) return inner.map((e) => (e.kind === 'returnToBattlefield' ? { ...e, attacking: true } : e));
  }
  if ((m = text.match(/^when (that creature|it|that permanent) becomes blocked this turn, (.+)$/i))) {
    const ref = objRef(m[1], ctx);
    const inner = ref ? parseSentence(m[2], ctx) : null;
    if (ref && inner) return [{ kind: 'delayedTrigger', event: 'becomesBlocked', filter: { objectRef: ref }, effects: inner, text, once: true }];
  }
  // "You may cast a spell with mana value 4 or less from your hand without paying its mana cost"
  if ((m = text.match(/^(?:you may )?cast (?:a|an) (.+?) (?:card |spell )?(?:from (your hand|your graveyard|a graveyard) )?(?:with mana value (\d+|X) or less )?(?:from (your hand|your graveyard|a graveyard) )?without paying its mana cost$/i))) {
    const noun = /^spell$/i.test(m[1]) ? { filter: { nonland: true } as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spell$/i, '')} card`);
    if (noun) {
      const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
      const where = (m[2] ?? m[4] ?? 'your hand').toLowerCase();
      const f: ObjectFilter = { ...noun.filter, zone: where.includes('graveyard') ? 'graveyard' : 'hand', nonland: true };
      if (where === 'your hand' || where === 'your graveyard') f.owner = 'you';
      if (m[3]) f.cmcLE = m[3] === 'X' ? 'X' : parseInt(m[3], 10);
      ctx.lastObj = { ref: 'chosen', key };
      return [{ kind: 'may', effects: [{ kind: 'chooseObjects', filter: f, count: 1, key }, { kind: 'castWithoutPaying', what: { ref: 'chosen', key } }] }];
    }
  }
  if ((m = text.match(/^(?:until end of turn, )?(.+?) assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'damageByToughness' }, on: ref, duration: 'endOfTurn' }] : null;
  }
  if (/^after this (?:phase|combat phase|main phase), there is an additional combat phase(?: followed by an additional main phase)?$/i.test(text)) return [{ kind: 'extraCombat' }];
  if (/^exile ~, then return it to the battlefield transformed under (?:your|its owner's) control$/i.test(text)) return [{ kind: 'exile', what: SELF }, { kind: 'returnToBattlefield', what: { ref: 'lastMoved' } }, { kind: 'transform', what: { ref: 'lastMoved' } }];
  if ((m = text.match(/^prevent all (combat )?damage that would be dealt to and dealt by (.+?) this turn$/i))) {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: 'endOfTurn' }, { kind: 'applyRule', rule: { kind: 'custom', tag: 'preventDamageTo', data: { combat: m[1] ? 'combat' : undefined } }, on: ref, duration: 'endOfTurn' }] : null;
  }
  if ((m = text.match(/^(.+?) deals (\w+|X) damage to (target player|target opponent|any target|target player or planeswalker|that player|each opponent) and (each .+)$/i))) {
    const a = parseSentence(`${m[1]} deals ${m[2]} damage to ${m[3]}`, ctx);
    const b = a ? parseSentence(`${m[1]} deals ${m[2]} damage to ${m[4]}`, ctx) : null;
    if (a && b) return [...a, ...b];
  }
  if ((m = text.match(/^(.+?) can block an additional creature (?:this turn|each combat)$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'extraBlock' }, on: ref, duration: / this turn$/i.test(text) ? 'endOfTurn' : 'permanent' }] : null;
  }
  if ((m = text.match(/^put (.+?) into its owner's library second from the top$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: 'secondFromTop' }] : null;
  }
  if ((m = text.match(/^choose ((?:any number of|up to \w+|\w+) target .+)$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [];
  }
  if ((m = text.match(/^(.+?) becomes? the (basic land type|creature type) of your choice(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'setSubtypes', on: ref, choose: m[2].toLowerCase() === 'basic land type' ? 'basicLandType' : 'creatureType', duration: / until end of turn$/i.test(text) ? 'endOfTurn' : 'permanent' }] : null;
  }
  if ((m = text.match(/^you and (permanents|creatures) you control gain (hexproof|indestructible|hexproof and indestructible) until end of turn$/i))) {
    const kws = m[2].split(' and ').map((k) => k.charAt(0).toUpperCase() + k.slice(1));
    const out: Effect[] = [{ kind: 'grantKeywords', keywords: kws, on: { ref: 'all', filter: { controller: 'you', zone: 'battlefield', ...(m[1].toLowerCase() === 'creatures' ? { types: ['Creature'] } : {}) } }, duration: 'endOfTurn' }];
    if (/hexproof/i.test(m[2])) out.push({ kind: 'applyRule', rule: { kind: 'custom', tag: 'hexproof' }, on: YOU, duration: 'endOfTurn' });
    return out;
  }
  if ((m = text.match(/^blight (\d+|X)$/i))) {
    const key = `blight${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'chooseObjects', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' }, count: 1, key }, { kind: 'addCounters', counter: '-1/-1', amount: m[1] === 'X' ? 'X' : parseInt(m[1], 10), on: { ref: 'chosen', key } }];
  }
  if ((m = text.match(/^return (it|that card|~|them) to the battlefield transformed(?: under (?:your|its owner's|their owner's) control)?(?: tapped)?$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToBattlefield', what: ref, transformed: true, controller: /owner's/i.test(text) ? 'owner' : 'you', tapped: / tapped$/i.test(text) || undefined }] : null;
  }
  if (/^reveal the top card of your library$/i.test(text)) {
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealTop', destination: 'stay' }];
  }
  if ((m = text.match(/^(each player|each opponent|target player|target opponent|that player|you) reveals? the top card of (?:their|your) library$/i))) {
    const who = playerRef(m[1], ctx);
    if (who) {
      ctx.lastObj = { ref: 'lastMoved' };
      return [{ kind: 'revealTop', who, destination: 'stay' }];
    }
  }
  if ((m = text.match(/^exert (~|it|that creature)$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'exert', what: ref }] : null;
  }
  // Earthbend N: target land you control becomes a 0/0 creature with haste (still a land) with N +1/+1 counters; it comes back tapped if it dies or is exiled.
  if ((m = text.match(/^earthbend (\d+|X)$/i))) {
    const n: Amount = m[1] === 'X' ? 'X' : parseInt(m[1], 10);
    const ref = objRef('target land you control', ctx);
    if (ref) {
      return [
        { kind: 'addTypes', types: ['Creature'], on: ref, duration: 'permanent' },
        { kind: 'setPT', power: 0, toughness: 0, on: ref, duration: 'permanent' },
        { kind: 'grantKeywords', keywords: ['Haste'], on: ref, duration: 'permanent' },
        { kind: 'addCounters', counter: '+1/+1', amount: n, on: ref },
        { kind: 'delayedTrigger', event: 'dies', filter: { objectRef: ref }, effects: [{ kind: 'returnToBattlefield', what: { ref: 'triggerObject' }, tapped: true, controller: 'owner' }], text: 'Earthbend: when it dies, return it to the battlefield tapped.', once: true },
        { kind: 'delayedTrigger', event: 'exiled', filter: { objectRef: ref }, effects: [{ kind: 'returnToBattlefield', what: { ref: 'triggerObject' }, tapped: true, controller: 'owner' }], text: 'Earthbend: when it is exiled, return it to the battlefield tapped.', once: true },
      ];
    }
  }
  // "~ becomes a Construct artifact creature with "..." until end of turn"
  if ((m = text.match(/^(.+?) becomes? (?:a|an) (\d+)\/(\d+) (.+?) creature(?: with (.+?))?(?: until end of turn)?(?: that(?:'s| is) still (?:a |an )?\w+)?$/i)) && !/"/.test(text)) {
    const ref = objRef(m[1], ctx);
    if (ref) {
      const words = m[4].split(/\s+/);
      const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
      const subtypes = words.filter((w) => /^[A-Z]/.test(w));
      const rest = words.filter((w) => !/^(white|blue|black|red|green|and|colorless|artifact|enchantment)$/i.test(w) && !/^[A-Z]/.test(w));
      if (!rest.length) {
        const dur: Duration = / until end of turn/i.test(text) ? 'endOfTurn' : 'permanent';
        const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
        const out: Effect[] = [{ kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, on: ref, duration: dur }, { kind: 'setPT', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: dur }];
        if (colors.length || /colorless/i.test(m[4])) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
        if (m[5]) {
          const kws = parseKeywordList(m[5]);
          if (!kws) return null;
          out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
        }
        return out;
      }
    }
  }
  if ((m = text.match(/^(.+?) becomes? (?:a|an) (.+?) (artifact creature|creature|artifact|enchantment creature) with "(.+)"(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) {
      const dur: Duration = / until end of turn"?$/i.test(text) || / until end of turn$/i.test(text) ? 'endOfTurn' : 'permanent';
      const types = m[3].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1));
      const subtypes = m[2].split(/\s+/).filter((w) => /^[A-Z]/.test(w));
      return [{ kind: 'addTypes', types, subtypes, on: ref, duration: dur }, { kind: 'grantAbility', text: m[4], on: ref, duration: dur }];
    }
  }
  // "~ deals damage equal to the discarded card's mana value to that permanent or player" → "~ deals X damage to ..., where X is ..."
  if ((m = text.match(/^(.+?) deals damage equal to (.+?) to (.+)$/i)) && !/\bwhere X is\b/i.test(text)) {
    const r = parseSentence(`${m[1]} deals X damage to ${m[3]}, where X is ${m[2]}`, ctx);
    if (r) return r;
  }
  if ((m = text.match(/^(.+?) deals damage to (.+?) equal to (.+)$/i)) && !/\bwhere X is\b/i.test(text)) {
    const r = parseSentence(`${m[1]} deals X damage to ${m[2]}, where X is ${m[3]}`, ctx);
    if (r) return r;
  }
  // "For each creature card exiled this way, create a token that is a copy of it"
  if ((m = text.match(/^for each (.+?) (exiled|destroyed|sacrificed|returned|discarded|milled|revealed) this way, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1].replace(/ cards?$/i, ' card')}`);
    if (noun) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastObj = { ref: 'iter' };
      const inner = parseSentence(m[3].replace(/\b(?:that|this) (?:creature|permanent|card|land|token)\b/gi, 'it'), sub);
      if (inner) return [{ kind: 'forEach', over: { ref: 'lastMoved' }, effects: inner, filter: { ...noun.filter, zone: undefined } } as Effect];
    }
  }
  if ((m = text.match(/^(.+?) can attack this turn as though (?:it|they) didn't have defender$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }] : null;
  }
  if ((m = text.match(/^(target (?:creature|permanent|artifact|nonland permanent)[^']*?)'s owner puts it on their choice of the top or bottom of their library$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: 'ownerChoice' }] : null;
  }
  if ((m = text.match(/^(.+?) becomes? a copy of (.+?)(?:, except (.+))?$/i)) && !/until end of turn/i.test(text)) {
    const what = objRef(m[1], ctx);
    const of = what ? objRef(m[2], ctx) : null;
    const ex = m[3] ? parseCopyExceptions(m[3]) : undefined;
    if (what && of && (!m[3] || ex)) return [{ kind: 'becomeCopy', what, of, exceptions: ex ?? undefined }];
  }
  if ((m = text.match(/^put (it|that card|them|those cards|~) into (?:your|its owner's|their owner's|their owners') graveyards?$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] : null;
  }
  if ((m = text.match(/^return ~ from your graveyard to the battlefield attached to (.+)$/i))) {
    const host = objRef(m[1], ctx);
    return host ? [{ kind: 'returnToBattlefield', what: SELF, attachTo: host }] : null;
  }
  if ((m = text.match(/^put (?:its|~'s) counters on (.+)$/i))) {
    const to = objRef(m[1], ctx);
    return to ? [{ kind: 'moveCounters', from: ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF, to }] : null;
  }
  if (/^~ assigns no combat damage this turn$/i.test(text)) return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: 'combat' }, on: SELF, duration: 'endOfTurn' }];
  if (/^until end of turn, you (?:do not|don't) lose this mana as steps and phases end$/i.test(text) || /^you (?:do not|don't) lose this mana as steps and phases end(?: this turn)?$/i.test(text)) return [{ kind: 'turnFlag', flag: 'keepMana' }];
  if (/^clash with an opponent$/i.test(text)) return [{ kind: 'clash' }];
  if ((m = text.match(/^detain (.+)$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantAttack' }, on: ref, duration: 'untilYourNextTurn' }, { kind: 'applyRule', rule: { kind: 'cantBlock' }, on: ref, duration: 'untilYourNextTurn' }, { kind: 'applyRule', rule: { kind: 'custom', tag: 'cantActivate' }, on: ref, duration: 'untilYourNextTurn' }] : null;
  }
  if ((m = text.match(/^double the number of ([+\-\w\/]+) counters on (.+)$/i))) {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[1], amount: { kind: 'countersOn', ref, counter: m[1] }, on: ref }] : null;
  }
  // "destroy that creature at end of combat" / "sacrifice it at end of combat"
  if ((m = text.match(/^(.+?) at (?:the )?end of combat$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) return [{ kind: 'delayedTrigger', event: 'endOfCombat', effects: inner, text, once: true }];
  }
  // "~ gets +1/+0 until end of turn and cannot be blocked this turn"
  if ((m = text.match(/^((~|it|that creature|target creature[^,]*?|enchanted creature|equipped creature) (?:gets?|gains?) .+? until end of turn) and ((?:cannot|can't|must|doesn't|does not) .+?)(?: this turn)?$/i))) {
    const a = parseSentence(m[1], ctx);
    const b = a ? parseSentence(`${m[2]} ${m[3]} this turn`, ctx) ?? parseSentence(`${m[2]} ${m[3]}`, ctx) : null;
    if (a && b) return [...a, ...b];
  }
  if ((m = text.match(/^(.+?) becomes? the color (?:or colors )?of your choice(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'setColors', colors: [], chooseColors: true, on: ref, duration: / until end of turn$/i.test(text) ? 'endOfTurn' : 'permanent' }] : null;
  }
  if ((m = text.match(/^put (it|that card|~|them|those cards) onto the battlefield transformed(?: under (?:your|its owner's|their owner's) control)?(?: with (?:a|an|(\w+)) ([+\-\w\/]+) counters? on it)?$/i))) {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToBattlefield', what: ref, transformed: true, counters: m[3] ? { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) as number) ?? 1 : 1 } : undefined }] : null;
  }
  if ((m = text.match(/^exile the top (?:card|(\w+|X) cards)(?: of your library)?(?: face down)?$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n !== null) {
      ctx.lastObj = { ref: 'lastMoved' };
      return [{ kind: 'exileTop', amount: n }];
    }
  }
  if ((m = text.match(/^exile the top (?:card|(\w+|X) cards) of (target player|target opponent|that player|each player|each opponent)'s library(?: face down)?$/i))) {
    const who = playerRef(m[2], ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (who && n !== null) return [{ kind: 'exileTop', who, amount: n }];
  }
  // "Whenever a creature blocks this turn, X" (a spell setting up a this-turn trigger)
  if ((m = text.match(/^(whenever [^,]+?) this turn, (.+)$/i))) {
    const head = parseTriggerHead(`${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}, ${m[2]}`);
    if (head && !head.also) {
      const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer });
      const inner = parseSentence(head.rest, sub);
      if (inner) return [{ kind: 'delayedTrigger', event: head.event, filter: head.filter, effects: inner, text, untilEndOfTurn: true }];
    }
  }
  // "Gain control of target creature for as long as ~ remains tapped" / "... for as long as you control ~"
  if ((m = text.match(/^(.+?) for as long as (~ remains tapped|you control ~|~ remains on the battlefield|~ remains untapped|you control ~ and ~ remains tapped|~ remains tapped and you control ~)$/i))) {
    const inner = parseSentence(m[1], ctx);
    const dur: Duration = /remains tapped/i.test(m[2]) ? 'whileSourceTapped' : /you control/i.test(m[2]) ? 'whileYouControlSource' : 'untilSourceLeaves';
    if (inner && inner.length && inner.every((e) => e.kind === 'gainControl' || e.kind === 'applyRule' || e.kind === 'pump' || e.kind === 'setPT' || e.kind === 'grantKeywords' || e.kind === 'addTypes' || e.kind === 'grantAbility' || e.kind === 'loseAllAbilities')) {
      return inner.map((e) => ('duration' in e ? ({ ...e, duration: dur } as Effect) : e));
    }
  }
  // "Until end of turn, whenever X, Y": a delayed trigger that fires repeatedly this turn.
  if ((m = text.match(/^until end of turn, (whenever .+)$/i))) {
    const head = parseTriggerHead(m[1]);
    if (head && !head.also) {
      const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer });
      const inner = parseSentence(head.rest, sub);
      if (inner) return [{ kind: 'delayedTrigger', event: head.event, filter: head.filter, effects: inner, text, untilEndOfTurn: true }];
    }
  }
  // "Pay {3}{U}{U}. If you don't, you lose the game."
  if ((m = text.match(/^(?:you may )?pay (\{.+?\}|\d+ life)\. if you (?:do not|don't), (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (inner) {
      const life = m[1].match(/^(\d+) life$/);
      return [{ kind: 'unlessPays', who: YOU, cost: life ? { payLife: parseInt(life[1], 10) } : m[1], effects: inner, text }];
    }
  }
  // "You may X. If you do, Y" is split by the caller; handle "you may X" here.
  if ((m = text.match(/^(?:you may )?pay (\{.+?\}|\d+ life)\. if you do, (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (inner) {
      const life = m[1].match(/^(\d+) life$/);
      const energy = m[1].match(/^(?:\{E\})+$/);
      return [life ? { kind: 'ifPays', cost: '', payLife: parseInt(life[1], 10), effects: inner } : energy ? { kind: 'ifPays', cost: '', energy: (m[1].match(/\{E\}/g) ?? []).length, effects: inner } : { kind: 'ifPays', cost: m[1], effects: inner }];
    }
  }
  // "You may tap three untapped creatures you control. If you do, Y" / "you may discard a nonland card. If you do, Y"
  if ((m = text.match(/^(?:you may )?((?:tap|discard|sacrifice|exile|return|reveal|remove) .+?)\. if you do, (.+)$/i))) {
    const cost = parseCost(m[1].replace(/^[a-z]/, (c) => c.toUpperCase()));
    const inner = cost ? parseSentence(m[2], ctx) : null;
    if (cost && inner) return [{ kind: 'ifPays', cost: '', payCostSpec: cost, effects: inner, text: `${m[1]}?` }];
  }
  if ((m = text.match(/^at the beginning of (the next end step|your next end step|that turn's end step|the next turn's upkeep|your next upkeep|the next upkeep|the next cleanup step), (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (inner) {
      const upkeep = /upkeep/i.test(m[1]);
      return [{ kind: 'delayedTrigger', event: upkeep ? 'beginningOfUpkeep' : /cleanup/i.test(m[1]) ? 'cleanup' : 'beginningOfEndStep', filter: /your next/i.test(m[1]) ? { player: 'you' } : undefined, effects: inner, text, once: true }];
    }
  }
  if ((m = text.match(/^when you next cast (.+?) this turn, (.+)$/i))) {
    const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true });
    const inner = parseSentence(m[2].replace(/\bcopy it\b/i, 'copy that spell'), sub);
    if (inner) {
      const types = /instant or sorcery/i.test(m[1]) ? ['Instant', 'Sorcery'] : /^a spell$/i.test(m[1]) ? undefined : /^an instant spell$/i.test(m[1]) ? ['Instant'] : /^a sorcery spell$/i.test(m[1]) ? ['Sorcery'] : null;
      if (types !== null) return [{ kind: 'delayedTrigger', event: 'cast', filter: { player: 'you', object: types ? { types } : undefined }, effects: inner, text, once: true }];
      const noun = parseNoun(m[1].replace(/ spells$/i, ' spell'));
      if (noun) {
        const f = { ...noun.filter };
        delete f.zone;
        return [{ kind: 'delayedTrigger', event: 'cast', filter: { player: 'you', object: f }, effects: inner, text, once: true }];
      }
    }
  }
  // "At this turn's next end of combat, X" / "At end of combat, X" on a spell.
  if ((m = text.match(/^at (?:this turn's next end of combat|the end of combat|end of combat), (.+)$/i))) {
    const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true });
    const inner = parseSentence(m[1], sub);
    if (inner) return [{ kind: 'delayedTrigger', event: 'endOfCombat', effects: inner, text, once: true }];
  }
  // "When you discard a nonland card this way, X" (same paragraph as the discard): X happens if a matching card moved.
  if ((m = text.match(/^when (?:you )?(?:discard|exile|sacrifice|reveal|mill|destroy|return) (?:a|an|one or more) (.+?) this way, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1].replace(/ cards?$/i, ' card')}`);
    if (noun) {
      const saved = ctx.lastObj;
      ctx.lastObj = { ref: 'lastMoved' };
      const inner = parseSentence(m[2], ctx);
      if (inner) return [{ kind: 'conditional', if: { kind: 'amount', a: { kind: 'countRef', ref: { ref: 'lastMoved' }, filter: { ...noun.filter, zone: undefined } }, op: '>=', b: 1 }, then: inner }];
      ctx.lastObj = saved;
    }
  }
  if ((m = text.match(/^when (that creature|that permanent|it|that token|those creatures) (dies|die|leaves the battlefield|is put into a graveyard) this turn, (.+)$/i))) {
    const ref = objRef(m[1], ctx);
    const inner = ref ? parseSentence(m[3], ctx) : null;
    if (ref && inner) return [{ kind: 'delayedTrigger', event: /dies|die|graveyard/i.test(m[2]) ? 'dies' : 'leavesBattlefield', filter: { objectRef: ref }, effects: inner, text, once: true }];
  }
  // Delayed triggers: "X at the beginning of the next end step" / "…of the next turn's upkeep"
  if ((m = text.match(/^(.+?) at the beginning of (?:the next end step|your next end step|the next turn's upkeep|your next upkeep|the next upkeep)$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) {
      const upkeep = /upkeep/i.test(m[0]);
      const yours = /your next/i.test(m[0]);
      return [{ kind: 'delayedTrigger', event: upkeep ? 'beginningOfUpkeep' : 'beginningOfEndStep', filter: yours ? { player: 'you' } : undefined, effects: inner, text: text, once: true }];
    }
  }
  // No-op / informational sentences
  if (isNoOpSentence(text)) return [];
  if (/^(it is still a land|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|it cannot be regenerated|they cannot be regenerated|then shuffle|shuffle|you may choose the same mode more than once|~ can be your commander|this ability costs .+? less to activate.*|do this .+? times?|any player may activate this ability(?: but only as a sorcery)?|you may look at the top card of your library any time|you may choose not to untap ~ during your untap step|~'s power and toughness are each equal to .+|that player may .+? for as long as .+)$/i.test(text)) return [];
  if ((m = text.match(/^(.+?) unless (.+?) pays? (\{.+?\})$/i)) && !/^counter /i.test(text)) {
    const who = playerRef(m[2], ctx);
    const inner = parseSentence(m[1], ctx);
    if (who && inner) {
      return [{ kind: 'unlessPays', who, cost: m[3], effects: inner }];
    }
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) returns? (?:a|an|another|(\w+)) (.+?)(?: (?:you|they) control)? to (?:its|their) owner'?s'? hands?$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${m[4]}`);
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (who && inner && noun && typeof n === 'number') {
      return [{ kind: 'unlessPays', who, cost: { returnToHand: noun.filter, count: n }, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) discards? (?:a|an|(\w+)) (.+?) cards?$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${m[4]} card`);
    if (who && inner && noun) {
      return [{ kind: 'unlessPays', who, cost: { discard: m[3] ? (wordToNumber(m[3]) as number) ?? 1 : 1, filter: noun.filter }, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) discards? (?:a card|(\w+) cards?) at random$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (who && inner) {
      return [{ kind: 'unlessPays', who, cost: { discard: m[3] ? (wordToNumber(m[3]) as number) ?? 1 : 1, random: true }, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  // "unless they sacrifice a nonland permanent of their choice or discard a card"
  // "Each opponent loses 3 life unless they discard a card or sacrifice a creature."
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) discards? a card or sacrifices? (?:a|an) (.+?)(?: of (?:their|its) choice)?$/i))) {
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const inner = who && noun ? parseSentence(m[1], ctx) : null;
    if (who && noun && inner) {
      return [{ kind: 'unlessPays', who, cost: { discard: 1 }, effects: [{ kind: 'unlessPays', who, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' } }, effects: inner }] }];
    }
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) sacrifices? (?:a|an) (.+?) of (?:their|its) choice or discards? a card$/i))) {
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const inner = who && noun ? parseSentence(m[1], ctx) : null;
    if (who && noun && inner) {
      return [{ kind: 'unlessPays', who, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' } }, effects: [{ kind: 'unlessPays', who, cost: { discard: 1 }, effects: inner }] }];
    }
  }
  // "unless you exile the top creature card of your graveyard" / "unless you exile a card from your graveyard"
  if ((m = text.match(/^(.+?) unless you exile (?:the top (.+?) card of your graveyard|(?:a|an) (.+?) from your graveyard)$/i))) {
    const noun = parseNoun(`a ${(m[2] ?? m[3]).replace(/ card$/i, '')} card`);
    const inner = noun ? parseSentence(m[1], ctx) : null;
    if (noun && inner) return [{ kind: 'unlessPays', who: YOU, cost: { exileFromGraveyard: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: 1 }, effects: inner }];
  }
  // "unless you sacrifice two Islands" / "unless you sacrifice two lands"
  if ((m = text.match(/^(.+?) unless you sacrifice (\w+) (.+?)$/i))) {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${m[3].replace(/s$/, '')}`);
    const inner = typeof n === 'number' && noun ? parseSentence(m[1], ctx) : null;
    if (typeof n === 'number' && noun && inner) return [{ kind: 'unlessPays', who: YOU, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' }, count: n }, effects: inner }];
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) (?:discards? (?:a card|(\w+) cards?)|sacrifices? (?:a|an|another) (.+?)|pays? (\d+) life)$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (who && inner) {
      let cost: { discard: number } | { sacrifice: ObjectFilter } | { payLife: number } | null = null;
      if (m[5]) cost = { payLife: parseInt(m[5], 10) };
      else if (m[4]) {
        const noun = parseNoun(`a ${m[4]}`);
        if (!noun) return null;
        cost = { sacrifice: { ...noun.filter, other: /another/i.test(m[0]) || undefined } };
      } else cost = { discard: m[3] ? (wordToNumber(m[3]) as number) ?? 1 : 1 };
      return [{ kind: 'unlessPays', who, cost, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  // "~ deals 2 damage to that player unless they control a commander": do it unless the condition holds.
  if ((m = text.match(/^(.+?) unless (.+)$/i)) && !/^counter /i.test(text) && !/ pays? /i.test(m[2]) && !/^(?:they|that player|you|its controller|that opponent|each opponent|an opponent) (?:discards?|sacrifices?|returns?)/i.test(m[2])) {
    const cond = parseCondition(m[2].replace(/^they control/i, 'that player controls').replace(/^they have/i, 'that player has'), { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
    if (cond && cond.kind !== 'manual') {
      const saved = ctx.targets.length;
      const inner = parseSentence(m[1], ctx);
      if (inner) return [{ kind: 'conditional', if: { kind: 'not', c: cond }, then: inner }];
      ctx.targets.length = saved;
    }
  }
  if ((m = text.match(/^(you|each player|each opponent|target player|target opponent|that player|its controller) may (.+)$/i)) && !/^you may (?:play|cast) /i.test(text)) {
    const saved = ctx.targets.length;
    const savedPlayer = ctx.lastPlayer;
    const who = playerRef(m[1], ctx);
    if (who && who.ref !== 'controller') ctx.lastPlayer = who;
    const inner = who ? parseSentence(rephraseFirstPerson(m[2]), ctx) : null;
    if (who && inner) return [{ kind: 'may', effects: inner, who: who.ref === 'controller' ? undefined : who }];
    ctx.targets.length = saved;
    ctx.lastPlayer = savedPlayer;
  }
  if ((m = text.match(/^until (?:the end of your next turn|end of turn|your next turn), you may (?:play|cast) (.+)$/i))) {
    const ref = objRef(m[1], ctx) ?? ctx.lastObj ?? { ref: 'lastMoved' as const };
    return [{ kind: 'playFromExile', what: ref, duration: /end of turn$/i.test(m[0].split(',')[0]) ? 'thisTurn' : 'permanent' }];
  }
  // "If <condition>, <effects>" — the condition may itself contain commas ("If you control a God, a
  // Demigod, or a legendary enchantment, ..."), so try every split, real conditions first.
  if (/^if /i.test(text) && !/ would /i.test(text.split(',')[0])) {
    const cuts: number[] = [];
    for (let k = 3; k < text.length; k++) if (text[k] === ',') cuts.push(k);
    const rctx = { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer };
    for (const pass of [0, 1]) {
      for (const k of cuts) {
        const condText = text.slice(3, k).trim();
        const rest = text.slice(k + 1).trim();
        if (!condText || !rest) continue;
        const cond = parseCondition(condText, rctx);
        if (pass === 0 ? !cond : !!cond) continue;
        const saved = ctx.targets.length;
        const inner = parseSentence(rest, ctx);
        if (inner) return [{ kind: 'conditional', if: cond ?? { kind: 'manual', text: `Is this true: "${condText}"?` }, then: inner }];
        ctx.targets.length = saved;
      }
    }
  }
  // "<effects> if <condition>" — likewise try each " if " boundary.
  if (/ if /i.test(text) && !/^counter /i.test(text)) {
    const cuts: number[] = [];
    for (const mm of text.matchAll(/ if /gi)) if (mm.index !== undefined) cuts.push(mm.index);
    for (const k of cuts) {
      const head = text.slice(0, k);
      const condText = text.slice(k + 4);
      const saved = ctx.targets.length;
      const inner = parseSentence(head, ctx);
      if (inner) {
        const cond = parseCondition(condText, { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject });
        return [{ kind: 'conditional', if: cond ?? { kind: 'manual', text: `Is this true: "${condText}"?` }, then: inner }];
      }
      ctx.targets.length = saved;
    }
  }
  text = text.replace(/^((?:any number of |up to \w+ |one or two |one, two, or three |\w+ )?(?:target |they|those creatures)[^,]*?) each (gets?|gains?|deals?|loses?|has|have|becomes?|cannot|can't|draws?|discards?|sacrifices?|mills?)\b/i, '$1 $2');
  // "Until end of turn, if you tap a land for mana, it produces {U} instead of any other type."
  if ((m = text.match(/^until (?:end of turn|your next turn), (if .+?|whenever .+?)$/i))) {
    const inner = parseStatic(m[1].replace(/^if (?:you|a player|an opponent) taps? (?:a|an) (.+?) for mana,/i, (_x, n: string) => `If a ${n.replace(/ you control$/i, '')} is tapped for mana,`), true);
    if (inner && inner.length && inner.every((ab) => ab.kind === 'static' ? !!ab.rule && !!ab.ruleAffects : ab.kind === 'replacement')) {
      const out: Effect[] = [];
      for (const ab of inner) {
        if (ab.kind === 'static' && ab.rule) {
          const who: Ref | undefined = ab.ruleAffects === 'opponents' ? { ref: 'eachOpponent' } : ab.ruleAffects === 'allPlayers' ? { ref: 'eachPlayer' } : undefined;
          out.push({ kind: 'grantPlayerRule', rule: ab.rule, who });
        } else if (ab.kind === 'replacement') out.push({ kind: 'grantReplacement', spec: ab });
      }
      if (out.length) return out;
    }
  }
  text = text.replace(/^until your next turn, (.+?)$/i, (_m, rest: string) => (/ until your next turn$/i.test(rest) ? rest : `${rest} until your next turn`));
  // Patterns are written for "until end of turn"; retime whatever they produce.
  for (const [suffix, dur] of [[' until your next turn', 'untilYourNextTurn'], [' until end of combat', 'endOfCombat'], [' until the end of your next turn', 'untilYourNextTurn']] as const) {
    if (text.toLowerCase().endsWith(suffix)) {
      const saved = ctx.targets.length;
      const inner = parseSentence(text.slice(0, -suffix.length) + ' until end of turn', ctx);
      if (inner) return inner.map((e) => retime(e, dur));
      ctx.targets.length = saved;
    }
  }
  text = text.replace(/^until end of turn, (.+?)$/i, (_m, rest: string) => (/ until end of turn$/i.test(rest) ? rest : /, where X is /i.test(rest) ? rest.replace(/, where X is /i, ' until end of turn, where X is ') : `${rest} until end of turn`));
  if ((m = text.match(/^(.+?), where X is ([^,]+?), (.+)$/i)) && /\bX\b/.test(m[1])) {
    const a = amt(m[2], ctx);
    const inner = a !== null ? parseSentence(`${m[1]}, ${m[3]}`, ctx) : null;
    if (inner) return inner.map((e) => substituteX(e, a!));
  }
  if ((m = text.match(/^(.+?), where X is (\d+) minus (.+)$/i))) {
    const mm = m;
    const b = amt(mm[3], ctx);
    const inner = b !== null ? parseSentence(mm[1], ctx) : null;
    if (inner && b !== null) return inner.map((e) => substituteX(e, { kind: 'minus', a: parseInt(mm[2], 10), b }));
  }
  if ((m = text.match(/^(.+), where X is (.+)$/i))) {
    // "…deals X damage…, where X is the number of…" → substitute amount.
    // Fall through when either half fails: a later pattern may take the whole sentence.
    const a = amt(m[2], ctx);
    const inner = parseSentence(m[1], ctx);
    if (inner && a !== null) return inner.map((e) => substituteX(e, a));
  }
  if ((m = text.match(/^for each (.+?), (.+)$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastObj = { ref: 'iter' };
      const inner = parseSentence(m[2].replace(/\b(that|this) (creature|permanent|player|opponent|land|card)\b/gi, 'it'), sub);
      if (inner) return [{ kind: 'forEach', over: { ref: 'all', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } }, effects: inner }];
    }
    if (/^(opponent|player)$/i.test(m[1])) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastPlayer = { ref: 'iter' };
      const inner = parseSentence(m[2].replace(/\bthat (player|opponent)\b/gi, 'that player'), sub);
      if (inner) return [{ kind: 'forEach', over: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: inner }];
    }
    // "For each counter removed this way, ~ gets +1/+0 until end of turn": a countable quantity.
    {
      const times = amt(m[1], ctx) ?? amt(`the number of ${m[1]}`, ctx);
      if (times !== null && times !== undefined) {
        const saved = ctx.targets.length;
        const inner = parseSentence(m[2], ctx);
        if (inner) return [{ kind: 'repeat', times, effects: inner }];
        ctx.targets.length = saved;
      }
    }
  }
  for (const [re, fn] of POOL_PATTERNS) {
    const pm = text.match(re);
    if (pm) {
      const r = fn(pm, ctx);
      if (r) return r;
    }
  }
  for (const [re, fn] of PATTERNS) {
    const mm = text.match(re);
    if (!mm) continue;
    const saved = ctx.targets.length;
    const r = fn(mm, ctx);
    if (r) return r;
    ctx.targets.length = saved;
  }
  // "you may copy ~ and may choose a new target for the copy"
  if (/ and may choose (?:a new target|new targets) for (?:the|that) copy$/i.test(text)) {
    const r = parseSentence(text.replace(/ and may choose (?:a new target|new targets) for (?:the|that) copy$/i, '. You may choose new targets for the copy'), ctx);
    if (r) return r;
  }
  // "~ deals 5 damage to that permanent or player and the damage cannot be prevented instead"
  if (/ and (?:the )?damage cannot be prevented(?: instead)?$/i.test(text)) {
    const r = parseSentence(text.replace(/ and (?:the )?damage cannot be prevented(?: instead)?$/i, ''), ctx);
    if (r) return [...r, { kind: 'turnFlag', flag: 'noPrevention' }];
  }
  // "~ cannot be countered and the damage cannot be prevented"
  if (/^~ cannot be countered and (?:the )?damage cannot be prevented$/i.test(text)) return [{ kind: 'turnFlag', flag: 'noPrevention' }];
  // "It gets an additional -1/-1 until end of turn for each Desert you control."
  if (/\b(?:gets?|get) an additional [+-]/i.test(text)) {
    const r = parseSentence(text.replace(/\b(gets?|get) an additional /i, '$1 '), ctx);
    if (r) return r;
  }
  // "Investigate X times, where X is the total number of creatures those players control."
  if ((m = text.match(/^(.+?) (twice|three times|four times|(?:\w+|X) times)(?:, where X is (.+?))?$/i)) && !/ for each /i.test(m[1])) {
    const word = m[2].toLowerCase();
    const times = word === 'twice' ? 2 : word === 'three times' ? 3 : word === 'four times' ? 4 : /^x times$/.test(word) ? (m[3] ? amt(m[3], ctx) : ('X' as Amount)) : wordToNumber(word.replace(/ times$/, ''));
    if (times !== null && times !== undefined) {
      const saved = ctx.targets.length;
      const inner = parseSentence(m[1], ctx);
      if (inner) return [{ kind: 'repeat', times: times as Amount, effects: inner }];
      ctx.targets.length = saved;
    }
  }
  // "It gets +2/+2 until end of turn and can block an additional creature this turn."
  if ((m = text.match(/^(.+?) and (can block an additional creature this turn|cannot be blocked this turn)$/i))) {
    const saved = ctx.targets.length;
    const subj = m[1].match(/^(.+?) (?:gets?|gains?|has|have)\b/i);
    const left = parseSentence(m[1], ctx);
    const right = subj ? parseSentence(`${subj[1]} ${m[2]}`, ctx) : null;
    if (left && right) return [...left, ...right];
    ctx.targets.length = saved;
  }
  // "also put a +1/+1 counter on each other creature you control" → drop the connective.
  if (/^also /i.test(text)) {
    const r = parseSentence(text.replace(/^also /i, ''), ctx);
    if (r) return r;
  }
  // "you scry 2" → "scry 2"
  if ((m = text.match(/^you ((?:scry|surveil|mill|proliferate|investigate|explore|manifest|venture|amass|adapt|monstrosity|bolster|support|fateseal|clash|populate|learn|discover|incubate|connive) .*|(?:proliferate|investigate|populate|learn|connive))$/i))) {
    const r = parseSentence(m[1], ctx);
    if (r) return r;
  }
  // "each opponent sacrifices a creature for each death vote" → repeat the action once per unit.
  if ((m = text.match(/^(.+?) for each ([^,]+)$/i)) && !/^(?:draw|you gain|you lose|create|put|exile|mill|scry)\b/i.test(text)) {
    const saved = ctx.targets.length;
    const inner = parseSentence(m[1], ctx);
    const per = inner ? perEach(m[2], ctx) : null;
    if (inner && per !== null) return [{ kind: 'repeat', times: per, effects: inner }];
    ctx.targets.length = saved;
  }
  for (const [re, fn] of [...SEARCH_PATTERNS, ...REVEAL_UNTIL_PATTERNS]) {
    const sm = text.match(re);
    if (sm) {
      const saved = ctx.targets.length;
      const r = fn(sm, ctx);
      if (r) return r;
      ctx.targets.length = saved;
    }
  }
  // Compound: "A and B" / "A, then B"
  const CLAUSE_VERB = /\b(?:gets?|gains?|loses?|becomes?|deals?|draws?|discards?|sacrifices?|creates?|destroys?|exiles?|returns?|puts?|taps?|untaps?|mills?|has|have|is|are|cannot|can)\b/i;
  const splitters = [/, then /i, /\. then /i, / and then /i, /, and /i, / and /i, /, (?=(?:then )?(?:discards?|loses?|gains?|draws?|sacrifices?|mills?|creates?|exiles?|destroys?|returns?|puts?|scry|untaps?|taps?)\b)/i, /, (?=(?:up to |any number of |another |each |all |target |that |those |the |you |it |they |~)[^,]*?\b(?:gets?|gains?|loses?|becomes?|deals?|draws?|discards?|sacrifices?|creates?|destroys?|exiles?|returns?|puts?|taps?|untaps?|mills?|has|have|is|are|cannot|can)\b)/i, /, (?=(?:gets?|gains?|loses?|becomes?|has|have|is|are|cannot|can|deals?|must|doesn't|does not)\s)/i];
  for (const sp of splitters) {
    const idx = text.search(sp);
    if (idx <= 0) continue;
    let parts = text.split(sp);
    if (parts.length < 2) continue;
    // "A, B, and C until end of turn": the trailing duration applies to every clause.
    {
      const dm = parts[parts.length - 1].match(/ (until end of turn|until your next turn|until end of combat)$/i);
      const stative = /\b(?:gets?|gains?|becomes?|has|have|is|are|cannot|can)\b/i;
      if (dm && parts.length > 1 && !parts.slice(0, -1).some((x) => new RegExp(dm[1], 'i').test(x)) && parts.every((x) => stative.test(x))) {
        parts = parts.map((x, i) => (i === parts.length - 1 ? x : `${x} ${dm[1]}`));
      }
    }
    const saved = ctx.targets.length;
    const out: Effect[] = [];
    let ok = true;
    const verb = parts[0].match(/^(put|destroy|exile|return|create|tap|untap|sacrifice|counter|draw|discard|gain|lose|remove|reveal|search|mill|scry)\b/i)?.[1];
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      let r = parseSentence(p, ctx);
      if (!r && pi > 0 && verb && !/^(you|each player|each opponent|target player|target opponent|that player|those players|it|they|~|its|their)\b/i.test(p)) r = parseSentence(`${verb} ${p}`, ctx);
      // "target creature gains haste and gets +X/+0": the second clause shares the first clause's subject.
      if (!r && pi > 0 && /^(gets?|gains?|loses?|has|have|cannot|can|becomes?|is|deals?|must|fights?|doesn't|does not)\b/i.test(p) && ctx.lastObj) r = parseSentence(`it ${p}`, ctx);
      if (!r) {
        ok = false;
        break;
      }
      out.push(...r);
    }
    if (ok) return out;
    ctx.targets.length = saved;
  }
  // "Target player investigates." — parse the verb phrase as if the subject were you, then retarget.
  {
    const pm = text.match(/^(target player|target opponent|each player|each opponent|that player|that opponent|the player to your (?:left|right)|its controller|its owner|each other player|any player|the monarch|defending player|the chosen player|enchanted player|they) (.+)$/i);
    if (pm) {
      const who = playerRef(pm[1], ctx);
      const DECONJUGATE: Record<string, string> = {
        investigates: 'investigate', loses: 'lose', gains: 'gain', draws: 'draw', discards: 'discard',
        mills: 'mill', scries: 'scry', surveils: 'surveil', puts: 'put', reveals: 'reveal',
        untaps: 'untap', taps: 'tap', sacrifices: 'sacrifice', skips: 'skip', takes: 'take',
        creates: 'create', exiles: 'exile', shuffles: 'shuffle', searches: 'search',
        flips: 'flip', gets: 'get', plays: 'play', casts: 'cast', attaches: 'attach', removes: 'remove',
        manifests: 'manifest', explores: 'explore', connives: 'connive', proliferates: 'proliferate',
        ventures: 'venture', returns: 'return', destroys: 'destroy', chooses: 'choose', copies: 'copy',
      };
      const vm = pm[2].match(/^(\w+)(.*)$/);
      const base = vm ? DECONJUGATE[vm[1].toLowerCase()] : undefined;
      if (who && base) {
        const saved = ctx.targets.length;
        const savedPlayer = ctx.lastPlayer;
        const inner = parseSentence(`you ${base}${vm![2]}`, ctx);
        const RETARGETABLE = new Set(['draw', 'gainLife', 'loseLife', 'setLife', 'discard', 'mill', 'millBottom', 'scry', 'surveil', 'investigate', 'treasure', 'createToken', 'shuffle', 'skipTurn', 'skipStep', 'extraTurn', 'revealHand', 'manifest', 'searchLibrary', 'exileTop', 'addPoison', 'loseAllCounters', 'ventureIntoDungeon', 'explore', 'proliferate', 'connive', 'clue', 'food', 'lookAtTop', 'handToLibrary', 'shuffleZoneIntoLibrary', 'addCounters', 'flipCoin', 'sacrifice', 'exile', 'destroy', 'returnToHand', 'moveToZone', 'tap', 'untap', 'chooseObjects', 'putIntoGraveyard']);
        if (inner && inner.length && inner.every((e) => RETARGETABLE.has(e.kind))) {
          ctx.lastPlayer = who;
          return inner.map((e) => retargetToPlayer(e, who));
        }
        ctx.targets.length = saved;
        ctx.lastPlayer = savedPlayer;
      }
    }
  }
  // "You gain control of it": "you" is the default subject, so retry without it.
  if (/^you [a-z]/i.test(text) && !/^you may /i.test(text)) {
    const saved = ctx.targets.length;
    const inner = parseSentence(text.replace(/^you /i, ''), ctx);
    if (inner) return inner;
    ctx.targets.length = saved;
  }
  // Flavor ability word left on a mode or line ("Gigaflare — Destroy target permanent").
  if (/^(?:he|she) /i.test(text)) {
    const inner = parseSentence(text.replace(/^(?:he|she) /i, '~ '), ctx);
    if (inner) return inner;
  }
  if ((m = text.match(/^[A-Z][^\u2014]{0,40}\u2014 (.+)$/))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) return inner;
  }
  return null;
}

export function substituteX(e: Effect, a: Amount): Effect {
  const rep = (v: unknown): unknown => (v === 'X' ? a : v);
  const out: Record<string, unknown> = { ...e };
  for (const k of ['amount', 'power', 'toughness', 'count']) if (k in out) out[k] = rep(out[k]);
  return out as unknown as Effect;
}

/** "draw a card" after "you may" is already imperative; "have ~ deal" → "~ deals". */
function rephraseFirstPerson(s: string): string {
  return s
    .replace(/^have (.+?) deal /i, '$1 deals ')
    .replace(/^have (.+?) fight /i, '$1 fights ')
    .replace(/^have (.+?) (lose|gain|draw|discard|sacrifice|mill|exile|shuffle|reveal|scry|surveil) /i, (_m, who: string, verb: string) => `${who} ${verb}s `);
}

function ctx0(): void {
  /* marker for patterns that need no context */
}

/** Parse a full effect text (multiple sentences). */
export function parseEffects(text: string, ctx: ParseCtx): { effects: Effect[]; unhandled: string[] } {
  const effects: Effect[] = [];
  const unhandled: string[] = [];
  let m: RegExpMatchArray | null;
  const sents = sentences(text);
  let lastStart = 0;
  let curStart = 0;
  for (let i = 0; i < sents.length; i++) {
    let s = sents[i];
    // `lastStart` is where the previous sentence's effects begin: "X. If ~ was kicked, Y instead." replaces them.
    lastStart = curStart;
    curStart = effects.length;
    // "Prevent all damage … this turn. You gain life equal to the damage prevented this way."
    if (/^prevent |^the next time /i.test(s) && sents[i + 1] && /damage prevented this way/i.test(sents[i + 1])) {
      const followText = sents[i + 1].replace(/^for each 1 damage prevented this way, /i, '').replace(/\bthe damage prevented this way\b/i, 'that much');
      const saved = ctx.targets.length;
      const eff = parseSentence(s, ctx);
      const inner = eff ? parseSentence(followText, ctx) : null;
      if (eff && inner) {
        const last = eff[eff.length - 1];
        const perOne = /^for each 1 damage prevented this way, /i.test(sents[i + 1]);
        const body: Effect[] = perOne ? [{ kind: 'repeat', times: { kind: 'triggerAmount' }, effects: inner }] : inner;
        if (last.kind === 'preventAll') last.effects = body;
        else if (last.kind === 'preventDamage') eff[eff.length - 1] = { kind: 'preventAll', to: 'all', toRef: last.to, effects: body, amount: last.amount === 'all' ? undefined : typeof last.amount === 'number' ? last.amount : undefined };
        else eff.push(...body);
        effects.push(...eff);
        i++;
        continue;
      }
      ctx.targets.length = saved;
    }
    // "Each opponent sacrifices a creature." + "Each opponent who cannot loses 3 life."
    if ((m = s.match(/^each (?:player|opponent) who (?:cannot|can't|does not|doesn't) (.+)$/i)) && effects.length) {
      const prev = effects[effects.length - 1];
      if (prev.kind === 'sacrificeChoice' || prev.kind === 'discard') {
        const saved = ctx.targets.length;
        const inner = parseSentence(`that player ${m[1]}`, ctx) ?? parseSentence(m[1], ctx);
        if (inner) {
          const cost = prev.kind === 'sacrificeChoice' ? { sacrifice: prev.filter, count: 1 } : { discard: 1 };
          effects[effects.length - 1] = { kind: 'unlessPays', who: prev.who ?? { ref: 'eachOpponent' }, cost, effects: inner };
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    // "Otherwise, X" completes the previous conditional, optional effect or payment.
    if (/^otherwise, /i.test(s) && effects.length) {
      const prev = effects[effects.length - 1];
      if (prev.kind === 'conditional' || prev.kind === 'revealTop' || prev.kind === 'may' || prev.kind === 'ifPays' || prev.kind === 'flipCoin') {
        const saved = ctx.targets.length;
        const inner = parseSentence(s.replace(/^otherwise, /i, ''), ctx);
        if (inner) {
          if (prev.kind === 'flipCoin') prev.lose = [...(prev.lose ?? []), ...inner];
          else prev.else = [...(prev.else ?? []), ...inner];
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    // Merge "You may pay X." + "If you do, Y."
    // "Tap three untapped creatures you control." + "If you do, Y." — only when the merge parses.
    if (/^(?:you may )?(?:tap|discard|sacrifice|exile|reveal|remove) /i.test(s) && sents[i + 1] && /^(?:if|when) you do, /i.test(sents[i + 1])) {
      const merged = `${s}. ${sents[i + 1].replace(/^when you do, /i, 'If you do, ')}`;
      const savedT = ctx.targets.length;
      const tryIt = parseSentence(merged, ctx);
      if (tryIt) {
        effects.push(...tryIt);
        i++;
        continue;
      }
      ctx.targets.length = savedT;
    }
    // "Excess damage is dealt to that creature's controller instead." refines the damage just dealt.
    {
      const prev = effects[effects.length - 1];
      if (/^excess damage is dealt to that creature's controller instead$/i.test(s) && prev && prev.kind === 'damage') {
        (prev as { excessToController?: boolean }).excessToController = true;
        continue;
      }
    }
    // "Each opponent attacking that player does the same." repeats what the sentence before did.
    {
      const same = s.match(/^each (?:opponent|player)(?: attacking that player)? does the same$/i);
      if (same && effects.length) {
        effects.push({ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [effects[effects.length - 1]] });
        continue;
      }
    }
    // "If ~ was kicked, create twelve of those tokens instead." replaces the creation just made.
    {
      const kick = s.match(/^if ~ was kicked, create (\w+) of those tokens instead$/i);
      const prev = effects[effects.length - 1];
      if (kick && prev && prev.kind === 'createToken') {
        const n = wordToNumber(kick[1]);
        if (typeof n === 'number') {
          effects[effects.length - 1] = { kind: 'conditional', if: { kind: 'memoryFlag', key: 'kicked' }, then: [{ ...prev, count: n }], else: [prev] };
          continue;
        }
      }
    }
    // "Create a token. The token enters tapped and attacking." refines the creation just made.
    {
      const ta = s.match(/^(?:the token|the tokens|it|they|[A-Z][\w' ,-]*) enters? (tapped and attacking|tapped|attacking)$/i);
      const prev = effects[effects.length - 1];
      if (ta && prev && (prev.kind === 'createToken' || prev.kind === 'populate')) {
        if (/tapped/i.test(ta[1])) (prev as { tapped?: boolean }).tapped = true;
        if (/attacking/i.test(ta[1])) (prev as { attacking?: boolean }).attacking = true;
        continue;
      }
    }
    // "That player may pay {2}." + "If they do, Y." (+ "Otherwise, Z.")
    {
      const pm = s.match(/^(that player|target player|target opponent|each opponent|each player|any player|any opponent|they|its controller) may pay ((?:\{[^}]+\})+|\d+ life)$/i);
      const nxt = pm && sents[i + 1]?.match(/^if (?:they|that player|the player|a player|any player|an opponent) (do(?:es)?(?: not|n't)?), (.+)$/i);
      if (pm && nxt) {
        const who = /^any (?:player|opponent)$/i.test(pm[1]) ? ({ ref: 'eachPlayer' } as Ref) : playerRef(pm[1], ctx);
        const saved = ctx.targets.length;
        const inner = who ? parseSentence(nxt[2], ctx) : null;
        if (who && inner) {
          const negative = /not|n't/i.test(nxt[1]);
          const els = !negative ? sents[i + 2]?.match(/^otherwise, (.+)$/i) : null;
          const elseE = els ? parseSentence(els[1], ctx) : null;
          const lm = pm[2].match(/^(\d+) life$/i);
          const cost = lm ? { payLife: parseInt(lm[1], 10) } : pm[2];
          effects.push(negative ? { kind: 'unlessPays', who, cost, effects: inner } : { kind: 'unlessPays', who, cost, effects: elseE ?? [], thenEffects: inner });
          i += elseE ? 2 : 1;
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    if ((/^(?:you may )?pay/i.test(s) || /, pay (?:\{[^}]+\})+$/i.test(s)) && sents[i + 1] && /^(?:if|when) you do, |^if you (?:do not|don't), /i.test(sents[i + 1])) {
      s = `${s}. ${sents[i + 1].replace(/^when you do, /i, 'If you do, ')}`;
      i++;
    }
    // "Reveal the top card of your library. If it is a permanent card, A. Otherwise, B."
    if (/^reveal the top card of your library$/i.test(s) && sents[i + 1] && /^if it is (?:a|an) .+? card, /i.test(sents[i + 1])) {
      const cm = sents[i + 1].match(/^if it is (?:a|an) (.+?) card, (.+)$/i)!;
      const noun = parseNoun(`a ${cm[1]} card`);
      const sub = { ...ctx, lastObj: { ref: 'lastMoved' } as Ref };
      const thenE = noun ? parseSentence(cm[2], sub) : null;
      let elseE: Effect[] | null = null;
      let used = 1;
      if (thenE && sents[i + 2] && /^otherwise, /i.test(sents[i + 2])) {
        elseE = parseSentence(sents[i + 2].replace(/^otherwise, /i, ''), sub);
        if (elseE) used = 2;
      }
      if (noun && thenE) {
        effects.push({ kind: 'revealTop', ifMatches: noun.filter, then: thenE, else: elseE ?? undefined, destination: 'stay' });
        i += used;
        continue;
      }
    }
    if (/^reveal cards from the top of your library until you reveal /i.test(s) && sents[i + 1] && /^(put|you may put) /i.test(sents[i + 1])) {
      let merged = `${s}. ${sents[i + 1]}`;
      let used = 1;
      if (sents[i + 2] && /^(put the rest|and the rest)/i.test(sents[i + 2])) {
        merged = `${merged}. ${sents[i + 2]}`;
        used = 2;
      }
      // Prefer the single merged effect; otherwise leave the sentences apart so the held-pool patterns handle them.
      if (parseSentence(merged, newCtx({ ...ctx, targets: [...ctx.targets] }))) {
        s = merged;
        i += used;
      }
    }
    // "Search your library for a basic land card. Put it onto the battlefield tapped, then shuffle."
    if (/^search your library for (?:a|an|up to \w+|\w+) [^,]+$/i.test(s) && sents[i + 1] && /^(?:reveal (?:it|them|that card|those cards), )?(?:put|you may put) (?:it|them|that card|those cards) /i.test(sents[i + 1])) {
      const merged = parseSentence(`${s}, ${lc(sents[i + 1])}`, ctx);
      if (merged) {
        effects.push(...merged);
        i++;
        continue;
      }
    }
    // Merge "Reveal the top N cards of your library" with its follow-up sentences.
    if (/^reveal the top (?:\w+|X) cards of your library$/i.test(s)) {
      let j = i + 1;
      let merged = s;
      while (sents[j] && /^(you may put|put (?:all|any number|a |an |up to|the rest)|and the rest)/i.test(sents[j])) {
        merged = `${merged}. ${sents[j]}`;
        j++;
      }
      const probe = newCtx({ ...ctx, targets: [...ctx.targets] });
      if (j > i + 1 && parseSentence(merged, probe)) {
        s = merged;
        i = j - 1;
      }
    }
    // Merge "Look at the top N cards…" with its follow-up sentences.
    let whereX = '';
    const lw = s.match(/^(look at the top X cards of your library), where X is (.+)$/i);
    if (lw) {
      s = lw[1];
      whereX = lw[2];
    }
    if (/^look at the top (?:\w+|X) cards of your library$/i.test(s)) {
      let j = i + 1;
      let merged = s;
      while (sents[j] && /^(you may reveal|you may put|put (?:one|two|three|up to|any number|the rest|the other|a |an |it|them)|reveal (?:a|an|up to)|then put|and the rest)/i.test(sents[j])) {
        merged = `${merged}. ${sents[j].replace(/\bthe other\b/i, 'the rest').replace(/\bone of those cards\b/i, 'one of them').replace(/on the bottom of your library$/i, 'on the bottom of your library in a random order')}`;
        j++;
      }
      if (whereX) merged = `${merged}, where X is ${whereX}`;
      // Prefer the single merged effect; otherwise fall back to a held pool + compositional follow-up sentences.
      const probe = newCtx({ ...ctx, targets: [...ctx.targets] });
      if (j > i + 1 && parseSentence(merged, probe)) {
        s = merged;
        i = j - 1;
      } else {
        // "Look at the top X cards… You may put … from among them onto the battlefield, where X is your life total."
        if (!whereX && /top X cards/i.test(s)) {
          for (let k = i + 1; k < sents.length; k++) {
            const wm = sents[k].match(/^(.+), where X is (.+?)\.?$/i);
            if (wm) {
              whereX = wm[2];
              sents[k] = wm[1];
              break;
            }
          }
        }
        if (whereX) s = `${s}, where X is ${whereX}`;
      }
    }
    if (/^reveal the top card of your library$/i.test(s) && sents[i + 1] && /^if it is /i.test(sents[i + 1])) {
      s = `${s}. ${sents[i + 1]}`;
      i++;
      if (sents[i + 1] && /^otherwise, /i.test(sents[i + 1])) {
        s = `${s}. ${sents[i + 1]}`;
        i++;
      }
    }
    // Flip a coin. If you win the flip, X. If you lose the flip, Y.
    if (/^flip a coin$/i.test(s)) {
      const win = sents[i + 1]?.match(/^if you win the flip, (.+)$/i);
      const lose = sents[i + 2]?.match(/^if you lose the flip, (.+)$/i);
      if (win) {
        const w = parseSentence(win[1], ctx);
        const l = lose ? parseSentence(lose[1], ctx) : [];
        if (w && l) {
          effects.push({ kind: 'flipCoin', win: w, lose: l });
          i += lose ? 2 : 1;
          continue;
        }
      }
    }
    // Rounding instructions apply to every "half" amount in the text.
    if (/^round (up|down) each time$/i.test(s)) {
      const round = /up/i.test(s) ? 'up' : 'down';
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (o.kind === 'half') o.round = round;
          Object.values(o).forEach(walk);
        }
      };
      walk(effects);
      continue;
    }
    // "Search your library for two cards. Put one into your hand and the other into your graveyard, then shuffle."
    if (/^search your library for (?:two|\w+) cards$/i.test(s) && sents[i + 1] && /^put one into your hand and the other /i.test(sents[i + 1])) {
      const merged = parseSentence(`${s}, ${lc(sents[i + 1])}`, ctx);
      if (merged) {
        effects.push(...merged);
        i++;
        continue;
      }
    }
    // "If that spell is countered this way, exile it instead of putting it into its owner's graveyard."
    if (/^if that spell is countered this way, exile it instead/i.test(s) || /^if that spell would be put into (?:a|their|its owner's|that player's) graveyard(?: this way)?, exile it instead$/i.test(s)) {
      const last = effects[effects.length - 1];
      if (last && last.kind === 'counterSpell') {
        last.exileInstead = true;
        continue;
      }
    }
    // "Do X. If you do, Y." — the follow-up belongs to the optional effect just made.
    {
      const fu = s.match(/^if you do, (.+)$/i);
      const prev = effects[effects.length - 1];
      if (fu && prev && (prev.kind === 'may' || prev.kind === 'ifPays')) {
        const saved = ctx.targets.length;
        const inner = parseSentence(fu[1], ctx);
        if (inner) {
          prev.effects = [...prev.effects, ...inner];
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    // "Do X. If <condition>, repeat this process." — loop the previous sentence's effects.
    {
      const rp = s.match(/^(?:if (.+?), )?repeat this process(?: once| any number of times| again)?$/i);
      if (rp && effects.length > lastStart) {
        const cond = rp[1] ? parseCondition(rp[1], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer }) : { kind: 'manual' as const, text: 'Repeat this process?' };
        if (cond) {
          const previous = effects.slice(lastStart);
          effects.push({ kind: 'repeatWhile', condition: cond, effects: previous, max: /once/i.test(s) ? 1 : 50 });
          continue;
        }
      }
    }
    // "X. If ~ was kicked, Y instead." → if kicked, Y; otherwise X.
    s = s.replace(/^if (.+?), instead (.+)$/i, 'If $1, $2 instead');
    if ((m = s.match(/^(.+?) instead if (.+)$/i)) && effects.length > lastStart && !/ would /i.test(m[2])) s = `If ${m[2]}, ${m[1]} instead`;
    if ((m = s.match(/^if (.+?), (.+?) instead$/i)) && effects.length > lastStart && !/ would /i.test(m[1])) {
      const cond = parseCondition(m[1], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
      let inner = cond && cond.kind !== 'manual' ? parseSentence(m[2], ctx) : null;
      // "~ deals 5 damage instead": same targets as the previous damage effect, new amount.
      const dm = !inner && m[2].match(/^(?:~|it|.+?) deals (\w+|X) damage$/i);
      if (dm && cond && cond.kind !== 'manual') {
        const n = wordToNumber(dm[1]);
        const prev = effects.slice(lastStart);
        if (n !== null && prev.some((e) => e.kind === 'damage')) inner = prev.map((e) => (e.kind === 'damage' ? { ...e, amount: n } : e));
      }
      // "create three of those tokens instead": the same token with a different count.
      const tk = !inner && m[2].match(/^create (\w+|X) of (?:those|these) tokens$/i);
      if (tk && cond && cond.kind !== 'manual') {
        const n = tk[1].toUpperCase() === 'X' ? ('X' as const) : wordToNumber(tk[1]);
        const prev = effects.slice(lastStart);
        if (n !== null && prev.some((e) => e.kind === 'createToken')) inner = prev.map((e) => (e.kind === 'createToken' ? { ...e, count: n } : e));
      }
      // "~ deals twice that much damage instead" / "draw twice that many cards instead": scale the previous amount.
      const mult = !inner && m[2].match(/^(?:.+? )?deals (twice|three times|half) that much damage$/i);
      if (mult && cond && cond.kind !== 'manual') {
        const prev = effects.slice(lastStart);
        const f = /twice/i.test(mult[1]) ? 2 : /three/i.test(mult[1]) ? 3 : 0.5;
        if (prev.some((e) => e.kind === 'damage')) {
          inner = prev.map((e) => (e.kind === 'damage' ? { ...e, amount: f === 0.5 ? { kind: 'half' as const, a: e.amount, round: 'down' as const } : { kind: 'times' as const, a: f, b: e.amount } } : e));
        }
      }
      if (cond && inner) {
        const previous = effects.splice(lastStart);
        effects.push({ kind: 'conditional', if: cond, then: inner, else: previous });
        continue;
      }
    }
    // "If a spell cast this way would be put into a graveyard, exile it instead."
    if (/^if (?:a spell cast this way|that spell|it) would be put into (?:a|your|its owner's) graveyard(?: this way)?, exile it instead$/i.test(s)) {
      const last = effects[effects.length - 1];
      if (last && (last.kind === 'castFrom' || last.kind === 'castWithoutPaying')) {
        last.exileAfter = true;
        continue;
      }
      if (last && last.kind === 'may' && last.effects.some((x) => x.kind === 'castFrom' || x.kind === 'castWithoutPaying')) {
        for (const x of last.effects) if (x.kind === 'castFrom' || x.kind === 'castWithoutPaying') x.exileAfter = true;
        continue;
      }
    }
    // "X is the mana value of the exiled card." defines X for the effects before it.
    if ((m = s.match(/^X is (.+)$/i)) && effects.length) {
      const a = amt(m[1], ctx);
      if (a !== null) {
        for (let k = 0; k < effects.length; k++) effects[k] = substituteX(effects[k], a);
        continue;
      }
    }
    // "If you don't, X" after a "you may ..." sentence is the optional block's else branch.
    if (/^if (?:you|they) (?:do not|don't), /i.test(s) && effects.length) {
      const last = effects[effects.length - 1];
      const inner = last && last.kind === 'may' ? parseSentence(s.replace(/^if (?:you|they) (?:do not|don't), /i, ''), ctx) : null;
      if (inner && last && last.kind === 'may') {
        last.else = [...(last.else ?? []), ...inner];
        continue;
      }
    }
    // "If you do, X" / "When you do, X" after a "you may ..." sentence belongs inside the optional block.
    if (/^(?:if|when) (?:you|they) do, /i.test(s) && effects.length) {
      const inner = parseSentence(s.replace(/^(?:if|when) (?:you|they) do, /i, ''), ctx);
      if (inner) {
        const last = effects[effects.length - 1];
        if (last && last.kind === 'may') last.effects.push(...inner);
        else effects.push(...inner);
        continue;
      }
    }
    const r = parseSentence(s, ctx);
    if (r) effects.push(...r);
    else {
      unhandled.push(s);
      effects.push({ kind: 'manual', text: s });
    }
  }
  return { effects, unhandled };
}

/** "an artifact, a creature, an enchantment, and a land" → the individual noun phrases. */
function splitItemList(text: string): string[] {
  return text
    .split(/,? and |, /i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * "Each player chooses from among the permanents they control an artifact, a creature, ...,
 * then sacrifices the rest": keep one of each listed kind, lose everything else matching the base noun.
 */
function buildKeepList(whoWord: string, baseText: string, listText: string, act: string): Effect[] | null {
  const base = parseNoun(`a ${baseText.replace(/s$/i, '')}`) ?? parseNoun(`a ${baseText}`);
  const items = splitItemList(listText).map((x) => parseNoun(x));
  if (!base || !base.confident || !items.length || items.some((n) => !n || !n.confident)) return null;
  const key = `keep_${baseText.replace(/\W+/g, '')}`;
  const over: Ref = /opponent/i.test(whoWord) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
  const effects: Effect[] = items.map((n) => ({
    kind: 'chooseObjects',
    who: { ref: 'iter' },
    filter: { ...base.filter, ...n!.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } },
    count: 1,
    key,
    upTo: true,
  }));
  const rest: Ref = { ref: 'all', filter: { ...base.filter, zone: 'battlefield', controllerRef: { ref: 'iter' }, notChosenKey: key } };
  effects.push(act.toLowerCase() === 'exiles' ? { kind: 'exile', what: rest } : { kind: 'sacrifice', what: rest });
  return [{ kind: 'forEach', over, effects }];
}

/** "a black or red source of your choice" / "~" / "target creature": the damage source a prevention watches. */
function preventionSource(text: string, ctx: ParseCtx): { source?: ObjectFilter; sourceRef?: Ref } | null {
  const t = text.trim();
  const l = t.toLowerCase();
  if (l === '~') return { sourceRef: SELF };
  const choice = l.match(/^(?:a|an) (.*?)\s*sources? of your choice$/);
  if (choice) {
    const qual = choice[1].trim();
    if (!qual) return {};
    const cols = qual.split(/ or |\/| and\/or /).map((c) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[c.trim() as 'white']);
    if (cols.every((c) => !!c)) return { source: { colors: cols as Color[] } };
    const noun = parseNoun(`a ${qual} permanent`);
    return noun && noun.confident ? { source: { ...noun.filter, zone: undefined } } : null;
  }
  const ofChoice = l.match(/^(?:a|an) (.+?) of your choice$/);
  if (ofChoice) {
    const noun = parseNoun(`a ${ofChoice[1]}`);
    return noun && noun.confident ? { source: { ...noun.filter, zone: undefined } } : null;
  }
  if (/^target /i.test(t)) {
    const ref = objRef(t, ctx);
    return ref ? { sourceRef: ref } : null;
  }
  const noun = parseNoun(t);
  if (noun && noun.confident && noun.kind !== 'player') {
    const f = { ...noun.filter };
    delete f.zone;
    return { source: f };
  }
  return null;
}

/** "you and/or creatures you control" / "target creature": who a prevention protects. */
function preventionTo(text: string, ctx: ParseCtx): { to?: Extract<Effect, { kind: 'preventAll' }>['to']; toRef?: Ref } | null {
  const l = text.trim().toLowerCase().replace(/ this turn$/, '');
  if (l === 'you') return { to: 'you' };
  if (/^you and(?:\/or| or)? (?:creatures|permanents) you control$/.test(l) || /^(?:creatures|permanents) you control and(?:\/or)? you$/.test(l)) return { to: 'youAndCreaturesYouControl' };
  if (/^you and(?:\/or| or)? planeswalkers you control$/.test(l)) return { to: 'youAndPlaneswalkersYouControl' };
  if (/^~ and(?:\/or| or)? you$/.test(l) || /^you and(?:\/or| or)? ~$/.test(l)) return { to: 'you' };
  if (l === 'creatures you control') return { to: 'creaturesYouControl' };
  if (l === 'any target' || l === 'anything') return { to: 'all' };
  if (l === 'each creature and each player') return { to: 'all' };
  if (l === '~') return { to: 'all', toRef: SELF };
  const noun = parseNoun(text.trim());
  if (noun && (noun.each || noun.plural) && noun.kind !== 'player') return { to: { ...noun.filter, zone: 'battlefield' } };
  const ref = anyRef(text.trim(), ctx);
  return ref ? { to: 'all', toRef: ref } : null;
}

/** Rewrite endOfTurn durations produced by an "until end of turn" pattern to another duration. */
function retime<T>(value: T, dur: Duration): T {
  if (Array.isArray(value)) return value.map((v) => retime(v, dur)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'duration' && v === 'endOfTurn' ? dur : retime(v, dur);
    }
    return out as unknown as T;
  }
  return value;
}
