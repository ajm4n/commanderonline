import type { Amount, Ref } from '@commander/engine';
import { wordToNumber } from './text.js';
import { parseNoun } from './nouns.js';

export interface RefCtx {
  self: Ref;
  lastObj: Ref | null;
  triggerHasObject: boolean;
}

/** Parse an amount phrase. Returns null if not understood. */
export function parseAmount(text: string, ctx: RefCtx): Amount | null {
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
  if (t === 'twice that much' || t === 'twice that many') return { kind: 'times', a: { kind: 'triggerAmount' }, b: 2 };
  if ((m = t.match(/^(?:its|that creature's|~'s|this creature's) (power|toughness)$/))) {
    const ref = /~|this/.test(m[0]) ? ctx.self : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : ctx.self);
    return { kind: m[1] as 'power' | 'toughness', ref };
  }
  if ((m = t.match(/^(?:its|that card's|that spell's|~'s) mana value$/))) return { kind: 'manaValue', ref: /~/.test(m[0]) ? ctx.self : ctx.lastObj ?? { ref: 'triggerObject' } };
  if (t === 'your life total') return { kind: 'life', ref: { ref: 'controller' } };
  if (t === 'the number of cards in your hand' || t === 'the number of cards in hand') return { kind: 'handSize', ref: { ref: 'controller' } };
  if (t === 'the number of cards in that player\'s hand' || t === "the number of cards in their hand") return { kind: 'handSize', ref: { ref: 'triggerPlayer' } };
  if (t === 'the number of cards in your graveyard') return { kind: 'graveyardSize', ref: { ref: 'controller' } };
  if ((m = t.match(/^the number of (\w+) cards in your graveyard$/))) {
    const noun = parseNoun(`${oc(m, 1)} card`);
    return noun ? { kind: 'graveyardSize', ref: { ref: 'controller' }, filter: noun.filter } : null;
  }
  if (t === 'the number of lands you control') return { kind: 'landsYouControl' };
  if (t === 'the number of opponents you have' || t === 'the number of your opponents') return { kind: 'opponents' };
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
