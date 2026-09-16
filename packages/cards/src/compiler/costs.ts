/** Activated-ability cost parsing. */
import type { AbilityCost, Condition } from '@commander/engine';
import { parseNoun } from './nouns.js';
import { wordToNumber } from './text.js';
import { parseCondition } from './conditions.js';

const MANA_RE = /^(?:\{[^}]+\})+$/;

export function parseCost(text: string): AbilityCost | null {
  const cost: AbilityCost = {};
  // "Sacrifice a creature or pay {3}" / "discard a card or pay 3 life": a choice of costs.
  {
    const cm = text.match(/^(.+?) or (pay .+|sacrifice .+|discard .+|exile .+)$/i);
    if (cm && !/,/.test(text)) {
      const norm = (x: string) => x.replace(/^pay ((?:\{[^}]+\})+)$/i, '$1');
      const a = parseCost(norm(cm[1]).replace(/^[a-z]/, (c) => c.toUpperCase()));
      const b = parseCost(norm(cm[2]).replace(/^[a-z]/, (c) => c.toUpperCase()));
      if (a && b) return { choice: [a, b] };
    }
  }
  // Split on commas not inside braces
  const parts = text.split(/,\s*(?![^{]*\})/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    let m: RegExpMatchArray | null;
    if (p === '{T}') cost.tap = true;
    else if ((m = p.match(/^Waterbend \{(\d+)\}$/i))) cost.waterbend = parseInt(m[1], 10);
    else if ((m = p.match(/^(You may )?Blight (\d+)$/i))) {
      cost.blight = parseInt(m[2], 10);
      if (m[1]) cost.blightOptional = true;
    }
    else if ((m = p.match(/^(you may )?collect evidence (\d+)$/i))) cost.collectEvidence = { n: parseInt(m[2], 10), optional: !!m[1] || undefined };
    else if ((m = p.match(/^Behold (?:a|an) (.+)$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (!noun) return null;
      cost.behold = { ...noun.filter, types: ['Creature'] };
    } else if ((m = p.match(/^Reveal (?:a|an) (.+?) card from your hand$/i))) {
      const noun = parseNoun(`a ${m[1]} card`);
      if (!noun) return null;
      cost.revealFromHand = noun.filter;
    } else if (/^Choose a creature type$/i.test(p)) cost.chooseCreatureType = true;
    else if ((m = p.match(/^Tap any number of untapped (.+?) you control$/i))) {
      const noun = parseNoun(`a ${m[1].replace(/s$/, '')}`);
      if (!noun) return null;
      cost.tapUntapped = { filter: noun.filter, count: 'any' };
    } else if ((m = p.match(/^Sacrifice any number of (.+)$/i))) {
      const noun = parseNoun(`a ${m[1].replace(/s$/, '')}`);
      if (!noun) return null;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield' }, count: 'any' };
    }
    else if (/^Forage$/i.test(p)) cost.choice = [{ exileFromGraveyard: { filter: {}, count: 3 } }, { sacrifice: { filter: { subtypes: ['Food'], zone: 'battlefield' }, count: 1 } }];
    else if (p === '{Q}') cost.untap = true;
    else if (MANA_RE.test(p)) {
      // {T} may be embedded like "{1}{T}"? Rare. Mana cost.
      const energy = p.match(/\{E\}/g);
      if (energy && energy.length === (p.match(/\{[^}]+\}/g) ?? []).length) cost.energy = energy.length;
      else cost.mana = p.replace(/\{T\}/g, '');
    } else if (/^Sacrifice ~$/i.test(p)) cost.sacrificeSelf = true;
    else if ((m = p.match(/^Sacrifice (?:a|an|another|(\w+)) (.+)$/i))) {
      const noun = parseNoun(`a ${m[2]}`);
      if (!noun) return null;
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') return null;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield', other: /another/i.test(p) || undefined }, count: n };
    } else if ((m = p.match(/^Pay (\d+) life$/i))) cost.payLife = parseInt(m[1], 10);
    else if (/^Pay X life$/i.test(p)) cost.payLife = 'X';
    else if ((m = p.match(/^Pay ((?:\{E\})+)$/i))) cost.energy = (m[1].match(/\{E\}/g) ?? []).length;
    else if (/^Discard ~$/i.test(p)) cost.discardSelf = true;
    else if (/^Discard your hand$/i.test(p)) cost.discard = 'hand';
    else if ((m = p.match(/^Discard (?:a|an|(\w+)) cards? at random$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') return null;
      cost.discard = { count: n, random: true };
    }
    else if ((m = p.match(/^Discard (?:a|an|(\w+)) (.+?)s?$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null) return null;
      if (/^cards?$/i.test(m[2])) cost.discard = { count: n };
      else {
        const noun = parseNoun(`a ${m[2]} card`);
        if (!noun) return null;
        cost.discard = { count: n, filter: noun.filter };
      }
    } else if ((m = p.match(/^Remove (?:a|an|(\w+)|any number of|all) ([+-]\d\/[+-]\d|\w+) counters? from ~$/i))) {
      const n = /any number of/i.test(p) ? 'X' : /^Remove all /i.test(p) ? 'all' : m[1] ? wordToNumber(m[1]) : 1;
      if (n === null) return null;
      cost.removeCounters = { counter: m[2], amount: n };
    } else if ((m = p.match(/^Put (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on ~$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') return null;
      cost.addCounters = { counter: m[2], amount: n };
    } else if (/^Exile ~ from your graveyard$/i.test(p)) cost.exileSelf = true;
    else if (/^Exile ~$/i.test(p)) cost.exileSelf = true;
    else if ((m = p.match(/^Exile (?:a|an|(\w+)) (.+?) cards? from your graveyard$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      const noun = m[2] ? parseNoun(`a ${m[2]} card`) : { filter: {} };
      if (n === null || !noun) return null;
      cost.exileFromGraveyard = { filter: noun.filter, count: n };
    } else if ((m = p.match(/^Exile (?:a|an|(\w+)) cards? from your graveyard$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') return null;
      cost.exileFromGraveyard = { filter: {}, count: n };
    } else if ((m = p.match(/^Tap (?:an|(\w+)) untapped (.+?) you control$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      const noun = parseNoun(`a ${m[2]}`);
      if (n === null || n === 'X' || !noun) return null;
      cost.tapUntapped = { filter: noun.filter, count: n };
    } else if (/^Return ~ to its owner's hand$/i.test(p)) cost.returnSelf = true;
    else if (/^Reveal ~ from your hand$/i.test(p)) cost.revealSelf = true;
    else if ((m = p.match(/^Return (?:a|an|(\w+)) (.+?) you control to (?:its|their) owner'?s'? hands?$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      const noun = parseNoun(`a ${m[2]}`);
      if (n === null || n === 'X' || !noun) return null;
      cost.returnToHand = { filter: noun.filter, count: n };
    } else return null;
  }
  return cost;
}

/** Trailing restrictions: "Activate only as a sorcery." etc. */
const STEP_WORDS: Record<string, string[]> = { upkeep: ['upkeep'], 'draw step': ['draw'], 'end step': ['end'], combat: ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'], 'main phase': ['main1', 'main2'], 'precombat main phase': ['main1'], 'postcombat main phase': ['main2'], 'declare attackers step': ['declareAttackers'], 'declare blockers step': ['declareBlockers'] };

export function parseActivationRestriction(text: string): { text: string; sorcerySpeed?: boolean; oncePerTurn?: boolean; exhaust?: boolean; yourTurn?: boolean; condition?: Condition; unhandled?: string } {
  let t = text.trim().replace(/^"(.*)"$/, '$1').replace(/Activate only (.+?) and only (.+?)\.?$/i, 'Activate only $1. Activate only $2.').replace(/\s*Activate only as an instant\.?$/i, '');
  const out: { text: string; sorcerySpeed?: boolean; oncePerTurn?: boolean; exhaust?: boolean; yourTurn?: boolean; condition?: Condition; unhandled?: string } = { text: t };
  let m: RegExpMatchArray | null;
  const addCond = (c: Condition) => {
    out.condition = out.condition ? { kind: 'and', cs: [out.condition, c] } : c;
  };
  for (;;) {
    if ((m = t.match(/^(.*?)\s*Activate only as a sorcery\.?$/i))) {
      out.sorcerySpeed = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only once\.?$/i))) {
      out.exhaust = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only once each turn\.?$/i))) {
      out.oncePerTurn = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during your turn\.?$/i))) {
      out.yourTurn = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during your turn, before attackers are declared\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers'], player: 'you', beforeAttackers: true });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during (your|an opponent's|each|the) (upkeep|draw step|end step|combat|main phase|precombat main phase|postcombat main phase|declare attackers step|declare blockers step)\.?$/i))) {
      addCond({ kind: 'turnStep', steps: STEP_WORDS[m[3].toLowerCase()], player: m[2].toLowerCase() === 'your' ? 'you' : /opponent/i.test(m[2]) ? 'opponent' : 'any' });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during an opponent's turn\.?$/i))) {
      addCond({ kind: 'notYourTurn' });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only before (?:blockers are declared|the declare blockers step)\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only before attackers are declared\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers'], beforeAttackers: true });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only before the combat damage step\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during (?:the )?(?:declare blockers step|combat after blockers are declared)\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during your (?:precombat |first )?main phase\.?$/i))) {
      addCond({ kind: 'turnStep', steps: /precombat|first/i.test(m[0]) ? ['main1'] : ['main1', 'main2'], player: 'you' });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during combat\.?$/i))) {
      addCond({ kind: 'turnStep', steps: STEP_WORDS.combat });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only if (.+?)\.?$/i)) && parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })) {
      addCond(parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })!);
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only (.+?)\.?$/i))) {
      out.unhandled = `Activate only ${m[2]}`;
      t = m[1];
    } else break;
  }
  out.text = t.trim();
  return out;
}
