/** Static abilities and replacement effects. */
import type { AbilityCost, AbilitySpec, Amount, Condition, Effect, ObjectFilter, Ref, RuleModification, StaticAbilitySpec } from '@commander/engine';
import { parseNoun, singularize } from './nouns.js';
import { parseKeywordList, isNoOpSentence, parseEffects, newCtx, parseCopyExceptions, parseTokenPhrase, parseGrantList } from './effects.js';
import { wordToNumber } from './text.js';
import { parseCondition } from './conditions.js';
import { parseCost } from './costs.js';
import { parseAmount } from './amounts.js';
import { damageSourceFilter, damageDestFilter, damageModifier } from './damage.js';

function affectsOf(text: string): { affects: StaticAbilitySpec['affects']; ok: boolean } {
  const l = text.trim().toLowerCase();
  // "Creatures enchanted player controls": the Aura is attached to the player.
  const ep = text.trim().match(/^(.+?) enchanted player controls$/i);
  if (ep) {
    const n = parseNoun(ep[1]);
    if (!n) return { affects: undefined, ok: false };
    return { affects: { ...n.filter, zone: n.filter.zone ?? 'battlefield', controllerRef: { ref: 'attachedTo' } }, ok: n.confident };
  }
  if (l === '~' || l === 'it') return { affects: 'self', ok: true };
  if (/^(enchanted|equipped|fortified) (creature|permanent|land|artifact|planeswalker)$/.test(l)) return { affects: 'attachedTo', ok: true };
  const noun = parseNoun(text.trim());
  if (!noun) return { affects: undefined, ok: false };
  const f: ObjectFilter = { ...noun.filter };
  if (noun.other) f.other = true;
  if (!f.zone && !f.zoneIn) f.zone = 'battlefield';
  // Plural nouns without "you control" default to all (e.g. "Creatures get -1/-1")
  return { affects: f, ok: noun.confident };
}

export function parseStatic(line: string, isCreatureOrPermanent: boolean): AbilitySpec[] | null {
  let m: RegExpMatchArray | null;
  const L0 = line.replace(/\.? This effect cannot reduce the mana in that cost to less than one mana\.?$/i, '');
  const L = L0
    .replace(/\.$/, '')
    .replace(/\. This effect (?:does not|doesn't) remove .+$/i, '')
    .replace(/\bloses? all other abilities\b/i, (w) => w.replace(/ other/, ''))
    .replace(/ and cannot have or gain \w+$/i, '');
  const objRule = (who: string, rule: RuleModification): AbilitySpec[] | null => {
    const a = affectsOf(who);
    return a.ok ? [{ kind: 'static', text: line, affects: a.affects, rule }] : null;
  };
  // "You may look at the cards exiled with ~, and you may play lands and cast spells from among
  // those cards." — looking is public information here; the permission is what matters.
  if ((m = L.match(/^You may look at the cards exiled with (?:~|it), and (you may .+?) from among those cards$/i))) {
    const inner = parseStatic(`${m[1].replace(/^you/, 'You')} from among cards exiled with ~`, isCreatureOrPermanent);
    if (inner) return inner;
  }
  // "You may pay {0} rather than pay the equip cost of the first equip ability you activate each
  // turn." / "... rather than pay cycling costs."
  if ((m = L.match(/^You may pay \{0\} rather than pay (?:the ([\w-]+) cost of the first (?:[\w-]+ ability you activate|card you cycle) (?:each turn|during each of your turns)|(?:the )?([\w-]+) costs?(?: for permanents you control)?)$/i)) && !/^mana$/i.test(m[2] ?? '')) {
    const prefix = (m[1] ?? m[2]).replace(/^\w/, (c) => c.toUpperCase());
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'freeFirstAbilityEachTurn', data: { textPrefix: prefix, always: m[2] ? true : undefined } } }];
  }
  // "~ and other Vampire creatures you control get +2/+1 and have flying." — the source joins the
  // group, so compile one static per subject.
  if ((m = L.match(/^~ and (.+?) (get|gain|have|are) (.+)$/i))) {
    const one: Record<string, string> = { get: 'gets', gain: 'gains', have: 'has', are: 'is' };
    const tail = m[3].replace(/\band (get|gain|have|are) /gi, (_x, v: string) => `and ${one[v.toLowerCase()]} `);
    const a = parseStatic(`~ ${one[m[2].toLowerCase()]} ${tail}`, isCreatureOrPermanent);
    const b = a ? parseStatic(`${m[1].replace(/^\w/, (c) => c.toUpperCase())} ${m[2]} ${m[3]}`, isCreatureOrPermanent) : null;
    if (a && b) return [...a, ...b];
  }
  // ---- Round 157 ----
  // "You and Humans you control have hexproof."
  // ---- Round 199b ----
  // "Equipped creature has deathtouch during your turn. Otherwise, it has reach."
  if ((m = L.match(/^(.+?) during your turn\. Otherwise, (.+)$/i))) {
    const subj = m[1].match(/^(~|Enchanted \w+|Equipped \w+|Creatures you control|Each creature you control)\b/i)?.[1];
    const a199 = parseStatic(`${m[1]} during your turn`, isCreatureOrPermanent);
    const other = subj ? m[2].replace(/^(?:it|they) /i, `${subj} `) : m[2];
    const c199 = parseCondition('it is your turn', { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    const b199 = c199 && c199.kind !== 'manual' ? parseStatic(other, isCreatureOrPermanent) : null;
    if (a199 && b199 && c199) return [...a199, ...b199.map((x) => (x.kind === 'static' ? { ...x, condition: { kind: 'not' as const, c: c199 } } : x))];
  }
  // "Equipped creature gets +1/+1. If it is a Warrior, it gets +2/+1 instead."
  if ((m = L.match(/^(.+?)\. If it is (?:a|an) (.+?), it gets ([+-]\d+)\/([+-]\d+) instead$/i))) {
    const subj = m[1].match(/^(~|Enchanted \w+|Equipped \w+)\b/i)?.[1];
    if (subj) {
      const c = parseCondition(`${subj} is a ${m[2]}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      const base = parseStatic(m[1], isCreatureOrPermanent);
      const boost = parseStatic(`${subj} gets ${m[3]}/${m[4]}`, isCreatureOrPermanent);
      if (c && c.kind !== 'manual' && base && boost)
        return [
          ...base.map((x) => (x.kind === 'static' ? { ...x, condition: { kind: 'not' as const, c } } : x)),
          ...boost.map((x) => (x.kind === 'static' ? { ...x, condition: c } : x)),
        ];
    }
  }
  // "You may cast spells from your hand without paying their mana costs." / "You may cast Dragon spells without ..."
  sx199: {
  if ((m = L.match(/^You may cast (.+?)(?: from your hand)? without paying their mana costs$/i))) {
    let f199: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const n199 = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!n199) break sx199;
      f199 = { ...n199.filter };
      delete f199.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castForFree', data: { filter: f199, fromHand: / from your hand /i.test(` ${m[0]} `) || undefined } } }];
  }
  }
  // "Your maximum hand size is equal to the number of hour counters on ~."
  if ((m = L.match(/^(Your|Each player's|Each opponent's) maximum hand size is equal to (.+)$/i))) {
    const amt199 = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (amt199 !== null) {
      const who199 = /^your$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
      return [{ kind: 'static', text: line, ruleAffects: who199, rule: { kind: 'maxHandSize', amount: amt199 } }];
    }
  }
  // ---- Round 275 ----
  // "~ has flying and trample if it devoured a creature."
  if ((m = L.match(/^~ (?:has|have) (.+?) if it devoured a creature$/i))) {
    const g275 = parseGrantList(m[1]);
    if (g275 && g275.keywords.length && !g275.abilities.length)
      return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: g275.keywords }, condition: { kind: 'memoryFlag', key: 'devoured' } }];
  }
  // ---- Round 272 ----
  // "If ~ is your commander, choose a color before the game begins. ~ is the chosen color."
  if (/^If ~ is your commander, choose a colou?r before the game begins\. ~ is the chosen colou?r$/i.test(L)) {
    return [
      { kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: 'color' },
      { kind: 'static', text: line, affects: 'self', modification: { layer: 5, setColorsFromMemory: 'color' } },
    ] as never;
  }
  // ---- Round 270 ----
  // "As long as you control exactly one creature, that creature gets +2/+0 and has lifelink."
  if ((m = L.match(/^As long as you control exactly one creature, that creature (.+)$/i))) {
    const inner270 = parseStatic(`Creatures you control ${m[1].replace(/^gets /i, 'get ').replace(/^has /i, 'have ')}`, isCreatureOrPermanent);
    if (inner270) {
      const c270: Condition = { kind: 'count', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' }, op: '==', value: 1 };
      return inner270.map((a) => (a.kind === 'static' ? { ...a, text: line, condition: a.condition ? { kind: 'and' as const, cs: [a.condition, c270] } : c270 } : a));
    }
  }
  // ---- Round 258 ----
  // "Creatures you control can't be the targets of blue spells or abilities from blue sources."
  if ((m = L.match(/^(.+?) cannot be the targets? of (white|blue|black|red|green) spells or abilities from \2 sources$/i))) {
    const c258 = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[2].toLowerCase() as 'white'];
    const r258 = objRule(m[1], { kind: 'cantBeTargeted', filter: { colors: [c258] } });
    if (r258) return r258;
  }
  // ---- Round 245 ----
  // "During your turn, ~ is a Bear with base power and toughness 4/2."
  sx245: {
  if ((m = L.match(/^(?:(During your turn), )?(.+?) is (?:a|an) ((?:white|blue|black|red|green|colorless) )?([A-Z][\w-]+) with base power and toughness (\d+)\/(\d+)$/i))) {
    const a245 = affectsOf(m[2]);
    if (!a245.ok) break sx245;
    const cond245: Condition | undefined = m[1] ? { kind: 'yourTurn' } : undefined;
    const out245: unknown[] = [
      { kind: 'static', text: line, affects: a245.affects, condition: cond245, modification: { layer: 4, setSubtypes: [m[4]] } },
      { kind: 'static', text: line, affects: a245.affects, condition: cond245, modification: { layer: '7b', power: parseInt(m[5], 10), toughness: parseInt(m[6], 10) } },
    ];
    if (m[3]) {
      const c245 = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[3].trim().toLowerCase() as 'white'];
      out245.push({ kind: 'static', text: line, affects: a245.affects, condition: cond245, modification: { layer: 5, setColors: c245 ? [c245] : [] } });
    }
    return out245 as never;
  }
  }
  // ---- Round 242 ----
  // "Creature spells you cast that share a creature type with ~ cost {1} less to cast."
  sx242: {
  if ((m = L.match(/^(.+? spells) you cast (that .+?) cost \{(\d)\} less to cast$/i))) {
    const n242 = parseNoun(`a ${singularize(m[1])} ${m[2]}`);
    if (!n242 || !n242.confident) break sx242;
    const f242 = { ...n242.filter };
    delete f242.zone;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[3], 10), filter: { ...f242, controller: 'you' } } }];
  }
  }
  // ---- Round 240 ----
  // "You may play lands and cast spells from among cards exiled with ~."
  if ((m = L.match(/^(?:During your turn, )?You may (?:play lands and cast spells|play cards|cast spells|play|cast)(?: from among(?: the)? cards| cards)? exiled with ~(?:, and you may spend mana as though it (?:were|was) mana of any (?:colou?r|type) to cast (?:those spells|them|it))?$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playExiledWithSource', data: { yourTurn: /^During your turn/i.test(L), anyMana: /spend mana as though/i.test(L) } } }];
  // "Double all damage ~ would deal."
  if (/^(?:Double|Triple) all damage ~ would deal$/i.test(L))
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damageMultiplier', data: { filter: { self: true }, times: /^Triple/i.test(L) ? 3 : 2 } } }];
  // ---- Round 239 ----
  // "You may spend mana as though it were mana of any color to cast planeswalker spells."
  if ((m = L.match(/^You may spend mana as though it were mana of any (?:colou?r|type) to cast (.+?) spells$/i))) {
    const n239 = parseNoun(`a ${m[1]} spell`);
    if (n239 && n239.confident) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'manaAsAnyColor', data: { filter: { ...n239.filter, zone: undefined } } } } as never];
  }
  // "You may spend mana as though it were mana of any color to activate abilities of creatures you control."
  // "... to pay the activation costs of ~'s abilities."
  if ((m = L.match(/^You may spend mana as though it were mana of any (?:colou?r|type) to (?:pay the activation costs of (~)'s abilities|activate abilities of (.+?))$/i))) {
    const f239 = m[1] ? { self: true } : parseNoun(`a ${singularize(m[2])}`)?.filter;
    if (f239) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'manaAsAnyColorAbilities', data: { filter: { ...f239, zone: undefined } } } } as never];
  }
  // ---- Round 235 ----
  // "As long as a creature card with flying is in a graveyard, ~ has flying."
  if ((m = L.match(/^As long as (?:a|an) (.+?) is in (?:a|any) graveyard, ~ has (.+?)$/i))) {
    const n235 = parseNoun(`a ${m[1]}`);
    const g235 = parseGrantList(m[2]);
    if (n235 && g235 && g235.keywords.length && !g235.abilities.length)
      return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: g235.keywords }, condition: { kind: 'count', filter: { ...n235.filter, zone: 'graveyard' }, op: '>=', value: 1 } }];
  }
  // "As long as ~ is attacking, defending player cannot cast spells."
  if (/^As long as ~ is attacking, defending player cannot cast spells$/i.test(L))
    return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'cantCast', data: { filter: {} } }, condition: { kind: 'objectMatches', ref: { ref: 'self' }, filter: { attacking: true } } }];
  // "As long as ~ is on the stack, spells that target it cost {2} more to cast."
  if ((m = L.match(/^As long as ~ is on the stack, spells that target it cost \{(\d+)\} (more|less) to cast$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: /more/i.test(m[2]) ? 'costIncrease' : 'costReduction', amount: parseInt(m[1], 10), filter: { spellTargets: { nameIs: '~' } } } }];
  // "As long as ~ attacked this turn, you may play the top card of your library."
  if (/^As long as ~ attacked this turn, you may play the top card of your library$/i.test(L))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playTopCard' }, condition: { kind: 'objectMatches', ref: { ref: 'self' }, filter: { attackedThisTurn: true } } }];
  // "~ attacks each combat if able unless you control another Ally."
  if ((m = L.match(/^~ attacks each combat if able unless you control another (.+?)$/i))) {
    const n235b = parseNoun(`a ${m[1]}`);
    if (n235b && n235b.confident)
      return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'mustAttack' }, condition: { kind: 'not', c: { kind: 'count', filter: { ...n235b.filter, zone: 'battlefield', controller: 'you', other: true }, op: '>=', value: 1 } } }];
  }
  // "~ enters tapped if it was played from your hand."
  if (/^~ enters tapped if it was played from your hand$/i.test(L))
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, condition: { kind: 'objectMatches', ref: { ref: 'self' }, filter: { castFromZone: 'hand' } } }];
  // "Activate no more times each turn than the number of snow Swamps you control"
  if ((m = L.match(/^Activate no more times each turn than the number of (.+?)$/i))) {
    const a235 = parseAmount(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a235 !== null) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'activationLimitAmount', data: a235 } }];
  }
  // ---- Round 234 ----
  // "You can't choose an untapped permanent as ~'s target as you cast it."
  if ((m = L.match(/^You cannot choose an? (untapped|tapped) (permanent|creature|artifact|land) as ~'s target as you cast it$/i)))
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'targetMustBe', data: { filter: /untapped/i.test(m[1]) ? { tapped: true } : { untapped: true } } } }];
  // "~ costs {1} less to cast for each opponent you attacked this turn."
  if ((m = L.match(/^~ costs \{(\d+)\} less to cast for each (.+?)$/i))) {
    const a234 = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a234 !== null) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[1], 10), perAmount: a234, filter: { self: true } } as never }];
  }
  // "~ costs 3 life more to cast for each target."
  if ((m = L.match(/^~ costs (\d+) life more to cast for each target$/i)))
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'lifeCostPerTarget', data: parseInt(m[1], 10) } }];
  // "~ gets +10/+10 for each player who has lost the game."
  if ((m = L.match(/^~ gets ([+-]\d+)\/([+-]\d+) for each player who has lost the game$/i)))
    return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7c', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), perAmount: { kind: 'playersLost' } } as never }];
  // "Equipment named Sword of Kaldra, ~, and Helm of Kaldra have indestructible."
  if ((m = L.match(/^(Equipment|Artifacts|Creatures) named ([A-Z][\w' ,-]*?), ~, and ([A-Z][\w' ,-]*?) have (.+?)$/i))) {
    const g234 = parseGrantList(m[4]);
    const n234 = parseNoun(`a ${singularize(m[1])}`);
    if (g234 && g234.keywords.length && !g234.abilities.length && n234)
      return [{ kind: 'static', text: line, affects: { ...n234.filter, zone: 'battlefield', anyOf: [{ nameIs: m[2] }, { nameIs: '~' }, { nameIs: m[3] }] }, modification: { layer: 6, addKeywords: g234.keywords } }];
  }
  // "Each creature without flanking blocking ~ gets -1/-1 until end of turn" (a static on the battlefield)
  if ((m = L.match(/^Each (.+?) gets ([+-]\d+)\/([+-]\d+) until end of turn$/i))) {
    const n234b = parseNoun(`a ${singularize(m[1])}`);
    if (n234b && n234b.confident)
      return [{ kind: 'static', text: line, affects: { ...n234b.filter, zone: 'battlefield' }, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } }];
  }
  // ---- Round 229 ----
  // "~'s power is equal to the number of tapped lands the chosen player controls."
  if ((m = L.match(/^~'s (power|toughness) is equal to (.+?)$/i))) {
    const a229 = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a229 !== null)
      return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', ...(/power/i.test(m[1]) ? { powerAmount: a229 } : { toughnessAmount: a229 }) } }];
  }
  // "Equipped creature gets +3/+1 and must be blocked by an Eldrazi if able."
  if ((m = L.match(/^(Equipped|Enchanted) (\w+) gets ([+-]\d+)\/([+-]\d+) and must be blocked by (?:a|an) (.+?) if able$/i))) {
    const n229 = parseNoun(`a ${m[5]}`);
    if (n229 && n229.confident)
      return [
        { kind: 'static', text: line, affects: 'attachedTo', modification: { layer: '7c', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10) } },
        { kind: 'static', text: line, affects: 'attachedTo', rule: { kind: 'custom', tag: 'mustBeBlockedBy', data: { filter: { ...n229.filter, zone: undefined } } } },
      ];
  }
  // "Equipped creature has menace and mobilize X, where X is its power."
  if ((m = L.match(/^(Equipped|Enchanted) (\w+) has ([\w ]+?) and (mobilize|bushido|rampage|annihilator|afflict) X, where X is its power$/i))) {
    const g229 = parseGrantList(m[3]);
    if (g229 && g229.keywords.length && !g229.abilities.length)
      return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 6, addKeywords: [...g229.keywords, `${m[4].replace(/^\w/, (c) => c.toUpperCase())} X`] } }];
  }
  // "Other creatures you control of a type you noted for cards named ~ get +1/+1."
  if ((m = L.match(/^Other (.+?) of a type you noted for cards named ~ get ([+-]\d+)\/([+-]\d+)$/i))) {
    const n229b = parseNoun(`a ${singularize(m[1])}`);
    if (n229b && n229b.confident)
      return [{ kind: 'static', text: line, affects: { ...n229b.filter, zone: 'battlefield', other: true, typeIsChosen: 'notedType' }, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } }];
  }
  // "Spells with the chosen name enchanted player casts cost {2} more to cast."
  if ((m = L.match(/^Spells with the chosen name enchanted player casts cost \{(\d+)\} (more|less) to cast$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'attachedToController', rule: { kind: /more/i.test(m[2]) ? 'costIncrease' : 'costReduction', amount: parseInt(m[1], 10), filter: { nameIsChosen: 'cardName' } } }];
  // "Each Sliver card in each player's hand has slivercycling {3}."
  if ((m = L.match(/^Each (.+?) card in each player's hand has ([\w-]+) ((?:\{[^}]+\})+)$/i))) {
    const n229c = parseNoun(`a ${m[1]} card`);
    if (n229c && n229c.confident)
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'grantHandKeyword', data: { filter: { ...n229c.filter, zone: 'hand' }, keyword: `${m[2]} ${m[3]}` } } }];
  }
  // "Black and/or red permanents and spells are colorless sources of damage."
  if ((m = L.match(/^(.+?) permanents and spells are colorless sources of damage$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'colorlessDamageSources', data: m[1] } }];
  // "Noncreature spells with mana value equal to the chosen number cannot be cast."
  if ((m = L.match(/^(.+?) spells with mana value equal to the chosen number cannot be cast$/i))) {
    const n229d = /^spells?$/i.test(m[1]) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(`a ${m[1]} spell`);
    if (n229d && n229d.confident)
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantCast', data: { filter: { ...n229d.filter, zone: undefined, cmcEQAmount: { kind: 'chosenNumber' } } } } }];
  }
  // ---- Round 221 ----
  if ((m = L.match(/^~ can be attached only to (?:a|an) (.+?)$/i))) {
    const n221 = parseNoun(`a ${m[1]}`);
    if (n221 && n221.confident) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'attachOnlyTo', data: { filter: { ...n221.filter, zone: undefined } } } }];
  }
  if (/^All creatures attack enchanted creature's controller each combat if able$/i.test(L))
    return [{ kind: 'static', text: line, affects: { types: ['Creature'], zone: 'battlefield' }, rule: { kind: 'custom', tag: 'mustAttackAttachedController' } }];
  if ((m = L.match(/^All creatures able to block (?:~|enchanted creature)(?: or (?:~|enchanted creature))? do so$/i)))
    return [{ kind: 'static', text: line, affects: { types: ['Creature'], zone: 'battlefield' }, rule: { kind: 'custom', tag: 'mustBlockSource', ...(/enchanted creature/i.test(m[0]) ? { data: '__attached__' } : {}) } }];
  // ---- Round 218 ----
  // "Activated abilities of white enchantments cost {3} more to activate."
  if ((m = L.match(/^(?:Activated )?abilities of (.+?) cost \{(\d+)\} more to activate$/i))) {
    const n218 = parseNoun(m[1]);
    if (n218) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'abilityCostIncrease', data: { amount: parseInt(m[2], 10), filter: { ...n218.filter, zone: n218.filter.zone ?? 'battlefield' } } } }];
  }
  // "Mana abilities of ~ cost an additional 1 life to activate."
  if ((m = L.match(/^Mana abilities of ~ cost an additional (\d+) life to activate$/i)))
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'manaAbilityLifeCost', data: parseInt(m[1], 10) } }];
  // "~ cannot be the target of spells unless it attacked or blocked this turn."
  if ((m = L.match(/^(.+?) cannot be the target of (spells|spells or abilities|abilities) unless (.+)$/i))) {
    const c218 = parseCondition(m[3].replace(/^it /i, '~ '), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (c218 && c218.kind !== 'manual') {
      const a218 = affectsOf(m[1]);
      if (a218.ok) return [{ kind: 'static', text: line, affects: a218.affects, rule: { kind: 'cantBeTargeted', by: /abilities$/i.test(m[2]) && !/spells/i.test(m[2]) ? 'abilities' : 'spells' }, condition: { kind: 'not', c: c218 } }];
    }
  }
  // "Enchanted creature cannot attack unless its controller pays {3}." / "~ cannot block creatures with power 3 or greater unless you pay {1}."
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block)(?: (.+?))? unless (?:its controller|you|their controller) pays? ((?:\{[^}]+\})+)$/i))) {
    const a218b = affectsOf(m[1]);
    if (a218b.ok) {
      const f218 = m[3] ? (parseNoun(m[3]) ?? parseNoun(`a ${singularize(m[3])}`)) : null;
      if (!m[3] || f218)
        return [{ kind: 'static', text: line, affects: a218b.affects, rule: { kind: 'custom', tag: /^block$/i.test(m[2]) ? 'blockCost' : /^attack or block$/i.test(m[2]) ? 'attackOrBlockCost' : 'attackCost', data: { cost: m[4], filter: f218 ? { ...f218.filter, zone: undefined } : undefined } } }];
    }
  }
  // "Creatures attacking the last chosen player have menace."
  if ((m = L.match(/^Creatures attacking the last chosen player (?:have|has) (.+?)$/i))) {
    const g218b = parseGrantList(m[1]);
    if (g218b && g218b.keywords.length && !g218b.abilities.length)
      return [{ kind: 'static', text: line, affects: { types: ['Creature'], attacking: true, zone: 'battlefield', custom: 'attackingChosenPlayer' }, modification: { layer: 6, addKeywords: g218b.keywords } }];
  }
  // "You have protection from the chosen card name."
  if (/^You have protection from the chosen card name$/i.test(L))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'protectionFromChosenName' } }];
  // ---- Round 212 ----
  // "Activated abilities cost {2} more to activate unless they are mana abilities."
  if ((m = L.match(/^Activated abilities cost \{(\d+)\} more to activate unless they are mana abilities$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'abilityCostIncrease', data: { amount: parseInt(m[1], 10), notMana: true } } }];
  }
  // "This ability costs {1} more to activate for each card in your hand."
  if ((m = L.match(/^This ability costs \{(\d+)\} more to activate for each (.+?)$/i))) {
    const a212 = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a212 !== null) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'thisAbilityCostIncrease', data: { amount: parseInt(m[1], 10), perAmount: a212 } } }];
  }
  // "Enchanted creature's controller cannot cast creature spells."
  if ((m = L.match(/^(Enchanted|Equipped) \w+'s controller cannot cast (.+?) spells$/i))) {
    const n212 = /^spells?$/i.test(m[2]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[2]} spell`);
    if (n212) return [{ kind: 'static', text: line, ruleAffects: 'attachedToController', rule: { kind: 'custom', tag: 'cantCast', data: { filter: { ...n212.filter, zone: undefined } } } }];
  }
  // "Skip your upkeep step if you have no cards in hand."
  if ((m = L.match(/^Skip your (upkeep|draw|combat|end) step if (.+?)$/i))) {
    const c212 = parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (c212 && c212.kind !== 'manual') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'skipStep', data: m[1].toLowerCase() }, condition: c212 }];
  }
  // "Players cannot play lands as long as ten or more lands are on the battlefield."
  if ((m = L.match(/^Players cannot play lands as long as (.+?)$/i))) {
    const c212b = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (c212b && c212b.kind !== 'manual') return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantPlayLands' }, condition: c212b }];
  }
  // "Each opponent cannot venture into the dungeon more than once each turn."
  if (/^Each opponent cannot venture into the dungeon more than once each turn$/i.test(L)) {
    return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'ventureOncePerTurn' } }];
  }
  // "~ cannot block or be blocked by creatures with power 2 or greater."
  if ((m = L.match(/^(.+?) cannot block or be blocked by (.+?)$/i))) {
    const n212c = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    if (n212c && n212c.confident) {
      const f212 = { ...n212c.filter, zone: undefined };
      const r1 = objRule(m[1], { kind: 'cantBeBlockedBy', filter: f212 });
      const r2 = objRule(m[1], { kind: 'custom', tag: 'cantBlockMatching', data: { filter: f212 } });
      if (r1 && r2) return [...r1, ...r2];
    }
  }
  // "Lands you control and land cards in your library are basic."
  if (/^Lands you control and land cards in your library are basic$/i.test(L)) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'landsAreBasic' } }];
  }
  // ---- Round 199 ----
  // "Creatures with flying cannot attack you or block creatures you control."
  if ((m = L.match(/^(.+?) cannot attack you(?: or planeswalkers you control)? or block creatures you control$/i))) {
    const aff199 = affectsOf(m[1]);
    if (aff199.ok)
      return [
        { kind: 'static', text: line, affects: aff199.affects, rule: { kind: 'custom', tag: 'cantAttackYou' } },
        { kind: 'static', text: line, affects: aff199.affects, rule: { kind: 'custom', tag: 'cantBlockYours' } },
      ];
  }
  // "~ gets +1/+1 for each noncreature token you control."
  if ((m = L.match(/^(.+?) gets? ([+-]\d+)\/([+-]\d+) for each ([\w' -]+?)$/i)) && !/mana symbol|creature type|counter|card type/i.test(m[4])) {
    const aff199b = affectsOf(m[1]);
    const noun199 = parseNoun(m[4]) ?? parseNoun(`a ${singularize(m[4])}`);
    if (aff199b.ok && noun199 && noun199.confident)
      return [{ kind: 'static', text: line, affects: aff199b.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perCount: { ...noun199.filter, zone: noun199.filter.zone ?? 'battlefield' } } }];
  }
  // "Players can't cast noncreature spells from graveyards or exile."
  if ((m = L.match(/^Players cannot cast (.+?) spells from (graveyards or exile|graveyards|exile)$/i))) {
    const noun199c = parseNoun(`a ${m[1]} spell`);
    if (noun199c) {
      const zones = /graveyards or exile/i.test(m[2]) ? ['graveyard', 'exile'] : /graveyards/i.test(m[2]) ? ['graveyard'] : ['exile'];
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantCastFromZones', data: { filter: { ...noun199c.filter, zone: undefined }, zones } } }];
    }
  }
  // "Permanents your opponents control can't be turned face up during your turn."
  if ((m = L.match(/^(.+?) cannot be turned face up(?: during your turn)?$/i))) {
    const aff199d = affectsOf(m[1]);
    if (aff199d.ok) return [{ kind: 'static', text: line, affects: aff199d.affects, rule: { kind: 'custom', tag: 'cantTurnFaceUp', data: / during your turn$/i.test(m[0]) ? 'yourTurn' : 'always' } }];
  }
  if ((m = L.match(/^You and (.+?) (?:has|have) (.+)$/i))) {
    const a = affectsOf(m[1]);
    const kws = parseKeywordList(m[2]);
    if (a.ok && kws) {
      return [
        { kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playerKeywords', data: kws } },
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } },
      ];
    }
  }
  // "Your life total cannot change."
  if (/^Your life total cannot change$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'lifeTotalLocked' } }];
  // "You cannot spend mana to cast ~."
  if (/^You cannot spend mana to cast ~$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castManaSourceRestriction', data: { filter: { nothing: true }, nameIs: '~' } } }];
  // "~ enters tapped and with three charge counters on it."
  if ((m = L.match(/^~ enters tapped and with (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n === 'number') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, counters: { counter: m[2], amount: n } }];
  }
  // "~ enters tapped if it is not your turn." / "~ enters tapped if it was played from your hand."
  if ((m = L.match(/^~ enters tapped if (.+)$/i))) {
    const cond = parseCondition(m[1].replace(/^it (?:is|was) /i, '~ $1 ').replace(/^~ is not your turn$/i, 'it is not your turn'), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })
      ?? parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, condition: cond }];
  }
  // "~ crews Vehicles as though its power were 2 greater."
  if ((m = L.match(/^(.+?) (?:crews Vehicles|saddles Mounts and crews Vehicles) as though (?:its|their) power were (\d+) greater$/i))) {
    const _r157 = objRule(m[1], { kind: 'custom', tag: 'crewPowerBonus', data: parseInt(m[2], 10) });
    if (_r157) return _r157;
  }
  // "You may play any number of lands on each of your turns."
  if (/^You may play any number of lands (?:on|during) each of your turns$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'extraLandDrop', count: 99 } }];
  // "You may play Forests from your graveyard."
  if ((m = L.match(/^You may play (.+?) from your graveyard$/i))) {
    const noun = parseNoun(`a ${singularize(m[1])}`) ?? parseNoun(`a ${m[1]}`);
    if (noun && noun.confident) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playLandsFromGraveyard', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "You may cast spells from among cards exiled with ~."
  if ((m = L.match(/^You may (?:cast|play) (.+?) from among cards exiled with ~$/i))) {
    const label = m[1].trim();
    const noun = /^(?:spells|cards)$/i.test(label) ? { filter: {} as ObjectFilter, confident: true } : /\bspells?\b/i.test(label) ? parseNoun(`a ${label}`) : parseNoun(`a ${label} spell`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castExiledWithSource', data: { filter: Object.keys(f).length ? f : undefined } } }];
    }
  }
  // ---- Round 156 ----
  // "During your turn, ~ costs {2} less to cast." / "During turns other than yours, ~ costs {3} more to cast."
  if ((m = L.match(/^During (your turn|turns other than yours|each opponent's turn), ((?:~|This spell) costs? .+)$/i))) {
    const inner = parseStatic(m[2], isCreatureOrPermanent);
    if (inner) return inner;
  }
  // "During your turn, you and ~ have hexproof."
  if ((m = L.match(/^(?:During your turn, )?you and ~ (?:has|have) (.+)$/i))) {
    const kws = parseKeywordList(m[1]);
    if (kws) {
      const cond: Condition | undefined = /^During your turn/i.test(L) ? { kind: 'yourTurn' } : undefined;
      return [
        { kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playerKeywords', data: kws }, condition: cond },
        { kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: kws }, condition: cond },
      ];
    }
  }
  // "Equipment you control have equip Knight {0}." / "Vehicles you control have crew 1."
  if ((m = L.match(/^(.+?) (?:has|have) ((?:equip|crew|ward|cycling|reinforce) [\w' ]*(?:\{[^}]+\})*|equip [A-Z][\w' ]* (?:\{[^}]+\})+)$/i))) {
    const noun = parseNoun(m[1]);
    if (noun && noun.confident) return [{ kind: 'static', text: line, affects: { ...noun.filter, zone: 'battlefield' }, modification: { layer: 6, addAbilityText: [m[2].charAt(0).toUpperCase() + m[2].slice(1)] } }];
  }
  // "Non-Human Werewolves you control cannot transform."
  if ((m = L.match(/^(.+?) cannot transform$/i))) { const _r156 = objRule(m[1], { kind: 'custom', tag: 'cantTransform' }); if (_r156) return _r156; }
  // "No more than one creature can attack you each combat."
  if ((m = L.match(/^No more than (\w+) creatures? can attack you(?: or planeswalkers you control)? each combat$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'maxAttackers', data: n } }];
  }
  // "Plotting cards from your hand costs {2} less." / "Foretelling cards from your hand costs {1} less."
  if ((m = L.match(/^(\w+ing) cards from your hand costs \{(\d+)\} (less|more)$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'keywordCostChange', data: { keyword: m[1].toLowerCase().replace(/ing$/, ''), amount: parseInt(m[2], 10) * (m[3].toLowerCase() === 'less' ? -1 : 1) } } }];
  }
  // "Spend only mana produced by basic lands to cast ~." / "... by creatures"
  if ((m = L.match(/^Spend only mana produced by (.+?) to cast ~$/i))) {
    const noun = parseNoun(`a ${singularize(m[1])}`) ?? parseNoun(`a ${m[1]}`);
    if (noun && noun.confident) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castManaSourceRestriction', data: { filter: { ...noun.filter, zone: undefined }, nameIs: '~' } } }];
  }
  // "Lands you control are 2/2 creatures with first strike."
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an)? ?(\d+)\/(\d+) (.*?)creatures?(?: with (.+?))?(?: that (?:is|are) still (?:a |an )?[\w ]+)?$/i))) {
    const a = affectsOf(m[1]);
    const kws = m[5] ? parseKeywordList(m[5]) : [];
    const words = (m[4] ?? '').split(/\s+/).filter(Boolean);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    if (a.ok && kws) {
      const out: AbilitySpec[] = [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: ['Creature'], addSubtypes: subtypes.length ? subtypes : undefined } },
        { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } },
      ];
      if (colors.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: colors } });
      if (kws.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
      return out;
    }
  }
  // "During your turn, you may cast cards exiled with ~ ... Mana of any type can be spent to cast
  // those spells." — as a following sentence or as a trailing clause.
  if ((m = L.match(/^(.+?)(?:\.|,)? (?:and )?[Mm]ana of any (?:colou?r|type) can be spent to (?:cast|play) (?:it|them|that spell|those spells|that card|those cards)$/i))) {
    const ANY_MANA_TAGS = ['playFromTop', 'playExiledWithSource', 'playExiledWithCounter', 'castExiledWithSource', 'castFromGraveyard'];
    const inner = parseStatic(m[1], isCreatureOrPermanent);
    if (inner && inner.length && inner.every((x) => x.kind === 'static' && x.rule?.kind === 'custom' && ANY_MANA_TAGS.includes(x.rule.tag))) {
      return inner.map((x) =>
        x.kind === 'static' && x.rule?.kind === 'custom'
          ? { ...x, rule: { ...x.rule, data: { ...((x.rule.data as Record<string, unknown>) ?? {}), anyMana: true } } }
          : x,
      );
    }
  }
  // "During your turn, you may play cards exiled with ~. If you cast a spell this way, pay life
  // equal to its mana value rather than pay its mana cost."
  if ((m = L.match(/^(.+?)\. If you cast a spell this way, (?:you )?pay life equal to (?:its|that spell's|the spell's) mana value rather than pay(?:ing)? its mana cost$/i))) {
    const inner = parseStatic(m[1], isCreatureOrPermanent);
    if (inner && inner.length && inner.every((x) => x.kind === 'static' && x.rule?.kind === 'custom')) {
      return inner.map((x) =>
        x.kind === 'static' && x.rule?.kind === 'custom'
          ? { ...x, rule: { ...x.rule, data: { ...((x.rule.data as Record<string, unknown>) ?? {}), payLifeEqualToManaValue: true } } }
          : x,
      );
    }
  }
  // "For each non-Human creature you control, you may have that creature assign its combat damage
  // as though it weren't blocked." / "Enchanted creature's controller may have it assign ..."
  if ((m = L.match(/^For each (.+?), you may have that (?:creature|permanent) assign its combat damage as though it (?:weren't|were not|was not) blocked$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun && noun.confident) return [{ kind: 'static', text: line, affects: { ...noun.filter, zone: 'battlefield' }, rule: { kind: 'custom', tag: 'assignAsUnblocked' } }];
  }
  if ((m = L.match(/^(Enchanted|Equipped) (?:creature|permanent)'s controller may have it assign its combat damage as though it (?:weren't|were not|was not) blocked$/i))) {
    return [{ kind: 'static', text: line, affects: 'attachedTo', rule: { kind: 'custom', tag: 'assignAsUnblocked' } }];
  }
  // "Equipped creature has lifelink if you control a Cleric, deathtouch if you control a Rogue,
  // ..." — one static per clause. A clause conditioned on the subject itself ("vigilance if it is
  // white") becomes a filter on the subject instead, so it is judged per affected object.
  if ((m = L.match(/^(.+?) (has|have) ([\w' -]+ if [^,]+(?:, (?:and )?[\w' -]+ if [^,]+)+)$/i))) {
    const clauses = m[3].split(/, (?:and )?/).map((x) => x.trim()).filter(Boolean);
    if (clauses.length >= 2) {
      const outs = clauses.map((cl) => {
        const cm = cl.match(/^([\w' -]+) if (.+)$/i);
        if (!cm) return null;
        return /^it /i.test(cm[2])
          ? parseStatic(`${m![1]} ${cm[2].replace(/^it /i, 'that ')} ${m![2]} ${cm[1]}`, isCreatureOrPermanent)
          : parseStatic(`${m![1]} ${m![2]} ${cm[1]} if ${cm[2]}`, isCreatureOrPermanent);
      });
      if (outs.every((o) => o !== null)) return outs.flat() as AbilitySpec[];
    }
  }
  // "~ attacks each combat if able unless you control a creature named Advocate of the Beast."
  if ((m = L.match(/^(.+?) unless (.+)$/i))) {
    const inner = parseStatic(m[1], isCreatureOrPermanent);
    const c = parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (inner && c && c.kind !== 'manual' && inner.every((x) => x.kind === 'static' && !x.condition))
      return inner.map((x) => (x.kind === 'static' ? { ...x, condition: { kind: 'not' as const, c } } : x));
  }
  // "Enchanted land loses all land types and abilities and has "{T}: Add {C}" and "{T}, Pay 1
  // life: Add one mana of any color.""
  if ((m = L0.replace(/\.$/, '').match(/^(Enchanted \w+|Equipped \w+|~) loses all (?:(\w+) types and )?abilities and has ((?:"[^"]+"(?:,? and )?)+)$/i))) {
    const a = affectsOf(m[1]);
    const quotes = [...m[3].matchAll(/"([^"]+)"/g)].map((q) => q[1]);
    if (a.ok && quotes.length) {
      const out: AbilitySpec[] = [];
      if (m[2]) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, setSubtypes: [] } });
      out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, loseAllAbilities: true, addAbilityText: quotes } });
      return out;
    }
  }
  // "Enchanted permanent is a Treasure artifact with "{T}, Sacrifice ~: Add one mana of any
  // color," and it loses all other abilities."
  if ((m = L0.replace(/\.$/, '').match(/^(Enchanted \w+|Equipped \w+|~) (?:is|are) (?:a|an) ([\w' -]+) with "(.+?),?"(,? and it loses all other abilities)?$/i))) {
    const a = affectsOf(m[1]);
    const probe = parseNoun(`a ${m[2]}`);
    if (a.ok && probe && probe.confident && probe.filter.types?.length) {
      return [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, setTypes: probe.filter.types, setSubtypes: probe.filter.subtypes ?? [] } },
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, loseAllAbilities: m[4] ? true : undefined, addAbilityText: [m[3]] } },
      ];
    }
  }
  // "Enchanted permanent is a colorless Forest land."
  if ((m = L.match(/^(Enchanted \w+|Equipped \w+|~) (?:is|are) (?:a|an) ([\w' -]+)$/i))) {
    const a = affectsOf(m[1]);
    const probe = parseNoun(`a ${m[2]}`);
    if (a.ok && probe && probe.confident && probe.filter.types?.length) {
      const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, setTypes: probe.filter.types, setSubtypes: probe.filter.subtypes ?? [] } }];
      if (probe.filter.colorless) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: [] } });
      return out;
    }
  }
  // ---- Round 155 ----
  // "All creatures are tokens." / "All nonland permanents are legendary." / "Creatures your opponents control have base toughness 1."
  if ((m = L.match(/^(.+?) (?:is|are) tokens?$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'isToken' } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) legendary$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addSupertypes: ['Legendary'] } }];
  }
  if ((m = L.match(/^(.+?) (?:has|have) base (power|toughness) (\d+)$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: /power/i.test(m[2]) ? { layer: '7b', setPower: parseInt(m[3], 10) } : { layer: '7b', setToughness: parseInt(m[3], 10) } }];
  }
  // "Creatures cannot be the targets of spells."
  if ((m = L.match(/^(.+?) cannot be the targets? of (spells|abilities|spells or abilities)$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) {
      const by = /^spells$/i.test(m[2]) ? 'spells' : /^abilities$/i.test(m[2]) ? 'abilities' : undefined;
      return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'cantBeTargeted', by } }];
    }
  }
  // "All Walls able to block ~ do so." / "All creatures with flying able to block ~ do so."
  if ((m = L.match(/^(?:All )?(.+?) able to block ~ do(?:es)? so$/i))) {
    const noun = parseNoun(`all ${m[1].replace(/^(?:all|each) /i, '')}`) ?? parseNoun(m[1]);
    if (noun && noun.confident) return [{ kind: 'static', text: line, affects: { ...noun.filter, zone: 'battlefield' }, rule: { kind: 'custom', tag: 'mustBlockSource' } }];
  }
  // "Creatures played by your opponents enter tapped."
  if ((m = L.match(/^(.+?) (?:played|cast) by your opponents enters? tapped$/i))) {
    const noun = parseNoun(m[1]);
    if (noun && noun.confident) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: { ...noun.filter, zone: undefined, controller: 'opponent' }, tapped: true }];
  }
  // "All morph costs cost {2} more." / "Buyback costs cost {2} less."
  if ((m = L.match(/^(?:All )?([\w-]+) costs cost \{(\d+)\} (less|more)(?: to activate)?$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'keywordCostChange', data: { keyword: m[1].toLowerCase(), amount: parseInt(m[2], 10) * (m[3].toLowerCase() === 'less' ? -1 : 1) } } }];
  }
  // "All damage is dealt as though its source had wither."
  if (/^All damage is dealt as though its source had wither$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'allDamageIsWither' } }];
  // "All lands are no longer snow."
  if ((m = L.match(/^(.+?) (?:is|are) no longer (snow|legendary)$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, removeSupertypes: [m[2].toLowerCase() === 'snow' ? 'Snow' : 'Legendary'] } }];
  }
  // ---- Round 154 ----
  // "You may play lands and cast Insect spells from your graveyard."
  // "Once during each of your turns, you may cast a permanent spell with mana value 2 or less from your graveyard."
  if ((m = L.match(/^Once during each of your turns, you may cast (?:a|an) (.+?) from your graveyard$/i))) {
    const n312 = parseNoun(`a ${m[1]}`);
    if (n312 && n312.confident)
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { ...n312.filter, zone: undefined }, oncePerTurn: true } } }];
  }
  // "Once during each of your turns, you may cast an instant or sorcery spell from your hand without paying its mana cost."
  if ((m = L.match(/^Once during each of your turns, you may cast (?:a|an) (.+?) from your hand without paying its mana cost$/i))) {
    const n312b = parseNoun(`a ${m[1]}`);
    if (n312b && n312b.confident)
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'altCostForSpells', data: { cost: '{0}', oncePerTurn: true, fromZone: 'hand', filter: { ...n312b.filter, zone: undefined } } } }];
  }
  sxr154: {
  if ((m = L.match(/^You may (play lands and cast (.+?) spells|play lands|cast (.+?) spells|play cards|cast spells|play lands and cast spells) from your graveyard(?:, but not from anywhere else)?$/i))) {
    const what = m[1].toLowerCase();
    const spellNoun = m[2] ?? m[3];
    const filter = spellNoun ? parseNoun(`a ${spellNoun} spell`)?.filter : undefined;
    if (spellNoun && !filter) break sxr154;
    const out: AbilitySpec[] = [];
    if (/cast|play cards/.test(what)) out.push({ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: filter ? { ...filter, zone: undefined } : undefined } } });
    if (/play lands|play cards/.test(what)) out.push({ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playLandsFromGraveyard' } });
    if (out.length) return out;
  }
  }
  // "You may play lands and cast spells with mana value 4 or greater from the top of your library."
  sxr154b: {
  if ((m = L.match(/^You may (play (?:(\w+) )?lands and cast|cast) (.+?) from the top of your library$/i))) {
    const label = m[3].trim();
    const landNoun = m[2] ? parseNoun(`a ${m[2]} land`) : null;
    if (m[2] && (!landNoun || !landNoun.confident)) break sxr154b;
    const noun = /^spells$/i.test(label) ? { filter: {} as ObjectFilter, confident: true } : /\bspells?\b/i.test(label) ? parseNoun(`a ${label.replace(/spells\b/i, 'spell')}`) : parseNoun(`a ${label} spell`);
    if (!noun || !noun.confident) break sxr154b;
    const f = { ...noun.filter };
    delete f.zone;
    const lf = landNoun ? { ...landNoun.filter } : null;
    if (lf) delete lf.zone;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playFromTop', data: { lands: /play (?:\w+ )?lands/i.test(m[1]), spells: true, filter: Object.keys(f).length ? f : undefined, landFilter: lf ?? undefined } } }];
  }
  }
  // "You may cast ~ from your graveyard by paying {2}{W} rather than paying its mana cost."
  if ((m = L.match(/^You may cast ~ from your graveyard by (.+?) (in addition to paying its other costs|rather than paying its mana cost)$/i))) {
    const GERUND: Record<string, string> = { paying: 'Pay', discarding: 'Discard', exiling: 'Exile', removing: 'Remove', sacrificing: 'Sacrifice', returning: 'Return', revealing: 'Reveal', tapping: 'Tap', untapping: 'Untap' };
    const costText = m[1]
      .replace(/\b(paying|discarding|exiling|removing|sacrificing|returning|revealing|tapping|untapping)\b/gi, (w) => GERUND[w.toLowerCase()].toLowerCase())
      .replace(/^[a-z]/, (c) => c.toUpperCase());
    const cost = parseCost(m[1].replace(/^paying /i, '')) ?? parseCost(costText);
    if (cost) {
      if (/rather than/i.test(m[2])) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'altCostForSpells', data: { cost: cost.mana ?? '{0}', filter: { nameIs: '~' }, fromZone: 'graveyard' } } }];
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { nameIs: '~' }, extraCost: cost } } }];
    }
  }
  // "You may cast ~ from your graveyard or from exile." / "You may cast ~ from your graveyard."
  if (/^You may cast ~ from your graveyard(?: or from exile)?(?:, but not from anywhere else)?$/i.test(L)) {
    const out: AbilitySpec[] = [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { nameIs: '~' } } } }];
    return out;
  }
  // ---- Round 152 ----
  // "Enchanted permanent is a colorless Clue artifact with \"{2}, Sacrifice ~: Draw a card\" and loses all other abilities."
  if ((m = L.match(/^(.+?) (?:is|are) (.+?) with "(.+?)" and loses? all (?:other )?(?:card types and abilities|abilities|types|card types)$/i))) {
    const a = affectsOf(m[1]);
    const probe = parseNoun(`a ${m[2].replace(/^(?:a|an) /i, '')}`);
    if (a.ok && probe && probe.confident && probe.filter.types?.length) {
      const out: AbilitySpec[] = [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, setTypes: probe.filter.types, setSubtypes: probe.filter.subtypes ?? [] } },
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, loseAllAbilities: true, addAbilityText: [m[3]] } },
      ];
      if (probe.filter.colorless) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: [] } });
      return out;
    }
  }
  // "All lands have \"{T}: Add one mana of any color\" and lose all other abilities."
  if ((m = L.match(/^(.+?) (?:has|have) (".+?") and loses? all (?:other )?abilities$/i))) {
    const a = affectsOf(m[1]);
    const g = parseGrantList(m[2]);
    if (a.ok && g) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, loseAllAbilities: true, addAbilityText: g.abilities, addKeywords: g.keywords.length ? g.keywords : undefined } }];
  }
  // ---- Round 150 ----
  // "Equipped creature gets +5/+5 and has first strike, trample, and \"Whenever ~ deals combat damage ...\""
  if ((m = L.match(/^(.+?) (?:has|have) (.+)$/i)) && /"/.test(m[2])) {
    const a = affectsOf(m[1]);
    const g = parseGrantList(m[2]);
    if (a.ok && g) {
      const out: AbilitySpec[] = [];
      if (g.keywords.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: g.keywords } });
      if (g.abilities.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: g.abilities } });
      return out;
    }
  }
  if ((m = L.match(/^(.+?) gets? ([+-]\d+)\/([+-]\d+),? and (?:has|have) (.+)$/i)) && /"/.test(m[4])) {
    const a = affectsOf(m[1]);
    const g = parseGrantList(m[4]);
    if (a.ok && g) {
      const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } }];
      if (g.keywords.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: g.keywords } });
      if (g.abilities.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: g.abilities } });
      return out;
    }
  }
  // "Treasures you control are Equipment in addition to their other types and have \"Equipped creature gets +2/+0,\" equip {2}."
  if ((m = L.match(/^(.+?) (?:is|are) (.+?) in addition to (?:their|its) other types and (?:has|have) (.+)$/i))) {
    const a = affectsOf(m[1]);
    const probe = parseNoun(`a ${m[2].replace(/^(?:a|an) /i, '')}`);
    const g = parseGrantList(m[3]);
    if (a.ok && probe && probe.confident && g) {
      const mod: Record<string, unknown> = { layer: 4 };
      if (probe.filter.types?.length) mod.addTypes = probe.filter.types;
      if (probe.filter.subtypes?.length) mod.addSubtypes = probe.filter.subtypes;
      const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: mod as never }];
      if (g.keywords.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: g.keywords } });
      if (g.abilities.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: g.abilities } });
      return out;
    }
  }
  // ---- Round 148 ----
  // "During your turn, your opponents cannot cast spells or activate abilities of artifacts, creatures, or enchantments."
  if ((m = L.match(/^During your turn, (your opponents|each opponent|players) cannot cast spells or activate abilities of (.+)$/i))) {
    const noun = parseNoun(`a ${singularize(m[2].replace(/,? or /g, ' or '))}`) ?? parseNoun(`a ${m[2]}`);
    const who = /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      return [
        { kind: 'static', text: line, ruleAffects: who, rule: { kind: 'custom', tag: 'cantCastSpells', data: { sourceTurnOnly: true } } },
        { kind: 'static', text: line, ruleAffects: who, rule: { kind: 'custom', tag: 'cantActivateAbilities', data: { sourceTurnOnly: true, filter: f } } },
      ];
    }
  }
  // "That land is an Island in addition to its other types for as long as it has a flood counter on it."
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) in addition to (?:its|their) other types for as long as it has (?:a|an) ([+\-\w\/]+) counter on it$/i))) {
    const a = affectsOf(m[1].replace(/^that /i, 'enchanted '));
    const probe = parseNoun(`a ${m[2]}`);
    if (a.ok && typeof a.affects === 'object' && probe && probe.confident) {
      const mod: Record<string, unknown> = { layer: 4 };
      if (probe.filter.types?.length) mod.addTypes = probe.filter.types;
      if (probe.filter.subtypes?.length) mod.addSubtypes = probe.filter.subtypes;
      return [{ kind: 'static', text: line, affects: { ...a.affects, hasCounter: m[3] }, modification: mod as never }];
    }
  }
  // ---- Round 144 ----
  // "As ~ enters or is turned face up, ..." — same as an enters replacement.
  if ((m = L.match(/^As ~ enters or is turned face up, (.+)$/i))) {
    const inner = parseStatic(`As ~ enters, ${m[1]}`, isCreatureOrPermanent);
    if (inner) return inner;
  }
  // "As ~ enters, choose Elemental, Elf, Faerie, Giant, Goblin, Kithkin, Merfolk, or Treefolk."
  if ((m = L.match(/^As ~ enters, choose ([A-Z][\w-]+(?:, [A-Z][\w-]+)+,? or [A-Z][\w-]+)$/))) {
    const opts = m[1].split(/,? or |, /).map((w) => w.trim()).filter(Boolean);
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: 'option', chooseOptions: opts, chooseKey: 'creatureType' }];
  }
  // "As ~ enters, choose a card type other than creature or land."
  if ((m = L.match(/^As ~ enters, choose a card type other than (.+)$/i))) {
    const excluded = m[1].toLowerCase().split(/,? or |, /).map((w) => w.trim());
    const all = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Battle'];
    const opts = all.filter((t) => !excluded.includes(t.toLowerCase()));
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: 'option', chooseOptions: opts, chooseKey: 'cardType' }];
  }
  // "Players can't play lands as long as ten or more lands are on the battlefield."
  if ((m = L.match(/^Players cannot play lands as long as (.+)$/i))) {
    const cond = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') return [{ kind: 'static', text: line, rule: { kind: 'custom', tag: 'cantPlayLands' }, ruleAffects: 'allPlayers', condition: cond }];
  }
  // "If you would draw a card, you may skip that draw instead."
  if (/^If you would draw a card, you may skip that draw instead$/i.test(L)) {
    return [{ kind: 'replacement', text: line, event: 'drawCard', who: 'you', skip: true }];
  }
  // "Enchanted creature gets +2/+2 and can't become suspected."
  if ((m = L.match(/^(Enchanted|Equipped) creature gets ([+-]\d+)\/([+-]\d+) and cannot become suspected$/i))) {
    return [
      { kind: 'static', text: line, affects: 'attachedTo', modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } },
      { kind: 'static', text: line, affects: 'attachedTo', rule: { kind: 'custom', tag: 'cantBecomeSuspected' } },
    ];
  }
  // "If ~ would die, put it on top/bottom of its owner's library instead."

  if ((m = L.match(/^If ~ would (?:die|be put into a graveyard from anywhere), (?:instead )?put it on (?:the )?(top|bottom) of its owner's library(?: instead)?$/i))) {
    return [{ kind: 'replacement', text: line, event: 'dies', self: true, instead: m[1].toLowerCase() === 'top' ? 'libraryTop' : 'libraryBottom' }];
  }
  // "As ~ enters, choose a noncreature, nonland card name."

  if (/^As ~ enters, choose (?:a|an) (?:noncreature, nonland |nonland |noncreature |creature )?card name$/i.test(L)) {
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: 'cardName', chooseKey: 'cardName' }];
  }
  // "As ~ enters, an opponent chooses a creature type."
  if ((m = L.match(/^As ~ enters, an opponent chooses (a creature type|a color|a card name)$/i))) {
    const key = /creature type/i.test(m[1]) ? 'creatureType' : /color/i.test(m[1]) ? 'color' : 'cardName';
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: key === 'creatureType' ? 'creatureType' : key === 'color' ? 'color' : 'cardName', chooseKey: key, chooseByOpponent: true }];
  }
  // "As ~ enters, choose 2, 3, or 4 at random."
  if ((m = L.match(/^As ~ enters, choose ((?:\d+, )+(?:or )?\d+) at random$/i))) {
    const opts = m[1].split(/,? or |, /).map((w) => w.trim()).filter(Boolean);
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: 'option', chooseOptions: opts, chooseKey: 'choice', chooseAtRandom: true }];
  }
  // "As ~ enters, it becomes your choice of a 3/3 creature, a 2/2 creature with flying, or a 1/6 creature with defender."
  if ((m = L.match(/^As ~ enters, (?:it|~) becomes your choice of (.+)$/i))) {
    const parts = m[1].split(/,? or |, /).map((x) => x.trim().replace(/^(?:a|an) /i, '')).filter(Boolean);
    const opts: string[] = [];
    const effects: Effect[] = [];
    let ok = parts.length > 1;
    for (const part of parts) {
      const pm = part.match(/^(\d+)\/(\d+)(?: ([\w ]*?))?(?: creature)?(?: with (.+))?$/i);
      if (!pm) { ok = false; break; }
      const kws = pm[4] ? parseKeywordList(pm[4]) : [];
      if (!kws) { ok = false; break; }
      const label = part;
      opts.push(label);
      const then: Effect[] = [{ kind: 'setPT', power: parseInt(pm[1], 10), toughness: parseInt(pm[2], 10), on: { ref: 'self' } }];
      const subtypes = (pm[3] ?? '').split(/\s+/).filter((w) => /^[A-Z][a-z]/.test(w));
      if (subtypes.length) then.push({ kind: 'addTypes', types: [], subtypes, on: { ref: 'self' } });
      if (kws.length) then.push({ kind: 'grantKeywords', keywords: kws, on: { ref: 'self' } });
      effects.push({ kind: 'conditional', if: { kind: 'chosenIs', key: 'ptChoice', value: label }, then });
    }
    if (ok) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: 'option', chooseOptions: opts, chooseKey: 'ptChoice', effects }];
  }
  // ---- Round 142 ----
  // "If a land is tapped for mana, it produces {B} instead of any other type."
  if ((m = L.match(/^If (?:a|an|target) (.+?) (?:is|are) tapped for mana, (?:it|they) produces? ((?:\{[^}]+\})+|colorless mana|one mana of (?:any color|a colou?r of your choice)) instead of any other type(?: and amount)?(?: of mana)?(?: instead)?$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    const produce = /colorless/i.test(m[2]) ? ['C'] : /any color|of your choice/i.test(m[2]) ? 'anyOneColor' : (m[2].match(/\{([^}]+)\}/g) ?? []).map((t) => t.slice(1, -1));
    if (noun && noun.confident && (produce === 'anyOneColor' || produce.every((c) => /^[WUBRGC]$/.test(c)))) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'manaTypeReplace', data: { filter: f, produce, fixedAmount: / and amount/i.test(L) ? 1 : undefined } } }];
    }
  }
  // "If target Plains is tapped for mana, it produces colorless mana instead of white mana."
  if ((m = L.match(/^If (?:a|an|target) (.+?) (?:is|are) tapped for mana, (?:it|they) produces? (colorless mana|(?:\{[^}]+\})+) instead of \w+ mana$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    const produce = /colorless/i.test(m[2]) ? ['C'] : (m[2].match(/\{([^}]+)\}/g) ?? []).map((t) => t.slice(1, -1));
    if (noun && noun.confident && produce.every((c) => /^[WUBRGC]$/.test(c))) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'manaTypeReplace', data: { filter: f, produce } } }];
    }
  }
  // "If tapped for mana, Plains produce {R}, Islands produce {G}, Swamps produce {W}, ..."
  if ((m = L.match(/^If tapped for mana, (.+)$/i))) {
    const parts = m[1].split(/,\s*(?:and\s+)?/).map((x) => x.trim().replace(/\.$/, '')).filter(Boolean);
    const out: AbilitySpec[] = [];
    let ok = parts.length > 1;
    for (const part of parts) {
      const pm = part.match(/^(.+?) produces? ((?:\{[^}]+\})+|colorless mana)$/i);
      if (!pm) { ok = false; break; }
      const noun = parseNoun(`a ${singularize(pm[1])}`) ?? parseNoun(`a ${pm[1]}`);
      const produce = /colorless/i.test(pm[2]) ? ['C'] : (pm[2].match(/\{([^}]+)\}/g) ?? []).map((t) => t.slice(1, -1));
      if (!noun || !noun.confident || !produce.every((c) => /^[WUBRGC]$/.test(c))) { ok = false; break; }
      const f = { ...noun.filter };
      delete f.zone;
      out.push({ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'manaTypeReplace', data: { filter: f, produce } } });
    }
    if (ok) return out;
  }
  // ---- Round 140 ----
  // "Skeletons you control and other Zombies you control get +1/+1 and have deathtouch."
  if ((m = L.match(/^(.+?(?: you control|s)) and ((?:other |another )?.+?(?: you control)?) ((?:get|gets|have|has) .+)$/i)) && !/ and /i.test(m[1])) {
    const a = affectsOf(m[1].trim());
    const b = affectsOf(m[2].trim());
    if (a.ok && b.ok) {
      const left = parseStatic(`${m[1].trim()} ${m[3]}`, isCreatureOrPermanent);
      const right = parseStatic(`${m[2].trim()} ${m[3]}`, isCreatureOrPermanent);
      if (left && right) return [...left, ...right];
    }
  }
  // "Spells you cast with mana value 6 or greater have cascade." / "Spells you cast have ripple 4."
  if ((m = L.match(/^(.+?) you cast(?: (with [^,]+?|that [^,]+?|from your hand))? have ([\w-]+(?: \d+| \{[^}]+\}|—.+)?)$/i))) {
    const kws = parseKeywordList(m[3]);
    const qual = m[2] && !/^from your hand$/i.test(m[2]) ? ` ${m[2]}` : '';
    const label = m[1].trim();
    const noun = /^spells?$/i.test(label) && !qual ? { filter: {} as ObjectFilter, confident: true } : /\bspells?\b/i.test(label) ? parseNoun(`a ${label.replace(/spells\b/i, 'spell')}${qual}`) : parseNoun(`a ${label} spell${qual}`);
    if (kws && noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      if (/ from your hand /i.test(` ${L} `)) f.castFromZone = 'hand';
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'spellsHaveKeywords', data: { keywords: kws.map((k) => k.replace(/^\w/, (c) => c.toUpperCase())), filter: Object.keys(f).length ? f : undefined } } }];
    }
  }
  // "Spells you cast that target a creature cost {2} less to cast."
  if ((m = L.match(/^Spells you cast that target (.+?) costs? \{(\d+)\} (less|more) to cast$/i))) {
    const noun = parseNoun(m[1]);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter: { spellTargets: f } } }];
    }
  }
  // "Spells your opponents cast during your turn cost {1} more to cast."
  if ((m = L.match(/^Spells (your opponents|you|each player) casts? during your turn costs? \{(\d+)\} (less|more) to cast$/i))) {
    const who = /^you$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10) }, condition: { kind: 'yourTurn' } }];
  }
  // "Spells with the chosen name cost {3} more to cast."
  if ((m = L.match(/^Spells with the chosen name costs? \{(\d+)\} (less|more) to cast$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: m[2].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[1], 10), filter: { nameIsChosen: 'cardName' } } }];
  }
  // "Spells you cast but do not own cost {1} less to cast."
  if ((m = L.match(/^Spells you cast but (?:do not|don't) own costs? \{(\d+)\} (less|more) to cast$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[2].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[1], 10), filter: { owner: 'opponent' } } }];
  }
  // "Tapped creatures you control can block as though they were untapped."
  if ((m = L.match(/^(.+?) can block as though (?:they were|it were) untapped$/i))) { const _r140 = objRule(m[1], { kind: 'custom', tag: 'blockWhileTapped' }); if (_r140) return _r140; }
  // "Stun counters cannot be removed from permanents your opponents control."
  if ((m = L.match(/^([+\-\w\/]+) counters cannot be removed from (.+)$/i))) { const _r140b = objRule(m[2], { kind: 'custom', tag: 'countersCantBeRemoved', data: m[1] }); if (_r140b) return _r140b; }
  // ---- Round 139 ----
  // "Once each turn, you may cast an instant or sorcery spell from the top of your library."
  if ((m = L.match(/^Once (?:each turn|during each of your turns), you may cast (.+?) (?:spells? )?from the top of your library(?: if (.+))?$/i)) && !m[2]) {
    const raw = m[1].trim();
    const noun = /\bspells?\b/i.test(raw) ? parseNoun(raw.replace(/^(?:a|an) /i, 'a ')) ?? parseNoun(`a ${raw}`) : parseNoun(`a ${raw.replace(/^(?:a|an) /i, '')} spell`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playFromTop', data: { spells: true, oncePerTurn: true, filter: f } } }];
    }
  }
  // "Once each turn, you may pay {0} rather than pay the mana cost for a spell you cast from exile."
  if ((m = L.match(/^(Once (?:each turn|during each of your turns), )?you may pay ((?:\{[^}]+\})+) rather than pay the mana cost for (?:a |an )?(.+?) you cast(?: from (your hand|exile|your graveyard))?(?: with mana value (?:X or less|(\d+) or less))?$/i))) {
    const label = m[3].trim();
    const noun = /^spells?$/i.test(label) ? { filter: {} as ObjectFilter, confident: true } : /\bspells?\b/i.test(label) ? parseNoun(`a ${label}`) : parseNoun(`a ${label} spell`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      if (m[5]) f.cmcLE = parseInt(m[5], 10);
      else if (/mana value X or less/i.test(L)) f.cmcLE = 'X';
      const zone = m[4] ? (/exile/i.test(m[4]) ? 'exile' : /graveyard/i.test(m[4]) ? 'graveyard' : 'hand') : undefined;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'altCostForSpells', data: { cost: m[2], filter: Object.keys(f).length ? f : undefined, oncePerTurn: !!m[1] || undefined, fromZone: zone } } }];
    }
  }
  // ---- Round 138 ----
  // "If you tap a permanent for mana, it produces twice as much of that mana instead."
  if ((m = L.match(/^If you tap (?:a|an) (.+?) for mana, it produces (twice|three times|four times) as much of that mana instead$/i))) {
    const times = /twice/i.test(m[2]) ? 2 : /three/i.test(m[2]) ? 3 : 4;
    const bare = /^permanent$/i.test(m[1].trim());
    const noun = bare ? null : parseNoun(`a ${m[1]}`);
    if (bare || (noun && noun.confident)) {
      const f = noun ? { ...noun.filter } : undefined;
      if (f) delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'manaMultiplier', data: { times, filter: f } } }];
    }
  }
  // "If you would roll one or more dice, instead roll that many dice plus one and ignore the lowest roll."
  if ((m = L.match(/^If you would roll one or more (?:planar )?dice, instead roll that many (?:planar )?dice plus (\w+) and ignore (?:the (lowest|highest) rolls?|one)$/i))) {
    const plus = wordToNumber(m[1]);
    if (typeof plus === 'number') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'extraDice', data: { plus, ignore: m[2]?.toLowerCase() === 'highest' ? 'highest' : 'lowest' } } }];
  }
  // "If you would scry a number of cards, draw that many cards instead."
  if ((m = L.match(/^If you would scry a number of cards, (draw that many cards|scry that many cards plus (\w+)) instead$/i))) {
    if (/^draw/i.test(m[1])) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'scryReplace', data: { toDraw: true } } }];
    const plus = m[2] ? wordToNumber(m[2]) : null;
    if (typeof plus === 'number') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'scryReplace', data: { plus } } }];
  }
  // "If you would get one or more {E}, you get twice that many {E} instead."
  if ((m = L.match(/^If you would get one or more \{E\}, you get (twice|three times) that many \{E\} instead$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'energyMultiplier', data: /twice/i.test(m[1]) ? 2 : 3 }, }];
  }
  // "If an opponent would create one or more tokens, they create half that many of each of those kinds of tokens instead, rounded down."
  if ((m = L.match(/^If (you|an opponent|a player) would create one or more tokens, (?:they|you) create (half that many|twice that many|that many plus (\w+))(?: of (?:those|each of those kinds of) tokens)? instead(?:, rounded (up|down))?$/i))) {
    const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    const how = m[2].toLowerCase();
    const plus = m[3] ? wordToNumber(m[3]) : 0;
    if (typeof plus === 'number') {
      return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: /twice/.test(how) ? 1 : plus, half: /half/.test(how) ? (m[4]?.toLowerCase() === 'up' ? 'up' : 'down') : undefined, who }];
    }
  }
  // "If you would lose the game, instead exile ~ and your life total becomes 1."
  if ((m = L.match(/^If you would lose the game, instead (.+)$/i))) {
    const pe = parseEffects(m[1], newCtx({ isSpell: false }));
    if (!pe.unhandled.length && pe.effects.length) return [{ kind: 'replacement', text: line, event: 'wouldLoseGame', instead: pe.effects }];
  }
  // ---- Round 137 ----
  // "If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up."
  if ((m = L.match(/^If (.+?) would deal (combat |noncombat )?damage to (.+?)(?: this turn)?, prevent half that damage,? rounded (up|down)$/i))) {
    const srcSpec = damageSourceFilter(m[1]);
    const dest = damageDestFilter(m[3]);
    if (srcSpec && dest) {
      const data: Record<string, unknown> = { ...srcSpec, ...dest, half: m[4].toLowerCase() === 'up' ? 'down' : 'up' };
      delete data.host;
      if (m[2] && /^combat/i.test(m[2])) data.combatOnly = true;
      if (m[2] && /^noncombat/i.test(m[2])) data.noncombatOnly = true;
      const host = srcSpec.selfOnly ? (/^~$/.test(m[1].trim()) ? 'self' : 'attachedTo') : dest.host ?? 'self';
      return [{ kind: 'static', text: line, affects: host, rule: { kind: 'custom', tag: 'damageModify', data } }];
    }
  }
  // "Prevent all damage that ~ would deal to red creatures."
  if ((m = L.match(/^Prevent all (combat |noncombat )?damage that (.+?) would deal to (.+)$/i))) {
    const src = damageSourceFilter(m[2]);
    const dst = damageDestFilter(m[3]);
    if (src && dst && !dst.host) {
      const data: Record<string, unknown> = { to: dst.toFilter, toPlayers: dst.toPlayers, toObjects: dst.toObjects, toController: dst.toController };
      if (m[1] && /^combat/i.test(m[1])) data.combatOnly = true;
      if (m[1] && /^noncombat/i.test(m[1])) data.noncombatOnly = true;
      const host = src.selfOnly ? (/^~$/.test(m[2].trim()) ? 'self' : 'attachedTo') : null;
      if (host) return [{ kind: 'static', text: line, affects: host, rule: { kind: 'custom', tag: 'dealsNoDamageTo', data } }];
    }
  }
  // ---- Round 136 ----
  // "If damage would be dealt to ~, put that many -1/-1 counters on it instead."
  if ((m = L.match(/^If (combat |noncombat )?damage would be dealt to (~|you)(?: this turn)?, (?:prevent that damage and (.+)|put that many ([+\-\w\/]+) counters on (?:it|~) instead|prevent that damage)$/i))) {
    const to = m[2] === '~' ? 'self' : 'controller';
    const tail = m[3] ? m[3] : m[4] ? `put that many ${m[4]} counters on ${to === 'self' ? '~' : '~'}` : null;
    let effects: Effect[] | undefined;
    let tailOk = true;
    if (tail) {
      const pe = parseEffects(tail.replace(/ instead$/i, ''), newCtx({ triggerHasObject: true, triggerHasPlayer: true }));
      if (pe.unhandled.length) tailOk = false;
      else effects = pe.effects;
    }
    if (tailOk) {
      const spec: AbilitySpec = { kind: 'replacement', text: line, event: 'damage', prevent: 'all', to, combatOnly: m[1] && /^combat/i.test(m[1]) ? true : undefined };
      if (effects?.length) (spec as { effects?: Effect[] }).effects = effects;
      return [spec];
    }
  }
  // "If a creature would deal combat damage to ~, prevent that damage and put a +1/+1 counter on ~."
  if ((m = L.match(/^If (.+?) would deal (combat |noncombat )?damage to (~|you|equipped creature|enchanted creature|.+?)(?: this turn)?, prevent (that damage|all of that damage|(\d+) of that damage)(?: and (.+))?$/i))) {
    const srcSpec = damageSourceFilter(m[1]);
    const dst = m[3].trim();
    const to: 'self' | 'controller' | ObjectFilter | null =
      dst === '~' || /^(?:equipped|enchanted) \w+$/i.test(dst) ? 'self' : /^you$/i.test(dst) ? 'controller' : (() => {
        const n = parseNoun(dst);
        if (!n || !n.confident || n.kind === 'player') return null;
        const f = { ...n.filter };
        delete f.zone;
        return f;
      })();
    let effects: Effect[] | undefined;
    let tailOk2 = true;
    if (m[6]) {
      const pe = parseEffects(m[6], newCtx({ triggerHasObject: true, triggerHasPlayer: true }));
      if (pe.unhandled.length) tailOk2 = false;
      else effects = pe.effects;
    }
    if (tailOk2 && srcSpec && to !== null && !srcSpec.selfOnly) {
      const spec: AbilitySpec = { kind: 'replacement', text: line, event: 'damage', prevent: m[5] ? parseInt(m[5], 10) : 'all', to, fromFilter: srcSpec.filter, combatOnly: m[2] && /^combat/i.test(m[2]) ? true : undefined };
      if (effects?.length) (spec as { effects?: Effect[] }).effects = effects;
      return [spec];
    }
  }
  // "If an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead."
  if ((m = L.match(/^If (?:an effect|you|a player|an opponent|another player) would put one or more (?:([+\-\w\/]+) )?counters on (.+?), (?:it puts|they put|put) (twice that many|half that many|that many plus (?:one|two|three)|that many minus one)(?: of (?:those|each of those kinds of)? ?counters)?(?: on (?:that \w+|it|them|that permanent or player))?(?: instead)?(?:, rounded (up|down))?$/i))) {
    const noun = /^(?:a permanent or player|a permanent)$/i.test(m[2].trim()) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(m[2]);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      const how = m[3].toLowerCase();
      const spec: AbilitySpec = {
        kind: 'replacement',
        text: line,
        event: 'counterAdded',
        extra: /plus one/.test(how) ? 1 : /plus two/.test(how) ? 2 : /plus three/.test(how) ? 3 : 0,
        multiply: /twice/.test(how) ? 2 : undefined,
        half: /half/.test(how) ? (m[4]?.toLowerCase() === 'up' ? 'up' : 'down') : undefined,
        minus: /minus one/.test(how) ? 1 : undefined,
        filter: Object.keys(f).length ? { ...f, zone: 'battlefield' } : undefined,
        counterType: m[1],
        who: /^If an opponent /i.test(L) ? 'opponent' : /^If (?:an effect|a player|another player) /i.test(L) ? 'any' : 'you',
      };
      return [spec];
    }
  }
  // "If one or more +1/+1 counters would be put on ~, that many plus one +1/+1 counters are put on it instead."
  if ((m = L.match(/^If one or more (?:([+\-\w\/]+) )?counters would be put on (.+?), (twice that many|half that many|that many plus (?:one|two|three)|that many minus one|(?:three times|twice) that many)(?: of (?:those|each of those kinds of)? ?counters)?(?: ?[+\-\w\/]+)? counters are put on (?:it|that \w+|them|that permanent or player) instead(?:, rounded (up|down))?$/i))) {
    const who = m[2].trim();
    const noun = /^~$/.test(who) ? { filter: { self: true } as ObjectFilter, confident: true } : /^(?:a permanent or player|a permanent)$/i.test(who) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(who);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      const how = m[3].toLowerCase();
      return [{
        kind: 'replacement',
        text: line,
        event: 'counterAdded',
        extra: /plus one/.test(how) ? 1 : /plus two/.test(how) ? 2 : /plus three/.test(how) ? 3 : 0,
        multiply: /three times/.test(how) ? 3 : /twice/.test(how) ? 2 : undefined,
        half: /half/.test(how) ? (m[4]?.toLowerCase() === 'up' ? 'up' : 'down') : undefined,
        minus: /minus one/.test(how) ? 1 : undefined,
        filter: Object.keys(f).length ? { ...f, zone: f.self ? undefined : 'battlefield' } : undefined,
        counterType: m[1],
        who: 'any',
      }];
    }
  }
  // "If an opponent would mill one or more cards, they mill twice that many cards instead."
  if ((m = L.match(/^If (you|an opponent|a player|each opponent) would mill one or more cards, (?:they|you) mill (twice that many|half that many|that many cards plus (\w+))(?: cards)?(?: instead)?(?:, rounded (up|down))?$/i))) {
    const how = m[2].toLowerCase();
    const add = m[3] ? wordToNumber(m[3]) : 0;
    if (typeof add === 'number') {
      const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
      return [{ kind: 'replacement', text: line, event: 'mill', who, multiply: /twice/.test(how) ? 2 : /half/.test(how) ? 0.5 : undefined, add: add || undefined }];
    }
  }
  // "If one or more -1/-1 counters would be put on a creature you control, that many -1/-1 counters minus one are put on that creature instead."
  if ((m = L.match(/^If one or more ([+\-\w\/]+) counters would be put on (.+?), that many (?:([+\-\w\/]+) counters )?(plus|minus) (one|two|three)(?: [+\-\w\/]+ counters)? are put on (?:it|that \w+|them) instead$/i))) {
    const who = m[2].trim();
    const noun = /^~$/.test(who) ? { filter: { self: true } as ObjectFilter, confident: true } : parseNoun(who);
    const n = wordToNumber(m[5]);
    if (noun && noun.confident && typeof n === 'number') {
      const f = { ...noun.filter };
      delete f.zone;
      return [{
        kind: 'replacement',
        text: line,
        event: 'counterAdded',
        extra: m[4].toLowerCase() === 'plus' ? n : 0,
        minus: m[4].toLowerCase() === 'minus' ? n : undefined,
        counterType: m[1],
        filter: Object.keys(f).length ? { ...f, zone: f.self ? undefined : 'battlefield' } : undefined,
        who: 'any',
      }];
    }
  }
  // "If one or more creature tokens would be created under your control, that many 4/4 white Angel creature tokens are created instead."
  if ((m = L.match(/^If one or more (creature |artifact )?tokens would be created under your control, (?:that many|(twice|three times) that many) (.+?) tokens are created instead$/i))) {
    const tok = parseTokenPhrase(`a ${m[3]} token`);
    if (tok) return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: /three times/i.test(m[2] ?? '') ? 2 : /twice/i.test(m[2] ?? '') ? 1 : 0, replaceToken: tok.token, creatureOnly: /creature/i.test(m[1] ?? '') || undefined }];
  }
  // "If a player would draw a card, that player skips that draw instead."
  if ((m = L.match(/^If (you|an opponent|a player) would draw a card, (?:that player|you|they) skips? that draw instead$/i))) {
    const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    return [{ kind: 'replacement', text: line, event: 'drawCard', who, skip: true }];
  }
  // "If a player would gain life, that player gains no life instead."
  if ((m = L.match(/^If (you|an opponent|a player|a spell or ability) would (?:gain life|cause its controller to gain life), (?:that player|you|they) (gains? no life|loses? that much life|gains? twice that much life|gains? that much life plus (\w+))(?: instead)?$/i))) {
    const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    const how = m[2].toLowerCase();
    if (/no life/.test(how)) return [{ kind: 'replacement', text: line, event: 'lifeGain', who, multiply: 0 }];
    if (/loses/.test(how)) return [{ kind: 'replacement', text: line, event: 'lifeGain', who, insteadLose: true }];
    if (/twice/.test(how)) return [{ kind: 'replacement', text: line, event: 'lifeGain', who, multiply: 2 }];
    const add = m[3] ? wordToNumber(m[3]) : null;
    if (typeof add === 'number') return [{ kind: 'replacement', text: line, event: 'lifeGain', who, add }];
  }
  // "If an opponent would lose life during your turn, they lose twice that much life instead."
  if ((m = L.match(/^If (you|an opponent|a player) would lose life(?: during your turn)?, (?:they|you) lose (twice|half) that much life instead$/i))) {
    const who = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    return [{ kind: 'replacement', text: line, event: 'lifeLoss', who, multiply: /twice/i.test(m[2]) ? 2 : 0.5, yourTurnOnly: / during your turn,/i.test(L) || undefined }];
  }
  // "If a source would deal damage to another Dinosaur you control, prevent all but 1 of that damage."
  if ((m = L.match(/^If (.+?) would deal (combat |noncombat )?damage to (.+?)(?: this turn)?, prevent all but (\d+) of that damage$/i))) {
    const srcSpec = damageSourceFilter(m[1]);
    const dest = damageDestFilter(m[3]);
    if (srcSpec && dest) {
      const data: Record<string, unknown> = { ...srcSpec, ...dest, setTo: parseInt(m[4], 10) };
      if (m[2] && /^combat/i.test(m[2])) data.combatOnly = true;
      if (m[2] && /^noncombat/i.test(m[2])) data.noncombatOnly = true;
      delete data.host;
      const host = srcSpec.selfOnly ? (/^~$/.test(m[1].trim()) ? 'self' : 'attachedTo') : dest.host ?? 'self';
      return [{ kind: 'static', text: line, affects: host, rule: { kind: 'custom', tag: 'damageModify', data } }];
    }
  }
  // "If a source you control would deal damage to an opponent, it deals double that damage instead."
  if ((m = L.match(/^If (.+?) would deal (?:(\d+) or more )?(combat |noncombat )?damage(?: this turn)?(?: to (.+?))?(?: this turn)?, (?:instead )?(?:it|that source|that spell|that creature|that permanent|that card|~) deals (.+)$/i))) {
    const srcSpec = damageSourceFilter(m[1]);
    const dest = m[4] ? damageDestFilter(m[4]) : {};
    const mod = damageModifier(m[5]);
    if (srcSpec && dest && mod) {
      const data: Record<string, unknown> = { ...srcSpec, ...dest, ...mod };
      if (m[2]) data.ifAtLeast = parseInt(m[2], 10);
      if (m[3] && /combat/i.test(m[3]) && !/noncombat/i.test(m[3])) data.combatOnly = true;
      if (m[3] && /noncombat/i.test(m[3])) data.noncombatOnly = true;
      delete data.host;
      const host = srcSpec.selfOnly ? (/^~$/.test(m[1].trim()) ? 'self' : 'attachedTo') : dest.host ?? 'self';
      return [{ kind: 'static', text: line, affects: host, rule: { kind: 'custom', tag: 'damageModify', data } }];
    }
  }
  // ---- Round 135 ----
  // "Each untapped creature you control gets +0/+2 as long as it is not attacking."
  if ((m = L.match(/^(.+?) ((?:gets?|get|has|have) .+) as long as (?:it is|they are|it's) (not |isn't |aren't )?(attacking|blocking|tapped|untapped|enchanted|equipped)$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok && typeof a.affects === 'object') {
      const neg = !!m[3];
      const state = m[4].toLowerCase();
      const extra: ObjectFilter = {};
      if (state === 'attacking') { if (neg) extra.notAttacking = true; else extra.attacking = true; }
      else if (state === 'blocking') { if (neg) extra.notBlocking = true; else extra.blocking = true; }
      else if (state === 'tapped') { if (neg) extra.untapped = true; else extra.tapped = true; }
      else if (state === 'untapped') { if (neg) extra.tapped = true; else extra.untapped = true; }
      else if (state === 'enchanted' && !neg) extra.hasAttachment = 'Aura';
      else if (state === 'equipped' && !neg) extra.hasAttachment = 'Equipment';
      if (Object.keys(extra).length) {
        const inner = parseStatic(`${m[1]} ${m[2]}`, isCreatureOrPermanent);
        if (inner && inner.every((ab) => ab.kind === 'static')) {
          return inner.map((ab) => (ab.kind === 'static' && typeof ab.affects === 'object' ? { ...ab, affects: { ...ab.affects, ...extra } } : ab));
        }
      }
    }
  }
  // "For every seven Foods you control, Squirrels you control get +3/+3."
  if ((m = L.match(/^For every (\w+) (.+?), (.+?) gets? \+(\d+)\/\+(\d+)$/i))) {
    const per = wordToNumber(m[1]);
    const cnt = parseNoun(`a ${m[2].replace(/^(\w+?)s\b/, '$1')}`) ?? parseNoun(`a ${m[2]}`);
    const a = affectsOf(m[3]);
    if (typeof per === 'number' && per > 0 && cnt && cnt.confident && a.ok) {
      const cf = { ...cnt.filter };
      if (!cf.zone) cf.zone = 'battlefield';
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[4], 10), toughness: parseInt(m[5], 10), perAmount: { kind: 'divide', a: { kind: 'count', filter: cf }, by: per, round: 'down' } } }];
    }
  }
  // "Each creature spell you cast costs {1} less to cast if it has mutate."
  if ((m = L.match(/^Each (.+?) spells? you cast costs? \{(\d+)\} (less|more) to cast if it has (\w+)$/i))) {
    const noun = parseNoun(`a ${m[1]} spell`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      f.keywords = [m[4].charAt(0).toUpperCase() + m[4].slice(1).toLowerCase()];
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter: f } }];
    }
  }
  // "Each spell you cast that is exactly three colors has replicate {3}."
  if ((m = L.match(/^Each (.+?) you cast that (?:is|are) exactly (two|three|four|five) colors has ([\w-]+(?: \{[^}]+\})?)$/i))) {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (noun && typeof n === 'number') {
      const f = { ...noun.filter };
      delete f.zone;
      f.colorCount = n;
      const kw = m[3].replace(/^\w/, (c) => c.toUpperCase());
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'spellsHaveKeywords', data: { keywords: [kw], filter: f } } }];
    }
  }
  // "If ~ attacks, all creatures you control attack if able."
  if ((m = L.match(/^If ~ attacks, (.+?) attacks? if able$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'mustAttack' }, condition: { kind: 'count', filter: { self: true, attacking: true, zone: 'battlefield' }, op: '>=', value: 1 } }];
  }
  // ---- Round 134 ----
  // "Enchanted creature cannot attack, block, or crew Vehicles."
  if ((m = L.match(/^(.+?) cannot ((?:attack|block|be blocked|crew(?: Vehicles)?|transform|become suspected|be regenerated|untap|be enchanted|be equipped)(?:, |,? (?:or|and) ).+)$/i))) {
    const CANT: Record<string, RuleModification> = {
      attack: { kind: 'cantAttack' },
      block: { kind: 'cantBlock' },
      'be blocked': { kind: 'cantBeBlocked' },
      'crew vehicles': { kind: 'custom', tag: 'cantCrew' },
      crew: { kind: 'custom', tag: 'cantCrew' },
      transform: { kind: 'custom', tag: 'cantTransform' },
      'become suspected': { kind: 'custom', tag: 'cantBecomeSuspected' },
      'be regenerated': { kind: 'custom', tag: 'cantBeRegenerated' },
      untap: { kind: 'cantUntap' },
      'be enchanted': { kind: 'custom', tag: 'cantBeEnchanted' },
      'be equipped': { kind: 'custom', tag: 'cantBeEquipped' },
    };
    const parts = m[2].split(/,? (?:or|and) |, /i).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const rules = parts.map((x) => CANT[x]);
    const a = affectsOf(m[1]);
    if (a.ok && parts.length > 1 && rules.every((r) => !!r)) return rules.map((rule) => ({ kind: 'static' as const, text: line, affects: a.affects, rule }));
  }
  // "Each nonland permanent you control is all colors."
  if ((m = L.match(/^(.+?) (?:is|are) all colors$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: ['W', 'U', 'B', 'R', 'G'] } }];
  }
  // "Enchanted creature gets +2/+2 and cannot become suspected." — a pump plus a rule on the same subject.
  if ((m = L.match(/^(.+?) ((?:gets?|get) [+-][\dX]+\/[+-][\dX]+|(?:has|have) [\w ]+?) and (cannot .+)$/i))) {
    const left = parseStatic(`${m[1]} ${m[2]}`, isCreatureOrPermanent);
    const right = parseStatic(`${m[1]} ${m[3]}`, isCreatureOrPermanent);
    if (left && right) return [...left, ...right];
  }
  // "Enchanted creature gets -1/-1, and its activated abilities cannot be activated."
  if ((m = L.match(/^(.+?), and (?:its|their) activated abilities cannot be activated$/i))) {
    const subj = m[1].match(/^(.+?) (?:gets?|has|have|is|are|cannot)\b/i);
    const left = parseStatic(m[1], isCreatureOrPermanent);
    const a = subj ? affectsOf(subj[1]) : { affects: undefined, ok: false };
    if (left && a.ok) return [...left, { kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'cantActivate' } }];
  }
  // "Each spell you cast that is red or green costs {1} less to cast."
  if ((m = L.match(/^Each spell you cast that (?:is|are) ((?:white|blue|black|red|green)(?:(?:,? or | and\/or )(?:white|blue|black|red|green))*) costs? \{(\d+)\} (less|more) to cast$/i))) {
    const cols = m[1].split(/,? or | and\/or /i).map((c) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[c.trim().toLowerCase() as 'white']);
    if (cols.every((c) => !!c)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter: { colors: cols } } }];
  }
  // "Each player cannot cast more than one noncreature spell each turn."
  if ((m = L.match(/^(You|Each player|Each opponent|Players|Your opponents) cannot cast more than (one|two|three) (.+?) spells? each turn$/i))) {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${m[3]} spell`);
    if (noun && noun.confident && typeof n === 'number') {
      const who = /^you$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'custom', tag: 'maxSpellsPerTurn', data: { count: n, filter: f } } }];
    }
  }
  // "Each player who has cast a nonartifact spell this turn cannot cast additional nonartifact spells."
  if ((m = L.match(/^Each player who has cast (?:a|an) (.+?) spell this turn cannot cast additional (.+?) spells$/i)) && m[1].toLowerCase() === m[2].toLowerCase()) {
    const noun = parseNoun(`a ${m[1]} spell`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'maxSpellsPerTurn', data: { count: 1, filter: f } } }];
    }
  }
  // "Each opponent must attack you or a planeswalker you control with at least one creature each combat if able."
  if ((m = L.match(/^(Each opponent|Each player|Players|Your opponents) must attack( you or a planeswalker you control| you)? with at least one creature each combat if able$/i))) {
    const who = /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'custom', tag: 'mustAttackWithOne', data: m[2] ? { you: true } : {} } }];
  }
  // "Each creature gets +1/+1 for each other creature on the battlefield that shares at least one creature type with it."
  if ((m = L.match(/^(.+?) gets? \+(\d+)\/\+(\d+) for each other (.+?) that shares (?:at least one|a) creature type with it$/i))) {
    const a = affectsOf(m[1]);
    const per = parseNoun(`a ${m[4]}`);
    if (a.ok && per && per.confident) {
      const pf = { ...per.filter, other: true, sharesCreatureTypeWithSource: true };
      if (!pf.zone) pf.zone = 'battlefield';
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perCount: pf, perSelf: true } }];
    }
  }
  // "Each creature you control gets +1/+1 for each white mana symbol in its mana cost."
  if ((m = L.match(/^(.+?) gets? \+(\d+)\/\+(\d+) for each (white|blue|black|red|green) mana symbol in (?:its|their) mana costs?$/i))) {
    const a = affectsOf(m[1]);
    const col = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[4].toLowerCase() as 'white'];
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perAmount: { kind: 'manaSymbolCount', ref: { ref: 'self' }, color: col }, perSelf: true } }];
  }
  // "Each non-Human creature you control gets +1/+1 for each of its creature types."
  if ((m = L.match(/^(.+?) gets? \+(\d+)\/\+(\d+) for each of (?:its|their) creature types$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perAmount: { kind: 'creatureTypeCount', ref: { ref: 'self' } }, perSelf: true } }];
  }
  // "Each noncreature artifact is an artifact creature with power and toughness each equal to its mana value."
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) with power and toughness each equal to (?:its|their) mana value$/i))) {
    const a = affectsOf(m[1]);
    const probe = parseNoun(`a ${m[2]}`);
    if (a.ok && probe && probe.confident && probe.filter.types?.length) {
      return [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: probe.filter.types } },
        { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', powerAmount: { kind: 'manaValue', ref: { ref: 'self' } }, toughnessAmount: { kind: 'manaValue', ref: { ref: 'self' } } } },
      ];
    }
  }
  // "Each creature assigns combat damage equal to its mana value rather than its power."
  if ((m = L.match(/^(.+?) assigns? combat damage equal to (?:its|their) mana value rather than (?:its|their) power$/i))) { const _r134a = objRule(m[1], { kind: 'custom', tag: 'damageByManaValue' }); if (_r134a) return _r134a; }
  // "If a creature dealt damage by ~ this turn would die, exile it instead."
  if ((m = L.match(/^If (?:a|an) (.+?) dealt damage by ~ this turn would die, exile it instead$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return [{ kind: 'replacement', text: line, event: 'dies', self: false, filter: { ...noun.filter, zone: undefined, damagedBySource: true }, instead: 'exile' }];
  }
  // "~ cannot be copied."
  if (/^~ cannot be copied$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantBeCopied' } }];
  // "~ cannot be blocked as long as it is attacking alone."
  if (/^~ cannot be blocked as long as it is attacking alone$/i.test(L)) {
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'cantBeBlocked' }, condition: { kind: 'count', filter: { types: ['Creature'], controller: 'you', attacking: true, zone: 'battlefield' }, op: '==', value: 1 } }];
  }
  // "If a spell or ability an opponent controls causes you to discard ~, put it onto the battlefield instead."
  if ((m = L.match(/^If a spell or ability an opponent controls causes you to discard ~, put it onto the battlefield(?: with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it)? instead of putting it into your graveyard$/i))) {
    const dn = m[1] ? wordToNumber(m[1]) : 1;
    const data = m[2] && typeof dn === 'number' ? { counter: m[2], amount: dn } : undefined;
    return [{ kind: 'static', text: line, affects: 'self', zone: 'hand', rule: { kind: 'custom', tag: 'discardToBattlefield', data } }];
  }
  // "Creature cards in graveyards and libraries can't enter the battlefield."
  if ((m = L.match(/^(.+?) in (graveyards|libraries|graveyards and libraries) cannot enter the battlefield$/i))) {
    const noun = parseNoun(m[1]);
    if (noun && noun.confident) {
      const zones = /and/i.test(m[2]) ? ['graveyard', 'library'] : /graveyards/i.test(m[2]) ? ['graveyard'] : ['library'];
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantEnterFromZone', data: { filter: { ...noun.filter, zone: undefined }, zones } } }];
    }
  }
  // "You have no maximum hand size for as long as you control ~."
  if ((m = L.match(/^(Equipped|Enchanted) creature gets ([+-]\d+)\/([+-]\d+) and is all creature types$/i))) {
    return [
      { kind: 'static', text: line, affects: 'attachedTo', modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } },
      { kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 6, addKeywords: ['Changeling'] } },
    ];
  }
  if (/^You control enchanted [\w ]+$/i.test(L)) {
    return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 'control', controller: 'sourceController' } }];
  }
  if (/^You have no maximum hand size(?: for as long as you control ~)?$/i.test(L)) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'noMaxHandSize' } }];
  }
  // "~ is all colors."
  if (/^~ is all colors$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 5, setColors: ['W', 'U', 'B', 'R', 'G'] } }];
  // "~ attacks or blocks each combat if able." / "~ blocks each combat if able."
  sfall1: {
  if ((m = L.match(/^(.+?) (attacks or blocks|blocks) each combat if able$/i))) {
    const rules: RuleModification['kind'][] = m[2].toLowerCase() === 'blocks' ? ['mustBlock'] : ['mustAttack', 'mustBlock'];
    const out: AbilitySpec[] = [];
    for (const k of rules) {
      const r = objRule(m[1], { kind: k } as RuleModification);
      if (!r) break sfall1;
      out.push(...r);
    }
    return out;
  }
  }
  // "~ cannot be blocked except by creatures with flying or reach."
  if ((m = L.match(/^(.+?) cannot be blocked except by (.+)$/i))) {
    const kw = m[2].match(/^creatures with (.+)$/i);
    const kws = kw ? parseKeywordList(kw[1].replace(/ or /g, ' and ')) : null;
    const noun = kws?.length ? null : parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    const filter = kws?.length ? (kws.length === 1 ? { keywords: kws } : { anyOf: kws.map((k) => ({ keywords: [k] })) }) : noun ? { ...noun.filter, zone: undefined } : null;
    if (filter) {
      const r = objRule(m[1], { kind: 'cantBeBlockedExceptBy', filter });
      if (r) return r;
    }
  }
  // "Lands you control enter untapped."
  if ((m = L.match(/^(.+?) enter untapped$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'entersUntapped', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "Spells with the chosen name cannot be cast."
  if (/^Spells with the chosen name cannot be cast$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantCast', data: { filter: { nameIsChosen: 'cardName' } } } }];
  // "Each opponent can cast spells only any time they could cast a sorcery."
  if (/^Each opponent can cast spells only any time they could cast a sorcery$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'sorcerySpeedOnly' } }];
  // "You may activate abilities of creatures you control as though those creatures had haste."
  if ((m = L.match(/^You may activate abilities of (.+?) as though (?:those|they had|that permanent had) .*haste$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'activateAsThoughHaste', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "You may cast ~ from your graveyard."
  if (/^You may cast ~ from your graveyard$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { nameIs: '~' } } } }];
  // "Only your opponents may activate this ability." — an activation restriction handled by the caller.
  // "Equipped creature gets +10/+10 and loses flying."
  if ((m = L.match(/^(Equipped|Enchanted) (creature|permanent) gets ([+-]\d+)\/([+-]\d+) and loses (.+)$/i))) {
    const kws = parseKeywordList(m[5]);
    if (kws) return [
      { kind: 'static', text: line, affects: 'attachedTo', modification: { layer: '7c', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10) } },
      { kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 6, removeKeywords: kws } },
    ];
  }
  // "As long as ~ is paired with another creature, each of those creatures gets +1/+1."
  if ((m = L.match(/^As long as ~ is paired with another creature, each of those creatures gets ([+-]\d+)\/([+-]\d+)$/i))) {
    return [
      { kind: 'static', text: line, affects: 'self', modification: { layer: '7c', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10) }, condition: { kind: 'paired', ref: { ref: 'self' } } },
      { kind: 'static', text: line, affects: { pairedWithSource: true, zone: 'battlefield' }, modification: { layer: '7c', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10) } },
    ];
  }
  // "As long as equipped creature is a Human, it gets an additional +1/+1."
  if ((m = L.match(/^As long as (?:equipped|enchanted) creature is (?:a|an) ([A-Z][\w' -]*), it gets an additional ([+-]\d+)\/([+-]\d+)$/))) {
    return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) }, condition: { kind: 'objectMatches', ref: { ref: 'attachedTo' }, filter: { subtypes: [m[1]] } } }];
  }
  // "Vehicles you control have crew 1."
  if ((m = L.match(/^(.+?) have (crew \d+|equip (?:\{[^}]+\})+|ward (?:\{[^}]+\})+)$/i))) {
    const noun = parseNoun(m[1]);
    const kw = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    if (noun) return [{ kind: 'static', text: line, affects: { ...noun.filter, zone: 'battlefield' }, modification: { layer: 6, addAbilityText: [kw] } }];
  }
  // "Enchanted permanent cannot attack or block, and its activated abilities cannot be activated (unless they are mana abilities)."
  if ((m = L.match(/^(.+?)(?: (cannot (?:attack|block|attack or block|attack, block, or transform|attack, block, or crew Vehicles|attack or block, or crew Vehicles)|does not untap during its controller's untap step)),? and(?: that permanent's| its)? activated abilities cannot be activated(?: unless they are mana abilities)?$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) {
      const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'cantActivateOwnAbilities', data: /unless they are mana abilities/i.test(L) ? { exceptMana: true } : undefined } }];
      const what = (m[2] ?? '').toLowerCase();
      if (/untap/.test(what)) out.push({ kind: 'static', text: line, affects: a.affects, rule: { kind: 'cantUntap' } });
      if (/attack/.test(what)) out.push({ kind: 'static', text: line, affects: a.affects, rule: { kind: 'cantAttack' } });
      if (/block/.test(what)) out.push({ kind: 'static', text: line, affects: a.affects, rule: { kind: 'cantBlock' } });
      return out;
    }
  }
  // "Its activated abilities cannot be activated this turn." handled as an effect; the bare static form:
  if (/^(?:its|that permanent's) activated abilities cannot be activated$/i.test(L)) {
    return [{ kind: 'static', text: line, affects: 'attachedTo', rule: { kind: 'custom', tag: 'cantActivateOwnAbilities' } }];
  }
  // "No more than one creature can attack each combat." / "... can block each combat."
  if ((m = L.match(/^No more than (\w+) creature can (attack|block) each combat$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: m[2].toLowerCase() === 'attack' ? 'maxAttackers' : 'maxBlockersTotal', data: n } }];
  }
  // "Creatures with islandwalk can be blocked as though they didn't have islandwalk."
  if ((m = L.match(/^Creatures with (\w+walk) can be blocked as though they did ?n[o']t have \1$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'ignoreLandwalk', data: m[1].toLowerCase() } }];
  }
  // "~ can block creatures with shadow as though it had shadow."
  if ((m = L.match(/^~ can block creatures with (\w+) as though it had \1$/i))) {
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'canBlockAsThough', data: m[1].toLowerCase() } }];
  }
  // "Enchanted creature loses flying."
  if ((m = L.match(/^(Enchanted|Equipped) (?:creature|permanent|artifact|land) loses (.+)$/i))) {
    const kws = parseKeywordList(m[2]);
    if (kws) return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 6, removeKeywords: kws } }];
  }
  // "Players cannot cast spells from graveyards or libraries."
  if (/^Players cannot cast spells from graveyards or libraries$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noCastFromGraveyardOrLibrary' } }];
  // "All creatures block each combat if able."
  if ((m = L.match(/^(All creatures|Creatures your opponents control|Creatures) block each combat if able$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'mustBlock' } }];
  }
  // "Each player may play an additional land on each of their turns."
  sx1: {
  if (/^Each player may play an additional land (?:on|during) each of their turns$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'extraLandDrop', count: 1 } }];
  // "During turns other than yours, spells you cast cost {1} less to cast."
  if ((m = L.match(/^During turns other than yours, (.+?) you cast cost \{(\d)\} less to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) break sx1;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter }, condition: { kind: 'not', c: { kind: 'yourTurn' } } }];
  }
  }
  // "If you would lose unspent mana, that mana becomes colorless instead."
  if (/^If you would lose unspent mana, that mana becomes colorless instead$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'keepMana' } }];
  // "If a player would begin an extra turn, that player skips that turn instead."
  if (/^If a player would begin an extra turn, that player skips that turn instead$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noExtraTurns' } }];
  // "If you would put one or more counters on a permanent or player, put twice that many instead."
  if ((m = L.match(/^If (you|an opponent) would put one or more counters on a permanent or player, (?:they |you )?put (twice that many|half that many, rounded down|half that many)(?: of each of those kinds of counters)? (?:on that permanent or player )?instead$/i))) {
    const mult = /twice/i.test(m[2]) ? 2 : 0.5;
    return [{ kind: 'static', text: line, ruleAffects: m[1].toLowerCase() === 'you' ? 'controller' : 'opponents', rule: { kind: 'custom', tag: 'counterMultiplier', data: mult } }];
  }
  if (/^You cannot lose the game$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'cantLose' } }];
  // "~ cannot have counters put on it." / "Creatures you control cannot have -1/-1 counters put on them."
  if ((m = L.match(/^(.+?) cannot have (?:([+\-\d\/]+|\w+) )?counters put on (?:it|them)$/i))) {
    const r = objRule(m[1], { kind: 'custom', tag: 'noCounters', data: m[2] ? { counter: m[2] } : undefined });
    if (r) return r;
  }
  // "~ has flying as long as it is modified."
  if ((m = L.match(/^(.+?) (?:has|have) (.+?) as long as (?:it is|they are) (modified|enchanted|equipped|tapped|untapped|attacking|blocking)$/i))) {
    const kws = parseKeywordList(m[2]);
    const a = affectsOf(m[1]);
    if (kws && a.ok) {
      const f = ({ modified: { modified: true }, enchanted: { hasAttachment: 'Aura' as const }, equipped: { hasAttachment: 'Equipment' as const }, tapped: { tapped: true }, untapped: { untapped: true }, attacking: { attacking: true }, blocking: { blocking: true } } as Record<string, ObjectFilter>)[m[3].toLowerCase()];
      if (a.affects === 'self') return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: kws }, condition: { kind: 'objectMatches', ref: { ref: 'self' }, filter: f } }];
      if (typeof a.affects === 'object') return [{ kind: 'static', text: line, affects: { ...a.affects, ...f }, modification: { layer: 6, addKeywords: kws } }];
    }
  }
  // "Enchant artifact, creature, or planeswalker"
  // "If you would gain life, draw that many cards instead."
  if (/^If you would gain life, draw that many cards instead$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'lifeGainToDraw' } }];
  // "If an opponent would gain life, that player loses that much life instead."
  if ((m = L.match(/^If (an opponent|a player|you) would gain life, (?:that player|you) loses? that much life instead$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: m[1].toLowerCase() === 'you' ? 'controller' : m[1].toLowerCase() === 'a player' ? 'allPlayers' : 'opponents', rule: { kind: 'custom', tag: 'lifeGainToLoss' } }];
  }
  // "Activated abilities of sources with the chosen name cannot be activated."
  if (/^Activated abilities of sources with the chosen name cannot be activated(?: unless they are mana abilities)?$/i.test(L)) {
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantActivateNamed', data: { key: 'cardName', exceptMana: /mana abilities/i.test(L) } } }];
  }
  // "~ is the chosen color."
  if (/^~ is the chosen colors?$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 5, setColorsFromMemory: 'color' } }];
  // "Creatures you control of the chosen color get +1/+1."
  if ((m = L.match(/^(.+?) of the chosen colors? get ([+-]\d+)\/([+-]\d+)$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok && typeof a.affects === 'object') return [{ kind: 'static', text: line, affects: { ...a.affects, chosenColor: true }, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } }];
  }
  // "Equip abilities you activate that target ~ cost {2} less to activate."
  if ((m = L.match(/^(\w+) abilities you activate that target ~ cost \{(\d)\} less to activate$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[2], 10), textPrefix: m[1] } } }];
  }
  // Defiler cycle: "As an additional cost to cast white permanent spells, you may pay 2 life."
  if ((m = L.match(/^As an additional cost to cast (.+?) spells, you may pay (\d+) life$/i))) {
    const noun = parseNoun(`a ${m[1]} spell`);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'optionalLifeCost', data: { filter: { ...noun.filter, zone: undefined }, life: parseInt(m[2], 10) } } }];
  }
  if ((m = L.match(/^Those spells cost ((?:\{[WUBRGC]\})+) less to cast if you paid life this way$/i))) return [];
  if ((m = L.match(/^(.+?) (?:has|have) (.+?) and "(.+)"$/i))) {
    const a = affectsOf(m[1]);
    const kws = parseKeywordList(m[2]);
    if (a.ok && kws) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } }, { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: [m[3]] } }];
  }  // "Enchanted creature gets +2/+2 as long as it is a Human. Otherwise, it cannot attack or block."
  if ((m = L.match(/^(.+?) as long as (.+?)\. Otherwise, (.+)$/i))) {
    const subject = m[1].match(/^(~|Enchanted \w+|Equipped \w+|Creatures you control|Each creature you control)\b/i)?.[1];
    const a = parseStatic(`${m[1]} as long as ${m[2]}`, isCreatureOrPermanent);
    const otherwise = subject ? m[3].replace(/^(?:it|they) /i, `${subject} `) : m[3];
    const cond = parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    const b = cond && cond.kind !== 'manual' ? parseStatic(otherwise, isCreatureOrPermanent) : null;
    if (a && b && cond) return [...a, ...b.map((x) => (x.kind === 'static' ? { ...x, condition: { kind: 'not' as const, c: cond } } : x))];
  }
  // Conditional statics: "As long as X, Y" / "During your turn, Y" / "Y as long as X"
  let condText: string | null = null;
  let innerText: string | null = null;
  if ((m = L.match(/^(?:As long as|While) (.+?), (.+)$/i))) {
    // The condition may contain commas ("As long as you control a God, a Demigod, or an enchantment, ...").
    [condText, innerText] = [m[1], m[2]];
    const head = L.match(/^(?:As long as|While) /i)![0].length;
    for (let k = L.length - 1; k >= head; k--) {
      if (L[k] !== ',') continue;
      const ct = L.slice(head, k).trim();
      const it = L.slice(k + 1).trim();
      if (!ct || !it) continue;
      if (parseCondition(ct, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })) { condText = ct; innerText = it; break; }
    }
  }
  else if ((m = L.match(/^(.+?) (?:as long as|while) (.+)$/i))) [condText, innerText] = [m[2], m[1]];
  else if ((m = L.match(/^((?:~|Enchanted \w+|Equipped \w+) (?:does not untap|cannot|gets|has) .+?) if (.+)$/i))) [condText, innerText] = [m[2], m[1]];
  sx2: {
  if (condText && innerText) {
    // "As long as ~ is attacking, it gets +2/+0": "it" is this permanent.
    if (/^it (gets|has|is|can|cannot|assigns|must|does|loses|gains|deals)\b/i.test(innerText) && /^(?:~|it)\b/i.test(condText)) innerText = innerText.replace(/^it /i, '~ ');
    else if (/^it (gets|has|is|can|cannot|assigns|must|does|loses|gains|deals)\b/i.test(innerText) && /^(?:enchanted|equipped) (creature|permanent)/i.test(condText)) innerText = innerText.replace(/^it /i, condText.match(/^(?:enchanted|equipped) (?:creature|permanent)/i)![0] + ' ');
    else if (/^it (gets|has|is|can|cannot|assigns|must|does|loses|gains|deals)\b/i.test(innerText)) innerText = innerText.replace(/^it /i, '~ ');
    const inner = parseStatic(innerText, isCreatureOrPermanent);
    if (inner) {
      const cond = parseCondition(condText, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) ?? { kind: 'manual' as const, text: condText };
      if (cond.kind === 'manual') break sx2; // can't evaluate statics interactively
      return inner.map((a) => (a.kind === 'static' ? { ...a, condition: cond } : a));
    }
  }
  }
  if ((m = L.match(/^During your turn, (.+)$/i))) {
    const inner = parseStatic(m[1], isCreatureOrPermanent);
    if (inner) return inner.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'yourTurn' as const } } : a));
  }
  if ((m = L.match(/^(.+?) (cannot [^,]+?) and (cannot .+)$/i))) {
    const a = parseStatic(`${m[1]} ${m[2]}`, isCreatureOrPermanent);
    const b = parseStatic(`${m[1]} ${m[3]}`, isCreatureOrPermanent);
    if (a && b) return [...a, ...b];
  }
  // Generic conjunctions sharing a subject: "Enchanted creature gets +2/+2, has flying, and is goaded."
  if ((m = L.match(/^(~|Enchanted \w+|Equipped \w+|Creatures you control|Other creatures you control|Each creature you control|Creatures your opponents control|Each other creature you control|All creatures|Each creature) (.+)$/i)) && /(?:, | and )/.test(m[2])) {
    const subject = m[1];
    // Commas inside quoted ability text are not list separators.
    const masked = m[2].replace(/"[^"]*"/g, (q) => q.replace(/, /g, '\u0001'));
    const parts = masked.split(/, and |, | and (?=(?:has|have|is|are|gets?|cannot|can|loses?|gains?|does not|doesn't|attacks?|assigns?|must|enters?)\b)/i).map((p) => p.replace(/\u0001/g, ', ').trim()).filter(Boolean);
    if (parts.length > 1) {
      const out: AbilitySpec[] = [];
      let ok = true;
      for (const p of parts) {
        const r = parseStatic(`${subject} ${p}`, isCreatureOrPermanent);
        if (!r) {
          ok = false;
          break;
        }
        out.push(...r);
      }
      if (ok) return out;
    }
  }
  if ((m = L.match(/^(.+?) assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power$/i))) { const _q1 = objRule(m[1], { kind: 'custom', tag: 'damageByToughness' }); if (_q1) return _q1; }
  // "Creatures cannot block unless their controller pays {1} for each of those creatures."
  if ((m = L.match(/^(.+?) cannot block unless their controller pays ((?:\{[^}]+\})+)(?: for each of those creatures)?$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'blockTax', data: { filter: { ...noun.filter, zone: undefined }, cost: m[2] } } }];
  }
  sfall2: {
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block) unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') {
      const rules: RuleModification[] = m[2].toLowerCase() === 'attack or block' ? [{ kind: 'cantAttack' }, { kind: 'cantBlock' }] : m[2].toLowerCase() === 'attack' ? [{ kind: 'cantAttack' }] : [{ kind: 'cantBlock' }];
      const out: AbilitySpec[] = [];
      for (const rule of rules) {
        const r = objRule(m[1], rule);
        if (!r) break sfall2;
        out.push(...r.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'not' as const, c: cond } } : a)));
      }
      return out;
    }
  }
  }
  // "You may play lands and cast creature spells from the top of your library."
  sx3: {
  if ((m = L.match(/^You may (play lands and cast (.+?) spells|play lands|cast (.+?) spells(?: and (.+?) spells)?|play cards|cast spells|play lands and cast spells) from the top of your library$/i))) {
    const what = m[1].toLowerCase();
    const spellNoun = m[2] ?? m[3];
    let filter = spellNoun ? parseNoun(`a ${spellNoun} spell`)?.filter : undefined;
    if (spellNoun && !filter) break sx3;
    if (filter && m[4]) {
      const second = parseNoun(`a ${m[4]} spell`)?.filter;
      if (!second) break sx3;
      filter = { anyOf: [{ ...filter, zone: undefined }, { ...second, zone: undefined }] };
    }
    const data = { lands: /play lands|play cards/.test(what), spells: /cast|play cards/.test(what), filter: filter ? { ...filter, zone: undefined } : undefined };
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playFromTop', data } }];
  }
  }
  // "As ~ enters, choose another creature you control."
  if ((m = L.match(/^As ~ enters, choose (?:a|an|another) (.+)$/i)) && !/^(color|creature type|opponent|player|card name|number|basic land type)$/i.test(m[1])) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun && noun.confident) {
      const f = { ...noun.filter };
      if (!f.zone) f.zone = 'battlefield';
      if (/^another /i.test(m[0].slice(m[0].indexOf('choose'))) || /\banother\b/i.test(m[0])) f.other = true;
      return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, chooseObject: f, chooseKey: 'chosen' }];
    }
  }
  if ((m = L.match(/^As ~ enters, choose (a color|a creature type|an opponent|a player|a card name|a number) and (a color|a creature type|an opponent|a player|a card name|a number)$/i))) {
    const a = parseStatic(`As ~ enters, choose ${m[1]}`, isCreatureOrPermanent);
    const b = parseStatic(`As ~ enters, choose ${m[2]}`, isCreatureOrPermanent);
    if (a && b) return [...a, ...b];
  }
  // "~ escapes with three +1/+1 counters on it."
  sx4: {
  if ((m = L.match(/^~ escapes with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w' -]+?) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) break sx4;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, condition: { kind: 'castFrom', zone: 'graveyard' }, counters: { counter: m[2], amount: n } }];
  }
  }
  // "~ can't attack a player it has already attacked this turn."
  if (/^~ cannot attack a player it has already attacked this turn$/i.test(L)) { const _q2 = objRule('~', { kind: 'custom', tag: 'onePlayerPerTurn' }); if (_q2) return _q2; }
  // "Enchanted land is the chosen type."
  if ((m = L.match(/^(.+?) (?:is|are) the chosen type$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addSubtypesFromMemory: 'landType' } }];
  }
  // "Colorless spells you cast with mana value 7 or greater cost {1} less to cast."
  if ((m = L.match(/^(.+?) you cast ((?:with|that (?:have|has)) [^,]+?) cost \{(\d)\} (less|more) to cast$/i))) {
    const noun = parseNoun(`a ${m[1].replace(/ spells?$/i, ' spell')} ${m[2]}`);
    if (noun) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[4].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[3], 10), filter: f } }];
    }
  }
  // "Spells your opponents cast that target a creature you control cost {2} more to cast."
  if ((m = L.match(/^Spells your opponents cast that target (.+?) cost \{(\d)\} more to cast$/i))) {
    const noun = parseNoun(singularize(m[1].replace(/^one or more /i, 'a ')));
    if (noun) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'costIncrease', amount: parseInt(m[2], 10), filter: { spellTargets: f } } }];
    }
  }
  // "If a source would deal damage to a Cleric creature you control, prevent 1 of that damage."
  if ((m = L.match(/^If (?:a|an) (.+?) would deal (combat )?damage to (.+?), prevent (\d+|all) of that damage$/i))) {
    const src = parseNoun(`a ${m[1]}`);
    const to = parseNoun(m[3]) ?? parseNoun(`a ${m[3]}`);
    if (src && to) {
      const tf = { ...to.filter };
      delete tf.zone;
      const sf = { ...src.filter };
      delete sf.zone;
      return [{ kind: 'replacement', text: line, event: 'damage', prevent: m[4] === 'all' ? 'all' : parseInt(m[4], 10), to: tf, fromFilter: /^source/i.test(m[1]) ? undefined : sf, combatOnly: m[2] ? true : undefined }];
    }
  }
  // "Red creature spells and green creature spells cost {1} more to cast."
  if ((m = L.match(/^(.+?) spells? and (.+?) spells? cost \{(\d+)\} (less|more) to cast$/i))) {
    const a = parseNoun(`a ${m[1]} spell`);
    const b = parseNoun(`a ${m[2]} spell`);
    if (a && b) {
      const f: ObjectFilter = { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }] };
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: m[4].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[3], 10), filter: f } }];
    }
  }
  if (/^You cannot play lands$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'cantPlayLands' } }];
  if (/^You cannot win the game and your opponents cannot lose the game$/i.test(L)) {
    return [
      { kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'cantWin' } },
      { kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'cantLose' } },
    ];
  }
  if ((m = L.match(/^(.+?) spells? cannot be cast$/i))) {
    const cc = /^spells?$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]} spell`);
    if (cc) {
      const f = { ...cc.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantCastSpells', data: { filter: f } } }];
    }
  }
  // "Creatures your opponents control lose flying." (the "and cannot have or gain X" tail is stripped above)
  if ((m = L.match(/^(.+?) (?:lose|loses) ([\w ,]+?)$/i))) {
    const kws = parseKeywordList(m[2]);
    const a = kws ? affectsOf(m[1]) : { affects: undefined, ok: false };
    if (kws && a.ok) {
      return [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, removeKeywords: kws } },
        { kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'cannotGainKeywords', data: kws } },
      ];
    }
  }
  // "Creatures your opponents control lose flying and cannot have or gain flying."
  if ((m = L.match(/^(.+?) lose ([\w ]+?)(?: and ([\w ]+?))? and cannot (?:have or gain|have) ([\w ]+?)(?: or ([\w ]+?))?$/i))) {
    const kws = parseKeywordList([m[2], m[3]].filter(Boolean).join(', '));
    const a = affectsOf(m[1]);
    if (kws && a.ok) {
      return [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, removeKeywords: kws } },
        { kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'cannotGainKeywords', data: kws } },
      ];
    }
  }
  if (/^Players cannot cast spells from graveyards or activate abilities of cards in graveyards$/i.test(L)) {
    return [
      { kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noCastFromGraveyardOrLibrary' } },
      { kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noGraveyardAbilities' } },
    ];
  }
  if (/^You have protection from each of your opponents$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'protectionFromOpponents' } }];
  if (/^~ is not legendary if it is a token$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 4, removeSupertypes: ['Legendary'] }, condition: { kind: 'objectMatches', ref: { ref: 'self' }, filter: { isToken: true } } }];
  if ((m = L.match(/^(.+?) can block creatures with (\w+) as though they (?:did not|didn't) have \2$/i))) {
    const r = objRule(m[1], { kind: 'custom', tag: 'canBlockAsThough', data: m[2].toLowerCase() });
    if (r) return r;
  }
  if ((m = L.match(/^~ enters under the control of (an opponent of your choice|target opponent)$/i)))
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: [{ kind: 'gainControl', what: { ref: 'self' }, who: { ref: 'eachOpponent' }, duration: 'permanent' }] }];
  if ((m = L.match(/^Each (.+?) in your hand has (miracle|foretell|cycling|madness|escape|scavenge)$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'grantSpellKeyword', data: { keyword: m[2].toLowerCase(), filter: { ...f, zone: 'hand' } } } }];
    }
  }
  if (/^Players cannot pay life or sacrifice creatures to cast spells or activate abilities$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noLifeOrSacrificeCosts' } }];
  if (/^Spells and abilities your opponents control cannot cause their controller to search their library$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'noSearch' } }];
  sfall3: {
  if ((m = L.match(/^(.+?) cannot be the target of (spells|abilities)(?: from (.+?) sources)?$/i))) {
    const f = m[3] ? parseNoun(`a ${m[3]}`)?.filter : undefined;
    if (m[3] && !f) break sfall3;
    const r = objRule(m[1], { kind: 'cantBeTargeted', by: /spells/i.test(m[2]) ? 'spells' : 'abilities', filter: f ? { ...f, zone: undefined } : undefined });
    if (r) return r;
  }
  }
  if ((m = L.match(/^Each (.+?) in your graveyard has the chosen creature type in addition to its other types$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (noun) return [{ kind: 'static', text: line, affects: { ...noun.filter, zone: 'graveyard' }, modification: { layer: 4, addSubtypesFromMemory: 'creatureType' } }];
  }
  if ((m = L.match(/^(.+?) cannot be sacrificed$/i))) {
    const r = objRule(m[1], { kind: 'custom', tag: 'cantBeSacrificed' });
    if (r) return r;
  }
  if (/^All lands lose all abilities except mana abilities$/i.test(L)) return [{ kind: 'static', text: line, affects: { types: ['Land'], zone: 'battlefield' }, modification: { layer: 6, loseAllAbilities: true } }];
  if ((m = L.match(/^Each (.+?) in your hand without (\w+) has \2$/i))) {
    const hn = parseNoun(`a ${m[1]}`);
    if (hn) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'grantSpellKeyword', data: { keyword: m[2].toLowerCase(), filter: { ...hn.filter, zone: 'hand' } } } }];
  }
  if ((m = L.match(/^(Exhaust|Equip|Crew|Channel|Cycling) abilities (?:you activate )?of (.+?) cost \{(\d+)\} less to activate$/i))) {
    const an = parseNoun(m[2]);
    if (an) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[3], 10), textPrefix: m[1], filter: { ...an.filter, zone: an.filter.zone ?? 'battlefield' } } } }];
  }
  if ((m = L.match(/^Creatures attacking (?:your opponents|you) have (.+)$/i))) {
    const kws = parseKeywordList(m[1]);
    if (kws) return [{ kind: 'static', text: line, affects: { types: ['Creature'], zone: 'battlefield', attacking: true }, modification: { layer: 6, addKeywords: kws } }];
  }
  if ((m = L.match(/^(.+?) and (.+?) have (.+)$/i)) && !/^(you|each player|players)/i.test(m[1])) {
    const kws = parseKeywordList(m[3]);
    const a = kws ? affectsOf(m[1]) : { affects: undefined, ok: false };
    const b = kws ? affectsOf(m[2]) : { affects: undefined, ok: false };
    if (kws && a.ok && b.ok) {
      return [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } },
        { kind: 'static', text: line, affects: b.affects, modification: { layer: 6, addKeywords: kws } },
      ];
    }
  }
  if ((m = L.match(/^(Flashback|Equip|Crew|Cycling|Unlock) costs your opponents pay cost \{(\d+)\} more$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: -parseInt(m[2], 10), textPrefix: m[1] } } }];
  if ((m = L.match(/^(?:Instant and sorcery spells|Spells) you control have rebound$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'grantSpellKeyword', data: { keyword: 'rebound' } } }];
  if (/^Players can cast spells and activate abilities only during their own turns$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'ownTurnOnly' } }];
  if ((m = L.match(/^(.+?) cannot be enchanted by other Auras$/i))) {
    const r = objRule(m[1], { kind: 'cantBeTargeted', by: 'spells', filter: { subtypes: ['Aura'] } });
    if (r) return r;
  }
  if ((m = L.match(/^If (?:a|an) (.+?) would enter and it wasn'?t cast, exile it instead$/i))) {
    const en = parseNoun(`a ${m[1]}`);
    if (en) {
      const f = { ...en.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'exileIfEntersUncast', data: { filter: f } } }];
    }
  }
  sx5: {
  if ((m = L.match(/^Enchanted player cannot cast more than (\w+) spells? each turn$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') break sx5;
    return [{ kind: 'static', text: line, ruleAffects: 'attachedToController', rule: { kind: 'custom', tag: 'maxSpellsPerTurn', data: n } }];
  }
  }
  sx6: {
  if ((m = L.match(/^No more than (\w+) creatures can attack you each combat$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') break sx6;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'maxAttackersAgainstYou', data: n } }];
  }
  }
  sx7: {
  if (/^Activated abilities of artifacts and creatures cannot be activated unless they are mana abilities$/i.test(L))
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noNonManaAbilities', data: { filter: { types: ['Artifact', 'Creature'] } } } }];
  if ((m = L.match(/^The chosen player's maximum hand size is (\w+)$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') break sx7;
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'chosenPlayerMaxHandSize', data: n } }];
  }
  }
  if ((m = L.match(/^You may pay ((?:\{[^}]+\})+) rather than pay the mana cost for spells you cast$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'altCostForSpells', data: { cost: m[1] } } }];
  if ((m = L.match(/^If ~ is your commander, choose a (color|creature type) before the game begins$/i)))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'preGameChoice', data: m[1].toLowerCase() } }];
  if (/^~ is the chosen color$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 5, setColorsFromMemory: 'color' } }];
  if (/^Players cannot search libraries$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noSearch' } }];
  if (/^Players cannot play lands$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'cantPlayLands' } }];
  if (/^Spells and abilities your opponents control cannot cause you to sacrifice permanents$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'cantBeMadeToSacrifice' } }];
  if ((m = L.match(/^(Each opponent|Each player|You) cannot draw more than (\w+) cards? each turn$/i))) {
    const n = wordToNumber(m[2]);
    if (typeof n === 'number') return [{ kind: 'static', text: line, ruleAffects: /opponent/i.test(m[1]) ? 'opponents' : /^you$/i.test(m[1]) ? 'controller' : 'allPlayers', rule: { kind: 'custom', tag: 'maxDrawsPerTurn', data: n } }];
  }
  // "If a source would deal damage to you or a creature you control, prevent 1 of that damage."
  if ((m = L.match(/^If (?:a|an) (.+?) would deal (combat )?damage to you or (?:a|an) (.+?) you control, prevent (\d+|all) of that damage$/i))) {
    return [{ kind: 'replacement', text: line, event: 'damage', prevent: m[4] === 'all' ? 'all' : parseInt(m[4], 10), to: 'controller', combatOnly: m[2] ? true : undefined }];
  }
  if (/^You may have ~ assign its combat damage as though it (?:were not|weren't) blocked$/i.test(L)) { const _q3 = objRule('~', { kind: 'custom', tag: 'assignAsUnblocked' }); if (_q3) return _q3; }
  // "If another red source you control would deal damage to a permanent or player, it deals that much damage plus 1 to that permanent or player instead."
  if ((m = L.match(/^If (?:another )?(?:a )?(\w+) sources? you control would deal (noncombat |combat )?damage to (?:an opponent or a permanent an opponent controls|a permanent or player|an opponent|a player or permanent), it deals that much damage plus (\d+) (?:to (?:that permanent or player|that player|them) )?instead$/i)) && !/^a$/i.test(m[1])) {
    const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, string>)[m[1].toLowerCase()];
    if (cn) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damagePlus', data: { filter: { controller: 'you', colors: [cn] }, plus: parseInt(m[4], 10), noncombatOnly: /noncombat/i.test(m[2] ?? '') || undefined, combatOnly: /^combat/i.test(m[2] ?? '') || undefined } } }];
  }
  // "If a Lizard you control would deal damage to a permanent or player, it deals that much damage plus 1 instead."
  if ((m = L.match(/^If (?:another )?(?:a|an) (.+?) would deal (noncombat |combat )?damage to (.+?), it deals that much damage plus (\d+|an amount of damage equal to .+?)(?: to .+?)? instead$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    const plusAmt: Amount | null = /^\d+$/.test(m[4]) ? parseInt(m[4], 10) : parseAmount(m[4].replace(/^an amount of damage equal to /i, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false } as never);
    if (noun && plusAmt !== null) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damagePlus', data: { filter: f, plus: plusAmt, noncombatOnly: /noncombat/i.test(m[2] ?? '') || undefined, combatOnly: /^combat/i.test(m[2] ?? '') || undefined, toOpponents: /opponent/i.test(m[3]) || undefined } } }];
    }
  }
  // "Double all damage that creature sources you control would deal."
  if ((m = L.match(/^(Double|Triple) all damage that (.+?) would deal$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) {
      const f = { ...noun.filter };
      delete f.zone;
      return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damageMultiplier', data: { filter: f, times: /triple/i.test(m[1]) ? 3 : 2 } } }];
    }
  }
  sx8: {
  if ((m = L.match(/^If a source you control would deal (noncombat |combat )?damage to (an opponent or a permanent an opponent controls|a permanent or player|an opponent|a player or permanent), it deals that much damage plus (\d+|an amount of damage equal to .+?) (?:to (?:that permanent or player|that player|them) )?instead$/i))) {
    const plusAmt = /^\d+$/.test(m[3]) ? parseInt(m[3], 10) : parseAmount(m[3].replace(/^an amount of damage equal to /i, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (plusAmt === null) break sx8;
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damagePlus', data: { filter: { controller: 'you' }, plus: plusAmt, noncombatOnly: /noncombat/i.test(m[1] ?? '') || undefined, combatOnly: /^combat/i.test(m[1] ?? '') || undefined, toOpponents: /opponent/i.test(m[2]) || undefined } } }];
  }
  }
  // "Once during each of your turns, you may cast an artifact or Human spell from your graveyard with mana value less than or equal to X."
  sx9: {
  if (/^You may cast ~ from your graveyard using its mutate ability$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { nameIs: '~' } } } }];
  if ((m = L.match(/^(Once during each of your turns, )?[Yy]ou may (play a land or cast|cast) (.+?) (?:spells? )?from (?:your graveyard|among cards in your graveyard that (.+?))(?: with mana value (?:less than or equal to|equal to or less than) (.+?))?(?: by (.+?) in addition to paying its other costs)?$/i))) {
    const base = m[3].replace(/^(?:a|an)$/i, '').replace(/^(?:a|an) /i, '').replace(/ spells?$/i, '').trim();
    // "from among cards in your graveyard that were milled this turn" is a filter on the card.
    const qual = m[4] ? m[4].replace(/^were milled this turn$/i, 'were put there from your library this turn') : null;
    const noun = qual ? parseNoun(`a ${base} card that ${qual}`.replace(/  +/g, ' ')) : parseNoun(`a ${base} spell`.replace(/  +/g, ' '));
    if (noun && noun.confident) {
      const filter = { ...noun.filter, zone: undefined as undefined };
      if (m[5]) {
        const amt = parseAmount(m[5], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
        if (amt === null) break sx9;
        filter.cmcLEAmount = amt;
      }
      let extraCost: AbilityCost | undefined;
      if (m[6]) {
        const G: Record<string, string> = { paying: 'Pay', discarding: 'Discard', exiling: 'Exile', removing: 'Remove', sacrificing: 'Sacrifice', returning: 'Return', revealing: 'Reveal', tapping: 'Tap', untapping: 'Untap' };
        const c = parseCost(m[6].replace(/\b(paying|discarding|exiling|removing|sacrificing|returning|revealing|tapping|untapping)\b/gi, (w) => G[w.toLowerCase()]).replace(/^[a-z]/, (ch) => ch.toUpperCase()));
        if (!c) break sx9;
        extraCost = c;
      }
      const out: AbilitySpec[] = [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter, oncePerTurn: !!m[1] || undefined, extraCost } } }];
      if (/^play a land or cast$/i.test(m[2])) {
        const landFilter: ObjectFilter = qual ? { ...(parseNoun(`a land card that ${qual}`)?.filter ?? { types: ['Land'] }), zone: undefined } : { types: ['Land'] };
        out.push({ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playLandsFromGraveyard', data: { filter: landFilter } } });
      }
      return out;
    }
  }
  }
  sx10: {
  if ((m = L.match(/^(Each player|Players|Your opponents|Each opponent|You) cannot cast more than (\w+) spells? each turn$/i))) {
    const n = wordToNumber(m[2]);
    if (typeof n !== 'number') break sx10;
    return [{ kind: 'static', text: line, ruleAffects: /^you$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers', rule: { kind: 'custom', tag: 'maxSpellsPerTurn', data: n } }];
  }  // "Your opponents cannot cast spells with the chosen name / with mana value 3 or less / during your turn / from anywhere other than their hands."
  if ((m = L.match(/^(Your opponents|Each opponent|Players|Each player|You) cannot cast (.+?)(?: (during your turn|during combat|from graveyards|from anywhere other than (?:their|your) hands?|with the chosen name|with the same name as the exiled card))?$/i))) {
    const who = /^you$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
    const data: Record<string, unknown> = {};
    if (m[3]) {
      if (/during your turn/i.test(m[3])) data.sourceTurnOnly = true;
      else if (/during combat/i.test(m[3])) data.duringCombat = true;
      else if (/from graveyards/i.test(m[3])) data.fromGraveyard = true;
      else if (/anywhere other than/i.test(m[3])) data.notFromHand = true;
      else if (/same name as the exiled card/i.test(m[3])) data.sameNameAsExiled = true;
      else data.chosenNameKey = 'cardName';
    }
    if (!/^spells$/i.test(m[2])) {
      const noun = /^spells? /i.test(m[2]) ? parseNoun(`a spell ${m[2].replace(/^spells? /i, '')}`) : parseNoun(`a ${m[2].replace(/ spells?$/i, '')} spell`);
      if (!noun) break sx10;
      data.filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'custom', tag: 'cantCastSpells', data } }];
  }
  }

  if ((m = L.match(/^All (combat )?damage that would be dealt to (you|you and other permanents you control|you and creatures you control|enchanted creature's controller|you and permanents you control) is dealt to (~|enchanted creature|equipped creature) instead$/i))) {
    const permanents = /permanents|creatures/i.test(m[2]);
    return [{ kind: 'static', text: line, affects: /^~$/i.test(m[3]) ? 'self' : 'attachedTo', rule: { kind: 'custom', tag: 'redirectDamage', data: { player: true, permanents, combatOnly: !!m[1] || undefined } } }];
  }
  sx11: {
  if ((m = L.match(/^(Your|Each player's|Each opponent's) maximum hand size is (?:(\w+)|(reduced|increased) by (\w+))$/i))) {
    const who = /^your$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
    if (m[2]) {
      const v = wordToNumber(m[2]);
      if (typeof v !== 'number') break sx11;
      return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'maxHandSize', value: v } }];
    }
    const d = wordToNumber(m[4]);
    if (typeof d !== 'number') break sx11;
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'maxHandSize', delta: m[3].toLowerCase() === 'reduced' ? -d : d } }];
  }
  }
  if ((m = L.match(/^Spells (your opponents cast |you cast |)that target ~ cost \{(\d+)\} (less|more) to cast$/i))) {
    const who = /opponents/i.test(m[1]) ? 'opponents' : /you cast/i.test(m[1]) ? 'controller' : 'allPlayers';
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter: { spellTargets: { nameIs: '~' } } } }];
  }
  if ((m = L.match(/^Spells you cast from (anywhere other than your hand|your graveyard or from exile|your graveyard|exile) cost \{(\d+)\} (less|more) to cast$/i))) {
    const filter: ObjectFilter = /anywhere other/i.test(m[1]) ? { notZone: 'hand' } : /graveyard or/i.test(m[1]) ? { zoneIn: ['graveyard', 'exile'] } : { zoneIn: [/graveyard/i.test(m[1]) ? 'graveyard' : 'exile'] };
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter } }];
  }
  if ((m = L.match(/^(You|Players|Each player) (?:do not|don't) lose unspent (?:\w+ )?mana as steps and phases end$/i))) return [{ kind: 'static', text: line, ruleAffects: /^you$/i.test(m[1]) ? 'controller' : 'allPlayers', rule: { kind: 'custom', tag: 'keepMana' } }];
  if ((m = L.match(/^(Players|Each player|Your opponents|Each opponent|You) cannot draw cards$/i))) return [{ kind: 'static', text: line, ruleAffects: /^you$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers', rule: { kind: 'custom', tag: 'cantDraw' } }];
  if ((m = L.match(/^(.+?) (?:is|are) every creature type$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: ['Changeling'] } }];
  }

  sx12: {
  if ((m = L.match(/^The (first|second|third|fourth) (.*?)spell you cast each turn costs \{(\d+)\} (less|more) to cast$/i))) {
    const nth = { first: 0, second: 1, third: 2, fourth: 3 }[m[1].toLowerCase() as 'first'];
    const noun = m[2].trim() ? parseNoun(`a ${m[2].trim()} spell`) : null;
    if (m[2].trim() && !noun) break sx12;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[4].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[3], 10), filter: noun ? { ...noun.filter, zone: undefined } : undefined }, condition: { kind: 'eventThisTurn', event: 'cast', player: 'you', op: '==', value: nth } }];
  }
  }
  if (/^You do not lose the game for having 0 or less life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'cantLose' } }];
  // "Each creature you control that is a Wolf or a Werewolf enters with an additional +1/+1 counter on it."
  if ((m = L.match(/^(?:Each )?(.+?) enters? with (?:an additional )?(?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on (?:it|them)$/i)) && !/^~/.test(m[1])) {
    const a = affectsOf(m[1]);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (a.ok && typeof a.affects === 'object' && typeof n === 'number') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: a.affects, counters: { counter: m[3], amount: n } }];
  }
  if ((m = L.match(/^(?:Each )?(.+?) enters? with (?:a number of additional|an additional X|X additional) ([+-]\d\/[+-]\d|\w+) counters on (?:it|them)(?: equal to (.+)|, where X is (.+))$/i)) && !/^~/.test(m[1])) {
    const a = affectsOf(m[1]);
    const amt = parseAmount(m[3] ?? m[4], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a.ok && typeof a.affects === 'object' && amt !== null) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: a.affects, counters: { counter: m[2], amount: amt } }];
  }
  // "Enchanted land is a 3/3 red Spirit creature with haste. It is still a land."
  sfall4: {
  if ((m = L.match(/^(.+?) is (?:a|an) (\d+)\/(\d+) (.+?) creature(?: with (.+?))?(?:\. (?:It|They) (?:is|are) still (?:a |an )?\w+s?| that (?:is|are) still (?:a |an )?\w+s?)?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall4;
    const words = m[4].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const rest = words.filter((w) => !/^(white|blue|black|red|green|and|colorless)$/i.test(w) && !/^[A-Z]/.test(w));
    if (rest.length) break sfall4;
    const out: AbilitySpec[] = [
      { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: ['Creature'], addSubtypes: subtypes.length ? subtypes : undefined } },
      { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } },
    ];
    if (colors.length || /colorless/i.test(m[4])) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: colors } });
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) break sfall4;
      out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
    }
    return out;
  }
  }
  if ((m = L.match(/^(.+?) can attack as though (?:it|they) (?:did not|didn't) have defender$/i))) { const _q4 = objRule(m[1], { kind: 'custom', tag: 'canAttackWithDefender' }); if (_q4) return _q4; }
  if ((m = L.match(/^Prevent all (combat )?damage that would be dealt to (.+?) during (your|each opponent's) turn$/i))) {
    const a = affectsOf(m[2]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'preventDamageTo', data: { combat: m[1] ? 'combat' : undefined } }, condition: /^your$/i.test(m[3]) ? { kind: 'yourTurn' } : { kind: 'notYourTurn' } }];
  }
  // "Prevent all combat damage that would be dealt to and dealt by enchanted creature."
  if ((m = L.match(/^Prevent all (combat )?damage that would be dealt to and dealt by (.+)$/i))) {
    const a = affectsOf(m[2]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag: 'dealsAndTakesNoDamage', data: m[1] ? 'combat' : 'all' } }];
  }
  // Static damage prevention: "Prevent all damage that would be dealt to ~ by artifact creatures." / "Prevent all combat damage that would be dealt by enchanted creature."
  sx13: {
  if ((m = L.match(/^Prevent all (combat |noncombat )?damage that would be dealt(?: to (.+?))?(?: by (.+?))?$/i)) && (m[2] || m[3])) {
    const combat = m[1] ? (m[1].trim().toLowerCase() as 'combat' | 'noncombat') : undefined;
    if (!m[2]) {
      // "...dealt by enchanted creature": the source deals no damage.
      { const _r1 = objRule(m[3], { kind: 'custom', tag: 'dealsNoDamage', data: combat ?? 'all' }); if (_r1) return _r1; }
    }
    let source: ObjectFilter | undefined;
    if (m[3] && /^creatures blocking (?:it|~)$/i.test(m[3])) source = { types: ['Creature'], blockingSource: true };
    else if (m[3] && /^sources of the (?:last )?chosen color$/i.test(m[3])) source = { chosenColor: true };
    else if (m[3]) {
      const sn = parseNoun(m[3].replace(/ sources?$/i, ' permanents').replace(/^(white|blue|black|red|green|colorless|colored|artifact|noncreature|nonblack|nonwhite|nonred|nongreen|nonblue) permanents$/i, '$1 permanent').replace(/^permanents$/i, 'permanent'));
      if (!sn) break sx13;
      source = { ...sn.filter, zone: undefined };
    }
    const rule: RuleModification = { kind: 'custom', tag: 'preventDamageTo', data: { combat, source } };
    const who = m[2].trim();
    if (/^you$/i.test(who)) return [{ kind: 'static', text: line, rule, ruleAffects: 'controller' }];
    if (/^you and (creatures|permanents) you control$/i.test(who)) {
      const a = affectsOf(who.replace(/^you and /i, ''));
      if (a.ok) return [{ kind: 'static', text: line, rule, ruleAffects: 'controller' }, { kind: 'static', text: line, affects: a.affects, rule }];
    }
    if (/^(you and )?(?:your )?planeswalkers you control$/i.test(who)) break sx13;
    { const _r2 = objRule(who, rule); if (_r2) return _r2; }
  }
  }
  if ((m = L.match(/^(.+?) (?:is|are) goaded$/i))) { const _q5 = objRule(m[1], { kind: 'custom', tag: 'goaded', data: '__controller__' }); if (_q5) return _q5; }
  if ((m = L.match(/^(.+?) loses? all abilities$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, loseAllAbilities: true } }];
  }
  if ((m = L.match(/^(.+?) (?:has|have) base power and toughness (\d+)\/(\d+)$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } }];
  }
  // "Equipped creature has base power and toughness X/X, where X is your life total."
  if ((m = L.match(/^(.+?) (?:has|have) base power and toughness (X|\*)\/(X|\*), where (?:X|\*) is (.+)$/i))) {
    const a = affectsOf(m[1]);
    const v = parseAmount(m[4], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false } as never);
    if (a.ok && v !== null) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', powerAmount: v, toughnessAmount: v } }];
  }
  // "Creature spells you cast cost {X} less to cast, where X is the amount of life you gained this turn."
  sfall5: {
  if ((m = L.match(/^(.+?) you cast cost \{X\} less to cast, where X is (.+)$/i))) {
    const per = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false } as never);
    if (per === null) break sfall5;
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) break sfall5;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: 1, filter, perAmount: per } }];
  }
  }
  sfall6: {
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) creatures? with base power and toughness (\d+)\/(\d+)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall6;
    const words = m[2].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const out: AbilitySpec[] = [
      { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: ['Creature'], addSubtypes: subtypes } },
      { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[3], 10), setToughness: parseInt(m[4], 10) } },
    ];
    if (colors.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: colors } });
    return out;
  }
  }
  sx14: {
  if ((m = L.match(/^While voting, you (?:may vote|get) an additional (?:time|vote)$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'extraVote', data: 1 } }];
  // Soulbond: "As long as ~ is paired with another creature, both creatures have protection from Zombies."
  if ((m = L.match(/^As long as ~ is paired with another creature, (?:both creatures|each of those creatures) (?:has|have) (.+)$/i))) {
    const cond = { kind: 'paired' as const };
    const quoted = m[1].match(/^"(.+)"$/);
    const mod = quoted ? { layer: 6 as const, addAbilityText: [quoted[1]] } : null;
    const kws = quoted ? null : parseKeywordList(m[1]);
    if (!mod && !kws) break sx14;
    const modification = mod ?? { layer: 6 as const, addKeywords: kws! };
    return [
      { kind: 'static', text: line, affects: 'self', modification, condition: cond },
      { kind: 'static', text: line, affects: { pairedWithSource: true }, modification, condition: cond },
    ];
  }
  }
  sx15: {
  if ((m = L.match(/^If it is neither day nor night, it becomes (day|night) as ~ enters$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: [{ kind: 'setDayNight', to: m[1].toLowerCase() === 'day' ? 'startDay' : 'startNight' }] }];
  // Draw replacements: "If you would draw a card, draw two cards instead."
  if ((m = L.match(/^If (you|a player|an opponent|each opponent) would draw (?:a card|(\w+) or more cards)(?: (while .+?|except the first one you draw in each of your draw steps))?, (?:instead (.+?)|(.+?) instead)$/i))) {
    const who: 'you' | 'opponent' | 'any' = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    const spec: Extract<import('@commander/engine').ReplacementSpec, { event: 'drawCard' }> = { kind: 'replacement', text: line, event: 'drawCard', who };
    if (m[3] && /^except the first/i.test(m[3])) spec.exceptFirstEachDrawStep = true;
    else if (m[3]) {
      const cond = parseCondition(m[3].replace(/^while /i, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (!cond || cond.kind === 'manual') break sx15;
      spec.condition = cond;
    }
    const tail = (m[4] ?? m[5]).replace(/^(?:instead )?/i, '').trim();
    const dm = tail.match(/^draw (\w+) cards?$/i);
    if (dm) {
      const n = wordToNumber(dm[1]);
      if (n === null || n === 'X') break sx15;
      spec.draws = n;
      return [spec];
    }
    const ctx = newCtx({ isSpell: false, triggerHasPlayer: true });
    const r = parseEffects(tail.replace(/^you may /i, 'you may '), ctx);
    if (r.unhandled.length || !r.effects.length) break sx15;
    spec.effects = r.effects;
    return [spec];
  }
  }
  // Amplify N: reveal cards sharing a creature type as it enters, one counter per card per N.
  if ((m = L.match(/^Amplify (\d+)$/i))) {
    const n = parseInt(m[1], 10);
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: [{ kind: 'chooseObjects', filter: { zone: 'hand', owner: 'you', sharesCreatureTypeWithSource: true }, count: 99, key: 'amplified', upTo: true }, { kind: 'revealHand', who: { ref: 'controller' } }, { kind: 'addCounters', counter: '+1/+1', amount: { kind: 'times', a: n, b: { kind: 'countRef', ref: { ref: 'chosen', key: 'amplified' } } }, on: { ref: 'self' } }] }];
  }
  // Storied: three or more artifacts, legendaries and/or Sagas gives you an enduring story for the game.
  if (/^Storied$/i.test(L)) {
    return [{ kind: 'triggered', text: line, event: 'entersBattlefield', filter: { self: true }, condition: { kind: 'count', filter: { anyOf: [{ types: ['Artifact'] }, { supertypes: ['Legendary'] }, { subtypes: ['Saga'] }], controller: 'you', zone: 'battlefield' }, op: '>=', value: 3 }, effects: [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'enduringStory' }, on: { ref: 'controller' }, duration: 'permanent' }] }];
  }
  // Increment: a counter whenever you spend more mana on a spell than this creature's power or toughness.
  if (/^Increment$/i.test(L)) {
    return [{ kind: 'triggered', text: line, event: 'cast', filter: { player: 'you' }, condition: { kind: 'manual', text: 'Was the mana spent greater than this creature\'s power or toughness?' }, effects: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: { ref: 'self' } }] }];
  }
  // "You may cast Hero spells as though they had flash." / "… this turn" is an effect, not a static.
  if ((m = L.match(/^You may cast (.+?) as though (?:they|it) had flash$/i))) {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spells?$/i, '')} spell`) ?? parseNoun(`a ${m[1]}`);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "Nontoken creatures you control are Forest lands in addition to their other types."
  if ((m = L.match(/^(.+?) (?:is|are) (.+?) in addition to (?:its|their) other types$/i))) {
    const a = affectsOf(m[1]);
    const words = m[2].split(/\s+/).filter((w) => !/^(and|a|an)$/i.test(w));
    const types = words.filter((w) => /^(artifact|creature|enchantment|land|planeswalker)s?$/i.test(w)).map((w) => w.replace(/s$/i, '')).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w) && !/^(Artifact|Creature|Enchantment|Land|Planeswalker)s?$/.test(w)).map((w) => singularize(w));
    if (a.ok && (types.length || subtypes.length)) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: types, addSubtypes: subtypes } }];
    if (a.ok && /^the chosen (?:creature )?type$/i.test(m[2])) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addSubtypesFromMemory: 'creatureType' } }];
  }
  // "Kithkin spells and Soldier spells you cast cost {1} less to cast."
  if ((m = L.match(/^(.+?) spells? and (.+?) spells? you cast cost \{(\d+)\} less to cast$/i))) {
    const a = parseNoun(`a ${m[1]} spell`);
    const b = parseNoun(`a ${m[2]} spell`);
    if (a && b) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[3], 10), filter: { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }] } } }];
  }
  // "Partner with <name>": when this enters you may search for that card.
  if ((m = L.match(/^Partner with (.+)$/i))) {
    return [{ kind: 'triggered', text: line, event: 'entersBattlefield', filter: { self: true }, optional: true, effects: [{ kind: 'searchLibrary', filter: { nameIs: m[1], zone: 'library' }, count: 1, destination: 'hand', reveal: true, shuffle: true }] }];
  }
  // "If a source an opponent controls would deal damage to you, prevent 1 of that damage."
  if ((m = L.match(/^If (?:a|an) (.+?) would deal (combat |noncombat )?damage to you, prevent (\w+) of that damage$/i))) {
    const st = m[1].replace(/\bsources?\b/i, 'permanent');
    const noun = parseNoun(st) ?? parseNoun(`a ${st}`);
    const n = wordToNumber(m[3]);
    if (noun && typeof n === 'number') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'preventDamageTo', data: { combat: m[2] ? (m[2].trim().toLowerCase() as 'combat' | 'noncombat') : undefined, source: { ...noun.filter, zone: undefined }, amount: n } } }];
  }
  // "Enchanted creature is a Flagbearer." / "Enchanted land is a Swamp."
  if ((m = L.match(/^(Enchanted|Equipped) (creature|land|permanent|artifact) is (?:a|an) ([A-Z][\w' -]*)$/))) {
    const sub = singularize(m[3]);
    const basics = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
    if (basics.includes(sub)) return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 4, setSubtypes: [sub] } }];
    return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 4, addSubtypes: [sub] } }];
  }
  // Deck-construction and ante lines have no in-game effect.
  if (/^A deck can have any number of cards named ~$/i.test(L)) return [];
  if (/^Remove ~ from your deck before playing if you(?:'re| are) not playing for ante$/i.test(L)) return [];
  // "Nonbasic lands are Mountains." / "Lands you control are Plains."
  if ((m = L.match(/^(.+?) (?:is|are) (Plains|Islands?|Swamps?|Mountains?|Forests?)$/))) {
    const a = affectsOf(m[1]);
    const sub = singularize(m[2]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, setSubtypes: [sub === 'Plain' ? 'Plains' : sub] } }];
  }
  // "Equip abilities you activate cost {1} less to activate." / "Equip costs you pay cost {1} less."
  if ((m = L.match(/^(?:(\w+) abilities you activate cost \{(\d+)\} less to activate|([\w-]+) costs you pay cost \{(\d+)\} less)$/i))) {
    const prefix = (m[1] ?? m[3]).replace(/^[a-z]/, (c) => c.toUpperCase());
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[2] ?? m[4], 10), textPrefix: prefix } } }];
  }
  // "Any player may cast Sliver spells as though they had flash."
  sx16: {
  if ((m = L.match(/^Any player may cast (.+?) as though (?:they had|it had) flash$/i))) {
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) break sx16;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter } } }];
  }
  }
  // "Activated abilities of creatures you control cost {2} less to activate."
  if ((m = L.match(/^(?:Activated )?abilities of (.+?) cost \{(\d+)\} less to activate$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[2], 10), filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } } } }];
  }
  sx17: {
  if (/^Players have no maximum hand size$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'noMaxHandSize' } }];
  // Clones
  if ((m = L.match(/^(You may have )?~ enters? (?:tapped )?as a copy of (?:any|a|an) (.+?)(?: on the battlefield)?(?:, except (.+))?$/i))) {
    // "..., except it enters with X additional +1/+1 counters on it" belongs on the replacement, not the copy.
    let etbCounters: { counter: string; amount: Amount } | undefined;
    if (m[3]) {
      const cm = m[3].match(/^(?:it|they) enters? with (?:a|an|(\w+|X)) (?:additional )?([+-]\d\/[+-]\d|\w+) counters? on (?:it|them)$/i);
      if (cm) {
        const n = cm[1] ? (cm[1].toUpperCase() === 'X' ? 'X' : wordToNumber(cm[1])) : 1;
        if (n === null) break sx17;
        etbCounters = { counter: cm[2], amount: n as Amount };
        m[3] = '';
      }
    }
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) break sx17;
    const ex = m[3] ? parseCopyExceptions(m[3].replace(/^(?:it|he|she) enters with /i, 'it has ').replace(/\bhis name\b/i, 'its name')) : undefined;
    if (m[3] && !ex) break sx17;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: /enters? tapped as a copy/i.test(L) || undefined, enterAsCopy: noun.filter, enterAsCopyOptional: !!m[1], copyExceptions: ex ?? undefined, counters: etbCounters as { counter: import('@commander/engine').CounterType; amount: Amount } | undefined }];
  }
  }
  // Rest in Peace / "If a creature an opponent controls would die, exile it instead."
  sx18: {
  if ((m = L.match(/^If (?:a|an) (.+?) would (die|be put into (a|an opponent's|your) graveyard(?: from anywhere| from the battlefield)?), exile it instead$/i))) {
    const noun = /^cards? or tokens?$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]}`);
    if (!noun) break sx18;
    const f = { ...noun.filter };
    delete f.zone;
    if (m[3] === "an opponent's") f.owner = 'opponent';
    if (m[3] === 'your') f.owner = 'you';
    const event = m[2] === 'die' || / from the battlefield$/i.test(m[2]) ? 'dies' : 'putIntoGraveyard';
    return [{ kind: 'replacement', text: line, event, self: false, filter: f, instead: 'exile' }];
  }
  }
  // Panharmonicon family
  sx19: {
  if ((m = L.match(/^If (?:a|an) (.+?) entering(?: the battlefield)? causes a triggered ability of (.+?) to trigger, that ability triggers an additional time$/i))) {
    const eo = parseNoun(`a ${m[1]}`);
    const who = parseNoun(m[2]);
    if (!eo || !who) break sx19;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who.filter, event: 'entersBattlefield', eventObject: eo.filter } } }];
  }
  }
  if ((m = L.match(/^If a creature dying causes a triggered ability of (.+?) to trigger, that ability triggers an additional time$/i))) {
    const who = parseNoun(m[1]);
    if (who) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who.filter, event: 'dies', eventObject: { types: ['Creature'] } } } }];
  }
  if ((m = L.match(/^If a triggered ability of (.+?) triggers(?: while (.+?))?, (?:that ability|it) triggers an additional time$/i))) {
    const who = parseNoun(m[1]);
    const cond = m[2] ? parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) : null;
    if (who && (!m[2] || (cond && cond.kind !== 'manual'))) {
      const spec: AbilitySpec = { kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who.filter } } };
      if (cond) spec.condition = cond;
      return [spec];
    }
  }
  // "If a creature you control attacking causes a triggered ability of a permanent you control to trigger,
  //  that ability triggers an additional time." The whole Panharmonicon family, one verb at a time.
  sx277: {
  if (/^If turning a face-down permanent face up causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i.test(L))
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: { controller: 'you' }, event: 'turnedFaceUp' } } }];
  if ((m = L.match(/^If (.+?) ((?:entering the battlefield|entering|leaving the battlefield|attacking|blocking|dying|being dealt damage|dealing combat damage to a player|drawing a card|gaining life|casting a spell|copying a spell|casting an instant or sorcery spell|copying an instant or sorcery spell|casting|copying|being turned face up|turning face up)(?: or (?:entering the battlefield|entering|leaving the battlefield|attacking|blocking|dying|being dealt damage|dealing combat damage to a player|drawing a card|gaining life|casting a spell|copying a spell|casting an instant or sorcery spell|copying an instant or sorcery spell|casting|copying|being turned face up|turning face up))?) causes a triggered ability of (.+?) to trigger, that ability triggers an additional time$/i))) {
    const EVENTS: Record<string, string> = {
      'entering the battlefield': 'entersBattlefield',
      entering: 'entersBattlefield',
      'leaving the battlefield': 'leavesBattlefield',
      attacking: 'attacks',
      blocking: 'blocks',
      dying: 'dies',
      'being dealt damage': 'dealtDamage',
      'dealing combat damage to a player': 'dealtCombatDamageToPlayer',
      'drawing a card': 'drawCard',
      'gaining life': 'lifeGained',
      'casting a spell': 'cast',
      'casting an instant or sorcery spell': 'cast',
      'copying a spell': 'spellCopied',
      casting: 'cast',
      copying: 'spellCopied',
      'copying an instant or sorcery spell': 'spellCopied',
      'being turned face up': 'turnedFaceUp',
      'turning face up': 'turnedFaceUp',
    };
    // " or " also occurs inside "an instant or sorcery spell", so split only where both halves are verbs.
    const whole = m[2].trim().toLowerCase();
    let events: (string | undefined)[] = EVENTS[whole] ? [EVENTS[whole]] : [];
    if (!events.length) {
      for (let i = whole.indexOf(' or '); i >= 0; i = whole.indexOf(' or ', i + 1)) {
        const a = EVENTS[whole.slice(0, i)];
        const b = EVENTS[whole.slice(i + 4)];
        if (a && b) {
          events = [a, b];
          break;
        }
      }
    }
    if (!events.length) break sx277;
    const who277 = parseNoun(m[3]);
    if (!who277 || !who277.confident || events.some((e) => !e)) break sx277;
    const subj = m[1].trim();
    // A player doing something has no object to filter on.
    const isPlayer = /^(?:a player|each player|you|an opponent|players|a player you control)$/i.test(subj);
    let eo277: ObjectFilter | undefined;
    if (!isPlayer) {
      const n277 = parseNoun(/^(?:a|an|each|another) /i.test(subj) ? subj : `a ${subj}`);
      if (!n277 || !n277.confident) break sx277;
      eo277 = n277.filter;
    }
    // "casting an instant or sorcery spell" also says what kind of spell.
    if (/instant or sorcery spell$/i.test(m[2]) && !eo277) eo277 = { anyOf: [{ types: ['Instant'] }, { types: ['Sorcery'] }] };
    return events.map((event) => ({ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who277.filter, event, ...(eo277 ? { eventObject: eo277 } : {}) } } }) as AbilitySpec);
  }
  }
  // Compound: "Equipped creature cannot be blocked and has shroud."
  if ((m = L.match(/^(.+?) (cannot be blocked|cannot block|cannot attack|cannot attack or block) and (?:has|have) (.+)$/i))) {
    const a = parseStatic(`${m[1]} ${m[2]}`, isCreatureOrPermanent);
    const b = parseStatic(`${m[1]} has ${m[3]}`, isCreatureOrPermanent);
    if (a && b) return [...a, ...b];
  }
  sfall7: {
  if ((m = L.match(/^(.+?) (?:is|are) not (?:a|an) (creature|artifact|enchantment|land|planeswalker)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall7;
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, removeTypes: [m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()] } }];
  }
  }
  if (/^Players cannot gain life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'cantGainLife' } }];
  if (/^Skip your draw step$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'skipDrawStep' } }];
  if (/^If ~ is in your opening hand, you may begin the game with it on the battlefield$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'leyline' }, zone: 'hand' }];
  if ((m = L.match(/^~ enters tapped unless (.+)$/i))) {
    const cond = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, unless: cond }];
  }
  // "If you control two or more other lands, ~ enters tapped."
  if ((m = L.match(/^If (.+?), ~ enters tapped$/i))) {
    const cond = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, condition: cond }];
  }
  sx20: {
  if (/^You control (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(L)) return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 'control', controller: 'sourceController' } }];
  // Self replacements on dying / leaving
  if ((m = L.match(/^If (combat )?damage would be dealt to ~(?: by (.+?))?(?: while (.+?))?, prevent that damage(?:\.|,)? (?:and |then )?(.+)$/i))) {
    const from = m[2] ? parseNoun(m[2].replace(/ sources?$/i, ' permanent')) : null;
    if (m[2] && !from) break sx20;
    const whileCond = m[3] ? parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) : null;
    if (m[3] && (!whileCond || whileCond.kind === 'manual')) break sx20;
    const ctx = newCtx({ triggerHasObject: false, triggerHasPlayer: false });
    const r = parseEffects(m[4].replace(/\bon it\b/g, 'on ~').replace(/\bfrom it\b/g, 'from ~'), ctx);
    if (r.unhandled.length) break sx20;
    return [{ kind: 'replacement', text: line, event: 'damage', prevent: 'all', to: 'self', combatOnly: !!m[1] || undefined, fromFilter: from ? { ...from.filter, zone: undefined } : undefined, condition: whileCond ?? undefined, effects: r.effects }];
  }
  }
  if (/^If ~ would (?:die|be put into a graveyard from anywhere|be put into a graveyard), exile it instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'putIntoGraveyard', self: true, instead: 'exile' }];
  if (/^If ~ would be put into a graveyard from the battlefield, (?:exile it|return it to its owner's hand|shuffle it into its owner's library) instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'dies', self: true, instead: /exile/i.test(L) ? 'exile' : /hand/i.test(L) ? 'returnToHand' : 'shuffleIntoLibrary' }];
  if (/^If ~ would leave the battlefield, exile it instead of putting it anywhere else$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'leavesBattlefield', self: true, instead: 'exile' }];
  if ((m = L.match(/^As ~ enters, you may pay (\d+) life\.? If you do not, it enters tapped$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, payLifeOrTapped: parseInt(m[1], 10) }];
  // P/T and keyword statics
  sfall8: {
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]\d+)\/([+-]\d+)(?: and (?:have|has) (.+))?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall8;
    const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } }];
    if (m[4]) {
      const quoted = m[4].match(/^"(.+)"$/);
      const kws = quoted ? null : parseKeywordList(m[4]);
      if (quoted) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: [quoted[1]] } });
      else if (kws) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
      else break sfall8;
    }
    return out;
  }
  }
  sfall9: {
  if ((m = L.match(/^(.+?) (?:have|has) "(.+)"$/i)) && !/^(you|each player|all players)/i.test(m[1])) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall9;
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: [m[2]] } }];
  }
  }
  if ((m = L.match(/^(.+?) (?:have|has) (.+)$/i)) && !/^(you|each player|each opponent|all players|players)\b/i.test(m[1])) {
    const kws = parseKeywordList(m[2]);
    if (kws) {
      const a = affectsOf(m[1]);
      if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } }];
    }
  }
  // "Enchanted land is a 3/3 black Ooze creature." / "~ is a 4/4 red Dragon artifact creature"
  sfall10: {
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (\d+)\/(\d+) (.+?) creatures?(?: with (.+))?(?: in addition to (?:its|their) other types)?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall10;
    const words = m[4].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const out: AbilitySpec[] = [
      { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: types, addSubtypes: subtypes } },
      { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } },
    ];
    if (colors.length || words.some((w) => /^colorless$/i.test(w))) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: colors } });
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) break sfall10;
      out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
    }
    return out;
  }
  }
  sfall11: {
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) in addition to (?:its|their) other (?:types|colors|land types|creature types)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall11;
    const words = m[2].split(/\s+/);
    const types = words.filter((w) => /^(creature|artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: types, addSubtypes: subtypes } }];
  }
  }
  sfall12: {
  if ((m = L.match(/^(.+?) (?:is|are) (white|blue|black|red|green|colorless)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall12;
    const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[2].toLowerCase() as 'white'];
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: c ? [c] : [] } }];
  }
  }
  // Rules on objects
  if ((m = L.match(/^(.+?) cannot block$/i))) { const _q6 = objRule(m[1], { kind: 'cantBlock' }); if (_q6) return _q6; }
  if ((m = L.match(/^(.+?) cannot attack$/i))) { const _q7 = objRule(m[1], { kind: 'cantAttack' }); if (_q7) return _q7; }
  if ((m = L.match(/^(.+?) cannot attack or block$/i))) {
    const a = objRule(m[1], { kind: 'cantAttack' });
    const b = objRule(m[1], { kind: 'cantBlock' });
    if (a && b) return [...a, ...b];
  }
  if ((m = L.match(/^(.+?) cannot be blocked$/i))) { const _q8 = objRule(m[1], { kind: 'cantBeBlocked' }); if (_q8) return _q8; }
  if ((m = L.match(/^(.+?) cannot be blocked by creatures with power (\d+) or less$/i))) { const _q9 = objRule(m[1], { kind: 'cantBeBlockedByPowerLE', power: parseInt(m[2], 10) }); if (_q9) return _q9; }
  if ((m = L.match(/^(.+?) cannot be blocked by creatures with power (\d+) or greater$/i))) { const _q10 = objRule(m[1], { kind: 'cantBeBlockedByPowerGE', power: parseInt(m[2], 10) }); if (_q10) return _q10; }
  if (/^Creatures with power less than ~'s power cannot block it$/i.test(L)) { const _q11 = objRule('~', { kind: 'cantBeBlockedByPowerLessThanSource' }); if (_q11) return _q11; }
  if ((m = L.match(/^(.+?) cannot attack unless defending player controls (?:a|an) (.+)$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) { const _q12 = objRule(m[1], { kind: 'cantAttackUnlessDefenderControls', filter: noun.filter }); if (_q12) return _q12; }
  }
  if ((m = L.match(/^(.+?) must be blocked if able$/i))) { const _q13 = objRule(m[1], { kind: 'custom', tag: 'mustBeBlocked' }); if (_q13) return _q13; }
  if ((m = L.match(/^(.+?) cannot be blocked except by (.+)$/i))) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    if (noun) { const _q14 = objRule(m[1], { kind: 'canBeBlockedOnlyBy', filter: noun.filter }); if (_q14) return _q14; }
  }
  if ((m = L.match(/^(.+?) cannot block (.+?)$/i)) && !/^(alone|unless|if)\b/i.test(m[2])) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    if (noun) { const _q15 = objRule(m[1], { kind: 'cantBlockFilter', filter: noun.filter }); if (_q15) return _q15; }
  }
  sfall13: {
  if ((m = L.match(/^(.+?) cannot be blocked by creatures with greater power$/i))) { const _q16 = objRule(m[1], { kind: 'cantBeBlockedByPowerGreaterThanSource' }); if (_q16) return _q16; }
  sfall14: {
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block) unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!cond || cond.kind === 'manual') break sfall14;
    const kinds: RuleModification['kind'][] = m[2].toLowerCase() === 'attack or block' ? ['cantAttack', 'cantBlock'] : m[2].toLowerCase() === 'attack' ? ['cantAttack'] : ['cantBlock'];
    const out: AbilitySpec[] = [];
    for (const k of kinds) {
      const r = objRule(m[1], { kind: k } as RuleModification);
      if (!r) break sfall14;
      out.push(...r.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'not' as const, c: cond } } : a)));
    }
    return out;
  }
  }
  }
  // "~ enters with a +1/+1 counter, a flying counter, a deathtouch counter, and a shield counter on it."
  sx21: {
  if ((m = L.match(/^~ enters with ((?:(?:a|an|\w+) [+-]?[\w/+-]+ counters?(?:, |,? and )?){2,}) on it$/i))) {
    const list: { counter: string; amount: Amount }[] = [];
    for (const part of m[1].split(/,\s*(?:and\s+)?|\s+and\s+/i)) {
      const pm = part.trim().match(/^(?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w' -]+?) counters?$/i);
      if (!pm) break sx21;
      const n = pm[1] ? wordToNumber(pm[1]) : 1;
      if (n === null || n === 'X') break sx21;
      list.push({ counter: pm[2], amount: n });
    }
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, countersList: list as { counter: import('@commander/engine').CounterType; amount: Amount }[] }];
  }
  }
  // "~ enters with your choice of a flying counter or a first strike counter on it." / "... of a +1/+1, first strike, or vigilance counter on it."
  sx22: {
  if ((m = L.match(/^~ enters with your choice of (?:(\w+) different counters on it from among (.+)|(.+?) counters? on it)$/i))) {
    const count = m[1] ? wordToNumber(m[1]) : 1;
    if (count === null || count === 'X') break sx22;
    const listText = m[2] ?? m[3];
    const from = listText
      .split(/,\s*(?:or\s+)?|\s+or\s+/i)
      .map((x) => x.trim().replace(/^(?:a|an) /i, '').replace(/ counters?$/i, ''))
      .filter(Boolean);
    if (from.length < 2) break sx22;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counterChoice: { from, count } }];
  }
  }
  // "~ enters with two -1/-1 counters on it unless you've cast another red spell this turn."
  if ((m = L.match(/^~ enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (cond && cond.kind !== 'manual' && n !== null && n !== 'X') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2] as import('@commander/engine').CounterType, amount: n }, condition: { kind: 'not', c: cond } }];
  }
  // "~ enters with twice X +1/+1 counters on it." / "... with X +1/+1 counters on it."
  if ((m = L.match(/^~ enters with (twice X|X) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) {
    const amount: Amount = /twice/i.test(m[1]) ? { kind: 'times', a: 'X', b: 2 } : 'X';
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2] as import('@commander/engine').CounterType, amount } }];
  }
  sx23: {
  if ((m = L.match(/^~ enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it for each (.+)$/i))) {
    const rc = { self: { ref: 'self' } as Ref, lastObj: null, triggerHasObject: false };
    const one = (phrase: string): Amount | null => {
      const n2 = parseNoun(phrase);
      if (n2) return { kind: 'count', filter: n2.filter.zone ? n2.filter : { ...n2.filter, zone: 'battlefield' } };
      return parseAmount(`the number of ${phrase}`, rc) ?? parseAmount(phrase, rc);
    };
    let per: Amount | null = one(m[3]);
    if (per === null) {
      const both = m[3].match(/^(.+?) and (?:each |for each )?(.+)$/i);
      if (both) {
        const a2 = one(both[1]);
        const b2 = a2 ? one(both[2]) : null;
        if (a2 && b2) per = { kind: 'sum', parts: [a2, b2] };
      }
    }
    if (per === null) break sx23;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: { kind: 'times', a: m[1] ? (wordToNumber(m[1]) as number) : 1, b: per } } }];
  }
  }
  if ((m = L.match(/^~ enters with (?:a number of|X) ([+-]\d\/[+-]\d|\w+) counters on it(?: equal to (.+)|, where X is (.+))$/i))) {
    const amt = parseAmount(m[2] ?? m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (amt !== null) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[1], amount: amt } }];
  }
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block) alone$/i))) { const _q17 = objRule(m[1], { kind: 'custom', tag: m[2].toLowerCase() === 'attack or block' ? 'cantAttackOrBlockAlone' : m[2].toLowerCase() === 'attack' ? 'cantAttackAlone' : 'cantBlockAlone' }); if (_q17) return _q17; }
  if ((m = L.match(/^(.+?) cannot be blocked by (.+)$/i)) && !/power|more than one|two or more/i.test(m[2])) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    if (noun) { const _q18 = objRule(m[1], { kind: 'cantBeBlockedBy', filter: noun.filter }); if (_q18) return _q18; }
  }
  if ((m = L.match(/^~ enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it if (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: m[1] ? (wordToNumber(m[1]) as number) : 1 }, condition: cond }];
  }
  if ((m = L.match(/^When you control no (.+?), sacrifice ~$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'sacrificeUnlessControl', data: noun.filter } }];
  }
  if (/^Living metal$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 4, addTypes: ['Artifact', 'Creature'] }, condition: { kind: 'yourTurn' } }];
  if ((m = L.match(/^~ enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it for each time it was kicked$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: { kind: 'times', a: m[1] ? (wordToNumber(m[1]) as number) : 1, b: { kind: 'kickCount' } } } }];
  if ((m = L.match(/^All creatures able to block (.+?) do so$/i))) { const _q19 = objRule(m[1], { kind: 'custom', tag: 'lure' }); if (_q19) return _q19; }
  if ((m = L.match(/^(.+?) can block an additional creature each combat$/i))) { const _q20 = objRule(m[1], { kind: 'custom', tag: 'extraBlock' }); if (_q20) return _q20; }
  if ((m = L.match(/^(.+?) can block any number of creatures$/i))) { const _q21 = objRule(m[1], { kind: 'custom', tag: 'extraBlock' }); if (_q21) return _q21; } // approximation: one extra
  if ((m = L.match(/^(.+?) cannot attack or block, and (?:its|their) activated abilities cannot be activated$/i))) {
    const a = objRule(m[1], { kind: 'cantAttack' });
    const b = objRule(m[1], { kind: 'cantBlock' });
    const c = objRule(m[1], { kind: 'custom', tag: 'cantActivate' });
    if (a && b && c) return [...a, ...b, ...c];
  }
  if ((m = L.match(/^(?:Activated abilities of (.+?) cannot be activated|(.+?)'s activated abilities cannot be activated)$/i))) { const _q22 = objRule(m[1] ?? m[2], { kind: 'custom', tag: 'cantActivate' }); if (_q22) return _q22; }
  if (/^You may play lands from your graveyard$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playLandsFromGraveyard' } }];
  sfall15: {
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]\d+)\/([+-]\d+) for each (.+?)(?: on the battlefield)?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) break sfall15;
    const both = m[4].match(/^(.+?) and (?:each |for each )?(.+)$/i);
    if (both && !/\b(and|or)\b/i.test(both[1])) {
      const rc = { self: { ref: 'self' } as Ref, lastObj: null, triggerHasObject: false };
      const pa = parseAmount(`the number of ${both[1]}`, rc);
      const pb = pa ? parseAmount(`the number of ${both[2]}`, rc) : null;
      if (pa && pb) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perAmount: { kind: 'sum', parts: [pa, pb] } } }];
    }
    const noun = parseNoun(m[4]) ?? parseNoun(`a ${m[4]}`);
    if (noun) {
      const f = { ...noun.filter };
      if (!f.zone) f.zone = 'battlefield';
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perCount: f } }];
    }
    const amt = parseAmount(`the number of ${m[4].replace(/^of /i, '').replace(/ counter on /, ' counters on ')}`, { self: { ref: 'self' }, lastObj: /^(?:enchanted|equipped) /i.test(m[1]) ? { ref: 'attachedTo' } : null, triggerHasObject: false });
    if (amt !== null) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perAmount: amt } }];
    break sfall15;
  }
  }
  sfall16: {
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]X|[+-]\d+)\/([+-]X|[+-]\d+), where X is (.+)$/i))) {
    const a = affectsOf(m[1]);
    const amt = parseAmount(m[4], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!a.ok || amt === null) break sfall16;
    const p = m[2].toUpperCase().includes('X') ? (m[2].startsWith('-') ? -1 : 1) : 0;
    const t = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? -1 : 1) : 0;
    const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: p, toughness: t, perAmount: amt } }];
    const fixedP = m[2].toUpperCase().includes('X') ? 0 : parseInt(m[2], 10);
    const fixedT = m[3].toUpperCase().includes('X') ? 0 : parseInt(m[3], 10);
    if (fixedP || fixedT) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: fixedP, toughness: fixedT } });
    return out;
  }
  }
  sx24: {
  if ((m = L.match(/^If (?:a|an) (.+?) would deal damage to (?:a permanent or player|a creature or player|any target|a permanent, player, or battle|a creature, planeswalker, or player), it deals (double|twice|triple|three times) that (?:much )?damage(?: to (?:that|it)[^,]*)? instead$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) break sx24;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damageMultiplier', data: { filter: f, times: /triple|three/i.test(m[2]) ? 3 : 2 } } }];
  }
  }
  sx25: {
  if ((m = L.match(/^If ~ was kicked(?: with its ((?:\{[^}]+\})+) kicker)?, it enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it and with (.+)$/i))) {
    const quoted = m[4].match(/^"(.+)"\.?$/);
    const kws = quoted ? null : parseKeywordList(m[4]);
    if (!kws && !quoted) break sx25;
    const kc: Condition = m[1] ? { kind: 'wasKickedWith', cost: m[1].toUpperCase() } : { kind: 'wasKicked' };
    return [
      { kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) as number) : 1 }, condition: kc },
      { kind: 'static', text: line, affects: 'self', modification: quoted ? { layer: 6, addAbilityText: [quoted[1]] } : { layer: 6, addKeywords: kws as string[] }, condition: kc },
    ];
  }
  }
  if ((m = L.match(/^~'s power is equal to (.+?) and its toughness is equal to (?:that number plus (\w+)|(.+))$/i))) {
    const rc = { self: { ref: 'self' } as Ref, lastObj: null, triggerHasObject: false };
    const pa = parseAmount(m[1], rc);
    const ta = m[2] ? (pa && wordToNumber(m[2]) !== null ? ({ kind: 'sum', parts: [pa, wordToNumber(m[2]) as number] } as Amount) : null) : parseAmount(m[3], rc);
    if (pa && ta) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', powerAmount: pa, toughnessAmount: ta } }];
  }
  sx26: {
  if ((m = L.match(/^~'s (power|toughness) is equal to (.+)$/i))) {
    const amt = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!amt) break sx26;
    return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', ...(m[1].toLowerCase() === 'power' ? { powerAmount: amt } : { toughnessAmount: amt }) } }];
  }
  }
  if ((m = L.match(/^~'s power and toughness are each equal to (.+)$/i))) {
    const amt = parseAmount(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (amt) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', powerAmount: amt, toughnessAmount: amt } }];
  }
  if ((m = L.match(/^If you would gain life, you gain that much life plus (\w+) instead$/i))) return [{ kind: 'replacement', text: line, event: 'lifeGain', add: wordToNumber(m[1]) as number, who: 'you' }];
  if ((m = L.match(/^If ~ was kicked(?: with its ((?:\{[^}]+\})+) kicker)?, it enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) as number) : 1 }, condition: m[1] ? { kind: 'wasKickedWith', cost: m[1].toUpperCase() } : { kind: 'wasKicked' } }];
  if ((m = L.match(/^(.+?) cannot be blocked by more than one creature$/i))) { const _q23 = objRule(m[1], { kind: 'maxBlockers', count: 1 }); if (_q23) return _q23; }
  if ((m = L.match(/^(?:During your turn, )?you may (?:play|cast) cards( you do not own)? with (\w+) counters on them from exile(?:, and mana of any type can be spent to cast (?:those spells|them))?$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playExiledWithCounter', data: { counter: m[2], notOwned: !!m[1], yourTurn: /^During your turn/i.test(L), anyMana: /mana of any type/i.test(L) } } }];
  if ((m = L.match(/^(.+?) cannot be blocked except by (\w+) or more creatures$/i)) && wordToNumber(m[2]) !== null) { const _q24 = objRule(m[1], { kind: 'custom', tag: 'minBlockers', data: wordToNumber(m[2]) }); if (_q24) return _q24; }
  if ((m = L.match(/^(.+?) can block only creatures with flying$/i))) { const _q25 = objRule(m[1], { kind: 'custom', tag: 'blockOnlyFlying' }); if (_q25) return _q25; }
  if ((m = L.match(/^(.+?) attacks? each combat if able$/i))) { const _q26 = objRule(m[1], { kind: 'mustAttack' }); if (_q26) return _q26; }
  if ((m = L.match(/^(.+?) (?:does not|do not) untap during (?:your|its controller's|their controllers'|their controller's) untap steps?(?: unless (.+))?$/i))) sx27u: {
    const _q27 = objRule(m[1], { kind: 'cantUntap' });
    if (!_q27) break sx27u;
    if (!m[2]) return _q27;
    const c27 = parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!c27 || c27.kind === 'manual') break sx27u;
    return _q27.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'not' as const, c: c27 } } : a));
  }
  if ((m = L.match(/^(.+?) cannot be countered$/i))) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantBeCountered' } }];
  // "~ cannot be the target of nongreen spells or abilities from nongreen sources."
  if ((m = L.match(/^(.+?) cannot be the target of (.+?) spells or abilities from \2 sources$/i))) {
    const noun = parseNoun(`a ${m[2]} spell`);
    if (noun) { const _q28 = objRule(m[1], { kind: 'cantBeTargeted', filter: { ...noun.filter, zone: undefined } }); if (_q28) return _q28; }
  }
  // "Untap all creatures you control during each other player's untap step."
  if ((m = L.match(/^Untap (?:all|each) (.+?) during each other player's untap step$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'untapEachUntapStep', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "Players cannot untap more than one artifact during their untap steps."
  if ((m = L.match(/^Players cannot untap more than (\w+) (.+?) during their untap steps$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    const n = wordToNumber(m[1]);
    if (noun && typeof n === 'number') return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'untapLimit', data: { count: n, filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "If ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner's library instead."
  if (/^If ~ would be put into a graveyard from anywhere, (?:reveal ~ and )?shuffle it into its owner's library instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'putIntoGraveyard', self: true, instead: 'shuffleIntoLibrary' }];
  // "Forests you control are 1/1 green Elf creatures that are still lands."
  if ((m = L.match(/^(.+?) are (\d+)\/(\d+)(?: (white|blue|black|red|green|colorless))?(?: ([A-Z][\w' -]*?))? creatures that are still lands$/))) {
    const a = affectsOf(m[1]);
    const col = m[4] ? ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: undefined } as Record<string, string | undefined>)[m[4].toLowerCase()] : undefined;
    if (a.ok) {
      const out: import('@commander/engine').AbilitySpec[] = [
        { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: ['Creature'], addSubtypes: m[5] ? m[5].split(/\s+/) : [] } },
        { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } },
      ];
      if (m[4]) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: col ? [col as never] : [] } });
      return out;
    }
  }
  if ((m = L.match(/^(.+?) cannot be the target of spells or abilities your opponents control$/i))) { const _q29 = objRule(m[1], { kind: 'cantBeTargeted', by: 'opponents' }); if (_q29) return _q29; }
  if ((m = L.match(/^(.+?) cannot be the target of (.+?) spells(?: or abilities)?( your opponents control)?$/i))) {
    const noun = parseNoun(`a ${m[2]} spell`);
    if (noun) { const _q30 = objRule(m[1], { kind: 'cantBeTargeted', by: 'spells', filter: { ...noun.filter, zone: undefined, controller: m[3] ? 'opponent' : undefined } }); if (_q30) return _q30; }
  }
  // "Damage is not removed from ~ during cleanup steps."
  if ((m = L.match(/^Damage is not removed from (.+?) during cleanup steps$/i))) { const _q191a = objRule(m[1], { kind: 'custom', tag: 'damagePersists' }); if (_q191a) return _q191a; }
  // "Abilities you activate that aren't mana abilities cost {2} less to activate."
  if ((m = L.match(/^Abilities you activate that (?:aren't|are not) mana abilities cost \{(\d+)\} less to activate$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[1], 10), notMana: true } } }];
  }
  if ((m = L.match(/^(.+?) cannot (attack|block|attack or block) unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') {
      const tag = m[2].toLowerCase() === 'attack' ? 'cantAttack' : m[2].toLowerCase() === 'block' ? 'cantBlock' : 'cantAttackOrBlock';
      const a = affectsOf(m[1]);
      if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag }, condition: { kind: 'not', c: cond } }];
    }
  }
  if ((m = L.match(/^Prevent all (?:combat )?damage that would be dealt to (.+)$/i))) { const _q31 = objRule(m[1], { kind: 'damagePrevention', amount: 'all' }); if (_q31) return _q31; }
  if ((m = L.match(/^Prevent all damage that would be dealt to you$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'damagePrevention', amount: 'all' } }];
  // Player-level rules
  // "You may cast legendary spells and artifact spells as though they had flash."
  if ((m = L.match(/^You may cast (.+?) as though (?:they|it) had flash$/i))) {
    if (/^spells$/i.test(m[1])) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castAsThoughFlash' } }];
    const parts = m[1].split(/ and /i).map((x) => parseNoun(x.replace(/ spells?$/i, ' spell')));
    if (parts.every((x) => x)) {
      const f = parts.length === 1 ? { ...parts[0]!.filter, zone: undefined } : { anyOf: parts.map((x) => ({ ...x!.filter, zone: undefined })) };
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: f } } }];
    }
  }
  // "Artifact spells you cast have convoke." / "Artifact creature spells you cast have affinity for artifacts."
  // "~ has all activated abilities of all creature cards in all graveyards."
  if ((m = L.match(/^(.+?) (?:has|have) all activated abilities of (.+?)$/i))) {
    const a = affectsOf(m[1]);
    const src = m[2].replace(/ exiled with (?:~|it)$/i, ' exiled with ~');
    const noun = /^all cards exiled with ~$/i.test(src) ? { filter: { exiledWithSource: true, zone: 'exile' } as ObjectFilter } : parseNoun(src);
    if (a.ok && noun) {
      const f: ObjectFilter = { ...noun.filter };
      if (!f.zone) f.zone = 'battlefield';
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addActivatedAbilitiesFrom: f } }];
    }
  }
  // "Spells you cast have cascade." → a cast trigger that discovers for one less than the spell's mana value.
  if ((m = L.match(/^(.+?) you cast(?: from (exile|your graveyard))? have cascade$/i))) {
    const casc = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(m[1].replace(/ spells?$/i, ' spell'));
    if (casc) {
      const f: ObjectFilter = { ...casc.filter, zone: undefined };
      return [{ kind: 'triggered', text: line, event: 'cast', filter: { player: 'you', object: f, fromZone: m[2] ? (/exile/i.test(m[2]) ? 'exile' : 'graveyard') : undefined }, effects: [{ kind: 'discover', amount: { kind: 'sum', parts: [{ kind: 'manaValue', ref: { ref: 'triggerObject' } }, -1] } }] }];
    }
  }
  if ((m = L.match(/^(.+?) you cast(?: from (?:exile|your graveyard))? have (convoke|improvise|delve|affinity for (.+))$/i))) {
    const spell = /^spells$/i.test(m[1]) ? { filter: {} } : parseNoun(m[1].replace(/ spells?$/i, ' spell'));
    if (spell) {
      const f = { ...spell.filter, zone: undefined };
      if (m[3]) {
        const per = parseNoun(m[3]) ?? parseNoun(`a ${singularize(m[3])}`);
        if (per) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: 1, filter: f, per: { ...per.filter, controller: 'you', zone: 'battlefield' } } }];
      } else {
        return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'grantSpellKeyword', data: { keyword: m[2].toLowerCase(), filter: f } } }];
      }
    }
  }
  // "Artifact and enchantment spells your opponents cast cost {2} more to cast."
  if ((m = L.match(/^(.+?) (?:your opponents|each opponent) casts? cost \{(\d)\} more to cast$/i))) {
    const words = m[1].replace(/ spells?$/i, '').split(/,? and |, /i).map((w) => w.trim()).filter(Boolean);
    const parts = words.map((w) => parseNoun(`a ${w} spell`));
    if (parts.every((x) => x)) {
      const f = parts.length === 1 ? { ...parts[0]!.filter, zone: undefined } : { anyOf: parts.map((x) => ({ ...x!.filter, zone: undefined })) };
      return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'costIncrease', amount: parseInt(m[2], 10), filter: f } }];
    }
  }
  // "Creatures entering do not cause abilities to trigger."
  if ((m = L.match(/^(.+?) entering(?: the battlefield)?(?: or dying)? do not cause abilities to trigger$/i))) {
    const words = m[1].split(/,? and |, /i).map((w) => w.trim()).filter(Boolean);
    const parts = words.map((w) => parseNoun(w));
    if (parts.every((x) => x)) {
      const f = parts.length === 1 ? { ...parts[0]!.filter, zone: undefined } : { anyOf: parts.map((x) => ({ ...x!.filter, zone: undefined })) };
      return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noEtbTriggers', data: { filter: f } } }];
    }
  }
  // The "legend rule" does not apply to tokens you control.
  if ((m = L.match(/^The "legend rule" does not apply to (.+)$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'noLegendRule', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  // "You may reveal ~ from your opening hand. If you do, at the beginning of the first upkeep, X."
  if ((m = L.match(/^You may reveal ~ from your opening hand\. If you do, (.+)$/i))) {
    let rest = m[1];
    let event: import('@commander/engine').GameEventName | null = null;
    let filter: import('@commander/engine').TriggerFilter | undefined;
    let mm: RegExpMatchArray | null;
    if ((mm = rest.match(/^at the beginning of (?:the|your) first upkeep, (.+)$/i))) {
      event = 'beginningOfUpkeep';
      filter = /your first/i.test(rest) ? { player: 'you' } : undefined;
      rest = mm[1];
    } else if ((mm = rest.match(/^(.+?) at the beginning of (?:the|your) first upkeep$/i))) {
      event = 'beginningOfUpkeep';
      filter = /your first/i.test(rest) ? { player: 'you' } : undefined;
      rest = mm[1];
    } else if ((mm = rest.match(/^at the beginning of your first main phase of the game, (.+)$/i))) {
      event = 'beginningOfPrecombatMain';
      filter = { player: 'you' };
      rest = mm[1];
    } else if ((mm = rest.match(/^when each opponent casts their first spell of the game, (.+)$/i))) {
      event = 'cast';
      filter = { player: 'opponent' };
      rest = mm[1];
    }
    if (event) {
      const ctx2 = newCtx({ triggerHasObject: event === 'cast', triggerHasPlayer: true });
      const r = parseEffects(rest, ctx2);
      if (!r.unhandled.length && r.effects.length) {
        return [{ kind: 'static', text: line, ruleAffects: 'controller', zone: 'hand', rule: { kind: 'custom', tag: 'openingHandReveal', data: { effects: [{ kind: 'delayedTrigger', event, filter, effects: r.effects, text: rest, once: true }] } } }];
      }
    }
  }
  // "If ~ is in your opening hand, you may begin the game with ~ on the battlefield."
  if (/^If ~ is in your opening hand, you may begin the game with (?:~|him|her|them) on the battlefield$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', zone: 'hand', rule: { kind: 'custom', tag: 'leyline' } }];
  // "Spells you cast of the chosen type cost {1} less to cast."
  if ((m = L.match(/^Spells you cast of the chosen type cost \{(\d)\} less to cast$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[1], 10), filter: { typeIsChosen: 'cardType' } } }];
  }
  // "Untap ~ during each other player's untap step."
  if ((m = L.match(/^Untap ~ during each other player's untap step$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'untapEachUntapStep', data: { filter: { nameIs: '~' } } } }];
  }
  // "~ is also a Cleric, Rogue, Warrior, and Wizard."
  if ((m = L.match(/^~ is also (?:a|an) ([A-Z][\w' -]*(?:, [A-Z][\w' -]*)*(?:,? and [A-Z][\w' -]*)?)$/))) {
    const subs = m[1].split(/,? and |, /).map((w) => w.trim()).filter(Boolean);
    return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 4, addSubtypes: subs } }];
  }
  // "Cards in graveyards cannot be the targets of spells or abilities."
  if (/^Cards in graveyards cannot be the targets of spells or abilities$/i.test(L)) {
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'graveyardsUntargetable' } }];
  }
  // "If ~ would be destroyed, regenerate it."
  if (/^If ~ would be destroyed, regenerate it$/i.test(L)) {
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'regenerationShield' } }];
  }
  // "Damage that would reduce your life total to less than 1 reduces it to 1 instead."
  if ((m = L.match(/^Damage that would reduce your life total to less than (\d+) reduces it to \1 instead$/i))) {
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'lifeFloor', data: parseInt(m[1], 10) } }];
  }
  // "Creatures cannot attack you unless their controller pays {2} for each creature they control that is attacking you."
  if ((m = L.match(/^(.+?) cannot attack you(?: or planeswalkers you control)? unless their controller pays ((?:\{[^}]+\})+)(?: for each (?:creature they control that is attacking you(?: or a planeswalker you control)?|of those creatures))?$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'attackTax', data: { filter: { ...noun.filter, zone: undefined }, cost: m[2] } } }];
  }
  // "Creature spells you cast cost {1} less to cast for each +1/+1 counter on ~."
  sfall17: {
  if ((m = L.match(/^(.+?) you cast cost \{(\d)\} less to cast for each (.+)$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    const per = parseAmount(`the number of ${m[3]}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) break sfall17;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    if (per !== null) {
      if (typeof per === 'object' && per.kind === 'count') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter, per: per.filter } }];
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter, perAmount: per } }];
    }
  }
  }

  if (/^You have no maximum hand size(?: for as long as you control ~)?$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'noMaxHandSize' } }];
  if (/^You have hexproof$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'hexproof' } }];
  if (/^You have shroud$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'shroud' } }];
  if (/^You cannot lose the game and your opponents cannot win the game$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'cantLose' } }];
  if ((m = L.match(/^You may play (?:an additional land|(\w+) additional lands) on each of your turns$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'extraLandDrop', count: m[1] ? (wordToNumber(m[1]) as number) ?? 1 : 1 } }];
  // "White spells you cast cost {W} more to cast."
  if ((m = L.match(/^(.+?) you cast cost ((?:\{[WUBRGC]\})+) more to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    let filterOk = true;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) filterOk = false;
      else {
        filter = { ...noun.filter };
        delete filter.zone;
      }
    }
    if (filterOk) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costIncrease', amount: (m[2].match(/\{/g) ?? []).length, symbols: m[2], filter } }];
  }
  sx27: {
  if ((m = L.match(/^(.*?)creatures? cannot attack you(?: or planeswalkers you control)?$/i))) {
    const pre = m[1].trim();
    let filter: ObjectFilter | undefined;
    if (pre) {
      const noun = parseNoun(`a ${pre} creature`);
      if (!noun) break sx27;
      filter = { ...noun.filter };
      delete filter.zone;
    } else filter = { types: ['Creature'] };
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'cantBeAttacked', data: { filter } } }];
  }
  }
  // Deck-construction rules have no in-game effect, but record them so the card counts as understood.
  if (/^A deck with this (?:commander|card as its commander) can have .+$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'deckConstruction' } }];
  if (/^(?:the )?damage cannot be prevented$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noDamagePrevention' } }];
  sfall18: {
  if ((m = L.match(/^(.+?) you cast cost ((?:\{[WUBRGC\d]\})+) (less|more) to cast$/i)) || (m = L.match(/^(.+?) cost ((?:\{[WUBRGC\d]\})+) (less|more) to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) break sfall18;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    const generic = m[2].match(/^\{(\d)\}$/);
    const kind = m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease';
    if (!generic && /\d/.test(m[2])) break sfall18;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: generic ? { kind, amount: parseInt(generic[1], 10), filter } : { kind, amount: 0, symbols: m[2], filter } }];
  }
  }
  sfall19: {
  if ((m = L.match(/^(.+?) your opponents cast cost \{(\d)\} more to cast$/i))) {
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) break sfall19;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'costIncrease', amount: parseInt(m[2], 10), filter } }];
  }
  }
  // Replacement: ETB
  sx28: {
  if (/^~ enters tapped$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true }];
  if ((m = L.match(/^~ enters (?:the battlefield )?with (?:a|an|(\w+|X)) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) break sx28;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: n } }];
  }
  }
  sx29: {
  if ((m = L.match(/^~ enters (?:the battlefield )?tapped with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) break sx29;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, counters: { counter: m[2], amount: n } }];
  }
  }
  if ((m = L.match(/^As ~ enters, (?:secretly )?choose (a color(?: other than \w+)?|an opponent|a creature type|a planeswalker type|a card name|a nonland card name|a player|a number(?: greater than 0)?|a basic land type|a card type|a permanent type|odd or even|(?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)(?:, (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle))*(?:,? or (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle))|[A-Z]\w+ or [A-Z]\w+)$/i))) {
    const c = m[1].toLowerCase();
    const base = { kind: 'replacement' as const, text: line, event: 'entersBattlefield' as const, self: true as const };
    if (c.startsWith('a color')) return [{ ...base, choose: 'color' }];
    if (c === 'an opponent') return [{ ...base, choose: 'opponent' }];
    if (c === 'a creature type') return [{ ...base, choose: 'creatureType' }];
    if (c === 'a planeswalker type') return [{ ...base, choose: 'option', chooseOptions: ['Jace', 'Chandra', 'Liliana', 'Nissa', 'Gideon', 'Ajani', 'Teferi', 'Kaya', 'Garruk', 'Vraska'], chooseKey: 'planeswalkerType' }];
    if (c === 'a permanent type') return [{ ...base, choose: 'option', chooseOptions: ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'], chooseKey: 'cardType' }];
    if (/^(?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)(?:,| or )/.test(c)) return [{ ...base, choose: 'option', chooseOptions: m[1].split(/,? or |, /).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase().trim()), chooseKey: 'cardType' }];
    if (/card name/.test(c)) return [{ ...base, choose: 'cardName' }];
    if (c === 'a player') return [{ ...base, choose: 'player' }];
    if (c.startsWith('a number')) return [{ ...base, choose: 'number' }];
    if (c === 'a basic land type') return [{ ...base, choose: 'option', chooseOptions: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'], chooseKey: 'landType' }];
    if (c === 'a card type') return [{ ...base, choose: 'option', chooseOptions: ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Battle', 'Kindred'], chooseKey: 'cardType' }];
    if (c === 'odd or even') return [{ ...base, choose: 'option', chooseOptions: ['odd', 'even'], chooseKey: 'choice' }];
    return [{ ...base, choose: 'option', chooseOptions: m[1].split(' or '), chooseKey: 'choice' }];
  }
  sx30: {
  if ((m = L.match(/^As ~ enters, you may reveal (?:a|an) (.+?) card from your hand\.? If you do not, (?:~|it) enters tapped$/i))) {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) break sx30;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, unless: { kind: 'count', filter: { ...noun.filter, zone: 'hand', owner: 'you' }, op: '>=', value: 1 } }];
  }
  }
  sx31: {
  if (/^If it is neither day nor night, it becomes day as ~ enters$/i.test(L)) return [{ kind: 'static', text: line }]; // day/night is not modeled; nothing else to do
  // Several statics in one line: "~ enters tapped. As it enters, choose a color."
  if (/\. [A-Z]/.test(L)) {
    const parts = L.split(/\. (?=[A-Z])/).map((p) => p.replace(/^As it enters/i, 'As ~ enters')).filter((p) => !isNoOpSentence(p));
    const out: AbilitySpec[] = [];
    for (const p of parts) {
      const r = parseStatic(p, isCreatureOrPermanent);
      if (!r) break sx31;
      out.push(...r);
    }
    return out;
  }
  }
  sfall20: {
  if ((m = L.match(/^(.+?) (?:enter|enters) with (?:an additional|a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on (?:it|them)$/i)) && !/^~/.test(m[1]) && parseNoun(m[1])) {
    const noun = parseNoun(m[1]);
    if (!noun) break sfall20;
    const f = { ...noun.filter };
    delete f.zone;
    if (noun.other) f.other = true;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: f, counters: { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) as number) : 1 } }];
  }
  }
  sfall21: {
  if ((m = L.match(/^(.+?) (?:enter|enters) tapped$/i)) && !/^~/.test(m[1]) && parseNoun(m[1])) {
    const noun = parseNoun(m[1]);
    if (!noun) break sfall21;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: f, tapped: true }];
  }
  }
  // Doublers
  if (/^If (?:you would create|an effect would create) one or more tokens(?: under your control)?, (?:create|it creates) twice that many (?:of those )?tokens instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 1 }];
  if (/^If (?:an effect would place|you would put) one or more counters on a permanent you control, (?:it places|put) twice that many (?:of each of those kinds of counters )?(?:counters )?on (?:that permanent|it) instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'counterAdded', extra: 0, multiply: 2 }];
  // "If one or more +1/+1 counters would be put on a creature you control, twice that many … instead."
  if ((m = L.match(/^If one or more ([+-]\d\/[+-]\d|\w+) counters would be put on (?:a|an|another) (.+?) you control, (twice that many|that many plus (?:one|two|three)) (?:(?:[+-]\d\/[+-]\d|\w+) )?counters? are put on (?:it|that creature|that permanent) instead$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) {
      const spec: AbilitySpec = { kind: 'replacement', text: line, event: 'counterAdded', counterType: m[1], filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, multiply: /twice/i.test(m[3]) ? 2 : 1, extra: /plus one/i.test(m[3]) ? 1 : /plus two/i.test(m[3]) ? 2 : /plus three/i.test(m[3]) ? 3 : 0 };
      return [spec];
    }
  }
  // "If one or more tokens would be created under your control, twice that many of those tokens are created instead."
  if ((m = L.match(/^If (?:one or more (?:(.+?) )?tokens would be created under your control, those tokens plus (.+?) are created instead|you would create one or more (?:(.+?) )?tokens?, instead create those tokens plus (.+?))$/i))) {
    const kindText = (m[1] ?? m[3] ?? '').trim();
    const extraText = (m[2] ?? m[4] ?? '').trim().replace(/[.]$/, '');
    const tok = parseTokenPhrase(extraText.replace(/^an additional /i, 'a '));
    if (tok && (!kindText || /^creature$/i.test(kindText))) {
      return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 0, alsoToken: tok.token, creatureOnly: /^creature$/i.test(kindText) || undefined }];
    }
  }
  sx32: {
  if ((m = L.match(/^If you would create one or more (?:(.+?) )?tokens?, (?:create those tokens plus an additional (.+?) token instead|instead create those tokens plus an additional (.+?) token)$/i))) {
    const noun = !m[1] ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]} token`);
    if (!noun) break sx32;
    return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 1 }];
  }
  }
  // "If ~ would enter, sacrifice an untapped Mountain instead."
  sx33: {
  if ((m = L.match(/^If ~ would enter, (sacrifice .+?) instead(?:\. If you do, put ~ onto the battlefield\. If you do not, put it into its owner's graveyard)?$/i))) {
    const r = parseEffects(m[1], newCtx({ triggerHasObject: false, triggerHasPlayer: false }));
    if (r.unhandled.length) break sx33;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: r.effects }];
  }
  }
  if (/^If one or more tokens would be created under your control, twice that many (?:of those )?tokens are created instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 1 }];
  if ((m = L.match(/^If one or more \+1\/\+1 counters would be put on (a|another) creature you control, that many plus (one|two) \+1\/\+1 counters are put on it instead$/i))) return [{ kind: 'replacement', text: line, event: 'counterAdded', extra: m[2].toLowerCase() === 'two' ? 2 : 1, counterType: '+1/+1', filter: { types: ['Creature'], controller: 'you', other: m[1].toLowerCase() === 'another' || undefined } }];
  if (/^If you would gain life, you gain twice that much life instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'lifeGain', multiply: 2, who: 'you' }];
  if (/^If an opponent would gain life, that player gains no life instead$/i.test(L) || /^Your opponents cannot gain life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'cantGainLife' } }];
  // ---- Round 128 ----
  // "Creatures with power 2 or less cannot attack you." / "... cannot attack you or planeswalkers you control."
  if ((m = L.match(/^(.+?) cannot attack (you|you or planeswalkers you control|you or a planeswalker you control)$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'cantAttackYou' } }];
  }
  if ((m = L.match(/^(.+?) cannot block (~|it|equipped creature|enchanted creature)$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'cantBlockSource' } }];
  }
  if ((m = L.match(/^(.+?) cannot become untapped$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'cantUntap' } }];
  }
  if ((m = L.match(/^(.+?) can only attack alone$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'attacksAlone' } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) snow$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, modification: { layer: 4, addSupertypes: ['Snow'] } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) the chosen colou?r$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, modification: { layer: 5, setColorsFromMemory: 'color' } }];
  }
  if ((m = L.match(/^(.+?) (?:has|have) landwalk of the chosen type$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'chosenLandwalk' } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) ([\w ,]+?) and loses all other card types$/i))) {
    const probe = parseNoun(`a ${m[2]}`);
    const aff = affectsOf(m[1]);
    if (aff.ok && probe && probe.filter.types?.length) return [{ kind: 'static', text: line, affects: aff.affects, modification: { layer: 4, setTypes: probe.filter.types } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) ((?:[A-Z][a-z]+)(?:, [A-Z][a-z]+)*(?:,? and [A-Z][a-z]+))$/))) {
    const subs = m[2].split(/,? and |, /).map((x) => x.trim()).filter(Boolean);
    const aff = affectsOf(m[1]);
    if (aff.ok && subs.length >= 2) return [{ kind: 'static', text: line, affects: aff.affects, modification: { layer: 4, setSubtypes: subs } }];
  }
  if ((m = L.match(/^(.+? spells?) you cast of the chosen type costs? \{(\d+)\} (less|more) to cast$/i))) {
    const noun = parseNoun(m[1].replace(/ spells$/i, ' spell'));
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter: { ...noun.filter, zone: undefined, chosenSubtypeKey: 'creatureType' } } }];
  }
  // ---- Round 126 ----
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]\d+)\/([+-]\d+) for every (\w+) (.+)$/i))) {
    const a = parseAmount(`every ${m[4]} ${m[5]}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    const aff = affectsOf(m[1]);
    if (a !== null && aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perAmount: a } }];
  }
  if (/^~ cannot attack during extra turns$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantAttackExtraTurns' } }];
  if (/^~ cannot be equipped$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantBeEquipped' } }];
  if ((m = L.match(/^(.+?) cannot be the target of (?:spells or )?abilities your opponents control$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'cantBeTargeted', by: 'opponents' } }];
  }
  if ((m = L.match(/^(.+?) cannot have more than (\w+) ([\w'-]+) counters? on (?:it|them)$/i))) {
    const n = wordToNumber(m[2]);
    const aff = affectsOf(m[1]);
    if (typeof n === 'number' && aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'maxCounters', data: { counter: m[3], max: n } } }];
  }
  if ((m = L.match(/^(.+?) can block (?:an additional (\w+) creatures?|(\w+) additional creatures?) each combat$/i))) {
    const n = wordToNumber(m[2] ?? m[3] ?? 'one');
    const aff = affectsOf(m[1]);
    if (typeof n === 'number' && aff.ok) {
      const out: AbilitySpec[] = [];
      for (let i = 0; i < n; i++) out.push({ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'extraBlock' } });
      return out;
    }
  }
  if ((m = L.match(/^(.+?) can block (.+?) as though it had (\w+)$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'canBlockAsThough', data: m[3].toLowerCase() } }];
  }
  if ((m = L.match(/^(.+?) (?:has|have) (.+?) during your turn$/i))) {
    const kws = parseKeywordList(m[2]);
    const aff = affectsOf(m[1]);
    if (kws && aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, modification: { layer: 6, addKeywords: kws }, condition: { kind: 'yourTurn' } }];
  }
  if (/^~ is every nonbasic land type$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'allNonbasicLandTypes' } }];
  if ((m = L.match(/^(.+?) must be blocked by exactly one creature if able$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'mustBeBlocked' } }];
  }
  if ((m = L.match(/^(.+?) (?:crews Vehicles|saddles Mounts and crews Vehicles) using its toughness rather than its power$/i))) {
    const aff = affectsOf(m[1]);
    if (aff.ok) return [{ kind: 'static', text: line, affects: aff.affects, rule: { kind: 'custom', tag: 'crewByToughness' } }];
  }
  // ---- Round 121 ----
  if (/^You have no maximum hand size(?: until your next turn| for as long as you control ~)?$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'noMaxHandSize' } }];
  if (/^You cannot get poison counters$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'noPoison' } }];
  if (/^You cannot play lands or cast spells from your hand$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'noPlayFromHand' } }];
  if ((m = L.match(/^You cannot untap more than (\w+) (.+?) during your untap step$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'untapLimit', data: { count: n } } }];
  }
  if (/^You cannot become the monarch(?: this turn)?$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'cantBecomeMonarch' } }];
  if ((m = L.match(/^You can spend mana of any (?:type|color) to cast (.+)$/i))) {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(m[1].replace(/ spells$/i, ' spell'));
    if (noun && noun.confident) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'anyManaFor', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }
  if (/^You may activate equip abilities any time you could cast an instant$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'equipAsInstant' } }];
  // ---- Round 119 ----
  // "The first spell you cast each turn has cascade." / "The next creature spell you cast this turn has cascade."
  if ((m = L.match(/^The (first|next) (.*?)spells? you cast (?:from exile )?(?:each turn|this turn) (?:has|have) (.+)$/i))) {
    const kws = parseKeywordList(m[3]);
    const pre = m[2].trim();
    const noun = pre ? parseNoun(`a ${pre} spell`) : { filter: {} as ObjectFilter, confident: true };
    if (kws && noun && noun.confident) {
      const cond: import('@commander/engine').Condition = { kind: 'eventThisTurn', event: 'cast', player: 'you', op: '==', value: 0 };
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'spellsHaveKeywords', data: { filter: { ...noun.filter, zone: undefined }, keywords: kws, fromExile: /from exile/i.test(L) || undefined } }, condition: cond }];
    }
  }
  if ((m = L.match(/^The (first|next) (.*?)spells? you cast (?:each turn|this turn) costs? \{(\d+)\} (less|more) to cast$/i))) {
    const pre = m[2].trim();
    const noun = pre ? parseNoun(`a ${pre} spell`) : { filter: {} as ObjectFilter, confident: true };
    if (noun && noun.confident) {
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[4].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[3], 10), filter: pre ? { ...noun.filter, zone: undefined } : undefined }, condition: { kind: 'eventThisTurn', event: 'cast', player: 'you', op: '==', value: 0 } }];
    }
  }
  // ---- Round 118 ----
  if (/^Players skip their untap steps$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'skipStep', data: 'untap' } }];
  if (/^Players skip their upkeep steps$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'skipStep', data: 'upkeep' } }];
  if (/^Players skip their draw steps$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'skipStep', data: 'draw' } }];
  if (/^Players cannot cycle cards$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noCycling' } }];
  if (/^Players cannot search libraries(?: this turn)?$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noSearch' } }];
  if (/^Players cannot activate planeswalkers' loyalty abilities$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noLoyaltyAbilities' } }];
  if (/^Players can cast spells only during their own turns$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'castOnlyOwnTurn' } }];
  if (/^Permanents with ice counters on them are snow$/i.test(L)) return [{ kind: 'static', text: line, affects: { counterAtLeast: { counter: 'ice', n: 1 }, zone: 'battlefield' }, modification: { layer: 4, addSupertypes: ['Snow'] } }];
  if (/^Permanents enter tapped this turn$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: {}, tapped: true }];
  // ---- Round 112 ----
  if ((m = L.match(/^(.+?) can attack as though it had haste$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: ['Haste'] } }];
  }
  if ((m = L.match(/^(Enchanted|Equipped) (\w+)'s activated abilities cost \{(\d+)\} (less|more) to activate$/i))) {
    return [{ kind: 'static', text: line, affects: 'attachedTo', rule: { kind: 'custom', tag: 'abilityCostChange', data: { amount: parseInt(m[3], 10) * (/less/i.test(m[4]) ? -1 : 1) } } }];
  }
  // ---- Round 110 ----
  // "Each Saga spell you cast has replicate." / "Each instant and sorcery spell you cast has casualty 1."
  if ((m = L.match(/^(?:Each |All )?(.+? spells?) you cast (?:from exile )?(?:has|have) (.+)$/i))) {
    const kws = parseKeywordList(m[2]);
    const noun = /^spells?$/i.test(m[1]) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(m[1].replace(/ spells$/i, ' spell'));
    if (kws && noun && noun.confident) {
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'spellsHaveKeywords', data: { filter: { ...noun.filter, zone: undefined }, keywords: kws, fromExile: /from exile/i.test(L) || undefined } } }];
    }
  }
  // "During turns other than yours, <static>."
  if ((m = L.match(/^During turns other than yours, (.+)$/i))) {
    const inner = parseStatic(m[1], isCreatureOrPermanent);
    if (inner) return inner.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'notYourTurn' as const } } : a));
  }
  if ((m = L.match(/^During (?:each|any) opponent's turn, (.+)$/i))) {
    const inner = parseStatic(m[1], isCreatureOrPermanent);
    if (inner) return inner.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'notYourTurn' as const } } : a));
  }
  // ---- Round 109 ----
  if (/^Combat damage cannot be prevented$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'noDamagePrevention' } }];
  if (/^Combat damage that would be dealt by creatures you control cannot be prevented$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'noDamagePrevention' } }];
  // ---- Round 108 ----
  // "~ cannot attack unless you pay {2}" / "... unless you sacrifice a land": a cost to attack or block.
  if ((m = L.match(/^(~|Enchanted \w+|Equipped \w+) cannot (attack or block|attack|block) unless you (.+)$/i))) {
    const costText = m[3].replace(/^pay /i, (w) => w).replace(/^[a-z]/, (ch) => ch.toUpperCase());
    const cost = parseCost(costText.replace(/^Pay ((?:\{[^}]+\})+)(?: for each .+)?$/i, '$1'));
    if (cost) {
      const a = affectsOf(m[1]);
      const tags = m[2].toLowerCase() === 'attack or block' ? ['attackCost', 'blockCost'] : m[2].toLowerCase() === 'attack' ? ['attackCost'] : ['blockCost'];
      if (a.ok) return tags.map((tag) => ({ kind: 'static' as const, text: line, affects: a.affects, rule: { kind: 'custom' as const, tag, data: { cost } } }));
    }
  }
  // ---- Round 107 ----
  // "~ is a black Zombie in addition to its other colors and types."
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an)? ?(.+?) in addition to (?:its|their) other (?:colors and types|types and colors|colors|types|creature types|card types)$/i))) {
    const a = affectsOf(m[1]);
    const probe = parseNoun(`a ${m[2]}`);
    if (a.ok && probe && probe.confident) {
      const mod: Record<string, unknown> = { layer: 4 };
      if (probe.filter.types?.length) mod.addTypes = probe.filter.types;
      if (probe.filter.subtypes?.length) mod.addSubtypes = probe.filter.subtypes;
      const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: mod as never }];
      if (probe.filter.colors?.length) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, addColors: probe.filter.colors } });
      return out;
    }
  }
  // "If at least three white mana was spent to cast ~, ~ enters with a +1/+1 counter on it."
  if ((m = L.match(/^If (.+?), (~ enters? with .+|~ enters? tapped.*)$/i))) {
    const cond = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    const inner = cond && cond.kind !== 'manual' ? parseStatic(m[2], isCreatureOrPermanent) : null;
    if (inner && cond) return inner.map((ab) => (ab.kind === 'replacement' ? { ...ab, condition: cond } : ab));
  }
  // "If you would create a Food token, instead create a Food token and a Treasure token."
  if ((m = L.match(/^If you would create (?:a|an) (.+?) token, (?:instead create|create) (?:a|an) \1 token and (?:a|an) (.+?) token(?: instead)?$/i))) {
    const tok = parseTokenPhrase(`a ${m[2]} token`);
    if (tok) return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 0, alsoToken: tok.token }];
  }
  // "If a source would deal 3 or less damage to ~, prevent that damage."
  if ((m = L.match(/^If (?:a|an) source would deal (\d+) or less damage to (~|you), prevent that damage$/i))) {
    return [{ kind: 'replacement', text: line, event: 'damage', prevent: parseInt(m[1], 10), to: /^you$/i.test(m[2]) ? 'controller' : 'self' }];
  }
  // ---- Round 106 ----
  if (/^damage does not cause you to lose life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'damageNoLifeLoss' } }];
  if ((m = L.match(/^(.+?) gets an additional ([+-]\d+)\/([+-]\d+)$/i))) {
    const r = parseStatic(`${m[1]} gets ${m[2]}/${m[3]}`, isCreatureOrPermanent);
    if (r) return r;
  }
  // ---- Round 104 ----
  // "~ is a land." / "~ is an artifact in addition to its other types."
  if ((m = L.match(/^(~|Enchanted \w+|Equipped \w+) (?:is|are) (?:a|an) ((?:artifact|creature|enchantment|land|planeswalker|battle)(?: (?:artifact|creature|enchantment|land|planeswalker|battle))*)( in addition to its other types)?$/i))) {
    const a = affectsOf(m[1]);
    const tys = m[2].split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: m[3] ? { layer: 4, addTypes: tys } : { layer: 4, setTypes: tys } }];
  }
  // "As ~ enters, <effects>" — a generic ETB replacement whose body compiles as plain effects.
  if ((m = L.match(/^As ~ enters, (.+)$/i))) {
    const c = newCtx({ triggerHasObject: false, triggerHasPlayer: false });
    const r = parseEffects(m[1], c);
    if (!r.unhandled.length && r.effects.length && !c.targets.length) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: r.effects }];
  }
  // ---- Round 103 ----
  // "You may cast ~ from exile."
  if (/^You may cast ~ from exile$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'castFromExileSelf' } }];
  // "Damage that would be dealt by ~ cannot be prevented."
  if (/^Damage that would be dealt by ~ cannot be prevented$/i.test(L) || /^Damage cannot be prevented$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'noDamagePrevention' } }];
  // "~ gets +2/+2 and creatures you control have vigilance": two independent statics joined by "and".
  if (/ and /i.test(L) && !/"/.test(L) && !/^(?:as long as|while|during|if)\b/i.test(L)) {
    for (const mm of [...L.matchAll(/ and /gi)].reverse()) {
      if (mm.index === undefined || mm.index < 4) continue;
      const left = L.slice(0, mm.index).trim().replace(/,$/, '');
      const right = L.slice(mm.index + 5).trim();
      if (!left || !right || !/\s/.test(right)) continue;
      const a = parseStatic(left, isCreatureOrPermanent);
      if (!a) continue;
      let b = parseStatic(right, isCreatureOrPermanent);
      if (!b) {
        // "Fish you control have haste and cannot be blocked by Humans": share the left subject.
        const sub = left.match(/^(.+?) (?:has|have|gets?|cannot|can|is|are|loses?|gains?|does not|doesn't|enters?|attacks?|blocks?|assigns?|must)\b/i);
        if (sub) b = parseStatic(`${sub[1]} ${right}`, isCreatureOrPermanent);
      }
      if (!b) continue;
      return [...a, ...b];
    }
  }
  if ((m = L.match(/^~ cannot attack alone unless (.+?)$/i))) {
    const c310 = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (c310 && c310.kind !== 'manual')
      return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantAttackAlone' }, condition: { kind: 'not', c: c310 } }];
  }
  // "If a source would deal damage to you, prevent that damage" is the same rule as "If damage
  // would be dealt to you, ...", which is the phrasing the patterns above know.
  if ((m = L.match(/^If a source would deal (combat |noncombat )?damage to (.+?), (.+)$/i))) {
    const inner = parseStatic(`If ${m[1] ?? ''}damage would be dealt to ${m[2]}, ${m[3]}`, isCreatureOrPermanent);
    if (inner) return inner;
  }
  // "Creatures you control get +1/+1 for as long as you control a Forest." — the same condition,
  // trailing instead of leading. Tried on every " if "/" as long as " boundary, longest first.
  {
    const cuts: number[] = [];
    for (const mm of L.matchAll(/ (?:for as long as|as long as|while|only if|if) /gi)) if (mm.index !== undefined) cuts.push(mm.index);
    for (const k of cuts.reverse()) {
      const head = L.slice(0, k);
      const condText = L.slice(k).replace(/^ (?:for as long as|as long as|while|only if|if) /i, '');
      const cond = parseCondition(condText, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (!cond || cond.kind === 'manual') continue;
      const inner = parseStatic(head, isCreatureOrPermanent);
      if (!inner || !inner.length || !inner.every((a) => a.kind === 'static')) continue;
      return inner.map((a) => (a.kind === 'static' ? { ...a, condition: a.condition ? ({ kind: 'and', cs: [a.condition, cond] } as Condition) : cond } : a));
    }
  }
  // "Creatures you control get +1/+1 during your turn." — the timing clause may trail instead.
  if ((m = L.match(/^(.+?) during (your|each opponent's|each player's|an opponent's|each of your opponents') turns?$/i))) {
    const inner = parseStatic(`During ${m[2]} turn, ${m[1]}`, isCreatureOrPermanent);
    if (inner) return inner;
  }
  // "As long as ~ has a counter on it, it can attack as though it didn't have defender." /
  // "If there are three or more Lesson cards in your graveyard, you may cast ~ as though it had
  // flash." A leading condition applies to whatever static follows it.
  if ((m = L.match(/^(?:As long as|While|If) (.+?), (.+)$/i))) {
    const cond301 = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond301 && cond301.kind !== 'manual') {
      const rest = m[2];
      const tries = [rest, rest.replace(/^it /i, '~ '), rest.replace(/^they /i, '~ ')];
      for (const t of tries) {
        const inner = parseStatic(t.charAt(0).toUpperCase() + t.slice(1), isCreatureOrPermanent);
        if (!inner) continue;
        return inner.map((a) =>
          a.kind === 'static' ? { ...a, condition: a.condition ? ({ kind: 'and', cs: [a.condition, cond301] } as Condition) : cond301 } : a,
        );
      }
    }
  }
  // Sagas & others are handled by the orchestrator.
  void isCreatureOrPermanent;
  return null;
}
