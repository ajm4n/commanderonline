/** Activated-ability cost parsing. */
import type { AbilityCost, Condition } from '@commander/engine';
import { parseNoun, singularize, singularizeList } from './nouns.js';
import { wordToNumber } from './text.js';
import { parseCondition } from './conditions.js';

const MANA_RE = /^(?:\{[^}]+\})+$/;

export function parseCost(text: string): AbilityCost | null {
  const cost: AbilityCost = {};
  // "you may sacrifice a creature" — an optional (additional) cost.
  {
    const om = text.match(/^You may (.+)$/i);
    if (om && !/^(?:blight|collect evidence)/i.test(om[1])) {
      const inner = parseCost(om[1].replace(/^[a-z]/, (c) => c.toUpperCase()));
      if (inner) return { ...inner, optional: true };
      return null;
    }
  }
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
  // "Discard a card and sacrifice a creature": two costs joined by "and".
  {
    const am = text.match(/^(.+?) and (pay .+|sacrifice .+|discard .+|exile .+|tap .+)$/i);
    if (am && !/,/.test(text)) {
      const norm = (x: string) => x.replace(/^pay ((?:\{[^}]+\})+)$/i, '$1');
      const a = parseCost(norm(am[1]).replace(/^[a-z]/, (c) => c.toUpperCase()));
      const b = parseCost(norm(am[2]).replace(/^[a-z]/, (c) => c.toUpperCase()));
      if (a && b && !Object.keys(a).some((k) => k in b)) return { ...a, ...b };
    }
  }
  // "Remove a counter from an artifact, creature, land, or planeswalker you control": comma list.
  {
    const rm = text.match(/^Remove (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+ )?counters? from (?:a|an) ([\w -]+(?:, [\w -]+)+,? or [\w -]+)$/i);
    if (rm) {
      const listed = singularizeList(rm[3].replace(/,? and\/or /g, ', or '));
      const noun = parseNoun(`an ${listed}`) ?? parseNoun(`a ${listed}`);
      const n = rm[1] ? wordToNumber(rm[1]) : 1;
      if (noun && noun.confident && typeof n === 'number') {
        return { removeCountersFrom: { counter: rm[2] ? rm[2].trim() : 'any', amount: n, filter: { ...noun.filter, zone: 'battlefield' } } };
      }
    }
  }
  // "Sacrifice an artifact, creature, or land": the list has commas, so it must be read whole.
  {
    const sm = text.match(/^Sacrifice (?:a|an) ([\w -]+(?:, [\w -]+)+,? or [\w -]+)$/i);
    if (sm) {
      const listed = singularizeList(sm[1].replace(/,? and\/or /g, ', or '));
      const noun = parseNoun(`an ${listed}`) ?? parseNoun(`a ${listed}`);
      if (noun && noun.confident) return { sacrifice: { filter: { ...noun.filter, zone: 'battlefield' }, count: 1 } };
    }
  }
  // Costs whose own text contains commas ("Tap four untapped artifacts, creatures, and/or lands you control").
  {
    const tm = text.match(/^Tap (\w+) (?:other )?untapped (.+?) you control$/i);
    if (tm && /,/.test(tm[2])) {
      const n = wordToNumber(tm[1]);
      const listed = singularizeList(tm[2].replace(/,? and\/or /g, ', or '));
      const noun = parseNoun(`an ${listed} you control`) ?? parseNoun(`a ${listed}`);
      if (noun && n !== null && n !== 'X') return { tapUntapped: { filter: { ...noun.filter, zone: 'battlefield' }, count: n } };
    }
  }
  // Split on commas not inside braces (", rounded up" is not a cost separator).
  const parts = text.replace(/, rounded (up|down)/gi, ' rounded $1').split(/,\s*(?![^{]*\})/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    let m: RegExpMatchArray | null;
    let matched = false;
    kp1: if (p === '{T}') {
      cost.tap = true;
      matched = true;
    }
    if (!matched) kp2: if ((m = p.match(/^Waterbend \{(\d+|X)\}$/i))) {
      cost.waterbend = m[1].toUpperCase() === 'X' ? 'X' : parseInt(m[1], 10);
      matched = true;
    }
    if (!matched) kp3: if ((m = p.match(/^Exile (?:(any number of|X|\w+) )?(.+?) (?:you control|from your graveyard)$/i))) {
      const fromGy = /from your graveyard$/i.test(p);
      const other3 = /^another$/i.test(m[1] ?? '');
      const noun = parseNoun(`${other3 ? 'another' : 'a'} ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
      if (!noun) break kp3;
      const n: number | 'any' | 'X' | null = !m[1] || other3 ? 1 : /any number of/i.test(m[1]) ? 'any' : m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as number | null);
      if (n === null) break kp3;
      if (fromGy) cost.exileFromGraveyard = { filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: n === 'any' ? 'X' : n };
      else cost.exileObjects = { filter: { ...noun.filter, zone: 'battlefield', controller: 'you' }, count: n };
      matched = true;
    }
    if (!matched) kp4: if ((m = p.match(/^Put (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on (?:a|an) (.+?) you control$/i))) {
      const noun = parseNoun(`a ${m[3]}`);
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (!noun || n === null || n === 'X') break kp4;
      cost.putCounters = { counter: m[2] as import('@commander/engine').CounterType, amount: n, filter: { ...noun.filter, zone: 'battlefield', controller: 'you' } };
      matched = true;
    }
    if (!matched) kp5: if ((m = p.match(/^Sacrifice (X|\w+) (.+?)s$/i)) && (m[1].toUpperCase() === 'X' || typeof wordToNumber(m[1]) === 'number')) {
      const noun = parseNoun(`a ${m[2]}`);
      if (!noun) break kp5;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield' }, count: m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as number) };
      matched = true;
    }
    if (!matched) kp6: if ((m = p.match(/^(You may )?Blight (\d+)$/i))) {
      cost.blight = parseInt(m[2], 10);
      if (m[1]) cost.blightOptional = true;
      matched = true;
    }
    if (!matched) kp7: if ((m = p.match(/^(you may )?collect evidence (\d+)$/i))) {
      cost.collectEvidence = { n: parseInt(m[2], 10), optional: !!m[1] || undefined };
      matched = true;
    }
    if (!matched) kp8: if ((m = p.match(/^Behold (?:a|an) (.+?)( and exile it)?$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (!noun) break kp8;
      cost.behold = { ...noun.filter, types: ['Creature'] };
      if (m[2]) cost.beholdExile = true;
      matched = true;
    }
    if (!matched) kp9: if ((m = p.match(/^Reveal (?:a|an) (.+?) card from your hand$/i))) {
      const noun = parseNoun(`a ${m[1]} card`);
      if (!noun) break kp9;
      cost.revealFromHand = noun.filter;
      matched = true;
    }
    if (!matched) kp10: if (/^Choose a creature type$/i.test(p)) {
      cost.chooseCreatureType = true;
      matched = true;
    }
    if (!matched) kp11: if ((m = p.match(/^Tap any number of untapped (.+?) you control$/i))) {
      const noun = parseNoun(`a ${singularize(m[1])}`);
      if (!noun) break kp11;
      cost.tapUntapped = { filter: noun.filter, count: 'any' };
      matched = true;
    }
    if (!matched) kp12: if ((m = p.match(/^Sacrifice any number of (.+)$/i))) {
      const noun = parseNoun(`a ${singularize(m[1])}`);
      if (!noun) break kp12;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield' }, count: 'any' };
      matched = true;
    }
    if (!matched) kp13: if (/^Forage$/i.test(p)) {
      cost.choice = [{ exileFromGraveyard: { filter: {}, count: 3 } }, { sacrifice: { filter: { subtypes: ['Food'], zone: 'battlefield' }, count: 1 } }];
      matched = true;
    }
    if (!matched) kp14: if (p === '{Q}') {
      cost.untap = true;
      matched = true;
    }
    if (!matched) kp15: if (MANA_RE.test(p)) {
      // {T} may be embedded like "{1}{T}"? Rare. Mana cost.
      const energy = p.match(/\{E\}/g);
      if (energy && energy.length === (p.match(/\{[^}]+\}/g) ?? []).length) cost.energy = energy.length;
      else cost.mana = p.replace(/\{T\}/g, '');
      matched = true;
    }
    if (!matched) kp16: if (/^Sacrifice ~$/i.test(p)) {
      cost.sacrificeSelf = true;
      matched = true;
    }
    if (!matched) kp17: if ((m = p.match(/^Sacrifice ~ and (?:a|an) (.+)$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (!noun) break kp17;
      cost.sacrificeSelf = true;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield' }, count: 1 };
      matched = true;
    }
    if (!matched) kp18: if ((m = p.match(/^Sacrifice (?:a|an) (.+?) attached to ~$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (!noun) break kp18;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield', attachedToSource: true }, count: 1 };
      matched = true;
    }
    if (!matched) kp19: if ((m = p.match(/^Exile (?:(any number of|X|\w+) )?(.+?) from your hand$/i))) {
      const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
      if (!noun) break kp19;
      const n: number | 'any' | 'X' | null = !m[1] ? 1 : /any number of/i.test(m[1]) ? 'any' : m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as number | null);
      if (n === null) break kp19;
      cost.exileObjects = { filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n };
      matched = true;
    }
    if (!matched) kp20: if ((m = p.match(/^Tap (\w+) (?:other )?untapped (.+?) you control(?: that share a creature type)?$/i)) && typeof wordToNumber(m[1]) === 'number') {
      const n = wordToNumber(m[1]);
      // "artifacts, creatures, and/or lands" → "an artifact, creature, or land"
      const listed = singularizeList(m[2].replace(/,? and\/or /g, ', or '));
      const noun = parseNoun(`an ${listed} you control`) ?? parseNoun(`a ${listed}`) ?? parseNoun(`a ${m[2]}`);
      if (!noun || n === null || n === 'X') break kp20;
      cost.tapUntapped = { filter: { ...noun.filter, zone: 'battlefield' }, count: n };
      matched = true;
    }
    if (!matched) kp21: if ((m = p.match(/^Sacrifice (?:a|an|another|(\w+)) (.+)$/i))) {
      const noun = parseNoun(`a ${m[2]}`);
      if (!noun) break kp21;
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') break kp21;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield', other: /another/i.test(p) || undefined }, count: n };
      matched = true;
    }
    if (!matched) if (/^Put (?:a|an) card an opponent owns from exile into that player's graveyard$/i.test(p)) {
      cost.processFromExile = {};
      matched = true;
    }
    if (!matched) kp21x: if ((m = p.match(/^Reveal X (white|blue|black|red|green|colorless|artifact|creature|land|nonland|instant|sorcery) cards from your hand$/i))) {
      const noun = parseNoun(`a ${m[1]} card`);
      if (!noun || !noun.confident) break kp21x;
      const f = { ...noun.filter };
      delete f.zone;
      cost.revealFromHandX = f;
      matched = true;
    }
    if (!matched) kp22: if ((m = p.match(/^Pay (\d+) life$/i))) {
      cost.payLife = parseInt(m[1], 10);
      matched = true;
    }
    if (!matched) kp23: if (/^Pay X life$/i.test(p)) {
      cost.payLife = 'X';
      matched = true;
    }
    if (!matched) kp24: if ((m = p.match(/^Pay ((?:\{E\})+)$/i))) {
      cost.energy = (m[1].match(/\{E\}/g) ?? []).length;
      matched = true;
    }
    if (!matched) kp25: if (/^Pay X \{E\}$/i.test(p)) {
      cost.energy = 'X';
      matched = true;
    }
    if (!matched) kp26: if ((m = p.match(/^Pay (\w+) \{E\}$/i)) && typeof wordToNumber(m[1]) === 'number') {
      cost.energy = wordToNumber(m[1]) as number;
      matched = true;
    }
    if (!matched) kp27: if (/^Discard ~$/i.test(p)) {
      cost.discardSelf = true;
      matched = true;
    }
    if (!matched) kp28: if (/^Discard your hand$/i.test(p)) {
      cost.discard = 'hand';
      matched = true;
    }
    if (!matched) kp29: if ((m = p.match(/^Discard (?:a|an|(\w+)) cards? at random$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null) break kp29;
      cost.discard = { count: n, random: true };
      matched = true;
    }
    if (!matched) kp30: if ((m = p.match(/^Discard (?:a|an|(\w+)) (.+?)s?$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null) break kp30;
      if (/^cards?$/i.test(m[2])) cost.discard = { count: n };
      else {
        const noun = parseNoun(`a ${m[2]} card`);
        if (!noun) break kp30;
        cost.discard = { count: n, filter: noun.filter };
      }
      matched = true;
    }
    if (!matched) kp31: if ((m = p.match(/^Remove one or more ([+-]\d\/[+-]\d|\w+) counters? from ~$/i))) {
      cost.removeCounters = { counter: m[1] as import('@commander/engine').CounterType, amount: 'X' };
      matched = true;
    }
    if (!matched) kp32: if ((m = p.match(/^Remove (?:a|an|(\w+)) counters? from ~$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null) break kp32;
      cost.removeCounters = { counter: 'any', amount: n };
      matched = true;
    }
    if (!matched) kp33: if ((m = p.match(/^Remove (?:a|an|(\w+)|any number of|all) ([+-]\d\/[+-]\d|\w+) counters? from ~$/i))) {
      const n = /any number of/i.test(p) ? 'X' : /^Remove all /i.test(p) ? 'all' : m[1] ? wordToNumber(m[1]) : 1;
      if (n === null) break kp33;
      cost.removeCounters = { counter: m[2], amount: n };
      matched = true;
    }
    if (!matched) kp34: if ((m = p.match(/^Put (?:a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on ~$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') break kp34;
      cost.addCounters = { counter: m[2], amount: n };
      matched = true;
    }
    if (!matched) kp35: if (/^Exile ~ from your graveyard$/i.test(p)) {
      cost.exileSelf = true;
      matched = true;
    }
    if (!matched) kp36: if (/^Exile ~$/i.test(p)) {
      cost.exileSelf = true;
      matched = true;
    }
    if (!matched) kp37: if ((m = p.match(/^Exile (?:a|an|(\w+)) (.+?) cards? from (your|a|a single) graveyard$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      const noun = m[2] ? parseNoun(`a ${m[2]} card`) : { filter: {} };
      if (n === null || !noun) break kp37;
      cost.exileFromGraveyard = { filter: /^your$/i.test(m[3]) ? { ...noun.filter, owner: 'you' } : noun.filter, count: n };
      matched = true;
    }
    if (!matched) kp37b: if ((m = p.match(/^Exile the top (?:(.+?) )?cards? of your graveyard$/i))) {
      const noun = m[1] ? parseNoun(`a ${m[1]} card`) : { filter: {} };
      if (!noun) break kp37b;
      cost.exileFromGraveyard = { filter: { ...noun.filter, topOfGraveyard: true }, count: 1 };
      matched = true;
    }
    if (!matched) kp38: if ((m = p.match(/^Exile (?:a|an|(\w+)) cards? from your graveyard$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (n === null || n === 'X') break kp38;
      cost.exileFromGraveyard = { filter: {}, count: n };
      matched = true;
    }
    if (!matched) kp39: if ((m = p.match(/^Tap (?:an|(\w+)) untapped (.+?) you control$/i)) && (!m[1] || typeof wordToNumber(m[1]) === 'number')) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      const noun = parseNoun(`a ${m[2]}`);
      if (n === null || n === 'X' || !noun) break kp39;
      cost.tapUntapped = { filter: noun.filter, count: n };
      matched = true;
    }
    if (!matched) kp40: if (/^Return ~ to its owner's hand$/i.test(p)) {
      cost.returnSelf = true;
      matched = true;
    }
    if (!matched) kp41: if (/^Reveal ~ from your hand$/i.test(p)) {
      cost.revealSelf = true;
      matched = true;
    }
    if (!matched) kp42: if ((m = p.match(/^Return (?:a|an|(\w+)) (.+?) you control to (?:its|their) owner'?s'? hands?$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      const noun = parseNoun(`a ${m[2]}`);
      if (n === null || n === 'X' || !noun) break kp42;
      cost.returnToHand = { filter: noun.filter, count: n };
      matched = true;
    }
    if (!matched) kp43: if ((m = p.match(/^Tap (?:an|another|X|(\w+)) untapped (.+?)(?: you control)?$/i))) {
      const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
      if (!noun) break kp43;
      const n: number | 'X' | null = /\bX untapped\b/.test(p) ? 'X' : m[1] ? (wordToNumber(m[1]) as number | null) : 1;
      if (n === null) break kp43;
      cost.tapUntapped = { filter: { ...noun.filter, zone: 'battlefield', controller: /you control/i.test(p) ? 'you' : undefined, other: /another/i.test(p) || undefined }, count: n };
      matched = true;
    }
    if (!matched) kp44: if ((m = p.match(/^Untap (?:a|an|(\w+)) tapped (.+?)(?: (?:you|an opponent) controls?)?$/i))) {
      const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (!noun || typeof n !== 'number') break kp44;
      cost.untapOther = { filter: { ...noun.filter, zone: 'battlefield', controller: /an opponent controls/i.test(p) ? 'opponent' : /you control/i.test(p) ? 'you' : undefined }, count: n };
      matched = true;
    }
    if (!matched) kp45: if (/^Tap (?:enchanted|equipped) \w+$/i.test(p)) {
      cost.tapAttached = true;
      matched = true;
    }
    if (!matched) kp46: if (/^Sacrifice (?:enchanted|equipped) \w+$/i.test(p)) {
      cost.sacrificeAttached = true;
      matched = true;
    }
    if (!matched) kp47: if (/^Exert ~$/i.test(p)) {
      cost.exert = true;
      matched = true;
    }
    if (!matched) kp48: if ((m = p.match(/^Mill (?:a|an|(\w+)) cards?$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp48;
      cost.mill = n;
      matched = true;
    }
    if (!matched) kp49: if ((m = p.match(/^Exile the top (?:(\w+) )?(.*?)cards? of your (library|graveyard)$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp49;
      const f = m[2].trim() ? parseNoun(`a ${m[2].trim()} card`)?.filter : undefined;
      if (m[2].trim() && !f) break kp49;
      cost.exileTop = { count: n, from: /library/i.test(m[3]) ? 'library' : 'graveyard', filter: f ? { ...f, zone: undefined } : undefined };
      matched = true;
    }
    if (!matched) kp50: if ((m = p.match(/^Put (?:a|an|(\w+)) cards? from your hand on (?:the )?(top|bottom) of your library$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp50;
      cost.handToLibrary = { count: n, position: /top/i.test(m[2]) ? 'top' : 'bottom' };
      matched = true;
    }
    if (!matched) kp51: if ((m = p.match(/^Put (?:(\w+) )?cards? from your graveyard on (?:the )?(top|bottom) of your library$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp51;
      cost.exileTop = { count: n, from: 'graveyard' };
      matched = true;
    }
    if (!matched) kp52: if ((m = p.match(/^Remove (?:a|an|one or more|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? from (?:(?:a|an|another) |among )(.+)$/i))) {
      const noun = parseNoun(`a ${singularize(m[3])}`) ?? parseNoun(`a ${m[3]}`);
      const n = /one or more/i.test(p) ? 1 : m[1] ? wordToNumber(m[1]) : 1;
      if (!noun || typeof n !== 'number') break kp52;
      cost.removeCountersFrom = { counter: m[2], amount: n, filter: { ...noun.filter, zone: 'battlefield', other: /from another /i.test(p) || undefined } };
      matched = true;
    }
    if (!matched) kp53: if ((m = p.match(/^Remove (?:a|an|(\w+)) counters? from (?:a|an|another) (.+)$/i))) {
      const noun = parseNoun(`a ${m[2]}`);
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (!noun || typeof n !== 'number') break kp53;
      cost.removeCountersFrom = { counter: 'any', amount: n, filter: { ...noun.filter, zone: 'battlefield', other: /from another /i.test(p) || undefined } };
      matched = true;
    }
    if (!matched) kp54: if ((m = p.match(/^Remove (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? from ~ and sacrifice it$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp54;
      cost.removeCounters = { counter: m[2], amount: n };
      cost.sacrificeSelf = true;
      matched = true;
    }
    if (!matched) kp55: if ((m = p.match(/^Remove (X|\d+|\w+) ([+-]\d\/[+-]\d|[\w'-]+) counters? from ~ and exile it$/i))) {
      const n: number | 'X' | null = m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as number | null);
      if (n === null) break kp55;
      cost.removeCounters = { counter: m[2], amount: n };
      cost.exileSelf = true;
      matched = true;
    }
    if (!matched) kp56: if ((m = p.match(/^Reveal (?:a|an|(\w+)) (.+?) from your hand(?: that .+| with .+)?$/i)) && (!m[1] || typeof wordToNumber(m[1]) === 'number')) {
      const noun = parseNoun(/\bcards?\b/i.test(m[2]) ? `a ${m[2].replace(/s\b/, '')}` : `a ${m[2]} card`);
      if (!noun) break kp56;
      cost.revealFromHand = noun.filter;
      if (m[1]) cost.revealFromHandCount = wordToNumber(m[1]) as number;
      matched = true;
    }
    if (!matched) kp57: if ((m = p.match(/^Remove (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? from among (.+)$/i))) {
      const noun = parseNoun(`a ${m[3]}`);
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (!noun || typeof n !== 'number') break kp57;
      cost.removeCountersFrom = { counter: m[2], amount: n, filter: { ...noun.filter, zone: 'battlefield' } };
      matched = true;
    }
    if (!matched) kp58: if ((m = p.match(/^Discard (?:a|an|(\w+)) cards? with different names$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp58;
      cost.discard = { count: n };
      matched = true;
    }
    if (!matched) kp59: if ((m = p.match(/^Discard (?:a|an) card with mana value (X|\d+)$/i))) {
      cost.discard = { count: 1, filter: m[1].toUpperCase() === 'X' ? { cmcEQ: 'X' as unknown as number } : { cmcEQ: parseInt(m[1], 10) } };
      matched = true;
    }
    if (!matched) kp60: if (/^Pay half your life rounded (?:up|down)$/i.test(p)) {
      cost.payLife = /down/i.test(p) ? 'halfDown' : 'halfUp';
      matched = true;
    }
    if (!matched) kp61: if ((m = p.match(/^Exile (?:a|an|(\w+)) cards? from your graveyard and ~$/i))) {
      const n = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n !== 'number') break kp61;
      cost.exileFromGraveyard = { filter: {}, count: n };
      cost.exileSelf = true;
      matched = true;
    }
    if (!matched) kp62: if ((m = p.match(/^Sacrifice one or more (.+?)s$/i))) {
      const noun = parseNoun(`a ${m[1]}`);
      if (!noun) break kp62;
      cost.sacrifice = { filter: { ...noun.filter, zone: 'battlefield' }, count: 'any' };
      matched = true;
    }
    if (!matched) kp63: if (/^Discard another card named ~$/i.test(p)) {
      cost.discard = { count: 1, filter: { nameIs: '~' } };
      matched = true;
    }
    if (!matched) return null;
  }
  return cost;
}

/** Trailing restrictions: "Activate only as a sorcery." etc. */
const STEP_WORDS: Record<string, string[]> = { upkeep: ['upkeep'], 'draw step': ['draw'], 'end step': ['end'], combat: ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'], 'main phase': ['main1', 'main2'], 'precombat main phase': ['main1'], 'postcombat main phase': ['main2'], 'declare attackers step': ['declareAttackers'], 'declare blockers step': ['declareBlockers'] };

export function parseActivationRestriction(text: string): { text: string; sorcerySpeed?: boolean; oncePerTurn?: boolean; perTurnLimit?: number; exhaust?: boolean; anyPlayer?: boolean; opponentsOnly?: boolean; yourTurn?: boolean; condition?: Condition; unhandled?: string } {
  let t = text.trim().replace(/^"(.*)"$/, '$1').replace(/Activate only (.+?) and only (.+?)\.?$/i, 'Activate only $1. Activate only $2.').replace(/\s*Activate only as an instant\.?$/i, '');
  const out: { text: string; sorcerySpeed?: boolean; oncePerTurn?: boolean; perTurnLimit?: number; exhaust?: boolean; anyPlayer?: boolean; opponentsOnly?: boolean; yourTurn?: boolean; condition?: Condition; unhandled?: string } = { text: t };
  let m: RegExpMatchArray | null;
  const addCond = (c: Condition) => {
    out.condition = out.condition ? { kind: 'and', cs: [out.condition, c] } : c;
  };
  // Two restrictions on one line: parse each and merge ("Activate only as a sorcery. Activate only if …").
  if ((m = t.match(/^(Activate only [^.]+)\.\s*(Activate only .+?)\.?$/i))) {
    const a = parseActivationRestriction(m[1]);
    const b = parseActivationRestriction(m[2]);
    if (a.unhandled || b.unhandled) return { text: '', unhandled: text.trim() };
    const cond = a.condition && b.condition ? ({ kind: 'and', cs: [a.condition, b.condition] } as Condition) : a.condition ?? b.condition;
    return { ...a, ...b, text: '', condition: cond };
  }
  for (;;) {
    if ((m = t.match(/^(.*?)\s*Activate only as a sorcery\.?$/i))) {
      out.sorcerySpeed = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Any player may activate this ability(?: but only during (?:any|an) upkeep step| but only during their (?:draw step|turn|upkeep))?\.?$/i))) {
      out.anyPlayer = true;
      if (/upkeep/i.test(m[0])) addCond({ kind: 'turnStep', steps: ['upkeep'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only once\.?$/i))) {
      out.exhaust = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Only your opponents may activate this ability(?: and only as a sorcery)?\.?$/i))) {
      out.opponentsOnly = true;
      if (/as a sorcery/i.test(m[0])) out.sorcerySpeed = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during (?:any|an) upkeep step\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['upkeep'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only during the end of combat step\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['endCombat'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate only once each turn\.?$/i))) {
      out.oncePerTurn = true;
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*Activate (?:no more than|only) (twice|three times|four times|\w+ times) each turn\.?$/i))) {
      out.perTurnLimit = ({ twice: 2, 'three times': 3, 'four times': 4, 'five times': 5 } as Record<string, number>)[m[2].toLowerCase()] ?? 2;
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
    } else if ((m = t.match(/^(.*?)\s*Any player may activate this ability but only during their turn before the end step\.?$/i))) {
      out.anyPlayer = true;
      addCond({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2'] });
      t = m[1];
    } else if ((m = t.match(/^(.*?)\s*You cannot activate this ability during combat\.?$/i))) {
      addCond({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'main2', 'end', 'cleanup'] });
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
