import type { Condition } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { parseAmount, type RefCtx } from './amounts.js';
import { wordToNumber } from './text.js';

export function parseCondition(text: string, ctx: RefCtx): Condition | null {
  const orig = text
    .trim()
    .replace(/[.,]$/, '')
    .replace(/^you've (cast|drawn|discarded|sacrificed|attacked|gained|lost|milled|committed)\b/i, (_m, v: string) => `you ${({ drawn: 'drew' } as Record<string, string>)[v.toLowerCase()] ?? v}`)
    .replace(/^(an opponent|a player|each opponent) has (drawn|cast|discarded|sacrificed)\b/i, (_m, w: string, v: string) => `${w} ${({ drawn: 'drew' } as Record<string, string>)[v.toLowerCase()] ?? v}`)
    .replace(/^you're the monarch$/i, 'you are the monarch')
    .replace(/^(?:~|it) remains tapped$/i, '~ is tapped')
    .replace(/^(?:~|it) remains untapped$/i, '~ is untapped')
    .replace(/^(?:~|it) remains on the battlefield$/i, '~ is on the battlefield')
    .replace(/^there's /i, 'there is ');
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
  // Disjunctions: "X or Y" / "X or if Y"
  if ((m = orig.match(/^(.+?) or (?:if )?(.+)$/i))) {
    const a = parseCondition(m[1], ctx);
    const b = parseCondition(m[2], ctx);
    if (a && b && a.kind !== 'manual' && b.kind !== 'manual') return { kind: 'or', cs: [a, b] };
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
  // "you cast two or more spells this turn" / "you drew two or more cards this turn"
  if ((m = t.match(/^(an opponent|you|a player|each opponent) (cast|drew|discarded|sacrificed|milled) (\w+) or more (spells|cards|creatures|permanents|instant or sorcery spells|creature spells|noncreature spells) this turn$/))) {
    const who = m[1] === 'you' ? 'you' : m[1] === 'a player' ? 'any' : 'opponent';
    const event: import('@commander/engine').GameEventName = m[2] === 'cast' ? 'cast' : m[2] === 'drew' ? 'drawCard' : m[2] === 'discarded' ? 'discard' : m[2] === 'sacrificed' ? 'sacrifice' : 'mill';
    const n = wordToNumber(m[3]);
    if (typeof n === 'number' && (m[2] !== 'cast' || m[4] === 'spells')) return { kind: 'eventThisTurn', event, player: who, op: '>=', value: n };
  }
  if ((m = t.match(/^(an opponent|each opponent|you|a player|that player) (?:has|have) (\w+) or more cards in (?:their|your) graveyard$/))) {
    const n = wordToNumber(m[2]);
    if (typeof n === 'number') return { kind: 'graveyard', ref: m[1] === 'you' ? { ref: 'controller' } : m[1] === 'that player' ? thatPlayer : { ref: 'eachOpponent' }, op: '>=', value: n };
  }
  if ((m = t.match(/^(an opponent|each opponent) has (\d+) or (less|fewer|more) life$/))) return { kind: 'life', ref: { ref: 'eachOpponent' }, op: m[3] === 'more' ? '>=' : '<=', value: parseInt(m[2], 10) };
  if (t === 'your life total is less than or equal to half your starting life total' || t === 'you have half your starting life total or less') return { kind: 'life', ref: { ref: 'controller' }, op: '<=', value: 20 };
  if (t === "an opponent's life total is less than half their starting life total" || t === 'an opponent has less than half their starting life total') return { kind: 'life', ref: { ref: 'eachOpponent' }, op: '<', value: 20 };
  if ((m = t.match(/^(?:~|it) is (?:a|an) (creature|artifact|enchantment|land|planeswalker|token|artifact creature)$/))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return { kind: 'objectMatches', ref: ctx.self, filter: noun.filter };
  }
  if ((m = t.match(/^(?:equipped|enchanted) (?:creature|permanent) is legendary$/))) return { kind: 'objectMatches', ref: { ref: 'attachedTo' }, filter: { supertypes: ['Legendary'] } };
  if ((m = t.match(/^(?:equipped|enchanted) creature is attacking$/))) return { kind: 'isAttacking', ref: { ref: 'attachedTo' } };
  if ((m = t.match(/^(?:equipped|enchanted) (?:creature|permanent) is (tapped|untapped)$/))) return m[1] === 'tapped' ? { kind: 'isTapped', ref: { ref: 'attachedTo' } } : { kind: 'not', c: { kind: 'isTapped', ref: { ref: 'attachedTo' } } };
  if ((m = t.match(/^there (?:is|are) exactly (\w+) ([+\-\w\/]+) counters? on (?:~|it)$/))) return { kind: 'hasCounter', ref: ctx.self, counter: oc(m, 2), op: '==', value: wordToNumber(m[1]) as number };
  if ((m = t.match(/^there (?:is|are) (?:a|an|one or more) ([+\-\w\/]+) counters? on (?:~|it)$/))) return { kind: 'hasCounter', ref: ctx.self, counter: oc(m, 1) };
  if ((m = t.match(/^there (?:is|are) no ([+\-\w\/]+) counters? on (?:~|it)$/))) return { kind: 'not', c: { kind: 'hasCounter', ref: ctx.self, counter: oc(m, 1) } };
  if ((m = t.match(/^(?:~|it) has no ([+\-\w\/]+) counters? on it$/))) return { kind: 'not', c: { kind: 'hasCounter', ref: ctx.self, counter: oc(m, 1) } };
  if ((m = t.match(/^defending player controls (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'count', filter: { ...noun.filter, controllerRef: { ref: 'defendingPlayer' }, zone: 'battlefield' }, op: '>=', value: 1 };
  }
  if ((m = t.match(/^(?:~|it) is (?:a|an) (.+?) (?:in addition to its other types)?$/)) && /^(creature|artifact|enchantment|land)$/.test(m[1])) return { kind: 'objectMatches', ref: ctx.self, filter: { types: [m[1].charAt(0).toUpperCase() + m[1].slice(1)] as never } };
  if (t === '~ is untapped' || t === 'it is untapped') return { kind: 'not', c: { kind: 'isTapped', ref: ctx.self } };
  if (t === 'you control ~') return { kind: 'and', cs: [{ kind: 'inZone', ref: ctx.self, zone: 'battlefield' }, { kind: 'count', filter: { controller: 'you', zone: 'battlefield', nameIs: '~' }, op: '>=', value: 1 }] };
  if ((m = t.match(/^(?:it|that creature|that permanent) is (?:still )?on the battlefield$/))) return { kind: 'inZone', ref: ctx.lastObj ?? ctx.self, zone: 'battlefield' };
  if ((m = t.match(/^(?:it|~) (?:is|remains) exiled$/))) return { kind: 'inZone', ref: ctx.lastObj ?? ctx.self, zone: 'exile' };
  if (t === 'you win' || t === 'you win the clash' || t === 'you won the clash') return { kind: 'memoryFlag', key: 'clashWon' };
  if (t === "you have the city's blessing") return { kind: 'cityBlessing' };
  if (t === 'it was kicked' || t === 'this spell was kicked') return { kind: 'wasKicked' };
  if (t === 'evidence was collected' || t === 'you collected evidence') return { kind: 'memoryFlag', key: 'evidenceCollected' };
  if (t === "tribute wasn't paid" || t === 'tribute was not paid') return { kind: 'not', c: { kind: 'memoryFlag', key: 'tributePaid' } };
  if (t === 'tribute was paid') return { kind: 'memoryFlag', key: 'tributePaid' };
  if ((m = t.match(/^(?:this is|it is) the (first|second|third|fourth) time(?: this ability has resolved this turn)?$/))) return { kind: 'abilityResolvedThisTurn', op: '==', value: { first: 1, second: 2, third: 3, fourth: 4 }[m[1] as 'first'] };
  if (t === "~'s additional cost was paid" || t === 'its additional cost was paid' || t === 'the additional cost was paid') return { kind: 'memoryFlag', key: 'additionalCostPaid' };
  if ((m = t.match(/^you have (\w+) or more (.+?) in your graveyard$/))) {
    const noun = parseNoun(oc(m, 2).replace(/ cards$/i, ' card'));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'graveyard', ref: { ref: 'controller' }, op: '>=', value: n, filter: noun.filter };
  }
  if (t === 'you search your library this way' || t === 'you searched your library this way') return { kind: 'ctxFlag', key: 'searched' };
  if (t === 'you win the flip' || t === 'you won the flip') return { kind: 'ctxFlag', key: 'flipWon' };
  if (t === 'you lose the flip' || t === 'you lost the flip') return { kind: 'not', c: { kind: 'ctxFlag', key: 'flipWon' } };
  if ((m = t.match(/^(a player|an opponent|you|each player|any player) cast (\w+) or more spells last turn$/))) { const n = wordToNumber(m[2]); if (typeof n === 'number') return { kind: 'eventLastTurn', event: 'cast', player: m[1] === 'you' ? 'you' : /opponent/.test(m[1]) ? 'opponent' : 'any', op: '>=', value: n }; }
  if (t === 'no spells were cast last turn' || t === 'no player cast a spell last turn') return { kind: 'eventLastTurn', event: 'cast', player: 'any', op: '==', value: 0 };
  if ((m = t.match(/^(?:a|one or more) (?:nonland )?permanents? left the battlefield under your control this turn$/))) return { kind: 'eventThisTurn', event: 'leavesBattlefield', player: 'you' };
  if (t === 'you cast it' || t === 'you cast ~' || t === 'it was cast' || t === '~ was cast' || t === 'you cast this spell') return { kind: 'memoryFlag', key: 'wasCast' };
  if ((m = t.match(/^you control (\w+) or more (.+?) with different (powers|toughnesses|names|mana values)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'amount', a: { kind: 'distinctValues', stat: m[3] === 'powers' ? 'power' : m[3] === 'toughnesses' ? 'toughness' : m[3] === 'names' ? 'name' : 'manaValue', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' } }, op: '>=', b: n };
  }
  if ((m = t.match(/^(?:it|that creature|that card) shares a creature type with ~$/))) return { kind: 'objectMatches', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }), filter: { sharesCreatureTypeWithSource: true } };
  if ((m = t.match(/^you gained (\w+) or more life this turn$/))) { const n = wordToNumber(m[1]); if (typeof n === 'number') return { kind: 'amount', a: { kind: 'playerTurnStat', key: 'lifeGainedAmount' }, op: '>=', b: n }; }
  if ((m = t.match(/^an opponent controls more (.+?) than you$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'opponentCompare', what: { ...noun.filter, zone: 'battlefield' }, op: '>' };
  }
  if ((m = t.match(/^you control more (.+?) than (?:each|any) (?:opponent|other player)$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'not', c: { kind: 'opponentCompare', what: { ...noun.filter, zone: 'battlefield' }, op: '>=' } };
  }
  if (t === 'an opponent has more life than you') return { kind: 'opponentCompare', what: 'life', op: '>' };
  if (t === 'you have more life than each opponent' || t === 'you have the most life' || t === 'you have more life than each other player') return { kind: 'not', c: { kind: 'opponentCompare', what: 'life', op: '>=' } };
  if (t === 'you descended this turn') return { kind: 'eventThisTurn', event: 'putIntoGraveyard', player: 'you' };
  if ((m = t.match(/^((?:\{[wubrgc]\})+) (?:was|were) spent to cast (?:it|~|this spell)$/))) return { kind: 'amount', a: { kind: 'manaSpent', of: 'colors', symbols: m[1].toUpperCase() }, op: '>=', b: (m[1].match(/\{/g) ?? []).length };
  if ((m = t.match(/^at least (\w+) mana was spent to cast (?:it|~|this spell)$/))) { const n = wordToNumber(m[1]); if (typeof n === 'number') return { kind: 'amount', a: { kind: 'memory', key: 'manaSpent' }, op: '>=', b: n }; }
  if ((m = t.match(/^(?:its|that (?:creature|card|spell|permanent)'s) mana value (?:was|is) (\d+) or (less|greater)$/))) return { kind: 'objectMatches', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }), filter: m[2] === 'less' ? { cmcLE: parseInt(m[1], 10) } : { cmcGE: parseInt(m[1], 10) } };
  if ((m = t.match(/^(?:it|that card|that permanent) was (?:a|an) (.+?)(?: card)?$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'objectMatches', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }), filter: noun.filter };
  }
  if ((m = t.match(/^you control (?:a|an) (\w+) and (?:a|an) (\w+)$/))) {
    const a = parseNoun(`a ${oc(m, 1)}`);
    const b = parseNoun(`a ${oc(m, 2)}`);
    if (a && b) return { kind: 'and', cs: [{ kind: 'count', filter: { ...a.filter, controller: 'you', zone: 'battlefield' }, op: '>=', value: 1 }, { kind: 'count', filter: { ...b.filter, controller: 'you', zone: 'battlefield' }, op: '>=', value: 1 }] };
  }
  if ((m = t.match(/^(?:a|an|one or more) (.+?) (?:is|are|was|were) (?:exiled|destroyed|put into a graveyard|discarded|milled|revealed|returned) this way$/))) {
    const noun = parseNoun(`a ${oc(m, 1).replace(/ cards?$/, ' card')}`);
    if (noun) return { kind: 'amount', a: { kind: 'countRef', ref: { ref: 'lastMoved' }, filter: { ...noun.filter, zone: undefined } }, op: '>=', b: 1 };
  }
  if ((m = t.match(/^(\w+) or more (.+?) entered the battlefield under your control this turn$/))) { const n = wordToNumber(m[1]); if (typeof n === 'number') return { kind: 'amount', a: { kind: 'eventsThisTurn', event: 'entersBattlefield', player: 'you' }, op: '>=', b: n }; }
  if (t === 'you cast it from your hand' || t === 'you cast ~ from your hand' || t === 'it was cast from your hand') return { kind: 'castFrom', zone: 'hand' };
  if ((m = t.match(/^defending player controls (\w+) or more (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, controllerRef: { ref: 'defendingPlayer' }, zone: 'battlefield' }, op: '>=', value: n };
  }
  if (t === 'you cast ~ during your main phase' || t === '~ was cast during your main phase') return { kind: 'not', c: { kind: 'memoryFlag', key: 'castAtInstantSpeed' } };
  if (t === '~ was cast during an opponent\'s turn' || t === 'you cast ~ during an opponent\'s turn') return { kind: 'notYourTurn' };
  if ((m = t.match(/^there are (\w+) or more (.+?) on the battlefield$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, zone: 'battlefield' }, op: '>=', value: n };
  }
  if ((m = t.match(/^there (?:is|are) (?:a|an|one or more) (.+?) in your graveyard$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'graveyard', ref: { ref: 'controller' }, op: '>=', value: 1, filter: noun.filter };
  }
  if ((m = t.match(/^your opponents control (\w+) or more (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, controller: 'opponent', zone: 'battlefield' }, op: '>=', value: n };
  }
  if ((m = t.match(/^(?:an opponent controls|your opponents control) no (.+)$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'count', filter: { ...noun.filter, controller: 'opponent', zone: 'battlefield' }, op: '==', value: 0 };
  }
  if (t === "a player's life total is less than or equal to half their starting life total" || t === 'a player has half their starting life total or less') return { kind: 'or', cs: [{ kind: 'life', ref: { ref: 'controller' }, op: '<=', value: 20 }, { kind: 'life', ref: { ref: 'eachOpponent' }, op: '<=', value: 20 }] };
  if ((m = t.match(/^(your|that player's|their) library has no cards in it$/))) return { kind: 'amount', a: { kind: 'librarySize', ref: /^your$/.test(m[1]) ? { ref: 'controller' } : { ref: 'triggerPlayer' } }, op: '==', b: 0 };
  if ((m = t.match(/^(?:you have|there are) (\w+) or (?:more|fewer) cards in your library$/))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return { kind: 'amount', a: { kind: 'librarySize', ref: { ref: 'controller' } }, op: /fewer/.test(t) ? '<=' : '>=', b: n };
  }
  if (t === 'it is bargained' || t === '~ was bargained' || t === 'this spell was bargained') return { kind: 'memoryFlag', key: 'additionalCostPaid' };
  if ((m = t.match(/^(?:a|one or more) creatures? (?:is|are) attacking you$/))) return { kind: 'count', filter: { types: ['Creature'], attacking: true, zone: 'battlefield' }, op: '>=', value: 1 };
  if ((m = t.match(/^you control (?:a|an|another) (.+?) with (\w+) or more ([+-]\d\/[+-]\d|[\w' -]+?) counters on it$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    const n = wordToNumber(m[2]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield', counterAtLeast: { counter: m[3], n } }, op: '>=', value: 1 };
  }
  if ((m = t.match(/^(?:a|an|one or more) (.+?) died under your control this turn$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'eventThisTurn', event: 'dies', who: { ref: 'controller' }, op: '>=', value: 1 };
  }
  if (t === 'an opponent has no cards in hand') return { kind: 'handSize', ref: { ref: 'eachOpponent' }, op: '==', value: 0 };
  if ((m = t.match(/^you cast (?:another|a|one or more) spells? this turn$/))) return { kind: 'eventThisTurn', event: 'cast', player: 'you', op: '>=', value: 1 };
  // "you have cast a creature spell this turn"
  if ((m = t.match(/^you (?:have )?cast (?:another|a|an|one or more) (.+?) spells? this turn$/))) {
    const noun = parseNoun(`a ${m[1]} spell`);
    if (noun) return { kind: 'eventThisTurn', event: 'cast', player: 'you', op: '>=', value: 1, filter: { ...noun.filter, zone: undefined } };
  }
  // "you control more creatures than defending player" / "than attacking player"
  if ((m = t.match(/^you control more (.+?) than (defending player|attacking player|any opponent|each opponent)$/))) {
    const noun = parseNoun(m[1]);
    if (noun) {
      const other: import('@commander/engine').Ref = m[2] === 'defending player' ? { ref: 'defendingPlayer' } : m[2] === 'attacking player' ? { ref: 'activePlayer' } : { ref: 'eachOpponent' };
      return { kind: 'amount', a: { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' } }, op: '>', b: { kind: 'count', filter: { ...noun.filter, controllerRef: other, zone: 'battlefield' } } };
    }
  }
  // "an opponent has been dealt damage this turn"
  if (/^(?:an opponent|a player|one of their opponents) (?:has been|was) dealt damage this turn$/.test(t)) return { kind: 'eventThisTurn', event: 'dealtDamage', player: 'opponent', op: '>=', value: 1 };
  // "defending player is the monarch" / "is poisoned"
  if ((m = t.match(/^(defending player|target player|that player|an opponent) is the monarch$/))) return { kind: 'isMonarch', ref: m[1] === 'defending player' ? { ref: 'defendingPlayer' } : thatPlayer };
  if ((m = t.match(/^(defending player|target player|that player|an opponent) is poisoned$/))) return { kind: 'playerStat', stat: 'poison', ref: m[1] === 'defending player' ? { ref: 'defendingPlayer' } : thatPlayer, op: '>=', value: 1 };
  // "it escaped"
  if (/^(?:it|~|that spell) escaped$/.test(t)) return { kind: 'memoryFlag', key: 'escaped' };
  if ((m = t.match(/^there are (\w+) or more (.+?) (?:total )?in all graveyards$/))) {
    const noun = parseNoun(oc(m, 2).replace(/ cards$/i, ' card'));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, zone: 'graveyard', controller: undefined }, op: '>=', value: n };
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
  if (t === '~ is saddled' || t === 'it is saddled') return { kind: 'objectMatches', ref: ctx.self, filter: { customRule: 'saddled' } };
  if (t === '~ is goaded' || t === 'it is goaded') return { kind: 'objectMatches', ref: ctx.self, filter: { customRule: 'goaded' } };
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
  if ((m = t.match(/^(?:~|this spell) was cast from (?:your |a )?(graveyard|hand|exile)$/))) return { kind: 'castFrom', zone: m[1] as 'graveyard' };
  if ((m = t.match(/^that player controls (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'count', filter: { ...noun.filter, controllerRef: thatPlayer, zone: 'battlefield' }, op: '>=', value: 1 };
  }
  if ((m = t.match(/^that player controls (\w+) or more (.+)$/))) {
    const noun = parseNoun(oc(m, 2));
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, controllerRef: thatPlayer, zone: 'battlefield' }, op: '>=', value: n };
  }
  if (t === 'that player controls a commander' || t === 'they control a commander') return { kind: 'count', filter: { controllerRef: thatPlayer, zone: 'battlefield', isCommander: true }, op: '>=', value: 1 };
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
  if ((m = t.match(/^(?:a|another) creature(?: not named ~)? died this turn$/))) return { kind: 'eventThisTurn', event: 'dies', player: 'any' };
  if ((m = t.match(/^a creature you control(?:led)? died this turn$/))) return { kind: 'eventThisTurn', event: 'dies', player: 'you' };
  if ((m = t.match(/^you have the initiative$/))) return { kind: 'hasInitiative' };
  if ((m = t.match(/^you have completed a dungeon$/)) || (m = t.match(/^you've completed a dungeon$/))) return { kind: 'playerStat', stat: 'dungeonsCompleted', op: '>=', value: 1 };
  if ((m = t.match(/^the ring has tempted you (\w+) or more times$/))) return { kind: 'playerStat', stat: 'ringLevel', op: '>=', value: wordToNumber(m[1]) as number };
  if ((m = t.match(/^an opponent has more life than you$/))) return { kind: 'manual', text: 'Does an opponent have more life than you?' };
  // ---- Round 116 ----
  if ((m = t.match(/^the (?:sacrificed|exiled|discarded|chosen|revealed|returned) (?:creature|card|permanent|land) (?:was|is) (?:a|an )?(.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`) ?? parseNoun(`a ${oc(m, 1)} permanent`);
    if (noun && noun.confident) return { kind: 'objectMatches', ref: ctx.lastObj ?? { ref: 'lastMoved' }, filter: noun.filter };
    if (/^suspected$/i.test(m[1])) return { kind: 'memoryFlag', key: 'suspected' };
  }
  if ((m = t.match(/^(?:the )?((?:\{[^}]+\})+|[\w'-]+(?: [\w'-]+)?) cost was paid$/))) {
    const label = m[1].replace(/^~'s /, '');
    if (/^(?:\{[^}]+\})+$/.test(label)) return { kind: 'memoryFlag', key: 'additionalCostPaid' };
    return { kind: 'memoryFlag', key: label.replace(/[^a-z]/gi, '').toLowerCase() };
  }
  if ((m = t.match(/^~'s (\w+) cost was paid$/))) return { kind: 'memoryFlag', key: m[1].toLowerCase() };
  if (/^~ was cast using teamwork$/.test(t)) return { kind: 'memoryFlag', key: 'teamwork' };
  if (/^~ has ?n[o']t been exerted this turn$/.test(t)) return { kind: 'not', c: { kind: 'memoryFlag', key: 'exerted' } };
  if (/^~ has been exerted this turn$/.test(t)) return { kind: 'memoryFlag', key: 'exerted' };
  if ((m = t.match(/^~ is (?:a|an) (aura|equipment|vehicle|saga|clue|food|treasure|token|commander)$/))) {
    const w = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    if (w === 'Token') return { kind: 'objectMatches', ref: ctx.self, filter: { isToken: true } };
    if (w === 'Commander') return { kind: 'objectMatches', ref: ctx.self, filter: { isCommander: true } };
    return { kind: 'objectMatches', ref: ctx.self, filter: { subtypes: [w] } };
  }
  // ---- Round 109 ----
  if ((m = t.match(/^you(?:'ve| have)? put one or more ([+-]\d\/[+-]\d|[\w'-]+) counters? on (?:~|it) this turn$/))) return { kind: 'eventThisTurn', event: 'counterAdded', player: 'you' };
  if ((m = t.match(/^(?:~|it) has (\w+) or more counters on it$/))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return { kind: 'hasCounter', ref: ctx.self, counter: 'any', op: '>=', value: n };
  }
  if (/^(?:~|it) has ?n[o']t dealt damage yet$/.test(t)) return { kind: 'not', c: { kind: 'objectMatches', ref: ctx.self, filter: { dealtDamageThisTurn: true } } };
  if (/^(?:~|it) is modified$/.test(t)) return { kind: 'objectMatches', ref: ctx.self, filter: { modified: true } };
  if (/^(?:~|it) is your ring-bearer$/.test(t)) return { kind: 'objectMatches', ref: ctx.self, filter: { custom: 'ringBearer' } };
  if (/^(?:~|it) attacked this turn$/.test(t)) return { kind: 'objectMatches', ref: ctx.self, filter: { attackedThisTurn: true } };
  if (/^(?:enchanted|equipped) (?:creature|permanent) is face down$/.test(t)) return { kind: 'faceDown', ref: { ref: 'attachedTo' } };
  if (/^(?:enchanted|equipped) creature is attacking alone$/.test(t)) {
    return { kind: 'and', cs: [{ kind: 'isAttacking', ref: { ref: 'attachedTo' } }, { kind: 'count', filter: { types: ['Creature'], attacking: true, controllerRef: { ref: 'controllerOf', of: { ref: 'attachedTo' } }, zone: 'battlefield' }, op: '==', value: 1 }] };
  }
  if (/^(?:~|it) is attacking alone$/.test(t)) {
    return { kind: 'and', cs: [{ kind: 'isAttacking', ref: ctx.self }, { kind: 'count', filter: { types: ['Creature'], attacking: true, controller: 'you', zone: 'battlefield' }, op: '==', value: 1 }] };
  }
  if ((m = t.match(/^an opponent cast (?:a|an) (.+?) spell this turn$/))) {
    const noun = parseNoun(`a ${oc(m, 1)} spell`);
    if (noun) return { kind: 'eventThisTurn', event: 'cast', player: 'opponent', filter: { ...noun.filter, zone: undefined } };
  }
  if (/^no permanents named ~ are on the battlefield$/.test(t)) return { kind: 'count', filter: { nameIs: '~', zone: 'battlefield' }, op: '==', value: 0 };
  if ((m = t.match(/^you control fewer (.+?) than each opponent$/))) {
    const noun = parseNoun(oc(m, 1));
    if (noun) return { kind: 'opponentCompare', what: { ...noun.filter, zone: 'battlefield' }, op: '>' };
  }
  // ---- Round 108 ----
  if (/^(?:a|any) player has no cards in hand$/.test(t)) return { kind: 'not', c: { kind: 'handSize', ref: { ref: 'eachPlayer' }, op: '>=', value: 1 } };
  if (/^(?:an )?opponent has no cards in hand$/.test(t)) return { kind: 'not', c: { kind: 'handSize', ref: { ref: 'eachOpponent' }, op: '>=', value: 1 } };
  if ((m = t.match(/^you control (?:at least )?(\w+) or more other (.+)$/)) || (m = t.match(/^you control (?:at least )?(\w+) other (.+)$/))) {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(oc(m, 2));
    if (noun && typeof n === 'number') return { kind: 'count', filter: { ...noun.filter, controller: 'you', other: true, zone: 'battlefield' }, op: '>=', value: n };
  }
  if (/^you have max speed$/.test(t)) return { kind: 'turnStat', key: 'speed', op: '>=', value: 4 };
  if ((m = t.match(/^there is (?:a|an) (.+?) on the battlefield$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'count', filter: { ...noun.filter, zone: 'battlefield' }, op: '>=', value: 1 };
  }
  if (/^(?:~|it) is paired with (?:a|another) creature(?: with soulbond)?$/.test(t)) return { kind: 'paired', ref: ctx.self };
  if ((m = t.match(/^(?:a|an) (.+?) (?:also )?attacks$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'count', filter: { ...noun.filter, attacking: true, other: true, zone: 'battlefield' }, op: '>=', value: 1 };
  }
  // ---- Round 107 ----
  if (/^(?:its controller|that player|they|the player|its owner) is poisoned$/.test(t)) return { kind: 'playerStat', stat: 'poison', ref: ctx.lastPlayer ?? { ref: 'triggerPlayer' }, op: '>=', value: 1 };
  if (/^you are poisoned$/.test(t)) return { kind: 'playerStat', stat: 'poison', ref: { ref: 'controller' }, op: '>=', value: 1 };
  if (/^(?:~|it) is not attacking or blocking$/.test(t)) return { kind: 'not', c: { kind: 'objectMatches', ref: ctx.lastObj ?? ctx.self, filter: { attackingOrBlocking: true } } };
  if (/^(?:~|it) is attacking or blocking$/.test(t)) return { kind: 'objectMatches', ref: ctx.lastObj ?? ctx.self, filter: { attackingOrBlocking: true } };
  if ((m = t.match(/^an opponent controls (?:at least )?(\w+) or more (.+?) than you$/)) || (m = t.match(/^an opponent controls (?:at least )?(\w+) more (.+?) than you$/))) {
    const noun = parseNoun(oc(m, 2));
    if (noun) return { kind: 'opponentCompare', what: { ...noun.filter, zone: 'battlefield' }, op: '>=' };
  }
  if ((m = t.match(/^(?:its|that spell's|the spell's) mana value is (less than or equal to|greater than or equal to|less than|greater than|equal to) (.+)$/))) {
    const a = parseAmount(m[2], ctx);
    const op = ({ 'less than or equal to': '<=', 'greater than or equal to': '>=', 'less than': '<', 'greater than': '>', 'equal to': '==' } as Record<string, '<=' | '>=' | '<' | '>' | '=='>)[m[1]];
    if (a !== null) return { kind: 'amount', a: { kind: 'manaValue', ref: ctx.lastObj ?? { ref: 'stackTarget' } }, op, b: a };
  }
  // ---- Round 104 ----
  // "you control a God, a Demigod, or a legendary enchantment" / "you control a blue permanent and a black permanent"
  if ((m = orig.match(/^(you control|an opponent controls|you do not control) (.+)$/i)) && /(?:, | and | or )/.test(m[2])) {
    const who = m[1];
    const parts = m[2].split(/,\s*(?:and |or )?|\s+(?:and|or)\s+/i).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.every((x) => /^(?:a|an|another|\w+ or more|\d+ or more)\b/i.test(x))) {
      const cs: Condition[] = [];
      for (const part of parts) {
        const c = parseCondition(`${who} ${part}`, ctx);
        if (!c) { cs.length = 0; break; }
        cs.push(c);
      }
      if (cs.length === parts.length) return { kind: /\bor\b/i.test(m[2]) ? 'or' : 'and', cs };
    }
  }
  if (t === '~ is your commander' || t === 'it is your commander') return { kind: 'objectMatches', ref: ctx.self, filter: { isCommander: true } };
  if (t === '~ is not your commander') return { kind: 'not', c: { kind: 'objectMatches', ref: ctx.self, filter: { isCommander: true } } };
  if (t === 'you cast a spell this way' || t === 'you cast it this way' || t === 'you cast that spell this way') return { kind: 'ctxFlag', key: 'castThisWay' };
  if ((m = t.match(/^you cast (?:a|an) (.+?) spell this way$/))) return { kind: 'ctxFlag', key: 'castThisWay' };
  if (t === "you've committed a crime this turn" || t === 'you committed a crime this turn') return { kind: 'eventThisTurn', event: 'committedCrime', player: 'you' };
  if (t === 'an opponent committed a crime this turn') return { kind: 'eventThisTurn', event: 'committedCrime', player: 'opponent' };
  if ((m = t.match(/^you (?:had|have had) (?:a|an|another) (.+?) enter(?:ed)? the battlefield under your control this turn$/)) || (m = t.match(/^(?:a|an|another) (.+?) entered the battlefield under your control this turn$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'count', filter: { ...noun.filter, controller: 'you', zone: 'battlefield', enteredThisTurn: true }, op: '>=', value: 1 };
  }
  if (t === 'you have more cards in hand than each opponent') return { kind: 'not', c: { kind: 'opponentCompare', what: { zone: 'hand' }, op: '>=' } };
  if ((m = t.match(/^(?:~|it) is (white|blue|black|red|green|colorless|multicolored|monocolored)$/))) {
    const col = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, string>;
    const f = m[1] === 'colorless' ? { colorless: true } : m[1] === 'multicolored' ? { multicolored: true } : m[1] === 'monocolored' ? { monocolored: true } : { colors: [col[m[1]] as 'W'] };
    return { kind: 'objectMatches', ref: ctx.lastObj ?? ctx.self, filter: f };
  }
  if ((m = t.match(/^~ is not (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'not', c: { kind: 'objectMatches', ref: ctx.self, filter: noun.filter } };
  }
  if ((m = t.match(/^~ is in (?:a|your|their) graveyard$/))) return { kind: 'inZone', ref: ctx.self, zone: 'graveyard' };
  if ((m = t.match(/^~ is in exile$/))) return { kind: 'inZone', ref: ctx.self, zone: 'exile' };
  if (t === '~ is in the command zone or on the battlefield') return { kind: 'or', cs: [{ kind: 'inZone', ref: ctx.self, zone: 'command' }, { kind: 'inZone', ref: ctx.self, zone: 'battlefield' }] };
  if ((m = t.match(/^(?:at least )?(\w+) or more mana was spent to cast (?:~|that spell|this spell)$/))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return { kind: 'amount', a: { kind: 'manaSpent', of: 'total' }, op: '>=', b: n };
  }
  if ((m = t.match(/^at least (\w+) (white|blue|black|red|green) mana was spent to cast (?:~|that spell|this spell)$/))) {
    const n = wordToNumber(m[1]);
    const sym = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[m[2]] as string;
    if (typeof n === 'number') return { kind: 'amount', a: { kind: 'manaSpent', of: 'total', symbols: sym }, op: '>=', b: n };
  }
  if ((m = t.match(/^~ (?:is|was) (renowned|foretold|suspected|saddled|solved)$/))) return { kind: 'memoryFlag', key: m[1] };
  if (t === '~ is monstrous') return { kind: 'objectMatches', ref: ctx.self, filter: { monstrous: true } };
  if (t === '~ is goaded') return { kind: 'objectMatches', ref: ctx.self, filter: { customRule: 'goaded' } };
  if ((m = t.match(/^(?:~|it) (?:is|was) (?:a|an) (.+?) card$/))) {
    const noun = parseNoun(`a ${oc(m, 1)} card`);
    if (noun) return { kind: 'objectMatches', ref: ctx.lastObj ?? ctx.self, filter: noun.filter };
  }
  if ((m = t.match(/^the top card of your library is (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'count', filter: { ...noun.filter, zone: 'library', owner: 'you', custom: 'topOfLibrary' }, op: '>=', value: 1 };
  }
  if ((m = t.match(/^(?:enchanted|equipped) (?:land|creature|permanent|artifact) is (?:a|an) (.+)$/))) {
    const noun = parseNoun(`a ${oc(m, 1)}`);
    if (noun) return { kind: 'objectMatches', ref: { ref: 'attachedTo' }, filter: noun.filter };
  }
  if ((m = t.match(/^you sacrificed (?:a|an) (.+?) this turn$/))) return { kind: 'eventThisTurn', event: 'sacrifice', player: 'you' };
  if ((m = t.match(/^(?:~|it) attacked during your last turn$/))) return { kind: 'objectMatches', ref: ctx.self, filter: { attackedThisTurn: true } };
  if (t === 'there are no cards in your graveyard') return { kind: 'graveyard', ref: { ref: 'controller' }, op: '==', value: 0 };
  if ((m = t.match(/^there are (\w+) or more cards in your graveyard$/))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return { kind: 'graveyard', ref: { ref: 'controller' }, op: '>=', value: n };
  }
  // ---- Round 103 ----
  if ((m = t.match(/^you have at least (\d+) life more than your starting life total$/))) return { kind: 'life', ref: { ref: 'controller' }, op: '>=', value: 40 + parseInt(m[1], 10) };
  if ((m = t.match(/^you have at least (\d+) life less than your starting life total$/))) return { kind: 'life', ref: { ref: 'controller' }, op: '<=', value: 40 - parseInt(m[1], 10) };
  if ((m = t.match(/^(?:enchanted|equipped) (?:creature|permanent|land|artifact|planeswalker) is (untapped|tapped)$/))) {
    const c: Condition = { kind: 'isTapped', ref: { ref: 'attachedTo' } };
    return m[1] === 'tapped' ? c : { kind: 'not', c };
  }
  if ((m = t.match(/^you control (\w+) or more (.+?) with the same name$/))) {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(oc(m, 2));
    if (noun && typeof n === 'number') return { kind: 'sameNameGroup', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, op: '>=', value: n };
  }
  return null;
}
