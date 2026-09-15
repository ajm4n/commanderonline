/** Sentence → Effect[] parser. */
import type { Effect, Ref, TargetSpec, TokenSpec, Duration, Color, ObjectFilter, Amount, Condition } from '@commander/engine';
import { TOKEN_PRESETS, parseAddManaText } from '@commander/engine';
import { wordToNumber, sentences, lc } from './text.js';
import { parseNoun, toTargetSpec, type ParsedNoun } from './nouns.js';
import { parseAmount } from './amounts.js';
import { parseCondition } from './conditions.js';

export interface ParseCtx {
  targets: TargetSpec[];
  lastObj: Ref | null;
  lastPlayer: Ref | null;
  /** Inside a trigger whose event carries an object / player. */
  triggerHasObject: boolean;
  triggerHasPlayer: boolean;
  /** The line is on an instant/sorcery (affects "~" meaning for return-to-hand etc.). */
  isSpell: boolean;
}

export function newCtx(partial: Partial<ParseCtx> = {}): ParseCtx {
  return { targets: [], lastObj: null, lastPlayer: null, triggerHasObject: false, triggerHasPlayer: false, isSpell: false, ...partial };
}

const SELF: Ref = { ref: 'self' };
const YOU: Ref = { ref: 'controller' };

const KEYWORD_WORDS = ['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance', 'haste', 'flash', 'defender', 'reach', 'menace', 'hexproof', 'indestructible', 'shroud', 'fear', 'intimidate', 'skulk', 'horsemanship', 'shadow', 'infect', 'wither', 'prowess', 'undying', 'persist', 'changeling', 'protection from white', 'protection from blue', 'protection from black', 'protection from red', 'protection from green', 'protection from all colors', 'protection from each color', 'protection from creatures', 'protection from artifacts', 'protection from everything', 'protection from instants', 'protection from sorceries', 'protection from planeswalkers', 'protection from colorless', 'protection from multicolored', 'protection from monocolored', 'hexproof from white', 'hexproof from blue', 'hexproof from black', 'hexproof from red', 'hexproof from green'];

export function parseKeywordList(text: string): string[] | null {
  const parts = text
    .toLowerCase()
    .replace(/,? and /g, ', ')
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (!KEYWORD_WORDS.includes(p)) return null;
    out.push(p.charAt(0).toUpperCase() + p.slice(1));
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
  const t = phrase.trim().replace(/[.,]$/, '');
  const l = t.toLowerCase();
  if (l === '~' || l === 'this') {
    ctx.lastObj = SELF;
    return SELF;
  }
  if (/^(it|them|they|that (creature|permanent|card|artifact|enchantment|land|planeswalker|token|spell)|those (creatures|permanents|cards|tokens)|the (creature|permanent|card)|that object|the (?:exiled|returned|chosen) cards?)$/.test(l)) {
    if (l.includes('token') && !ctx.lastObj) return { ref: 'lastCreated' };
    return ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : null);
  }
  if (/^(enchanted|equipped|fortified) (creature|permanent|land|player|artifact|planeswalker)$/.test(l)) return { ref: 'attachedTo' };
  if (/^the exiled cards?$/.test(l) || /^the cards? exiled with ~$/.test(l) || /^cards exiled with ~$/.test(l)) return { ref: 'chosen', key: 'exiled' };
  if (/^(that|those) tokens?$/.test(l) || l === 'the tokens' || l === 'the token') return { ref: 'lastCreated' };
  if (/^(that|the) spell$/.test(l)) return ctx.lastObj ?? { ref: 'stackTarget' };
  if (l === 'the chosen creature' || l === 'the chosen permanent') return { ref: 'chosen', key: 'chosen' };
  const gy = t.match(/^~ from your graveyard$/i);
  if (gy) return SELF;
  const noun = parseNoun(t);
  if (!noun) return null;
  if (noun.target) {
    const spec = toTargetSpec(noun);
    ctx.targets.push(spec);
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    if (noun.kind !== 'player') ctx.lastObj = ref;
    else ctx.lastPlayer = ref;
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
  if (l === 'that player' || l === 'that opponent' || l === 'they' || l === 'the player') return ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' } : null);
  if (l === 'its controller' || l === "that creature's controller" || l === "that permanent's controller" || l === 'the controller of that creature') return { ref: 'controllerOf', of: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  if (l === "~'s controller") return { ref: 'controllerOf', of: SELF };
  if (l === 'its owner' || l === "that card's owner") return { ref: 'ownerOf', of: ctx.lastObj ?? { ref: 'triggerObject' } };
  if (l === 'defending player' || l === 'the defending player') return { ref: 'defendingPlayer' };
  if (l === 'the active player') return { ref: 'activePlayer' };
  if (l === "enchanted player" || l === "that player's controller") return { ref: 'attachedTo' };
  if (l === 'the chosen player' || l === 'the chosen opponent') return { ref: 'chosen', key: 'opponent' };
  const noun = parseNoun(phrase);
  if (noun && noun.kind === 'player' && noun.target) {
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastPlayer = ref;
    return ref;
  }
  return null;
}

/** Object-or-player phrase (damage targets, "any target"). */
function anyRef(phrase: string, ctx: ParseCtx): Ref | null {
  const l = phrase.trim().toLowerCase();
  if (l === 'each creature and each player' || l === 'each creature and each planeswalker and each player') return null; // handled by caller
  return playerRef(phrase, ctx) ?? objRef(phrase, ctx);
}

const COLOR_MAP: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/** Parse "a 1/1 white Soldier creature token with vigilance" etc. */
export function parseTokenPhrase(text: string): { count: number | 'X'; token: TokenSpec; tapped?: boolean; attacking?: boolean } | null {
  let t = text.trim().replace(/\.$/, '');
  let tapped = false;
  let attacking = false;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(.*?)(?:,)? (?:that is|that are) tapped and attacking$/))) {
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
  if ((m = t.match(/^(a|an|\w+|X) tokens? that (?:is|are) (?:a )?cop(?:y|ies) of (.+)$/i))) {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    const ctx = newCtx({ triggerHasObject: true });
    const ref = objRef(m[2], ctx);
    if (!ref || ctx.targets.length) return null; // copy targets are handled by the caller pattern
    return { count: n, token: { name: 'Copy', typeLine: '', colors: [], copyOf: ref }, tapped, attacking };
  }
  m = t.match(/^(a|an|\w+|X) (.+?) tokens?(?: named ([A-Z][\w' ,-]*?))?(?: with (.+))?$/i);
  if (!m) return null;
  const n = wordToNumber(m[1]);
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
  return parseAmount(text, { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
}

/** Subject-verb helpers */
function subjectPlayer(subj: string | undefined, ctx: ParseCtx): Ref | null {
  if (subj === undefined || subj.trim() === '') return ctx.lastPlayer ?? YOU;
  const who = playerRef(subj, ctx);
  if (who && who.ref !== 'controller') ctx.lastPlayer = who;
  return who;
}

const PATTERNS: Pattern[] = [
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
    const noun = parseNoun(m[4]);
    if (!who || n === null || !noun) return null;
    const filter = { ...noun.filter };
    if (!filter.zone) filter.zone = 'battlefield';
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: { kind: 'times', a: n, b: { kind: 'count', filter } }, who } as Effect];
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
  [/^flip ~$/i, () => [{ kind: 'transform', what: SELF }]],
  [/^exile all graveyards$/i, () => [{ kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'exile' }]],
  [/^exile (.+?)'s graveyard$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'exile' }] : null;
  }],
  [/^(?:(.+?) )?exiles? (?:their|your) graveyard$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'exile' }] : null;
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
  [/^(.+?) does not untap during your next untap step$/i, (m, ctx) => {
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
  [/^(?:it|~|that creature|this creature) connives?$/i, () => [{ kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }, { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'chosen', key: 'lastDiscarded' }, filter: { nonland: true } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: SELF }] }]],
  [/^(.+?) connives?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }, { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'chosen', key: 'lastDiscarded' }, filter: { nonland: true } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }] }] : null;
  }],
  // Damage
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals (\w+|X) damage to (.+?)(?: for each (.+))?$/i, (m, ctx) => {
    const src = objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    if (!src) return null;
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    let amount: Amount = n;
    if (m[4]) {
      const noun = parseNoun(m[4]);
      if (!noun) return null;
      amount = { kind: 'times', a: n, b: { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } } };
    }
    return damageTo(m[3], amount, ctx, src);
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
  [/^(?:(.+?) )?sacrifices? (~|it|that creature|that permanent|enchanted creature|equipped creature)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'sacrifice', what: ref }] : null;
  }],
  [/^(?:(.+?) )?sacrifices? (?:a|an|another|(\w+)) (.+?)(?: of (?:their|your) choice)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    return [{ kind: 'sacrificeChoice', who, filter: { ...noun.filter, zone: 'battlefield', other: /another/i.test(m[0]) || undefined }, count: n }];
  }],
  // Indefinite choices: "return a land you control to its owner's hand", "tap an untapped creature you control", "exile a card from your graveyard"
  [/^(return|tap|untap|exile|destroy) (?:a|an|up to (\w+)) (.+?)(?: to (?:its|their) owner'?s'? hands?| to your hand)?$/i, (m, ctx) => {
    if (/target|each/i.test(m[3])) return null;
    const c = chooseRef(`a ${m[3]}`, ctx, YOU, !!m[2]);
    if (!c) return null;
    const verb = m[1].toLowerCase();
    const eff: Effect = verb === 'return' ? { kind: 'returnToHand', what: c.ref } : verb === 'tap' ? { kind: 'tap', what: c.ref } : verb === 'untap' ? { kind: 'untap', what: c.ref } : verb === 'exile' ? { kind: 'exile', what: c.ref } : { kind: 'destroy', what: c.ref };
    if (verb === 'return' && !/ to (?:its|their) owner'?s'? hands?| to your hand/i.test(m[0])) return null;
    return [...c.pre, eff];
  }],
  [/^(?:you may )?put (?:a|an|up to (\w+)) (.+?) cards? from your hand onto the battlefield( tapped)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]} card from your hand`, ctx, YOU, true);
    if (!c) return null;
    return [...c.pre, { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3] }];
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
  [/^return (.+?) to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  [/^return (.+?) to your hand$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  [/^return (.+?) to the battlefield(?: under (your|its owner's) control)?( tapped)?(?: with (?:a|an|\w+) ([+-]\d\/[+-]\d|\w+) counters? on it)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const e: Effect = { kind: 'returnToBattlefield', what: ref, tapped: !!m[3], controller: m[2] === "its owner's" ? 'owner' : 'you' };
    if (m[4]) e.counters = { counter: m[4], amount: 1 };
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
    const copy = m[1].match(/^(a|an|\w+|X) tokens? that (?:is|are) (?:a )?cop(?:y|ies) of (.+?)(?:, except (.+))?$/i);
    if (copy) {
      const n = wordToNumber(copy[1]);
      const ref = objRef(copy[2], ctx);
      if (n === null || !ref) return null;
      const token: TokenSpec = { name: 'Copy', typeLine: '', colors: [], copyOf: ref };
      if (copy[3]) {
        const kw = copy[3].match(/^(?:it|they) (?:has|have) (.+)$/i);
        const kws = kw ? parseKeywordList(kw[1]) : null;
        if (!kws) return null;
        token.exceptions = { keywords: kws };
      }
      ctx.lastObj = { ref: 'lastCreated' };
      return [{ kind: 'createToken', token, count: n }];
    }
    const t = parseTokenPhrase(m[1]);
    if (!t) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: t.count, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^investigate$/i, () => [{ kind: 'investigate' }]],
  [/^(?:(.+?) )?exiles? the top (?:card|(\w+|X) cards) of (?:your|their) library(?: face down)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exileTop', amount: n, who, faceDown: / face down$/i.test(m[0]) }];
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
  [/^put (?:a|an|(\w+|X)) ([+-]\d+\/[+-]\d+|\w+) counters? on (.+)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const isObjectTarget = !/^(you|each player|each opponent|target player|target opponent|that player)$/i.test(m[3]);
    const ref = isObjectTarget ? objRef(m[3], ctx) : playerRef(m[3], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[2], amount: n, on: ref }] : null;
  }],
  [/^put (?:a|an|(\w+|X)) ([+-]\d+\/[+-]\d+|\w+) counters? on (.+?) for each (.+)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(m[4]);
    if (n === null || !noun) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[2], amount: { kind: 'times', a: n, b: { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } } }, on: ref }] : null;
  }],
  [/^remove (?:a|an|all|(\w+|X)) ([+-]\d+\/[+-]\d+|\w+) counters? from (.+)$/i, (m, ctx) => {
    const n = /all/i.test(m[0].split(' ')[1]) ? 'all' : m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'removeCounters', counter: m[2], amount: n, on: ref }] : null;
  }],
  [/^(?:you )?gets? (?:a|an|(\w+)) (poison|experience) counters?$/i, (m) => [{ kind: 'addCounters', counter: m[2].toLowerCase(), amount: m[1] ? (wordToNumber(m[1]) ?? 1) : 1, on: YOU }]],
  [/^(?:you )?gets? ((?:\{E\})+)$/i, (m) => [{ kind: 'addCounters', counter: 'energy', amount: (m[1].match(/\{E\}/g) ?? []).length, on: YOU }]],
  [/^(.+?) gets? (?:a|an|(\w+)) poison counters?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'addCounters', counter: 'poison', amount: m[2] ? (wordToNumber(m[2]) ?? 1) : 1, on: who }] : null;
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
    const noun = parseNoun(m[4]);
    if (!ref || !noun) return null;
    const f = noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' as const };
    const p = parseInt(m[2], 10);
    const t = parseInt(m[3], 10);
    return [{ kind: 'pump', power: { kind: 'times', a: p, b: { kind: 'count', filter: f } }, toughness: { kind: 'times', a: t, b: { kind: 'count', filter: f } }, on: ref, duration: 'endOfTurn' }];
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
  [/^(.+?) becomes? (?:a|an) ([\dX]+)\/([\dX]+) (.+?) (?:creature|artifact creature)(?: with (.+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [{ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur }, { kind: 'addTypes', types: ['Creature'], subtypes: m[4].split(/\s+/).filter((w) => /^[A-Z]/.test(w)), on: ref, duration: dur }];
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
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
    const ref = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    return ref ? [] : null;
  }],
  // Reveal-and-discard: "You choose a nonland card from it. That player discards that card."
  [/^you choose (?:a|an|up to (\w+)) (?:(.+?) )?cards?(?: of that color| of the chosen color)? from (?:it|among them|that hand)$/i, (m, ctx) => {
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
  [/^counter (.+?)(?: unless its controller pays (\{.+\}|\d+))?$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    if (noun.kind !== 'spell' && noun.kind !== 'activatedOrTriggered') return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    const pays = m[2] ? (/^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2]) : undefined;
    return [{ kind: 'counterSpell', what: ref, unlessPays: pays }];
  }],
  // Search
  [/^search (your|their|that player's) library for (?:a|an|up to (\w+)) (?:(.+?) )?cards?(?:, reveal (?:it|them))?,?(?: and| then)? put (?:it|them|that card|those cards|the rest) (into (?:your|their) hand|onto the battlefield( tapped)?|on top of (?:your|their) library|into (?:your|their) graveyard)(?:, then shuffle| and shuffle|, then shuffle (?:your|their) library)?(?:\. then shuffle)?$/i, (m, ctx) => {
    const noun = m[3] ? parseNoun(`${m[3]} card`) : { filter: {} as ObjectFilter };
    ctx.lastObj = { ref: 'lastMoved' };
    if (!noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const who = m[1].toLowerCase() === 'your' ? undefined : ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : undefined);
    if (m[1].toLowerCase() !== 'your' && !who) return null;
    const dest = /hand/.test(m[4]) ? 'hand' : /battlefield/.test(m[4]) ? 'battlefield' : /top/.test(m[4]) ? 'top' : 'graveyard';
    return [{ kind: 'searchLibrary', who, filter: { ...noun.filter, zone: 'library' }, count: n, destination: dest, tapped: !!m[5], reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
  [/^search your library for (two|\w+) cards, put one into your hand and the other (into your graveyard|onto the battlefield|on top of your library)(?:, then shuffle)?$/i, (m) => {
    ctx0();
    const dest = /graveyard/.test(m[2]) ? 'graveyard' : /battlefield/.test(m[2]) ? 'battlefield' : 'top';
    return [{ kind: 'searchLibrary', filter: { zone: 'library' }, count: 1, destination: 'hand', shuffle: false }, { kind: 'searchLibrary', filter: { zone: 'library' }, count: 1, destination: dest, shuffle: true }];
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
  [/^copy (.+?)(?:\. You may choose new targets for the copy)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'copySpell', what: ref }] : null;
  }],
  // Attach
  [/^attach (.+?) to (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = objRef(m[2], ctx);
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
  [/^(.+?) phases out$/i, (m, ctx) => {
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
  [/^prevent all (combat )?damage that would be dealt (?:to (.+?) )?this turn$/i, (m, ctx) => {
    if (!m[2]) return [{ kind: 'manual', text: m[0] }];
    const ref = anyRef(m[2], ctx) ?? (m[2].toLowerCase() === 'you' ? YOU : null);
    return ref ? [{ kind: 'preventDamage', amount: 'all', to: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^prevent the next (\d+) damage that would be dealt to (.+?) this turn$/i, (m, ctx) => {
    const ref = anyRef(m[2], ctx);
    return ref ? [{ kind: 'preventDamage', amount: parseInt(m[1], 10), to: ref, duration: 'endOfTurn' }] : null;
  }],
  // Look at top
  [/^look at the top (\w+|X) cards of your library\.? put (?:one|(\w+)) of them into your hand and the rest (?:on the bottom of your library in a random order|into your graveyard|on the bottom of your library in any order)$/i, (m) => {
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
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?(?:reveal|put) (?:a|an|up to (\w+)) (.+?) cards? from among them(?: and put (?:it|them) into your hand)?(?:\.? put (?:it|them) into your hand)?\.? (?:put the rest|and the rest) (?:on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : 1;
    const noun = parseNoun(`${m[3]} card`);
    if (n === null || pick === null || !noun) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard$/i.test(m[0]) ? 'handRestGraveyard' : 'handRestBottom', filter: noun.filter, pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? put (?:a|an|up to (\w+)) (.+?) cards? from among them onto the battlefield( tapped)?(?: and the rest|\.? put the rest) (?:on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[3]} card`);
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
  [/^choose a color$/i, () => [{ kind: 'chooseColor', key: 'color' }]],
  [/^choose a creature type$/i, () => [{ kind: 'chooseCreatureType', key: 'creatureType' }]],
  [/^exchange life totals with (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'exchangeLife', a: YOU, b: who }] : null;
  }],
  [/^(.+?) explores?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'revealTop', ifMatches: { types: ['Land'] }, then: [{ kind: 'putIntoHand', what: { ref: 'lastMoved' } }], else: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }, { kind: 'may', prompt: 'Put the revealed card into your graveyard?', effects: [{ kind: 'moveToZone', what: { ref: 'lastMoved' }, zone: 'graveyard' }] }] }] : null;
  }],
  [/^venture into the dungeon$/i, () => [{ kind: 'ventureIntoDungeon' }]],
  [/^monstrosity (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'monstrosity', amount: n }];
  }],
  [/^flip a coin$/i, () => [{ kind: 'flipCoin', win: [] }]],
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
  if (/^(?:any number of|up to \w+) targets?$/i.test(t) || /^any target$/i.test(t) || /^up to (\w+) targets?$/i.test(t) || /^one or two targets$/i.test(t)) {
    const um = t.match(/^up to (\w+) targets?$/i);
    const n = um ? wordToNumber(um[1]) : /^one or two/i.test(t) ? 2 : 1;
    ctx.targets.push({ description: t, kind: 'any', min: um ? 0 : 1, max: typeof n === 'number' ? n : 10 });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [mk(ref)];
  }
  const ref = anyRef(t, ctx);
  return ref ? [mk(ref)] : null;
}

/** Informational text the engine needs no code for (or that players handle trivially by hand). */
export function isNoOpSentence(text: string): boolean {
  return /^(draft ~ face up|play with the top card of your library revealed|it is still a land|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|it cannot be regenerated|they cannot be regenerated|you may choose the same mode more than once|~ can be your commander|any player may activate this ability|you may look at the top card of your library any time|you may choose not to untap ~ during your untap step|~'s power and toughness are each equal to .+|doctor's companion|fuse|~ enters prepared|partner|friends forever|choose a background|this spell cannot be countered|~ cannot be countered)\.?$/i.test(text.trim());
}

/** Parse one sentence; returns null if not understood. */
export function parseSentence(s: string, ctx: ParseCtx): Effect[] | null {
  let text = s.trim().replace(/\.$/, '');
  if (!text) return [];
  text = text.replace(/^then,? /i, '');
  text = rephraseFirstPerson(text);
  let m: RegExpMatchArray | null;
  // "You may X. If you do, Y" is split by the caller; handle "you may X" here.
  if ((m = text.match(/^(?:you may )?pay (\{.+?\}|\d+ life)\. if you do, (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (!inner) return null;
    const life = m[1].match(/^(\d+) life$/);
    const energy = m[1].match(/^(?:\{E\})+$/);
    return [life ? { kind: 'ifPays', cost: '', payLife: parseInt(life[1], 10), effects: inner } : energy ? { kind: 'ifPays', cost: '', energy: (m[1].match(/\{E\}/g) ?? []).length, effects: inner } : { kind: 'ifPays', cost: m[1], effects: inner }];
  }
  // Delayed triggers: "X at the beginning of the next end step" / "…of the next turn's upkeep"
  if ((m = text.match(/^(.+?) at the beginning of (?:the next end step|your next end step|the next turn's upkeep|your next upkeep|the next upkeep)$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (!inner) return null;
    const upkeep = /upkeep/i.test(m[0]);
    const yours = /your next/i.test(m[0]);
    return [{ kind: 'delayedTrigger', event: upkeep ? 'beginningOfUpkeep' : 'beginningOfEndStep', filter: yours ? { player: 'you' } : undefined, effects: inner, text: text, once: true }];
  }
  // No-op / informational sentences
  if (isNoOpSentence(text)) return [];
  if (/^(it is still a land|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|it cannot be regenerated|they cannot be regenerated|then shuffle|shuffle|you may choose the same mode more than once|~ can be your commander|this ability costs .+? less to activate for each .+|do this .+? times?|any player may activate this ability|you may look at the top card of your library any time|you may choose not to untap ~ during your untap step|~'s power and toughness are each equal to .+|that player may .+? for as long as .+)$/i.test(text)) return [];
  if ((m = text.match(/^(.+?) unless (.+?) pays? (\{.+?\})$/i)) && !/^counter /i.test(text)) {
    const who = playerRef(m[2], ctx);
    const inner = parseSentence(m[1], ctx);
    if (!who || !inner) return null;
    return [{ kind: 'unlessPays', who, cost: m[3], effects: inner }];
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent) (discards? a card|sacrifices? (?:a|an) (?:creature|permanent|artifact|land|nonland permanent))$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (!who || !inner) return null;
    return [{ kind: 'unlessPays', who, cost: /discard/i.test(m[3]) ? 'discard' : 'sacrifice', effects: inner, text: m[3] }];
  }
  if ((m = text.match(/^(you|each player|each opponent|target player|target opponent|that player|its controller) may (.+)$/i)) && !/^you may (?:play|cast) /i.test(text)) {
    const saved = ctx.targets.length;
    const who = playerRef(m[1], ctx);
    const inner = who ? parseSentence(rephraseFirstPerson(m[2]), ctx) : null;
    if (who && inner) return [{ kind: 'may', effects: inner, who: who.ref === 'controller' ? undefined : who }];
    ctx.targets.length = saved;
  }
  if ((m = text.match(/^until (?:the end of your next turn|end of turn|your next turn), you may (?:play|cast) (.+)$/i))) {
    const ref = objRef(m[1], ctx) ?? ctx.lastObj ?? { ref: 'lastMoved' as const };
    return [{ kind: 'playFromExile', what: ref, duration: /end of turn$/i.test(m[0].split(',')[0]) ? 'thisTurn' : 'permanent' }];
  }
  if ((m = text.match(/^if (.+?), (.+)$/i))) {
    const cond = parseCondition(m[1], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject });
    const inner = parseSentence(m[2], ctx);
    if (!inner) return null;
    return [{ kind: 'conditional', if: cond ?? { kind: 'manual', text: `Is this true: "${m[1]}"?` }, then: inner }];
  }
  if ((m = text.match(/^(.+?) if (.+)$/i)) && !/^counter /i.test(text)) {
    const inner = parseSentence(m[1], ctx);
    if (inner) {
      const cond = parseCondition(m[2], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject });
      return [{ kind: 'conditional', if: cond ?? { kind: 'manual', text: `Is this true: "${m[2]}"?` }, then: inner }];
    }
  }
  text = text.replace(/^((?:any number of |up to \w+ )?target (?:players|opponents)) each /i, '$1 ');
  if ((m = text.match(/^(.+?), where X is (.+)$/i))) {
    // "…deals X damage…, where X is the number of…" → substitute amount
    const a = amt(m[2], ctx);
    const inner = parseSentence(m[1], ctx);
    if (!inner || a === null) return null;
    return inner.map((e) => substituteX(e, a));
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
  }
  for (const [re, fn] of PATTERNS) {
    const mm = text.match(re);
    if (!mm) continue;
    const saved = ctx.targets.length;
    const r = fn(mm, ctx);
    if (r) return r;
    ctx.targets.length = saved;
  }
  // Compound: "A and B" / "A, then B"
  const splitters = [/, then /i, /\. then /i, / and then /i, /, and /i, / and /i];
  for (const sp of splitters) {
    const idx = text.search(sp);
    if (idx <= 0) continue;
    const parts = text.split(sp);
    if (parts.length < 2) continue;
    const saved = ctx.targets.length;
    const out: Effect[] = [];
    let ok = true;
    for (const p of parts) {
      const r = parseSentence(p, ctx);
      if (!r) {
        ok = false;
        break;
      }
      out.push(...r);
    }
    if (ok) return out;
    ctx.targets.length = saved;
  }
  return null;
}

function substituteX(e: Effect, a: Amount): Effect {
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
  const sents = sentences(text);
  for (let i = 0; i < sents.length; i++) {
    let s = sents[i];
    // Merge "You may pay X." + "If you do, Y."
    if (/^(?:you may )?pay/i.test(s) && sents[i + 1] && /^if you do, /i.test(sents[i + 1])) {
      s = `${s}. ${sents[i + 1]}`;
      i++;
    }
    // Merge "Look at the top N cards…" with its follow-up sentences.
    if (/^look at the top (?:\w+|X) cards of your library$/i.test(s)) {
      let j = i + 1;
      while (sents[j] && /^(you may reveal|you may put|put (?:one|two|three|up to|any number|the rest|a |an |it|them)|reveal (?:a|an|up to)|then put|and the rest)/i.test(sents[j])) {
        s = `${s}. ${sents[j]}`;
        j++;
      }
      if (j > i + 1) i = j - 1;
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
    if (/^if that spell is countered this way, exile it instead/i.test(s)) {
      const last = effects[effects.length - 1];
      if (last && last.kind === 'counterSpell') {
        last.exileInstead = true;
        continue;
      }
    }
    // "If you do, X" after a "you may ..." sentence belongs inside the optional block.
    if (/^if you do, /i.test(s) && effects.length) {
      const inner = parseSentence(s.replace(/^if you do, /i, ''), ctx);
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
