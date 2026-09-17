import type { Amount, Ref } from '@commander/engine';
import { wordToNumber } from './text.js';
import { parseNoun } from './nouns.js';

export interface RefCtx {
  self: Ref;
  lastObj: Ref | null;
  triggerHasObject: boolean;
  lastPlayer?: Ref | null;
  triggerHasPlayer?: boolean;
  /** Resolve a player phrase ("target player") to a Ref, registering targets when the caller can. */
  resolvePlayer?: (phrase: string) => Ref | null;
}

/** Apply a noun's controller phrase ("creatures target player controls") to its filter; null when the player cannot be resolved. */
function withCtrl<T extends { filter: import('@commander/engine').ObjectFilter; controllerPhrase?: string } | null>(noun: T, ctx: RefCtx): T | null {
  if (!noun || !noun.controllerPhrase) return noun;
  const p = noun.controllerPhrase;
  let r: Ref | null = ctx.resolvePlayer?.(p) ?? null;
  if (!r && /^(that player|they|that opponent|its controller)$/i.test(p)) r = thatPlayer(ctx);
  if (!r && /^defending player$/i.test(p)) r = { ref: 'defendingPlayer' };
  if (!r) return null;
  return { ...noun, filter: { ...noun.filter, controllerRef: r } };
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
  if (/^(?:the number of )?(?:[+\-\w\/]+ )?counters? removed this way$/i.test(text.trim())) return 'X';
  if (/^(?:the number of )?times? (?:it|~|this spell) was kicked$/i.test(text.trim())) return { kind: 'kickCount' };
  if (/^(?:the number of )?(?:creatures?|permanents?|cards?) put into your graveyard from the battlefield this turn$/i.test(text.trim())) return { kind: 'eventsThisTurn', event: 'dies', player: 'you' };
  {
    const pw = text.trim().match(/^(?:the|its|that creature's|the sacrificed creature's|the destroyed creature's) ?(power|toughness|mana value)(?: of (the creature that died|that creature|it|the sacrificed creature|the destroyed creature|the exiled card|that card))?$/i);
    if (pw && (pw[2] || /^(its|that|the sacrificed|the destroyed)/i.test(text.trim()))) return { kind: pw[1].toLowerCase() === 'power' ? 'power' : pw[1].toLowerCase() === 'toughness' ? 'toughness' : 'manaValue', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }) };
  }
  if (/^(?:the number of )?colors (?:that spell|it|that card|that permanent) is$/i.test(text.trim())) return { kind: 'colorCount', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'self' }) };
  if (/^(?:that|the) (?:card|creature|permanent|spell|revealed card|exiled card|discarded card|sacrificed creature|sacrificed permanent)'s mana value$/i.test(text.trim())) return { kind: 'manaValue', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }) };
  {
    const pf = text.trim().match(/^the (power|toughness|mana value) of (the exiled card|the exiled cards|that card|that creature|that permanent|it|the revealed card|the discarded card|the sacrificed creature|the destroyed creature|the returned card)$/i);
    if (pf) {
      const ref: Ref = /^the exiled/i.test(pf[2]) ? { ref: 'chosen', key: 'exiled' } : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' });
      return { kind: pf[1].toLowerCase() === 'power' ? 'power' : pf[1].toLowerCase() === 'toughness' ? 'toughness' : 'manaValue', ref };
    }
  }
  if (/^(?:the number of )?basic land types? among lands you control$/i.test(text.trim()) || /^your domain count$/i.test(text.trim())) return { kind: 'domain' };
  {
    const ct = text.trim().match(/^(?:the number of )?card types? among (.+)$/i);
    if (ct) {
      const noun = withCtrl(parseNoun(ct[1].replace(/ cards$/i, ' card')), ctx);
      if (noun) return { kind: 'cardTypesAmong', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } };
    }
    if (/^(?:the number of )?(?:1 )?life you (?:have )?gained this turn$/i.test(text.trim())) return { kind: 'playerTurnStat', key: 'lifeGainedAmount' };
  }
  if (/^(?:the number of )?(?:(?:1 )?life (?:you |they )?(?:gained|lost)(?: this way)?|cards? (?:looked at while scrying|scried) this way|cards? (?:you )?(?:drew|discarded|milled) this way)$/i.test(text.trim())) return { kind: 'triggerAmount' };
  if (/^(?:the number of )?(?:\w+ )?(?:permanents?|creatures?|artifacts?|enchantments?|lands?|cards?|planeswalkers?) destroyed this way$/i.test(text.trim())) return { kind: 'ctxMemory', key: 'destroyedThisWay' };
  {
    const pm = text.trim().match(/^(.+?) (plus|minus) (\d+|one|two|three|four|five)$/i);
    if (pm && !/^(?:that many|twice)/i.test(pm[1])) {
      const a = parseAmount(pm[1], ctx);
      const n = wordToNumber(pm[3]);
      if (a !== null && typeof n === 'number') return { kind: 'sum', parts: [a, pm[2].toLowerCase() === 'plus' ? n : -n] };
    }
    const pm2 = text.trim().match(/^(the number of .+?) (plus|minus) (the number of .+)$/i);
    if (pm2) {
      const a = parseAmount(pm2[1], ctx);
      const b = parseAmount(pm2[3], ctx);
      if (a !== null && b !== null) return pm2[2].toLowerCase() === 'plus' ? { kind: 'sum', parts: [a, b] } : { kind: 'sum', parts: [a, { kind: 'times', a: b, b: -1 }] };
    }
  }
  {
    const cc = text.trim().toLowerCase().match(/^(?:the number of )?(?:its|~'s|that (?:creature|permanent|card|spell)'s) colors?$/) || text.trim().toLowerCase().match(/^(?:the number of )?colors? (?:of|among) (it|~|that (?:creature|permanent|card|spell))$/);
    if (cc) return { kind: 'colorCount', ref: /~/.test(text) ? { ref: 'self' } : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'self' }) };
  }
  {
    const dv = text.trim().toLowerCase().match(/^your devotion to (white|blue|black|red|green)(?: and (white|blue|black|red|green))?$/);
    if (dv) {
      const C: Record<string, import('@commander/engine').Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
      return { kind: 'devotion', colors: dv[2] ? [C[dv[1]], C[dv[2]]] : [C[dv[1]]] };
    }
    const ca = text.trim().match(/^(?:the number of )?([+\-\w\/]+) counters? (?:among|on) (.+)$/i);
    if (ca && !/^(it|them|~|that creature|that permanent|each of them)$/i.test(ca[2])) {
      const noun = withCtrl(parseNoun(ca[2]), ctx);
      if (noun) return { kind: 'countersOn', ref: { ref: 'all', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } }, counter: ca[1] };
    }
  }
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
    const noun = withCtrl(parseNoun(`a ${oc(m, 1)} card`), ctx);
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
    const noun = withCtrl(parseNoun(`${oc(m, 1)} card`), ctx);
    return noun ? { kind: 'graveyardSize', ref: { ref: 'controller' }, filter: noun.filter } : null;
  }
  if (t === 'the number of lands you control') return { kind: 'landsYouControl' };
  if ((m = t.match(/^the (greatest|highest) (power|toughness|mana value) among (.+?) and (.+)$/))) {
    const a = withCtrl(parseNoun(oc(m, 3)), ctx);
    const b = withCtrl(parseNoun(oc(m, 4)), ctx);
    if (a && b) return { kind: 'maxOf', stat: m[2] === 'power' ? 'power' : m[2] === 'toughness' ? 'toughness' : 'manaValue', filter: { anyOf: [{ ...a.filter, zone: a.filter.zone ?? 'battlefield' }, { ...b.filter, zone: b.filter.zone ?? 'battlefield' }] } };
  }
  if ((m = t.match(/^the (greatest|highest) (power|toughness|mana value) among (.+)$/))) {
    const noun = withCtrl(parseNoun(oc(m, 3)), ctx);
    if (noun) return { kind: 'maxOf', stat: m[2] === 'power' ? 'power' : m[2] === 'toughness' ? 'toughness' : 'manaValue', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } };
  }
  if (t === 'the number of creatures in your party') return { kind: 'partySize' };
  if (t === 'the number of times it was kicked' || t === 'the number of times ~ was kicked') return { kind: 'kickCount' };
  if (t === 'the number of creature in your party' || t === 'creature in your party' || t === 'creatures in your party' || t === 'the number of creatures in your party') return { kind: 'partySize' };
  if (t === 'the number of opponents you have' || t === 'the number of your opponents' || t === 'opponents you have' || t === 'your opponents' || t === 'the number of opponents') return { kind: 'opponents' };
  if (t === 'the number of spells you have cast this turn' || t === 'spells you have cast this turn' || t === 'spell you have cast this turn' || t === 'the number of spell you have cast this turn' || t === 'the number of other spells you have cast this turn') return { kind: 'spellsCastThisTurn' };
  if (t === 'the number of cards you have drawn this turn' || t === 'cards you have drawn this turn' || t === 'card you have drawn this turn' || t === 'the number of card you have drawn this turn') return { kind: 'cardsDrawnThisTurn' };
  if ((m = t.match(/^(?:the number of )?cards? (?:you )?(?:drew|drawn) this way$/))) return { kind: 'triggerAmount' };
  if ((m = t.match(/^the mana value of the (?:sacrificed|exiled|discarded|destroyed|chosen) (?:permanent|creature|card|artifact|land)$/))) return { kind: 'manaValue', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }) };
  if ((m = t.match(/^the number of cards (that player|target opponent|target player|they|each opponent) discarded this turn$/))) {
    const r = ctx.resolvePlayer?.(m[1]) ?? thatPlayer(ctx);
    return { kind: 'playerTurnStat', key: 'discard', ref: r };
  }
  if ((m = t.match(/^(?:the number of )?colors? of mana spent to cast (?:it|~|this spell)$/))) return { kind: 'manaSpent', of: 'colors' };
  if ((m = t.match(/^(?:the number of |the amount of )?mana spent to cast (?:it|~|this spell)$/))) return { kind: 'manaSpent', of: 'total' };
  if ((m = t.match(/^((?:\{[wubrgc]\})+) spent to cast (?:it|~|this spell)$/))) return { kind: 'manaSpent', of: 'colors', symbols: m[1].toUpperCase() };
  if ((m = t.match(/^(?:the )?total (?:number of )?(?:cards in all players' hands)$/))) return { kind: 'count', filter: { zone: 'hand' } };
  if ((m = t.match(/^(?:the )?(?:total )?(?:amount of )?(?:\d+ )?life (?:lost by |your )?opponents? (?:have )?lost this turn$/)) || (m = t.match(/^(?:the )?total life lost by your opponents this turn$/))) return { kind: 'playerTurnStat', key: 'lifeLostAmount', opponents: true };
  if ((m = t.match(/^(?:the )?(?:total )?(?:amount of )?life you(?:'ve| have)? lost this turn$/))) return { kind: 'playerTurnStat', key: 'lifeLostAmount' };
  if ((m = t.match(/^(?:the )?total toughness of (.+)$/))) {
    const noun = withCtrl(parseNoun(oc(m, 1)), ctx);
    if (noun) return { kind: 'totalToughness', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } };
  }
  if ((m = t.match(/^(?:the number of )?([\w' -]+?) votes?$/)) && !/^(?:the|a|an|no)$/.test(m[1])) return { kind: 'voteCount', option: m[1].toLowerCase() };
  if ((m = t.match(/^(?:the )?(?:excess )?damage dealt to you this turn$/))) return { kind: 'playerTurnStat', key: 'damageTaken' };
  if ((m = t.match(/^(?:the )?number of counters on (?:it|~|that permanent|that creature)$/))) return { kind: 'countersOn', ref: /~/.test(t) ? ctx.self : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : ctx.self), counter: 'any' };
  if ((m = t.match(/^(?:that|the) creature's power plus its toughness$/))) {
    const ref: Ref = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : ctx.self);
    return { kind: 'sum', parts: [{ kind: 'power', ref }, { kind: 'toughness', ref }] };
  }
  if ((m = t.match(/^the (?:sacrificed|exiled|discarded|destroyed|chosen) \w+'s (power|toughness)$/))) return { kind: m[1] as 'power' | 'toughness', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }) };
  if ((m = t.match(/^the (?:sacrificed|exiled|discarded|destroyed|chosen) \w+'s mana value$/))) return { kind: 'manaValue', ref: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'lastMoved' }) };
  if ((m = t.match(/^(target|that|the) ([\w -]+?)'s (power|toughness|mana value)$/)) && ctx.lastObj) return { kind: m[3] === 'power' ? 'power' : m[3] === 'toughness' ? 'toughness' : 'manaValue', ref: ctx.lastObj };
  if ((m = t.match(/^(?:the )?(?:total )?amount of life you(?:'ve| have)? gained this turn$/))) return { kind: 'playerTurnStat', key: 'lifeGainedAmount' };
  if ((m = t.match(/^(?:the )?(?:number of )?(?:each )?opponents?$/)) || t === 'opponent you have') return { kind: 'opponents' };
  if ((m = t.match(/^(?:the|that) result$/))) return { kind: 'lastRoll' };
  if ((m = t.match(/^(?:the )?chosen number$/))) return { kind: 'chosenNumber' };
  if ((m = t.match(/^(?:the number of )?(?:each )?times? you(?:'ve| have)? cast (?:your|a) commander from the command zone this game$/))) return { kind: 'commanderCasts' };
  if ((m = t.match(/^your starting life total$/))) return { kind: 'startingLife' };
  if ((m = t.match(/^the number of differently named (.+?) you control$/))) {
    const noun = withCtrl(parseNoun(oc(m, 1).replace(/s$/i, '')), ctx);
    if (noun) return { kind: 'distinctValues', stat: 'name', filter: { ...noun.filter, controller: 'you', zone: noun.filter.zone ?? 'battlefield' } };
  }
  if ((m = t.match(/^the (?:amount|number) of mana spent to cast (?:that spell|it)$/))) return { kind: 'manaSpent', of: 'total' };
  if ((m = t.match(/^the number of tokens you(?:'ve| have)? created this turn$/))) return { kind: 'playerTurnStat', key: 'tokenCreated' };
  if ((m = t.match(/^the number of cards in (.+?)'s (?:hand|graveyard)$/))) {
    const r = ctx.resolvePlayer?.(m[1]);
    if (r) return /graveyard/.test(t) ? { kind: 'graveyardSize', ref: r } : { kind: 'handSize', ref: r };
  }
  if ((m = t.match(/^the number of (.+?) cards in (?:its controller's|that player's|their) graveyard$/))) {
    const noun = parseNoun(`${oc(m, 1)} card`);
    if (noun) return { kind: 'graveyardSize', ref: thatPlayer(ctx), filter: noun.filter };
  }
  if ((m = t.match(/^(\d+|one|two|three|four|five) plus (.+)$/))) {
    const base = wordToNumber(m[1]);
    const rest = parseAmount(m[2], ctx);
    if (base !== null && base !== 'X' && rest !== null) return { kind: 'sum', parts: [base, rest] };
  }
  if (t === 'the number of experience counters you have' || t === 'experience counter you have' || t === 'experience counters you have') return { kind: 'turnStat', key: 'experience' };
  if (t === 'player' || t === 'players' || t === 'the number of players' || t === 'players in the game') return { kind: 'sum', parts: [1, { kind: 'opponents' }] };
  if ((m = t.match(/^(?:the number of )?colors? among (.+)$/))) {
    const noun = withCtrl(parseNoun(oc(m, 1)), ctx);
    if (noun) return { kind: 'colorCount', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } };
  }
  if ((m = t.match(/^(?:the number of )?different (powers?|toughnesses|toughness|mana values?|names?) among (.+)$/))) {
    const noun = withCtrl(parseNoun(oc(m, 2)), ctx);
    if (noun) return { kind: 'distinctValues', stat: /^power/.test(m[1]) ? 'power' : /^tough/.test(m[1]) ? 'toughness' : /^mana/.test(m[1]) ? 'manaValue' : 'name', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } };
  }
  if ((m = t.match(/^(?:the number of )?(?:cards?|creatures?|permanents?|creature cards?|nonland cards?|lands?) (?:you )?exiled this way$/))) return { kind: 'ctxMemory', key: 'lastMoved' };
  if ((m = t.match(/^(?:the number of )?(?:\w+ )?(?:creatures?|permanents?|lands?|artifacts?) (?:you )?(?:tapped|untapped|returned|put onto the battlefield|sacrificed|exiled|destroyed) this way$/))) return { kind: 'ctxMemory', key: 'lastMoved' };
  if ((m = t.match(/^(?:the number of )?(\+1\/\+1|-1\/-1|charge|loyalty|lore|\w+) counters on (~|it|that creature|this creature)$/))) return { kind: 'countersOn', ref: /~|this/.test(m[2]) ? ctx.self : ctx.lastObj ?? ctx.self, counter: m[1] };
  if ((m = t.match(/^the number of (.+?)(?: on the battlefield)?$/))) {
    const noun = withCtrl(parseNoun(oc(m, 1)), ctx);
    if (noun) return { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter } };
  }
  if ((m = t.match(/^the number of (.+?) in all graveyards$/))) {
    const noun = withCtrl(parseNoun(oc(m, 1).replace(/ cards$/i, ' card')), ctx);
    if (noun) return { kind: 'count', filter: { ...noun.filter, zone: 'graveyard' } };
  }
  if ((m = t.match(/^(\d+|x|one|two|three|four|five) plus the number of (.+)$/))) {
    const noun = withCtrl(parseNoun(oc(m, 2)), ctx);
    const base = wordToNumber(m[1]);
    if (noun && base !== null) return { kind: 'sum', parts: [base, { kind: 'count', filter: noun.filter }] };
  }
  if ((m = t.match(/^(?:the )?damage dealt(?: this way)?$/))) return { kind: 'triggerAmount' };
  if ((m = t.match(/^your devotion to (white|blue|black|red|green)$/))) return { kind: 'devotion', colors: [({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1] as 'white']] };
  if (t === 'the number of creatures you control') return { kind: 'count', filter: { types: ['Creature'], controller: 'you' } };
  if (t === 'the number of spells you have cast this turn' || t === 'the number of other spells you have cast this turn') return { kind: 'spellsCastThisTurn' };
  return null;
}
