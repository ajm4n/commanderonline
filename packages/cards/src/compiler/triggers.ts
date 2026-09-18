/** Trigger head parsing: "Whenever X, " → event + filter. */
import type { GameEventName, TriggerFilter, ZoneName } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { parseCondition } from './conditions.js';
import { wordToNumber } from './text.js';
import type { ObjectFilter } from '@commander/engine';

export interface TriggerHead {
  /** State triggers ("When ~ has no counters on it"): the condition that must become true. */
  stateCondition?: import('@commander/engine').Condition;
  event: GameEventName;
  filter?: TriggerFilter;
  zone?: ZoneName | ZoneName[];
  leaves?: boolean;
  hasObject: boolean;
  hasPlayer: boolean;
  /** Effects text after the comma. */
  rest: string;
  /** Extra trigger heads for "attacks or blocks". */
  also?: Omit<TriggerHead, 'rest' | 'also'>[];
  /** "When ~ exploits a creature": the effects run only if a creature was sacrificed on entering. */
  exploit?: boolean;
  /** "Whenever a Knight you control deals combat damage to a player": "that creature" is the damage source, not the event object. */
  objectIsSource?: boolean;
}

function nounFilter(text: string, opts: { defaultYou?: boolean } = {}) {
  const noun = parseNoun(text.trim());
  if (!noun) return null;
  const f = { ...noun.filter };
  delete f.zone;
  const tf: TriggerFilter = { object: f };
  if (noun.other) tf.object = { ...f, other: true };
  if (f.controller === 'you') {
    delete tf.object!.controller;
    tf.objectController = 'you';
  } else if (f.controller === 'opponent') {
    delete tf.object!.controller;
    tf.objectController = 'opponent';
  } else if (opts.defaultYou) tf.objectController = 'you';
  return tf;
}

export function parseTriggerHead(line: string): TriggerHead | null {
  // "When a Dragon you control enters" behaves like "Whenever ..."; "attacks while saddled" is an attack trigger with a condition.
  line = line
    .replace(/ is put into graveyards from anywhere\b/i, ' is put into a graveyard from anywhere')
    .replace(/^When (a|an|another|one or more) /, 'Whenever $1 ')
    .replace(/^When (~|you|equipped creature|enchanted creature|enchanted player|your commander) (attacks|blocks|deals|casts|enters|dies|cycles|becomes|taps|untaps)\b/i, 'Whenever $1 $2')
    .replace(/^Whenever (~(?: and ~)?) (enter|attack|block|deal|die|become|tap|untap)\b/i, (_x, who: string, verb: string) => `Whenever ${who} ${verb}s`)
    .replace(/^Whenever ~ attack, /, 'Whenever ~ attacks, ')
    .replace(/^Whenever you attack a player with /i, 'Whenever you attack with ')
    .replace(/^Whenever ~ attacks while saddled, /i, 'Whenever ~ attacks, if ~ is saddled, ')
    .replace(/^Whenever ~ attacks for the first time each turn, /i, 'Whenever ~ attacks, ')
    .replace(/^At the beginning of combat on each player's turn, /i, 'At the beginning of combat on each turn, ')
    .replace(/deals (combat )?damage to (a player|an opponent) or battle\b/i, 'deals $1damage to $2')
    .replace(/deals (combat )?damage to a player or planeswalker\b/i, 'deals $1damage to a player');
  {
    const sm = line.match(/^Whenever (?:a|an|one or more) (.+?) you control deals? (combat )?damage to (an opponent|a player), (.+)$/i);
    if (sm) {
      const noun = parseNoun(`a ${sm[1]}`);
      if (noun) return { event: 'dealtDamage', filter: { player: /opponent/i.test(sm[3]) ? 'opponent' : 'any', toPlayer: true, combat: sm[2] ? true : undefined, source: { ...noun.filter, controller: 'you' } }, hasObject: true, hasPlayer: true, objectIsSource: true, rest: sm[4] };
    }
    const nm = line.match(/^Whenever you cast a spell other than your first spell each turn, (.+)$/i);
    if (nm) return { event: 'cast', filter: { player: 'you', minNthThisTurn: 2 }, hasObject: true, hasPlayer: true, rest: nm[1] };
  }
  // "Whenever you cast an instant, sorcery, or Wizard spell, ..." — the type list contains commas.
  {
    const cl = line.match(/^When(?:ever)? (you cast|a player casts|an opponent casts) (?:a|an) ([^,]+(?:, [^,]+)+) spell, (.+)$/i);
    if (cl) {
      const noun = parseNoun(`a ${cl[2]} spell`);
      if (noun && noun.confident) {
        const f = { ...noun.filter };
        delete f.zone;
        const who = /^you cast$/i.test(cl[1]) ? ('you' as const) : /opponent/i.test(cl[1]) ? ('opponent' as const) : undefined;
        return { event: 'cast', filter: { player: who, object: f }, hasObject: true, hasPlayer: true, rest: cl[3] };
      }
    }
  }
  {
    // "Whenever ~ attacks or blocks while you control a Dinosaur, X" → the condition becomes an intervening "if".
    const wm = line.match(/^(When(?:ever)? [^,]+?) while (.+?), (.+)$/i);
    if (wm && !/for as long as/i.test(line)) {
      const h = parseTriggerHead(`${wm[1]}, if ${wm[2]}, ${wm[3]}`);
      if (h) return h;
    }
    const cp = line.match(/^At the beginning of the chosen (?:player|opponent)'s (upkeep|end step|draw step), (.+)$/i);
    if (cp) return { event: cp[1].toLowerCase() === 'upkeep' ? 'beginningOfUpkeep' : cp[1].toLowerCase() === 'end step' ? 'beginningOfEndStep' : 'beginningOfDraw', filter: { custom: 'chosenPlayersStep' }, hasObject: false, hasPlayer: true, rest: cp[2] };
  }
  {
    // "Whenever one or more cards leave your graveyard during your turn, X" → same trigger, restricted to your turn.
    const dm = line.match(/^(When(?:ever)? .+?) during your turn, (.+)$/i);
    if (dm) {
      const h = parseTriggerHead(`${dm[1]}, ${dm[2]}`);
      if (h) return { ...h, filter: { ...(h.filter ?? {}), yourTurn: true } };
    }
  }
  {
    // Compound heads: "When ~ enters or transforms into ~, X" / "At the beginning of your upkeep and whenever enchanted land becomes tapped, X" / "When you cycle ~ and when ~ dies, X"
    // Try each way of splitting the head in turn; the first split whose halves both parse wins.
    const splits: [string, string][] = [];
    {
      const c1 = line.match(/^((?:When(?:ever)?|At the beginning of) [^,]+?) (?:and|or) ((?:when(?:ever)?|at the beginning of) [^,]+?), (.+)$/i);
      if (c1) {
        const bHalf = `${c1[2].charAt(0).toUpperCase()}${c1[2].slice(1)}`.replace(/^(When(?:ever)?) it /i, '$1 ~ ');
        splits.push([`${c1[1]}, ${c1[3]}`, `${bHalf}, ${c1[3]}`]);
      }
      const c2 = line.match(/^(When(?:ever)? ~) ([^,]+?) or ([^,]+?), (.+)$/i);
      if (c2) splits.push([`${c2[1]} ${c2[2]}, ${c2[4]}`, `${c2[1]} ${c2[3]}, ${c2[4]}`]);
      const c3 = line.match(/^(When(?:ever)?) (.+?) or (.+?), (.+)$/i);
      if (c3) splits.push([`${c3[1]} ${c3[2]}, ${c3[4]}`, `${c3[1]} ${c3[3]}, ${c3[4]}`]);
      const c4 = line.match(/^(When(?:ever)?) (.+?) or ([^,]+?), (.+)$/i);
      if (c4) splits.push([`${c4[1]} ${c4[2]}, ${c4[4]}`, `${c4[1]} ${c4[3]}, ${c4[4]}`]);
    }
    for (const [headA, headB] of splits) {
      const a = parseTriggerHead(headA);
      if (!a) continue;
      const b = parseTriggerHead(headB);
      // Rooms are not implemented: "and whenever you fully unlock a Room" can never fire here, so keep the other half.
      if (!b) {
        if (/unlock/i.test(headB)) return a;
        continue;
      }
      const { rest: _r, also: _a, ...bHead } = b;
      void _r;
      void _a;
      return { ...a, also: [...(a.also ?? []), bHead, ...(b.also ?? [])] };
    }
    const lv = line.match(/^Whenever (?:one or more |a |an |another )?(.+?) (?:leaves?|leave) the battlefield without dying, (.+)$/i);
    if (lv) {
      const noun = parseNoun(`a ${lv[1]}`);
      if (noun) return { event: 'leavesBattlefield', filter: { object: { ...noun.filter, zone: undefined }, notToZone: 'graveyard' }, hasObject: true, hasPlayer: false, rest: lv[2] };
    }
    const pg = line.match(/^When(?:ever)? (?:enchanted|equipped) (?:artifact|permanent|creature|land|enchantment|[A-Z]\w+) (?:is put into a graveyard|dies|is put into a graveyard from the battlefield), (.+)$/i);
    if (pg) return { event: /dies|from the battlefield/i.test(pg[0]) ? 'dies' : 'putIntoGraveyard', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, leaves: true, rest: pg[1] };
    const es = line.match(/^At the beginning of the (end step|upkeep) of (?:enchanted|equipped) \w+'s controller, (.+)$/i);
    if (es) return { event: es[1].toLowerCase() === 'upkeep' ? 'beginningOfUpkeep' : 'beginningOfEndStep', filter: { custom: 'attachedControllersUpkeep' }, hasObject: false, hasPlayer: true, rest: es[2].replace(/\b(?:the|that) (creature|permanent|land|artifact|enchantment)\b(?!')/gi, 'enchanted $1') };
    const ns = line.match(/^Whenever (a player|an opponent|you) casts? (?:their|your) (second|third|fourth) spell each turn, (.+)$/i);
    if (ns) return { event: 'cast', filter: { player: ns[1] === 'you' ? 'you' : /opponent/i.test(ns[1]) ? 'opponent' : 'any', nthThisTurn: ns[2].toLowerCase() === 'second' ? 2 : ns[2].toLowerCase() === 'third' ? 3 : 4 }, hasObject: true, hasPlayer: true, rest: ns[3] };
    const sd = line.match(/^Whenever (?:a|an|one or more) (.+?) (?:is|are) sacrificed or destroyed, (.+)$/i);
    if (sd) {
      const noun = parseNoun(`a ${sd[1]}`);
      if (noun) return { event: 'sacrifice', filter: { object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: sd[2], also: [{ event: 'dies', filter: { object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true }] };
    }
    const rm = line.match(/^Whenever (?:a|an|one or more) (.+?) (?:is|are) returned to your hand, (.+)$/i);
    if (rm) {
      const noun = parseNoun(`a ${rm[1]}`);
      if (noun) return { event: 'returnedToHand', filter: { player: 'you', object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: rm[2] };
    }
    const tp = line.match(/^Whenever you tap (?:an untapped |a |an )?(.+?), (.+)$/i);
    if (tp && !/for mana/i.test(tp[1])) {
      const noun = parseNoun(`a ${tp[1]}`);
      if (noun) return { event: 'tapped', filter: { object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: false, rest: tp[2] };
    }
    const xe = line.match(/^Whenever you exert (?:a|an) (.+?), (.+)$/i);
    if (xe) {
      const noun = parseNoun(`a ${xe[1]}`);
      if (noun) return { event: 'exerted', filter: { player: 'you', object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: xe[2] };
    }
    const em = line.match(/^Whenever you expend (\d+), (.+)$/i);
    if (em) return { event: 'expend', filter: { player: 'you', custom: `expend:${em[1]}` }, hasObject: false, hasPlayer: true, rest: em[2] };
    const am = line.match(/^Whenever (a player|an opponent|you) activates? an ability(?: of (?:a|an) (.+?))?( that is not a mana ability| that isn't a mana ability)?, (.+)$/i);
    if (am) {
      const noun = am[2] ? parseNoun(`a ${am[2]}`) : null;
      if (!am[2] || noun) return { event: 'abilityActivated', filter: { player: am[1] === 'you' ? 'you' : /opponent/i.test(am[1]) ? 'opponent' : 'any', object: noun?.filter, custom: am[3] ? 'nonManaAbility' : undefined }, hasObject: true, hasPlayer: true, rest: am[4] };
    }
    const xm = line.match(/^Whenever you activate an exhaust ability, (.+)$/i);
    if (xm) return { event: 'abilityActivated', filter: { player: 'you', custom: 'exhaust' }, hasObject: true, hasPlayer: true, rest: xm[1] };
    const lm = line.match(/^When(?:ever)? you play another land, (.+)$/i);
    if (lm) return { event: 'landPlayed', filter: { player: 'you', object: { other: true } }, hasObject: true, hasPlayer: true, rest: lm[1] };
    const tm = line.match(/^When(?:ever)? ~ transforms into [^,]+, (.+)$/i);
    if (tm) return { event: 'transformed', filter: { self: true }, hasObject: true, hasPlayer: false, rest: tm[1] };
    const dm2 = line.match(/^Whenever (?:a|an) (.+?) deals damage to you, (.+)$/i);
    if (dm2 && !/^source/i.test(dm2[1])) {
      const noun = parseNoun(`a ${dm2[1]}`);
      if (noun) return { event: 'dealtDamage', filter: { player: 'you', toPlayer: true, source: noun.filter }, hasObject: false, hasPlayer: true, rest: dm2[2] };
    }
  }
  {
    const dm = line.match(/^Whenever (?:a|an) (.+?) dealt damage by ~ this turn (dies|is put into a graveyard), (.+)$/i);
    if (dm) {
      const noun = parseNoun(`a ${dm[1]}`);
      if (noun) return { event: 'dies', filter: { object: { ...noun.filter, damagedBySource: true } }, hasObject: true, hasPlayer: false, rest: dm[3] };
    }
  }
  let m: RegExpMatchArray | null;
  let L = line;
  // ---- Round 166 ----
  if ((m = L.match(/^As ~ is turned face up, (.+)$/i))) return { event: 'turnedFaceUp', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^As ~ becomes attached to (?:a|an) (?:creature|permanent|player), (.+)$/i))) return { event: 'becomesAttached', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  // ---- Round 163 ----
  if ((m = L.match(/^Whenever (?:a|an) spell you(?:'ve| have) cast is countered, (.+)$/i))) return { event: 'countered', filter: { objectController: 'you' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever the (\w+) spell of a turn is cast, (.+)$/i))) {
    const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
    const n = ORDINALS[m[1].toLowerCase()];
    if (n !== undefined) return { event: 'cast', filter: { player: 'any', nthThisTurnAllPlayers: n }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever you search your library, (.+)$/i))) return { event: 'searchedLibrary', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ is dealt (\d+) or more damage, (.+)$/i))) return { event: 'dealtDamage', filter: { self: true, minAmount: parseInt(m[1], 10) }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^When (?:enchanted|equipped) (?:creature|permanent|artifact|land|vehicle) is turned face up, (.+)$/i))) return { event: 'turnedFaceUp', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When (?:enchanted|equipped) (?:creature|permanent|artifact|land|vehicle) transforms, (.+)$/i))) return { event: 'transformed', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ phases out, (.+)$/i))) return { event: 'phasedOut', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever you clash and win, (.+)$/i))) return { event: 'clashed', filter: { player: 'you', custom: 'wonClash' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you clash, (.+)$/i))) return { event: 'clashed', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  {
    // "When you cast ~ from your hand, ..."
    const cf = line.match(/^When(?:ever)? you cast ~ from (your hand|your graveyard|a graveyard|exile), (.+)$/i);
    if (cf) return { event: 'cast', filter: { self: true, player: 'you', fromZone: /hand/i.test(cf[1]) ? 'hand' : /graveyard/i.test(cf[1]) ? 'graveyard' : 'exile' }, hasObject: true, hasPlayer: true, rest: cf[2] };
  }
  {
    // State triggers: "When no creatures are on the battlefield, sacrifice ~." / "When an opponent has 10 or less life, ..."
    const st = line.match(/^When(?:ever)? (.+?), (.+)$/i);
    if (st && !/\b(?:enters?|dies|attacks?|blocks?|deals?|becomes?|is dealt|leaves?|taps?|untaps?|casts?|draws?|discards?|sacrifices?|activates?|cycles?|unlocks?|is turned|is put|resolves?|would|pays?|rolls?|explores?|mills?|surveils?|scrys?|connives?|transforms?|phases?|crews?|equips?|regenerates?|begins?|ends?|has been)\b/i.test(st[1])) {
      const cond = parseCondition(st[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') return { event: 'stateTrigger', filter: { self: true }, hasObject: true, hasPlayer: false, stateCondition: cond, rest: st[2] };
    }
  }
  {
    // ---- Round 144 heads ----
    // "Whenever you draw your third card each turn, ..." (any ordinal, "each turn" or "in a turn")
    if ((m = L.match(/^When(?:ever)? (you|an opponent|a player) draws? (?:your|their) (\w+) card (?:each turn|in a turn|this turn), (.+)$/i))) {
      const n = wordToNumber(m[2].replace(/^(first|second|third|fourth|fifth|sixth|seventh)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five', sixth: 'six', seventh: 'seven' } as Record<string, string>)[w.toLowerCase()] ?? w));
      if (typeof n === 'number') {
        const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : undefined;
        return { event: 'drawCard', filter: { player: who, nthThisTurn: n }, hasObject: true, hasPlayer: true, rest: m[3] };
      }
    }
    // "Whenever you cast a spell that is white, ..."
    if ((m = L.match(/^When(?:ever)? you cast a spell that is (white|blue|black|red|green), (.+)$/i))) {
      const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1].toLowerCase() as 'white'];
      return { event: 'cast', filter: { player: 'you', object: { colors: [cn] } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    // "Whenever you cast a spell that is both red and white, ..." / "... that is white or blue"
    if ((m = L.match(/^When(?:ever)? you cast a spell that is (?:both )?((?:white|blue|black|red|green)(?:(?:,? or | and )(?:white|blue|black|red|green))+), (.+)$/i))) {
      const cols = m[1].split(/,? or | and /i).map((c) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[c.trim().toLowerCase() as 'white']);
      if (cols.every((c) => !!c)) {
        const both = /both/i.test(m[0]) || / and /i.test(m[1]);
        return { event: 'cast', filter: { player: 'you', object: both ? { colors: cols, allColors: true } : { colors: cols } }, hasObject: true, hasPlayer: true, rest: m[2] };
      }
    }
    // "Whenever ~ or another nontoken artifact you control dies or is put into exile from the battlefield, ..."
    if ((m = L.match(/^When(?:ever)? (.+?) dies or is put into exile from the battlefield, (.+)$/i))) {
      const a = parseTriggerHead(`Whenever ${m[1]} dies, ${m[2]}`);
      if (a) {
        const b = parseTriggerHead(`Whenever ${m[1]} is put into exile from the battlefield, ${m[2]}`);
        const bh = b ? (() => { const { rest: _r, also: _a, ...rest } = b; void _r; void _a; return rest; })() : { event: 'exiled' as const, filter: a.filter, hasObject: true, hasPlayer: false };
        return { ...a, also: [...(a.also ?? []), bh] };
      }
    }
    // "Whenever a player casts a spell from their hand, ..."
    if ((m = L.match(/^When(?:ever)? (a player|an opponent|you) casts? a spell from (?:their|your) hand, (.+)$/i))) {
      const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : undefined;
      return { event: 'cast', filter: { player: who, fromZone: 'hand' }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
  }

  // ETB
  if ((m = L.match(/^Whenever ~ enters or attacks, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true }] };
  if ((m = L.match(/^When(?:ever)? ~ enters or leaves the battlefield, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'leavesBattlefield', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^When(?:ever)? ~ enters and at the beginning of your upkeep, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'beginningOfUpkeep', filter: { player: 'you' }, hasObject: false, hasPlayer: true }] };
  if ((m = L.match(/^When ~ enters?, (.+)$/i)) && /^When ~ enter,/.test(L)) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ becomes level (\d+), (.+)$/i))) return { event: 'counterAdded', filter: { self: true, counterType: 'level' }, hasObject: true, hasPlayer: false, rest: `if ~ has ${m[1]} or more level counters on it, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ and at least (\w+) other creatures? attack, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control ${wordToNumber(m[1]) === 1 ? 'two' : wordToNumber(m[1]) === 2 ? 'three' : 'four'} or more attacking creatures, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ attacks alone, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control exactly one attacking creature, ${m[1]}` };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) you control attacks alone, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]} you control`);
    if (tf) return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: `if you control exactly one attacking creature, ${m[2]}` };
  }
  if ((m = L.match(/^Whenever you attack with (\w+) or more creatures, (.+)$/i))) return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: `if you control ${m[1]} or more attacking creatures, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ attacks a player who has (more|less) life than you, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if that player has ${m[1]} life than you, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ attacks while you control (.+?), (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control ${m[1]}, ${m[2]}` };
  if ((m = L.match(/^When(?:ever)? ~ enters or is turned face up, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:enchanted|equipped) creature attacks or blocks, (.+)$/i))) return { event: 'attacks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'blocks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^When(?:ever)? (?:enchanted|equipped) creature becomes the target of a spell or ability, (.+)$/i))) return { event: 'becomesTarget', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ becomes the target of a spell, (.+)$/i))) return { event: 'becomesTarget', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you cast an instant or sorcery spell that targets only ~ or activate an ability that targets only ~, (.+)$/i))) return { event: 'cast', filter: { player: 'you', targetsSource: true, object: { types: ['Instant', 'Sorcery'] } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you cast a creature spell with power (\d+) or greater, (.+)$/i))) return { event: 'cast', filter: { player: 'you', object: { types: ['Creature'], powerGE: parseInt(m[1], 10) } }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever an opponent draws their second card each turn, (.+)$/i))) return { event: 'drawCard', filter: { player: 'opponent', nthThisTurn: 2 }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you surveil, (.+)$/i))) return { event: 'surveil', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you scry or surveil, (.+)$/i))) return { event: 'scry', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1], also: [{ event: 'surveil', filter: { player: 'you' }, hasObject: false, hasPlayer: true }] };
  if ((m = L.match(/^Whenever you play a land or cast a spell, (.+)$/i))) return { event: 'landPlayed', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'cast', filter: { player: 'you' }, hasObject: true, hasPlayer: true }] };
  if ((m = L.match(/^Whenever a creature an opponent controls becomes tapped, (.+)$/i))) return { event: 'tapped', filter: { object: { types: ['Creature'] }, objectController: 'opponent' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) you control becomes tapped, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]} you control`);
    if (tf) return { event: 'tapped', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^When(?:ever)? ~ enters or dies, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'dies', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^When(?:ever)? ~ enters(?: under your control)?, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When ~ exploits a creature, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], exploit: true };
  if ((m = L.match(/^When(?:ever)? ~ enters (un)?tapped, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: `if ~ is ${m[1] ? 'untapped' : 'tapped'}, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ or another (.+?) enters(?: under your control)?, (.+)$/i))) {
    const tf = nounFilter(m[1], { defaultYou: / under your control/i.test(m[0]) });
    if (!tf) return null;
    delete tf.object!.other;
    return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an|another|one or more) (.+?) enters(?: under your control| under an opponent's control)?, (.+)$/i))) {
    const under = m[0].match(/ under (your|an opponent's) control/i)?.[1];
    const tf = nounFilter(`${/^another/i.test(m[0].replace(/^Whenever /i, '')) ? 'another ' : 'a '}${m[1]}`);
    if (!tf) return null;
    if (under === 'your') tf.objectController = 'you';
    if (under === "an opponent's") tf.objectController = 'opponent';
    return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  // Dies / leaves
  if ((m = L.match(/^When(?:ever)? ~ dies, (.+)$/i))) return { event: 'dies', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ leaves the battlefield, (.+)$/i))) return { event: 'leavesBattlefield', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ is put into a graveyard from anywhere, (.+)$/i))) return { event: 'putIntoGraveyard', filter: { self: true }, zone: ['battlefield', 'hand', 'library', 'stack'], leaves: true, hasObject: true, hasPlayer: false, rest: m[1] };
  // "When ~ dies or is put into exile from the battlefield, …"
  if ((m = L.match(/^When(?:ever)? ~ dies or is put into exile from the battlefield, (.+)$/i))) return { event: 'dies', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'exiled', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false }] };
  // "When ~ becomes monstrous, …"
  if ((m = L.match(/^When(?:ever)? ~ becomes monstrous, (.+)$/i))) return { event: 'becomesMonstrous', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ or another (.+?) (?:dies|die), (.+)$/i))) {
    const tf = nounFilter(m[1]);
    if (!tf) return null;
    delete tf.object!.other;
    return { event: 'dies', filter: tf, leaves: true, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard, (.+)$/i))) {
    return {
      event: 'dies',
      filter: { object: { types: ['Creature'], other: true } },
      leaves: true,
      hasObject: true,
      hasPlayer: false,
      rest: m[1],
      also: [
        { event: 'putIntoGraveyard', filter: { object: { types: ['Creature'] }, notFromZone: 'battlefield' }, hasObject: true, hasPlayer: false },
        { event: 'leftGraveyard', filter: { object: { types: ['Creature'] }, player: 'you' }, hasObject: true, hasPlayer: false },
      ],
    };
  }
  if ((m = L.match(/^Whenever (?:a|an|another|one or more) (.+?) (?:dies|die), (.+)$/i))) {
    const tf = nounFilter(`${/^Whenever another/i.test(m[0]) ? 'another ' : 'a '}${m[1]}`);
    if (tf) return { event: 'dies', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an|another) (.+?) (?:is put into your graveyard(?: from anywhere)?|is put into a graveyard(?: from anywhere)?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'putIntoGraveyard', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an|another) (.+?) leaves the battlefield, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'leavesBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  // Attacks / blocks
  if ((m = L.match(/^Whenever day becomes night or night becomes day, (.+)$/i))) return { event: 'dayNightChanged', hasObject: false, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever day becomes night, (.+)$/i))) return { event: 'dayNightChanged', filter: { custom: 'becomesNight' }, hasObject: false, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever night becomes day, (.+)$/i))) return { event: 'dayNightChanged', filter: { custom: 'becomesDay' }, hasObject: false, hasPlayer: false, rest: m[1] };
  // Attacks by and against players
  if ((m = L.match(/^Whenever (?:a player|an opponent) attacks(?: you)?(?: with (\w+) or more creatures)?, (.+)$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : null;
    const tf: import('@commander/engine').TriggerFilter = { player: /an opponent/i.test(m[0]) ? 'opponent' : 'any', firstEachTurn: true };
    if (/attacks you/i.test(m[0])) tf.attacksYou = true;
    if (typeof n === 'number' && n > 1) tf.minAmount = n;
    return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a player|a creature|one or more creatures) attacks? one of your opponents, (.+)$/i))) return { event: 'attacks', filter: { otherPlayer: 'opponent', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever one or more creatures attack you, (.+)$/i))) return { event: 'attacks', filter: { attacksYou: true, firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a player attacks enchanted player with one or more creatures, (.+)$/i))) return { event: 'attacks', filter: { custom: 'attacksEnchantedPlayer', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  // Sacrifices, searches, attachments, phasing, voting, proliferating, conniving
  if ((m = L.match(/^Whenever (?:a player|an opponent|you) sacrifices? (?:a|an|one or more) (.+?), (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: 'sacrifice', filter: { player: /an opponent/i.test(m[0]) ? 'opponent' : /whenever you/i.test(m[0]) ? 'you' : 'any', object: noun.filter }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:an opponent|a player) searches their library, (.+)$/i))) return { event: 'searchedLibrary', filter: { player: /an opponent/i.test(m[0]) ? 'opponent' : 'any' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ becomes attached to (?:a|an) (.+?), (.+)$/i))) return { event: 'becomesAttached', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever (?:an|a) (Aura|Equipment|permanent) becomes attached to ~, (.+)$/i))) return { event: 'becomesAttached', filter: { custom: 'attachedToSelf' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever ~ phases in, (.+)$/i))) return { event: 'phasedIn', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever players finish voting, (.+)$/i))) return { event: 'finishedVoting', hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you proliferate, (.+)$/i))) return { event: 'proliferated', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|another) creature you control connives, (.+)$/i))) return { event: 'connived', filter: { objectController: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
  // Zone changes and control
  if ((m = L.match(/^When(?:ever)? (?:a|an|one or more) (.+?) (?:is|are) put into an opponent's graveyard from (the battlefield|anywhere), (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: /battlefield/i.test(m[2]) ? 'dies' : 'putIntoGraveyard', filter: { object: noun.filter, objectController: 'opponent' }, hasObject: true, hasPlayer: true, rest: m[3] };
  }
  if ((m = L.match(/^When(?:ever)? (?:a|an|one or more) (.+?) (?:is|are) put into your graveyard from anywhere, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: 'putIntoGraveyard', filter: { object: { ...noun.filter, owner: 'you' } }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^When ~ is put into your graveyard from your library, (.+)$/i))) return { event: 'putIntoGraveyard', filter: { self: true, fromZone: 'library' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? you lose control of ~, (.+)$/i))) return { event: 'controlChanged', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? (?:enchanted|equipped) (?:creature|permanent|land) leaves the battlefield, (.+)$/i))) return { event: 'leavesBattlefield', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever an opponent plays a land, (.+)$/i))) return { event: 'landPlayed', filter: { player: 'opponent' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever one or more (.+?) cards? (?:are|is) milled, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]} card`);
    if (noun) return { event: 'mill', filter: { object: noun.filter }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  // Casting and abilities
  if ((m = L.match(/^When you cast (?:a|an) (.+?), (.+)$/i))) {
    const noun = parseNoun(`a ${m[1].replace(/ spell$/i, '')} card`);
    if (noun) return { event: 'cast', filter: { player: 'you', object: noun.filter }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:you|a player) casts? a spell of the chosen color, (.+)$/i))) return { event: 'cast', filter: { player: /whenever you/i.test(m[0]) ? 'you' : 'any', object: { chosenColor: true } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever an ability of (?:equipped|enchanted) creature is activated, (.+)$/i))) return { event: 'abilityActivated', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a player draws their second card each turn, (.+)$/i))) return { event: 'drawCard', filter: { nthThisTurn: 2 }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you lose life for the first time each turn, (.+)$/i))) return { event: 'lifeLost', filter: { player: 'you', firstEachTurn: true }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever an opponent is dealt noncombat damage, (.+)$/i))) return { event: 'dealtDamage', filter: { player: 'opponent', toPlayer: true, combat: false }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you put one or more ([+-]\d\/[+-]\d|\w+) counters on ~, (.+)$/i))) return { event: 'counterAdded', filter: { self: true, counterType: m[1] }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever a face-down creature you control enters, (.+)$/i))) return { event: 'entersBattlefield', filter: { object: { types: ['Creature'], controller: 'you', faceDown: true } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When ~ blocks (?:a creature|a (.+?)), (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[2] ?? m[1] };
  if ((m = L.match(/^When(?:ever)? ~ dies during combat, (.+)$/i))) return { event: 'dies', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ or (?:equipped|enchanted) creature (attacks|blocks|deals combat damage to a player), (.+)$/i))) {
    const ev = /attacks/i.test(m[1]) ? 'attacks' : /blocks/i.test(m[1]) ? 'blocks' : 'dealtDamage';
    const extra = ev === 'dealtDamage' ? { toPlayer: true, combat: true } : {};
    return { event: ev, filter: { self: true, ...extra }, hasObject: true, hasPlayer: true, rest: m[2], also: [{ event: ev, filter: { attachedToSource: true, ...extra }, hasObject: true, hasPlayer: true }] };
  }
  if ((m = L.match(/^Whenever your commander (enters|attacks|dies)(?: or (enters|attacks|dies))?, (.+)$/i))) {
    const map: Record<string, import('@commander/engine').GameEventName> = { enters: 'entersBattlefield', attacks: 'attacks', dies: 'dies' };
    const f = { object: { isCommander: true, controller: 'you' as const } };
    const head = { event: map[m[1].toLowerCase()], filter: f, hasObject: true, hasPlayer: true, rest: m[3] };
    return m[2] ? { ...head, also: [{ event: map[m[2].toLowerCase()], filter: f, hasObject: true, hasPlayer: true }] } : head;
  }
  if ((m = L.match(/^Whenever another creature you control enters or dies, (.+)$/i))) {
    const f = { object: { types: ['Creature'], controller: 'you' as const, other: true } };
    return { event: 'entersBattlefield', filter: f, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'dies', filter: f, hasObject: true, hasPlayer: true }] };
  }
  if ((m = L.match(/^When(?:ever)? (?:equipped|enchanted) creature (?:blocks or becomes blocked|attacks or blocks)(?: by a creature)?, (.+)$/i))) {
    const f = { attachedToSource: true };
    return { event: /attacks/i.test(m[0]) ? 'attacks' : 'blocks', filter: f, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: /attacks/i.test(m[0]) ? 'blocks' : 'becomesBlocked', filter: f, hasObject: true, hasPlayer: true }] };
  }
  if ((m = L.match(/^When ~ leaves the battlefield or becomes untapped, (.+)$/i))) return { event: 'leavesBattlefield', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'untapped', filter: { self: true }, hasObject: true, hasPlayer: true }] };
  if ((m = L.match(/^When you cast or cycle ~, (.+)$/i))) return { event: 'cast', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'cycled', filter: { self: true }, hasObject: true, hasPlayer: true }] };
  if ((m = L.match(/^Whenever you play a land from exile or cast a spell from exile, (.+)$/i))) return { event: 'landPlayed', filter: { player: 'you', fromZone: 'exile' }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'cast', filter: { player: 'you', fromZone: 'exile' }, hasObject: true, hasPlayer: true }] };
  // Crew, plot, clash, energy, discards, counters, targets
  if ((m = L.match(/^Whenever ~ (?:crews a Vehicle|saddles a Mount or crews a Vehicle)(?: during your main phase)?, (.+)$/i))) return { event: 'crewed', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ becomes plotted, (.+)$/i))) return { event: 'plotted', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you clash, (.+)$/i))) return { event: 'clashed', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you get one or more \{E\}, (.+)$/i))) return { event: 'gotEnergy', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? (?:you discard ~|a spell or ability an opponent controls causes you to discard ~), (.+)$/i))) return { event: 'discard', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever an opponent shuffles their library, (.+)$/i))) return { event: 'shuffle', filter: { player: 'opponent' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a player loses the game, (.+)$/i))) return { event: 'playerLost', hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a creature becomes the target of a spell or ability, (.+)$/i))) return { event: 'becomesTarget', filter: { object: { types: ['Creature'] } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you or a permanent you control becomes the target of a spell or ability an opponent controls, (.+)$/i))) return { event: 'becomesTarget', filter: { objectController: 'you', player: 'opponent' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a face-down creature you control dies, (.+)$/i))) return { event: 'dies', filter: { object: { types: ['Creature'], controller: 'you', faceDown: true } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When you sacrifice (?:a|an) (.+?), (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: 'sacrifice', filter: { player: 'you', object: noun.filter }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever a creature (?:deals combat damage to|attacks) enchanted player, (.+)$/i))) return { event: /attacks/i.test(m[0]) ? 'attacks' : 'dealtDamage', filter: { custom: 'attacksEnchantedPlayer', ...(/damage/i.test(m[0]) ? { toPlayer: true, combat: true } : {}) }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a creature you control that is (?:enchanted or equipped|equipped or enchanted) attacks, (.+)$/i))) return { event: 'attacks', filter: { object: { types: ['Creature'], controller: 'you', hasAttachment: 'any' } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever one or more other creatures you control with power (\w+) or less enter, (.+)$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return { event: 'entersBattlefield', filter: { object: { types: ['Creature'], controller: 'you', other: true, powerLE: n } }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever you activate a loyalty ability of (?:enchanted planeswalker|a (\w+) planeswalker), (.+)$/i))) return { event: 'abilityActivated', filter: m[1] ? { object: { types: ['Planeswalker'], subtypes: [m[1]] } } : { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever a time counter is removed from ~ while it is exiled, (.+)$/i))) return { event: 'counterRemoved', filter: { self: true, counterType: 'time' }, hasObject: true, hasPlayer: true, rest: m[1], zone: 'exile' };
  if ((m = L.match(/^When(?:ever)? ~ enters during the declare attackers step, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true, custom: 'declareAttackersStep' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ mutates, (.+)$/i))) return { event: 'mutates', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  // State triggers: "When ~ has no +1/+1 counters on it, sacrifice it."
  if ((m = L.match(/^When ~ has no ([+-]\d\/[+-]\d|[\w' -]+?) counters on it, (.+)$/i))) return { event: 'stateTrigger', hasObject: true, hasPlayer: true, rest: m[2], stateCondition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: m[1], op: '==', value: 0 } };
  if ((m = L.match(/^When there are no creatures on the battlefield, (.+)$/i))) return { event: 'stateTrigger', hasObject: false, hasPlayer: true, rest: m[1], stateCondition: { kind: 'count', filter: { types: ['Creature'], zone: 'battlefield' }, op: '==', value: 0 } };
  if ((m = L.match(/^When you have (\w+) or less life, (.+)$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return { event: 'stateTrigger', hasObject: false, hasPlayer: true, rest: m[2], stateCondition: { kind: 'life', ref: { ref: 'controller' }, op: '<=', value: n } };
  }
  if ((m = L.match(/^Whenever you put one or more (?:([+-]\d\/[+-]\d|[\w' -]+?) )?counters on (?:a|an) (.+?), (.+)$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) return { event: 'counterAdded', filter: { object: noun.filter, counterType: m[1] as import('@commander/engine').CounterType | undefined, player: 'you' }, hasObject: true, hasPlayer: true, rest: m[3] };
  }
  if ((m = L.match(/^When you unlock this door, (.+)$/i))) return { event: 'unlockedDoor', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  // Morph: "When ~ is turned face up, ..." / "Whenever a permanent you control is turned face up, ..."
  if ((m = L.match(/^(?:When(?:ever)?|As) ~ is turned face up, (.+)$/i))) return { event: 'turnedFaceUp', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^As ~ becomes attached to (?:a|an) (?:creature|permanent|player), (.+)$/i))) return { event: 'becomesAttached', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|another) (.+?) is turned face up, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: 'turnedFaceUp', filter: { object: noun.filter }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever ~ or another (.+?) you control is turned face up, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: 'turnedFaceUp', filter: { object: { ...noun.filter, controller: 'you' } }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  // Crime, dice, explore, unattach and a batch of narrower heads.
  if ((m = L.match(/^Whenever you commit a crime, (.+)$/i))) return { event: 'committedCrime', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever an opponent commits a crime, (.+)$/i))) return { event: 'committedCrime', filter: { player: 'opponent' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you roll (?:one or more dice|a die|dice), (.+)$/i))) return { event: 'rolledDie', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|another) creature you control explores, (.+)$/i))) return { event: 'explored', filter: { objectController: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ explores, (.+)$/i))) return { event: 'explored', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ becomes unattached(?: from (?:a permanent|a creature))?, (.+)$/i))) return { event: 'becomesUnattached', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you win a coin flip, (.+)$/i))) return { event: 'coinFlipped', filter: { player: 'you', custom: 'wonFlip' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you lose a coin flip, (.+)$/i))) return { event: 'coinFlipped', filter: { player: 'you', custom: 'lostFlip' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a source deals damage to ~, (.+)$/i))) return { event: 'dealtDamage', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ is dealt (combat )?damage, (.+)$/i))) return { event: 'dealtDamage', filter: { self: true, combat: m[1] ? true : undefined }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^When (equipped|enchanted) (?:creature|permanent|land) is dealt (combat )?damage, (.+)$/i))) return { event: 'dealtDamage', filter: { attachedToSource: true, combat: m[2] ? true : undefined }, hasObject: true, hasPlayer: true, rest: m[3] };
  if ((m = L.match(/^When(?:ever)? (equipped|enchanted) (?:creature|permanent|land|artifact) becomes (tapped|untapped), (.+)$/i))) return { event: m[2].toLowerCase() === 'tapped' ? 'tapped' : 'untapped', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[3] };
  if ((m = L.match(/^Whenever (?:equipped|enchanted) creature attacks alone, (.+)$/i))) return { event: 'attacks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: `if you control exactly one attacking creature, ${m[1]}` };
  if ((m = L.match(/^Whenever enchanted player is attacked, (.+)$/i))) return { event: 'attacked', filter: { attachedToSource: true }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ enters from a graveyard, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true, fromZone: 'graveyard' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^At the beginning of combat on each opponent's turn, (.+)$/i))) return { event: 'beginningOfCombat', filter: { player: 'opponent' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|one or more) creatures? deals? combat damage to one of your opponents, (.+)$/i))) return { event: 'dealtDamage', filter: { toPlayer: true, player: 'opponent', combat: true }, hasObject: true, hasPlayer: true, objectIsSource: true, rest: m[1] };
  if ((m = L.match(/^Whenever you attack a player, (.+)$/i))) return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ dies or is put into exile from the battlefield, (.+)$/i))) return { event: 'dies', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'leavesBattlefield', filter: { self: true, toZone: 'exile' }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^When ~ attacks or blocks, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^When ~ blocks, (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ blocks or becomes blocked, (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) attacks, (.+)$/i))) return { event: 'attacks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) blocks, (.+)$/i))) return { event: 'blocks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) becomes blocked, (.+)$/i))) return { event: 'becomesBlocked', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^When(?:ever)? (equipped|enchanted) (?:creature|permanent) dies, (.+)$/i))) return { event: 'dies', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) deals (combat )?damage(?: to (a player|an opponent|a creature))?, (.+)$/i))) {
    const tf: TriggerFilter = { sourceAttachedTo: true };
    if (m[3] && /player|opponent/.test(m[3])) tf.toPlayer = true;
    if (m[3] === 'an opponent') tf.player = 'opponent';
    if (m[3] === 'a creature') tf.object = { types: ['Creature'] };
    return { event: m[2] ? 'dealsCombatDamage' : 'dealsDamage', filter: tf, hasObject: true, hasPlayer: true, rest: m[4] };
  }
  if ((m = L.match(/^Whenever (?:enchanted|equipped) (?:land|permanent|creature|Forest|Island|Swamp|Mountain|Plains) is tapped for mana, (.+)$/i))) return { event: 'tappedForMana', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ is tapped for mana, (.+)$/i))) return { event: 'tappedForMana', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you tap (?:a|an) (.+?) for mana, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.player = 'you';
    return { event: 'tappedForMana', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever a player taps (?:a|an) (.+?) for mana, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'tappedForMana', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) becomes tapped, (.+)$/i))) return { event: 'tapped', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) is dealt damage, (.+)$/i))) return { event: 'dealtDamage', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^At the beginning of the upkeep of (?:enchanted|equipped) (?:creature|permanent|artifact|enchantment|land|planeswalker)'s controller, (.+)$/i))) return { event: 'beginningOfUpkeep', filter: { custom: 'attachedControllersUpkeep' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ attacks or blocks, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^Whenever ~ attacks(?: a player| an opponent)?, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ attacks a player who (?:is|has) .+?, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ blocks(?: a creature)?, (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ blocks or becomes blocked by a creature, (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^Whenever ~ blocks (?:a|an) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'blocks', filter: { self: true, source: tf.object }, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever enchanted (creature|permanent) attacks, (.+)$/i))) return { event: 'attacks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever (?:enchanted|equipped) (creature|permanent) (?:deals combat damage to a player|deals combat damage to an opponent), (.+)$/i))) return { event: 'dealtCombatDamageToPlayer', filter: { attachedToSource: true, player: /opponent/i.test(m[0]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^When(?:ever)? enchanted (creature|permanent|land|artifact) dies, (.+)$/i))) return { event: 'dies', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever you cast a spell that targets ~, (.+)$/i))) return { event: 'cast', filter: { player: 'you', targetsSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ becomes blocked(?: by a creature)?, (.+)$/i))) return { event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|another|one or more) (.+?) attacks?(?: a player| you or a planeswalker you control| a player or planeswalker)?, (.+)$/i))) {
    const tf = nounFilter(`${/^Whenever another/i.test(m[0]) ? 'another ' : 'a '}${m[1]}`);
    if (tf) return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever you attack(?: with (?:one or more|a|an) (.+?))?, (.+)$/i))) {
    const tf: TriggerFilter = { player: 'you', firstEachTurn: true };
    if (m[1]) {
      const nf = nounFilter(`a ${m[1]}`);
      if (!nf) return null;
      tf.object = nf.object;
    }
    return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an) (.+?) attacks you or a planeswalker you control, (.+)$/i)) || (m = L.match(/^Whenever (?:a|an) (.+?) attacks you, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.attacksYou = true;
    return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an) (.+?) blocks(?: ~)?, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'blocks', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  // Damage
  if ((m = L.match(/^When(?:ever)? ~ deals combat damage to (a player|an opponent), (.+)$/i))) return { event: 'dealtCombatDamageToPlayer', filter: { self: true, player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever a creature deals combat damage to you, (.+)$/i))) return { event: 'dealtCombatDamageToPlayer', filter: { player: 'you', object: { types: ['Creature'] } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you're dealt damage, (.+)$/i)) || (m = L.match(/^Whenever you are dealt damage, (.+)$/i))) return { event: 'dealtDamage', filter: { player: 'you', toPlayer: true }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a source you control deals (noncombat )?damage to (an opponent|a player), (.+)$/i))) return { event: 'dealsDamage', filter: { player: /opponent/i.test(m[2]) ? 'opponent' : 'any', toPlayer: true, source: { controller: 'you' }, combat: m[1] ? false : undefined }, hasObject: false, hasPlayer: true, rest: m[3] };
  if ((m = L.match(/^Whenever a source you control deals damage to you, (.+)$/i))) return { event: 'dealtDamage', filter: { player: 'you', toPlayer: true, source: { controller: 'you' } }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ deals combat damage to (a player|an opponent|a player or battle|a player or planeswalker|an opponent or battle), (.+)$/i))) return { event: 'dealtCombatDamageToPlayer', filter: { self: true, player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever ~ attacks and is not blocked, (.+)$/i))) return { event: 'attacksUnblocked', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When you cycle ~, (.+)$/i))) return { event: 'cycled', filter: { self: true }, zone: ['graveyard', 'hand'], hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:you cycle|a player cycles) (?:a card|another card), (.+)$/i))) return { event: 'cycled', filter: { player: /you cycle/i.test(m[0]) ? 'you' : 'any' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever one or more cards leave your graveyard, (.+)$/i))) return { event: 'leftGraveyard', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ blocks or becomes blocked by (?:a|an) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'blocks', filter: { self: true, source: tf.object }, hasObject: true, hasPlayer: false, rest: m[2], also: [{ event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  }
  if ((m = L.match(/^Whenever ~ deals damage to (a player|an opponent), (.+)$/i))) return { event: 'dealtDamage', filter: { source: { self: true }, toPlayer: true, player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: false, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever ~ deals combat damage to a creature, (.+)$/i))) return { event: 'dealsCombatDamage', filter: { source: { self: true }, object: { types: ['Creature'] } }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ deals (?:combat )?damage, (.+)$/i))) return { event: /combat/i.test(m[0]) ? 'dealsCombatDamage' : 'dealsDamage', filter: { source: { self: true } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ deals damage to a creature, (.+)$/i))) return { event: 'dealsDamage', filter: { source: { self: true }, object: { types: ['Creature'] } }, hasObject: true, hasPlayer: false, rest: m[1] };
  // "Whenever ~ deals damage to a Dinosaur, destroy that creature."
  if ((m = L.match(/^Whenever ~ deals (combat )?damage to (?:a|an) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[2]}`);
    if (tf) return { event: m[1] ? 'dealsCombatDamage' : 'dealsDamage', filter: { source: { self: true }, object: tf }, hasObject: true, hasPlayer: false, rest: m[3] };
  }
  if ((m = L.match(/^Whenever ~ is dealt damage, (.+)$/i))) return { event: 'dealtDamage', filter: { object: { self: true } }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|one or more) (.+?) (?:you control )?deals? combat damage to (a player|an opponent), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}${/you control/i.test(m[0]) ? ' you control' : ''}`);
    if (!tf) return null;
    tf.player = /opponent/i.test(m[2]) ? 'opponent' : 'any';
    return { event: 'dealtCombatDamageToPlayer', filter: tf, hasObject: true, hasPlayer: true, rest: m[3] };
  }
  if ((m = L.match(/^Whenever a source (?:an opponent controls )?deals damage to you, (.+)$/i))) return { event: 'dealtDamage', filter: { player: 'you', toPlayer: true }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) (?:you control )?is dealt damage, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}${/you control/i.test(m[0]) ? ' you control' : ''}`);
    if (tf) return { event: 'dealtDamage', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  // Beginning of steps
  if ((m = L.match(/^At the beginning of (your|each|each player's|each opponent's|an opponent's|the|enchanted player's) (upkeep|end step|draw step|precombat main phase|first main phase|postcombat main phase|combat(?: on your turn)?|combat on each of your turns|next end step), (.+)$/i))) {
    const whose = m[1].toLowerCase();
    const step = m[2].toLowerCase();
    const player: TriggerFilter['player'] = whose === 'your' ? 'you' : whose.includes('opponent') ? 'opponent' : 'any';
    const event: GameEventName = step.startsWith('upkeep') ? 'beginningOfUpkeep' : step.includes('end step') ? 'beginningOfEndStep' : step.includes('draw') ? 'beginningOfDraw' : step.includes('precombat') || step.includes('first main') ? 'beginningOfPrecombatMain' : step.includes('postcombat') ? 'beginningOfPostcombatMain' : 'beginningOfCombat';
    const tf: TriggerFilter = { player };
    if (step.includes('on your turn') || step.includes('each of your turns')) tf.player = 'you';
    return { event, filter: tf, hasObject: false, hasPlayer: true, rest: m[3] };
  }
  if ((m = L.match(/^At the beginning of your (?:second|postcombat) main phase, (.+)$/i)) || (m = L.match(/^At the beginning of each of your postcombat main phases, (.+)$/i))) return { event: 'beginningOfPostcombatMain', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^At the beginning of your combat step, (.+)$/i))) return { event: 'beginningOfCombat', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever one or more (.+?) you control enter, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1].replace(/s$/, '')} you control`);
    if (tf) return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever one or more (.+?) cards? leave your graveyard, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]} card`);
    if (!tf) return null;
    tf.player = 'you';
    return { event: 'leftGraveyard', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever a creature you control becomes blocked, (.+)$/i))) return { event: 'becomesBlocked', filter: { object: { types: ['Creature'] }, objectController: 'you' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|another) (.+?) (?:becomes blocked|blocks), (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { event: /becomes blocked/i.test(m[0]) ? 'becomesBlocked' : 'blocks', filter: { object: noun.filter }, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^At the beginning of your turn, (.+)$/i))) return { event: 'beginningOfUpkeep', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^At the beginning of combat on (your|each) turn, (.+)$/i)) || (m = L.match(/^At the beginning of (each) combat, (.+)$/i))) return { event: 'beginningOfCombat', filter: { player: m[1] === 'your' ? 'you' : 'any' }, hasObject: false, hasPlayer: true, rest: m[2] };
  // Casting
  if ((m = L.match(/^When you cast ~, (.+)$/i)) || (m = L.match(/^When you cast this spell, (.+)$/i))) return { event: 'cast', filter: { self: true }, zone: 'stack', hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you cast or copy (?:a|an) (.+?) spell, (.+)$/i))) L = `Whenever you cast a ${m[1]} spell, ${m[2]}`; // copies are approximated by casts
  if ((m = L.match(/^Whenever you cast (?:a|an) (.+?) spell with mana value (\d+) or (greater|less), (.+)$/i)) || (m = L.match(/^Whenever you cast a (spell) with mana value (\d+) or (greater|less), (.+)$/i))) {
    const noun = m[1] === 'spell' ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]} spell`);
    if (!noun) return null;
    const f: ObjectFilter = { ...noun.filter };
    delete f.zone;
    if (m[3] === 'greater') f.cmcGE = parseInt(m[2], 10);
    else f.cmcLE = parseInt(m[2], 10);
    return { event: 'cast', filter: { player: 'you', object: f }, hasObject: true, hasPlayer: true, rest: m[4] };
  }
  if ((m = L.match(/^Whenever you cast a spell that targets (?:a|an|one or more) (.+?) you control, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return { event: 'cast', filter: { player: 'you', targetsControlled: noun.filter }, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever you cast an instant or sorcery spell that targets only ~, (.+)$/i))) return { event: 'cast', filter: { player: 'you', targetsSource: true, object: { types: ['Instant', 'Sorcery'] } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you cast a spell that is one or more colors, (.+)$/i))) return { event: 'cast', filter: { player: 'you', object: { custom: 'colored' } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (you|a player|an opponent|each opponent|another player) casts? (?:a|an) (.+?), (.+)$/i))) {
    const noun = parseNoun(`a ${/\bspells?\b/i.test(m[2]) ? m[2] : `${m[2]} spell`}`);
    if (noun) {
      const f: TriggerFilter = { player: m[1] === 'you' ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : m[1] === 'another player' ? 'notYou' : 'any' };
      const of = { ...noun.filter };
      if (of.zone === 'graveyard' || of.zone === 'exile' || of.zone === 'hand') {
        f.fromZone = of.zone;
        delete of.zone;
      }
      if (Object.keys(of).length) f.object = of;
      return { event: 'cast', filter: f, hasObject: true, hasPlayer: true, rest: m[3] };
    }
  }
  if ((m = L.match(/^Whenever you cast a kicked spell, (.+)$/i))) return { event: 'cast', filter: { player: 'you', custom: 'kicked' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you cast a spell from (exile|your graveyard|a graveyard), (.+)$/i))) return { event: 'cast', filter: { player: 'you', fromZone: /exile/.test(m[1]) ? 'exile' : 'graveyard' }, hasObject: true, hasPlayer: true, rest: m[2] };
  // "Whenever you cast an instant, sorcery, or Wizard spell, ..." — the type list contains commas.
  if ((m = L.match(/^Whenever (you cast|a player casts|an opponent casts) (?:a|an) ([^,]+(?:, [^,]+)+) spell, (.+)$/i))) {
    const noun = parseNoun(`a ${m[2]} spell`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      const who = /^you cast$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : undefined;
      return { event: 'cast', filter: { player: who, object: f }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
  }
  if ((m = L.match(/^Whenever you cast (?:a|an|your first|your second) (.+?)(?: spell)?(?: each turn| during an opponent's turn| during each opponent's turn| from your hand| from anywhere other than your hand)?, (.+)$/i))) {
    const nounText = m[1].replace(/ spell$/, '');
    const tf: TriggerFilter = { player: 'you' };
    if (/your second/i.test(m[0])) tf.nthThisTurn = 2;
    if (nounText !== 'spell' && nounText !== '') {
      const noun = parseNoun(`a ${nounText} spell`);
      if (!noun) return null;
      const f = { ...noun.filter };
      delete f.zone;
      tf.object = f;
    }
    if (/your first/i.test(m[0])) tf.firstEachTurn = true;
    if (/during (?:an|each) opponent's turn/i.test(m[0])) tf.notYourTurn = true;
    return { event: 'cast', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever an opponent casts (?:a|an|their first) (.+?)(?: spell)?(?: each turn)?, (.+)$/i)) || (m = L.match(/^Whenever a player casts (?:a|an|their first) (.+?)(?: spell)?(?: each turn)?, (.+)$/i))) {
    const nounText = m[1].replace(/ spell$/, '');
    const tf: TriggerFilter = { player: /opponent/i.test(m[0]) ? 'opponent' : 'any' };
    if (nounText !== 'spell') {
      const noun = parseNoun(`a ${nounText} spell`);
      if (!noun) return null;
      const f = { ...noun.filter };
      delete f.zone;
      tf.object = f;
    }
    if (/their first/i.test(m[0])) tf.firstEachTurn = true;
    return { event: 'cast', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  // Player events
  if ((m = L.match(/^Whenever you gain life(?: for the first time each turn)?, (.+)$/i))) return { event: 'lifeGained', filter: { player: 'you', firstEachTurn: /first time/i.test(m[0]) || undefined }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (an opponent|a player) gains life, (.+)$/i))) return { event: 'lifeGained', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: false, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever you lose life, (.+)$/i))) return { event: 'lifeLost', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (an opponent|a player) loses life, (.+)$/i))) return { event: 'lifeLost', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: false, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever you draw a card, (.+)$/i))) return { event: 'drawCard', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you draw your (first|second) card each turn, (.+)$/i))) return { event: 'drawCard', filter: { player: 'you', nthThisTurn: m[1] === 'first' ? 1 : 2 }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever (an opponent|a player) draws a card, (.+)$/i))) return { event: 'drawCard', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever you discard (a card|one or more cards), (.+)$/i))) return { event: /one or more/i.test(m[1]) ? 'discardBatch' : 'discard', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever (an opponent|a player) discards (a card|one or more cards), (.+)$/i))) return { event: /one or more/i.test(m[2]) ? 'discardBatch' : 'discard', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[3] };
  if ((m = L.match(/^Whenever (you|an opponent|a player) (?:cycle or )?discards? (?:a|an|another) (.+? card), (.+)$/i))) {
    const tf = nounFilter(`a ${m[2]}`);
    if (!tf) return null;
    tf.player = m[1].toLowerCase() === 'you' ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    return { event: 'discard', filter: tf, hasObject: true, hasPlayer: true, rest: m[3] };
  }
  if ((m = L.match(/^Whenever you cycle or discard (?:a|another) card, (.+)$/i))) return { event: 'discard', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever a card is put into an opponent's graveyard from anywhere, (.+)$/i))) return { event: 'putIntoGraveyard', filter: { player: 'opponent' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) card leaves your graveyard, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]} card`);
    if (!tf) return null;
    tf.player = 'you';
    return { event: 'leftGraveyard', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }

  if ((m = L.match(/^Whenever you mill (?:a card|one or more cards), (.+)$/i))) return { event: 'putIntoGraveyard', filter: { player: 'you', fromZone: 'library' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|one or more) (.+?) (?:is|are) put into your graveyard from your library, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.fromZone = 'library';
    tf.player = 'you';
    return { event: 'putIntoGraveyard', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever the Ring tempts you, (.+)$/i))) return { event: 'ringTempted', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you venture into the dungeon, (.+)$/i))) return { event: 'ventures', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you complete a dungeon, (.+)$/i))) return { event: 'dungeonCompleted', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you take the initiative, (.+)$/i))) return { event: 'takesInitiative', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? you sacrifice ~, (.+)$/i))) return { event: 'sacrifice', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you sacrifice (?:a|an|another|one or more) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.player = 'you';
    return { event: 'sacrifice', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever you scry, (.+)$/i))) return { event: 'scry', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you (?:create|make) (?:a|an|one or more) (.+?) tokens?, (.+)$/i)) || (m = L.match(/^Whenever one or more (.+?) tokens? enter(?:s)? under your control, (.+)$/i))) {
    const tf = m[1] && m[1] !== 'token' ? nounFilter(`a ${m[1]}`) : { object: {} };
    if (!tf) return null;
    tf.player = 'you';
    return { event: 'tokenCreated', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever you create a token, (.+)$/i)) || (m = L.match(/^Whenever one or more tokens enter under your control, (.+)$/i))) return { event: 'tokenCreated', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ becomes tapped, (.+)$/i))) return { event: 'tapped', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ becomes untapped, (.+)$/i))) return { event: 'untapped', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When(?:ever)? ~ becomes the target of a spell or ability(?: an opponent controls| you control)?(?: for the first time each turn)?, (.+)$/i))) return { event: 'becomesTarget', filter: { self: true, player: / an opponent controls/i.test(m[0]) ? 'opponent' : / you control/i.test(m[0]) ? 'you' : 'any', firstEachTurn: /first time each turn/i.test(m[0]) || undefined }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) you control becomes the target of a spell or ability an opponent controls, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]} you control`);
    if (!tf) return null;
    tf.player = 'opponent';
    return { event: 'becomesTarget', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:one or more|a) ([+-]\d\/[+-]\d|\w+) counters? (?:is|are) put on ~, (.+)$/i))) return { event: 'counterAdded', filter: { self: true, counterType: m[1] }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever (?:one or more|a) ([+-]\d\/[+-]\d|\w+) counters? (?:is|are) put on (?:a|an) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[2]}`);
    if (!tf) return null;
    tf.counterType = m[1];
    return { event: 'counterAdded', filter: tf, hasObject: true, hasPlayer: false, rest: m[3] };
  }
  if ((m = L.match(/^Whenever you put (?:one or more|a|an) ([+-]\d\/[+-]\d|\w+) counters? on (?:a|an) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[2]}`);
    if (!tf) return null;
    tf.counterType = m[1];
    return { event: 'counterAdded', filter: tf, hasObject: true, hasPlayer: false, rest: m[3] };
  }
  if ((m = L.match(/^When(?:ever)? ~ becomes monstrous, (.+)$/i))) return { event: 'becomesMonstrous', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ transforms, (.+)$/i))) return { event: 'transformed', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever you become the monarch, (.+)$/i))) return { event: 'becomesMonarch', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) (?:is put into|enters) your graveyard from your library, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.fromZone = 'library';
    return { event: 'putIntoGraveyard', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an) (.+?) is put into your graveyard from anywhere, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (tf) return { event: 'putIntoGraveyard', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an) (.+?) enters under an opponent's control, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.objectController = 'opponent';
    return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever a player attacks you with one or more creatures, (.+)$/i))) return { event: 'attacked', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ or another creature you control becomes blocked, (.+)$/i))) return { event: 'becomesBlocked', filter: { object: { types: ['Creature'] }, objectController: 'you' }, hasObject: true, hasPlayer: false, rest: m[1] };
  {
    // "Whenever one or more X <plural verb>" reads like the singular head; only used if that parses.
    if (/^When(?:ever)? one or more /i.test(L)) {
      const verb = (v: string): string => ({ enter: 'enters', die: 'dies', 'are put': 'is put', 'are exiled': 'is exiled', become: 'becomes', attack: 'attacks', deal: 'deals', leave: 'leaves', 'are tapped': 'is tapped', 'are dealt': 'is dealt', 'are countered': 'is countered', 'are destroyed': 'is destroyed', 'are sacrificed': 'is sacrificed' } as Record<string, string>)[v.toLowerCase()] ?? v;
      const base = L.replace(/^(When(?:ever)? )one or more /i, '$1a ').replace(/\b(enter|die|are put|are exiled|become|attack|deal|leave|are tapped|are dealt|are countered|are destroyed|are sacrificed)\b/i, verb);
      for (const alt of [base, base.replace(/^(When(?:ever)? a )([\w' -]*?)s\b/i, '$1$2'), base.replace(/^(When(?:ever)? a )([\w' -]+?)s /i, '$1$2 ')]) {
        if (alt === L) continue;
        const h = parseTriggerHead(alt);
        if (h) return h;
      }
    }
  }
  {
    // Curse heads: the Aura is attached to a player.
    if ((m = L.match(/^At the beginning of enchanted player's (upkeep|end step|draw step), (.+)$/i)))
      return { event: /upkeep/i.test(m[1]) ? 'beginningOfUpkeep' : /end step/i.test(m[1]) ? 'beginningOfEndStep' : 'beginningOfDraw', filter: { custom: 'attachedPlayersStep' }, hasObject: false, hasPlayer: true, rest: m[2] };
    if ((m = L.match(/^When(?:ever)? (?:a player|an opponent) attacks enchanted player(?: with one or more creatures)?, (.+)$/i)))
      return { event: 'attacked', filter: { custom: 'attachedPlayerAttacked' }, hasObject: false, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? enchanted player is attacked, (.+)$/i)))
      return { event: 'attacked', filter: { custom: 'attachedPlayerAttacked' }, hasObject: false, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? enchanted player casts? (?:a|an) (.+?)(?: other than the first spell they cast each turn)?, (.+)$/i))) {
      const noun = /^spell$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (noun) return { event: 'cast', filter: { custom: 'enchantedPlayer', object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
  }
  {
    // Round 93 heads.
    if ((m = L.match(/^When(?:ever)? enchanted player draws a card, (.+)$/i)))
      return { event: 'drawCard', filter: { custom: 'enchantedPlayer' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? enchanted player casts a spell with the chosen name, (.+)$/i)))
      return { event: 'cast', filter: { custom: 'enchantedPlayer', object: { nameIsChosen: 'cardName' } }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) enchanted player controls (enters|dies|becomes tapped), (.+)$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (noun) {
        const ev: GameEventName = /enters/i.test(m[2]) ? 'entersBattlefield' : /dies/i.test(m[2]) ? 'dies' : 'tapped';
        return { event: ev, filter: { object: { ...noun.filter, zone: undefined }, custom: 'enchantedPlayerControls' }, hasObject: true, hasPlayer: true, rest: m[3] };
      }
    }
    if ((m = L.match(/^When(?:ever)? you gain life for the first time (?:each turn|during each of your turns), (.+)$/i)))
      return { event: 'lifeGained', filter: { player: 'you', firstEachTurn: true }, hasObject: false, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you forage, (.+)$/i)))
      return { event: 'foraged', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^At the beginning of each of your main phases, (.+)$/i)))
      return { event: 'beginningOfPrecombatMain', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1], also: [{ event: 'beginningOfPostcombatMain', filter: { player: 'you' }, hasObject: false, hasPlayer: true }] };
    if ((m = L.match(/^When(?:ever)? ~ has (\w+) or more ([\w' -]+?) counters on it, (.+)$/i))) {
      const n = wordToNumber(m[1]);
      if (typeof n === 'number') return { event: 'stateTrigger', hasObject: true, hasPlayer: true, rest: m[3], stateCondition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: m[2], op: '>=', value: n } };
    }
    if ((m = L.match(/^When(?:ever)? you discard one or more cards at random, (.+)$/i)))
      return { event: 'discardBatch', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (a player|an opponent|you) plays a land or casts a spell, (.+)$/i))) {
      const who = /opponent/i.test(m[1]) ? 'opponent' : /^you$/i.test(m[1]) ? 'you' : 'any';
      return { event: 'landPlayed', filter: { player: who }, hasObject: true, hasPlayer: true, rest: m[2], also: [{ event: 'cast', filter: { player: who }, hasObject: true, hasPlayer: true }] };
    }
    if ((m = L.match(/^When(?:ever)? ~ deals (\w+) or more damage to (an opponent|a player|a creature), (.+)$/i))) {
      const n = wordToNumber(m[1]);
      if (typeof n === 'number') {
        const toCreature = /creature/i.test(m[2]);
        return { event: 'dealsDamage', filter: { source: { self: true }, minAmount: n, toPlayer: toCreature ? undefined : true, player: toCreature ? undefined : /opponent/i.test(m[2]) ? 'opponent' : 'any', object: toCreature ? { types: ['Creature'] } : undefined }, hasObject: true, hasPlayer: true, rest: m[3] };
      }
    }
    if ((m = L.match(/^When(?:ever)? ~ deals damage to one or more creatures, (.+)$/i)))
      return { event: 'dealsDamage', filter: { source: { self: true }, object: { types: ['Creature'] } }, hasObject: true, hasPlayer: false, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) enters (untapped|tapped), (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'entersBattlefield', filter: { ...tf, object: { ...tf.object, ...(/untapped/i.test(m[2]) ? { untapped: true } : { tapped: true }) } }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? you'?re dealt (combat )?damage, (.+)$/i)))
      return { event: 'dealtDamage', filter: { player: 'you', toPlayer: true, combat: m[1] ? true : undefined }, hasObject: false, hasPlayer: true, rest: m[2] };
    if ((m = L.match(/^When(?:ever)? one or more creatures an opponent controls attack you and aren'?t blocked, (.+)$/i)))
      return { event: 'attacksUnblocked', filter: { objectController: 'opponent', attacksYou: true }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) is exiled from the battlefield, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'leavesBattlefield', filter: { ...tf, toZone: 'exile' }, hasObject: true, hasPlayer: false, leaves: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) exploits (?:a|an) (.+?), (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: true, exploit: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) transforms(?: into (?:a|an) (.+?))?, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'transformed', filter: tf, hasObject: true, hasPlayer: false, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) with the same name as (?:a|an) (.+?) is cast, (.+)$/i))) return null;
    if ((m = L.match(/^When(?:ever)? you attack with creatures with total power (\w+) or greater(?: for the first time each turn)?, (.+)$/i))) {
      const n = wordToNumber(m[1]);
      if (typeof n === 'number') return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
  }
  {
    // Round 92 heads.
    if ((m = L.match(/^When(?:ever)? the (\w+) ([\w' -]+?) counter is put on ~, (.+)$/i))) {
      const n = wordToNumber(m[1].replace(/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five', sixth: 'six', seventh: 'seven', eighth: 'eight', ninth: 'nine', tenth: 'ten' } as Record<string, string>)[w.toLowerCase()] ?? w));
      if (typeof n === 'number') return { event: 'counterAdded', filter: { self: true, counterType: m[2] }, hasObject: true, hasPlayer: false, rest: `if ~ has ${n} or more ${m[2]} counters on it, ${m[3]}` };
    }
    if ((m = L.match(/^When(?:ever)? the creature ~ haunts dies, (.+)$/i)))
      return { event: 'dies', filter: { custom: 'hauntedBySource' }, hasObject: true, hasPlayer: false, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? a spell or ability you control counters a spell, (.+)$/i)))
      return { event: 'countered', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you cast (?:a|an) (.+?) using mana produced by ~, (.+)$/i))) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (noun) return { event: 'cast', filter: { player: 'you', object: { ...noun.filter, zone: undefined }, custom: 'usingSourceMana' }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? one or more (.+?) you control deal (combat )?damage to your opponents, (.+)$/i))) {
      const noun = parseNoun(`a ${m[1].replace(/s$/i, '')}`);
      if (noun) return { event: 'dealtDamage', filter: { player: 'opponent', toPlayer: true, combat: m[2] ? true : undefined, source: { ...noun.filter, zone: undefined, controller: 'you' } }, hasObject: true, hasPlayer: true, objectIsSource: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? one or more creatures you control deal combat damage to one or more players, (.+)$/i)))
      return { event: 'dealtCombatDamageToPlayer', filter: { player: 'any', source: { types: ['Creature'], controller: 'you' } }, hasObject: true, hasPlayer: true, objectIsSource: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? ~ enters and when you sacrifice it, (.+)$/i)))
      return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'sacrifice', filter: { self: true }, hasObject: true, hasPlayer: false }] };
    if ((m = L.match(/^When(?:ever)? (?:enchanted|equipped) creature attacks and is not blocked, (.+)$/i)))
      return { event: 'attacksUnblocked', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) deals damage to you or (?:a|an) (.+?) you control, (.+)$/i))) {
      const src = parseNoun(`a ${m[1]}`);
      if (src) return { event: 'dealtDamage', filter: { player: 'you', source: { ...src.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? ~ (?:has|gains) (flying|first strike|trample|deathtouch|lifelink|haste|vigilance|reach|menace), (.+)$/i)))
      return { event: 'stateTrigger', hasObject: true, hasPlayer: true, rest: m[2], stateCondition: { kind: 'objectMatches', ref: { ref: 'self' }, filter: { keywords: [m[1].replace(/^[a-z]/, (c) => c.toUpperCase())] } } };
    if ((m = L.match(/^When(?:ever)? you tap ~ for mana, (.+)$/i)))
      return { event: 'tappedForMana', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (an opponent|a player|you) becomes the monarch, (.+)$/i)))
      return { event: 'becomesMonarch', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : /^you$/i.test(m[1]) ? 'you' : 'any' }, hasObject: false, hasPlayer: true, rest: m[2] };
    if ((m = L.match(/^When(?:ever)? ~ becomes crewed(?: for the first time each turn)?, (.+)$/i)))
      return { event: 'crewed', filter: { self: true, firstEachTurn: / for the first time each turn/i.test(m[0]) || undefined }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? there are (\w+) or more ([\w' -]+?) counters on ~, (.+)$/i))) {
      const n = wordToNumber(m[1]);
      if (typeof n === 'number') return { event: 'stateTrigger', hasObject: true, hasPlayer: true, rest: m[3], stateCondition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: m[2], op: '>=', value: n } };
    }
    if ((m = L.match(/^When(?:ever)? you have (\w+) or more life, (.+)$/i))) {
      const n = wordToNumber(m[1]);
      if (typeof n === 'number') return { event: 'stateTrigger', hasObject: false, hasPlayer: true, rest: m[2], stateCondition: { kind: 'life', ref: { ref: 'controller' }, op: '>=', value: n } };
    }
    if ((m = L.match(/^When(?:ever)? (\w+) or more creatures you control attack a player, (.+)$/i)) && wordToNumber(m[1]) !== null)
      return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: `if you control ${m[1]} or more attacking creatures, ${m[2]}` };
    if ((m = L.match(/^When(?:ever)? you cast a spell, (.+)$/i)))
      return { event: 'cast', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) attacks a player alone, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'attacks', filter: { ...tf, custom: 'attacksAlone' }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? you attack with your commander, (.+)$/i)))
      return { event: 'attacks', filter: { object: { isCommander: true }, objectController: 'you' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (a player|an opponent|you) casts a spell from their hand, (.+)$/i)))
      return { event: 'cast', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : /^you$/i.test(m[1]) ? 'you' : 'any', fromZone: 'hand' }, hasObject: true, hasPlayer: true, rest: m[2] };
    if ((m = L.match(/^At end of combat on your turn, (.+)$/i)))
      return { event: 'endOfCombat', filter: { yourTurn: true }, hasObject: false, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? an opponent attacks with creatures, (.+)$/i)))
      return { event: 'attacks', filter: { player: 'opponent', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you (?:gain or lose|lose or gain) life during your turn, (.+)$/i)))
      return { event: 'lifeGained', filter: { player: 'you', yourTurn: true }, hasObject: false, hasPlayer: true, rest: m[1], also: [{ event: 'lifeLost', filter: { player: 'you', yourTurn: true }, hasObject: false, hasPlayer: true }] };
    if ((m = L.match(/^When(?:ever)? (a player|an opponent|you) wins a coin flip, (.+)$/i)))
      return { event: 'coinFlipped', filter: { player: /opponent/i.test(m[1]) ? 'opponent' : /^you$/i.test(m[1]) ? 'you' : 'any', custom: 'wonFlip' }, hasObject: false, hasPlayer: true, rest: m[2] };
    if ((m = L.match(/^When(?:ever)? ~ attacks the player with the most life(?: or tied for most life)?, (.+)$/i)))
      return { event: 'attacks', filter: { self: true, custom: 'attacksMostLife' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you cast a spell that is (white|blue|black|red|green), (.+)$/i))) {
      const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, 'W' | 'U' | 'B' | 'R' | 'G'>)[m[1].toLowerCase()];
      return { event: 'cast', filter: { player: 'you', object: { colors: [cn] } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) dealt damage by (?:equipped|enchanted) creature this turn dies, (.+)$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (noun) return { event: 'dies', filter: { object: { ...noun.filter, zone: undefined, damagedBySource: true } }, hasObject: true, hasPlayer: false, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an) (.+?) becomes the target of a spell or ability you control, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'becomesTarget', filter: { ...tf, player: 'you' }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? you draw your (\w+) card in a turn, (.+)$/i))) {
      const n = wordToNumber(m[1].replace(/^(first|second|third|fourth|fifth)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five' } as Record<string, string>)[w.toLowerCase()] ?? w));
      if (typeof n === 'number') return { event: 'drawCard', filter: { player: 'you', nthThisTurn: n }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? ~ attacks a battle, (.+)$/i)))
      return { event: 'attacks', filter: { self: true, custom: 'attacksBattle' }, hasObject: true, hasPlayer: true, rest: m[1] };
  }
  {
    // Round 91 heads.
    if ((m = L.match(/^When(?:ever)? (\w+) or more creatures attack, (.+)$/i)) && wordToNumber(m[1]) !== null)
      return { event: 'attacks', filter: { firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: `if ${m[1]} or more creatures are attacking, ${m[2]}` };
    if ((m = L.match(/^When(?:ever)? you attack with exactly (\w+) creatures?, (.+)$/i)) && wordToNumber(m[1]) !== null)
      return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: `if you control exactly ${m[1]} attacking creatures, ${m[2]}` };
    if ((m = L.match(/^When(?:ever)? (?:a|an|another) (.+?) attacks or enters attacking, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: m[2], also: [{ event: 'entersBattlefield', filter: { ...tf, custom: 'enteredAttacking' }, hasObject: true, hasPlayer: true }] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|another) (.+?) enters tapped, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf) return { event: 'entersBattlefield', filter: { ...tf, object: { ...tf.object, tapped: true } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? another player casts a spell from anywhere other than their hand, (.+)$/i)))
      return { event: 'cast', filter: { player: 'opponent', notFromZone: 'hand' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you activate a loyalty ability, (.+)$/i)))
      return { event: 'abilityActivated', filter: { player: 'you', custom: 'loyaltyAbility' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you attack enchanted player, (.+)$/i)))
      return { event: 'attacks', filter: { player: 'you', custom: 'attacksAttachedPlayer' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you create one or more tokens(?: for the first time each turn)?, (.+)$/i)))
      return { event: 'tokenCreated', filter: { player: 'you', firstEachTurn: / for the first time each turn/i.test(m[0]) || undefined }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? you become the target of a spell or ability(?: an opponent controls)?, (.+)$/i)))
      return { event: 'becomesTarget', filter: { player: / an opponent controls/i.test(m[0]) ? 'opponent' : 'any', custom: 'targetsYou' }, hasObject: true, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? ~ deals combat damage to one or more blocking creatures, (.+)$/i)))
      return { event: 'dealsCombatDamage', filter: { source: { self: true }, object: { types: ['Creature'], blocking: true } }, hasObject: true, hasPlayer: false, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? your commander deals combat damage to (a player|an opponent), (.+)$/i)))
      return { event: 'dealtCombatDamageToPlayer', filter: { object: { isCommander: true, controller: 'you' }, player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
    if ((m = L.match(/^When(?:ever)? ~ and\/or one or more other (.+?) you control enter, (.+)$/i))) {
      const tf = nounFilter(`a ${m[1]}`);
      if (tf?.object) return { event: 'entersBattlefield', filter: { object: { ...tf.object, controller: undefined }, objectController: 'you' }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
  }
  {
    // Fallback heads: only reached when no earlier pattern matched.
    const nf = (t0: string): ObjectFilter | null => {
      const t = t0.trim().replace(/^(?:a|an|another|one or more) /i, '');
      for (const c of [t, t.replace(/s$/i, ''), t.replace(/^(\S+)s\b/i, '$1')]) {
        const n = parseNoun(`a ${c}`);
        if (n) {
          const f = { ...n.filter };
          delete f.zone;
          return f;
        }
      }
      return null;
    };
    const tfOf = (t: string): TriggerFilter | null => {
      const f = nf(t);
      if (!f) return null;
      const tf: TriggerFilter = { object: f };
      if (f.controller === 'you') {
        delete tf.object!.controller;
        tf.objectController = 'you';
      } else if (f.controller === 'opponent') {
        delete tf.object!.controller;
        tf.objectController = 'opponent';
      }
      return tf;
    };
    const who = (t: string): 'you' | 'opponent' | 'any' => (/opponent/i.test(t) ? 'opponent' : /^you$/i.test(t.trim()) ? 'you' : 'any');
    // Haunt: the ability triggers on entering and again when the haunted creature dies.
    if ((m = L.match(/^When(?:ever)? ~ enters or the (?:creature|permanent) it haunts dies, (.+)$/i)))
      return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'dies', filter: { custom: 'hauntedBySource' }, hasObject: true, hasPlayer: false }] };
    if ((m = L.match(/^At (?:the )?end of combat, (.+)$/i))) return { event: 'endOfCombat', hasObject: false, hasPlayer: true, rest: m[1] };
    if ((m = L.match(/^When(?:ever)? (~|(?:equipped|enchanted) creature) becomes blocked by (?:a|an|one or more) (.+?), (.+)$/i))) {
      const src = nf(m[2]);
      if (src) return { event: 'becomesBlocked', filter: m[1] === '~' ? { self: true, source: src } : { attachedToSource: true, source: src }, hasObject: true, hasPlayer: false, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (~|(?:equipped|enchanted) creature) blocks or becomes blocked by (?:a|an|one or more) (.+?), (.+)$/i))) {
      const src = nf(m[2]);
      const base: TriggerFilter = m[1] === '~' ? { self: true } : { attachedToSource: true };
      if (src) return { event: 'blocks', filter: { ...base, source: src }, hasObject: true, hasPlayer: false, rest: m[3], also: [{ event: 'becomesBlocked', filter: { ...base, source: src }, hasObject: true, hasPlayer: false }] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|another) (.+?) becomes (tapped|untapped), (.+)$/i))) {
      const tf = tfOf(m[1]);
      if (tf) return { event: m[2].toLowerCase() === 'tapped' ? 'tapped' : 'untapped', filter: tf, hasObject: true, hasPlayer: false, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|another) (.+?) is tapped for mana, (.+)$/i))) {
      const tf = tfOf(m[1]);
      if (tf) return { event: 'tappedForMana', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (an opponent|a player|you) taps? (?:a|an|another) (.+?) for mana, (.+)$/i))) {
      const tf = tfOf(m[2]);
      if (tf) return { event: 'tappedForMana', filter: { ...tf, player: who(m[1]) }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (you|an opponent|a player) plays? (?:a|an|another) (.+?), (.+)$/i))) {
      const tf = tfOf(m[2]);
      if (tf) return { event: 'landPlayed', filter: { ...tf, player: who(m[1]) }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (a player|an opponent|you) puts? (?:a|an|another|one or more) (.+?) onto the battlefield, (.+)$/i))) {
      const tf = tfOf(m[2]);
      if (tf) return { event: 'entersBattlefield', filter: { ...tf, player: who(m[1]) }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|another) (.+?) attacks one of your opponents, (.+)$/i))) {
      const tf = tfOf(m[1]);
      if (tf) return { event: 'attacks', filter: { ...tf, otherPlayer: 'opponent' }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (~|(?:a|an|another) .+?) becomes the target of (?:a|an) (.+?), (.+)$/i))) {
      const src = nf(m[2]);
      const tgt: TriggerFilter | null = m[1] === '~' ? { self: true } : tfOf(m[1]);
      if (src && tgt) return { event: 'becomesTarget', filter: { ...tgt, source: src }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (you|an opponent|a player) casts? (?:your|their) first (.+?) each turn, (.+)$/i))) {
      const f = nf(m[2]);
      if (f) return { event: 'cast', filter: { player: who(m[1]), object: f, firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? enchanted player casts? (?:a|an) (.+?), (.+)$/i))) {
      const f = nf(m[1]);
      if (f) return { event: 'cast', filter: { custom: 'enchantedPlayer', object: f }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|one or more) ([+-]\d\/[+-]\d|[\w' -]+?) counters? (?:is|are) put on ~, (.+)$/i)))
      return { event: 'counterAdded', filter: { self: true, counterType: m[1] }, hasObject: true, hasPlayer: false, rest: m[2] };
    if ((m = L.match(/^When(?:ever)? (?:a|an|one or more) ([+-]\d\/[+-]\d|[\w' -]+?) counters? (?:is|are) put on (?:a|an|one or more) (.+?), (.+)$/i))) {
      const tf = tfOf(m[2]);
      if (tf) return { event: 'counterAdded', filter: { ...tf, counterType: m[1] }, hasObject: true, hasPlayer: false, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (you|an opponent|a player) discards? one or more (.+?), (.+)$/i))) {
      const f = nf(m[2]);
      if (f) return { event: 'discardBatch', filter: { player: who(m[1]), object: f }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|one or more) (.+?) deals? (combat )?damage to (you|~|a player|an opponent|(?:a|an) .+?), (.+)$/i))) {
      const src = nf(m[1]);
      const to = m[3];
      if (src && /^you$/i.test(to)) return { event: 'dealtDamage', filter: { player: 'you', toPlayer: true, combat: m[2] ? true : undefined, source: src }, hasObject: false, hasPlayer: true, rest: m[4] };
      if (src && to === '~') return { event: 'dealtDamage', filter: { self: true, combat: m[2] ? true : undefined, source: src }, hasObject: true, hasPlayer: true, rest: m[4] };
      if (src && /^(?:a player|an opponent)$/i.test(to)) return { event: m[2] ? 'dealsCombatDamage' : 'dealsDamage', filter: { player: who(to), toPlayer: true, source: src }, hasObject: true, hasPlayer: true, rest: m[4] };
      const obj = src ? nf(to) : null;
      if (src && obj) return { event: m[2] ? 'dealsCombatDamage' : 'dealsDamage', filter: { source: src, object: obj }, hasObject: true, hasPlayer: false, rest: m[4] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an|one or more) (.+?) deals? (combat )?damage, (.+)$/i))) {
      const src = nf(m[1]);
      if (src) return { event: m[2] ? 'dealsCombatDamage' : 'dealsDamage', filter: { source: src }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    if ((m = L.match(/^When(?:ever)? you attack with (\w+) or more (.+?), (.+)$/i)) && wordToNumber(m[1]) !== null)
      return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: `if you control ${m[1]} or more attacking ${m[2]}, ${m[3]}` };
    if ((m = L.match(/^When(?:ever)? ~ or (?:a|an|another) (.+?) leaves the battlefield, (.+)$/i))) {
      const tf = tfOf(m[1]);
      if (tf?.object) {
        delete tf.object.other;
        return { event: 'leavesBattlefield', filter: tf, hasObject: true, hasPlayer: false, leaves: true, rest: m[2] };
      }
    }
    // ---- Round 120 heads ----
    // "Whenever you put a +1/+1 counter on another creature, ..."
    if ((m = L.match(/^Whenever you put (?:a|an) (?:([+-]\d\/[+-]\d|\w+) )?counters? on (.+?), (.+)$/i))) {
      const target = m[2].trim();
      if (/^(?:a permanent or player|a permanent|a player)$/i.test(target)) return { event: 'counterAdded', filter: { player: 'you', counterType: m[1] }, hasObject: true, hasPlayer: true, rest: m[3] };
      const f = nf(target);
      if (f) return { event: 'counterAdded', filter: { player: 'you', object: f, counterType: m[1] }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    // "Whenever you turn a permanent face up, ..."
    if ((m = L.match(/^Whenever you turn (?:a|an) (.+?) face up, (.+)$/i))) {
      const f = nf(m[1]);
      if (f) return { event: 'turnedFaceUp', filter: { player: 'you', object: f }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    // "Whenever you tap a permanent for {C}, ..." / "Whenever you tap a land for mana, ..."
    if ((m = L.match(/^Whenever you tap (?:a|an) (.+?) for (?:mana|(\{[^}]+\})), (.+)$/i))) {
      const f = nf(m[1]);
      if (f) return { event: 'tappedForMana', filter: { player: 'you', object: f }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    // "Whenever you sacrifice ~ or another artifact, ..."
    if ((m = L.match(/^Whenever you sacrifice ~ or another (.+?), (.+)$/i))) {
      const f = nf(m[1]);
      if (f) {
        delete f.other;
        return { event: 'sacrifice', filter: { player: 'you', object: f }, hasObject: true, hasPlayer: true, leaves: true, rest: m[2] };
      }
    }
    // "Whenever ~ or another permanent enters from a graveyard, ..."
    if ((m = L.match(/^Whenever ~ or another (.+?) enters from (?:a|your) graveyard, (.+)$/i))) {
      const f = nf(m[1]);
      if (f) {
        delete f.other;
        return { event: 'entersBattlefield', filter: { object: { ...f, custom: 'fromGraveyard' } }, hasObject: true, hasPlayer: true, rest: m[2] };
      }
    }
    if ((m = L.match(/^Whenever (?:a|an) (.+?) enters from (?:a|your) graveyard, (.+)$/i))) {
      const f = nf(m[1]);
      if (f) return { event: 'entersBattlefield', filter: { object: { ...f, custom: 'fromGraveyard' } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    // "Whenever you copy an instant spell, ..."
    if ((m = L.match(/^Whenever you copy (?:a|an) (.+?) spell, (.+)$/i))) {
      const noun = parseNoun(`a ${m[1]} spell`);
      if (noun) return { event: 'spellCopied', filter: { player: 'you', object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    // "Whenever you cast a spell that targets one or more permanents, ..."
    if ((m = L.match(/^Whenever you cast (?:a|an) (.*?)spell with (?:one or more targets|a single target), (.+)$/i)) || (m = L.match(/^Whenever you cast (?:a|an) (.*?)spell that targets one or more (?:permanents|creatures|players), (.+)$/i))) {
      const noun = m[1].trim() ? parseNoun(`a ${m[1].trim()} spell`) : { filter: {} as ObjectFilter };
      if (noun) return { event: 'cast', filter: { player: 'you', object: { ...noun.filter, zone: undefined } }, hasObject: true, hasPlayer: true, rest: m[2] };
    }
    // "Whenever you cast your third spell in a turn, ..."
    if ((m = L.match(/^Whenever you cast your (second|third|fourth|fifth) spell (?:in|each) (?:a )?turn, (.+)$/i))) {
      const nth = { second: 1, third: 2, fourth: 3, fifth: 4 }[m[1].toLowerCase() as 'second'];
      return { event: 'cast', filter: { player: 'you' }, hasObject: true, hasPlayer: true, rest: `if you have cast exactly ${nth} other spells this turn, ${m[2]}` };
    }
    // "Whenever ~ and at least one other Warrior attack, ..."
    if ((m = L.match(/^Whenever ~ and at least one (?:other )?(.+?) attacks?, (.+)$/i))) {
      const f = nf(m[1]);
      if (f) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control two or more attacking ${m[1]}s, ${m[2]}` };
    }
    // ---- Round 115 heads ----
    // "Whenever you put one or more counters on a permanent or player, ..."
    if ((m = L.match(/^Whenever you put one or more (?:([+-]\d\/[+-]\d|\w+) )?counters? on (.+?), (.+)$/i))) {
      const target = m[2].trim();
      if (/^(?:a permanent or player|a permanent|a player)$/i.test(target)) return { event: 'counterAdded', filter: { player: 'you', counterType: m[1] }, hasObject: true, hasPlayer: true, rest: m[3] };
      const f = nf(target);
      if (f) return { event: 'counterAdded', filter: { player: 'you', object: f, counterType: m[1] }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    // "Whenever one or more +1/+1 counters are put on another permanent you control, ..."
    if ((m = L.match(/^Whenever (?:one or more|a|an) (?:([+-]\d\/[+-]\d|\w+) )?counters? (?:is|are) put on (.+?)(?: for the first time each turn)?, (.+)$/i))) {
      const f = nf(m[2]);
      if (f) return { event: 'counterAdded', filter: { object: f, counterType: m[1], firstEachTurn: /first time each turn/i.test(L) || undefined }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    // "Whenever one or more loyalty counters are removed from ~, ..."
    if ((m = L.match(/^Whenever (?:one or more|a|an) (?:([+-]\d\/[+-]\d|\w+) )?counters? (?:is|are) removed from (.+?), (.+)$/i))) {
      const f = /^~$/.test(m[2].trim()) ? { self: true } : nf(m[2]);
      if (f) return { event: 'counterRemoved', filter: /^~$/.test(m[2].trim()) ? { self: true, counterType: m[1] } : { object: f as ObjectFilter, counterType: m[1] }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    // "Whenever you cast a spell that is white, ..." / "... that is both red and white, ..."
    if ((m = L.match(/^Whenever you cast (?:a|an) (.+?) spell that is (?:both )?((?:white|blue|black|red|green)(?:(?: and| or|,) (?:white|blue|black|red|green))*), (.+)$/i)) || (m = L.match(/^Whenever you cast (?:a|an) (spell) that is (?:both )?((?:white|blue|black|red|green)(?:(?: and| or|,) (?:white|blue|black|red|green))*), (.+)$/i))) {
      const map: Record<string, 'W' | 'U' | 'B' | 'R' | 'G'> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
      const cols = m[2].split(/(?: and | or |,\s*)/).map((w) => map[w.trim().toLowerCase()]).filter(Boolean);
      const base = /^spell$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]} spell`);
      if (base && cols.length) return { event: 'cast', filter: { player: 'you', object: { ...base.filter, zone: undefined, colors: cols } }, hasObject: true, hasPlayer: true, rest: m[3] };
    }
    // "Whenever you copy a spell, ..." / "Whenever you collect evidence, ..."
    if ((m = L.match(/^Whenever you (copy a spell|collect evidence|waterbend|firebend|earthbend|airbend|surveil|explore|cycle a card|proliferate|investigate|connive|venture into the dungeon), (.+)$/i))) {
      const ev: Record<string, string> = { 'copy a spell': 'spellCopied', 'collect evidence': 'evidenceCollected', waterbend: 'waterbend', firebend: 'firebend', earthbend: 'earthbend', airbend: 'airbend', surveil: 'surveil', explore: 'explored', 'cycle a card': 'cycled', proliferate: 'proliferated', investigate: 'investigated', connive: 'connived', 'venture into the dungeon': 'ventured' };
      const name = ev[m[1].toLowerCase()];
      if (name) return { event: name as import('@commander/engine').GameEventName, filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[2] };
    }
    if ((m = L.match(/^When(?:ever)? (?:a|an) (\w+), (\w+),? or (\w+) enters(?: the battlefield)?, (.+)$/i))) {
      const types = [m[1], m[2], m[3]].map((t) => `${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()}`);
      return { event: 'entersBattlefield', filter: { object: { types } }, hasObject: true, hasPlayer: true, rest: m[4] };
    }
  }
  if ((m = L.match(/^At the beginning of each end step, if you control (?:a|an) (.+?), (.+)$/i))) return null; // let generic handle
  return null;
}

/** Strip a leading "you may" and intervening-if clause. */
export function splitTriggerRest(rest: string): { optional: boolean; condition: string | null; rest: string } {
  let r = rest.trim();
  let condition: string | null = null;
  let m = r.match(/^if (.+?), (.+)$/i);
  if (m && /\bthe difference\b/i.test(m[2])) m = null;
  if (m) {
    condition = m[1];
    r = m[2];
  }
  let optional = false;
  if ((m = r.match(/^you may (.+)$/i)) && !/^you may pay /i.test(r)) {
    optional = true;
    r = m[1];
    r = r.replace(/^have (.+?) deal /i, '$1 deals ').replace(/^have (.+?) fight /i, '$1 fights ');
  }
  return { optional, condition, rest: r };
}
