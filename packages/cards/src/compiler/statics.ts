/** Static abilities and replacement effects. */
import type { AbilitySpec, ObjectFilter, RuleModification, StaticAbilitySpec } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { parseKeywordList } from './effects.js';
import { wordToNumber } from './text.js';
import { parseCondition } from './conditions.js';

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
  // Conditional statics: "As long as X, Y" / "During your turn, Y" / "Y as long as X"
  let condText: string | null = null;
  let innerText: string | null = null;
  if ((m = L.match(/^(?:As long as|While) (.+?), (.+)$/i))) [condText, innerText] = [m[1], m[2]];
  else if ((m = L.match(/^(.+?) (?:as long as|while) (.+)$/i))) [condText, innerText] = [m[2], m[1]];
  if (condText && innerText) {
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
  if (/^~'s power and toughness are each equal to /i.test(L)) return [{ kind: 'static', text: line }];
  if (/^You control (?:enchanted|equipped) (?:creature|permanent|artifact|land|planeswalker)$/i.test(L)) return [{ kind: 'static', text: line, affects: 'attachedTo', modification: { layer: 'control', controller: 'sourceController' } }];
  // Self replacements on dying / leaving
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
      const kws = parseKeywordList(m[4]);
      if (!kws) return null;
      out.push({ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } });
    }
    return out;
  }
  if ((m = L.match(/^(.+?) (?:have|has) (.+)$/i)) && !/^(you|each|all players)/i.test(m[1])) {
    const kws = parseKeywordList(m[2]);
    if (kws) {
      const a = affectsOf(m[1]);
      if (!a.ok) return null;
      return [{ kind: 'static', text: line, affects: a.affects, modification: { layer: 6, addKeywords: kws } }];
    }
  }
  if ((m = L.match(/^(.+?) (?:is|are) (?:a|an) (.+?) in addition to (?:its|their) other (?:types|colors)$/i))) {
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
  const objRule = (who: string, rule: RuleModification): AbilitySpec[] | null => {
    const a = affectsOf(who);
    return a.ok ? [{ kind: 'static', text: line, affects: a.affects, rule }] : null;
  };
  if ((m = L.match(/^(.+?) cannot block$/i))) return objRule(m[1], { kind: 'cantBlock' });
  if ((m = L.match(/^(.+?) cannot attack$/i))) return objRule(m[1], { kind: 'cantAttack' });
  if ((m = L.match(/^(.+?) cannot attack or block$/i))) {
    const a = objRule(m[1], { kind: 'cantAttack' });
    const b = objRule(m[1], { kind: 'cantBlock' });
    return a && b ? [...a, ...b] : null;
  }
  if ((m = L.match(/^(.+?) cannot be blocked$/i))) return objRule(m[1], { kind: 'cantBeBlocked' });
  if ((m = L.match(/^(.+?) cannot be blocked except by two or more creatures$/i))) return objRule(m[1], { kind: 'custom', tag: 'minBlockers', data: 2 });
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
  if ((m = L.match(/^As ~ enters, choose (a color|an opponent|a creature type)$/i))) return [{ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, choose: /color/.test(m[1]) ? 'color' : /opponent/.test(m[1]) ? 'opponent' : 'creatureType' }];
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
  if (/^If one or more \+1\/\+1 counters would be put on a creature you control, that many plus one \+1\/\+1 counters are put on it instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'counterAdded', extra: 1, counterType: '+1/+1', filter: { types: ['Creature'], controller: 'you' } }];
  if (/^If you would gain life, you gain twice that much life instead$/i.test(L)) return [{ kind: 'replacement', text: line, event: 'lifeGain', multiply: 2, who: 'you' }];
  if (/^If an opponent would gain life, that player gains no life instead$/i.test(L) || /^Your opponents cannot gain life$/i.test(L)) return [{ kind: 'static', text: line, ruleAffects: 'opponents', rule: { kind: 'cantGainLife' } }];
  // Sagas & others are handled by the orchestrator.
  void isCreatureOrPermanent;
  return null;
}
