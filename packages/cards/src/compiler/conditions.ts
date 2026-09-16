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
  // "you control a Mountain or a Plains" → "you control a Mountain or Plains"
  if ((m = orig.match(/^(.+?) (?:a|an) (.+?) or (?:a|an) (.+)$/i)) && /^you control|^an opponent controls/i.test(m[1])) {
    const r = parseCondition(`${m[1]} a ${m[2]} or ${m[3]}`, ctx);
    if (r) return r;
  }
  // Conjunctions: "X and Y"
  if ((m = orig.match(/^(.+?) and (.+)$/i))) {
    const a = parseCondition(m[1], ctx);
    const b = parseCondition(m[2], ctx);
    if (a && b && a.kind !== 'manual' && b.kind !== 'manual') return { kind: 'and', cs: [a, b] };
  }
  const thatPlayer: import('@commander/engine').Ref = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' } : { ref: 'controller' });
  if (t === 'that player has no cards in hand' || t === 'they have no cards in hand') return { kind: 'handSize', ref: thatPlayer, op: '==', value: 0 };
  if ((m = t.match(/^that player has (\w+) or more cards in hand$/))) return { kind: 'handSize', ref: thatPlayer, op: '>=', value: wordToNumber(m[1]) ?? 1 };
  if ((m = t.match(/^(.+?) have total power (\w+) or (greater|less)$/))) {
    const noun = parseNoun(oc(m, 1));
    const n = wordToNumber(m[2]);
    if (noun && typeof n === 'number') return { kind: 'amount', a: { kind: 'totalPower', filter: { ...noun.filter, zone: 'battlefield' } }, op: m[3] === 'greater' ? '>=' : '<=', b: n };
  }
  if (t === 'you have a full party') return { kind: 'amount', a: { kind: 'partySize' }, op: '>=', b: 4 };
  if ((m = t.match(/^an opponent has (\w+) or more poison counters$/))) return { kind: 'playerStat', stat: 'poison', ref: { ref: 'eachOpponent' }, op: '>=', value: wordToNumber(m[1]) as number };
  if ((m = t.match(/^there are (\w+) or more ([+\-\w\/]+) counters on ~$/))) return { kind: 'hasCounter', ref: ctx.self, counter: oc(m, 2), op: '>=', value: wordToNumber(m[1]) as number };
  if ((m = t.match(/^you have exactly (\w+) cards in hand$/))) return { kind: 'handSize', ref: { ref: 'controller' }, op: '==', value: wordToNumber(m[1]) as number };
  if ((m = t.match(/^you have (\w+) or more opponents$/))) return { kind: 'amount', a: { kind: 'opponents' }, op: '>=', b: wordToNumber(m[1]) ?? 2 };
  if ((m = t.match(/^a player has (\d+) or (less|more) life$/))) return { kind: 'or', cs: [{ kind: 'life', ref: { ref: 'controller' }, op: m[2] === 'less' ? '<=' : '>=', value: parseInt(m[1], 10) }, { kind: 'life', ref: { ref: 'eachOpponent' }, op: m[2] === 'less' ? '<=' : '>=', value: parseInt(m[1], 10) }] };
  if ((m = t.match(/^(.+?) is (less than|greater than|fewer than|more than) (\w+)$/))) {
    const a = parseAmount(oc(m, 1), ctx);
    const n = wordToNumber(m[3]);
    if (a !== null && typeof n === 'number') return { kind: 'amount', a, op: /less|fewer/.test(m[2]) ? '<' : '>', b: n };
  }
  if ((m = t.match(/^(.+?) is (\w+) or (more|greater|less|fewer)$/))) {
    const a = parseAmount(oc(m, 1), ctx);
    const n = wordToNumber(m[2]);
    if (a !== null && typeof n === 'number') return { kind: 'amount', a, op: /more|greater/.test(m[3]) ? '>=' : '<=', b: n };
  }
  if (t === 'it is your turn' || t === "it's your turn") return { kind: 'yourTurn' };
  if (t === 'it is not your turn') return { kind: 'notYourTurn' };
  if (t === 'you control your commander' || t === 'you control a commander') return { kind: 'controlsCommander' };
  if (t === 'you are the monarch') return { kind: 'isMonarch', ref: { ref: 'controller' } };
  if (t === 'you have no cards in hand') return { kind: 'handSize', ref: { ref: 'controller' }, op: '==', value: 0 };
  if ((m = t.match(/^you have (\w+) or more cards in hand$/))) return { kind: 'handSize', ref: { ref: 'controller' }, op: '>=', value: wordToNumber(m[1]) ?? 1 };
  if ((m = t.match(/^you have (\w+) or fewer cards in hand$/))) return { kind: 'handSize', ref: { ref: 'controller' }, op: '<=', value: wordToNumber(m[1]) ?? 1 };
  if ((m = t.match(/^you control exactly one (.+)$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, op: '==', value: 1 };
  }
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
  if ((m = t.match(/^an opponent controls (\w+) or more (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, controller: 'opponent', zone: 'battlefield' }, op: '>=', value: n };
  }
  if ((m = t.match(/^an opponent controls (?:a|an) (.+)$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'count', filter: { ...noun.filter, controller: 'opponent', zone: 'battlefield' }, op: '>=', value: 1 };
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
  if ((m = t.match(/^(?:~|it) is (equipped|enchanted)$/))) return { kind: 'objectMatches', ref: ctx.self, filter: { hasAttachment: m[1] === 'equipped' ? 'Equipment' : 'Aura' } };
  if (t === '~ is monstrous' || t === 'it is monstrous') return { kind: 'objectMatches', ref: ctx.self, filter: { monstrous: true } };
  if (t === '~ is attached to a creature' || t === 'it is attached to a creature' || t === '~ is attached to a permanent') return { kind: 'objectMatches', ref: ctx.self, filter: { attached: true } };
  if (t === 'it entered this turn' || t === '~ entered this turn' || t === 'it entered the battlefield this turn') return { kind: 'objectMatches', ref: ctx.self, filter: { enteredThisTurn: true } };
  if (t === '~ is in your graveyard' || t === 'it is in your graveyard') return { kind: 'inZone', ref: ctx.self, zone: 'graveyard' };
  if (t === '~ is on the battlefield' || t === 'it is on the battlefield') return { kind: 'inZone', ref: ctx.self, zone: 'battlefield' };
  if ((m = t.match(/^(\w+) or more (.+?) are attached to (?:it|~)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, attachedToSource: true, zone: 'battlefield' }, op: '>=', value: n };
  }
  if ((m = t.match(/^(?:enchanted|equipped) (?:creature|permanent) is (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'objectMatches', ref: { ref: 'attachedTo' }, filter: noun.filter };
  }
  if ((m = t.match(/^(?:enchanted|equipped) creature is (white|blue|black|red|green)$/))) return { kind: 'objectMatches', ref: { ref: 'attachedTo' }, filter: { colors: [({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1] as 'white']] } };
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
  if ((m = t.match(/^(an opponent|you|a player|each opponent) (discarded a card|discarded one or more cards|drew a card|drew two or more cards|gained life|lost life|cast a spell|cast an instant or sorcery spell|attacked|sacrificed a permanent|sacrificed a creature|was dealt damage|milled a card|milled one or more cards) this turn$/))) {
    const who = m[1] === 'you' ? 'you' : m[1] === 'a player' ? 'any' : 'opponent';
    const ev = m[2];
    const event: import('@commander/engine').GameEventName = /discard/.test(ev) ? 'discard' : /drew/.test(ev) ? 'drawCard' : /gained/.test(ev) ? 'lifeGained' : /lost/.test(ev) ? 'lifeLost' : /cast/.test(ev) ? 'cast' : /attacked/.test(ev) ? 'attacks' : /sacrificed/.test(ev) ? 'sacrifice' : /dealt damage/.test(ev) ? 'dealtDamage' : 'mill';
    return { kind: 'eventThisTurn', event, player: who, op: '>=', value: /two or more/.test(ev) ? 2 : 1 };
  }
  if ((m = t.match(/^a creature died this turn$/))) return { kind: 'eventThisTurn', event: 'dies', player: 'any' };
  if ((m = t.match(/^you have the initiative$/))) return { kind: 'hasInitiative' };
  if ((m = t.match(/^you have completed a dungeon$/)) || (m = t.match(/^you've completed a dungeon$/))) return { kind: 'playerStat', stat: 'dungeonsCompleted', op: '>=', value: 1 };
  if ((m = t.match(/^the ring has tempted you (\w+) or more times$/))) return { kind: 'playerStat', stat: 'ringLevel', op: '>=', value: wordToNumber(m[1]) as number };
  if ((m = t.match(/^an opponent has more life than you$/))) return { kind: 'manual', text: 'Does an opponent have more life than you?' };
  return null;
}
