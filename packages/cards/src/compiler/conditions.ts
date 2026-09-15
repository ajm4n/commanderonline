import type { Condition } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { parseAmount, type RefCtx } from './amounts.js';
import { wordToNumber } from './text.js';

export function parseCondition(text: string, ctx: RefCtx): Condition | null {
  const orig = text.trim().replace(/[.,]$/, '');
  const t = orig.toLowerCase();
  const oc = (m: RegExpMatchArray, g: number): string => {
    const idx = t.indexOf(m[g]);
    return idx >= 0 ? orig.slice(idx, idx + m[g].length) : m[g];
  };
  let m: RegExpMatchArray | null;
  if (t === 'it is your turn' || t === "it's your turn") return { kind: 'yourTurn' };
  if (t === 'it is not your turn') return { kind: 'notYourTurn' };
  if (t === 'you control your commander' || t === 'you control a commander') return { kind: 'controlsCommander' };
  if (t === 'you are the monarch') return { kind: 'isMonarch', ref: { ref: 'controller' } };
  if (t === 'you have no cards in hand') return { kind: 'handSize', ref: { ref: 'controller' }, op: '==', value: 0 };
  if ((m = t.match(/^you have (\w+) or more cards in hand$/))) return { kind: 'handSize', ref: { ref: 'controller' }, op: '>=', value: wordToNumber(m[1]) ?? 1 };
  if ((m = t.match(/^you have (\w+) or fewer cards in hand$/))) return { kind: 'handSize', ref: { ref: 'controller' }, op: '<=', value: wordToNumber(m[1]) ?? 1 };
  if ((m = t.match(/^you control (\w+) or more (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && n !== null) return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, op: '>=', value: n };
  }
  if ((m = t.match(/^you control (\w+) or fewer (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && n !== null) return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, op: '<=', value: n };
  }
  if ((m = t.match(/^you control (?:a|an|another) (.+)$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield', other: /another/.test(m[0]) }, op: '>=', value: 1 };
  }
  if ((m = t.match(/^you control no (.+)$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, op: '==', value: 0 };
  }
  if ((m = t.match(/^there are (\w+) or more (.+?) in your graveyard$/))) {
    const noun = parseNoun(`${oc(m, 2)}`);
    const n = wordToNumber(m[1]);
    if (n !== null) return { kind: 'graveyard', ref: { ref: 'controller' }, op: '>=', value: n, filter: noun?.filter };
  }
  if ((m = t.match(/^(?:~|it) is (tapped|untapped)$/))) return m[1] === 'tapped' ? { kind: 'isTapped', ref: ctx.self } : { kind: 'not', c: { kind: 'isTapped', ref: ctx.self } };
  if ((m = t.match(/^(?:~|it) is attacking$/))) return { kind: 'isAttacking', ref: ctx.self };
  if ((m = t.match(/^(?:~|it) has (?:a|an) ([+-]\d\/[+-]\d|\w+) counter on it$/))) return { kind: 'hasCounter', ref: ctx.self, counter: m[1] };
  if ((m = t.match(/^(?:~|it) has (\w+) or more ([+-]\d\/[+-]\d|\w+) counters on it$/))) return { kind: 'hasCounter', ref: ctx.self, counter: m[2], op: '>=', value: wordToNumber(m[1]) ?? 1 };
  if ((m = t.match(/^(?:that|the) (?:creature|permanent|card|spell) (?:is|was) (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'objectMatches', ref: ctx.lastObj ?? { ref: 'triggerObject' }, filter: noun.filter };
  }
  if ((m = t.match(/^it is (?:a|an) (.+?) card$/)) || (m = t.match(/^it is (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'objectMatches', ref: ctx.lastObj ?? { ref: 'lastMoved' }, filter: noun.filter };
  }
  if ((m = t.match(/^you have (\w+|\d+) or (more|less) life$/))) return { kind: 'life', ref: { ref: 'controller' }, op: m[2] === 'more' ? '>=' : '<=', value: wordToNumber(m[1]) ?? 0 };
  if ((m = t.match(/^your life total is (?:less than|greater than) (\d+)$/))) return { kind: 'life', ref: { ref: 'controller' }, op: /less/.test(t) ? '<' : '>', value: parseInt(m[1], 10) };
  if ((m = t.match(/^~ was kicked$/))) return { kind: 'wasKicked' };
  if ((m = t.match(/^(?:~|this spell) was cast from (?:your )?(graveyard|hand|exile)$/))) return { kind: 'castFrom', zone: m[1] as 'graveyard' };
  if ((m = t.match(/^(.+?) is (\d+) or (more|less)$/))) {
    const a = parseAmount(m[1], ctx);
    if (a !== null) return { kind: 'amount', a, op: m[3] === 'more' ? '>=' : '<=', b: parseInt(m[2], 10) };
  }
  if ((m = t.match(/^you have (\w+) or more (poison|experience) counters$/))) { const v = wordToNumber(m[1]); return { kind: 'turnStat', key: m[2], op: '>=', value: typeof v === 'number' ? v : 0 }; }
  if ((m = t.match(/^an opponent has more life than you$/))) return { kind: 'manual', text: 'Does an opponent have more life than you?' };
  return null;
}
