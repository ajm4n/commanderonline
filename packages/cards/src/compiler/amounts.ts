import type { Amount, Ref } from '@commander/engine';
import { wordToNumber } from './text.js';
import { parseNoun } from './nouns.js';

export interface RefCtx {
  self: Ref;
  lastObj: Ref | null;
  triggerHasObject: boolean;
  lastPlayer?: Ref | null;
  triggerHasPlayer?: boolean;
}

/** "their"/"that player's" inside an amount: the player the sentence is about. */
function thatPlayer(ctx: RefCtx): Ref {
  return ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' } : { ref: 'controller' });
}

/** Parse an amount phrase. Returns null if not understood. */
export function parseAmount(text: string, ctx: RefCtx): Amount | null {
  text = text.replace(/\byou've\b/gi, 'you have').replace(/\bopponents? you have\b/i, 'opponents you have').replace(/\b([+\-\w\/]+) counter on\b/i, '$1 counters on');
  {
    const t0 = text.trim().toLowerCase().replace(/^the number of /, '');
    const ev = t0.match(/^(creatures?|permanents?|spells?|cards?|instant or sorcery spells?|nontoken creatures?) (?:that )?(died|entered(?: the battlefield)?|you have cast|your opponents have cast|an opponent has cast|you have drawn|you have discarded|you have sacrificed|were sacrificed|you have milled|were milled)(?: under your control)? this turn$/);
    if (ev) {
      const v = ev[2];
      const event: import('@commander/engine').GameEventName = /died/.test(v) ? 'dies' : /entered/.test(v) ? 'entersBattlefield' : /cast/.test(v) ? 'cast' : /drawn/.test(v) ? 'drawCard' : /discard/.test(v) ? 'discard' : /sacrific/.test(v) ? 'sacrifice' : 'mill';
      const player: 'you' | 'opponent' | 'any' = /^you have|under your control/.test(v) || /under your control/.test(t0) ? 'you' : /opponent/.test(v) ? 'opponent' : 'any';
      return { kind: 'eventsThisTurn', event, player };
    }
    const tp = t0.match(/^(?:the )?total (power|mana value) of (.+)$/);
    if (tp) {
      const noun = parseNoun(text.trim().slice(text.trim().length - tp[2].length));
      if (noun) return tp[1] === 'power' ? { kind: 'totalPower', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } } : { kind: 'totalManaValue', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } };
    }
  }
  if (/^(?:the number of )?[+\-\w\/]+ counters? removed this way$/i.test(text.trim())) return 'X';
  if (/^(?:the number of )?creatures? blocking (?:it|~|that creature)$/i.test(text.trim())) return { kind: 'countRef', ref: { ref: 'blockersOf', of: /~$/.test(text.trim()) ? { ref: 'self' } : ctx.lastObj ?? { ref: 'self' } } };
  const orig = text.trim().replace(/^(?:an amount of \w+ |a number of \w+ )?equal to /i, '');
  const t = orig.toLowerCase();
  /** Original-case text of a capture group (lowercasing preserves length). */
  const oc = (m: RegExpMatchArray, g: number): string => {
    const idx = t.indexOf(m[g]);
    return idx >= 0 ? orig.slice(idx, idx + m[g].length) : m[g];
  };
  const n = wordToNumber(t);
  if (n !== null) return n;
  let m: RegExpMatchArray | null;
  if (t === 'that much' || t === 'that many' || t === 'that much damage' || t === 'that amount') return { kind: 'triggerAmount' };
  if (t === 'the life lost this way' || t === 'the total life lost this way' || t === 'the total amount of life lost this way' || t === 'the amount of life lost this way') return { kind: 'ctxMemory', key: 'lifeLostThisWay' };
  if (t === 'the number of cards milled this way' || t === 'the number of cards put into your graveyard this way') return { kind: 'ctxMemory', key: 'lastMoved' };
  if (t === 'the number of cards revealed this way') return { kind: 'ctxMemory', key: 'revealedCount' };
  if (t === 'twice that much' || t === 'twice that many') return { kind: 'times', a: { kind: 'triggerAmount' }, b: 2 };
  if ((m = t.match(/^(twice|three times|double) (.+)$/))) {
    const inner = parseAmount(oc(m, 2), ctx);
    if (inner !== null) return { kind: 'times', a: inner, b: /three/.test(m[1]) ? 3 : 2 };
  }
  if (t === 'that many cards minus one' || t === 'that many minus one') return { kind: 'sum', parts: [{ kind: 'discardedThisWay', ref: { ref: 'iter' } }, -1] };
  if (t === 'the greatest number of cards a player discarded this way') return { kind: 'ctxMemory', key: 'maxDiscarded' };
  if (t === 'the number of cards discarded this way') return { kind: 'ctxMemory', key: 'discardedCount' };
  if ((m = t.match(/^half (.+?)(?:, rounded (up|down))?$/))) {
    const inner = parseAmount(oc(m, 1), ctx);
    if (inner !== null) return { kind: 'half', a: inner, round: m[2] === 'up' ? 'up' : 'down' };
  }
  if ((m = t.match(/^the number of cards in (your|their|that player's) library$/))) return { kind: 'librarySize', ref: m[1] === 'your' ? { ref: 'controller' } : thatPlayer(ctx) };
  if (t === 'their life total' || t === "that player's life total") return { kind: 'life', ref: thatPlayer(ctx) };
  if (t === 'the number of cards in their library') return { kind: 'librarySize', ref: thatPlayer(ctx) };
  if ((m = t.match(/^the number of (.+?) cards? put into (?:a|your|their) graveyard this way$/)) || (m = t.match(/^the number of (.+?) cards? milled this way$/))) {
    const noun = parseNoun(`a ${oc(m, 1)} card`);
    if (noun) return { kind: 'countRef', ref: { ref: 'lastMoved' }, filter: noun.filter };
  }
  if ((m = t.match(/^(?:its|that creature's|~'s|this creature's) (power|toughness)$/))) {
    const ref = /~|this/.test(m[0]) ? ctx.self : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : ctx.self);
    return { kind: m[1] as 'power' | 'toughness', ref };
  }
  if ((m = t.match(/^(?:its|that card's|that spell's|that permanent's|that creature's|the sacrificed creature's|the exiled card's|~'s) mana value$/))) return { kind: 'manaValue', ref: /~/.test(m[0]) ? ctx.self : ctx.lastObj ?? { ref: 'triggerObject' } };
  if ((m = t.match(/^the sacrificed (?:creature|permanent)'s (power|toughness)$/))) return { kind: m[1] as 'power', ref: ctx.lastObj ?? { ref: 'triggerObject' } };
  if ((m = t.match(/^the number of cards in (that player's|their) hand$/))) return { kind: 'handSize', ref: thatPlayer(ctx) };
  if (t === 'your life total') return { kind: 'life', ref: { ref: 'controller' } };
  if (t === 'the number of cards in your hand' || t === 'the number of cards in hand') return { kind: 'handSize', ref: { ref: 'controller' } };
  if (t === 'the number of cards in that player\'s hand' || t === "the number of cards in their hand") return { kind: 'handSize', ref: { ref: 'triggerPlayer' } };
  if (t === 'the number of cards in your graveyard') return { kind: 'graveyardSize', ref: { ref: 'controller' } };
  if ((m = t.match(/^the number of (\w+) cards in your graveyard$/))) {
    const noun = parseNoun(`${oc(m, 1)} card`);
    return noun ? { kind: 'graveyardSize', ref: { ref: 'controller' }, filter: noun.filter } : null;
  }
  if (t === 'the number of lands you control') return { kind: 'landsYouControl' };
  if ((m = t.match(/^the (greatest|highest) (power|toughness|mana value) among (.+)$/))) {
    const noun = parseNoun(oc(m, 3));
    if (noun) return { kind: 'maxOf', stat: m[2] === 'power' ? 'power' : m[2] === 'toughness' ? 'toughness' : 'manaValue', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } };
  }
  if (t === 'the number of creatures in your party') return { kind: 'partySize' };
  if (t === 'the number of times it was kicked' || t === 'the number of times ~ was kicked') return { kind: 'kickCount' };
  if (t === 'the number of opponents you have' || t === 'the number of your opponents' || t === 'opponents you have' || t === 'your opponents' || t === 'the number of opponents') return { kind: 'opponents' };
  if (t === 'the number of spells you have cast this turn' || t === 'spells you have cast this turn' || t === 'spell you have cast this turn' || t === 'the number of spell you have cast this turn' || t === 'the number of other spells you have cast this turn') return { kind: 'spellsCastThisTurn' };
  if (t === 'the number of cards you have drawn this turn' || t === 'cards you have drawn this turn' || t === 'card you have drawn this turn' || t === 'the number of card you have drawn this turn') return { kind: 'cardsDrawnThisTurn' };
  if (t === 'the number of experience counters you have') return { kind: 'turnStat', key: 'experience' };
  if ((m = t.match(/^the number of (\+1\/\+1|-1\/-1|charge|loyalty|lore|\w+) counters on (~|it|that creature|this creature)$/))) return { kind: 'countersOn', ref: /~|this/.test(m[2]) ? ctx.self : ctx.lastObj ?? ctx.self, counter: m[1] };
  if ((m = t.match(/^the number of (.+?)(?: on the battlefield)?$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter } };
  }
  if ((m = t.match(/^(\d+|x) plus the number of (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const base = wordToNumber(m[1]);
    if (noun && base !== null) return { kind: 'sum', parts: [base, { kind: 'count', filter: noun.filter }] };
  }
  if ((m = t.match(/^(?:the )?damage dealt(?: this way)?$/))) return { kind: 'triggerAmount' };
  if ((m = t.match(/^your devotion to (white|blue|black|red|green)$/))) return { kind: 'devotion', colors: [({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1] as 'white']] };
  if (t === 'the number of creatures you control') return { kind: 'count', filter: { types: ['Creature'], controller: 'you' } };
  if (t === 'the number of spells you have cast this turn' || t === 'the number of other spells you have cast this turn') return { kind: 'spellsCastThisTurn' };
  return null;
}
