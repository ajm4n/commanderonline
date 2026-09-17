/** Static abilities and replacement effects. */
import type { AbilitySpec, Amount, ObjectFilter, Ref, RuleModification, StaticAbilitySpec } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { parseKeywordList, isNoOpSentence, parseEffects, newCtx, parseCopyExceptions, parseTokenPhrase } from './effects.js';
import { wordToNumber } from './text.js';
import { parseCondition } from './conditions.js';
import { parseAmount } from './amounts.js';

function affectsOf(text: string): { affects: StaticAbilitySpec['affects']; ok: boolean } {
  const l = text.trim().toLowerCase();
  if (l === '~') return { affects: 'self', ok: true };
  if (/^(enchanted|equipped|fortified) (creature|permanent|land|artifact|planeswalker)$/.test(l)) return { affects: 'attachedTo', ok: true };
  const noun = parseNoun(text.trim());
  if (!noun) return { affects: undefined, ok: false };
  const f: ObjectFilter = { ...noun.filter };
  if (noun.other) f.other = true;
  if (!f.zone) f.zone = 'battlefield';
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
  // "~ is all colors."
  if (/^~ is all colors$/i.test(L)) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: 5, setColors: ['W', 'U', 'B', 'R', 'G'] } }];
  // "~ attacks or blocks each combat if able." / "~ blocks each combat if able."
  if ((m = L.match(/^(.+?) (attacks or blocks|blocks) each combat if able$/i))) {
    const rules: RuleModification['kind'][] = m[2].toLowerCase() === 'blocks' ? ['mustBlock'] : ['mustAttack', 'mustBlock'];
    const out: AbilitySpec[] = [];
    for (const k of rules) {
      const r = objRule(m[1], { kind: k } as RuleModification);
      if (!r) return null;
      out.push(...r);
    }
    return out;
  }
  // "~ cannot be blocked except by creatures with flying or reach."
  if ((m = L.match(/^(.+?) cannot be blocked except by (.+)$/i))) {
    const kw = m[2].match(/^creatures with (.+)$/i);
    const kws = kw ? parseKeywordList(kw[1].replace(/ or /g, ' and ')) : null;
    const noun = kws?.length ? null : parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
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
  if (/^Each player may play an additional land on each of their turns$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'extraLandDrop', count: 1 } }];
  // "During turns other than yours, spells you cast cost {1} less to cast."
  if ((m = L.match(/^During turns other than yours, (.+?) you cast cost \{(\d)\} less to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter }, condition: { kind: 'not', c: { kind: 'yourTurn' } } }];
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
  if ((m = L.match(/^(?:As long as|While) (.+?), (.+)$/i))) [condText, innerText] = [m[1], m[2]];
  else if ((m = L.match(/^(.+?) (?:as long as|while) (.+)$/i))) [condText, innerText] = [m[2], m[1]];
  else if ((m = L.match(/^((?:~|Enchanted \w+|Equipped \w+) (?:does not untap|cannot|gets|has) .+?) if (.+)$/i))) [condText, innerText] = [m[2], m[1]];
  if (condText && innerText) {
    // "As long as ~ is attacking, it gets +2/+0": "it" is this permanent.
    if (/^it (gets|has|is|can|cannot|assigns|must|does|loses|gains|deals)\b/i.test(innerText) && /^(?:~|it)\b/i.test(condText)) innerText = innerText.replace(/^it /i, '~ ');
    else if (/^it (gets|has|is|can|cannot|assigns|must|does|loses|gains|deals)\b/i.test(innerText) && /^(?:enchanted|equipped) (creature|permanent)/i.test(condText)) innerText = innerText.replace(/^it /i, condText.match(/^(?:enchanted|equipped) (?:creature|permanent)/i)![0] + ' ');
    else if (/^it (gets|has|is|can|cannot|assigns|must|does|loses|gains|deals)\b/i.test(innerText)) innerText = innerText.replace(/^it /i, '~ ');
    const inner = parseStatic(innerText, isCreatureOrPermanent);
    if (inner) {
      const cond = parseCondition(condText, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) ?? { kind: 'manual' as const, text: condText };
      if (cond.kind === 'manual') return null; // can't evaluate statics interactively
      return inner.map((a) => (a.kind === 'static' ? { ...a, condition: cond } : a));
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
  if ((m = L.match(/^(.+?) assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power$/i))) return objRule(m[1], { kind: 'custom', tag: 'damageByToughness' });
  // "Creatures cannot block unless their controller pays {1} for each of those creatures."
  if ((m = L.match(/^(.+?) cannot block unless their controller pays ((?:\{[^}]+\})+)(?: for each of those creatures)?$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'custom', tag: 'blockTax', data: { filter: { ...noun.filter, zone: undefined }, cost: m[2] } } }];
  }
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block) unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') {
      const rules: RuleModification[] = m[2].toLowerCase() === 'attack or block' ? [{ kind: 'cantAttack' }, { kind: 'cantBlock' }] : m[2].toLowerCase() === 'attack' ? [{ kind: 'cantAttack' }] : [{ kind: 'cantBlock' }];
      const out: AbilitySpec[] = [];
      for (const rule of rules) {
        const r = objRule(m[1], rule);
        if (!r) return null;
        out.push(...r.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'not' as const, c: cond } } : a)));
      }
      return out;
    }
  }
  // "You may play lands and cast creature spells from the top of your library."
  if ((m = L.match(/^You may (play lands and cast (.+?) spells|play lands|cast (.+?) spells(?: and (.+?) spells)?|play cards|cast spells|play lands and cast spells) from the top of your library$/i))) {
    const what = m[1].toLowerCase();
    const spellNoun = m[2] ?? m[3];
    let filter = spellNoun ? parseNoun(`a ${spellNoun} spell`)?.filter : undefined;
    if (spellNoun && !filter) return null;
    if (filter && m[4]) {
      const second = parseNoun(`a ${m[4]} spell`)?.filter;
      if (!second) return null;
      filter = { anyOf: [{ ...filter, zone: undefined }, { ...second, zone: undefined }] };
    }
    const data = { lands: /play lands|play cards/.test(what), spells: /cast|play cards/.test(what), filter: filter ? { ...filter, zone: undefined } : undefined };
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playFromTop', data } }];
  }
  if ((m = L.match(/^As ~ enters, choose (a color|a creature type|an opponent|a player|a card name|a number) and (a color|a creature type|an opponent|a player|a card name|a number)$/i))) {
    const a = parseStatic(`As ~ enters, choose ${m[1]}`, isCreatureOrPermanent);
    const b = parseStatic(`As ~ enters, choose ${m[2]}`, isCreatureOrPermanent);
    if (a && b) return [...a, ...b];
  }
  // "~ escapes with three +1/+1 counters on it."
  if ((m = L.match(/^~ escapes with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w' -]+?) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, condition: { kind: 'memoryFlag', key: 'escaped' }, counters: { counter: m[2], amount: n } }];
  }
  // "~ can't attack a player it has already attacked this turn."
  if (/^~ cannot attack a player it has already attacked this turn$/i.test(L)) return objRule('~', { kind: 'custom', tag: 'onePlayerPerTurn' });
  // "Enchanted land is the chosen type."
  if ((m = L.match(/^(.+?) (?:is|are) the chosen type$/i))) {
    const a = affectsOf(m[1]);
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addSubtypesFromMemory: 'landType' } }];
  }
  if (/^You may have ~ assign its combat damage as though it weren't blocked$/i.test(L)) return objRule('~', { kind: 'custom', tag: 'assignAsUnblocked' });
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
  if ((m = L.match(/^If a source you control would deal (noncombat |combat )?damage to (an opponent or a permanent an opponent controls|a permanent or player|an opponent|a player or permanent), it deals that much damage plus (\d+|an amount of damage equal to .+?) (?:to (?:that permanent or player|that player|them) )?instead$/i))) {
    const plusAmt = /^\d+$/.test(m[3]) ? parseInt(m[3], 10) : parseAmount(m[3].replace(/^an amount of damage equal to /i, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (plusAmt === null) return null;
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damagePlus', data: { filter: { controller: 'you' }, plus: plusAmt, noncombatOnly: /noncombat/i.test(m[1] ?? '') || undefined, combatOnly: /^combat/i.test(m[1] ?? '') || undefined, toOpponents: /opponent/i.test(m[2]) || undefined } } }];
  }
  // "Once during each of your turns, you may cast an artifact or Human spell from your graveyard with mana value less than or equal to X."
  if (/^You may cast ~ from your graveyard using its mutate ability$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { nameIs: '~' } } } }];
  if ((m = L.match(/^(Once during each of your turns, )?[Yy]ou may cast (.+?) (?:spells? )?from your graveyard(?: with mana value (?:less than or equal to|equal to or less than) (.+?))?$/i))) {
    const noun = parseNoun(`a ${m[2].replace(/^(?:a|an) /i, '').replace(/ spells?$/i, '')} spell`);
    if (noun) {
      const filter = { ...noun.filter, zone: undefined as undefined };
      if (m[3]) {
        const amt = parseAmount(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
        if (amt === null) return null;
        filter.cmcLEAmount = amt;
      }
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter, oncePerTurn: !!m[1] || undefined } } }];
    }
  }
  if ((m = L.match(/^(Each player|Players|Your opponents|Each opponent|You) cannot cast more than (\w+) spells? each turn$/i))) {
    const n = wordToNumber(m[2]);
    if (typeof n !== 'number') return null;
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
      if (!noun) return null;
      data.filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'custom', tag: 'cantCastSpells', data } }];
  }

  if ((m = L.match(/^All (combat )?damage that would be dealt to (you|you and other permanents you control|you and creatures you control|enchanted creature's controller|you and permanents you control) is dealt to (~|enchanted creature) instead$/i))) {
    const permanents = /permanents|creatures/i.test(m[2]);
    return [{ kind: 'static', text: line, affects: /^~$/i.test(m[3]) ? 'self' : 'attachedTo', rule: { kind: 'custom', tag: 'redirectDamage', data: { player: true, permanents, combatOnly: !!m[1] || undefined } } }];
  }
  if ((m = L.match(/^(Your|Each player's|Each opponent's) maximum hand size is (?:(\w+)|(reduced|increased) by (\w+))$/i))) {
    const who = /^your$/i.test(m[1]) ? 'controller' : /opponent/i.test(m[1]) ? 'opponents' : 'allPlayers';
    if (m[2]) {
      const v = wordToNumber(m[2]);
      if (typeof v !== 'number') return null;
      return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'maxHandSize', value: v } }];
    }
    const d = wordToNumber(m[4]);
    if (typeof d !== 'number') return null;
    return [{ kind: 'static', text: line, ruleAffects: who, rule: { kind: 'maxHandSize', delta: m[3].toLowerCase() === 'reduced' ? -d : d } }];
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

  if ((m = L.match(/^The (first|second|third|fourth) (.*?)spell you cast each turn costs \{(\d+)\} (less|more) to cast$/i))) {
    const nth = { first: 0, second: 1, third: 2, fourth: 3 }[m[1].toLowerCase() as 'first'];
    const noun = m[2].trim() ? parseNoun(`a ${m[2].trim()} spell`) : null;
    if (m[2].trim() && !noun) return null;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[4].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[3], 10), filter: noun ? { ...noun.filter, zone: undefined } : undefined }, condition: { kind: 'eventThisTurn', event: 'cast', player: 'you', op: '==', value: nth } }];
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
  if ((m = L.match(/^(.+?) is (?:a|an) (\d+)\/(\d+) (.+?) creature(?: with (.+?))?(?:\. (?:It|They) (?:is|are) still (?:a |an )?\w+s?| that (?:is|are) still (?:a |an )?\w+s?)?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
    const words = m[4].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const rest = words.filter((w) => !/^(white|blue|black|red|green|and|colorless)$/i.test(w) && !/^[A-Z]/.test(w));
    if (rest.length) return null;
    const out: AbilitySpec[] = [
      { kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: ['Creature'], addSubtypes: subtypes.length ? subtypes : undefined } },
      { kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } },
    ];
    if (colors.length || /colorless/i.test(m[4])) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: colors } });
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) return null;
      out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
    }
    return out;
  }
  if ((m = L.match(/^(.+?) can attack as though (?:it|they) didn't have defender$/i))) return objRule(m[1], { kind: 'custom', tag: 'canAttackWithDefender' });
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
  if ((m = L.match(/^Prevent all (combat |noncombat )?damage that would be dealt(?: to (.+?))?(?: by (.+?))?$/i)) && (m[2] || m[3])) {
    const combat = m[1] ? (m[1].trim().toLowerCase() as 'combat' | 'noncombat') : undefined;
    if (!m[2]) {
      // "...dealt by enchanted creature": the source deals no damage.
      return objRule(m[3], { kind: 'custom', tag: 'dealsNoDamage', data: combat ?? 'all' });
    }
    let source: ObjectFilter | undefined;
    if (m[3] && /^creatures blocking (?:it|~)$/i.test(m[3])) source = { types: ['Creature'], blockingSource: true };
    else if (m[3] && /^sources of the (?:last )?chosen color$/i.test(m[3])) source = { chosenColor: true };
    else if (m[3]) {
      const sn = parseNoun(m[3].replace(/ sources?$/i, ' permanents').replace(/^(white|blue|black|red|green|colorless|colored|artifact|noncreature|nonblack|nonwhite|nonred|nongreen|nonblue) permanents$/i, '$1 permanent').replace(/^permanents$/i, 'permanent'));
      if (!sn) return null;
      source = { ...sn.filter, zone: undefined };
    }
    const rule: RuleModification = { kind: 'custom', tag: 'preventDamageTo', data: { combat, source } };
    const who = m[2].trim();
    if (/^you$/i.test(who)) return [{ kind: 'static', text: line, rule, ruleAffects: 'controller' }];
    if (/^you and (creatures|permanents) you control$/i.test(who)) {
      const a = affectsOf(who.replace(/^you and /i, ''));
      if (a.ok) return [{ kind: 'static', text: line, rule, ruleAffects: 'controller' }, { kind: 'static', text: line, affects: a.affects, rule }];
    }
    if (/^(you and )?(?:your )?planeswalkers you control$/i.test(who)) return null;
    return objRule(who, rule);
  }
  if ((m = L.match(/^(.+?) (?:is|are) goaded$/i))) return objRule(m[1], { kind: 'custom', tag: 'goaded', data: '__controller__' });
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
  if ((m = L.match(/^(.+?) you cast cost \{X\} less to cast, where X is (.+)$/i))) {
    const per = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false } as never);
    if (per === null) return null;
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: 1, filter, perAmount: per } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) creatures? with base power and toughness (\d+)\/(\d+)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
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
  if ((m = L.match(/^While voting, you (?:may vote|get) an additional (?:time|vote)$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'extraVote', data: 1 } }];
  // Soulbond: "As long as ~ is paired with another creature, both creatures have protection from Zombies."
  if ((m = L.match(/^As long as ~ is paired with another creature, (?:both creatures|each of those creatures) (?:has|have) (.+)$/i))) {
    const cond = { kind: 'paired' as const };
    const quoted = m[1].match(/^"(.+)"$/);
    const mod = quoted ? { layer: 6 as const, addAbilityText: [quoted[1]] } : null;
    const kws = quoted ? null : parseKeywordList(m[1]);
    if (!mod && !kws) return null;
    const modification = mod ?? { layer: 6 as const, addKeywords: kws! };
    return [
      { kind: 'static', text: line, affects: 'self', modification, condition: cond },
      { kind: 'static', text: line, affects: { pairedWithSource: true }, modification, condition: cond },
    ];
  }
  if ((m = L.match(/^If it is neither day nor night, it becomes (day|night) as ~ enters$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: [{ kind: 'setDayNight', to: m[1].toLowerCase() === 'day' ? 'startDay' : 'startNight' }] }];
  // Draw replacements: "If you would draw a card, draw two cards instead."
  if ((m = L.match(/^If (you|a player|an opponent|each opponent) would draw (?:a card|(\w+) or more cards)(?: (while .+?|except the first one you draw in each of your draw steps))?, (?:instead (.+?)|(.+?) instead)$/i))) {
    const who: 'you' | 'opponent' | 'any' = /^you$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
    const spec: Extract<import('@commander/engine').ReplacementSpec, { event: 'drawCard' }> = { kind: 'replacement', text: line, event: 'drawCard', who };
    if (m[3] && /^except the first/i.test(m[3])) spec.exceptFirstEachDrawStep = true;
    else if (m[3]) {
      const cond = parseCondition(m[3].replace(/^while /i, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (!cond || cond.kind === 'manual') return null;
      spec.condition = cond;
    }
    const tail = (m[4] ?? m[5]).replace(/^(?:instead )?/i, '').trim();
    const dm = tail.match(/^draw (\w+) cards?$/i);
    if (dm) {
      const n = wordToNumber(dm[1]);
      if (n === null || n === 'X') return null;
      spec.draws = n;
      return [spec];
    }
    const ctx = newCtx({ isSpell: false, triggerHasPlayer: true });
    const r = parseEffects(tail.replace(/^you may /i, 'you may '), ctx);
    if (r.unhandled.length || !r.effects.length) return null;
    spec.effects = r.effects;
    return [spec];
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
    const subtypes = words.filter((w) => /^[A-Z]/.test(w) && !/^(Artifact|Creature|Enchantment|Land|Planeswalker)s?$/.test(w)).map((w) => w.replace(/s$/, ''));
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
    const sub = m[3].replace(/s$/, '');
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
    const sub = m[2].replace(/^Plains$/, 'Plains').replace(/s$/, '');
    if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, setSubtypes: [sub === 'Plain' ? 'Plains' : sub] } }];
  }
  // "Equip abilities you activate cost {1} less to activate." / "Equip costs you pay cost {1} less."
  if ((m = L.match(/^(?:(\w+) abilities you activate cost \{(\d+)\} less to activate|([\w-]+) costs you pay cost \{(\d+)\} less)$/i))) {
    const prefix = (m[1] ?? m[3]).replace(/^[a-z]/, (c) => c.toUpperCase());
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[2] ?? m[4], 10), textPrefix: prefix } } }];
  }
  // "Any player may cast Sliver spells as though they had flash."
  if ((m = L.match(/^Any player may cast (.+?) as though (?:they had|it had) flash$/i))) {
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter } } }];
  }
  // "Activated abilities of creatures you control cost {2} less to activate."
  if ((m = L.match(/^(?:Activated )?abilities of (.+?) cost \{(\d+)\} less to activate$/i))) {
    const noun = parseNoun(m[1]);
    if (noun) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'abilityCostReduction', data: { amount: parseInt(m[2], 10), filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } } } }];
  }
  if (/^Players have no maximum hand size$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'noMaxHandSize' } }];
  // Clones
  if ((m = L.match(/^(You may have )?~ enters? (?:tapped )?as a copy of (?:any|a|an) (.+?)(?: on the battlefield)?(?:, except (.+))?$/i))) {
    // "..., except it enters with X additional +1/+1 counters on it" belongs on the replacement, not the copy.
    let etbCounters: { counter: string; amount: Amount } | undefined;
    if (m[3]) {
      const cm = m[3].match(/^(?:it|they) enters? with (?:a|an|(\w+|X)) (?:additional )?([+-]\d\/[+-]\d|\w+) counters? on (?:it|them)$/i);
      if (cm) {
        const n = cm[1] ? (cm[1].toUpperCase() === 'X' ? 'X' : wordToNumber(cm[1])) : 1;
        if (n === null) return null;
        etbCounters = { counter: cm[2], amount: n as Amount };
        m[3] = '';
      }
    }
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const ex = m[3] ? parseCopyExceptions(m[3].replace(/^(?:it|he|she) enters with /i, 'it has ').replace(/\bhis name\b/i, 'its name')) : undefined;
    if (m[3] && !ex) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: /enters? tapped as a copy/i.test(L) || undefined, enterAsCopy: noun.filter, enterAsCopyOptional: !!m[1], copyExceptions: ex ?? undefined, counters: etbCounters as { counter: import('@commander/engine').CounterType; amount: Amount } | undefined }];
  }
  // Rest in Peace / "If a creature an opponent controls would die, exile it instead."
  if ((m = L.match(/^If (?:a|an) (.+?) would (die|be put into (a|an opponent's|your) graveyard(?: from anywhere| from the battlefield)?), exile it instead$/i))) {
    const noun = /^cards? or tokens?$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const f = { ...noun.filter };
    delete f.zone;
    if (m[3] === "an opponent's") f.owner = 'opponent';
    if (m[3] === 'your') f.owner = 'you';
    const event = m[2] === 'die' || / from the battlefield$/i.test(m[2]) ? 'dies' : 'putIntoGraveyard';
    return [{ kind: 'replacement', text: line, event, self: false, filter: f, instead: 'exile' }];
  }
  // Panharmonicon family
  if ((m = L.match(/^If (?:a|an) (.+?) entering(?: the battlefield)? causes a triggered ability of (.+?) to trigger, that ability triggers an additional time$/i))) {
    const eo = parseNoun(`a ${m[1]}`);
    const who = parseNoun(m[2]);
    if (!eo || !who) return null;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who.filter, event: 'entersBattlefield', eventObject: eo.filter } } }];
  }
  if ((m = L.match(/^If a creature dying causes a triggered ability of (.+?) to trigger, that ability triggers an additional time$/i))) {
    const who = parseNoun(m[1]);
    return who ? [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who.filter, event: 'dies', eventObject: { types: ['Creature'] } } } }] : null;
  }
  if ((m = L.match(/^If a triggered ability of (.+?) triggers, that ability triggers an additional time$/i))) {
    const who = parseNoun(m[1]);
    return who ? [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'doubleTriggers', data: { filter: who.filter } } }] : null;
  }
  // Compound: "Equipped creature cannot be blocked and has shroud."
  if ((m = L.match(/^(.+?) (cannot be blocked|cannot block|cannot attack|cannot attack or block) and (?:has|have) (.+)$/i))) {
    const a = parseStatic(`${m[1]} ${m[2]}`, isCreatureOrPermanent);
    const b = parseStatic(`${m[1]} has ${m[3]}`, isCreatureOrPermanent);
    if (a && b) return [...a, ...b];
  }
  if ((m = L.match(/^(.+?) (?:is|are) not (?:a|an) (creature|artifact|enchantment|land|planeswalker)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, removeTypes: [m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()] } }];
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
  if (/^You control (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(L)) return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 'control', controller: 'sourceController' } }];
  // Self replacements on dying / leaving
  if ((m = L.match(/^If (combat )?damage would be dealt to ~(?: by (.+?))?(?: while (.+?))?, prevent that damage(?:\.|,)? (?:and |then )?(.+)$/i))) {
    const from = m[2] ? parseNoun(m[2].replace(/ sources?$/i, ' permanent')) : null;
    if (m[2] && !from) return null;
    const whileCond = m[3] ? parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) : null;
    if (m[3] && (!whileCond || whileCond.kind === 'manual')) return null;
    const ctx = newCtx({ triggerHasObject: false, triggerHasPlayer: false });
    const r = parseEffects(m[4].replace(/\bon it\b/g, 'on ~').replace(/\bfrom it\b/g, 'from ~'), ctx);
    if (r.unhandled.length) return null;
    return [{ kind: 'replacement', text: line, event: 'damage', prevent: 'all', to: 'self', combatOnly: !!m[1] || undefined, fromFilter: from ? { ...from.filter, zone: undefined } : undefined, condition: whileCond ?? undefined, effects: r.effects }];
  }
  if (/^If ~ would (?:die|be put into a graveyard from anywhere|be put into a graveyard), exile it instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'putIntoGraveyard', self: true, instead: 'exile' }];
  if (/^If ~ would be put into a graveyard from the battlefield, (?:exile it|return it to its owner's hand|shuffle it into its owner's library) instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'dies', self: true, instead: /exile/i.test(L) ? 'exile' : /hand/i.test(L) ? 'returnToHand' : 'shuffleIntoLibrary' }];
  if (/^If ~ would leave the battlefield, exile it instead of putting it anywhere else$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'leavesBattlefield', self: true, instead: 'exile' }];
  if ((m = L.match(/^As ~ enters, you may pay (\d+) life\.? If you do not, it enters tapped$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, payLifeOrTapped: parseInt(m[1], 10) }];
  // P/T and keyword statics
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]\d+)\/([+-]\d+)(?: and (?:have|has) (.+))?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
    const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10) } }];
    if (m[4]) {
      const quoted = m[4].match(/^"(.+)"$/);
      const kws = quoted ? null : parseKeywordList(m[4]);
      if (quoted) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: [quoted[1]] } });
      else if (kws) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
      else return null;
    }
    return out;
  }
  if ((m = L.match(/^(.+?) (?:have|has) "(.+)"$/i)) && !/^(you|each player|all players)/i.test(m[1])) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addAbilityText: [m[2]] } }];
  }
  if ((m = L.match(/^(.+?) (?:have|has) (.+)$/i)) && !/^(you|each player|each opponent|all players|players)\b/i.test(m[1])) {
    const kws = parseKeywordList(m[2]);
    if (kws) {
      const a = affectsOf(m[1]);
      if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } }];
    }
  }
  // "Enchanted land is a 3/3 black Ooze creature." / "~ is a 4/4 red Dragon artifact creature"
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (\d+)\/(\d+) (.+?) creatures?(?: with (.+))?(?: in addition to (?:its|their) other types)?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
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
      if (!kws) return null;
      out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
    }
    return out;
  }
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) in addition to (?:its|their) other (?:types|colors|land types|creature types)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
    const words = m[2].split(/\s+/);
    const types = words.filter((w) => /^(creature|artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 4, addTypes: types, addSubtypes: subtypes } }];
  }
  if ((m = L.match(/^(.+?) (?:is|are) (white|blue|black|red|green|colorless)$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
    const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[2].toLowerCase() as 'white'];
    return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 5, setColors: c ? [c] : [] } }];
  }
  // Rules on objects
  if ((m = L.match(/^(.+?) cannot block$/i))) return objRule(m[1], { kind: 'cantBlock' });
  if ((m = L.match(/^(.+?) cannot attack$/i))) return objRule(m[1], { kind: 'cantAttack' });
  if ((m = L.match(/^(.+?) cannot attack or block$/i))) {
    const a = objRule(m[1], { kind: 'cantAttack' });
    const b = objRule(m[1], { kind: 'cantBlock' });
    return a && b ? [...a, ...b] : null;
  }
  if ((m = L.match(/^(.+?) cannot be blocked$/i))) return objRule(m[1], { kind: 'cantBeBlocked' });
  if ((m = L.match(/^(.+?) cannot be blocked by creatures with power (\d+) or less$/i))) return objRule(m[1], { kind: 'cantBeBlockedByPowerLE', power: parseInt(m[2], 10) });
  if ((m = L.match(/^(.+?) cannot be blocked by creatures with power (\d+) or greater$/i))) return objRule(m[1], { kind: 'cantBeBlockedByPowerGE', power: parseInt(m[2], 10) });
  if (/^Creatures with power less than ~'s power cannot block it$/i.test(L)) return objRule('~', { kind: 'cantBeBlockedByPowerLessThanSource' });
  if ((m = L.match(/^(.+?) cannot attack unless defending player controls (?:a|an) (.+)$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) return objRule(m[1], { kind: 'cantAttackUnlessDefenderControls', filter: noun.filter });
  }
  if ((m = L.match(/^(.+?) must be blocked if able$/i))) return objRule(m[1], { kind: 'custom', tag: 'mustBeBlocked' });
  if ((m = L.match(/^(.+?) cannot be blocked except by (.+)$/i))) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (noun) return objRule(m[1], { kind: 'canBeBlockedOnlyBy', filter: noun.filter });
  }
  if ((m = L.match(/^(.+?) cannot block (.+?)$/i)) && !/^(alone|unless|if)\b/i.test(m[2])) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (noun) return objRule(m[1], { kind: 'cantBlockFilter', filter: noun.filter });
  }
  if ((m = L.match(/^(.+?) cannot be blocked by creatures with greater power$/i))) return objRule(m[1], { kind: 'cantBeBlockedByPowerGreaterThanSource' });
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block) unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!cond || cond.kind === 'manual') return null;
    const kinds: RuleModification['kind'][] = m[2].toLowerCase() === 'attack or block' ? ['cantAttack', 'cantBlock'] : m[2].toLowerCase() === 'attack' ? ['cantAttack'] : ['cantBlock'];
    const out: AbilitySpec[] = [];
    for (const k of kinds) {
      const r = objRule(m[1], { kind: k } as RuleModification);
      if (!r) return null;
      out.push(...r.map((a) => (a.kind === 'static' ? { ...a, condition: { kind: 'not' as const, c: cond } } : a)));
    }
    return out;
  }
  // "~ enters with a +1/+1 counter, a flying counter, a deathtouch counter, and a shield counter on it."
  if ((m = L.match(/^~ enters with ((?:(?:a|an|\w+) [+-]?[\w/+-]+ counters?(?:, |,? and )?){2,}) on it$/i))) {
    const list: { counter: string; amount: Amount }[] = [];
    for (const part of m[1].split(/,\s*(?:and\s+)?|\s+and\s+/i)) {
      const pm = part.trim().match(/^(?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w' -]+?) counters?$/i);
      if (!pm) return null;
      const n = pm[1] ? wordToNumber(pm[1]) : 1;
      if (n === null || n === 'X') return null;
      list.push({ counter: pm[2], amount: n });
    }
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, countersList: list as { counter: import('@commander/engine').CounterType; amount: Amount }[] }];
  }
  // "~ enters with your choice of a flying counter or a first strike counter on it." / "... of a +1/+1, first strike, or vigilance counter on it."
  if ((m = L.match(/^~ enters with your choice of (?:(\w+) different counters on it from among (.+)|(.+?) counters? on it)$/i))) {
    const count = m[1] ? wordToNumber(m[1]) : 1;
    if (count === null || count === 'X') return null;
    const listText = m[2] ?? m[3];
    const from = listText
      .split(/,\s*(?:or\s+)?|\s+or\s+/i)
      .map((x) => x.trim().replace(/^(?:a|an) /i, '').replace(/ counters?$/i, ''))
      .filter(Boolean);
    if (from.length < 2) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counterChoice: { from, count } }];
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
    if (per === null) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: { kind: 'times', a: m[1] ? (wordToNumber(m[1]) as number) : 1, b: per } } }];
  }
  if ((m = L.match(/^~ enters with (?:a number of|X) ([+-]\d\/[+-]\d|\w+) counters on it(?: equal to (.+)|, where X is (.+))$/i))) {
    const amt = parseAmount(m[2] ?? m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    return amt !== null ? [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[1], amount: amt } }] : null;
  }
  if ((m = L.match(/^(.+?) cannot (attack or block|attack|block) alone$/i))) return objRule(m[1], { kind: 'custom', tag: m[2].toLowerCase() === 'attack or block' ? 'cantAttackOrBlockAlone' : m[2].toLowerCase() === 'attack' ? 'cantAttackAlone' : 'cantBlockAlone' });
  if ((m = L.match(/^(.+?) cannot be blocked by (.+)$/i)) && !/power|more than one|two or more/i.test(m[2])) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
    if (noun) return objRule(m[1], { kind: 'cantBeBlockedBy', filter: noun.filter });
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
  if ((m = L.match(/^All creatures able to block (.+?) do so$/i))) return objRule(m[1], { kind: 'custom', tag: 'lure' });
  if ((m = L.match(/^(.+?) can block an additional creature each combat$/i))) return objRule(m[1], { kind: 'custom', tag: 'extraBlock' });
  if ((m = L.match(/^(.+?) can block any number of creatures$/i))) return objRule(m[1], { kind: 'custom', tag: 'extraBlock' }); // approximation: one extra
  if ((m = L.match(/^(.+?) cannot attack or block, and (?:its|their) activated abilities cannot be activated$/i))) {
    const a = objRule(m[1], { kind: 'cantAttack' });
    const b = objRule(m[1], { kind: 'cantBlock' });
    const c = objRule(m[1], { kind: 'custom', tag: 'cantActivate' });
    return a && b && c ? [...a, ...b, ...c] : null;
  }
  if ((m = L.match(/^(?:Activated abilities of (.+?) cannot be activated|(.+?)'s activated abilities cannot be activated)$/i))) return objRule(m[1] ?? m[2], { kind: 'custom', tag: 'cantActivate' });
  if (/^You may play lands from your graveyard$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playLandsFromGraveyard' } }];
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]\d+)\/([+-]\d+) for each (.+?)(?: on the battlefield)?$/i))) {
    const a = affectsOf(m[1]);
    if (!a.ok) return null;
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
    return null;
  }
  if ((m = L.match(/^(.+?) (?:get|gets) ([+-]X|[+-]\d+)\/([+-]X|[+-]\d+), where X is (.+)$/i))) {
    const a = affectsOf(m[1]);
    const amt = parseAmount(m[4], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!a.ok || amt === null) return null;
    const p = m[2].toUpperCase().includes('X') ? (m[2].startsWith('-') ? -1 : 1) : 0;
    const t = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? -1 : 1) : 0;
    const out: AbilitySpec[] = [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: p, toughness: t, perAmount: amt } }];
    const fixedP = m[2].toUpperCase().includes('X') ? 0 : parseInt(m[2], 10);
    const fixedT = m[3].toUpperCase().includes('X') ? 0 : parseInt(m[3], 10);
    if (fixedP || fixedT) out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: fixedP, toughness: fixedT } });
    return out;
  }
  if ((m = L.match(/^If (?:a|an) (.+?) would deal damage to (?:a permanent or player|a creature or player|any target|a permanent, player, or battle|a creature, planeswalker, or player), it deals (double|twice|triple|three times) that (?:much )?damage(?: to (?:that|it)[^,]*)? instead$/i))) {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'damageMultiplier', data: { filter: f, times: /triple|three/i.test(m[2]) ? 3 : 2 } } }];
  }
  if ((m = L.match(/^If ~ was kicked, it enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it and with (.+)$/i))) {
    const kws = parseKeywordList(m[3]);
    if (!kws) return null;
    return [
      { kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: m[1] ? (wordToNumber(m[1]) as number) : 1 }, condition: { kind: 'wasKicked' } },
      { kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: kws }, condition: { kind: 'wasKicked' } },
    ];
  }
  if ((m = L.match(/^~'s power is equal to (.+?) and its toughness is equal to (?:that number plus (\w+)|(.+))$/i))) {
    const rc = { self: { ref: 'self' } as Ref, lastObj: null, triggerHasObject: false };
    const pa = parseAmount(m[1], rc);
    const ta = m[2] ? (pa && wordToNumber(m[2]) !== null ? ({ kind: 'sum', parts: [pa, wordToNumber(m[2]) as number] } as Amount) : null) : parseAmount(m[3], rc);
    if (pa && ta) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', powerAmount: pa, toughnessAmount: ta } }];
  }
  if ((m = L.match(/^~'s (power|toughness) is equal to (.+)$/i))) {
    const amt = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (!amt) return null;
    return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', ...(m[1].toLowerCase() === 'power' ? { powerAmount: amt } : { toughnessAmount: amt }) } }];
  }
  if ((m = L.match(/^~'s power and toughness are each equal to (.+)$/i))) {
    const amt = parseAmount(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (amt) return [{ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', powerAmount: amt, toughnessAmount: amt } }];
  }
  if ((m = L.match(/^If you would gain life, you gain that much life plus (\w+) instead$/i))) return [{ kind: 'replacement', text: line, event: 'lifeGain', add: wordToNumber(m[1]) as number, who: 'you' }];
  if ((m = L.match(/^If ~ was kicked, it enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: m[1] ? (wordToNumber(m[1]) as number) : 1 }, condition: { kind: 'wasKicked' } }];
  if ((m = L.match(/^(.+?) cannot be blocked by more than one creature$/i))) return objRule(m[1], { kind: 'maxBlockers', count: 1 });
  if ((m = L.match(/^(?:During your turn, )?you may (?:play|cast) cards( you do not own)? with (\w+) counters on them from exile(?:, and mana of any type can be spent to cast (?:those spells|them))?$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playExiledWithCounter', data: { counter: m[2], notOwned: !!m[1], yourTurn: /^During your turn/i.test(L), anyMana: /mana of any type/i.test(L) } } }];
  if ((m = L.match(/^(.+?) cannot be blocked except by (\w+) or more creatures$/i)) && wordToNumber(m[2]) !== null) return objRule(m[1], { kind: 'custom', tag: 'minBlockers', data: wordToNumber(m[2]) });
  if ((m = L.match(/^(.+?) can block only creatures with flying$/i))) return objRule(m[1], { kind: 'custom', tag: 'blockOnlyFlying' });
  if ((m = L.match(/^(.+?) attacks? each combat if able$/i))) return objRule(m[1], { kind: 'mustAttack' });
  if ((m = L.match(/^(.+?) (?:does not|do not) untap during (?:your|its controller's|their controllers'|their controller's) untap steps?$/i))) return objRule(m[1], { kind: 'cantUntap' });
  if ((m = L.match(/^(.+?) cannot be countered$/i))) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantBeCountered' } }];
  // "~ cannot be the target of nongreen spells or abilities from nongreen sources."
  if ((m = L.match(/^(.+?) cannot be the target of (.+?) spells or abilities from \2 sources$/i))) {
    const noun = parseNoun(`a ${m[2]} spell`);
    if (noun) return objRule(m[1], { kind: 'cantBeTargeted', filter: { ...noun.filter, zone: undefined } });
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
  if ((m = L.match(/^(.+?) cannot be the target of spells or abilities your opponents control$/i))) return objRule(m[1], { kind: 'cantBeTargeted', by: 'opponents' });
  if ((m = L.match(/^(.+?) cannot be the target of (.+?) spells(?: or abilities)?$/i))) {
    const noun = parseNoun(`a ${m[2]} spell`);
    if (noun) return objRule(m[1], { kind: 'cantBeTargeted', by: 'spells', filter: { ...noun.filter, zone: undefined } });
  }
  if ((m = L.match(/^(.+?) cannot (attack|block|attack or block) unless (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') {
      const tag = m[2].toLowerCase() === 'attack' ? 'cantAttack' : m[2].toLowerCase() === 'block' ? 'cantBlock' : 'cantAttackOrBlock';
      const a = affectsOf(m[1]);
      if (a.ok) return [{ kind: 'static', text: line, affects: a.affects, rule: { kind: 'custom', tag }, condition: { kind: 'not', c: cond } }];
    }
  }
  if ((m = L.match(/^Prevent all (?:combat )?damage that would be dealt to (.+)$/i))) return objRule(m[1], { kind: 'damagePrevention', amount: 'all' });
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
        const per = parseNoun(m[3]) ?? parseNoun(`a ${m[3].replace(/s$/, '')}`);
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
  if ((m = L.match(/^(.+?) entering do not cause abilities to trigger$/i))) {
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
  if ((m = L.match(/^(.+?) you cast cost \{(\d)\} less to cast for each (.+)$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    const per = parseAmount(`the number of ${m[3]}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    if (per !== null) {
      if (typeof per === 'object' && per.kind === 'count') return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter, per: per.filter } }];
      return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter, perAmount: per } }];
    }
  }

  if (/^You have no maximum hand size$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'noMaxHandSize' } }];
  if (/^You have hexproof$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'hexproof' } }];
  if (/^You have shroud$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'shroud' } }];
  if (/^You cannot lose the game and your opponents cannot win the game$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'cantLose' } }];
  if ((m = L.match(/^You may play (?:an additional land|(\w+) additional lands) on each of your turns$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'extraLandDrop', count: m[1] ? (wordToNumber(m[1]) as number) ?? 1 : 1 } }];
  // "White spells you cast cost {W} more to cast."
  if ((m = L.match(/^(.+?) you cast cost ((?:\{[WUBRGC]\})+) more to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'costIncrease', amount: (m[2].match(/\{/g) ?? []).length, symbols: m[2], filter } }];
  }
  if ((m = L.match(/^(.*?)creatures? cannot attack you(?: or planeswalkers you control)?$/i))) {
    const pre = m[1].trim();
    let filter: ObjectFilter | undefined;
    if (pre) {
      const noun = parseNoun(`a ${pre} creature`);
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    } else filter = { types: ['Creature'] };
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'cantBeAttacked', data: { filter } } }];
  }
  // Deck-construction rules have no in-game effect, but record them so the card counts as understood.
  if (/^A deck with this (?:commander|card as its commander) can have .+$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'deckConstruction' } }];
  if (/^(?:the )?damage cannot be prevented$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'custom', tag: 'noDamagePrevention' } }];
  if ((m = L.match(/^(.+?) you cast cost ((?:\{[WUBRGC\d]\})+) (less|more) to cast$/i)) || (m = L.match(/^(.+?) cost ((?:\{[WUBRGC\d]\})+) (less|more) to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    const generic = m[2].match(/^\{(\d)\}$/);
    const kind = m[3].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease';
    if (!generic && /\d/.test(m[2])) return null;
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: generic ? { kind, amount: parseInt(generic[1], 10), filter } : { kind, amount: 0, symbols: m[2], filter } }];
  }
  if ((m = L.match(/^(.+?) your opponents cast cost \{(\d)\} more to cast$/i))) {
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'costIncrease', amount: parseInt(m[2], 10), filter } }];
  }
  // Replacement: ETB
  if (/^~ enters tapped$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true }];
  if ((m = L.match(/^~ enters (?:the battlefield )?with (?:a|an|(\w+|X)) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: n } }];
  }
  if ((m = L.match(/^~ enters (?:the battlefield )?tapped with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, counters: { counter: m[2], amount: n } }];
  }
  if ((m = L.match(/^As ~ enters, choose (a color(?: other than \w+)?|an opponent|a creature type|a planeswalker type|a card name|a nonland card name|a player|a number(?: greater than 0)?|a basic land type|a card type|a permanent type|odd or even|(?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)(?:, (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle))*(?:,? or (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle))|[A-Z]\w+ or [A-Z]\w+)$/i))) {
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
  if ((m = L.match(/^As ~ enters, you may reveal (?:a|an) (.+?) card from your hand\.? If you do not, (?:~|it) enters tapped$/i))) {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tapped: true, unless: { kind: 'count', filter: { ...noun.filter, zone: 'hand', owner: 'you' }, op: '>=', value: 1 } }];
  }
  if (/^If it is neither day nor night, it becomes day as ~ enters$/i.test(L)) return [{ kind: 'static', text: line }]; // day/night is not modeled; nothing else to do
  // Several statics in one line: "~ enters tapped. As it enters, choose a color."
  if (/\. [A-Z]/.test(L)) {
    const parts = L.split(/\. (?=[A-Z])/).map((p) => p.replace(/^As it enters/i, 'As ~ enters')).filter((p) => !isNoOpSentence(p));
    const out: AbilitySpec[] = [];
    for (const p of parts) {
      const r = parseStatic(p, isCreatureOrPermanent);
      if (!r) return null;
      out.push(...r);
    }
    return out;
  }
  if ((m = L.match(/^(.+?) (?:enter|enters) with (?:an additional|a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on (?:it|them)$/i)) && !/^~/.test(m[1])) {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    const f = { ...noun.filter };
    delete f.zone;
    if (noun.other) f.other = true;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: f, counters: { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) as number) : 1 } }];
  }
  if ((m = L.match(/^(.+?) (?:enter|enters) tapped$/i)) && !/^~/.test(m[1])) {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: false, filter: f, tapped: true }];
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
  if ((m = L.match(/^If you would create one or more (?:(.+?) )?tokens?, (?:create those tokens plus an additional (.+?) token instead|instead create those tokens plus an additional (.+?) token)$/i))) {
    const noun = !m[1] ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1]} token`);
    if (!noun) return null;
    return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 1 }];
  }
  // "If ~ would enter, sacrifice an untapped Mountain instead."
  if ((m = L.match(/^If ~ would enter, (sacrifice .+?) instead$/i))) {
    const r = parseEffects(m[1], newCtx({ triggerHasObject: false, triggerHasPlayer: false }));
    if (r.unhandled.length) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, effects: r.effects }];
  }
  if (/^If one or more tokens would be created under your control, twice that many (?:of those )?tokens are created instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'tokenCreated', extra: 1 }];
  if ((m = L.match(/^If one or more \+1\/\+1 counters would be put on (a|another) creature you control, that many plus (one|two) \+1\/\+1 counters are put on it instead$/i))) return [{ kind: 'replacement', text: line, event: 'counterAdded', extra: m[2].toLowerCase() === 'two' ? 2 : 1, counterType: '+1/+1', filter: { types: ['Creature'], controller: 'you', other: m[1].toLowerCase() === 'another' || undefined } }];
  if (/^If you would gain life, you gain twice that much life instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'lifeGain', multiply: 2, who: 'you' }];
  if (/^If an opponent would gain life, that player gains no life instead$/i.test(L) || /^Your opponents cannot gain life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'cantGainLife' } }];
  // Sagas & others are handled by the orchestrator.
  void isCreatureOrPermanent;
  return null;
}
