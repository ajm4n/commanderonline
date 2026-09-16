/** Static abilities and replacement effects. */
import type { AbilitySpec, Amount, ObjectFilter, RuleModification, StaticAbilitySpec } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { parseKeywordList, isNoOpSentence, parseEffects, newCtx, parseCopyExceptions } from './effects.js';
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
  const L = line.replace(/\.$/, '');
  const objRule = (who: string, rule: RuleModification): AbilitySpec[] | null => {
    const a = affectsOf(who);
    return a.ok ? [{ kind: 'static', text: line, affects: a.affects, rule }] : null;
  };
  // Conditional statics: "As long as X, Y" / "During your turn, Y" / "Y as long as X"
  let condText: string | null = null;
  let innerText: string | null = null;
  if ((m = L.match(/^(?:As long as|While) (.+?), (.+)$/i))) [condText, innerText] = [m[1], m[2]];
  else if ((m = L.match(/^(.+?) (?:as long as|while) (.+)$/i))) [condText, innerText] = [m[2], m[1]];
  else if ((m = L.match(/^(~ (?:does not untap|cannot|gets|has) .+?) if (.+)$/i))) [condText, innerText] = [m[2], m[1]];
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
    const parts = m[2].split(/, and |, | and (?=(?:has|have|is|are|gets?|cannot|can|loses?|gains?)\b)/i).map((p) => p.trim()).filter(Boolean);
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
  if ((m = L.match(/^You may (play lands and cast (.+?) spells|play lands|cast (.+?) spells|play cards|cast spells|play lands and cast spells) from the top of your library$/i))) {
    const what = m[1].toLowerCase();
    const spellNoun = m[2] ?? m[3];
    const filter = spellNoun ? parseNoun(`a ${spellNoun} spell`)?.filter : undefined;
    if (spellNoun && !filter) return null;
    const data = { lands: /play lands|play cards/.test(what), spells: /cast|play cards/.test(what), filter: filter ? { ...filter, zone: undefined } : undefined };
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'playFromTop', data } }];
  }
  if ((m = L.match(/^As ~ enters, choose (a color|a creature type|an opponent|a player|a card name|a number) and (a color|a creature type|an opponent|a player|a card name|a number)$/i))) {
    const a = parseStatic(`As ~ enters, choose ${m[1]}`, isCreatureOrPermanent);
    const b = parseStatic(`As ~ enters, choose ${m[2]}`, isCreatureOrPermanent);
    if (a && b) return [...a, ...b];
  }
  if ((m = L.match(/^(.+?) can attack as though (?:it|they) didn't have defender$/i))) return objRule(m[1], { kind: 'custom', tag: 'canAttackWithDefender' });
  // Static damage prevention: "Prevent all damage that would be dealt to ~ by artifact creatures." / "Prevent all combat damage that would be dealt by enchanted creature."
  if ((m = L.match(/^Prevent all (combat |noncombat )?damage that would be dealt(?: to (.+?))?(?: by (.+?))?$/i)) && (m[2] || m[3])) {
    const combat = m[1] ? (m[1].trim().toLowerCase() as 'combat' | 'noncombat') : undefined;
    if (!m[2]) {
      // "...dealt by enchanted creature": the source deals no damage.
      return objRule(m[3], { kind: 'custom', tag: 'dealsNoDamage', data: combat ?? 'all' });
    }
    let source: ObjectFilter | undefined;
    if (m[3]) {
      const sn = parseNoun(m[3].replace(/ sources?$/i, ' permanents').replace(/^(white|blue|black|red|green|colorless|colored|artifact|noncreature|nonblack|nonwhite|nonred|nongreen|nonblue) permanents$/i, '$1 permanent').replace(/^permanents$/i, 'permanent'));
      if (!sn) return null;
      source = { ...sn.filter, zone: undefined };
    }
    const rule: RuleModification = { kind: 'custom', tag: 'preventDamageTo', data: { combat, source } };
    const who = m[2].trim();
    if (/^you$/i.test(who)) return [{ kind: 'static', text: line, rule, ruleAffects: 'controller' }];
    if (/^you and (creatures|permanents) you control$/i.test(who)) {
      const a = affectsOf(who.replace(/^you and /i, ''));
      return a.ok ? [{ kind: 'static', text: line, rule, ruleAffects: 'controller' }, { kind: 'static', text: line, affects: a.affects, rule }] : null;
    }
    if (/^(you and )?(?:your )?planeswalkers you control$/i.test(who)) return null;
    return objRule(who, rule);
  }
  if ((m = L.match(/^(.+?) (?:is|are) goaded$/i))) return objRule(m[1], { kind: 'custom', tag: 'goaded', data: '__controller__' });
  if ((m = L.match(/^(.+?) loses? all abilities$/i))) {
    const a = affectsOf(m[1]);
    return a.ok ? [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, loseAllAbilities: true } }] : null;
  }
  if ((m = L.match(/^(.+?) (?:has|have) base power and toughness (\d+)\/(\d+)$/i))) {
    const a = affectsOf(m[1]);
    return a.ok ? [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7b', setPower: parseInt(m[2], 10), setToughness: parseInt(m[3], 10) } }] : null;
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
  if (/^Players have no maximum hand size$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'allPlayers', rule: { kind: 'noMaxHandSize' } }];
  // Clones
  if ((m = L.match(/^(You may have )?~ enters? as a copy of (?:any|a|an) (.+?)(?: on the battlefield)?(?:, except (.+))?$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const ex = m[3] ? parseCopyExceptions(m[3].replace(/^(?:it|he|she) enters with /i, 'it has ').replace(/\bhis name\b/i, 'its name')) : undefined;
    if (m[3] && !ex) return null;
    return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, enterAsCopy: noun.filter, enterAsCopyOptional: !!m[1], copyExceptions: ex ?? undefined }];
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
  if (/^You control (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(L)) return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 'control', controller: 'sourceController' } }];
  // Self replacements on dying / leaving
  if ((m = L.match(/^If (combat )?damage would be dealt to ~(?: by (.+?))?, prevent that damage(?:\.|,)? (?:and |then )?(.+)$/i))) {
    const from = m[2] ? parseNoun(m[2].replace(/ sources?$/i, ' permanent')) : null;
    if (m[2] && !from) return null;
    const ctx = newCtx({ triggerHasObject: false, triggerHasPlayer: false });
    const r = parseEffects(m[3].replace(/\bon it\b/g, 'on ~'), ctx);
    if (r.unhandled.length) return null;
    return [{ kind: 'replacement', text: line, event: 'damage', prevent: 'all', to: 'self', combatOnly: !!m[1] || undefined, fromFilter: from ? { ...from.filter, zone: undefined } : undefined, effects: r.effects }];
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
      if (!a.ok) return null;
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } }];
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
    return noun ? objRule(m[1], { kind: 'cantAttackUnlessDefenderControls', filter: noun.filter }) : null;
  }
  if ((m = L.match(/^(.+?) must be blocked if able$/i))) return objRule(m[1], { kind: 'custom', tag: 'mustBeBlocked' });
  if ((m = L.match(/^(.+?) cannot be blocked except by (.+)$/i))) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
    return noun ? objRule(m[1], { kind: 'canBeBlockedOnlyBy', filter: noun.filter }) : null;
  }
  if ((m = L.match(/^(.+?) cannot block (.+?)$/i)) && !/^(alone|unless|if)\b/i.test(m[2])) {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2].replace(/s$/, '')}`);
    return noun ? objRule(m[1], { kind: 'cantBlockFilter', filter: noun.filter }) : null;
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
  if ((m = L.match(/^~ enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it for each (.+)$/i))) {
    const noun = parseNoun(m[3]);
    const per: Amount | null = noun ? { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } } : parseAmount(`the number of ${m[3]}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
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
    return noun ? objRule(m[1], { kind: 'cantBeBlockedBy', filter: noun.filter }) : null;
  }
  if ((m = L.match(/^~ enters with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on it if (.+)$/i))) {
    const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (cond && cond.kind !== 'manual') return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, counters: { counter: m[2], amount: m[1] ? (wordToNumber(m[1]) as number) : 1 }, condition: cond }];
  }
  if ((m = L.match(/^When you control no (.+?), sacrifice ~$/i))) {
    const noun = parseNoun(m[1]);
    return noun ? [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'sacrificeUnlessControl', data: noun.filter } }] : null;
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
    const noun = parseNoun(m[4]) ?? parseNoun(`a ${m[4]}`);
    if (noun) {
      const f = { ...noun.filter };
      if (!f.zone) f.zone = 'battlefield';
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: '7c', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), perCount: f } }];
    }
    const amt = parseAmount(`the number of ${m[4].replace(/ counter on /, ' counters on ')}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
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
  if ((m = L.match(/^(.+?) does not untap during (?:your|its controller's) untap step$/i))) return objRule(m[1], { kind: 'cantUntap' });
  if ((m = L.match(/^(.+?) cannot be countered$/i))) return [{ kind: 'static', text: line, affects: 'self', rule: { kind: 'custom', tag: 'cantBeCountered' } }];
  if ((m = L.match(/^(.+?) cannot be the target of spells or abilities your opponents control$/i))) return objRule(m[1], { kind: 'cantBeTargeted', by: 'opponents' });
  if ((m = L.match(/^Prevent all (?:combat )?damage that would be dealt to (.+)$/i))) return objRule(m[1], { kind: 'damagePrevention', amount: 'all' });
  if ((m = L.match(/^Prevent all damage that would be dealt to you$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'damagePrevention', amount: 'all' } }];
  // Player-level rules
  if (/^You have no maximum hand size$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'noMaxHandSize' } }];
  if (/^You have hexproof$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'hexproof' } }];
  if (/^You have shroud$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'custom', tag: 'shroud' } }];
  if (/^You cannot lose the game and your opponents cannot win the game$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'cantLose' } }];
  if ((m = L.match(/^You may play (?:an additional land|(\w+) additional lands) on each of your turns$/i))) return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: 'extraLandDrop', count: m[1] ? (wordToNumber(m[1]) as number) ?? 1 : 1 } }];
  if ((m = L.match(/^(.+?) you cast cost \{(\d)\} (less|more) to cast$/i)) || (m = L.match(/^(.+?) cost \{(\d)\} (less|more) to cast$/i))) {
    const nounText = m[1].replace(/^Spells$/i, 'spells');
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(nounText)) {
      const noun = parseNoun(nounText.replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter };
      delete filter.zone;
    }
    return [{ kind: 'static', text: line, ruleAffects: 'controller', rule: { kind: m[3] === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[2], 10), filter } }];
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
  if ((m = L.match(/^As ~ enters, choose (a color(?: other than \w+)?|an opponent|a creature type|a card name|a nonland card name|a player|a number(?: greater than 0)?|a basic land type|odd or even|[A-Z]\w+ or [A-Z]\w+)$/i))) {
    const c = m[1].toLowerCase();
    const base = { kind: 'replacement' as const, text: line, event: 'entersBattlefield' as const, self: true as const };
    if (c.startsWith('a color')) return [{ ...base, choose: 'color' }];
    if (c === 'an opponent') return [{ ...base, choose: 'opponent' }];
    if (c === 'a creature type') return [{ ...base, choose: 'creatureType' }];
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
  if ((m = L.match(/^If one or more \+1\/\+1 counters would be put on (a|another) creature you control, that many plus (one|two) \+1\/\+1 counters are put on it instead$/i))) return [{ kind: 'replacement', text: line, event: 'counterAdded', extra: m[2].toLowerCase() === 'two' ? 2 : 1, counterType: '+1/+1', filter: { types: ['Creature'], controller: 'you', other: m[1].toLowerCase() === 'another' || undefined } }];
  if (/^If you would gain life, you gain twice that much life instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'lifeGain', multiply: 2, who: 'you' }];
  if (/^If an opponent would gain life, that player gains no life instead$/i.test(L) || /^Your opponents cannot gain life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'cantGainLife' } }];
  // Sagas & others are handled by the orchestrator.
  void isCreatureOrPermanent;
  return null;
}
