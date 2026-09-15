/**
 * Oracle text → CardScript compiler. Turns templated rules text into
 * executable scripts so the engine can automate cards nobody hand-scripted.
 */
import type { AbilitySpec, ActivatedAbilitySpec, CardData, CardScript, Effect, TargetSpec, TriggeredAbilitySpec, Condition, CostModifier } from '@commander/engine';
import { ENFORCED_KEYWORDS } from '@commander/engine';
import { normalizeOracle } from './text.js';
import { parseEffects, newCtx, parseSentence, isNoOpSentence, type ParseCtx } from './effects.js';
import { parseTriggerHead, splitTriggerRest } from './triggers.js';
import { parseCost, parseActivationRestriction } from './costs.js';
import { parseStatic } from './statics.js';
import { parseCondition } from './conditions.js';
import { parseNoun } from './nouns.js';
import { parseTypeLine } from '@commander/engine';

export interface CompileResult {
  script: CardScript;
  compiledLines: string[];
  unhandledLines: string[];
}

const KEYWORD_LINE_RE = /^(Flying|First strike|Double strike|Deathtouch|Lifelink|Trample|Vigilance|Haste|Flash|Defender|Reach|Menace|Hexproof|Indestructible|Shroud|Fear|Intimidate|Skulk|Horsemanship|Shadow|Infect|Wither|Toxic \d+|Prowess|Changeling|Devoid|Partner|Partner with [^,;]+|Friends forever|Choose a Background|Ward (?:\{[^}]+\})+|Ward—[^.]+|Protection from [^,;]+|Hexproof from [^,;]+|Enchant [^,;]+|Equip (?:\{[^}]+\})+|Equip \d+|Kicker (?:\{[^}]+\})+|Flashback (?:\{[^}]+\})+|Flashback—[^.]+|Cycling (?:\{[^}]+\})+|Undying|Persist|Exalted|Convoke|Delve|Affinity for \w+|Improvise|Cascade|Storm|Rebound|Split second|Riot|Unleash|Mentor|Landwalk|Islandwalk|Swampwalk|Forestwalk|Mountainwalk|Plainswalk|Flanking|Bushido \d+|Rampage \d+|Annihilator \d+|Battle cry|Extort|Ingest|Myriad|Melee|Dethrone|Afflict \d+|Fabricate \d+|Crew \d+|Ninjutsu (?:\{[^}]+\})+|Commander ninjutsu (?:\{[^}]+\})+|Buyback (?:\{[^}]+\})+|Evoke (?:\{[^}]+\})+|Escape—[^.]+|Unearth (?:\{[^}]+\})+|Emerge (?:\{[^}]+\})+|Madness (?:\{[^}]+\})+|Morph (?:\{[^}]+\})+|Megamorph (?:\{[^}]+\})+|Disguise (?:\{[^}]+\})+|Miracle (?:\{[^}]+\})+|Dredge \d+|Suspend \d+—(?:\{[^}]+\})+|Vanishing \d+|Fading \d+|Echo (?:\{[^}]+\})+|Cumulative upkeep [^.]+|Modular \d+|Sunburst|Graft \d+|Bloodthirst \d+|Devour \d+|Undaunted|Living weapon|Daybound|Nightbound|Decayed|Disturb (?:\{[^}]+\})+|Training|Backup \d+|Blitz (?:\{[^}]+\})+|Casualty \d+|Enlist|Ravenous|Boast — [^.]+|Foretell (?:\{[^}]+\})+|Squad (?:\{[^}]+\})+|Reconfigure (?:\{[^}]+\})+|Compleated|For Mirrodin!|Prototype [^.]+|Encore (?:\{[^}]+\})+|Mutate (?:\{[^}]+\})+|Escalate (?:\{[^}]+\})+|Surge (?:\{[^}]+\})+|Awaken \d+—(?:\{[^}]+\})+|Renown \d+|Outlast (?:\{[^}]+\})+|Prowl (?:\{[^}]+\})+|Conspire|Retrace|Reinforce \d+—(?:\{[^}]+\})+|Champion [^.]+|Evolve|Cipher|Bestow (?:\{[^}]+\})+|Tribute \d+|Dash (?:\{[^}]+\})+|Embalm (?:\{[^}]+\})+|Eternalize (?:\{[^}]+\})+|Exert|Ascend|Jump-start|Afterlife \d+|Spectacle (?:\{[^}]+\})+|Amass \w+ \d+|Adventure|Offspring (?:\{[^}]+\})+|Impending \d+—(?:\{[^}]+\})+|Gift [^.]+|Bargain|Cleave (?:\{[^}]+\})+|Companion — [^.]+|Level up (?:\{[^}]+\})+|Soulbond|Haunt|Aura swap (?:\{[^}]+\})+|Fortify (?:\{[^}]+\})+|Transmute (?:\{[^}]+\})+|Ripple \d+|Frenzy \d+|Gravestorm|Poisonous \d+|Recover (?:\{[^}]+\})+|Absorb \d+|Vanishing|Wither|Provoke|Entwine (?:\{[^}]+\})+|Splice onto [^.]+|Offering|Epic|Hidden agenda|Double agenda|Assist|Legendary landwalk|Nonbasic landwalk|Desertwalk|Phasing|Banding|Rampage|Shadow|Totem armor|Vigilance|Hideaway \d+|Job select|Start your engines!|Saddle \d+|Spree|Plot|Freerunning (?:\{[^}]+\})+|Umbra armor|Devoid)$/i;

function isKeywordLine(line: string): boolean {
  const parts = line.replace(/\.$/, '').split(/[,;]\s*/);
  if (!parts.length) return false;
  return parts.every((p) => {
    const t = p.trim();
    if (KEYWORD_LINE_RE.test(t)) return true;
    const base = t.replace(/\s*(\{.*|\d+|—.*|from .*)$/, '').trim();
    const norm = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
    return ENFORCED_KEYWORDS.has(norm) && base.split(' ').length <= 2;
  });
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };

function compileFace(card: CardData, faceName: string, text: string, typeLine: string): CompileResult {
  const lines = normalizeOracle(card, faceName, text);
  const parsed = parseTypeLine(typeLine);
  const isSpell = parsed.types.includes('Instant') || parsed.types.includes('Sorcery');
  const abilities: AbilitySpec[] = [];
  const compiledLines: string[] = [];
  const unhandledLines: string[] = [];
  const spellEffects: Effect[] = [];
  const spellTargets: TargetSpec[] = [];
  const spellCtx = newCtx({ isSpell: true });
  let modal: { text: string; targets?: TargetSpec[]; effects: Effect[] }[] | null = null;
  let minModes = 1;
  let maxModes = 1;
  let additionalCost: CardScript['additionalCost'];
  const alternativeCosts: NonNullable<CardScript['alternativeCosts']> = [];
  const costModifiers: CostModifier[] = [];
  /** Active LEVEL / STATION block: abilities parsed while it is open get this condition. */
  let block: { condition: Condition; station: boolean } | null = null;
  const withBlock = (abs: AbilitySpec[]): AbilitySpec[] => {
    if (!block) return abs;
    const cond = block.condition;
    return abs.map((a) => {
      if (a.kind === 'static' || a.kind === 'triggered' || a.kind === 'activated') return { ...a, condition: a.condition ? { kind: 'and', cs: [a.condition, cond] } : cond } as AbilitySpec;
      return a;
    });
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let m: RegExpMatchArray | null;
    // LEVEL a-b / LEVEL a+ / STATION a+ blocks
    if ((m = line.match(/^LEVEL (\d+)-(\d+)$/)) || (m = line.match(/^LEVEL (\d+)\+$/)) || (m = line.match(/^STATION (\d+)\+$/))) {
      const station = /^STATION/.test(line);
      const counter = station ? 'charge' : 'level';
      const lo = parseInt(m[1], 10);
      const hi = m[2] !== undefined ? parseInt(m[2], 10) : null;
      const ge: Condition = { kind: 'hasCounter', ref: { ref: 'self' }, counter, op: '>=', value: lo };
      block = { condition: hi === null ? ge : { kind: 'and', cs: [ge, { kind: 'hasCounter', ref: { ref: 'self' }, counter, op: '<=', value: hi }] }, station };
      compiledLines.push(line);
      continue;
    }
    if (block && (m = line.match(/^(\d+|\*)\/(\d+|\*)$/))) {
      const pt = (v: string) => (v === '*' ? 0 : parseInt(v, 10));
      abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: '7b', setPower: pt(m[1]), setToughness: pt(m[2]) }, condition: block.condition });
      if (block.station) abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: 4, addTypes: ['Creature'] }, condition: block.condition });
      compiledLines.push(line);
      continue;
    }
    if (block && isKeywordLine(line)) {
      const kws = line.replace(/\.$/, '').split(/[,;]\s*/).map((k) => k.trim()).map((k) => k.charAt(0).toUpperCase() + k.slice(1).toLowerCase());
      abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: kws }, condition: block.condition });
      compiledLines.push(line);
      continue;
    }
    // Casting keywords with rules the engine implements
    if ((m = line.match(/^Plot ((?:\{[^}]+\})+)$/i))) {
      abilities.push({ kind: 'activated', text: line, cost: { mana: m[1] }, effects: [{ kind: 'plot' }], zone: 'hand', sorcerySpeed: true });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Warp ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'warp', text: `Warp ${m[1]}`, cost: { mana: m[1] }, zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Affinity for (.+)$/i))) {
      const noun = parseNounLoose(m[1]);
      if (noun) {
        costModifiers.push({ amount: 1, direction: 'less', per: { ...noun, controller: 'you' }, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^Level up ((?:\{[^}]+\})+)$/i))) {
      abilities.push({ kind: 'activated', text: line, cost: { mana: m[1] }, effects: [{ kind: 'addCounters', counter: 'level', amount: 1, on: { ref: 'self' } }], sorcerySpeed: true });
      compiledLines.push(line);
      continue;
    }
    if (/^Station$/i.test(line)) {
      abilities.push({ kind: 'activated', text: 'Station', cost: { tapUntapped: { filter: { types: ['Creature'], controller: 'you', other: true }, count: 1 } }, effects: [{ kind: 'addCounters', counter: 'charge', amount: { kind: 'power', ref: { ref: 'chosen', key: 'costTapped' } }, on: { ref: 'self' } }], sorcerySpeed: true });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast for each (.+?)\.?$/i))) {
      const noun = parseNounLoose(m[3]);
      if (noun) {
        costModifiers.push({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', per: noun, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast if (.+?)\.?$/i))) {
      const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        costModifiers.push({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', condition: cond, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast as long as (.+?)\.?$/i))) {
      const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        costModifiers.push({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', condition: cond, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if (isNoOpSentence(line)) {
      compiledLines.push(line);
      continue;
    }
    if (isKeywordLine(line)) {
      compiledLines.push(line);
      // Cycling: an activated ability from hand.
      if ((m = line.match(/^Cycling ((?:\{[^}]+\})+)$/i))) abilities.push({ kind: 'activated', text: line, cost: { mana: m[1], discardSelf: true }, effects: [{ kind: 'draw', amount: 1 }], zone: 'hand' });
      if ((m = line.match(/^Cycling (\d+)$/i))) abilities.push({ kind: 'activated', text: line, cost: { mana: `{${m[1]}}`, discardSelf: true }, effects: [{ kind: 'draw', amount: 1 }], zone: 'hand' });
      continue;
    }
    // Landcycling variants
    if ((m = line.match(/^(Basic landcycling|Landcycling|Plainscycling|Islandcycling|Swampcycling|Mountaincycling|Forestcycling|Wizardcycling|Slivercycling) ((?:\{[^}]+\})+|\d+)\.?$/i))) {
      const cost = /^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2];
      const kind = m[1].toLowerCase();
      const filter = kind === 'basic landcycling' ? { supertypes: ['Basic' as const], types: ['Land'] } : kind === 'landcycling' ? { types: ['Land'] } : kind.endsWith('cycling') && /^(plains|island|swamp|mountain|forest)/.test(kind) ? { types: ['Land'], subtypes: [m[1].replace(/cycling$/i, '')] } : { types: ['Creature'], subtypes: [m[1].replace(/cycling$/i, '')] };
      abilities.push({ kind: 'activated', text: line, cost: { mana: cost, discardSelf: true }, effects: [{ kind: 'searchLibrary', filter: { ...filter, zone: 'library' }, count: 1, destination: 'hand', reveal: true, shuffle: true }], zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    // Modal spells
    if ((m = line.match(/^Choose (one|two|three|one or both|one or more|any number|up to two|up to three)(?: —)?$/i))) {
      modal = [];
      const w = m[1].toLowerCase();
      if (w === 'one') [minModes, maxModes] = [1, 1];
      else if (w === 'two') [minModes, maxModes] = [2, 2];
      else if (w === 'three') [minModes, maxModes] = [3, 3];
      else if (w === 'one or both') [minModes, maxModes] = [1, 2];
      else if (w === 'up to two') [minModes, maxModes] = [1, 2];
      else if (w === 'up to three') [minModes, maxModes] = [1, 3];
      else [minModes, maxModes] = [1, 6];
      compiledLines.push(line);
      continue;
    }
    if (modal && (m = line.match(/^•\s*(.+)$/))) {
      const ctx = newCtx({ isSpell: true });
      const { effects, unhandled } = parseEffects(m[1], ctx);
      modal.push({ text: m[1], targets: ctx.targets, effects });
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
    // Additional costs
    if ((m = line.match(/^As an additional cost to cast (?:this spell|~), (.+?)\.?$/i))) {
      const c = parseCost(m[1].replace(/^sacrifice/i, 'Sacrifice').replace(/^discard/i, 'Discard').replace(/^pay/i, 'Pay').replace(/^exile/i, 'Exile').replace(/^tap/i, 'Tap'));
      if (c) {
        additionalCost = c;
        compiledLines.push(line);
      } else unhandledLines.push(line);
      continue;
    }
    // Saga chapters
    if ((m = line.match(/^((?:I|II|III|IV|V|VI)(?:, (?:I|II|III|IV|V|VI))*) — (.+)$/))) {
      const chapters = m[1].split(', ').map((r) => ROMAN[r]);
      const ctx = newCtx({ isSpell: false });
      const { effects, unhandled } = parseEffects(m[2], ctx);
      for (const ch of chapters) {
        abilities.push({ kind: 'triggered', text: `Chapter ${ch}: ${m[2]}`, event: 'counterAdded', filter: { self: true, counterType: 'lore' }, condition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: 'lore', op: '==', value: ch }, targets: ctx.targets, effects });
      }
      // Sacrifice after final chapter
      if (li === lines.length - 1 || !/^(?:I|II|III|IV|V|VI)/.test(lines[li + 1] ?? '')) {
        const last = Math.max(...chapters);
        abilities.push({ kind: 'triggered', text: 'Sacrifice this Saga after its final chapter.', event: 'counterAdded', filter: { self: true, counterType: 'lore' }, condition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: 'lore', op: '>=', value: last }, effects: [{ kind: 'delayedTrigger', event: 'spellResolved', text: 'Sacrifice saga', effects: [{ kind: 'sacrifice', what: { ref: 'self' } }] }] });
      }
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
    // Planeswalker loyalty abilities: "+1: ...", "−3: ...", "0: ..."
    if ((m = line.match(/^([+−-]?\d+|0): (.+)$/))) {
      const n = parseInt(m[1].replace('−', '-'), 10);
      const ctx = newCtx();
      const rest = parseActivationRestriction(m[2]);
      const { effects, unhandled } = parseEffects(rest.text, ctx);
      abilities.push({ kind: 'activated', text: line, cost: { loyalty: n }, targets: ctx.targets, effects, sorcerySpeed: true });
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
    // Triggered
    if (/^(When|Whenever|At the beginning)/i.test(line)) {
      const head = parseTriggerHead(line);
      if (!head) {
        // Unknown trigger condition: still surface at the right time if we can guess the event roughly.
        unhandledLines.push(line);
        abilities.push(...guessTrigger(line));
        continue;
      }
      const split = splitTriggerRest(head.rest);
      const ctx = newCtx({ triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer });
      let effects: Effect[];
      let unhandled: string[];
      const modalHead = split.rest.match(/^choose (one|two|one or both|one or more|any number)(?: —)?$/i);
      if (modalHead && lines[li + 1]?.startsWith('•')) {
        // Modal trigger: options follow as bullet lines.
        const options: { text: string; effects: Effect[] }[] = [];
        unhandled = [];
        while (lines[li + 1]?.startsWith('•')) {
          li++;
          const optText = lines[li].replace(/^•\s*/, '');
          const r = parseEffects(optText, ctx);
          options.push({ text: optText, effects: r.effects });
          unhandled.push(...r.unhandled);
        }
        const w = modalHead[1].toLowerCase();
        effects = [{ kind: 'chooseMode', options, count: w === 'two' ? 2 : 1 }];
      } else ({ effects, unhandled } = parseEffects(split.rest, ctx));
      let condition: Condition | undefined;
      if (split.condition) condition = parseCondition(split.condition, { self: { ref: 'self' }, lastObj: null, triggerHasObject: head.hasObject }) ?? { kind: 'manual', text: `Is this true: "${split.condition}"?` };
      const heads = [head, ...(head.also ?? []).map((h) => ({ ...h, rest: head.rest }))];
      for (const h of heads) {
        const ab: TriggeredAbilitySpec = { kind: 'triggered', text: line, event: h.event, filter: h.filter, effects, targets: ctx.targets.length ? ctx.targets : undefined, optional: split.optional || undefined, condition, zone: h.zone, leavesTheBattlefield: h.leaves };
        abilities.push(...withBlock([ab]));
      }
      if (unhandled.length) unhandledLines.push(...unhandled.map((u) => `${line.slice(0, line.indexOf(',') + 1)} ${u}`));
      else compiledLines.push(line);
      continue;
    }
    // Activated: "COST: EFFECT"
    const colon = line.indexOf(': ');
    if (colon > 0 && !/^(Choose|Enchant|Equip)/i.test(line)) {
      const costText = line.slice(0, colon);
      const cost = parseCost(costText);
      if (cost) {
        const rest = parseActivationRestriction(line.slice(colon + 2));
        const ctx = newCtx();
        let effects: Effect[];
        let unhandled: string[];
        const modalHead = rest.text.match(/^choose (one|two|one or both)(?: —)?\.?$/i);
        if (modalHead && lines[li + 1]?.startsWith('•')) {
          const options: { text: string; effects: Effect[] }[] = [];
          unhandled = [];
          while (lines[li + 1]?.startsWith('•')) {
            li++;
            const optText = lines[li].replace(/^•\s*/, '');
            const r = parseEffects(optText, ctx);
            options.push({ text: optText, effects: r.effects });
            unhandled.push(...r.unhandled);
          }
          effects = [{ kind: 'chooseMode', options, count: modalHead[1].toLowerCase() === 'two' ? 2 : 1 }];
        } else ({ effects, unhandled } = parseEffects(rest.text, ctx));
        const isMana = effects.length > 0 && effects.every((e) => e.kind === 'addMana' || (e.kind === 'chooseMode' && e.options.every((o) => o.effects.every((x) => x.kind === 'addMana')))) && ctx.targets.length === 0;
        const ab: ActivatedAbilitySpec = { kind: 'activated', text: line, cost, effects, targets: ctx.targets.length ? ctx.targets : undefined, manaAbility: isMana || undefined, sorcerySpeed: rest.sorcerySpeed, oncePerTurn: rest.oncePerTurn, condition: rest.yourTurn ? { kind: 'yourTurn' } : undefined };
        if (cost.discardSelf || cost.exileSelf && /from your graveyard/i.test(costText)) ab.zone = cost.discardSelf ? 'hand' : 'graveyard';
        if (rest.unhandled) {
          ab.condition = { kind: 'manual', text: `${rest.unhandled}?` };
          unhandledLines.push(rest.unhandled);
        }
        abilities.push(...withBlock([ab]));
        if (unhandled.length) unhandledLines.push(...unhandled);
        else compiledLines.push(line);
        continue;
      }
    }
    // Static
    const stat = parseStatic(line, !isSpell);
    if (stat) {
      abilities.push(...withBlock(stat));
      compiledLines.push(line);
      continue;
    }
    // Cost modifiers we can't enforce yet: note them without polluting the spell's effects.
    if (/^(?:~|this spell) costs? .+ (?:less|more) to cast/i.test(line)) {
      unhandledLines.push(line);
      continue;
    }
    // Spell text
    if (isSpell) {
      const { effects, unhandled } = parseEffects(line, spellCtx);
      spellEffects.push(...effects);
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
    unhandledLines.push(line);
  }
  if (isSpell || modal || spellEffects.length) {
    if (modal) abilities.push({ kind: 'spell', modes: modal, minModes, maxModes, effects: [], targets: [] });
    else abilities.push({ kind: 'spell', effects: spellEffects, targets: spellCtx.targets.length ? spellCtx.targets : undefined });
    void spellTargets;
  }
  const meaningful = lines.filter((l) => !isKeywordLine(l));
  const automatedAbilities = abilities.filter((a) => {
    if (a.kind === 'spell') return a.effects.some((e) => e.kind !== 'manual') || (a.modes?.length ?? 0) > 0;
    if (a.kind === 'triggered') return true; // even a manual-effect trigger fires the prompt at the right time
    if (a.kind === 'activated') return a.effects.some((e) => e.kind !== 'manual');
    return true;
  });
  const coverage: CardScript['coverage'] = meaningful.length === 0 || unhandledLines.length === 0 ? 'full' : automatedAbilities.length === 0 ? 'none' : 'partial';
  return { script: { name: faceName, abilities, additionalCost, alternativeCosts: alternativeCosts.length ? alternativeCosts : undefined, costModifiers: costModifiers.length ? costModifiers : undefined, coverage, origin: 'compiled', unhandledText: unhandledLines.length ? unhandledLines : undefined }, compiledLines, unhandledLines };
}

/** Noun phrase → filter for cost modifiers ("creature on the battlefield", "artifacts", "Equipment you control"). */
function parseNounLoose(text: string): import('@commander/engine').ObjectFilter | null {
  const t = text.replace(/ on the battlefield$/i, '').trim();
  const noun = parseNoun(t) ?? parseNoun(`a ${t}`);
  if (!noun) return null;
  const f = { ...noun.filter };
  if (!f.zone) f.zone = 'battlefield';
  return f;
}

/** For trigger lines we can't parse, guess a coarse event so the player still gets a prompt at roughly the right time. */
function guessTrigger(line: string): AbilitySpec[] {
  const text: Effect[] = [{ kind: 'manual', text: line }];
  if (/^At the beginning of your upkeep/i.test(line)) return [{ kind: 'triggered', text: line, event: 'beginningOfUpkeep', filter: { player: 'you' }, effects: text }];
  if (/^At the beginning of (?:each|each player's) upkeep/i.test(line)) return [{ kind: 'triggered', text: line, event: 'beginningOfUpkeep', effects: text }];
  if (/^At the beginning of your end step/i.test(line)) return [{ kind: 'triggered', text: line, event: 'beginningOfEndStep', filter: { player: 'you' }, effects: text }];
  if (/^At the beginning of (?:each|the) end step/i.test(line)) return [{ kind: 'triggered', text: line, event: 'beginningOfEndStep', effects: text }];
  if (/^At the beginning of (?:your )?combat/i.test(line)) return [{ kind: 'triggered', text: line, event: 'beginningOfCombat', filter: { player: 'you' }, effects: text }];
  if (/^When(?:ever)? ~ enters/i.test(line)) return [{ kind: 'triggered', text: line, event: 'entersBattlefield', filter: { self: true }, effects: text }];
  if (/^When(?:ever)? ~ dies/i.test(line)) return [{ kind: 'triggered', text: line, event: 'dies', filter: { self: true }, leavesTheBattlefield: true, effects: text }];
  if (/^Whenever ~ attacks/i.test(line)) return [{ kind: 'triggered', text: line, event: 'attacks', filter: { self: true }, effects: text }];
  if (/^Whenever ~ deals combat damage to a player/i.test(line)) return [{ kind: 'triggered', text: line, event: 'dealtCombatDamageToPlayer', filter: { self: true }, effects: text }];
  if (/^Whenever you cast/i.test(line)) return [{ kind: 'triggered', text: line, event: 'cast', filter: { player: 'you' }, effects: text }];
  if (/^Whenever (?:a|an|another) .+? enters/i.test(line)) return [{ kind: 'triggered', text: line, event: 'entersBattlefield', effects: text }];
  if (/^Whenever (?:a|an|another) .+? dies/i.test(line)) return [{ kind: 'triggered', text: line, event: 'dies', effects: text }];
  if (/^Whenever a land enters/i.test(line)) return [{ kind: 'triggered', text: line, event: 'entersBattlefield', filter: { object: { types: ['Land'] }, objectController: 'you' }, effects: text }];
  return [];
}

export function compileCard(card: CardData): CompileResult {
  const front = compileFace(card, card.name, card.oracleText ?? '', card.typeLine);
  if (card.faces && card.faces.length > 1) {
    const faces = card.faces.slice(1).map((f) => compileFace({ ...card, ...f, faces: undefined }, f.name, f.oracleText, f.typeLine));
    front.script.faces = faces.map((f) => f.script);
    for (const f of faces) {
      front.compiledLines.push(...f.compiledLines);
      front.unhandledLines.push(...f.unhandledLines);
    }
    if (faces.some((f) => f.script.coverage !== 'full')) front.script.coverage = front.script.coverage === 'none' && faces.every((f) => f.script.coverage === 'none') ? 'none' : 'partial';
  }
  return front;
}

export { parseSentence, newCtx, type ParseCtx };
