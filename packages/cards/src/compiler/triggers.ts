/** Trigger head parsing: "Whenever X, " → event + filter. */
import type { GameEventName, TriggerFilter, ZoneName } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { wordToNumber } from './text.js';
import type { ObjectFilter } from '@commander/engine';

export interface TriggerHead {
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
    .replace(/^When (a|an|another|one or more) /, 'Whenever $1 ')
    .replace(/^Whenever ~ attacks while saddled, /i, 'Whenever ~ attacks, if ~ is saddled, ')
    .replace(/^Whenever ~ attacks for the first time each turn, /i, 'Whenever ~ attacks, ')
    .replace(/^At the beginning of combat on each player's turn, /i, 'At the beginning of combat on each turn, ');
  {
    // "Whenever one or more cards leave your graveyard during your turn, X" → same trigger, restricted to your turn.
    const dm = line.match(/^(When(?:ever)? .+?) during your turn, (.+)$/i);
    if (dm) {
      const h = parseTriggerHead(`${dm[1]}, ${dm[2]}`);
      if (h) return { ...h, filter: { ...(h.filter ?? {}), yourTurn: true } };
    }
  }
  {
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

  // ETB
  if ((m = L.match(/^Whenever ~ enters or attacks, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true }] };
  if ((m = L.match(/^When(?:ever)? ~ enters or leaves the battlefield, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'leavesBattlefield', filter: { self: true }, leaves: true, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^When ~ enters and at the beginning of your upkeep, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'beginningOfUpkeep', filter: { player: 'you' }, hasObject: false, hasPlayer: true }] };
  if ((m = L.match(/^When ~ enters?, (.+)$/i)) && /^When ~ enter,/.test(L)) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^When ~ becomes level (\d+), (.+)$/i))) return { event: 'counterAdded', filter: { self: true, counterType: 'level' }, hasObject: true, hasPlayer: false, rest: `if ~ has ${m[1]} or more level counters on it, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ and at least (\w+) other creatures? attack, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control ${wordToNumber(m[1]) === 1 ? 'two' : wordToNumber(m[1]) === 2 ? 'three' : 'four'} or more attacking creatures, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ attacks alone, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control exactly one attacking creature, ${m[1]}` };
  if ((m = L.match(/^Whenever (?:a|an) (.+?) you control attacks alone, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]} you control`);
    if (!tf) return null;
    return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: `if you control exactly one attacking creature, ${m[2]}` };
  }
  if ((m = L.match(/^Whenever you attack with (\w+) or more creatures, (.+)$/i))) return { event: 'attacks', filter: { player: 'you', firstEachTurn: true }, hasObject: true, hasPlayer: true, rest: `if you control ${m[1]} or more attacking creatures, ${m[2]}` };
  if ((m = L.match(/^Whenever ~ attacks while you control (.+?), (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: `if you control ${m[1]}, ${m[2]}` };
  if ((m = L.match(/^When ~ enters or is turned face up, (.+)$/i))) return { event: 'entersBattlefield', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
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
    if (!tf) return null;
    return { event: 'tapped', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
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
    if (!tf) return null;
    return { event: 'dies', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an|another) (.+?) (?:is put into your graveyard from anywhere|is put into a graveyard from anywhere), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    return { event: 'putIntoGraveyard', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an|another) (.+?) leaves the battlefield, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    return { event: 'leavesBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  // Attacks / blocks
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
    if (!tf) return null;
    return { event: 'tappedForMana', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) becomes tapped, (.+)$/i))) return { event: 'tapped', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever (equipped|enchanted) (?:creature|permanent) is dealt damage, (.+)$/i))) return { event: 'dealtDamage', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^At the beginning of the upkeep of (?:enchanted|equipped) (?:creature|permanent)'s controller, (.+)$/i))) return { event: 'beginningOfUpkeep', filter: { custom: 'attachedControllersUpkeep' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ attacks or blocks, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1], also: [{ event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^Whenever ~ attacks(?: a player| an opponent)?, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ attacks a player who (?:is|has) .+?, (.+)$/i))) return { event: 'attacks', filter: { self: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ blocks(?: a creature)?, (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ blocks or becomes blocked by a creature, (.+)$/i))) return { event: 'blocks', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1], also: [{ event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  if ((m = L.match(/^Whenever ~ blocks (?:a|an) (.+?), (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    return { event: 'blocks', filter: { self: true, source: tf.object }, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever enchanted (creature|permanent) attacks, (.+)$/i))) return { event: 'attacks', filter: { attachedToSource: true }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever (?:enchanted|equipped) (creature|permanent) (?:deals combat damage to a player|deals combat damage to an opponent), (.+)$/i))) return { event: 'dealtCombatDamageToPlayer', filter: { attachedToSource: true, player: /opponent/i.test(m[0]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^When(?:ever)? enchanted (creature|permanent|land|artifact) dies, (.+)$/i))) return { event: 'dies', filter: { attachedToSource: true }, hasObject: true, hasPlayer: false, rest: m[2] };
  if ((m = L.match(/^Whenever you cast a spell that targets ~, (.+)$/i))) return { event: 'cast', filter: { player: 'you', targetsSource: true }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ becomes blocked(?: by a creature)?, (.+)$/i))) return { event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever (?:a|an|another|one or more) (.+?) attacks?(?: a player| you or a planeswalker you control| a player or planeswalker)?, (.+)$/i))) {
    const tf = nounFilter(`${/^Whenever another/i.test(m[0]) ? 'another ' : 'a '}${m[1]}`);
    if (!tf) return null;
    return { event: 'attacks', filter: tf, hasObject: true, hasPlayer: true, rest: m[2] };
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
    if (!tf) return null;
    return { event: 'blocks', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  // Damage
  if ((m = L.match(/^When ~ deals combat damage to (a player|an opponent), (.+)$/i))) return { event: 'dealtCombatDamageToPlayer', filter: { self: true, player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: true, hasPlayer: true, rest: m[2] };
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
    if (!tf) return null;
    return { event: 'blocks', filter: { self: true, source: tf.object }, hasObject: true, hasPlayer: false, rest: m[2], also: [{ event: 'becomesBlocked', filter: { self: true }, hasObject: true, hasPlayer: false }] };
  }
  if ((m = L.match(/^Whenever ~ deals damage to (a player|an opponent), (.+)$/i))) return { event: 'dealtDamage', filter: { source: { self: true }, toPlayer: true, player: /opponent/i.test(m[1]) ? 'opponent' : 'any' }, hasObject: false, hasPlayer: true, rest: m[2] };
  if ((m = L.match(/^Whenever ~ deals combat damage to a creature, (.+)$/i))) return { event: 'dealsCombatDamage', filter: { source: { self: true }, object: { types: ['Creature'] } }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^Whenever ~ deals (?:combat )?damage, (.+)$/i))) return { event: /combat/i.test(m[0]) ? 'dealsCombatDamage' : 'dealsDamage', filter: { source: { self: true } }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ deals damage to a creature, (.+)$/i))) return { event: 'dealsDamage', filter: { source: { self: true }, object: { types: ['Creature'] } }, hasObject: true, hasPlayer: false, rest: m[1] };
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
    if (!tf) return null;
    return { event: 'dealtDamage', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
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
    if (!tf) return null;
    return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
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
  if ((m = L.match(/^Whenever you cast a kicked spell, (.+)$/i))) return { event: 'cast', filter: { player: 'you', custom: 'kicked' }, hasObject: true, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever you cast a spell from (exile|your graveyard|a graveyard), (.+)$/i))) return { event: 'cast', filter: { player: 'you', fromZone: /exile/.test(m[1]) ? 'exile' : 'graveyard' }, hasObject: true, hasPlayer: true, rest: m[2] };
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
  if ((m = L.match(/^When ~ becomes monstrous, (.+)$/i))) return { event: 'becomesMonstrous', filter: { self: true }, hasObject: true, hasPlayer: false, rest: m[1] };
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
    if (!tf) return null;
    return { event: 'putIntoGraveyard', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever (?:a|an) (.+?) enters under an opponent's control, (.+)$/i))) {
    const tf = nounFilter(`a ${m[1]}`);
    if (!tf) return null;
    tf.objectController = 'opponent';
    return { event: 'entersBattlefield', filter: tf, hasObject: true, hasPlayer: false, rest: m[2] };
  }
  if ((m = L.match(/^Whenever a player attacks you with one or more creatures, (.+)$/i))) return { event: 'attacked', filter: { player: 'you' }, hasObject: false, hasPlayer: true, rest: m[1] };
  if ((m = L.match(/^Whenever ~ or another creature you control becomes blocked, (.+)$/i))) return { event: 'becomesBlocked', filter: { object: { types: ['Creature'] }, objectController: 'you' }, hasObject: true, hasPlayer: false, rest: m[1] };
  if ((m = L.match(/^At the beginning of each end step, if you control (?:a|an) (.+?), (.+)$/i))) return null; // let generic handle
  return null;
}

/** Strip a leading "you may" and intervening-if clause. */
export function splitTriggerRest(rest: string): { optional: boolean; condition: string | null; rest: string } {
  let r = rest.trim();
  let condition: string | null = null;
  let m = r.match(/^if (.+?), (.+)$/i);
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
