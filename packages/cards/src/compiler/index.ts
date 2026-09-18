/**
 * Oracle text → CardScript compiler. Turns templated rules text into
 * executable scripts so the engine can automate cards nobody hand-scripted.
 */
import type { AbilitySpec, ActivatedAbilitySpec, Amount, CardData, CardScript, Effect, TargetSpec, TriggeredAbilitySpec, Condition, CostModifier, AbilityCost } from '@commander/engine';
import { ENFORCED_KEYWORDS } from '@commander/engine';
import { normalizeOracle, wordToNumber, sentences } from './text.js';
import { parseEffects, newCtx, parseSentence, isNoOpSentence, isTrailingNoise, substituteX, type ParseCtx } from './effects.js';
import { parseTriggerHead, splitTriggerRest } from './triggers.js';
import { parseCost, parseActivationRestriction } from './costs.js';
import { parseStatic } from './statics.js';
import { parseCondition } from './conditions.js';
import { parseNoun } from './nouns.js';
import { parseAmount } from './amounts.js';
import { parseTypeLine } from '@commander/engine';

export interface CompileResult {
  script: CardScript;
  compiledLines: string[];
  unhandledLines: string[];
}

const KEYWORD_LINE_RE = /^(Flying|First strike|Double strike|Deathtouch|Lifelink|Trample|Vigilance|Haste|Flash|Defender|Reach|Menace|Hexproof|Indestructible|Shroud|Fear|Intimidate|Skulk|Horsemanship|Shadow|Infect|Wither|Toxic \d+|Prowess|Changeling|Devoid|Partner|Partner with [^,;]+|Friends forever|Choose a Background|Ward (?:\{[^}]+\})+|Ward—[^.]+|Protection from [^;]+|Hexproof from [^;]+|Enchant [^;]+|Equip (?:\{[^}]+\})+|Equip \d+|Equipment swap (?:\{[^}]+\})+|Kicker (?:\{[^}]+\})+|Flashback (?:\{[^}]+\})+|Flashback—[^.]+|Cycling (?:\{[^}]+\})+|Cycling—[^.]+|Snow [a-z]+walk|Read ahead|Proliferatelink|Mayhem|Deworded|Forbidden|Grazing type|Coststorm|Undying|Persist|Exalted|Convoke|Delve|Affinity for \w+|Improvise|Cascade|Storm|Rebound|Split second|Riot|Unleash|Mentor|Landwalk|Islandwalk|Swampwalk|Forestwalk|Mountainwalk|Plainswalk|Flanking|Bushido \d+|Rampage \d+|Annihilator \d+|Battle cry|Extort|Ingest|Myriad|Melee|Dethrone|Afflict \d+|Fabricate \d+|Crew \d+|Ninjutsu (?:\{[^}]+\})+|Commander ninjutsu (?:\{[^}]+\})+|Buyback (?:\{[^}]+\})+|Evoke (?:\{[^}]+\})+|Escape—[^.]+|Unearth (?:\{[^}]+\})+|Emerge (?:\{[^}]+\})+|Madness (?:\{[^}]+\})+|Morph (?:\{[^}]+\})+|Megamorph (?:\{[^}]+\})+|Disguise (?:\{[^}]+\})+|Miracle (?:\{[^}]+\})+|Dredge \d+|Suspend (?:\d+|X)—(?:\{[^}]+\})+|Vanishing \d+|Fading \d+|Echo (?:\{[^}]+\})+|Cumulative upkeep [^.]+|Modular \d+|Sunburst|Graft \d+|Bloodthirst \d+|Devour \d+|Devour \w+ \d+|Undaunted|Living weapon|Daybound|Nightbound|Decayed|Disturb (?:\{[^}]+\})+|Training|Backup \d+|Blitz (?:\{[^}]+\})+|Blitz—[^.]+|Casualty—[^.]+|Disturb—[^.]+|Prowl—[^.]+|Spectacle—[^.]+|Dash—[^.]+|Evoke—[^.]+|Bestow—[^.]+|Madness—[^.]+|Outlast—[^.]+|Unearth—[^.]+|Overload—[^.]+|Scavenge—[^.]+|Casualty \d+|Enlist|Ravenous|Boast — [^.]+|Foretell (?:\{[^}]+\})+|Squad (?:\{[^}]+\})+|Reconfigure (?:\{[^}]+\})+|Compleated|For Mirrodin!|Prototype [^.]+|Encore (?:\{[^}]+\})+|Mutate (?:\{[^}]+\})+|Escalate (?:\{[^}]+\})+|Surge (?:\{[^}]+\})+|Awaken \d+—(?:\{[^}]+\})+|Renown \d+|Outlast (?:\{[^}]+\})+|Prowl (?:\{[^}]+\})+|Conspire|Retrace|Reinforce (?:\d+|X)—(?:\{[^}]+\})+|Champion [^.]+|Evolve|Cipher|Bestow (?:\{[^}]+\})+|Tribute \d+|Dash (?:\{[^}]+\})+|Embalm (?:\{[^}]+\})+|Embalm—[^.]+|Eternalize (?:\{[^}]+\})+|Eternalize—[^.]+|Exert|Ascend|Jump-start|Afterlife \d+|Spectacle (?:\{[^}]+\})+|Amass \w+ \d+|Adventure|Offspring (?:\{[^}]+\})+|Impending \d+—(?:\{[^}]+\})+|Gift [^.]+|Bargain|Cleave (?:\{[^}]+\})+|Companion — [^.]+|Level up (?:\{[^}]+\})+|Soulbond|Haunt|Aura swap (?:\{[^}]+\})+|Fortify (?:\{[^}]+\})+|Transmute (?:\{[^}]+\})+|Ripple \d+|Frenzy \d+|Gravestorm|Poisonous \d+|Recover (?:\{[^}]+\})+|Recover—[^.]+|Replicate (?:\{[^}]+\})+|Replicate—[^.]+|Kicker—[^.]+|Multikicker—[^.]+|Equip—[^.]+|Eternalize—[^.]+|Embalm—[^.]+|Buyback—[^.]+|Land casualty \d+|Library ninjutsu (?:\{[^}]+\})+|Host (?:\{[^}]+\})+|Craft with [^.]+|Beam me up (?:\{[^}]+\})+|Absorb \d+|Vanishing|Wither|Provoke|Entwine (?:\{[^}]+\})+|Entwine—[^.]+|Splice onto [^.]+|Offering|[A-Z]\w+ offering|Web-slinging (?:\{[^}]+\})+|Shackle (?:\{[^}]+\})+|Bloodthirst X|Toxic \d+|Tiered|Paradigm|Demonstrate|Time travel|Forage|Flashforward (?:\{[^}]+\})+|Negamorph (?:\{[^}]+\})+|Multicleave (?:\{[^}]+\})+|Multicleave \d+|Epic|Hidden agenda|Double agenda|Assist|Legendary landwalk|Nonbasic landwalk|Desertwalk|Phasing|Banding|Rampage|Shadow|Totem armor|Vigilance|Hideaway \d+|Job select|Start your engines!|Saddle \d+|Spree|Plot|Freerunning (?:\{[^}]+\})+|Umbra armor|Devoid|Exploit|Soulshift \d+|Mobilize \d+|Multikicker (?:\{[^}]+\})+|Living metal|Discover \d+|Firebending \d+|Waterbending \d+|Earthbending \d+|Airbending \d+|(?:Firebending|Waterbending|Earthbending|Airbending|Mobilize|Monstrosity|Amass [A-Z]\\w+) X, where X is [^.]+|Squad—[^.]+|Teach (?:\{[^}]+\})+|Transfigure (?:\{[^}]+\})+|Trample over planeswalkers)$/i;

function isKeywordLine(line: string): boolean {
  if (KEYWORD_LINE_RE.test(line.replace(/\.$/, ''))) return true;
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
  const lines = normalizeOracle(card, faceName, text).flatMap((l) => {
    const cm = l.match(/^((?:~|This spell) costs? )(\{\d+\} (?:less|more) to cast (?:if|as long as) .+?) and (\{\d+\} (?:less|more) to cast (?:if|as long as) .+?)\.?$/i);
    if (cm) return [`${cm[1]}${cm[2]}.`, `${cm[1]}${cm[3]}.`];
    // "Flashback {8}{G}{G}. This spell costs {X} less to cast this way, where X is …"
    // "Plainscycling {2}, islandcycling {2}" — one keyword per line.
    if (/^[A-Za-z]+cycling (?:\{[^}]+\})+(?:, [a-z]+cycling (?:\{[^}]+\})+)+\.?$/.test(l)) return l.replace(/\.$/, '').split(/,\s*/).map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}`);
    const kw = l.match(/^((?:Flashback|Harmonize|Replicate|Overload|Mutate|Morph|Megamorph|Disguise) (?:\{[^}]+\})+)\. (.+)$/i);
    if (kw) return [kw[1], kw[2]];
    const also = l.match(/^(~ costs? .+?)\. It also (costs? .+?)\.?$/i);
    if (/^You may exert ~ as it attacks\./i.test(l)) return [l.replace(/^You may exert ~ as it attacks\./i, 'Whenever ~ attacks, you may exert ~.')];
    const ac = l.match(/^(As an additional cost to cast (?:~|this spell), .+?)\. ((?:~|This spell) costs? .+)$/i);
    if (ac) return [`${ac[1]}.`, ac[2]];
    if (also) return [`${also[1]}.`, `~ ${also[2]}.`];
    // "If you have 3 or less life, ~ costs {6} less to cast." → "~ costs {6} less to cast if you have 3 or less life."
    const im = l.match(/^If (.+?), ((?:~|this spell) costs? \{[^}]+\} (?:less|more) to cast)\.?$/i);
    if (im) return [`${im[2].charAt(0).toUpperCase()}${im[2].slice(1)} if ${im[1]}.`];
    // "If you attacked this turn, you may pay {U} rather than pay ~'s mana cost." → "You may pay {U} rather than pay ~'s mana cost if you attacked this turn."
    const am = l.match(/^If (.+?), you may (.+? rather than pay (?:~'s|this spell's) mana cost)\.?$/i);
    if (am) return [`You may ${am[2]} if ${am[1]}.`];
    // "If an opponent controls a Swamp and you control a Plains, you may cast ~ without paying its mana cost."
    const fm = l.match(/^If (.+?), you may cast (?:~|this spell) without paying its mana cost\.?$/i);
    if (fm) return [`You may cast ~ without paying its mana cost if ${fm[1]}.`];
    return [l];
  });
  const parsed = parseTypeLine(typeLine);
  const isSpell = parsed.types.includes('Instant') || parsed.types.includes('Sorcery');
  const abilities: AbilitySpec[] = [];
  const compiledLines: string[] = [];
  const unhandledLines: string[] = [];
  const spellEffects: Effect[] = [];
  let lastSpellLine: string | null = null;
  let lastSpellStart = 0;
  const spellTargets: TargetSpec[] = [];
  const spellCtx = newCtx({ isSpell: true });
  let modal: { text: string; targets?: TargetSpec[]; effects: Effect[] }[] | null = null;
  let minModes = 1;
  let maxModes = 1;
  let modalMaxIf: { condition: Condition; max: number } | undefined;
  let modalRepeatable = false;
  let castCondition: Condition | undefined;
  let additionalCost: CardScript['additionalCost'];
  let modalX: Amount | null = null;
  let modeCosts: (string | undefined)[] | null = null;
  let modalNotChosen: 'turn' | 'game' | null = null;
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

  let pendingRoll: { kind: 'rollDie'; sides: number; results: { min: number; max: number; effects: Effect[] }[] } | null = null;
  const findRoll = (effects: Effect[]): typeof pendingRoll => {
    for (const e of effects) {
      if (e.kind === 'rollDie' && e.results.length === 0) return e;
      if ('effects' in e && Array.isArray((e as { effects?: Effect[] }).effects)) {
        const r = findRoll((e as { effects: Effect[] }).effects);
        if (r) return r;
      }
    }
    return null;
  };
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // Drop purely informational trailing sentences ("The same is true for …").
    {
      const ss = sentences(line);
      const kept = [...ss];
      while (kept.length > 1 && isTrailingNoise(kept[kept.length - 1])) kept.pop();
      if (kept.length && kept.length < ss.length) line = kept.length === 1 ? kept[0] : `${kept.join('. ')}.`;
      // A trailing sentence after a closing quote ('… end of turn." It is still a land.') is not
      // split by sentences(), so trim it here.
      const qm = line.match(/^(.*\.")\s+([^"]+?)\.?$/);
      if (qm && isTrailingNoise(qm[2])) line = qm[1];
    }
    // "~ costs {U}{U} less to cast ..." — colored reductions are handled as generic-count lines with the symbols remembered.
    let costSymbols: string | undefined;
    // "During your turn, ~ costs {2} less to cast." → move the timing to the tail.
    {
      const dl = line.match(/^During (your turn|turns other than yours|each opponent's turn), ((?:~|This spell) costs? (?:\{[0-9WUBRGC]\})+ (?:less|more) to cast)\.?$/i);
      if (dl) line = `${dl[2]} during ${/^your turn$/i.test(dl[1]) ? 'your turn' : "an opponent's turn"}.`;
    }
    {
      const cl = line.match(/^((?:~|This spell) costs? )((?:\{[0-9WUBRGC]\})+)( (?:less|more) to cast .+)$/i);
      if (cl) {
        const syms = cl[2].match(/\{[^}]+\}/g) ?? [];
        const colored = syms.filter((x) => /^\{[WUBRGC]\}$/.test(x));
        if (colored.length) {
          const generic = syms.filter((x) => /^\{\d+\}$/.test(x)).reduce((acc, x) => acc + parseInt(x.slice(1, -1), 10), 0);
          costSymbols = colored.join('');
          line = `${cl[1]}{${generic + colored.length}}${cl[3]}`;
        }
      }
    }
    const pushCostMod = (mod: CostModifier) => costModifiers.push(costSymbols ? { ...mod, symbols: costSymbols, text: mod.text } : mod);
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(\d+)(?:\s*[—–-]\s*(\d+))?\s*\|\s*(.+)$/))) {
      if (!pendingRoll) for (const ab of [...abilities].reverse()) if ('effects' in ab && Array.isArray(ab.effects)) { pendingRoll = findRoll(ab.effects); if (pendingRoll) break; }
      if (!pendingRoll) pendingRoll = findRoll(spellEffects);
      if (pendingRoll) {
        const ctx = newCtx();
        const r = parseEffects(m[3], ctx);
        pendingRoll.results.push({ min: parseInt(m[1], 10), max: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10), effects: r.effects });
        if (r.unhandled.length) unhandledLines.push(...r.unhandled);
        else compiledLines.push(line);
        continue;
      }
    } else pendingRoll = null;
    // Spacecraft rows: "10+ | Whenever you attack, ..." are STATION thresholds with the ability on the same line.
    if ((m = line.match(/^(\d+)\+ \| (.+)$/))) {
      block = { condition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: 'charge', op: '>=', value: parseInt(m[1], 10) }, station: true };
      line = m[2];
      m = null;
    }
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
    // Morph / megamorph / disguise: cast face down for {3}, then turn it face up for the listed cost.
    if ((m = line.match(/^(Morph|Megamorph|Disguise) ((?:\{[^}]+\})+|[^.]+)$/i))) {
      const kind = m[1].toLowerCase();
      const turnUp = /^(?:\{[^}]+\})+$/.test(m[2].trim()) ? { mana: m[2].trim() } : parseCost(m[2].trim().replace(/^[a-z]/, (c) => c.toUpperCase()));
      if (turnUp) {
        alternativeCosts.push({ id: kind, text: line, cost: { mana: '{3}' }, zone: 'hand', faceDown: true, ward: kind === 'disguise' ? '{2}' : undefined });
        abilities.push({
          kind: 'activated',
          text: `Turn ~ face up (${m[1]} ${m[2]})`,
          cost: turnUp,
          faceDownOnly: true,
          effects: [{ kind: 'turnFaceUp', ...(kind === 'megamorph' ? { counters: { counter: '+1/+1', amount: 1 } } : {}) }],
        });
        compiledLines.push(line);
        continue;
      }
    }
    // Replicate: pay the cost any number of times, then copy the spell that many times.
    if ((m = line.match(/^Replicate ((?:\{[^}]+\})+)$/i))) {
      abilities.push({ kind: 'triggered', text: line, event: 'cast', filter: { self: true }, zone: 'stack', effects: [{ kind: 'copySpell', what: { ref: 'self' }, count: { kind: 'kickCount' } }] });
      compiledLines.push(line);
      continue;
    }
    // Harmonize: cast it from your graveyard for this cost, then exile it.
    if ((m = line.match(/^Harmonize ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'harmonize', text: line, cost: { mana: m[1] }, zone: 'graveyard' });
      compiledLines.push(line);
      continue;
    }
    // Craft with X: exile this and matching permanents you control, then return it transformed.
    if ((m = line.match(/^Craft with ([\w' -]+) ((?:\{[^}]+\})+)$/i))) {
      const noun = parseNoun(`a ${m[1].toLowerCase() === 'artifact' || m[1].toLowerCase() === 'creature' ? m[1].toLowerCase() : m[1]}`);
      if (noun) {
        abilities.push({
          kind: 'activated',
          text: line,
          cost: { mana: m[2], exileSelf: true, exileObjects: { filter: { ...noun.filter, zone: 'battlefield', controller: 'you', other: true }, count: 'any' } },
          sorcerySpeed: true,
          effects: [{ kind: 'returnToBattlefield', what: { ref: 'self' }, transformed: true, controller: 'owner' }],
        });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^Flashback ((?:\{[^}]+\})+)$/i))) {
      // The engine reads flashback straight off the oracle text.
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^More Than Meets the Eye ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'converted', text: line, cost: { mana: m[1] }, zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Mutate ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'mutate', text: line, cost: { mana: m[1] }, zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Teamwork (\d+)$/i))) {
      additionalCost = { ...(additionalCost ?? {}), optional: true, tapUntappedTotalPower: { filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' }, power: parseInt(m[1], 10) } };
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Overload ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'overload', text: line, cost: { mana: m[1] }, zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Tribute (\d+)$/i))) {
      abilities.push({ kind: 'replacement', text: line, event: 'entersBattlefield', self: true, tribute: parseInt(m[1], 10) });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Mayhem ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'mayhem', text: line, cost: { mana: m[1] }, zone: 'graveyard', condition: { kind: 'memoryFlag', key: 'discardedThisTurn' } });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Sneak ((?:\{[^}]+\})+)$/i))) {
      alternativeCosts.push({ id: 'sneak', text: line, cost: { mana: m[1] }, zone: 'hand', condition: { kind: 'eventThisTurn', event: 'dealtCombatDamageToPlayer', player: 'opponent' } });
      compiledLines.push(line);
      continue;
    }
    // "Equip legendary creature {1}", "Equip Halfling {1}": equip with a restricted target.
    if ((m = line.match(/^Equip ([A-Za-z][A-Za-z,' ]*?) ((?:\{[^}]+\})+)$/i))) {
      const q = m[1].trim();
      const noun = parseNoun(/\b(creature|planeswalker|token|commander)s?\b/i.test(q) ? `${q} you control` : `${q} creature you control`);
      if (noun && noun.confident) {
        abilities.push({ kind: 'activated', text: line, cost: { mana: m[2] }, sorcerySpeed: true, targets: [{ description: `target ${q} you control`, kind: 'object', filter: { ...noun.filter, zone: 'battlefield', controller: 'you' } }], effects: [{ kind: 'attach', what: { ref: 'self' }, to: { ref: 'target' } }] });
        compiledLines.push(line);
        continue;
      }
    }
    // Licids: "{W}, {T}: ~ loses this ability and becomes an Aura enchantment with enchant creature.
    // Attach it to target creature. You may pay {W} to end this effect."
    if ((m = line.match(/^((?:\{[^}]+\}|,| |\{T\})+): ~ loses this ability and becomes an Aura enchantment with enchant (\w+)\. Attach it to target \2\. You may pay ((?:\{[^}]+\})+) to end this effect\.?$/i))) {
      const cost = parseCost(m[1]);
      const host = parseNoun(`target ${m[2]}`);
      if (cost && host) {
        abilities.push({
          kind: 'activated',
          text: line,
          cost,
          targets: [{ description: `target ${m[2]}`, kind: 'object', filter: { ...host.filter, zone: 'battlefield' } }],
          effects: [
            { kind: 'addTypes', types: ['Enchantment'], setTypes: ['Enchantment'], subtypes: ['Aura'], on: { ref: 'self' }, duration: 'permanent' },
            { kind: 'attach', what: { ref: 'self' }, to: { ref: 'target' } },
          ],
        });
        abilities.push({ kind: 'activated', text: `${m[3]}: End the Aura effect.`, cost: { mana: m[3] }, effects: [{ kind: 'unattach', what: { ref: 'self' } }] });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^Firebending (\d+)$/i))) {
      abilities.push({ kind: 'triggered', text: line, event: 'beginningOfPrecombatMain', filter: { player: 'you' }, effects: [{ kind: 'addMana', mana: ['R'], amount: parseInt(m[1], 10) }, { kind: 'turnFlag', flag: 'keepMana' }] });
      compiledLines.push(line);
      continue;
    }
    // "You may cast ~ as though it had flash. If you cast it any time a sorcery couldn't have been cast, the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step."
    if (/^You may cast ~ as though it had flash\. If you cast it any time a sorcery couldn't have been cast, the controller of the permanent it becomes sacrifices it at the beginning of the next cleanup step\.?$/i.test(line)) {
      abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: ['Flash'] }, zone: 'hand' });
      abilities.push({ kind: 'triggered', text: line, event: 'entersBattlefield', filter: { self: true }, condition: { kind: 'memoryFlag', key: 'castAtInstantSpeed' }, effects: [{ kind: 'delayedTrigger', event: 'cleanup', effects: [{ kind: 'sacrifice', what: { ref: 'self' } }], text: 'Sacrifice this at the beginning of the next cleanup step.', once: true }] });
      compiledLines.push(line);
      continue;
    }
    // Crew N / Saddle N: tap creatures with total power N or more.
    if ((m = line.match(/^(Crew|Saddle) (\d+)$/i))) {
      const n = parseInt(m[2], 10);
      const crew = /^crew$/i.test(m[1]);
      abilities.push({ kind: 'activated', text: line, cost: { tapUntappedTotalPower: { filter: { types: ['Creature'], zone: 'battlefield', other: true }, power: n } }, effects: crew ? [{ kind: 'addTypes', types: ['Artifact', 'Creature'], on: { ref: 'self' }, duration: 'endOfTurn' }] : [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'saddled' }, on: { ref: 'self' }, duration: 'endOfTurn' }], sorcerySpeed: !crew });
      compiledLines.push(line);
      continue;
    }
    // "You may cast ~ without paying its mana cost if <condition>."
    if ((m = line.match(/^You may cast (?:~|this spell) without paying its mana cost(?: if (.+?)| as long as (.+?))?\.?$/i))) {
      const condText = m[1] ?? m[2];
      const cond = condText ? parseCondition(condText, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) : undefined;
      if (!condText || (cond && cond.kind !== 'manual')) {
        alternativeCosts.push({ id: `free${alternativeCosts.length}`, text: line, cost: { mana: '' }, condition: cond ?? undefined, zone: 'hand' });
        compiledLines.push(line);
        continue;
      }
    }
    // "You may pay {U} rather than pay ~'s mana cost if you attacked this turn." / "You may sacrifice a creature rather than pay ..."
    if ((m = line.match(/^You may (pay ((?:\{[^}]+\})+)|[^,]+?) rather than pay (?:~'s|this spell's) mana cost(?: if (.+?)| as long as (.+?))?\.?$/i))) {
      let cost = m[2] ? ({ mana: m[2] } as AbilityCost | null) : parseCost(m[1].replace(/^[a-z]/, (c) => c.toUpperCase()));
      // "pay {1} and return a basic land you control to its owner's hand"
      const both = !cost ? m[1].match(/^pay ((?:\{[^}]+\})+) and (.+)$/i) : null;
      if (both) {
        const rest = parseCost(both[2].replace(/^[a-z]/, (c) => c.toUpperCase()));
        if (rest) cost = { ...rest, mana: both[1] };
      }
      // "pay 1 life and exile a black card from your hand"
      const lifeAnd = !cost ? m[1].match(/^pay (\d+) life and (.+)$/i) : null;
      if (lifeAnd) {
        const rest = parseCost(lifeAnd[2].replace(/^[a-z]/, (c) => c.toUpperCase()));
        if (rest) cost = { ...rest, payLife: parseInt(lifeAnd[1], 10) };
      }
      const condText = m[3] ?? m[4];
      const cond = condText ? parseCondition(condText, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false }) : undefined;
      if (cost && (!condText || (cond && cond.kind !== 'manual'))) {
        alternativeCosts.push({ id: `alt${alternativeCosts.length}`, text: line, cost, condition: cond ?? undefined, zone: 'hand' });
        compiledLines.push(line);
        continue;
      }
    }
    // Cases: "To solve — <condition>." marks the Case solved once the condition holds.
    if ((m = line.match(/^To solve — (.+?)\.?$/i))) {
      const cond = parseCondition(m[1].replace(/\.$/, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        abilities.push({ kind: 'triggered', text: line, event: 'stateTrigger', condition: cond, effects: [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'solved' }, on: { ref: 'self' }, duration: 'permanent' }] });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^You may cast ~ from your graveyard (?:if|as long as) (.+?)\.?$/i))) {
      const cond = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        alternativeCosts.push({ id: 'fromGraveyard', text: line, cost: { mana: card.manaCost ?? '' }, zone: 'graveyard', condition: cond });
        compiledLines.push(line);
        continue;
      }
    }
    // "You may cast ~ as though it had flash if you control a Human."
    if ((m = line.match(/^You may cast (?:~|this spell) as though it had flash if (.+?)\.?$/i)) && !/^you pay /i.test(m[1])) {
      const c = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (c && c.kind !== 'manual') {
        abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: ['Flash'] }, zone: 'hand', condition: c });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^You may cast ~ as though it had flash if you pay ((?:\{[^}]+\})+) more to cast it\.?$/i))) {
      alternativeCosts.push({ id: 'flashPlus', text: line, cost: { mana: `${card.manaCost ?? ''}${m[1]}` }, zone: 'hand', instantSpeed: true });
      compiledLines.push(line);
      continue;
    }
    if (/^You may cast ~ as though it had flash\.?$/i.test(line)) {
      abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: 6, addKeywords: ['Flash'] }, zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    // "You may cast ~ from your graveyard by discarding a card in addition to paying its other costs."
    if ((m = line.match(/^You may cast ~ from your graveyard by (discarding a card|paying (\d+) life(?: and discarding a card)?|sacrificing (?:a|an) (.+?)|exiling (\w+) other cards? from your graveyard) in addition to paying its other costs\.?$/i))) {
      const extra: AbilityCost = m[2] ? { payLife: parseInt(m[2], 10), ...(/discarding a card/i.test(m[1]) ? { discard: { count: 1 } } : {}) } : m[3] ? { sacrifice: { filter: { ...(parseNoun(`a ${m[3]}`)?.filter ?? {}), zone: 'battlefield' }, count: 1 } } : m[4] ? { exileFromGraveyard: { filter: {}, count: wordToNumber(m[4]) as number } } : { discard: { count: 1 } };
      alternativeCosts.push({ id: 'fromGraveyard', text: line, cost: { mana: card.manaCost ?? '', ...extra }, zone: 'graveyard' });
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
        pushCostMod({ amount: 1, direction: 'less', per: { ...noun, controller: 'you' }, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if (/^Cascade$/i.test(line)) {
      abilities.push({ kind: 'triggered', text: line, event: 'cast', filter: { self: true }, zone: 'stack', effects: [{ kind: 'discover', amount: { kind: 'sum', parts: [{ kind: 'manaValue', ref: { ref: 'self' } }, -1] } }] });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Discover (\d+)$/i))) {
      abilities.push({ kind: 'triggered', text: line, event: 'cast', filter: { self: true }, zone: 'stack', effects: [{ kind: 'discover', amount: parseInt(m[1], 10) }] });
      compiledLines.push(line);
      continue;
    }
    if (/^Living metal$/i.test(line)) {
      abilities.push({ kind: 'static', text: line, affects: 'self', modification: { layer: 4, addTypes: ['Artifact', 'Creature'] }, condition: { kind: 'yourTurn' } });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast if it targets (?:a|an) (.+?)\.?$/i))) {
      const noun = parseNoun(`a ${m[3]}`);
      if (noun) {
        pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', ifTargets: noun.filter, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{X\} (less|more) to cast, where X is (.+?)\.?$/i))) {
      const amt = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (amt !== null) {
        pushCostMod({ amount: 1, direction: m[1].toLowerCase() as 'less' | 'more', perAmount: amt, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast for each creature in your party\.?$/i))) {
      pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', perAmount: { kind: 'partySize' }, text: line });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Soulshift (\d+)$/i))) {
      const n = parseInt(m[1], 10);
      abilities.push({ kind: 'triggered', text: line, event: 'dies', filter: { self: true }, leavesTheBattlefield: true, optional: true, targets: [{ description: `target Spirit card with mana value ${n} or less from your graveyard`, kind: 'object', filter: { zone: 'graveyard', owner: 'you', subtypes: ['Spirit'], cmcLE: n }, min: 1, max: 1 }], effects: [{ kind: 'putIntoHand', what: { ref: 'target', slot: 0 } }] });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^Mobilize (\d+)$/i))) {
      const n = parseInt(m[1], 10);
      abilities.push({ kind: 'triggered', text: line, event: 'attacks', filter: { self: true }, effects: [{ kind: 'createToken', token: { name: 'Warrior', typeLine: 'Creature — Warrior', power: '1', toughness: '1', colors: ['R'] }, count: n, tapped: true, attacking: true }, { kind: 'delayedTrigger', event: 'beginningOfEndStep', text: 'Mobilize: sacrifice the Warriors', effects: [{ kind: 'sacrifice', what: { ref: 'lastCreated' } }], once: true }] });
      compiledLines.push(line);
      continue;
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
    if ((m = line.match(/^(?:~|This spell) costs? ((?:\{[^}]+\})+) more to cast for each target beyond the first\.?$/i))) {
      // Colored symbols count as generic mana here (the engine's cost modifiers are generic-only).
      pushCostMod({ amount: (m[1].match(/\{([^}]+)\}/g) ?? []).reduce((s, x) => s + (/^\{\d+\}$/.test(x) ? parseInt(x.slice(1, -1), 10) : 1), 0), direction: 'more', perExtraTarget: true, text: line });
      compiledLines.push(line);
      continue;
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{X\} (less|more) to cast(?: this way)?, where X is (.+?)\.?$/i))) {
      const amt = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (amt !== null) {
        pushCostMod({ amount: 1, direction: m[1].toLowerCase() as 'less' | 'more', perAmount: amt, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast for each (.+?)\.?$/i))) {
      const noun = parseNounLoose(m[3]);
      if (noun) {
        pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', per: noun, text: line });
        compiledLines.push(line);
        continue;
      }
      const amt = parseAmount(`the number of ${m[3]}`, { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (amt !== null) {
        pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', perAmount: amt, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    // "You can't cast ~ unless an opponent lost life this turn."
    if ((m = line.match(/^You cannot cast (?:~|this spell) unless (.+?)\.?$/i))) {
      const cond = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        castCondition = castCondition ? { kind: 'and', cs: [castCondition, cond] } : cond;
        compiledLines.push(line);
        continue;
      }
    }
    // Casting restrictions: "Cast ~ only during combat" / "only if you control a snow land"
    if ((m = line.match(/^Cast (?:~|this spell) only (.+?)\.?$/i))) {
      const cond = parseCastRestriction(m[1]);
      if (cond) {
        castCondition = castCondition ? { kind: 'and', cs: [castCondition, cond] } : cond;
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast during (your|an opponent's|each|the) (upkeep|draw step|end step|combat|main phase|precombat main phase|postcombat main phase|declare attackers step|declare blockers step|turn)\.?$/i))) {
      const steps: Record<string, string[]> = { upkeep: ['upkeep'], 'draw step': ['draw'], 'end step': ['end'], combat: ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'], 'main phase': ['main1', 'main2'], 'precombat main phase': ['main1'], 'postcombat main phase': ['main2'], 'declare attackers step': ['declareAttackers'], 'declare blockers step': ['declareBlockers'] };
      const who = m[3].toLowerCase() === 'your' ? 'you' : /opponent/i.test(m[3]) ? 'opponent' : 'any';
      const cond: Condition = m[4].toLowerCase() === 'turn' ? (who === 'you' ? { kind: 'yourTurn' } : { kind: 'notYourTurn' }) : { kind: 'turnStep', steps: steps[m[4].toLowerCase()], player: who };
      pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', condition: cond, text: line });
      compiledLines.push(line);
      continue;
    }
    // "~ costs {X} less to cast, where X is the number of cards in your graveyard."
    if ((m = line.match(/^(?:~|This spell) costs? \{X\} (less|more) to cast, where X is (.+?)\.?$/i))) {
      const amt2 = parseAmount(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (amt2 !== null) {
        pushCostMod({ amount: 1, direction: m[1].toLowerCase() as 'less' | 'more', perAmount: amt2, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast if (.+?)\.?$/i))) {
      const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', condition: cond, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if ((m = line.match(/^(?:~|This spell) costs? \{(\d+)\} (less|more) to cast as long as (.+?)\.?$/i))) {
      const cond = parseCondition(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (cond && cond.kind !== 'manual') {
        pushCostMod({ amount: parseInt(m[1], 10), direction: m[2].toLowerCase() as 'less' | 'more', condition: cond, text: line });
        compiledLines.push(line);
        continue;
      }
    }
    if (isNoOpSentence(line)) {
      compiledLines.push(line);
      continue;
    }
    // Sieges: "As ~ enters, choose Abzan or Mardu." followed by "• Abzan \u2014 <ability>" bullets.
    if ((m = line.match(/^As ~ enters, choose ([A-Z][\w' -]*(?:, [A-Z][\w' -]*)*(?:,? or [A-Z][\w' -]*))\.?$/)) && lines[li + 1]?.startsWith('\u2022')) {
      const opts = m[1].split(/,? or |, /).map((w) => w.trim()).filter(Boolean);
      const st = parseStatic(line, !isSpell);
      if (st) abilities.push(...st);
      compiledLines.push(line);
      let anyBad = false;
      while (lines[li + 1]?.startsWith('\u2022')) {
        li++;
        const bullet = lines[li].replace(/^\u2022\s*/, '');
        const bm = bullet.match(/^([A-Z][\w' -]*) \u2014 (.+)$/);
        const which = bm ? opts.find((o) => o.toLowerCase() === bm[1].toLowerCase()) : undefined;
        if (!bm || !which) {
          unhandledLines.push(lines[li]);
          anyBad = true;
          continue;
        }
        const inner = compileFace({ ...card, name: card.name, oracleText: bm[2] }, faceName, bm[2], typeLine);
        if (inner.unhandledLines.length || !inner.script.abilities.length) {
          unhandledLines.push(lines[li]);
          anyBad = true;
          continue;
        }
        for (const ab of inner.script.abilities) {
          if (ab.kind === 'spell') continue;
          const cond: Condition = { kind: 'chosenIs', key: 'choice', value: which };
          abilities.push({ ...ab, condition: 'condition' in ab && ab.condition ? { kind: 'and', cs: [ab.condition, cond] } : cond } as AbilitySpec);
        }
        compiledLines.push(lines[li]);
      }
      void anyBad;
      continue;
    }
    // "Tiered": the bullet modes that follow form a "choose one" with per-mode costs.
    if (/^Tiered\.?$/i.test(line) && lines[li + 1]?.startsWith('•')) line = 'Choose one';
    if (isKeywordLine(line)) {
      compiledLines.push(line);
      // Cycling: an activated ability from hand.
      if ((m = line.match(/^Cycling ((?:\{[^}]+\})+)$/i))) abilities.push({ kind: 'activated', text: line, cost: { mana: m[1], discardSelf: true }, effects: [{ kind: 'draw', amount: 1 }], zone: 'hand' });
      if ((m = line.match(/^Cycling (\d+)$/i))) abilities.push({ kind: 'activated', text: line, cost: { mana: `{${m[1]}}`, discardSelf: true }, effects: [{ kind: 'draw', amount: 1 }], zone: 'hand' });
      continue;
    }
    // Landcycling variants
    if ((m = line.match(/^(Basic landcycling|Artifact landcycling|Landcycling|[A-Z][a-z]+cycling) ((?:\{[^}]+\})+|\d+)\.?$/i))) {
      const cost = /^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2];
      const kind = m[1].toLowerCase();
      const filter = kind === 'basic landcycling' ? { supertypes: ['Basic' as const], types: ['Land'] } : kind === 'artifact landcycling' ? { types: ['Artifact', 'Land'] } : kind === 'landcycling' ? { types: ['Land'] } : /^(plains|island|swamp|mountain|forest|desert|cave|gate|sphere|locus|urza)cycling$/.test(kind) ? { types: ['Land'], subtypes: [m[1].replace(/cycling$/i, '')] } : { types: ['Creature'], subtypes: [m[1].replace(/cycling$/i, '')] };
      abilities.push({ kind: 'activated', text: line, cost: { mana: cost, discardSelf: true }, effects: [{ kind: 'searchLibrary', filter: { ...filter, zone: 'library' }, count: 1, destination: 'hand', reveal: true, shuffle: true }], zone: 'hand' });
      compiledLines.push(line);
      continue;
    }
    // Modal spells
    let maxModesIf: { condition: Condition; max: number } | undefined;
    let repeatable = false;
    if ((m = line.match(/^Choose (one|two|one or both)\. (.+?), then —$/i))) {
      const r = parseEffects(m[2], spellCtx);
      spellEffects.push(...r.effects);
      if (r.unhandled.length) unhandledLines.push(...r.unhandled);
      line = `Choose ${m[1]}`;
    }
    if ((m = line.match(/^Choose (one)\. If you control a commander as you cast (?:this spell|~), you may choose both instead\.?$/i))) {
      maxModesIf = { condition: { kind: 'controlsCommander' }, max: 2 };
      line = 'Choose one';
    } else if ((m = line.match(/^Choose (one|two)\. If (.+?) as you cast (?:this spell|~), you may choose (both|two|three) instead\.?$/i)) && parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })?.kind !== 'manual' && parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })) {
      maxModesIf = { condition: parseCondition(m[2], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false })!, max: m[3].toLowerCase() === 'three' ? 3 : 2 };
      line = `Choose ${m[1]}`;
    } else if ((m = line.match(/^Choose (one|two)\. If (.+?),? (?:you may )?choose (both|two|three|any number|an additional mode) instead\.?$/i))) {
      const c = parseCondition(m[2].replace(/ as you cast (?:this spell|~)$/i, ''), { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (c && c.kind !== 'manual') maxModesIf = { condition: c, max: /any number/i.test(m[3]) ? 6 : /three/i.test(m[3]) ? 3 : 2 };
      line = `Choose ${m[1]}`;
    } else if ((m = line.match(/^Choose (\w+)\. You may choose the same mode more than once\.?$/i))) {
      repeatable = true;
      line = `Choose ${m[1]}`;
    }
    if (/^Choose (?:one|two)\b/i.test(line) && (/been chosen/i.test(line) || / X is /i.test(line))) {
      const mh = parseModalHead(line);
      if (mh) {
        modalX = mh.x ?? null;
        modalNotChosen = mh.notChosen ?? null;
        line = `Choose ${mh.count === 2 ? 'two' : 'one'}`;
      }
    }
    if ((m = line.match(/^Choose (one|two|three|one or both|one or more|any number|up to two|up to three)(?: —)?$/i))) {
      modal = [];
      if (maxModesIf) modalMaxIf = maxModesIf;
      if (repeatable) modalRepeatable = true;
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
    // Spree: "+ {2}{B} — Destroy target creature." Each mode has its own additional cost.
    if ((m = line.match(/^\+\s*((?:\{[^}]+\})+)\s*\u2014\s*(.+)$/))) {
      const ctx = newCtx({ isSpell: true });
      const { effects, unhandled } = parseEffects(m[2], ctx);
      if (unhandled.length) {
        unhandledLines.push(...unhandled);
        continue;
      }
      if (!modal) {
        modal = [];
        modeCosts = [];
        [minModes, maxModes] = [1, 6];
      }
      modeCosts ??= [];
      modeCosts[modal.length] = m[1];
      modal.push({ text: line, targets: ctx.targets, effects });
      compiledLines.push(line);
      continue;
    }
    if (modal && (m = line.match(/^•\s*(.+)$/))) {
      const ctx = newCtx({ isSpell: true });
      const { effects, unhandled } = parseEffects(stripModeLabel(m[1]), ctx);
      modal.push({ text: m[1], targets: ctx.targets, effects: modalX !== null ? effects.map((e) => substituteX(e, modalX!)) : effects });
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
    // Additional costs
    if ((m = line.match(/^As an additional cost to cast (?:this spell|~), (.+?)\.?$/i))) {
      const c = parseCost(m[1].replace(/^[a-z]/, (ch) => ch.toUpperCase()));
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
    if ((m = line.match(/^([+−-]X): (.+)$/))) {
      const ctx = newCtx();
      const rest = parseActivationRestriction(m[2]);
      const { effects, unhandled } = parseEffects(rest.text, ctx);
      const up = m[1].startsWith('+');
      abilities.push({ kind: 'activated', text: line, cost: up ? { loyalty: 0, manual: 'Add X loyalty counters' } : { loyalty: 0, removeCounters: { counter: 'loyalty', amount: 'X' } }, targets: ctx.targets, effects, sorcerySpeed: true });
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
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
    // On a spell, "At the beginning of your next upkeep, X" is a delayed trigger the spell sets up.
    if (isSpell && (/^At the beginning of (?:your next|the next) /i.test(line) || /^Whenever [^,]+ this turn, /i.test(line))) {
      const r = parseEffects(line, spellCtx);
      if (!r.unhandled.length) {
        spellEffects.push(...r.effects);
        compiledLines.push(line);
        continue;
      }
    }
    // "When you discard a nonland card this way, X" on its own line: runs after the previous ability when a matching card moved.
    if ((m = line.match(/^When (?:you )?(?:discard|exile|sacrifice|reveal|mill|destroy|return) (?:a|an|one or more) (.+?) this way, (.+?)\.?$/i)) && (abilities.length || (isSpell && spellEffects.length))) {
      const prev = abilities[abilities.length - 1] as AbilitySpec | undefined;
      const prevEffects = isSpell && spellEffects.length ? spellEffects : prev && (prev.kind === 'triggered' || prev.kind === 'activated' || prev.kind === 'spell') ? prev.effects : null;
      const noun = parseNoun(`a ${m[1].replace(/ cards?$/i, ' card')}`);
      if (prevEffects && noun) {
        const ctx = newCtx({ triggerHasObject: false, triggerHasPlayer: false, isSpell: isSpell || prev?.kind === 'spell' });
        ctx.lastObj = { ref: 'lastMoved' };
        const r = parseEffects(m[2], ctx);
        if (!r.unhandled.length) {
          prevEffects.push({ kind: 'conditional', if: { kind: 'amount', a: { kind: 'countRef', ref: { ref: 'lastMoved' }, filter: { ...noun.filter, zone: undefined } }, op: '>=', b: 1 }, then: r.effects });
          if (ctx.targets.length) {
            if (isSpell && spellEffects.length) spellCtx.targets.push(...ctx.targets);
            else if (prev && 'targets' in prev) prev.targets = [...(prev.targets ?? []), ...ctx.targets];
          }
          compiledLines.push(line);
          continue;
        }
      }
    }
    // Reflexive trigger on its own line: "When you do, X" attaches to the previous ability's optional block.
    if ((m = line.match(/^When you do, (.+?)\.?$/i)) && abilities.length) {
      const prev = abilities[abilities.length - 1];
      const prevEffects = prev.kind === 'triggered' || prev.kind === 'activated' || prev.kind === 'spell' ? prev.effects : null;
      const last = prevEffects?.[prevEffects.length - 1];
      if (last && (last.kind === 'may' || last.kind === 'ifPays')) {
        const ctx = newCtx({ triggerHasObject: true, triggerHasPlayer: true, isSpell: prev.kind === 'spell' });
        const { effects, unhandled } = parseEffects(m[1], ctx);
        if (!unhandled.length) {
          last.effects.push(...effects);
          if (ctx.targets.length && 'targets' in prev) prev.targets = [...(prev.targets ?? []), ...ctx.targets];
          compiledLines.push(line);
          continue;
        }
      }
    }
    // A standalone restriction line applies to the activated ability above it.
    if (/^(?:Activate |Any player may activate this ability|Only your opponents may activate this ability)/i.test(line)) {
      const rest = parseActivationRestriction(line);
      const prev = [...abilities].reverse().find((a) => a.kind === 'activated');
      if (prev && prev.kind === 'activated' && !rest.text.trim() && !rest.unhandled) {
        if (rest.sorcerySpeed) prev.sorcerySpeed = true;
        if (rest.oncePerTurn) prev.oncePerTurn = true;
        if (rest.perTurnLimit) prev.perTurnLimit = rest.perTurnLimit;
        if (rest.exhaust) prev.exhaust = true;
        if (rest.anyPlayer) prev.anyPlayer = true;
        if (rest.opponentsOnly) prev.opponentsOnly = true;
        if (rest.yourTurn) prev.condition = prev.condition ? { kind: 'and', cs: [prev.condition, { kind: 'yourTurn' }] } : { kind: 'yourTurn' };
        if (rest.condition) prev.condition = prev.condition ? { kind: 'and', cs: [prev.condition, rest.condition] } : rest.condition;
        compiledLines.push(line);
        continue;
      }
    }
    // Triggered
    if ((/^(When|Whenever|At the beginning)/i.test(line) && !/^When you next cast /i.test(line)) || (!isSpell && /^At (?:the )?end of combat, /i.test(line))) {
      const head = parseTriggerHead(line);
      if (!head) {
        // "When you control no Islands, sacrifice ~" is a state trigger the engine treats like a static rule.
        const asStatic = parseStatic(line, !isSpell);
        if (asStatic) {
          abilities.push(...withBlock(asStatic));
          compiledLines.push(line);
          continue;
        }
        // Unknown trigger condition: still surface at the right time if we can guess the event roughly.
        unhandledLines.push(line);
        abilities.push(...guessTrigger(line));
        continue;
      }
      const split = splitTriggerRest(head.rest);
      const ctx = newCtx({ triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer, triggerObjectIsSource: head.objectIsSource });
      let effects: Effect[];
      let unhandled: string[];
      let reflexivePrefix: string | null = null;
      let restForModal = split.rest;
      {
        const rm = split.rest.match(/^(.+?)\.\s*(?:When|If) you do, (choose .+)$/i);
        if (rm && parseModalHead(rm[2]) && lines[li + 1]?.startsWith('•')) {
          reflexivePrefix = rm[1];
          restForModal = rm[2];
        }
      }
      const modalHead = parseModalHead(restForModal);
      if (modalHead && lines[li + 1]?.startsWith('•')) {
        // Modal trigger: options follow as bullet lines.
        const options: { text: string; effects: Effect[] }[] = [];
        unhandled = [];
        while (lines[li + 1]?.startsWith('•')) {
          li++;
          const optText = stripModeLabel(lines[li].replace(/^•\s*/, ''));
          const r = parseEffects(optText, ctx);
          // A mode whose body is itself a triggered ability grants that ability instead.
          if (r.unhandled.length && parseTriggerHead(optText)) {
            options.push({ text: optText, effects: [{ kind: 'grantAbility', text: optText, on: { ref: 'self' }, duration: 'permanent' }] });
            continue;
          }
          options.push({ text: optText, effects: modalHead.x !== undefined ? r.effects.map((e) => substituteX(e, modalHead.x!)) : r.effects });
          unhandled.push(...r.unhandled);
        }
        effects = [{ kind: 'chooseMode', options, count: modalHead.count, countAmount: modalHead.xCount, min: modalHead.min, notChosen: modalHead.notChosen, random: modalHead.random }];
        if (reflexivePrefix) {
          // "you may pay {1}. When you do, choose one —": the modes are the payment's effects.
          const pay = reflexivePrefix.match(/^(?:you may )?pay ((?:\{[^}]+\})+|\d+ life)$/i);
          if (pay) {
            const life = pay[1].match(/^(\d+) life$/);
            effects = [life ? { kind: 'ifPays', cost: '', payLife: parseInt(life[1], 10), effects } : { kind: 'ifPays', cost: pay[1], effects }];
            reflexivePrefix = null;
          }
        }
        if (reflexivePrefix) {
          const pre = parseEffects(reflexivePrefix, ctx);
          if (pre.unhandled.length) unhandled.push(...pre.unhandled);
          else {
            const last = pre.effects[pre.effects.length - 1];
            if (last && (last.kind === 'ifPays' || last.kind === 'may')) {
              last.effects = [...last.effects, ...effects];
              effects = pre.effects;
            } else effects = [...pre.effects, ...effects];
          }
        }
      } else ({ effects, unhandled } = parseEffects(split.rest, ctx));
      let condition: Condition | undefined = head.stateCondition;
      if (split.condition) condition = parseCondition(split.condition, { self: { ref: 'self' }, lastObj: null, triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer }) ?? { kind: 'manual', text: `Is this true: "${split.condition}"?` };
      if (head.exploit) {
        // Exploit: on entering, you may sacrifice a creature; if you do, the exploit effects happen.
        effects = [{ kind: 'may', prompt: 'Exploit: sacrifice a creature?', effects: [{ kind: 'sacrificeChoice', who: { ref: 'controller' }, filter: { types: ['Creature'], zone: 'battlefield' }, count: 1 }, ...effects] }];
      }
      const heads = [head, ...(head.also ?? []).map((h) => ({ ...h, rest: head.rest }))];
      for (const h of heads) {
        const ab: TriggeredAbilitySpec = { kind: 'triggered', text: line, event: h.event, filter: h.filter, effects, targets: ctx.targets.length ? ctx.targets : undefined, optional: split.optional || undefined, condition, zone: h.zone, leavesTheBattlefield: h.leaves, oncePerTurn: /this ability triggers only once each turn|do this only once each turn/i.test(line) || undefined };
        if (h.event === 'stateTrigger' && condition) ab.stateCondition = condition;
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
        const modalHead = parseModalHead(rest.text);
        if (modalHead && lines[li + 1]?.startsWith('•')) {
          const options: { text: string; effects: Effect[] }[] = [];
          unhandled = [];
          while (lines[li + 1]?.startsWith('•')) {
            li++;
            const optText = stripModeLabel(lines[li].replace(/^•\s*/, ''));
            const r = parseEffects(optText, ctx);
            if (r.unhandled.length && parseTriggerHead(optText)) {
              options.push({ text: optText, effects: [{ kind: 'grantAbility', text: optText, on: { ref: 'self' }, duration: 'permanent' }] });
              continue;
            }
            options.push({ text: optText, effects: modalHead.x !== undefined ? r.effects.map((e) => substituteX(e, modalHead.x!)) : r.effects });
            unhandled.push(...r.unhandled);
          }
          effects = [{ kind: 'chooseMode', options, count: modalHead.count, countAmount: modalHead.xCount, min: modalHead.min, notChosen: modalHead.notChosen, random: modalHead.random }];
        } else ({ effects, unhandled } = parseEffects(rest.text, ctx));
        // Class cards: "{2}{W}: Level 2" gains the level; abilities after it need that level.
        const lvl = rest.text.match(/^Level (\d+)\.?$/i);
        if (lvl) {
          const n = parseInt(lvl[1], 10);
          abilities.push({ kind: 'activated', text: line, cost, effects: [{ kind: 'addCounters', counter: 'level', amount: 1, on: { ref: 'self' } }], sorcerySpeed: true, condition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: 'level', op: '==', value: n - 2 } });
          block = { condition: { kind: 'hasCounter', ref: { ref: 'self' }, counter: 'level', op: '>=', value: n - 1 }, station: false };
          compiledLines.push(line);
          continue;
        }
        const isMana = effects.length > 0 && effects.every((e) => e.kind === 'addMana' || (e.kind === 'chooseMode' && e.options.every((o) => o.effects.every((x) => x.kind === 'addMana')))) && ctx.targets.length === 0;
        const conds: Condition[] = [];
        if (rest.yourTurn) conds.push({ kind: 'yourTurn' });
        if (rest.condition) conds.push(rest.condition);
        const ab: ActivatedAbilitySpec = { kind: 'activated', text: line, cost, effects, targets: ctx.targets.length ? ctx.targets : undefined, manaAbility: isMana || undefined, sorcerySpeed: rest.sorcerySpeed, oncePerTurn: rest.oncePerTurn, perTurnLimit: rest.perTurnLimit, opponentsOnly: rest.opponentsOnly, exhaust: rest.exhaust, anyPlayer: rest.anyPlayer, zone: cost.discardSelf || cost.revealSelf ? 'hand' : undefined, condition: conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : { kind: 'and', cs: conds } };
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
      // "As long as ~ is in your graveyard, ..." works from the graveyard.
      if (/~ is in your graveyard/i.test(line)) for (const a of stat) if (a.kind === 'static') a.zone = 'graveyard';
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
      // "Morbid — ~ deals 5 damage instead if a creature died this turn." rewrites the previous line's effects.
      if (lastSpellLine !== null && lastSpellStart === 0 && /instead(?: if .+)?\.?$/i.test(line) && !/ would /i.test(line)) {
        const fresh = newCtx({ isSpell: true });
        const r = parseEffects(`${lastSpellLine}. ${line}`, fresh);
        if (!r.unhandled.length) {
          spellEffects.length = 0;
          spellEffects.push(...r.effects);
          spellCtx.targets.length = 0;
          spellCtx.targets.push(...fresh.targets);
          compiledLines.push(line);
          continue;
        }
      }
      lastSpellStart = spellEffects.length;
      lastSpellLine = line;
      const { effects, unhandled } = parseEffects(line, spellCtx);
      spellEffects.push(...effects);
      if (unhandled.length) unhandledLines.push(...unhandled);
      else compiledLines.push(line);
      continue;
    }
    unhandledLines.push(line);
  }
  // Dice result rows ("1—9 | effect") attach to the preceding roll.
  void 0;
  if (isSpell || modal || spellEffects.length) {
    if (modal) abilities.push({ kind: 'spell', modes: modal, modeCosts: modeCosts ?? undefined, minModes, maxModes, maxModesIf: modalMaxIf, modesRepeatable: modalRepeatable || undefined, modesNotChosen: modalNotChosen ?? undefined, effects: spellEffects, targets: spellCtx.targets.length ? spellCtx.targets : [] });
    else abilities.push({ kind: 'spell', effects: spellEffects, targets: spellCtx.targets.length ? spellCtx.targets : undefined });
    void spellTargets;
  }
  // Statics that give the permanent itself rules text ('~ has "Whenever ~ becomes blocked, draw a card"') compile that text
  // as ordinary abilities carrying the static's condition.
  for (const ab of [...abilities]) {
    if (ab.kind !== 'static' || ab.affects !== 'self' || !ab.modification || ab.modification.layer !== 6 || !ab.modification.addAbilityText?.length) continue;
    for (const text of ab.modification.addAbilityText) {
      const inner = compileFace(card, faceName, text, typeLine);
      for (const ia of inner.script.abilities) {
        if (ia.kind === 'spell') continue;
        const cond = ab.condition;
        abilities.push(cond && (ia.kind === 'static' || ia.kind === 'triggered' || ia.kind === 'activated') ? ({ ...ia, condition: ia.condition ? { kind: 'and', cs: [ia.condition, cond] } : cond } as AbilitySpec) : ia);
      }
      unhandledLines.push(...inner.unhandledLines);
    }
    abilities.splice(abilities.indexOf(ab), 1);
  }
  // Integrity guard: an ability that refers to a target slot it never declares would
  // resolve against nothing, so treat its line as unhandled rather than claim it works.
  for (const ab of [...abilities]) {
    const declared = ((ab as { targets?: unknown[] }).targets?.length ?? 0) + ((ab as { modes?: { targets?: unknown[] }[] }).modes ?? []).reduce((a, mo) => a + (mo.targets?.length ?? 0), 0);
    let maxSlot = -1;
    const scan = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) scan(x); return; }
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.ref === 'target') maxSlot = Math.max(maxSlot, typeof o.slot === 'number' ? o.slot : 0);
      for (const x of Object.values(o)) scan(x);
    };
    scan(ab);
    if (maxSlot < declared) continue;
    abilities.splice(abilities.indexOf(ab), 1);
    const text = (ab as { text?: string }).text;
    const line = text && lines.find((l) => l === text || l.includes(text));
    if (line) {
      const at = compiledLines.indexOf(line);
      if (at >= 0) compiledLines.splice(at, 1);
      if (!unhandledLines.includes(line)) unhandledLines.push(line);
    }
  }
  const meaningful = lines.filter((l) => !isKeywordLine(l));
  const automatedAbilities = abilities.filter((a) => {
    if (a.kind === 'spell') return a.effects.some((e) => e.kind !== 'manual') || (a.modes?.length ?? 0) > 0;
    if (a.kind === 'triggered') return true; // even a manual-effect trigger fires the prompt at the right time
    if (a.kind === 'activated') return a.effects.some((e) => e.kind !== 'manual');
    return true;
  });
  const coverage: CardScript['coverage'] = meaningful.length === 0 || unhandledLines.length === 0 ? 'full' : automatedAbilities.length === 0 ? 'none' : 'partial';
  return { script: { name: faceName, abilities, additionalCost, castCondition, alternativeCosts: alternativeCosts.length ? alternativeCosts : undefined, costModifiers: costModifiers.length ? costModifiers : undefined, coverage, origin: 'compiled', unhandledText: unhandledLines.length ? unhandledLines : undefined }, compiledLines, unhandledLines };
}

/** "Cast ~ only during combat [before blockers are declared] [and only if ...]" → a condition checked when casting. */
function parseCastRestriction(text: string): Condition | null {
  const parts = text.split(/ and only /i);
  const conds: Condition[] = [];
  for (const raw of parts) {
    const p = raw.replace(/^(?:during|if) /i, (w) => w.toLowerCase());
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^during (?:the |your |an opponent's )?(declare attackers|declare blockers|combat damage|end|upkeep|draw) step$/i))) conds.push({ kind: 'turnStep', steps: [({ 'declare attackers': 'declareAttackers', 'declare blockers': 'declareBlockers', 'combat damage': 'combatDamage', end: 'end', upkeep: 'upkeep', draw: 'draw' } as Record<string, string>)[m[1].toLowerCase()]] });
    else if ((m = p.match(/^during combat(?: on your turn)?( before blockers are declared| after blockers are declared| before the combat damage step)?$/i))) {
      const before = / before blockers/i.test(m[1] ?? '');
      const after = / after blockers/i.test(m[1] ?? '');
      const steps = before ? ['beginCombat', 'declareAttackers'] : after ? ['declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'] : /before the combat damage/i.test(m[1] ?? '') ? ['beginCombat', 'declareAttackers', 'declareBlockers'] : ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'];
      conds.push({ kind: 'turnStep', steps, player: / on your turn/i.test(p) ? 'you' : undefined });
    } else if ((m = p.match(/^during (your|an opponent's|each player's) (upkeep|draw|end|untap)(?: step)?$/i))) {
      const who = /^your$/i.test(m[1]) ? 'you' : /opponent/i.test(m[1]) ? 'opponent' : 'any';
      conds.push({ kind: 'turnStep', steps: [m[2].toLowerCase()], player: who });
    } else if ((m = p.match(/^during an opponent's turn after their upkeep step$/i))) {
      conds.push({ kind: 'and', cs: [{ kind: 'notYourTurn' }, { kind: 'turnStep', steps: ['draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end'] }] });
    } else if (/^before blockers are declared$/i.test(p)) conds.push({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers'] });
    else if ((m = p.match(/^during combat on an opponent's turn$/i))) {
      conds.push({ kind: 'and', cs: [{ kind: 'notYourTurn' }, { kind: 'turnStep', steps: ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'] }] });
    } else if (/^during an opponent's turn$/i.test(p)) conds.push({ kind: 'notYourTurn' });
    else if (/^after combat$/i.test(p)) conds.push({ kind: 'turnStep', steps: ['main2', 'end'] });
    else if (/^before combat$/i.test(p)) conds.push({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1'] });
    else if (/^during your turn$/i.test(p)) conds.push({ kind: 'not', c: { kind: 'notYourTurn' } });
    else if (/^during your turn$/i.test(p)) conds.push({ kind: 'yourTurn' });
    else if (/^before the combat damage step$/i.test(p)) conds.push({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers'] });
    else if (/^before attackers are declared$/i.test(p)) conds.push({ kind: 'turnStep', steps: ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers'], beforeAttackers: true });
    else if (/^if you've been attacked this step$/i.test(p) || /^if you have been attacked this step$/i.test(p)) conds.push({ kind: 'eventThisTurn', event: 'attacked', player: 'you' });
    else if ((m = p.match(/^if (.+)$/i))) {
      const c = parseCondition(m[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (!c || c.kind === 'manual') return null;
      conds.push(c);
    } else return null;
  }
  return conds.length === 1 ? conds[0] : { kind: 'and', cs: conds };
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


/** Mode bullets sometimes carry a flavor label ("Dispel Magic — Destroy target enchantment"). */
function stripModeLabel(text: string): string {
  // Tiered spells: "Cross-Slash — {0} — Destroy target tapped creature."
  const tiered = text.match(/^[A-Z][\w' !,.-]{1,40}? — (?:\{[^}]*\})+ — (.+)$/);
  if (tiered) return tiered[1];
  return text.replace(/^([A-Z][\w' !,.-]{1,40}?) — (?=[A-Z~{])/, '');
}

/** A modal head, possibly with an X definition or a "that hasn't been chosen" restriction. */
function parseModalHead(text: string): { count: number; notChosen?: 'turn' | 'game'; x?: Amount; min?: number; xCount?: Amount; random?: boolean } | null {
  text = text.trim().replace(/\s*\u2014\s*$/, '');
  let atRandom = false;
  if (/ at random$/i.test(text)) {
    atRandom = true;
    text = text.replace(/ at random$/i, '');
  }
  // A conditional upgrade ("If you have no cards in hand, choose one or more instead") is not
  // modelled inside triggered abilities; keep the base choice.
  text = text.replace(/\.\s*If .+?, (?:you may )?choose .+? instead\.?$/i, '');
  text = text.replace(/\.\s*Each mode must target a different \w+\.?$/i, '');
  {
    const xm = text.match(/^choose up to X,? where X is (.+?)\s*(?:\u2014)?\.?$/i);
    if (xm) {
      const a = parseAmount(xm[1], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
      if (a !== null) return { count: 6, min: 0, x: undefined, xCount: a };
    }
  }
  const m = text.match(/^choose (one|two|one or both|one or more|any number|up to one|up to two|up to three)(?: that (?:has not|hasn't) been chosen( this turn)?)?(?: —)?\.?(?: X is (.+?)\.?)?$/i);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const out: { count: number; notChosen?: 'turn' | 'game'; x?: Amount; min?: number; xCount?: Amount; random?: boolean } = { count: /two/i.test(w) ? 2 : /three/i.test(w) ? 3 : 1 };
  if (atRandom) out.random = true;
  if (/^up to /i.test(w)) out.min = 0;
  if (m[2] !== undefined || /been chosen/i.test(text)) out.notChosen = m[2] ? 'turn' : 'game';
  if (m[3]) {
    const a = parseAmount(m[3], { self: { ref: 'self' }, lastObj: null, triggerHasObject: false });
    if (a === null) return null;
    out.x = a;
  }
  return out;
}

/** Rooms are split enchantments whose two doors unlock separately; both doors live on one permanent. */
function compileRoom(card: CardData): CompileResult | null {
  const faces = card.faces;
  if (!faces || faces.length !== 2 || !faces.every((f) => /\bRoom\b/.test(f.typeLine ?? ''))) return null;
  const abilities: AbilitySpec[] = [];
  const compiledLines: string[] = [];
  const unhandledLines: string[] = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const doorOpen: Condition = { kind: 'doorUnlocked', door: i };
    const r = compileFace({ ...card, ...f, faces: undefined }, f.name ?? card.name, f.oracleText ?? '', f.typeLine ?? card.typeLine);
    compiledLines.push(...r.compiledLines);
    unhandledLines.push(...r.unhandledLines);
    for (const ab of r.script.abilities) {
      if (ab.kind === 'triggered' && /^When you unlock this door/i.test(ab.text)) {
        abilities.push({ ...ab, event: 'unlockedDoor', filter: { self: true, custom: `door:${i}` } });
        continue;
      }
      if (ab.kind === 'spell') continue; // a Room is a permanent; its halves have no spell effects
      const guard = (c?: Condition): Condition => (c ? { kind: 'and', cs: [doorOpen, c] } : doorOpen);
      if (ab.kind === 'triggered' || ab.kind === 'activated' || ab.kind === 'static') abilities.push({ ...ab, condition: guard(ab.condition) } as AbilitySpec);
      else abilities.push(ab);
    }
    // "As a sorcery, you may pay the mana cost of a locked door to unlock it."
    abilities.push({
      kind: 'activated',
      text: `Unlock ${f.name ?? card.name} (${f.manaCost ?? ''})`,
      cost: { mana: f.manaCost ?? '' },
      sorcerySpeed: true,
      condition: { kind: 'doorUnlocked', door: i, not: true },
      effects: [{ kind: 'unlockDoor', door: i }],
    });
  }
  const coverage = unhandledLines.length ? (compiledLines.length ? 'partial' : 'none') : 'full';
  return {
    script: { name: card.name, abilities, coverage, origin: 'compiled', unhandledText: unhandledLines.length ? unhandledLines : undefined },
    compiledLines,
    unhandledLines,
  };
}

export function compileCard(card: CardData): CompileResult {
  const room = compileRoom(card);
  if (room) return room;
  const front = compileFace(card, card.name, card.oracleText ?? '', card.typeLine);
  // Prepared: the permanent half may cast a copy of its spell half while it is prepared.
  if (card.faces?.length === 2 && /\bbecomes prepared\b/i.test(card.oracleText ?? '') && /^(Instant|Sorcery)\b/.test(card.faces[1].typeLine ?? '')) {
    const spellFace = card.faces[1];
    const r = compileFace({ ...card, ...spellFace, faces: undefined }, spellFace.name ?? card.name, spellFace.oracleText ?? '', spellFace.typeLine ?? '');
    const spell = r.script.abilities.find((a) => a.kind === 'spell');
    if (spell && spell.kind === 'spell' && !r.unhandledLines.length) {
      front.script.abilities.push({
        kind: 'activated',
        text: `Cast a copy of ${spellFace.name ?? 'its spell'} (${spellFace.manaCost ?? ''})`,
        cost: { mana: spellFace.manaCost ?? '' },
        condition: { kind: 'memoryFlag', key: 'prepared' },
        targets: spell.targets,
        effects: [...spell.effects, { kind: 'setMemory', key: 'prepared', value: 0 }],
      });
      front.compiledLines.push(...r.compiledLines);
    } else front.unhandledLines.push(...r.unhandledLines);
  }
  if (card.faces && card.faces.length > 1) {
    const faces = card.faces.slice(1).map((f) => compileFace({ ...card, ...f, faces: undefined }, f.name, f.oracleText, f.typeLine));
    front.script.faces = faces.map((f) => f.script);
    for (const f of faces) {
      front.compiledLines.push(...f.compiledLines);
      front.unhandledLines.push(...f.unhandledLines);
    }
    const allFaces = [front.script, ...faces.map((f) => f.script)];
    front.script.coverage = allFaces.every((f) => f.coverage === 'full') ? 'full' : allFaces.every((f) => f.coverage === 'none') ? 'none' : 'partial';
  }
  return front;
}

export { parseSentence, newCtx, type ParseCtx };
