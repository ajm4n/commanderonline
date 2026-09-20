/** Sentence → Effect[] parser. */
import type { Effect, Ref, TargetSpec, TokenSpec, Duration, Color, ObjectFilter, Amount, Condition, ManaColor } from '@commander/engine';
import { TOKEN_PRESETS, parseAddManaText } from '@commander/engine';
import { wordToNumber, sentences, lc } from './text.js';
import { parseNoun, toTargetSpec, type ParsedNoun, singularize } from './nouns.js';
import { parseAmount } from './amounts.js';
import { parseCondition } from './conditions.js';
import { parseTriggerHead } from './triggers.js';
import type { TriggerHead } from './triggers.js';
import { parseCost } from './costs.js';
import { parseStatic } from './statics.js';
import { damageSourceFilter, damageDestFilter, damageModifier } from './damage.js';

export interface ParseCtx {
  targets: TargetSpec[];
  lastObj: Ref | null;
  lastPlayer: Ref | null;
  /** The target registered by a bare "Choose any target." sentence, for a later "that target". */
  anyTarget?: Ref;
  /** ~ named as a damage source with no antecedent in scope: becomes "it" for later sentences once the recipient is resolved. */
  pendingSubject?: Ref;
  /** Every "any target" slot a "Choose any target, then choose another …" sentence registered ("each of them"). */
  anyTargets?: Ref[];
  /** Inside a trigger whose event carries an object / player. */
  triggerHasObject: boolean;
  triggerHasPlayer: boolean;
  /** The line is on an instant/sorcery (affects "~" meaning for return-to-hand etc.). */
  isSpell: boolean;
  /** Inside a trigger whose subject is the event's source (damage dealer) rather than its object. */
  triggerObjectIsSource?: boolean;
  /** Inside a "whenever one or more …" trigger: plural pronouns mean every object of the batch. */
  triggerBatch?: boolean;
  /** "Whenever you attack with one or more Insects, … each of them": the attacking creatures the head named. */
  attackersFilter?: import('@commander/engine').ObjectFilter;
  /** Memory key of a looked-at / revealed pool of library cards that "the rest" refers to. */
  restKey?: string;
  /** The creature that just explored (for "Whenever a creature you control explores"). */
  exploreRef?: Ref;
  /** Bound by a sentence whose comparison defines "the difference". */
  difference?: Amount;
  /** What "X" stands for once a "where X is …" sentence has defined it (later sentences may test X). */
  boundX?: Amount;
}

export function newCtx(partial: Partial<ParseCtx> = {}): ParseCtx {
  return { targets: [], lastObj: null, lastPlayer: null, triggerHasObject: false, triggerHasPlayer: false, isSpell: false, ...partial };
}

const SELF: Ref = { ref: 'self' };
const YOU: Ref = { ref: 'controller' };

const EXTRA_KEYWORDS = ['mentor', 'exalted', 'banding', 'melee', 'flanking', 'bushido', 'decayed', 'training', 'backup', 'plainswalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'forestwalk', 'landwalk', 'phasing', 'rampage', 'annihilator', 'afflict', 'battle cry', 'dethrone', 'myriad', 'extort', 'ingest', 'devoid', 'wither', 'toxic', 'riot', 'unleash', 'undying', 'persist', 'protection from the chosen color', 'protection from all colors', 'hexproof from each color', 'ward {1}', 'ward {2}', 'ward {3}', 'ward {4}', 'ward—pay 2 life', 'ward—pay 3 life', 'cumulative upkeep', 'cascade', 'storm', 'prowess', 'evolve', 'skulk', 'shadow', 'horsemanship', 'fear', 'intimidate', 'convoke', 'delve', 'improvise', 'ravenous', 'daybound', 'nightbound', 'squad', 'enlist', 'sunburst', 'modular', 'vanishing', 'fading', 'echo', 'living weapon', 'reconfigure', 'compleated', 'for mirrodin!', 'jump-start', 'afterlife', 'ascend', 'exert', 'crew', 'partner', 'changeling', 'suspend', 'flash', 'provoke', 'melee', 'umbra armor', 'totem armor', 'tantrum', 'bands with other legendary creatures'];
const KEYWORD_WORDS = ['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance', 'haste', 'flash', 'defender', 'reach', 'menace', 'hexproof', 'indestructible', 'shroud', 'fear', 'intimidate', 'skulk', 'horsemanship', 'shadow', 'infect', 'wither', 'prowess', 'undying', 'persist', 'changeling', 'protection from white', 'protection from blue', 'protection from black', 'protection from red', 'protection from green', 'protection from all colors', 'protection from each color', 'protection from creatures', 'protection from artifacts', 'protection from everything', 'protection from instants', 'protection from sorceries', 'protection from planeswalkers', 'protection from colorless', 'protection from multicolored', 'protection from monocolored', 'hexproof from white', 'hexproof from blue', 'hexproof from black', 'hexproof from red', 'hexproof from green'];

export function parseKeywordList(text: string): string[] | null {
  const parts = text
    .toLowerCase()
    .replace(/ and from /g, ', protection from ')
    .replace(/,? and /g, ', ')
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    const q = p.replace(/^(?:your choice of )/, '');
    if (!KEYWORD_WORDS.includes(q) && !EXTRA_KEYWORDS.includes(q) && !/^(?:protection from [A-Za-z][\w' -]*|hexproof from [A-Za-z][\w' -]*|ward \{[^}]+\}|(?:artifact|nonbasic|snow|legendary) landwalk|[a-z]+walk|(?:annihilator|bushido|rampage|toxic|afflict|fabricate|modular|absorb|ripple|poisonous|frenzy|renown|backup|squad|crew|reinforce|bloodthirst|graft|amplify|soulshift|firebending|waterbending|earthbending|airbending|mobilize|devour|training|spectacle|afterlife|vanishing|fading|dredge|ripple|frenzy|poisonous|absorb|level up|tribute) \d+|(?:unearth|cycling|flashback|escape|scavenge|replicate|conspire|retrace|miracle|madness|outlast|encore|bestow|embalm|eternalize|evoke|emerge|prowl|blitz|dash|foretell|disturb|spectacle|surge|overload|aftermath|transmute|buyback|entwine|splice|awaken|kicker|multikicker|slivercycling|landcycling|typecycling|basic landcycling|plainscycling|islandcycling|swampcycling|mountaincycling|forestcycling|wizardcycling|slivercycling|reconfigure|equip|fortify|ninjutsu|commander ninjutsu|freerunning|impending|offspring|gift|craft|discover|plot|squad|casualty|cleave|escalate|prototype) (?:(?:\{[^}]+\})+|\d+|—.+)|(?:flashback|escape|scavenge|replicate|conspire|retrace|unearth|embalm|eternalize|miracle|madness|outlast|encore|bestow|aftermath|retrace|dredge|haunt|epic|evoke|emerge|prowl|blitz|dash|foretell|disturb|jump-start|spectacle|surge|overload|entwine|buyback|awaken|cascade|storm|delve|discover|plot|craft|forage|cloak|manifest dread|read ahead|hope|provoke|demonstrate|exploit|mono|continuous|flanking|banding|soulbond|melee|ascend|myriad|extort|convoke|improvise|riot|exalted|fear|intimidate|totem armor|split second|devoid|ingest|skulk|partner|mutate|boast|will of the council|council's dilemma|goaded|decayed|toxic|for mirrodin!|living weapon|reconfigure|compleated|daybound|nightbound|start your engines!|max speed|tap to attack))$/.test(q)) return null;
    out.push(q.charAt(0).toUpperCase() + q.slice(1));
  }
  return out;
}

function duration(text: string): { rest: string; duration: Duration | undefined } {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^(.*?)\s+until end of turn$/i))) return { rest: m[1], duration: 'endOfTurn' };
  if ((m = text.match(/^(.*?)\s+until your next turn$/i))) return { rest: m[1], duration: 'untilYourNextTurn' };
  if ((m = text.match(/^(.*?)\s+until end of combat$/i))) return { rest: m[1], duration: 'endOfCombat' };
  if ((m = text.match(/^(.*?)\s+this turn$/i))) return { rest: m[1], duration: 'endOfTurn' };
  return { rest: text, duration: undefined };
}

/** Resolve an object phrase to a Ref, registering targets. */
export function objRef(phrase: string, ctx: ParseCtx): Ref | null {
  const t = phrase.trim().replace(/[.,]$/, '').replace(/^a second target /i, 'another target ');
  // "target artifact card in a graveyard or artifact on the battlefield": one filter, two zones.
  {
    const gb = t.match(/^(target|another target) (\w+) cards? in (?:a|your|an opponent's) graveyard or \2 on the battlefield$/i);
    if (gb) {
      const noun = parseNoun(`a ${gb[2]}`);
      if (noun && noun.confident) {
        const f: ObjectFilter = { ...noun.filter, zoneIn: ['graveyard', 'battlefield'] };
        delete f.zone;
        if (/your graveyard/i.test(t)) f.owner = 'you';
        else if (/an opponent's graveyard/i.test(t)) f.owner = 'opponent';
        ctx.targets.push({ description: t, kind: 'object', filter: f, min: 1, max: 1 });
        const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
        ctx.lastObj = ref;
        return ref;
      }
    }
  }
  // "target spell or nonland permanent": one filter covering the stack and the battlefield.
  // Nothing on the stack is a land, so excluding lands is enough to spell "nonland permanent".
  {
    const sp = t.match(/^(target|another target) spell or (nonland )?permanent(?: an opponent controls| you (?:do not|don't) control| you control)?( with .+)?$/i);
    if (sp) {
      const f: ObjectFilter = { zoneIn: ['stack', 'battlefield'] };
      if (sp[2]) f.notTypes = ['Land'];
      if (sp[3]) {
        const q = parseNoun(`a permanent${sp[3]}`);
        if (!q || !q.confident) return null;
        Object.assign(f, { ...q.filter, zone: undefined, zoneIn: ['stack', 'battlefield'], types: undefined });
      }
      if (/an opponent controls/i.test(t)) f.controller = 'opponent';
      else if (/you control/i.test(t)) f.controller = /do not|don't/i.test(t) ? 'opponent' : 'you';
      if (/^another /i.test(sp[1])) f.other = true;
      ctx.targets.push({ description: t, kind: 'object', filter: f, min: 1, max: 1 });
      const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
      ctx.lastObj = ref;
      return ref;
    }
  }
  const l = t.toLowerCase();
  let m0: RegExpMatchArray | null;
  if (l === '~' || l === 'this') {
    ctx.lastObj = SELF;
    return SELF;
  }
  if (/^each of (?:them|those (?:creatures|permanents|cards|tokens|lands))$/.test(l)) return ctx.lastObj ?? (ctx.attackersFilter ? { ref: 'all', filter: { ...ctx.attackersFilter, attacking: true, controller: 'you', zone: 'battlefield' } } : ctx.triggerBatch ? { ref: 'triggerObjects' } : { ref: 'lastMoved' });
  if ((m0 = l.match(/^the player or planeswalker (it|that creature|~) is attacking$/))) return { ref: 'defenderOf', of: m0[1] === '~' ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  if (/^(each creature|all creatures|creatures) blocking (?:it|~|that creature)$/.test(l)) return { ref: 'blockersOf', of: l.endsWith('~') ? SELF : ctx.lastObj ?? SELF };
  // After a bare "Choose target X." sentence, "that creature" is that chosen target even when later sentences moved "it".
  if (ctx.anyTarget && /^that (?:creature|permanent|player|opponent|planeswalker|creature or planeswalker|permanent or player)$/.test(l)) return ctx.anyTarget;
  if (/^(?:the|a|an|one of the) (?:card|creature card|permanent card)s? exiled with (?:~|it)$/.test(l) || /^the exiled cards?$/.test(l) || /^cards exiled with ~$/.test(l) || /^(?:a|the) card (?:you )?exiled with cards named ~$/.test(l)) return { ref: 'chosen', key: 'exiled' };
  if (/^the creature that attacked$/.test(l)) return ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF;
  if (/^(it|them|they|that (creature|permanent|card|artifact|enchantment|land|planeswalker|token|spell)|those (creatures|permanents|cards|tokens|lands|artifacts|enchantments|planeswalkers|spells)|the (creature|permanent|card)|that object|the (?:returned|chosen) cards?)$/.test(l) || /^that [A-Z]\w+$/i.test(t)) {
    if (l.includes('token') && !ctx.lastObj) return { ref: 'lastCreated' };
    // "Whenever one or more creature cards are put into your graveyard …, put one of them onto the battlefield" / "put a
    // +1/+1 counter on each of those creatures": all the objects that triggered it together.
    if (ctx.attackersFilter && !ctx.lastObj && /^(?:them|they|those \w+)$/.test(l)) return { ref: 'all', filter: { ...ctx.attackersFilter, attacking: true, controller: 'you', zone: 'battlefield' } };
    if (ctx.triggerBatch && !ctx.lastObj && /^(?:them|they|those \w+)$/.test(l)) return { ref: 'triggerObjects' };
    // On a permanent, a bare "it" with nothing else in scope means the permanent itself ("if ~ is tapped, put a counter on it").
    // "that creature" never means ~ itself (a card says "~" for that): after "put a quest counter on ~" pointed "it"
    // at ~, "that creature" in a trigger is still the creature that triggered it (Support Mission, Glorious Purpose).
    if (/^that /.test(l) && ctx.lastObj?.ref === 'self' && ctx.triggerHasObject) return ctx.triggerObjectIsSource ? { ref: 'triggerSource' } : { ref: 'triggerObject' };
    // With no antecedent in scope, fall back to the last object this script moved ("put that card onto the battlefield").
    if (ctx.lastObj) return ctx.lastObj;
    if (ctx.triggerHasObject) return ctx.triggerObjectIsSource ? { ref: 'triggerSource' } : { ref: 'triggerObject' };
    if (l === 'it') return SELF;
    // "Return the top creature card of your graveyard to the battlefield. That creature gains haste. Exile it …":
    // once "that creature" has meant what last moved, so does the "it" that follows (Shallow Grave). "That card" is
    // left alone: reveal-and-put sequences still refer to the revealed pile afterwards (Curse of Unbinding).
    if (/^that (?:creature|permanent|artifact|enchantment|land|planeswalker|token)$/.test(l)) ctx.lastObj = { ref: 'lastMoved' };
    return { ref: 'lastMoved' };
  }
  if (/^(enchanted|equipped|fortified) (creature|permanent|land|player|artifact|planeswalker|enchantment)$/.test(l) || /^(?:enchanted|equipped) [A-Z]\w+$/i.test(t)) {
    if (!/player$/.test(l)) ctx.lastObj = { ref: 'attachedTo' }; // "Untap enchanted creature. It gains hexproof …"
    return { ref: 'attachedTo' };
  }

  if (/^each (?:\w+ )?(?:permanent|card|creature|player)s? with the most votes(?: or tied for most votes)?$/.test(l)) return { ref: 'chosen', key: 'votes' };
  if (/^(that|those) tokens?$/.test(l) || l === 'the tokens' || l === 'the token') return { ref: 'lastCreated' };
  if (/^(that|the) spell$/.test(l)) return ctx.lastObj ?? { ref: 'stackTarget' };
  if (/^the chosen (?:creatures|permanents|lands|artifacts|players)$/.test(l) && ctx.lastObj) return ctx.lastObj;
  if (/^any of those cards you (?:didn't|did not) play$/.test(l)) return ctx.lastObj ?? { ref: 'lastMoved' };
  if (/^the other (?:creature|permanent)$/.test(l)) return ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : null) ?? { ref: 'lastMoved' };
  if (/^the (?:permanent|creature|artifact|land|planeswalker)(?: you (?:do not|don't) control| an opponent controls| you control)?$/.test(l) && ctx.lastObj) return ctx.lastObj;
  if (l === 'the chosen creature' || l === 'the chosen permanent') return { ref: 'chosen', key: 'chosen' };
  const gy = t.match(/^~ from your graveyard$/i);
  if (gy) return SELF;
  const noun = parseNoun(t);
  if (!noun) return null;
  // "all Auras attached to that creature": with no target in scope the host is whatever the
  // script last touched — a trigger's object, typically.
  if (noun.filter.attachedToRef?.ref === 'target' && /attached to that /i.test(t)) {
    const host: Ref | null = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : null);
    if (!host) return null;
    noun.filter.attachedToRef = host;
  }
  if (noun.controllerPhrase) {
    const pr = playerRef(noun.controllerPhrase, ctx);
    if (!pr) return null;
    noun.filter.controllerRef = pr;
  }
  if (noun.target) {
    const spec = toTargetSpec(noun);
    ctx.targets.push(spec);
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    if (noun.kind !== 'player') ctx.lastObj = ref;
    if (noun.kind !== 'object') ctx.lastPlayer = ref;
    return ref;
  }
  if (noun.each || (noun.plural && !noun.indefinite)) {
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone) f.zone = 'battlefield';
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return ref;
  }
  return null;
}

/** For indefinite nouns ("a land you control"): produce a choose effect and a ref to the choice. */
export function chooseRef(phrase: string, ctx: ParseCtx, who: Ref = YOU, upTo = false): { pre: Effect[]; ref: Ref } | null {
  const noun = parseNoun(phrase.trim());
  if (!noun || noun.target || noun.each) return null;
  if (noun.controllerPhrase) {
    const pr = playerRef(noun.controllerPhrase, ctx);
    if (process.env.COMPILER_TRACE) console.error(`[chooseRef] ${phrase} :: controllerPhrase=${noun.controllerPhrase} lastPlayer=${JSON.stringify(ctx.lastPlayer)} -> ${JSON.stringify(pr)}`);
    if (!pr) return null;
    noun.filter.controllerRef = pr;
    // "a creature they control" / "a creature that player controls": that player makes the choice.
    if (who.ref === 'controller' && /^(?:they|that player|that opponent|the player)$/i.test(noun.controllerPhrase.trim()) && (pr.ref === 'iter' || pr.ref === 'triggerPlayer')) who = pr;
  }
  const f: ObjectFilter = { ...noun.filter };
  if (!f.zone) f.zone = 'battlefield';
  if (f.zone === 'battlefield' && !f.controller && who.ref === 'controller') f.controller = 'you';
  const key = `chosen${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
  const n = noun.count === 'X' ? 'X' : noun.count;
  const ref: Ref = { ref: 'chosen', key };
  ctx.lastObj = ref;
  return { pre: [{ kind: 'chooseObjects', who, filter: f, count: n, key, upTo }], ref };
}

export function playerRef(phrase: string, ctx: ParseCtx): Ref | null {
  const l = phrase.trim().toLowerCase().replace(/[.,]$/, '');
  if (l === 'you') return YOU;
  if (l === 'each opponent' || l === 'your opponents' || l === 'each of your opponents') return { ref: 'eachOpponent' };
  if (l === 'each player' || l === 'all players') return { ref: 'eachPlayer' };
  // With no antecedent, "that player" means whoever controls the object this script last touched.
  if (l === 'that player' || l === 'that opponent' || l === 'they' || l === 'the player') return ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' } : ctx.triggerHasObject ? { ref: 'triggerController' } : { ref: 'controllerOf', of: { ref: 'lastMoved' } });
  if (l === 'each other player' || l === 'all other players' || l === 'each of your opponents') return { ref: 'eachOpponent' };
  // "Each player other than its controller" / "... other than target player"
  {
    const ot = phrase.trim().match(/^each (?:player|other player) other than (.+)$/i);
    if (ot) {
      const except = playerRef(ot[1], ctx);
      if (except) return { ref: 'playersExcept', except };
    }
  }
  if (l === 'each other opponent' || l === 'each of their opponents' || l === 'each other player who is an opponent') return { ref: 'eachOtherOpponent' };
  if (l === 'its controller' || /^(?:that|the) [\w ]+'s controller$/.test(l) || l === 'the controller of that creature' || l === 'the controller of that permanent') return { ref: 'controllerOf', of: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  if (l === "~'s controller") return { ref: 'controllerOf', of: SELF };
  if (l === "~'s owner") return { ref: 'ownerOf', of: SELF };
  // "each of that player's opponents" (Heartwood Storyteller): everyone but that player.
  if (l === "each of that player's opponents" || l === "that player's opponents" || l === "each of their opponents" && ctx.lastPlayer) {
    const tp = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : ctx.triggerHasObject ? { ref: 'triggerController' as const } : null);
    if (tp) return { ref: 'playersExcept', except: tp };
  }
  // "Target creature's controller reveals a card at random from their hand."
  {
    const tc = phrase.trim().match(/^(target [\w' -]+)'s controller$/i);
    if (tc) {
      const of = objRef(tc[1], ctx);
      if (of) return { ref: 'controllerOf', of };
    }
  }
  if (/^(?:enchanted|equipped) \w+'s controller$/.test(l)) return { ref: 'controllerOf', of: { ref: 'attachedTo' } };
  if (l === 'its owner' || l === "that card's owner") return { ref: 'ownerOf', of: ctx.lastObj ?? { ref: 'triggerObject' } };
  if (l === 'defending player' || l === 'the defending player') return { ref: 'defendingPlayer' };
  {
    const mm = l.match(/^the player (?:(?:with|who has) the (most|least|fewest|lowest|highest|greatest) (life|life total|cards in hand)|who controls the (most|fewest) (.+))$/);
    if (mm) {
      const least = mm[1] === 'least' || mm[1] === 'fewest' || mm[1] === 'lowest' || mm[3] === 'fewest';
      if (mm[2]) return { ref: 'playerWithMost', what: /^life/.test(mm[2]) ? 'life' : 'cards', least: least || undefined };
      const noun = parseNoun(mm[4]!) ?? parseNoun(`a ${singularize(mm[4]!)}`) ?? parseNoun(`a ${singularize(mm[4]!).replace(/^\w/, (c) => c.toUpperCase())}`);
      if (noun && noun.confident) return { ref: 'playerWithMost', what: { filter: { ...noun.filter, zone: 'battlefield' } }, least: least || undefined };
    }
  }
  if (l === 'the active player' || l === 'the attacking player' || l === 'that attacking player' || l === 'attacking player' || l === 'defending player' || l === 'the defending player') return { ref: l === 'the active player' ? 'activePlayer' : /defending/.test(l) ? 'defendingPlayer' : 'triggerPlayer' };
  if (l === 'the player to your left' || l === 'the player to your right') return { ref: 'neighbor', side: l.endsWith('left') ? 'left' : 'right' };
  if (l === "enchanted player" || l === "that player's controller") return { ref: 'attachedTo' };
  if (l === 'the chosen player' || l === 'the chosen opponent') return { ref: 'chosen', key: 'opponent' };
  if (/^the player or planeswalker (?:it|that creature|~) is attacking$/.test(l)) return { ref: 'defenderOf', of: /~ is attacking$/.test(l) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF) };
  const noun = parseNoun(phrase);
  if (noun && noun.kind === 'player' && noun.target) {
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastPlayer = ref;
    return ref;
  }
  return null;
}

/** "An opponent" as an actor (piles, choices): one opponent, not each. */
function actorRef(phrase: string, ctx: ParseCtx): Ref | null {
  if (/^(?:an opponent|a player|an opponent of your choice|one of your opponents)$/i.test(phrase.trim())) return { ref: 'eachOpponent' };
  return playerRef(phrase, ctx);
}

/** Object-or-player phrase (damage targets, "any target"). */
function anyRef(phrase: string, ctx: ParseCtx): Ref | null {
  const l = phrase.trim().toLowerCase();
  if (l === 'each creature and each player' || l === 'each creature and each planeswalker and each player') return null; // handled by caller
  // "that target" / "that permanent or player" refers back to an "any target" already chosen, even when a
  // later sentence moved "it" elsewhere (Blast of Genius: "Choose any target. Draw three cards, then discard a card. ~ deals … to that target").
  if (/^that (?:target|permanent or player|creature, player, or planeswalker|permanent, player or planeswalker|creature or player|player or permanent)$/i.test(l) && (ctx.anyTarget ?? ctx.lastObj)) return ctx.anyTarget ?? ctx.lastObj;
  if (/^that (?:creature|permanent|player|opponent|planeswalker|land|artifact)$/i.test(l) && ctx.anyTarget) return ctx.anyTarget;
  return playerRef(phrase, ctx) ?? objRef(phrase, ctx);
}

const COLOR_MAP: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/** Parse "a 1/1 white Soldier creature token with vigilance" etc. */
export function parseTokenPhrase(text: string): { count: Amount; token: TokenSpec; tapped?: boolean; attacking?: boolean } | null {
  {
    // "Guenhwyvar, a legendary 4/1 green Cat creature token with trample"
    const nm = text.trim().match(/^([A-Z][\w' -]*(?:, [A-Z][\w' -]*)?), ((?:a|an) .+ token.*)$/);
    if (nm && !/^(?:a|an|two|three|four|five|X)\b/i.test(nm[1])) {
      const inner = parseTokenPhrase(nm[2]);
      if (inner) return { ...inner, token: { ...inner.token, name: nm[1], legendary: true } };
    }
  }
  let t = text.trim().replace(/\.$/, '');
  let tapped = false;
  let attacking = false;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(.*?)(?:,| and)? (?:that is|that are) tapped and attacking$/))) {
    t = m[1];
    tapped = attacking = true;
  } else if ((m = t.match(/^(.*?) tapped and attacking$/))) {
    t = m[1];
    tapped = attacking = true;
  } else if ((m = t.match(/^(.*?)(?:,)? (?:that is|that are) attacking$/))) {
    t = m[1];
    attacking = true;
  } else if ((m = t.match(/^(.*?) tapped$/))) {
    t = m[1];
    tapped = true;
  }
  // "an 8/8 Beast creature token that is red, green, and white": the colours trail the body.
  // "a 3/3 Kavu creature token with trample that is all colors": and a keyword clause may sit between.
  t = t.replace(/ that (?:is|are) all colors$/i, ' that is white, blue, black, red, and green');
  if ((m = t.match(/^(.+?) token((?: with .+?)?) that (?:is|are) ((?:white|blue|black|red|green|colorless)(?:(?:, and|, or|,| and| or) (?:white|blue|black|red|green))*)$/i))) {
    const pm2 = m[1].match(/^(.*?)([\dX*]+\/[\dX*]+ )(.*)$/);
    t = (pm2 ? `${pm2[1]}${pm2[2]}${m[3]} ${pm2[3].trim()} token` : `${m[3]} ${m[1]} token`) + m[2];
  }
  // "a tapped and attacking 1/1 red Devil creature token": the flags may come before the body.
  if ((m = t.match(/^((?:a|an|\w+|X)) tapped and attacking (.+)$/i)) && !/tokens? that/i.test(t)) {
    t = `${m[1]} ${m[2]}`;
    tapped = true;
    attacking = true;
  } else if ((m = t.match(/^((?:a|an|\w+|X)) tapped (.+)$/i)) && !/tokens? that/i.test(t)) {
    t = `${m[1]} ${m[2]}`;
    tapped = true;
  }
  // "twice X 1/1 black and green Pest creature tokens"
  let countMul = 1;
  if ((m = t.match(/^(twice|three times) X (.+)$/i))) {
    countMul = /twice/i.test(m[1]) ? 2 : 3;
    t = `X ${m[2]}`;
  }
  // Snow is cosmetic for tokens; drop it so the type line parses.
  t = t.replace(/\bsnow (?=artifact|creature|enchantment|land)/i, '');
  // Copy tokens
  if ((m = t.match(/^(a|an|\w+|X) (?:tapped and attacking |tapped )?tokens? that (?:is|are) (?:a )?cop(?:y|ies) of (.+)$/i))) {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    if (/^(?:a|an|\w+|X) tapped/i.test(t)) tapped = true;
    if (/^(?:a|an|\w+|X) tapped and attacking/i.test(t)) attacking = true;
    const ctx = newCtx({ triggerHasObject: true });
    const ref = objRef(m[2], ctx);
    if (!ref || ctx.targets.length) return null; // copy targets are handled by the caller pattern
    return { count: countMul === 1 ? n : ({ kind: 'times', a: n, b: countMul } as Amount), token: { name: 'Copy', typeLine: '', colors: [], copyOf: ref }, tapped, attacking };
  }
  // "a 2/2 red Dragon creature token with flying and \"{R}: ~ gets +1/+0 until end of turn.\""
  {
    const qm = t.match(/^(.+? tokens?(?: named (?:~'s |[A-Z])[\w' ,-]*?)?(?: with [^"]+?)?)(?:,| and| with) "(.+)"$/i);
    if (qm) {
      const base = parseTokenPhrase(qm[1].replace(/,$/, '').replace(/ and$/, '').replace(/ with$/, ''));
      if (base) {
        const text2 = base.token.oracleText ? `${base.token.oracleText}\n${qm[2]}` : qm[2];
        return { ...base, token: { ...base.token, oracleText: text2 } };
      }
    }
  }
  // "a 0/1 green Wall creature token with defender named Wood" → move the name ahead of the "with" clause
  {
    const rm = t.match(/^(.+? tokens?) (with .+?) (named (?:~'s |[A-Z])[\w' ,-]*)$/i);
    if (rm) t = `${rm[1]} ${rm[3]} ${rm[2]}`;
  }
  m = t.match(/^(a|an|twice that many|that many|\w+|X) (.+?) tokens?(?: named ((?:~'s |[A-Z])[\w' ,~-]*?))?(?: with (.+))?$/i);
  if (!m) return null;
  const n: Amount | null = /that many/i.test(m[1]) ? (/twice/i.test(m[1]) ? { kind: 'times', a: { kind: 'triggerAmount' }, b: 2 } : { kind: 'triggerAmount' }) : wordToNumber(m[1]);
  if (n === null) return null;
  let body = m[2];
  if (/^tapped /i.test(body)) {
    tapped = true;
    body = body.replace(/^tapped /i, '');
  }
  const name = m[3];
  const withText = m[4];
  const spec: TokenSpec = { name: '', typeLine: '', colors: [] };
  if ((/^legendary /i).test(body)) {
    spec.legendary = true;
    body = body.replace(/^legendary /i, '');
  }
  const pt = body.match(/^([\dX*]+)\/([\dX*]+) (.+)$/);
  if (pt) {
    spec.power = pt[1];
    spec.toughness = pt[2];
    body = pt[3];
  }
  // colors
  const colorRe = /^((?:white|blue|black|red|green|colorless)(?:(?:, and|, or|,| and| or) (?:white|blue|black|red|green))*) (.+)$/i;
  const cm = body.match(colorRe);
  if (cm) {
    for (const w of cm[1].toLowerCase().split(/,? and |,? or |, /)) if (COLOR_MAP[w]) spec.colors.push(COLOR_MAP[w]);
    body = cm[2];
  }
  // remaining: subtype words + card types
  const words = body.split(/\s+/);
  const types: string[] = [];
  const subtypes: string[] = [];
  for (const w of words) {
    const l = w.toLowerCase();
    if (l === 'creature') types.push('Creature');
    else if (l === 'artifact') types.push('Artifact');
    else if (l === 'enchantment') types.push('Enchantment');
    else if (l === 'land') types.push('Land');
    else if (/^[A-Z]/.test(w)) subtypes.push(w);
    else return null;
  }
  if (!types.length && subtypes.length === 1 && TOKEN_PRESETS[subtypes[0]] && !spec.power) {
    const preset = TOKEN_PRESETS[subtypes[0]];
    return { count: countMul === 1 ? n : ({ kind: 'times', a: n, b: countMul } as Amount), token: { ...preset, preset: subtypes[0] }, tapped, attacking };
  }
  if (!types.length) types.push(spec.power ? 'Creature' : 'Artifact');
  spec.typeLine = types.join(' ') + (subtypes.length ? ` — ${subtypes.join(' ')}` : '');
  spec.name = name ?? (subtypes.length ? subtypes.join(' ') : types.join(' '));
  if (withText) {
    // 'with flying' / 'with "..."' / 'with haste and trample'
    const kws = parseKeywordList(withText.replace(/"/g, ''));
    if (kws) spec.keywords = kws;
    else if (/^"/.test(withText)) spec.oracleText = withText.replace(/^"|"$/g, '');
    else return null;
  }
  return { count: countMul === 1 ? n : ({ kind: 'times', a: n, b: countMul } as Amount), token: spec, tapped, attacking };
}

type Pattern = [RegExp, (m: RegExpMatchArray, ctx: ParseCtx) => Effect[] | null];

function amt(text: string, ctx: ParseCtx) {
  // "enchanted creature's power": the permanent this Aura/Equipment is attached to (was read as ~'s own power).
  const em = text.trim().match(/^(?:the )?(?:enchanted|equipped|fortified) [\w' -]+?'s (power|toughness|mana value)$/i);
  if (em) return { kind: em[1].toLowerCase() === 'power' ? 'power' : em[1].toLowerCase() === 'toughness' ? 'toughness' : 'manaValue', ref: { ref: 'attachedTo' } } as Amount;
  // "target creature's power": register the target here, since the amount parser cannot.
  const tm = text.trim().match(/^(?:the )?(target [\w' -]+?)'s (power|toughness|mana value)$/i);
  if (tm) {
    const ref = objRef(tm[1], ctx);
    if (ref) return { kind: tm[2].toLowerCase() === 'power' ? 'power' : tm[2].toLowerCase() === 'toughness' ? 'toughness' : 'manaValue', ref } as Amount;
  }
  // Scapeshift: "Sacrifice any number of lands. Search your library for up to that many land cards": the count of what
  // the previous effect moved, not a trigger's amount.
  if (/^that many$/i.test(text.trim()) && ctx.lastObj && !ctx.triggerHasObject && !ctx.triggerHasPlayer) return { kind: 'countRef', ref: ctx.lastObj as Ref } as Amount;
  const hm = text.trim().match(/^the number of cards in (target (?:player|opponent))'s (hand|graveyard)$/i);
  if (hm) {
    const who = playerRef(hm[1], ctx);
    if (who) return (hm[2].toLowerCase() === 'hand' ? { kind: 'handSize', ref: who } : { kind: 'graveyardSize', ref: who }) as Amount;
  }
  return parseAmount(text, { self: SELF, difference: ctx.difference, boundX: ctx.boundX, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer, resolvePlayer: (p) => playerRef(p, ctx) });
}

/** "for each X": a count of matching objects, or any other amount phrase. */
function perEach(phrase: string, ctx: ParseCtx): Amount | null {
  // "each Aura and Equipment attached to it": the trailing qualifier belongs to both nouns,
  // so let the amount parser see the whole phrase before splitting on "and".
  if (/ attached to (?:it|~|that creature|that permanent)$/i.test(phrase)) {
    const whole = amt(phrase, ctx);
    if (whole) return whole;
  }
  const both = phrase.match(/^(.+?) and (?:each |for each )?(.+)$/i);
  if (both && !/\b(and|or)\b/i.test(both[1])) {
    const a = perEach(both[1], ctx);
    const b = a ? perEach(both[2], ctx) : null;
    if (a && b) return { kind: 'sum', parts: [a, b] };
  }
  // "for each card discarded this way" / "for each creature sacrificed this way": what this ability just moved.
  {
    const tw = phrase.match(/^(?:card|creature|permanent|land|artifact|token)s? (discarded|sacrificed|exiled|destroyed|milled|returned|put into a graveyard|put into your graveyard) this way$/i);
    if (tw) return /^discarded$/i.test(tw[1]) ? { kind: 'ctxMemory', key: 'discardedCount' } : /^destroyed$/i.test(tw[1]) ? { kind: 'ctxMemory', key: 'destroyedThisWay' } : { kind: 'countRef', ref: { ref: 'lastMoved' } };
  }
  const noun = parseNoun(phrase);
  if (noun && noun.kind !== 'player') {
    const f: ObjectFilter = noun.filter.zone ? { ...noun.filter } : { ...noun.filter, zone: 'battlefield' };
    if (noun.controllerPhrase) {
      const pr = playerRef(noun.controllerPhrase, ctx);
      if (!pr) return null;
      f.controllerRef = pr;
    }
    return { kind: 'count', filter: f };
  }
  return amt(`the number of ${phrase}`, ctx) ?? amt(phrase, ctx);
}

/** Subject-verb helpers */
function subjectPlayer(subj: string | undefined, ctx: ParseCtx): Ref | null {
  if (subj === undefined || subj.trim() === '') return ctx.lastPlayer ?? YOU;
  const who = playerRef(subj, ctx);
  if (who && who.ref !== 'controller') ctx.lastPlayer = who;
  return who;
}


const DEST_RE = String.raw`(into (?:your|their|that player's|its owner's) hand|into (?:your|their|that player's|its owner's) graveyard|onto the battlefield(?: tapped)?(?: and attacking)?(?: under your control)?|on the bottom of (?:your|their|that player's|that) library(?: in (?:a random|any) order)?|(?:back )?on top of (?:your|their|that player's|that) library(?: in any order)?|into exile)`;
/** Effects that move a chosen ref to a destination phrase (see DEST_RE). */
function moveChosen(ref: Ref, dest: string): Effect | null {
  const d = dest.toLowerCase();
  if (/^into [\w' ]*hand$/.test(d)) return { kind: 'putIntoHand', what: ref };
  if (/^into [\w' ]*graveyard$/.test(d)) return { kind: 'moveToZone', what: ref, zone: 'graveyard' };
  if (/^onto the battlefield/.test(d)) return { kind: 'returnToBattlefield', what: ref, tapped: /tapped/.test(d), attacking: /attacking/.test(d) || undefined };
  if (/^on the bottom/.test(d)) return { kind: 'putOnLibrary', what: ref, position: 'bottom' };
  if (/^(?:back )?on top/.test(d)) return { kind: 'putOnLibrary', what: ref, position: 'top' };
  if (/^into exile$/.test(d)) return { kind: 'exile', what: ref };
  return null;
}
function restDest(dest: string): Extract<Effect, { kind: 'moveRest' }>['to'] | null {
  const d = dest.toLowerCase();
  if (/^into [\w' ]*hand$/.test(d)) return 'hand';
  if (/^into [\w' ]*graveyard$/.test(d)) return 'graveyard';
  if (/^on the bottom/.test(d)) return /random/.test(d) ? 'bottomRandom' : 'bottom';
  if (/^(?:back )?on top/.test(d)) return 'top';
  if (/^into exile$/.test(d) || d === 'exile') return 'exile';
  return null;
}
/** Follow-up clauses after "Look at the top N cards of your library" (the pool is remembered under ctx.restKey). */
/** The pool that "them" / "the rest" refers to: a held look/search pool, else the cards just moved. */
function poolRef(ctx: ParseCtx): Ref {
  // In a "whenever one or more … " trigger with nothing looked at or moved yet, "them" is the batch itself
  // (Colossal Grave-Reaver: "put one of them onto the battlefield").
  return ctx.restKey ? { ref: 'chosen', key: ctx.restKey } : ctx.triggerBatch && !ctx.lastObj ? { ref: 'triggerObjects' } : { ref: 'lastMoved' };
}

const POOL_PATTERNS: Pattern[] = [
  // "Put the revealed cards on the bottom of your library in a random order" / "exile all other cards revealed this way"
  [new RegExp(String.raw`^(?:then )?(?:and )?(?:put|exile) (?:the revealed cards|all other cards revealed this way|all cards revealed this way|the other cards revealed this way|the rest of the revealed cards)(?: ${DEST_RE})?$`, 'i'), (m, ctx) => {
    if (!ctx.restKey) return null;
    const to = restDest(m[1] ?? 'into exile');
    return to ? [{ kind: 'moveRest', key: ctx.restKey, to }] : null;
  }],
  // "Put the nonland cards revealed this way into your hand" (the matches held by a reveal-until)
  [new RegExp(String.raw`^(?:you may )?put (?:those|the) ((?!rest\b)[\w -]+?) (?:cards? )?(?:revealed this way |from among them )?${DEST_RE}$`, 'i'), (m, ctx) => {
    if (!ctx.restKey) return null;
    const mv = moveChosen({ ref: 'chosen', key: ctx.restKey }, m[2]);
    return mv ? [mv] : null;
  }],
  // "Put one of them into your hand (and the rest on the bottom of your library in a random order)"
  [new RegExp(String.raw`^(you may )?(put|exile) (one|the other|(\w+)|up to (\w+)|any number|all|the rest)(?: of (?:them|those cards))?( face down)?(?: ${DEST_RE})?(?: and (?:put )?the rest ${DEST_RE})?$`, 'i'), (m, ctx) => {
    const pool: Ref = poolRef(ctx);
    const out: Effect[] = [];
    const isRest = /^(all|the rest)$/i.test(m[3]);
    const faceDown = !!m[6];
    const dest = m[2].toLowerCase() === 'exile' ? 'into exile' : m[7];
    if (!dest) return null;
    if (isRest) {
      const to = restDest(dest);
      if (!to) return null;
      out.push({ kind: 'moveRest', key: ctx.restKey ?? 'lastMoved', to });
    } else {
      const n = /^(one|the other)$/i.test(m[3]) ? 1 : m[4] ? wordToNumber(m[4]) : m[5] ? wordToNumber(m[5]) : 'X';
      if (n === null) return null;
      const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
      const anyNumber = /^any number$/i.test(m[3]);
      out.push({ kind: 'chooseObjects', from: pool, filter: {}, count: anyNumber ? 99 : n, key, upTo: !!m[1] || !!m[5] || anyNumber });
      const mv = moveChosen({ ref: 'chosen', key }, dest);
      if (!mv) return null;
      out.push(faceDown && mv.kind === 'exile' ? { ...mv, faceDown: true } : mv);
      ctx.lastObj = { ref: 'chosen', key };
    }
    if (m[8]) {
      const to = restDest(m[8]);
      if (!to) return null;
      out.push({ kind: 'moveRest', key: ctx.restKey ?? 'lastMoved', to });
    }
    return out;
  }],
  // "You may reveal a creature card from among them and put it into your hand" / "Put all land cards revealed this way onto the battlefield tapped"
  [new RegExp(String.raw`^(you may )?(reveal|put|exile) (a|an|all|up to (\w+)|any number of|(\w+)) (.+?) (?:from among (?:them|those cards)|revealed this way|milled this way|from among the revealed cards|from among the cards milled this way)(?:,? and put (?:it|them|that card|those cards) ${DEST_RE}| ${DEST_RE})?(?: and (?:put )?the rest ${DEST_RE})?$`, 'i'), (m, ctx) => {
    const pool: Ref = poolRef(ctx);
    const phrase = /\bcards?\b/i.test(m[6]) ? m[6].replace(/\bcards\b/i, 'card') : `${m[6]} card`;
    const noun = parseNoun(`a ${phrase}`);
    if (!noun) return null;
    const all = /^(all|any number of)$/i.test(m[3]);
    const n = /^(a|an)$/i.test(m[3]) ? 1 : m[4] ? wordToNumber(m[4]) : m[5] ? wordToNumber(m[5]) : 99;
    if (n === null) return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const out: Effect[] = [{ kind: 'chooseObjects', from: pool, filter: noun.filter, count: all ? 99 : n, key, upTo: !!m[1] || !!m[4] || /any number/i.test(m[3]) }];
    const dest = m[2].toLowerCase() === 'exile' ? 'into exile' : m[7] ?? m[8];
    if (dest) {
      const mv = moveChosen({ ref: 'chosen', key }, dest);
      if (!mv) return null;
      out.push(mv);
    } else if (m[2].toLowerCase() === 'put') return null;
    ctx.lastObj = { ref: 'chosen', key };
    if (m[9]) {
      const to = restDest(m[9]);
      if (!to) return null;
      out.push({ kind: 'moveRest', key: ctx.restKey ?? 'lastMoved', to });
    }
    return out;
  }],
  // "Put the rest on the bottom of your library in a random order" / "Exile the rest" / "and the rest into your graveyard"
  [new RegExp(String.raw`^(?:then )?(?:and )?(?:put )?the rest(?: of (?:the|those) cards)? ${DEST_RE}$|^(?:then )?exile the rest(?: of (?:the|those) cards)?$|^(?:then )?put the rest(?: of (?:the|those) cards)? into exile$`, 'i'), (m, ctx) => {
    if (!ctx.restKey) return null;
    const to = restDest(m[1] ?? 'exile');
    return to ? [{ kind: 'moveRest', key: ctx.restKey, to }] : null;
  }],
  // "Look at the top five cards of your library, put one of them into your hand, and exile the rest" / bare "Look at the top N cards of your library"
  [/^(look at|reveal) the top (\w+|X) cards? of (your|target opponent's|target player's|that player's|an opponent's|that opponent's|their) library(?:, where X is (.+?))?(?:, (.+))?$/i, (m, ctx) => {
    const n = m[2] === 'X' ? 'X' : wordToNumber(m[2]);
    if (n === null) return null;
    let amount: Amount = n;
    if (m[4]) {
      const a = amt(m[4], ctx);
      if (!a) return null;
      amount = a;
    }
    const whose = /^your$/i.test(m[3]) ? null : playerRef(m[3].replace(/'s$/, ''), ctx);
    if (!/^your$/i.test(m[3]) && !whose) return null;
    const key = `looked${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.restKey = key;
    ctx.lastObj = { ref: 'chosen', key };
    const out: Effect[] = [{ kind: 'lookAtTop', amount, then: 'hold', key, reveal: /^reveal/i.test(m[1]), ...(whose ? { who: whose, looker: YOU } : {}) }];
    if (m[5]) {
      for (const clause of m[5].split(/, (?:and |then )?|,? and then |,? then /i)) {
        const r = parseSentence(clause, ctx);
        if (!r) return null;
        out.push(...r);
      }
    }
    return out;
  }],
];


/** "up to two basic land cards" / "a creature card" / "three cards" → count and filter for a library search. */
function searchTarget(phrase: string, ctx: ParseCtx): { count: Amount; upTo: boolean; filter: ObjectFilter } | null {
  let t = phrase.trim().replace(/[.,]$/, '').replace(/ that each have different names$/i, ' with different names');
  let upTo = false;
  let count: Amount = 1;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^up to (that many|X|\w+) (.+)$/i))) {
    upTo = true;
    const n = /that many/i.test(m[1]) ? 'X' : m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    if (n === null) return null;
    count = n;
    t = m[2];
  } else if ((m = t.match(/^(?:a|an) (.+)$/i))) {
    t = m[1];
  } else if ((m = t.match(/^any number of (.+)$/i))) {
    count = 99;
    upTo = true;
    t = m[1];
  } else if ((m = t.match(/^(X|\w+) (.+)$/i)) && (m[1].toUpperCase() === 'X' || typeof wordToNumber(m[1]) === 'number')) {
    count = m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as number);
    t = m[2];
  }
  const noun = parseNoun(/\bcards?\b/i.test(t) ? t.replace(/\bcards\b/i, 'card') : `${singularize(t)} card`);
  if (!noun) return null;
  const filter: ObjectFilter = { ...noun.filter, zone: 'library' };
  if (noun.controllerPhrase) {
    const pr = playerRef(noun.controllerPhrase, ctx);
    if (!pr) return null;
    filter.controllerRef = pr;
  }
  return { count, upTo, filter };
}

/** Library searches whose destination comes in a later sentence ("Search your library for two cards and reveal them. Put one ..."). */
const SEARCH_PATTERNS: Pattern[] = [
  [/^search (your|their|that player's|target player's|target opponent's) library for (.+?)(?:,? and reveal (?:it|them|those cards)| and reveal them)?(?:, then shuffle| and shuffle|,? then shuffle your library)?$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx);
    if (!who) return null;
    const tgt = searchTarget(m[2], ctx);
    if (!tgt) return null;
    const key = `searched${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.restKey = key;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'searchLibrary', who: who.ref === 'controller' ? undefined : who, filter: tgt.filter, count: tgt.count, destination: 'hold', key, reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
];


/** "Reveal cards from the top of your library until you reveal a nonland card" — the destination may come later. */
const REVEAL_UNTIL_PATTERNS: Pattern[] = [
  [/^reveal cards from the top of your library until you reveal (?:(?:a|an) |(X|\w+) )?(.+?)(?:, where X is (.+?))?$/i, (m, ctx) => {
    const plural = /^(?:X|two|three|four|five|\w+)$/i.test(m[1] ?? '') && !!m[1];
    let count: Amount = 1;
    if (plural) {
      const n = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
      if (n === null) return null;
      count = n;
    }
    // "a Doctor card, a card with doctor's companion, or a Vehicle card" → any of these
    const alts = m[2].split(/,\s*(?:or\s+)?|\s+or\s+/i).map((x) => x.trim().replace(/^(?:a|an) /i, '')).filter(Boolean);
    const filters: ObjectFilter[] = [];
    for (const a of alts) {
      const noun = parseNoun(/\bcards?\b/i.test(a) ? a.replace(/\bcards\b/i, 'card') : `${singularize(a)} card`);
      if (!noun) return null;
      filters.push({ ...noun.filter, zone: undefined });
    }
    const filter: ObjectFilter = filters.length === 1 ? filters[0] : { anyOf: filters };
    if (m[3]) {
      const a = amt(m[3], ctx);
      if (a === null) return null;
      count = a;
    }
    const key = `revealed${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.restKey = key;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'revealUntil', filter, destination: 'hold', rest: 'bottom', count: plural || m[3] ? count : undefined, key }];
  }],
];

const PATTERNS: Pattern[] = [
  // Scion of the Ur-Dragon: "~ becomes a copy of that card until end of turn"
  [/^(~|it|that creature) becomes a copy of (that card|that creature|it|the exiled card|the chosen card|the revealed card) until end of turn(?:, except (.+))?$/i, (m, ctx) => {
    const what = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx);
    const of = ctx.lastObj ?? { ref: 'lastMoved' as const };
    // Vesuvan Drifter: "…, except it has flying"
    const ex = m[3] ? parseCopyExceptions(m[3]) : undefined;
    if (m[3] && !ex) return null;
    return what ? [{ kind: 'becomeCopy', what, of, exceptions: ex ?? undefined, duration: 'endOfTurn' }] : null;
  }],
  [/^each (.+?) deals (?:(\d+|X) damage|damage equal to its (power|toughness)) to (?:its|their) controller$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const amount: Amount = m[2] ? (m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10)) : { kind: m[3].toLowerCase() as 'power' | 'toughness', ref: { ref: 'iter' } };
    return [{ kind: 'forEach', over: { ref: 'all', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } }, effects: [{ kind: 'damage', amount, to: { ref: 'controllerOf', of: { ref: 'iter' } }, source: { ref: 'iter' } }] }];
  }],
  // "Until your next turn, you may cast sorcery spells as though they had flash." (Teferi, Time Raveler)
  [/^(?:(?:until your next turn|until end of turn|this turn), )?you may cast (.+?) as though (?:they|it) had flash(?: until end of turn| this turn)?$/i, (m) => {
    // "until your next turn" is retimed by the caller from the endOfTurn marker.
    const duration: Duration = /^until your next turn/i.test(m[0]) ? 'untilYourNextTurn' : 'endOfTurn';
    if (/^spells$/i.test(m[1])) return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash' }, duration }];
    const parts = m[1].split(/ and /i).map((x) => parseNoun(x.replace(/ spells?$/i, ' spell')));
    if (!parts.every((x) => x)) return null;
    const f = parts.length === 1 ? { ...parts[0]!.filter, zone: undefined } : { anyOf: parts.map((x) => ({ ...x!.filter, zone: undefined })) };
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: f } }, duration }];
  }],
  // Voting: "Starting with you, each player votes for death or taxes."
  [/^(?:starting with you, )?each player (?:secretly )?votes for (.+?)(?:, then those votes are revealed)?$/i, (m, ctx) => {
    const list = m[1];
    // "a nonland permanent you don't control" / "an artifact, creature, or enchantment card in your graveyard"
    const noun = parseNoun(list);
    if (noun && !noun.target) {
      const f: ObjectFilter = { ...noun.filter };
      if (!f.zone) f.zone = 'battlefield';
      if (noun.controllerPhrase) {
        const pr = playerRef(noun.controllerPhrase, ctx);
        if (!pr) return null;
        f.controllerRef = pr;
      }
      ctx.lastObj = { ref: 'chosen', key: 'votes' };
      return [{ kind: 'voteObjects', filter: f, key: 'votes' }];
    }
    const options = list.split(/,\s*(?:or\s+)?|\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
    if (options.length < 2 || options.some((o) => !/^[\w' -]+$/.test(o))) return null;
    return [{ kind: 'vote', options }];
  }],
  // "For each death vote, each opponent sacrifices a creature."
  [/^for each ([\w' -]+?) vote, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[2], ctx);
    return inner ? [{ kind: 'repeat', times: { kind: 'voteCount', option: m[1].toLowerCase() }, effects: inner }] : null;
  }],
  // "If dominion gets more votes, the Ring tempts you."
  [/^if ([\w' -]+?) gets? more votes, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[2], ctx);
    return inner ? [{ kind: 'conditional', if: { kind: 'voteMost', option: m[1].toLowerCase() }, then: inner }] : null;
  }],
  // "You and target opponent each draw two cards" → for each of those players
  [/^you and (target opponent|target player|that player|each opponent|each other player|the chosen player|defending player) each (\w+) (.+)$/i, (m, ctx) => {
    const other = playerRef(m[1], ctx);
    if (!other) return null;
    const verb = m[2].toLowerCase();
    const third = /(ch|sh|s|x|z)$/.test(verb) ? `${verb}es` : verb === 'may' ? 'may' : `${verb}s`;
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(`that player ${third} ${m[3]}`, sub);
    if (!inner) return null;
    ctx.lastPlayer = other;
    return [{ kind: 'forEach', over: { ref: 'players', of: [YOU, other] }, effects: inner }];
  }],
  // Draw
  [/^(?:(.+?) )?draws? (?:(\w+|X) cards?|a card)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    if (!who) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    return [{ kind: 'draw', amount: n, who }];
  }],
  [/^(?:(.+?) )?draws? ((?:twice |half )?that many cards(?: minus one| plus one)?)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const base: Amount = { kind: 'discardedThisWay', ref: { ref: 'iter' } };
    const a = /minus one/i.test(m[2]) ? amt(m[2], ctx) : /plus one/i.test(m[2]) ? ({ kind: 'sum', parts: [base, 1] } as Amount) : /^twice /i.test(m[2]) ? ({ kind: 'times', a: base, b: 2 } as Amount) : /^half /i.test(m[2]) ? ({ kind: 'half', a: base, round: 'down' } as Amount) : base;
    return who && a !== null ? [{ kind: 'draw', amount: a, who }] : null;
  }],
  [/^(?:(.+?) )?draws? cards equal to (.+)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    const a = amt(m[2], ctx);
    return who && a !== null ? [{ kind: 'draw', amount: a, who }] : null;
  }],
  // Life
  [/^(?:(.+?) )?(gains?|loses?) (\w+|X) life$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[3]);
    if (!who || n === null) return null;
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: n, who } as Effect];
  }],
  [/^(?:(.+?) )?(gains?|loses?) life equal to (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = amt(m[3], ctx);
    if (!who || a === null) return null;
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: a, who } as Effect];
  }],
  [/^(?:(.+?) )?(gains?|loses?) (\w+|X) life for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[3]);
    if (!who || n === null) return null;
    const per = perEach(m[4].replace(/^of /i, ''), ctx);
    if (per === null) return null;
    return [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: { kind: 'times', a: n, b: per }, who } as Effect];
  }],
  [/^(?:(.+?) )?discards? a card for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const per: Amount | null = perEach(m[2], ctx);
    return who && per !== null ? [{ kind: 'discard', amount: per, who }] : null;
  }],
  [/^(?:(.+?) )?reveals? (?:their|your) hand and discards? all (.+?) cards$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    return who && noun ? [{ kind: 'revealHand', who }, { kind: 'discard', amount: 'hand', who, filter: noun.filter }] : null;
  }],
  [/^(?:(.+?) )?exiles? (?:a|an|(\w+)) (?:(.+?) )?cards? from (?:their|your) (graveyard|hand)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    const noun = m[3] ? parseNoun(`a ${m[3]} card`) : { filter: {} as ObjectFilter };
    if (!who || n === null || !noun) return null;
    const key = `exiled${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: m[4] as 'graveyard' | 'hand' }, owner: who, count: n, key }, { kind: 'exile', what: { ref: 'chosen', key } }];
  }],
  [/^(?:(.+?) )?mills? half (?:their|your) library(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'mill', amount: { kind: 'half', a: { kind: 'librarySize', ref: who }, round: m[2] === 'up' ? 'up' : 'down' }, who }] : null;
  }],
  [/^look at (.+?)'s hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'revealHand', who }] : null;
  }],
  [/^put a number of ([+-]\d\/[+-]\d|\w+) counters on (.+?) equal to (.+)$/i, (m, ctx) => {
    // "on ~ equal to that spell's mana value / half that card's mana value": the amount refers to what came before,
    // unless it says "its", which is the thing getting the counters.
    const itsAmt = /^(?:half )?its\b/i.test(m[3]);
    // "on each other creature you control equal to that creature's toughness": one amount per creature.
    if (/^each /i.test(m[2]) && /^(?:half )?(?:its|that (?:creature|permanent)'s)\b/i.test(m[3])) {
      const noun = parseNoun(`a ${singularize(m[2].replace(/^each /i, ''))}`);
      if (noun && noun.confident && !noun.target) {
        const sub = newCtx({ ...ctx, targets: ctx.targets });
        sub.lastObj = { ref: 'iter' };
        const a = amt(m[3], sub);
        if (a !== null) return [{ kind: 'forEach', over: { ref: 'all', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } }, effects: [{ kind: 'addCounters', counter: m[1], amount: a, on: { ref: 'iter' } }] }];
      }
    }
    let a: Amount | null = itsAmt ? null : amt(m[3], ctx);
    const ref = objRef(m[2], ctx);
    if (itsAmt && ref) a = amt(m[3], ctx);
    return ref && a !== null ? [{ kind: 'addCounters', counter: m[1], amount: a, on: ref }] : null;
  }],
  [/^(.+?) reveals cards from the top of their library until (?:they reveal|revealing) (?:a|an) (.+?) card\.? (?:put|that player puts|they put) (?:that card|it) (into their hand|onto the battlefield( tapped)?|into their graveyard)(?: and (?:put )?the rest|\. put the rest| and the rest) (on the bottom of their library in (?:a random|any) order|into their graveyard)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    if (!who || !noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealUntil', who, filter: noun.filter, destination: /hand/.test(m[3]) ? 'hand' : /battlefield/.test(m[3]) ? 'battlefield' : 'graveyard', tapped: !!m[4], rest: /graveyard/.test(m[5]) ? 'graveyard' : 'bottom' }];
  }],
  [/^(?:(.+?) )?exiles? cards from the top of (?:their|your) library until (?:they|you) exile (?:a|an) (.+?) card$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    if (!who || !noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealUntil', who, filter: noun.filter, destination: 'exile', rest: 'exile' }];
  }],
  [/^(?:(.+?) )?(gains?|loses?) life equal to (.+?)(?:, but not more life than .+)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = amt(m[3], ctx);
    return who && a !== null ? [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: a, who } as Effect] : null;
  }],
  [/^(?:(.+?) )?(gains?|loses?) that much life$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: /gain/i.test(m[2]) ? 'gainLife' : 'loseLife', amount: { kind: 'triggerAmount' }, who } as Effect] : null;
  }],
  [/^(?:(.+?) )?loses? half (?:their|your) life(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'loseLife', amount: { kind: 'half', a: { kind: 'life', ref: who }, round: m[2] === 'down' ? 'down' : 'up' }, who }] : null;
  }],
  [/^(?:(.+?) )?loses? (\w+) life for each card fewer than (\w+) in (?:their|your) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const per = wordToNumber(m[2]);
    const lim = wordToNumber(m[3]);
    if (!who || typeof per !== 'number' || typeof lim !== 'number') return null;
    return [{ kind: 'loseLife', who, amount: { kind: 'times', a: per, b: { kind: 'max', a: { kind: 'sum', parts: [lim, { kind: 'times', a: { kind: 'handSize', ref: who }, b: -1 }] }, b: 0 } } }];
  }],
  [/^move (?:a|an|(\w+|X)) ([+-]\d\/[+-]\d|\w+) counters? from (.+?) onto (.+)$/i, (m, ctx) => {
    const from = objRef(m[3], ctx);
    const to = from ? objRef(m[4], ctx) : null;
    if (!from || !to) return null;
    const n = m[1] ? (m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1])) : 1;
    if (n === null) return null;
    return [{ kind: 'moveCounters', from, to, counter: m[2] as import('@commander/engine').CounterType, amount: n as Amount }];
  }],
  [/^flip (~|it)$/i, () => [{ kind: 'transform', what: SELF }]],
  [/^convert (~|it|that creature|target creature)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'transform', what: ref }] : null;
  }],
  [/^(.+?) reveals (\w+) cards? from their hand and you choose one of them$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    const key = `revealed${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key: `${key}pick` };
    return [{ kind: 'chooseObjects', who, filter: { zone: 'hand' }, owner: who, count: n, key }, { kind: 'chooseObjects', who: YOU, filter: {}, from: { ref: 'chosen', key }, count: 1, key: `${key}pick` }];
  }],
  [/^look at (.+?)'s hand and choose (\w+|X) cards? from it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    const key = `looked${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'revealHand', who }, { kind: 'chooseObjects', who: YOU, filter: { zone: 'hand' }, owner: who, count: n, key }];
  }],
  [/^(?:that player|they) discards? those cards$/i, (m, ctx) => (ctx.lastObj ? [{ kind: 'discardObjects', what: ctx.lastObj }] : null)],
  [/^(?:(.+?) )?discovers? (\w+)$/i, (m, ctx) => {
    if (m[1] && !/^(?:you|they|that player|each player|each opponent|target player|target opponent|its controller)$/i.test(m[1])) return null;
    const n1 = m[2].toUpperCase() === 'X' ? 'X' : wordToNumber(m[2]);
    if (n1 === null) return null;
    void ctx;
    return [{ kind: 'discover', amount: n1 as Amount }];
  }],
  [/^discover (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'discover', amount: n }];
  }],
  [/^incubate (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'createToken', token: { name: 'Incubator', typeLine: 'Artifact — Incubator', colors: [], preset: 'Incubator' }, count: 1 }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'lastCreated' } }];
  }],
  [/^damage cannot be prevented this turn$/i, () => [{ kind: 'turnFlag', flag: 'noPrevention' }]],
  [/^(?:(.+?) )?shuffles? (?:their|your) graveyard into (?:their|your) library$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'library' }, { kind: 'shuffle', who }] : null;
  }],
  [/^reveal cards from the top of your library until you reveal (?:a|an) (.+?) card\.? (?:put|you may put) (?:that card|it) (into your hand|onto the battlefield( tapped)?|into your graveyard)(?: and (?:put )?the rest|\. put the rest| and the rest) (on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealUntil', filter: noun.filter, destination: /hand/.test(m[2]) ? 'hand' : /battlefield/.test(m[2]) ? 'battlefield' : 'graveyard', tapped: !!m[3], rest: /graveyard/.test(m[4]) ? 'graveyard' : 'bottom' }];
  }],
  [/^(.+?) deals damage to itself equal to its power$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'dealsDamageEqualToPower', source: ref, to: ref }] : null;
  }],
  [/^(.+?) cannot block ~ this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantBlockSource', data: '__self__' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) blocks (?:~|it) this (?:turn|combat) if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlock', data: '__self__' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(?:all creatures able to block (.+?) this turn do so|(.+?) must be blocked this turn if able)$/i, (m, ctx) => {
    const ref = objRef(m[1] ?? m[2], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: m[1] ? 'lure' : 'mustBeBlocked' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) can attack this turn as though (?:it|they) did not have defender$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(?:they|it|those tokens|that token) (?:have|has) "(.+)"$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? { ref: 'lastCreated' as const };
    return [{ kind: 'grantAbility', text: m[1], on: ref, duration: 'permanent' }];
  }],
  [/^you get an emblem with "(.+?)"?$/i, (m) => [{ kind: 'emblem', text: m[1] }]],
  [/^(.+?) gets an emblem with "(.+)"$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'emblem', text: m[2], who }] : null;
  }],
  [/^amass (\w+) (\w+)$/i, (m) => {
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    const type = m[1];
    return [{ kind: 'conditional', if: { kind: 'count', filter: { subtypes: ['Army'], controller: 'you', zone: 'battlefield' }, op: '>=', value: 1 }, then: [{ kind: 'chooseObjects', filter: { subtypes: ['Army'], controller: 'you', zone: 'battlefield' }, count: 1, key: 'army' }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'chosen', key: 'army' } }], else: [{ kind: 'createToken', token: { name: `${type} Army`, typeLine: `Creature — ${type} Army`, power: '0', toughness: '0', colors: ['B'] }, count: 1 }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'lastCreated' } }] }];
  }],
  [/^bolster (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'chooseObjects', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield', lowestToughness: true }, count: 1, key: 'bolster' }, { kind: 'addCounters', counter: '+1/+1', amount: n, on: { ref: 'chosen', key: 'bolster' } }];
  }],
  [/^if (that creature|that creature or planeswalker|it|those creatures|that permanent) would die this turn, exile it instead$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^if a creature dealt damage this way would die this turn, exile it instead$/i, () => [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  [/^look at the top (?:card|(\w+|X) cards) of (.+?)'s library(?:, then put them back in any order| in any order)?$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!who || n === null) return null;
    // The imperative form is the ability's controller looking, whoever owns the library.
    if (/in any order/i.test(m[0])) return [{ kind: 'lookAtTop', amount: n, who, looker: YOU, then: 'reorder' }];
    ctx.lastObj = { ref: 'memory', key: 'looked' };
    return [{ kind: 'lookAtTop', amount: n, who, looker: YOU, then: 'hold', key: 'looked' }];
  }],
  [/^(?:until end of turn, )?(.+?) gains? (.+?) and gets? ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    if (!kws || !ref) return null;
    const p = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[3], 10);
    const t = m[4].toUpperCase().includes('X') ? (m[4].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[4], 10);
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }, { kind: 'pump', power: p, toughness: t, on: ref, duration: 'endOfTurn' }];
  }],
  [/^reveal the top (\w+|X) cards of your library\.? (?:put|you may put) (all|any number of|a|an|up to (\w+)) (.+?) cards? (?:revealed this way |from among them )?(into your hand|onto the battlefield( tapped)?)(?:,| and|\.)(?: put)? the rest (on the bottom of your library in (?:a random|any) order|into your graveyard|on top of your library in any order)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[4]} card`);
    if (n === null || !noun) return null;
    const pick = m[3] ? wordToNumber(m[3]) : /^(all|any number)/i.test(m[2]) ? n : 1;
    if (pick === null) return null;
    const rest = /graveyard/.test(m[7]) ? 'Graveyard' : /bottom/.test(m[7]) ? 'Bottom' : 'Top';
    if (/battlefield/.test(m[5]) && rest !== 'Bottom') return null;
    const then = /battlefield/.test(m[5]) ? 'battlefieldRestBottom' : (`handRest${rest}` as 'handRestBottom' | 'handRestGraveyard' | 'handRestTop');
    return [{ kind: 'lookAtTop', amount: n, then, filter: noun.filter, pick }];
  }],
  [/^exile all graveyards$/i, () => [{ kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'exile' }]],
  [/^exile (.+?)'s graveyard$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'exile' }] : null;
  }],
  [/^(?:(.+?) )?exiles? (?:their|your) graveyard$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'graveyard', to: 'exile' }] : null;
  }],
  [/^(.+?) gains? control of (.+?)( until end of turn)?$/i, (m, ctx) => {
    if (/^(?:you|an opponent)$/i.test(m[1])) return null;
    const who = playerRef(m[1], ctx);
    const ref = who ? objRef(m[2], ctx) : null;
    return who && ref ? [{ kind: 'gainControl', what: ref, who, duration: m[3] ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^(.+?) chooses? (?:a|an|target) (.+?) (?:they|that player) controls?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = who ? parseNoun(`a ${m[2]}`) : null;
    if (!who || !noun) return null;
    const key = `chosen${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: 1, key }];
  }],
  [/^an opponent gains control of (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }, { kind: 'gainControl', what: ref, who: { ref: 'chosen', key: 'opponent' } }] : null;
  }],
  [/^choose an opponent$/i, (_m, ctx) => {
    ctx.lastPlayer = { ref: 'chosen', key: 'opponent' };
    return [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }];
  }],
  // Baleful Mastery: "an opponent draws a card" — you choose which opponent.
  [/^an opponent (draws? .+|discards? .+|gains? \d+ life|loses? \d+ life)$/i, (m, ctx) => {
    const key = `opp_${Math.random().toString(36).slice(2, 6)}`;
    const who: Ref = { ref: 'chosen', key };
    const saved = ctx.lastPlayer;
    ctx.lastPlayer = who;
    const inner = parseSentence(`that player ${m[1]}`, ctx);
    if (!inner) {
      ctx.lastPlayer = saved;
      return null;
    }
    return [{ kind: 'choosePlayer', key, who: 'opponent' }, ...inner];
  }],
  [/^choose a nonland card name$/i, () => [{ kind: 'nameCard', key: 'cardName' }]],
  [/^switch (.+?)'s power and toughness(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'switchPT', on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^you may tap or untap (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'chooseMode', options: [{ text: 'Tap it', effects: [{ kind: 'tap', what: ref }] }, { text: 'Untap it', effects: [{ kind: 'untap', what: ref }] }, { text: 'Do nothing', effects: [] }] }] : null;
  }],
  [/^(.+?) attacks? this turn if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^you may play an additional land this turn$/i, () => [{ kind: 'extraLandThisTurn' }]],
  [/^(.+?) (?:does|do) not untap during (?:(?:its|their) controller'?s'?|the player's|that player's|your) next untap step$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilNextUntap' }] : null;
  }],
  [/^(.+?) (?:does not|do not|doesn't|don't) untap during (?:your|its controller's|their controllers'|their controller's) next untap steps?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilNextUntap' }] : null;
  }],
  [/^for each (?:permanent|creature|card|land|artifact|enchantment|nonland permanent) (?:put into a graveyard|destroyed|exiled|sacrificed) this way, its (controller|owner) creates? (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(m[2]);
    if (!t) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    const who: Ref = m[1].toLowerCase() === 'owner' ? { ref: 'ownerOf', of: { ref: 'iter' } } : { ref: 'controllerOf', of: { ref: 'iter' } };
    return [{ kind: 'forEach', over: { ref: 'lastMoved' }, effects: [{ kind: 'createToken', token: t.token, count: t.count, tapped: t.tapped, attacking: t.attacking, who }] }];
  }],
  [/^for each (.+?) card put into (?:a|your|their) graveyard this way, (?:you )?create (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    const t = parseTokenPhrase(m[2]);
    if (!noun || !t) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: { kind: 'countRef', ref: { ref: 'lastMoved' }, filter: noun.filter }, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^(?:until end of turn, )?(.+?) gains? "(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'grantAbility', text: m[2], on: ref, duration: /until end of turn/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^(.+?) gains? "(.+)" for as long as (.+)$/i, () => null],
  // "It gains \"At the beginning of your end step, return ~ to its owner's hand.\" Then put the rest ..."
  [/^(.+?) (?:gains?|has) "(.+?)"\.? (?:Then |then )?(.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const saved = ctx.targets.length;
    const rest = parseSentence(m[3].replace(/^[a-z]/, (c) => c), ctx) ?? parseSentence(m[3].replace(/^./, (c) => c.toLowerCase()), ctx);
    if (!rest) {
      ctx.targets.length = saved;
      return null;
    }
    return [{ kind: 'grantAbility', text: m[2], on: ref, duration: 'permanent' }, ...rest];
  }],
  [/^adapt (\w+)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'conditional', if: { kind: 'not', c: { kind: 'hasCounter', ref: SELF, counter: '+1/+1' } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: n, on: SELF }] }];
  }],
  [/^support (\w+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `up to ${n} other target creatures`, kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], other: true }, min: 0, max: n });
    return [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^(?:it|~|that creature|this creature) connives?$/i, () => [{ kind: 'log', text: 'connives', event: 'connived', objectRef: SELF }, { kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }, { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'chosen', key: 'lastDiscarded' }, filter: { nonland: true } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: SELF }] }]],
  [/^(.+?) connives?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'log', text: 'connives', event: 'connived', objectRef: ref }, { kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }, { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'chosen', key: 'lastDiscarded' }, filter: { nonland: true } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }] }] : null;
  }],
  // Damage
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals (\w+|X) damage to (.+?)(?: for each (.+))?$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    if (!src) return null;
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    let amount: Amount = n;
    if (m[4]) {
      const per = perEach(m[4], ctx);
      if (!per) return null;
      amount = { kind: 'times', a: n, b: per };
    }
    return damageTo(m[3], amount, ctx, src);
  }],
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals that much damage to (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    return src ? damageTo(m[2], { kind: 'triggerAmount' }, ctx, src) : null;
  }],
  [/^(~|it|that creature|enchanted creature|equipped creature|.+?) deals (\w+|X) damage to (.+?) and (\w+|X) damage to (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    const n1 = wordToNumber(m[2]);
    const n2 = wordToNumber(m[4]);
    if (!src || n1 === null || n2 === null) return null;
    const a = damageTo(m[3], n1, ctx, src);
    const b = damageTo(m[5], n2, ctx, src);
    return a && b ? [...a, ...b] : null;
  }],
  [/^(~|it|that creature|.+?) deals damage equal to (.+?) to (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    if (!src) return null;
    const a = amt(m[2], ctx);
    if (a === null) return null;
    return damageTo(m[3], a, ctx, src);
  }],
  [/^(~|it|that creature|.+?) deals (\w+|X) damage divided as you choose among (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!src || n === null) return null;
    return damageTo(`${m[2]} damage, divided as you choose among ${m[3]}`.replace(/^.*?, divided/, 'x, divided'), n, ctx, src);
  }],
  [/^each player shuffles their hand and graveyard into their library, then draws (\w+) cards$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'hand', to: 'library' }, { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'library' }, { kind: 'shuffle', who: { ref: 'eachPlayer' } }, { kind: 'draw', amount: n, who: { ref: 'eachPlayer' } }];
  }],
  [/^(~|it|that creature|.+?) deals damage to (.+?) equal to (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    if (!src) return null;
    const a = amt(m[3], ctx);
    if (a === null) return null;
    return damageTo(m[2], a, ctx, src);
  }],
  // Destroy / exile / sacrifice
  [/^destroy (.+?)(?:\. (?:It|They) cannot be regenerated)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'destroy', what: ref, cantRegenerate: /regenerat/i.test(m[0]) }] : null;
  }],
  [/^exile (.+?)( from (?:their|your|its owner's|that player's) graveyard)?(?: with (?:a|an|(\w+)) (\w+) counters? on (?:it|them))?(?: until (?:~|it) leaves the battlefield)?$/i, (m, ctx) => {
    const until = / until (?:~|it) leaves the battlefield$/i.test(m[0]);
    // "target card that is an instant or sorcery from your graveyard": the zone belongs to the noun.
    const ref = objRef(`${m[1]}${m[2] ?? ''}`, ctx) ?? (m[2] ? objRef(m[1], ctx) : null);
    if (!ref) return null;
    const e: Effect = { kind: 'exile', what: ref, untilSourceLeaves: until, remember: 'exiled' };
    if (m[4]) e.counters = { counter: m[4], amount: m[3] ? (wordToNumber(m[3]) ?? 1) : 1 };
    ctx.lastObj = { ref: 'lastMoved' };
    return [e];
  }],
  [/^(?:(.+?) )?sacrifices? (~|it|them|that creature|that permanent|the creature|the permanent|that token|the token|those creatures|those tokens|enchanted creature|equipped creature)$/i, (m, ctx) => {
    // Sarkhan the Mad: "Target creature's controller sacrifices it, then that player creates …" — the object is the
    // possessive's noun, and "that player" afterwards is its controller.
    const pm = m[1]?.match(/^(.+?)'s controller$/i);
    if (pm && /^(?:it|that creature|that permanent)$/i.test(m[2])) {
      const obj = objRef(pm[1], ctx);
      if (!obj) return null;
      ctx.lastObj = obj;
      ctx.lastPlayer = { ref: 'controllerOf', of: obj };
      return [{ kind: 'sacrifice', what: obj }];
    }
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'sacrifice', what: ref }] : null;
  }],
  [/^(?:(.+?) )?sacrifices? (?:a|an|another|any number of|(\w+)) (.+?)(?: of (?:their|your) choice)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const anyNumber = /sacrifices? any number of /i.test(m[0]);
    const noun = parseNoun(`a ${m[3]}`) ?? (anyNumber ? parseNoun(`a ${m[3].replace(/^(\w+?)s\b/i, '$1')}`) : null);
    if (!who || !noun) return null;
    const n = anyNumber ? 99 : m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    return [{ kind: 'sacrificeChoice', who, filter: { ...noun.filter, zone: 'battlefield', other: /another/i.test(m[0]) || undefined }, count: n, upTo: anyNumber || undefined }];
  }],
  // Indefinite choices: "return a land you control to its owner's hand", "tap an untapped creature you control", "exile a card from your graveyard"
  [/^(return|tap|untap|exile|destroy) (?:a|an|another|up to (\w+)|(any number of)) (.+?)(?: to (?:its|their) owner'?s'? hands?| to your hand)?( until (?:~|it) leaves the battlefield)?$/i, (m, ctx) => {
    if (/target|each/i.test(m[4])) return null;
    const c = chooseRef(`a ${singularize(m[4])}`, ctx, YOU, !!m[2] || !!m[3]);
    if (!c) return null;
    if (/^(return|tap|untap|exile|destroy) another /i.test(m[0])) (c.pre[0] as { filter: ObjectFilter }).filter.other = true;
    if (m[3]) (c.pre[0] as { count: number }).count = 20;
    else if (m[2]) (c.pre[0] as { count: number | 'X' }).count = wordToNumber(m[2]) ?? 1;
    const verb = m[1].toLowerCase();
    const eff: Effect = verb === 'return' ? { kind: 'returnToHand', what: c.ref } : verb === 'tap' ? { kind: 'tap', what: c.ref } : verb === 'untap' ? { kind: 'untap', what: c.ref } : verb === 'exile' ? { kind: 'exile', what: c.ref, untilSourceLeaves: !!m[5], remember: 'exiled' } : { kind: 'destroy', what: c.ref };
    if (verb === 'return' && !/ to (?:its|their) owner'?s'? hands?| to your hand/i.test(m[0])) return null;
    if (verb === 'exile' && m[5]) ctx.lastObj = { ref: 'lastMoved' };
    return [...c.pre, eff];
  }],
  [/^put (?:a|an|(\w+)) (?:(.+?) )?cards? from your hand (on top of|on the bottom of) your library(?: in any order)?$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const noun = m[2] ? parseNoun(`a ${m[2]} card`) : { filter: {} as ObjectFilter };
    if (!noun) return null;
    const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n, key }, { kind: 'putOnLibrary', what: { ref: 'chosen', key }, position: /top/.test(m[3]) ? 'top' : 'bottom' }];
  }],
  [/^(?:you may )?put (?:a|an|up to (\w+)) (.+?) from your hand onto the battlefield(?: (tapped)(?: and (attacking)(?: that (?:player|opponent))?)?)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${/\bcards?\b/i.test(m[2]) ? m[2].replace(/ cards$/i, ' card') : `${m[2]} card`} from your hand`, ctx, YOU, true);
    if (!c) return null;
    return [...c.pre, { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3], attacking: m[4] ? true : undefined }];
  }],
  [/^(?:you may )?put (?:a|an|up to (\w+)) (.+?) cards? from your graveyard (?:onto the battlefield|into your hand)( tapped)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]} card from your graveyard`, ctx, YOU, true);
    if (!c) return null;
    return [...c.pre, /battlefield/i.test(m[0]) ? { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3] } : { kind: 'putIntoHand', what: c.ref }];
  }],
  [/^return (?:a|an|up to (\w+)) (.+?) cards? from your graveyard to (?:your hand|the battlefield)( tapped)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]} card from your graveyard`, ctx, YOU, !!m[1]);
    if (!c) return null;
    return [...c.pre, /battlefield/i.test(m[0]) ? { kind: 'returnToBattlefield', what: c.ref, tapped: !!m[3] } : { kind: 'putIntoHand', what: c.ref }];
  }],
  [/^look at the top card of your library$/i, () => [{ kind: 'lookAtTop', amount: 1, then: 'reorder' }]],
  [/^choose a card name$/i, () => [{ kind: 'nameCard', key: 'cardName' }]],
  // Return
  [/^return (.+?) and (.+?) to their owners'? hands$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = a ? objRef(m[2], ctx) : null;
    return a && b ? [{ kind: 'returnToHand', what: a }, { kind: 'returnToHand', what: b }] : null;
  }],
  [/^return (.+?) to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  [/^return (.+?) to (?:your|their) hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  [/^return (.+?) to the battlefield( tapped)?(?: under (your|its owner's|their owner's|their owners') control)?( tapped)?(?: with (?:a|an|\w+) ([+-]\d\/[+-]\d|\w+) counters? on (?:it|them))?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const e: Effect = { kind: 'returnToBattlefield', what: ref, tapped: !!(m[2] || m[4]), controller: m[3] && /owner/.test(m[3]) ? 'owner' : 'you' };
    if (m[5]) e.counters = { counter: m[5], amount: 1 };
    return [e];
  }],
  [/^put (.+?) (?:into (?:its|their) owner'?s'? hands?|into your hand)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putIntoHand', what: ref }] : null;
  }],
  [/^put (.+?) (?:onto|on) the battlefield(?: under (your|its owner's) control)?( tapped)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToBattlefield', what: ref, tapped: !!m[3], controller: m[2] === "its owner's" ? 'owner' : 'you' }] : null;
  }],
  [/^put (.+?) on (?:the )?(top|bottom) of (?:its|their) owner'?s'? librar(?:y|ies)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: m[2].toLowerCase() as 'top' | 'bottom' }] : null;
  }],
  [/^put (.+?) on (?:the )?(top|bottom) of your library$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: m[2].toLowerCase() as 'top' | 'bottom' }] : null;
  }],
  [/^(?:(.+?) )?shuffles? (.+?) into (?:its|their|your) (?:owner'?s'? )?librar(?:y|ies)$/i, (m, ctx) => {
    // "The owner of target permanent shuffles it into their library" (Chaos Warp): "it" is that permanent.
    const owned = m[1]?.match(/^the owner of (.+)$/i);
    if (owned && /^(?:it|that card|that permanent|them)$/i.test(m[2])) {
      const ref = objRef(owned[1], ctx);
      if (!ref) return null;
      const owner: Ref = { ref: 'ownerOf', of: ref };
      ctx.lastPlayer = owner;
      ctx.lastObj = null; // the shuffled card is gone; a later "it" means whatever comes next
      return [{ kind: 'moveToZone', what: ref, zone: 'library' }, { kind: 'shuffle', who: owner }];
    }
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'library' }, { kind: 'shuffle', who: m[1] ? playerRef(m[1], ctx) ?? undefined : undefined }] : null;
  }],
  // Tokens
  [/^create (.+)$/i, (m, ctx) => {
    // copies of a target
    const copy = m[1].match(/^(a|an|\w+|X) ((?:tapped and attacking |tapped )?)tokens? that (?:is|are) (?:a )?cop(?:y|ies) of (.+?)(?:,? except (.+?))?((?:,| and)? (?:that is|that are|that's) (?:tapped and attacking|attacking|tapped))?$/i);
    if (copy) {
      const n = wordToNumber(copy[1]);
      const pre: Effect[] = [];
      let ref = objRef(copy[3], ctx);
      if (!ref) {
        const ch = chooseRef(copy[3], ctx);
        if (ch) {
          pre.push(...ch.pre);
          ref = ch.ref;
        }
      }
      if (n === null || !ref) return null;
      if (copy[5]) copy[2] = `${copy[2]} ${copy[5]}`;
      const token: TokenSpec = { name: 'Copy', typeLine: '', colors: [], copyOf: ref };
      if (copy[4]) {
        const ex = parseCopyExceptions(copy[4]);
        if (!ex) return null;
        token.exceptions = ex;
      }
      ctx.lastObj = { ref: 'lastCreated' };
      return [...pre, { kind: 'createToken', token, count: n, tapped: /tapped/i.test(copy[2]), attacking: /attacking/i.test(copy[2]) }];
    }
    // Role tokens attached to something
    const role = m[1].match(/^(?:a|an) ((?:Wicked|Monster|Royal|Sorcerer|Cursed|Virtuous|Young Hero) Role) token attached to (.+)$/i);
    if (role) {
      const host = objRef(role[2], ctx);
      if (!host) return null;
      return [{ kind: 'createToken', token: { name: role[1].replace(/ Role$/, ''), typeLine: '', colors: [], preset: role[1] }, count: 1, attachTo: host }];
    }
    const t = parseTokenPhrase(m[1]);
    if (!t) {
      // "Create a 1/1 green Snake creature token, a 2/2 green Wolf creature token, and a 3/3 green Elephant creature token."
      const parts = m[1].split(/, and |, (?=(?:a|an|two|three|four|X) )/i).map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1) {
        const specs = parts.map((x) => parseTokenPhrase(x));
        if (specs.every((x) => x)) {
          ctx.lastObj = { ref: 'lastCreated' };
          return specs.map((x) => ({ kind: 'createToken', token: x!.token, count: x!.count, tapped: x!.tapped, attacking: x!.attacking }) as Effect);
        }
      }
      return null;
    }
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: t.count, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^(.+?) creates? (.+)$/i, (m, ctx) => {
    if (/^(?:you|create)$/i.test(m[1])) return null;
    const who = playerRef(m[1], ctx);
    const t = parseTokenPhrase(m[2]);
    if (!who || !t) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: t.count, tapped: t.tapped, attacking: t.attacking, who }];
  }],
  [/^create (.+?) for each (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(m[1]);
    if (!t || t.count !== 1) return null;
    const a: Amount | null = perEach(m[2], ctx) ?? amt(`the number of ${m[2].replace(/^(\w+) /, (w) => (/s$/.test(w.trim()) ? w : `${w.trim()}s `))}`, ctx);
    if (a === null) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: a, tapped: t.tapped, attacking: t.attacking }];
  }],
  [/^create a number of (.+?) tokens? equal to (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(`a ${m[1]} token`);
    const a = amt(m[2], ctx);
    if (!t || a === null) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: a }];
  }],
  [/^(?:you )?gets? ((?:\{E\})+) for each (.+)$/i, (m, ctx) => {
    const noun = parseNoun(m[2]);
    if (!noun) return null;
    return [{ kind: 'addCounters', counter: 'energy', amount: { kind: 'times', a: (m[1].match(/\{E\}/g) ?? []).length, b: { kind: 'count', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } } }, on: YOU }];
  }],
  [/^investigate$/i, () => [{ kind: 'investigate' }]],
  [/^investigate (twice|three times|(\w+) times)$/i, (m) => {
    const n = /twice/i.test(m[1]) ? 2 : /three times/i.test(m[1]) ? 3 : wordToNumber(m[2] ?? '');
    return n === null ? null : [{ kind: 'investigate', count: n }];
  }],
  [/^exile all (?:opponents'|your opponents') graveyards$/i, () => [{ kind: 'moveAll', who: { ref: 'eachOpponent' }, from: 'graveyard', to: 'exile' }]],
  [/^(~|it|that creature) attacks that (player|opponent) this combat if able$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : ctx.lastObj ?? SELF;
    return [{ kind: 'applyRule', on: ref, rule: { kind: 'mustAttack' }, duration: 'endOfTurn' }];
  }],
  // "Put those counters on target creature you control." (after "remove ... counters")
  [/^put those counters on (.+)$/i, (m, ctx) => {
    // The Ozolith: "Whenever a creature you control leaves the battlefield, if it had counters on it, put those
    // counters on ~" — the counters come from the object in scope; with none, from ~ ("remove … counters from ~").
    const from: Ref = ctx.lastObj && ctx.lastObj.ref !== 'self' ? ctx.lastObj : ctx.triggerHasObject && !ctx.lastObj ? { ref: 'triggerObject' } : SELF;
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'moveCounters', from, to: ref }] : null;
  }],
  // "An opponent chooses two of those cards."
  [/^(.+?) chooses (\w+) of those cards$/i, (m, ctx) => {
    const by = actorRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!by || n === null) return null;
    ctx.lastObj = { ref: 'chosen', key: 'chosen' };
    return [{ kind: 'chooseObjects', from: { ref: 'lastMoved' }, filter: {}, count: n, key: 'chosen', who: by }];
  }],

  [/^(?:(.+?) )?exiles? the top (?:card|(\w+|X) cards) of (?:your|their) library(?: face down)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exileTop', amount: n, who, faceDown: / face down$/i.test(m[0]) }];
  }],
  [/^reveal (?:any number of|(\w+)) (.+?) (?:cards? )?(?:in|from) your hand$/i, (m, ctx) => {
    void ctx;
    const noun = parseNoun(`a ${m[2].replace(/ cards?$/i, '')} card`) ?? parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 99;
    if (n === null) return null;
    const key = 'revealedFromHand';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n as Amount, key, upTo: true }, { kind: 'revealHand', who: YOU }];
  }],
  [/^(?:(.+?) )?reveals? (?:their|your) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'revealHand', who }] : null;
  }],
  [/^you may (?:play|cast) (?:that card|those cards|it|them) (?:this turn|until end of turn|until the end of your next turn|for as long as (?:it remains|they remain) exiled)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? { ref: 'lastMoved' as const };
    return [{ kind: 'playFromExile', what: ref, duration: playUntil(m[0]) }];
  }],
  [/^add (\w+|X) mana of the chosen color$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'addMana', mana: 'chosenColor', amount: n }];
  }],
  [/^add one mana of the chosen color$/i, () => [{ kind: 'addMana', mana: 'chosenColor' }]],
  [/^(?:you )?(?:gets?|gain) ((?:\{E\})+)$/i, (m) => [{ kind: 'addCounters', counter: 'energy', amount: (m[1].match(/\{E\}/g) ?? []).length, on: YOU }]],
  // Counters
  // "Put a +1/+1 counter and a trample counter on target creature"
  [/^put ((?:a|an|\w+) (?:[+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters?(?:,? (?:and )?(?:a|an|\w+) (?:[+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters?)+) on (.+)$/i, (m, ctx) => {
    const parts = m[1].split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    const items: { counter: string; amount: Amount }[] = [];
    for (const part of parts) {
      const pm = part.trim().match(/^(?:a|an|(\w+|X)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters?$/i);
      if (!pm) return null;
      const n: Amount | null = pm[1] ? wordToNumber(pm[1]) : 1;
      if (n === null) return null;
      items.push({ counter: pm[2], amount: n });
    }
    const isPlayer = /^(you|each player|each opponent|target player|target opponent|that player|its controller)$/i.test(m[2]);
    const ref = isPlayer ? playerRef(m[2], ctx) : objRef(m[2], ctx);
    if (!ref) return null;
    return items.map((it) => ({ kind: 'addCounters', counter: it.counter, amount: it.amount, on: ref }) as Effect);
  }],
  // "counter that spell or ability unless its controller pays {2}"
  [/^counter that (?:spell or ability|ability|spell)(?: unless its controller pays ((?:\{[^}]+\})+))?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'triggerObject' } as Ref);
    return [{ kind: 'counterSpell', what: ref, unlessPays: m[1] }];
  }],
  // "~ cannot be blocked by creatures with power 2 or less this turn"
  [/^(.+?) cannot be blocked by creatures with power (\d+) or (less|greater) this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const n = parseInt(m[2], 10);
    return [{ kind: 'applyRule', rule: /less/i.test(m[3]) ? { kind: 'cantBeBlockedByPowerLE', power: n } : { kind: 'cantBeBlockedByPowerGE', power: n }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Double / Switch the power and toughness of target creature until end of turn"
  [/^(?:switch its power and toughness)(?: until end of turn)?$/i, (m, ctx) => [{ kind: 'switchPT', on: ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF), duration: 'endOfTurn' }]],
  [/^(double|switch) the power and toughness of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [/^double$/i.test(m[1]) ? { kind: 'doubleStat', on: ref, stat: 'both', duration: dur } : { kind: 'switchPT', on: ref, duration: dur }];
  }],
  // "Its power is equal to that creature's power and its toughness is equal to that creature's toughness"
  [/^(its|~'s) power is equal to (.+?) and (?:its|~'s) toughness is equal to (.+)$/i, (m, ctx) => {
    const pw = amt(m[2], ctx);
    const tg = amt(m[3], ctx);
    if (pw == null || tg == null) return null;
    const ref = /^its$/i.test(m[1]) ? ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref) : ({ ref: 'self' } as Ref);
    return [{ kind: 'setPT', power: pw, toughness: tg, on: ref, duration: 'permanent' }];
  }],
  // "Any player may have ~ deal 6 damage to them"
  [/^any player may have ~ deal (\d+|X) damage to (?:them|him or her)$/i, (m) => {
    const n: Amount = m[1] === 'X' ? 'X' : parseInt(m[1], 10);
    return [{ kind: 'anyPlayerMay', prompt: `Have ~ deal ${m[1]} damage to you?`, effects: [{ kind: 'damage', amount: n, to: { ref: 'controller' }, source: { ref: 'self' } }] }];
  }],
  // "draw three cards, then discard one of them"
  [/^(?:(.+?) )?draws? (\w+|X) cards?, then discards? (\w+|X) of them$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = m[2] === 'X' ? ('X' as Amount) : wordToNumber(m[2]);
    const b = m[3] === 'X' ? ('X' as Amount) : wordToNumber(m[3]);
    if (!who || a === null || b === null) return null;
    return [{ kind: 'draw', amount: a, who }, { kind: 'discard', amount: b, who }];
  }],
  // "You may put a permanent card from among the milled cards into your hand"
  [/^(?:you may )?put (?:a|an|(\w+)) (.+?) from among the milled cards into your hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const c = chooseRef(`a ${m[2]}`, ctx, YOU, true);
    if (!c) return null;
    (c.pre[0] as { filter: ObjectFilter }).filter = { ...noun.filter, zone: 'graveyard', owner: 'you' };
    return [...c.pre, { kind: 'putIntoHand', what: c.ref }];
  }],
  // "Put a +1/+1 counter or a loyalty counter on it" — a +1/+1 counter on a creature, a loyalty counter on a planeswalker.
  [/^put (?:a|an) \+1\/\+1 counter or (?:a|an) loyalty counter on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'conditional', if: { kind: 'objectMatches', ref, filter: { types: ['Creature'] } }, then: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }], else: [{ kind: 'conditional', if: { kind: 'objectMatches', ref, filter: { types: ['Planeswalker'] } }, then: [{ kind: 'addCounters', counter: 'loyalty', amount: 1, on: ref }] }] }];
  }],
  [/^put (?:a|an|another|(\w+|X|twice X|that many|twice that many)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? on (.+)$/i, (m, ctx) => {
    const n: Amount | null = m[1] ? (/that many/i.test(m[1]) ? amt(m[1], ctx) : /^twice x$/i.test(m[1]) ? { kind: 'times', a: 'X', b: 2 } : wordToNumber(m[1])) : 1;
    if (n === null) return null;
    const isObjectTarget = !/^(you|each player|each opponent|target player|target opponent|that player|defending player|its controller|that creature's controller|the chosen player|the chosen opponent)$/i.test(m[3]);
    const ref = isObjectTarget ? objRef(m[3], ctx) : playerRef(m[3], ctx);
    if (!ref && isObjectTarget && /^(?:a|an) /i.test(m[3])) {
      const c = chooseRef(m[3], ctx);
      if (c) return [...c.pre, { kind: 'addCounters', counter: m[2], amount: n, on: c.ref }];
    }
    return ref ? [{ kind: 'addCounters', counter: m[2], amount: n, on: ref }] : null;
  }],
  [/^distribute (\w+|X) ([+-]\d+\/[+-]\d+|\w+) counters among (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = objRef(m[3], ctx);
    return n !== null && ref ? [{ kind: 'addCounters', counter: m[2], amount: n, on: ref, divided: true }] : null;
  }],
  [/^(?:(.+?) )?draws? a card for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    if (!who) return null;
    const noun = parseNoun(m[2]);
    const a: Amount | null = perEach(m[2], ctx);
    if (a === null) return null;
    return [{ kind: 'draw', amount: a, who }];
  }],
  [/^put (?:a|an|(\w+|X)) ([+-]\d+\/[+-]\d+|\w+) counters? on (.+?) for each (.+)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const per: Amount | null = perEach(m[4], ctx);
    if (per === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[2], amount: { kind: 'times', a: n, b: per }, on: ref }] : null;
  }],
  [/^remove (a|all|(\w+|X)) counters? from (.+)$/i, (m, ctx) => {
    const n: Amount | 'all' | null = /^all$/i.test(m[1]) ? 'all' : m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'removeCounters', counter: 'any', amount: n, on: ref }] : null;
  }],
  [/^remove (?:a|an|all|(\w+|X|twice X|that many)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? from (.+)$/i, (m, ctx) => {
    const n: Amount | 'all' | null = /all/i.test(m[0].split(' ')[1]) ? 'all' : m[1] ? (/that many/i.test(m[1]) ? { kind: 'triggerAmount' } : /^twice x$/i.test(m[1]) ? { kind: 'times', a: 'X', b: 2 } : wordToNumber(m[1])) : 1;
    if (n === null) return null;
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'removeCounters', counter: m[2], amount: n, on: ref }] : null;
  }],
  [/^(?:you )?gets? (?:a|an|(\w+)) (poison|experience) counters?$/i, (m) => [{ kind: 'addCounters', counter: m[2].toLowerCase(), amount: m[1] ? (wordToNumber(m[1]) ?? 1) : 1, on: YOU }]],
  [/^(?:you )?gets? ((?:\{E\})+)$/i, (m) => [{ kind: 'addCounters', counter: 'energy', amount: (m[1].match(/\{E\}/g) ?? []).length, on: YOU }]],
  [/^(.+?) gets? (?:a|an|(\w+)) (poison|rad|ticket|experience|energy) counters?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'addCounters', counter: m[3].toLowerCase(), amount: m[2] ? (wordToNumber(m[2]) ?? 1) : 1, on: who }] : null;
  }],
  [/^proliferate$/i, () => [{ kind: 'proliferate' }]],
  [/^populate$/i, () => [{ kind: 'populate' }]],
  // Pump / keywords
  [/^(.+?) (?:gets?|get) ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: and (?:gains?|has|have) (.+?))?(?: until end of turn| until your next turn)?$/i, (m, ctx) => {
    const { duration: dur } = duration(m[0]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const p = m[2].toUpperCase().includes('X') ? (m[2].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[2], 10);
    const t = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[3], 10);
    const out: Effect[] = [{ kind: 'pump', power: p, toughness: t, on: ref, duration: dur ?? 'permanent' }];
    if (m[4]) {
      const kws = parseKeywordList(m[4].replace(/ until end of turn$/i, ''));
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur ?? 'permanent' });
    }
    return out;
  }],
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+) for each (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const a: Amount | null = perEach(m[4], ctx);
    if (a === null) return null;
    const p = parseInt(m[2], 10);
    const t = parseInt(m[3], 10);
    return [{ kind: 'pump', power: { kind: 'times', a: p, b: a }, toughness: { kind: 'times', a: t, b: a }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+) until end of turn for each (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const a: Amount | null = perEach(m[4], ctx);
    if (a === null) return null;
    return [{ kind: 'pump', power: { kind: 'times', a: parseInt(m[2], 10), b: a }, toughness: { kind: 'times', a: parseInt(m[3], 10), b: a }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^(.+?) (?:gets?|get) ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X) and gains? ((?:[\w' ]+ )?and )?"(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const p = m[2].toUpperCase().includes('X') ? (m[2].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[2], 10);
    const t = m[3].toUpperCase().includes('X') ? (m[3].startsWith('-') ? { kind: 'times' as const, a: 'X' as const, b: -1 } : 'X') : parseInt(m[3], 10);
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [{ kind: 'pump', power: p, toughness: t, on: ref, duration: dur }];
    // "gains trample and \"Whenever …\"": the words before the quote are keywords.
    if (m[4]) {
      const kws = parseKeywordList(m[4].replace(/ and $/i, ''));
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    out.push({ kind: 'grantAbility', text: m[5], on: ref, duration: dur });
    return out;
  }],
  [/^(.+?) (?:loses? all abilities and )?becomes? (?:a|an) (.+?)(?: creature)? with base power and toughness (\d+|X)\/(\d+|X)(?:,? and (?:gains )?(.+?)|, (.+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = m[2].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const out: Effect[] = [];
    if (/loses all abilities and/i.test(m[0])) out.push({ kind: 'loseAllAbilities', on: ref, duration: dur });
    out.push({ kind: 'setPT', power: m[3] === 'X' ? 'X' : parseInt(m[3], 10), toughness: m[4] === 'X' ? 'X' : parseInt(m[4], 10), on: ref, duration: dur });
    out.push({ kind: 'addTypes', types, subtypes, on: ref, duration: dur });
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    const kwText = m[5] ?? m[6];
    if (kwText) {
      const kws = parseKeywordList(kwText);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    return out;
  }],
  // "it becomes a 0/0 Robot creature in addition to its other types"
  [/^(.+?) becomes? an? (\d+)\/(\d+) ([A-Za-z][\w' -]*?) creature(?: with ([\w ,]+?))?(?: in addition to its other types)?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const noun = parseNoun(`a ${m[4]} creature`);
    if (!noun) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const kws = m[5] ? parseKeywordList(m[5]) : [];
    if (m[5] && !kws) return null;
    const out: Effect[] = [
      { kind: 'addTypes', types: ['Creature'], subtypes: noun.filter.subtypes, on: ref, duration: dur },
      { kind: 'setPT', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: dur },
    ];
    if (kws?.length) out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    return out;
  }],
  [/^(.+?) becomes? an? (artifact creature|artifact|creature|enchantment creature|enchantment)(?: in addition to its other types)?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const types = m[2].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    return [{ kind: 'addTypes', types, on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(.+?) (?:has|have) base (power|toughness) (\d+|X)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const v: Amount = m[3] === 'X' ? 'X' : parseInt(m[3], 10);
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'setPT', ...(m[2].toLowerCase() === 'power' ? { power: v } : { toughness: v }), on: ref, duration: dur }];
  }],
  // "becomes an Avatar in addition to its other types" / "becomes blue Illusions in addition to their other types"
  [/^(.+?) becomes? (?:a |an )?([A-Za-z][\w' -]*?)(?: in addition to (?:its|their) other types)?(?: until end of turn)?$/i, (m, ctx) => {
    const inAddition = /in addition to (?:its|their) other types/i.test(m[0]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = m[2].split(/\s+/).filter((w) => !/^and$/i.test(w));
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = words.filter((w) => /^(artifact|creature|enchantment|land|planeswalker)s?$/i.test(w)).map((w) => w.replace(/s$/i, '')).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w)).map((w) => singularize(w));
    if (!types.length && !subtypes.length && !colors.length) return null;
    const out: Effect[] = [];
    if (!inAddition && subtypes.length && !types.length && !colors.length) out.push({ kind: 'setSubtypes', on: ref, subtypes, duration: dur });
    else if (types.length || subtypes.length) out.push({ kind: 'addTypes', types, subtypes, on: ref, duration: dur });
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    return out.length ? out : null;
  }],
  // "gains your choice of flying, vigilance, deathtouch, or haste"
  [/^(.+?) gains? your choice of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const kws = parseKeywordList(m[2].replace(/,? or /gi, ', '));
    if (!kws || kws.length < 2) return null;
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent', choose: 1 }];
  }],
  // "Until end of turn, ~ becomes a 3/2 red Goblin creature with \"…\". It is still a land."
  [/^(.+?) becomes? (?:a|an) ([\dX]+\/[\dX]+ .*?creature) with "(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const temp = / until end of turn$/i.test(m[0]);
    const base = parseSentence(`${m[1]} becomes a ${m[2]}${temp ? ' until end of turn' : ''}`, ctx);
    if (!base) return null;
    const ref = ctx.lastObj ?? objRef(m[1], ctx);
    if (!ref) return null;
    return [...base, { kind: 'grantAbility', text: m[3], on: ref, duration: temp ? 'endOfTurn' : 'permanent' }];
  }],
  // "target land becomes a 3/3 creature that is still a land"
  [/^(.+?) (?:loses? all abilities and )?becomes? (?:a|an) ([\dX]+)\/([\dX]+) (.*?)?creature(?: that(?:'s| is) still (?:a |an )?(\w+))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = (m[4] ?? '').trim().split(/\s+/).filter(Boolean).filter((w) => !/^and$/i.test(w));
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    if (words.some((w) => !/^(white|blue|black|red|green|artifact|enchantment|land|colorless)$/i.test(w) && !/^[A-Z]/.test(w))) return null;
    const out: Effect[] = [];
    if (/loses all abilities and/i.test(m[0])) out.push({ kind: 'loseAllAbilities', on: ref, duration: dur });
    ctx.lastObj = ref;
    out.push({ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur });
    out.push({ kind: 'addTypes', types, subtypes, on: ref, duration: dur });
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    return out;
  }],
  [/^(.+?) (?:loses? all abilities and )?(?:has|have) base power and toughness (\d+|X)\/(\d+|X)(?: and gains? ([\w ,]+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [];
    if (/loses all abilities and/i.test(m[0])) out.push({ kind: 'loseAllAbilities', on: ref, duration: dur });
    out.push({ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur });
    if (m[4]) {
      const kws = parseKeywordList(m[4]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    return out;
  }],
  [/^(.+?) loses? (.+?) until end of turn$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    return kws && ref ? [{ kind: 'removeKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^(.+?) becomes? (white|blue|black|red|green|colorless)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[2].toLowerCase() as 'white'];
    return [{ kind: 'setColors', colors: c ? [c] : [], on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(.+?) blocks this turn if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlockAny' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^reveal the top card of your library and put (?:it|that card) into your hand$/i, (_m, ctx) => {
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealTop', destination: 'hand' }];
  }],
  [/^(?:(.+?) )?draws? an additional card$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'draw', amount: 1, who }] : null;
  }],
  [/^(.+?) (?:gains?|has|have) (.+?)(?: until end of turn| until your next turn)?$/i, (m, ctx) => {
    const { duration: dur } = duration(m[0]);
    const kws = parseKeywordList(m[2]);
    if (!kws) return null;
    const ref = objRef(m[1], ctx);
    // No stated duration: the grant lasts indefinitely (CR 611.2a) — "It gains first strike." (Brass-Talon Chimera),
    // "it loses defender" (Elder Land Wurm), "That token gains haste" (Helm of the Host).
    return ref ? [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur ?? 'permanent' }] : null;
  }],
  [/^(.+?) loses? all abilities(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'loseAllAbilities', on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^(.+?) (?:cannot|can't) (attack|block|attack or block|be blocked)(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const kinds = m[2] === 'attack or block' ? ['cantAttack', 'cantBlock'] : m[2] === 'be blocked' ? ['cantBeBlocked'] : [m[2] === 'attack' ? 'cantAttack' : 'cantBlock'];
    return kinds.map((k) => ({ kind: 'applyRule', rule: { kind: k as 'cantAttack' }, on: ref, duration: dur }));
  }],
  [/^(.+?) (?:each )?becomes? (?:(?:a|an) )?(?:legendary |snow )?([\dX]+)\/([\dX]+) (.+?) (?:creature|artifact creature)s?(?: with (.+?))?(?: and loses (.+?))?(?: in addition to (?:its|their) other types)?(?: that (?:is|are) (?:still|no longer) (?:a |an )?[\w ]+)?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = m[4].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...(/artifact creature$/i.test(m[0].split(' with ')[0]) || words.some((w) => /^artifact$/i.test(w)) ? ['Artifact'] : [])];
    const out: Effect[] = [{ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur }, { kind: 'addTypes', types, subtypes: words.filter((w) => /^[A-Z]/.test(w)), on: ref, duration: dur }];
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur });
    }
    if (m[6]) {
      const kws = parseKeywordList(m[6]);
      if (!kws) return null;
      out.push({ kind: 'removeKeywords', keywords: kws, on: ref, duration: dur });
    }
    return out;
  }],
  // Tap / untap
  [/^(tap|untap) (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: m[1].toLowerCase() as 'tap' | 'untap', what: ref }] : null;
  }],
  // "…, then reveals the top card of their library" (a third-person subject carried from the previous clause)
  [/^(?:(.+?) )?reveals? the top card of (their|your|his or her) library$/i, (m, ctx) => {
    const who = /^your$/i.test(m[2]) && !m[1] ? YOU : subjectPlayer(m[1], ctx);
    if (!who) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealTop', who, destination: 'stay' }];
  }],
  // Mana Drain: "add an amount of {C} equal to that spell's mana value"
  [/^add an amount of \{([WUBRGC])\} equal to (.+)$/i, (m, ctx) => {
    const a = amt(m[2], ctx);
    return a === null ? null : [{ kind: 'addMana', mana: [m[1].toUpperCase() as ManaColor], amount: a }];
  }],
  // Scry / surveil / mill
  [/^scry (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'scry', amount: n }];
  }],
  [/^surveil (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'surveil', amount: n }];
  }],
  [/^(?:(.+?) )?mills? ((?:twice |three times |four times )?(?:\w+|X)|(?:twice |half |three times )?that many) cards?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[2]) ?? amt(m[2], ctx);
    return who && n !== null ? [{ kind: 'mill', amount: n, who }] : null;
  }],
  [/^(?:(.+?) )?mills? cards equal to (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const a = amt(m[2], ctx);
    return who && a !== null ? [{ kind: 'mill', amount: a, who }] : null;
  }],
  // "choose target X." → just registers the target for the following sentences
  [/^choose (target .+|up to \w+ (?:other )?target .+)$/i, (m, ctx) => {
    const parts = m[1].split(/ and (?=target |up to \w+ target )/i);
    let last: Ref | null = null;
    for (const p of parts) {
      last = objRef(p, ctx) ?? playerRef(p, ctx);
      if (!last) return null;
    }
    // A bare "Choose target X." exists so later sentences can say "that creature"/"that target" after other things moved "it".
    if (parts.length === 1 && last) ctx.anyTarget = last;
    return [];
  }],
  // Reveal-and-discard: "You choose a nonland card from it. That player discards that card."
  [/^you (?:may )?choose (?:a|an|up to (\w+)) (?:(.+?) )?cards?(?: of that color| of the chosen color)?(?: (with [^,]+?|that [^,]+?))? from (?:it|among them|that hand)(?: (with [^,]+?|that [^,]+?))?$/i, (m, ctx) => {
    const owner = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : null);
    if (!owner) return null;
    // The qualifier can sit either side of "from it": "a card with mana value 3 or less from it".
    const qual = m[3] ?? m[4];
    const adj = !m[2] || m[2] === 'card' ? '' : `${m[2]} `;
    const noun = !adj && !qual ? { filter: {} as ObjectFilter } : parseNoun(`a ${adj}card${qual ? ` ${qual}` : ''}`);
    if (!noun) return null;
    const key = `revealed${ctx.targets.length}`;
    const n = m[1] ? (wordToNumber(m[1]) ?? 1) : 1;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand' }, owner, count: n, key, upTo: !!m[1] }];
  }],
  [/^(?:that player|they|target player|each of those players) discards? (?:that card|those cards|it|them|the chosen cards?)$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    return ref ? [{ kind: 'discardObjects', what: ref }] : null;
  }],
  // "each opponent with no cards in hand loses 10 life" style
  [/^each (opponent|player) (?:with|who has) (no cards in hand|(\w+) or more cards in hand|(\w+) or fewer cards in hand|more life than you|less life than you) (.+)$/i, (m, ctx) => {
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(m[5].replace(/^(loses?|gains?|draws?|discards?|sacrifices?|mills?)/i, (v) => v), sub);
    if (!inner) return null;
    let cond: Condition;
    if (/^no cards/i.test(m[2])) cond = { kind: 'handSize', ref: { ref: 'iter' }, op: '==', value: 0 };
    else if (m[3]) cond = { kind: 'handSize', ref: { ref: 'iter' }, op: '>=', value: wordToNumber(m[3]) as number };
    else if (m[4]) cond = { kind: 'handSize', ref: { ref: 'iter' }, op: '<=', value: wordToNumber(m[4]) as number };
    else cond = { kind: 'amount', a: { kind: 'life', ref: { ref: 'iter' } }, op: /more/i.test(m[2]) ? '>' : '<', b: { kind: 'life', ref: YOU } };
    return [{ kind: 'forEach', over: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: [{ kind: 'conditional', if: cond, then: inner }] }];
  }],
  // "For each opponent, create a 1/1 white Human creature token that is tapped and attacking that player."
  [/^for each (opponent|player), (.+)$/i, (m, ctx) => {
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    // "attacking that player" is the iterated player, not whoever this source is attacking.
    const naming = / attacking that (?:player|opponent)\b/i.test(m[2]);
    const inner = parseSentence(naming ? m[2].replace(/ attacking that (?:player|opponent)\b/i, ' attacking') : m[2], sub);
    if (!inner) return null;
    if (naming) {
      let tagged = false;
      for (const e of inner) if (e.kind === 'createToken' && e.attacking) { e.attackingPlayer = { ref: 'iter' }; tagged = true; }
      if (!tagged) return null;
    }
    return [{ kind: 'forEach', over: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: inner }];
  }],
  [/^the ring tempts you$/i, () => [{ kind: 'ringTempts' }]],
  [/^you take the initiative$/i, () => [{ kind: 'takeInitiative' }]],
  [/^(.+?) takes the initiative$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'takeInitiative', who }] : null;
  }],
  [/^roll a (?:d(\d+)|six-sided die|twenty-sided die)$/i, (m) => [{ kind: 'rollDie', sides: m[1] ? parseInt(m[1], 10) : /six/i.test(m[0]) ? 6 : 20, results: [] }]],
  [/^exile this saga, then return it to the battlefield transformed under your control$/i, () => [{ kind: 'exile', what: SELF }, { kind: 'returnToBattlefield', what: SELF, transformed: true }]],
  [/^(?:you may )?cast (.+?)(?:, and mana of any type can be spent to cast (?:that spell|it))?$/i, (m, ctx) => {
    if (/without paying/i.test(m[0])) return null;
    const anyMana = /mana of any type/i.test(m[0]);
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'castFrom', what: ref, anyManaType: anyMana }] : null;
  }],
  // Discard
  [/^(?:(.+?) )?discards? (?:a|an|one or more|(\w+|X)) ((?:[\w-]+ )+cards?)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n: Amount = /one or more/i.test(m[0]) ? 1 : m[2] ? (m[2] === 'X' ? 'X' : wordToNumber(m[2]) ?? 1) : 1;
    return [{ kind: 'discard', amount: n, who, filter: { ...noun.filter, zone: undefined } }];
  }],
  [/^(?:(.+?) )?discards? (?:(\w+|X) cards?|a card)( at random)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    return who && n !== null ? [{ kind: 'discard', amount: n, who, random: !!m[3] }] : null;
  }],
  [/^(?:(.+?) )?discards? (?:all (?:the )?cards in (?:their|your) hand|their hands)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'discard', amount: 'hand', who }] : null;
  }],
  [/^(?:(.+?) )?discards? (?:their|your) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'discard', amount: 'hand', who }] : null;
  }],
  [/^(.+?) adds? (?:an additional )?(.+)$/i, (m, ctx) => {
    if (/^add$/i.test(m[1])) return null;
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const inner = parseSentence(`add ${m[2]}`, ctx);
    if (!inner || !inner.every((e) => e.kind === 'addMana' || e.kind === 'chooseMode')) return null;
    return inner.map((e) => (e.kind === 'addMana' ? { ...e, who } : e));
  }],
  [/^add an additional (.+)$/i, (m, ctx) => parseSentence(`add ${m[1]}`, ctx)],
  [/^add (?:an additional )?one mana of any type that (?:land|permanent|creature|artifact) produced$/i, () => [{ kind: 'addMana', mana: 'triggerMana' }]],
  [/^(.+?) adds? (?:an additional )?one mana of any type that (?:land|permanent|creature|artifact) produced$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'addMana', mana: 'triggerMana', who }] : null;
  }],
  // "Add one mana of any type that a land you control could produce."
  [/^add (\w+|X) mana of any type that (?:a|an) .+? could produce$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'addMana', mana: 'anyColor', amount: n }];
  }],
  // Mana
  // "Add {G} for each Elf you control" (Priest of Titania, Elvish Archdruid)
  [/^add ((?:\{[WUBRGC]\})+) for each (.+)$/i, (m, ctx) => {
    const mana = [...m[1].matchAll(/\{([WUBRGC])\}/g)].map((x) => x[1] as ManaColor);
    const amount = amt(`the number of ${m[2]}`, ctx) ?? amt(m[2], ctx);
    return amount === null ? null : [{ kind: 'addMana', mana, amount }];
  }],
  // "add {G} and you gain 1 life" (Selvala, Explorer Returned)
  [/^add ((?:\{[WUBRGC]\})+) and (.+)$/i, (m, ctx) => {
    const mana = [...m[1].matchAll(/\{([WUBRGC])\}/g)].map((x) => x[1] as ManaColor);
    const rest = parseSentence(m[2], ctx);
    return rest ? [{ kind: 'addMana', mana }, ...rest] : null;
  }],
  [/^add (.+)$/i, (m) => {
    const body = m[1];
    let mm: RegExpMatchArray | null;
    if ((mm = body.match(/^(\w+|X) mana of any one color$/i)) || (mm = body.match(/^(\w+|X) mana in any combination of colors$/i))) {
      const n = wordToNumber(mm[1]);
      return n === null ? null : [{ kind: 'addMana', mana: 'anyColor', amount: n }];
    }
    if ((mm = body.match(/^(\w+|X) mana of any color$/i))) {
      const n = wordToNumber(mm[1]);
      return n === null ? null : [{ kind: 'addMana', mana: 'anyColor', amount: n }];
    }
    if (/^(?:\w+|X) mana of any of ~'s colors$/i.test(body) || /mana of any color in your commander's color identity/i.test(body)) return [{ kind: 'addMana', mana: 'commanderColors' }];
    const alts = parseAddManaText(`Add ${body}.`);
    if (alts.length === 1) return [{ kind: 'addMana', mana: alts[0] }];
    if (alts.length > 1) {
      // "Add {G} or {W}" → choose among alternatives
      return [{ kind: 'chooseMode', options: alts.map((a) => ({ text: `Add ${a.map((c) => `{${c}}`).join('')}`, effects: [{ kind: 'addMana', mana: a }] })) }];
    }
    return null;
  }],
  // Counter
  [/^counter (that spell|the spell|it)(?: unless (?:its controller|that player|they|the controller|that spell's controller) pays? (\{.+\}|\d+))?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' as const } : /the spell/i.test(m[1]) ? { ref: 'stackTarget' as const } : null);
    if (!ref) return null;
    const pays = m[2] ? (/^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2]) : undefined;
    return [{ kind: 'counterSpell', what: ref, unlessPays: pays }];
  }],
  [/^counter (.+?)(?: unless (?:its controller|that player|they|the controller|that spell's controller|that ability's controller) pays? (\{.+\}|\d+))?$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    if (noun.kind !== 'spell' && noun.kind !== 'activatedOrTriggered' && noun.kind !== 'spellOrAbility') return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    const pays = m[2] ? (/^\d+$/.test(m[2]) ? `{${m[2]}}` : m[2]) : undefined;
    return [{ kind: 'counterSpell', what: ref, unlessPays: pays }];
  }],
  // Search
  [/^search (your|their|that player's|target player's|target opponent's) library for (?:a|an|up to (that many|\w+)|(?:any number of)) (.+?)(?:, reveal (?:it|them|that card|those cards))?,?(?: and| then)? (?:(?:reveal (?:it|them),? )?(?:then )?shuffle,? and )?(?:put (?:it|them|that card|those cards|the rest) (into (?:your|their) hand|onto the battlefield(?: under your control)?( tapped)?|on top(?: of (?:your|their) library)?|into (?:your|their) graveyard)|(exile) (?:it|them|that card|those cards)(?: face down)?)(?:, then shuffle| and shuffle|, then shuffle (?:your|their) library)?(?:\. then shuffle)?$/i, (m, ctx) => {
    const nounText = m[3].replace(/ cards$/i, ' card');
    const noun = /^cards?$/i.test(m[3]) ? { filter: {} as ObjectFilter } : parseNoun(/\bcards?\b/i.test(nounText) ? nounText : `${nounText} card`);
    ctx.lastObj = { ref: 'lastMoved' };
    if (!noun) return null;
    // "up to that many": what the previous sentence sacrificed/discarded (Scapeshift), else the trigger's amount.
    const n: Amount | null = m[2] ? (/that many/i.test(m[2]) ? (ctx.lastObj && !ctx.triggerHasObject && !ctx.triggerHasPlayer ? { kind: 'countRef', ref: ctx.lastObj } : { kind: 'triggerAmount' }) : wordToNumber(m[2])) : /any number of/i.test(m[0]) ? 20 : 1;
    if (n === null) return null;
    const whose = m[1].toLowerCase();
    let who: Ref | undefined;
    if (whose.startsWith('target')) {
      who = playerRef(whose.replace(/'s$/, ''), ctx) ?? undefined;
      if (!who) return null;
    } else if (whose !== 'your') {
      who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : undefined);
      if (!who) return null;
    }
    const dest = m[6] ? 'exile' : /hand/.test(m[4]) ? 'hand' : /battlefield/.test(m[4]) ? 'battlefield' : /top/.test(m[4]) ? 'top' : 'graveyard';
    // Bribery: searching another player's library and putting the card "onto the battlefield under your control".
    const yours = who && dest === 'battlefield' && /under your control/i.test(m[0]);
    return [{ kind: 'searchLibrary', who, filter: { ...noun.filter, zone: 'library' }, count: n, destination: dest, tapped: !!m[5], reveal: /reveal/i.test(m[0]), shuffle: true, ...(yours ? { controller: 'you' as const } : {}) }];
  }],
  [/^search your ((?:library|graveyard|hand)(?:(?:,|,? and|,? and\/or|,? or|\/or) (?:your )?(?:library|graveyard|hand))*) for (?:a|an) (.+?)(?:, reveal (?:it|them|that card),?)?(?:,? and| then)? put (?:it|that card) (into your hand|onto the battlefield( tapped)?)(?:\. if you search your library this way, shuffle| and shuffle| then shuffle|, then shuffle|, then shuffle your library)?$/i, (m, ctx) => {
    const zones = [...new Set((m[1].match(/library|graveyard|hand/gi) ?? []).map((z) => z.toLowerCase()))] as ('library' | 'graveyard' | 'hand')[];
    const nounText = /\bcards?\b/i.test(m[2]) ? m[2] : `${m[2]} card`;
    const noun = parseNoun(nounText.replace(/ cards$/i, ' card'));
    if (!noun || !zones.length) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'searchLibrary', filter: f, count: 1, destination: /hand/.test(m[3]) ? 'hand' : 'battlefield', tapped: !!m[4], reveal: true, shuffle: true, zones }];
  }],
  [/^search your library for up to two (.+?) cards, reveal (?:them|those cards), put one onto the battlefield( tapped)? and the other into your hand(?:, then shuffle)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'battlefield', tapped: !!m[2], reveal: true, shuffle: false }, { kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'hand', reveal: true, shuffle: true }];
  }],
  [/^search your library for (two|\w+) cards, put one into your hand and the other (into your graveyard|onto the battlefield|on top of your library)(?:, then shuffle)?$/i, (m) => {
    ctx0();
    const dest = /graveyard/.test(m[2]) ? 'graveyard' : /battlefield/.test(m[2]) ? 'battlefield' : 'top';
    return [{ kind: 'searchLibrary', filter: { zone: 'library' }, count: 1, destination: 'hand', shuffle: false }, { kind: 'searchLibrary', filter: { zone: 'library' }, count: 1, destination: dest, shuffle: true }];
  }],
  // ---- Round 105 search variants ----
  // "search your library for a Curse card, put it onto the battlefield attached to target player, then shuffle"
  [/^search your library for (?:a|an) (.+?), put (?:it|that card) onto the battlefield attached to (.+?)(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1] : `a ${m[1]} card`);
    if (!noun) return null;
    const host = objRef(m[2], ctx);
    if (!host) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [
      { kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'battlefield', shuffle: true },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host },
    ];
  }],
  // "Search your library for X cards, then shuffle and put those cards on top in any order"
  [/^search your library for (any number of|up to \w+|X|\w+) (.*?)cards?(?:, reveal (?:it|them))?,? (?:then )?shuffle and put (?:them|those cards|it) on top(?: of your library)?(?: in any order)?$/i, (m, ctx) => {
    const nounText = m[2].trim();
    const noun = nounText ? parseNoun(`a ${nounText} card`) : { filter: {} as ObjectFilter };
    if (!noun) return null;
    const n: Amount | null = /any number of/i.test(m[1]) ? 20 : m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1].replace(/^up to /i, '')) as Amount | null);
    if (n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: n, destination: 'top', reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
  // "Search your library for a Zombie card and a Swamp card, reveal them, put them into your hand, then shuffle"
  // "Search your library for a white card, a blue card, ... and a green card, reveal them, put them into your hand, then shuffle"
  [/^search your library (?:and(?:\/or)? graveyard )?for ((?:a|an) [^,]+?(?:, (?:a|an) [^,]+?)*,? and (?:a|an) [^,]+?)(?:, reveal (?:it|them|those cards))?(?:,? (?:and )?put (?:it|them|those cards) (into your hand|onto the battlefield( tapped)?))?(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const zones: ('library' | 'graveyard')[] | undefined = /graveyard/i.test(m[0]) ? ['library', 'graveyard'] : undefined;
    const items = m[1].split(/,\s*and\s+|\s+and\s+|,\s*/i).map((x) => x.trim()).filter(Boolean);
    if (items.length < 2 || items.length > 6) return null;
    const out: Effect[] = [];
    for (let i = 0; i < items.length; i++) {
      const noun = parseNoun(/\bcards?\b/i.test(items[i]) ? items[i] : `${items[i]} card`);
      if (!noun || !noun.confident) return null;
      const dest = m[2] && /battlefield/i.test(m[2]) ? 'battlefield' : 'hand';
      out.push({ kind: 'searchLibrary', filter: { ...noun.filter, zone: zones ? undefined : 'library' }, zones, count: 1, destination: dest, tapped: m[3] ? true : undefined, reveal: /reveal/i.test(m[0]), shuffle: i === items.length - 1 });
    }
    ctx.lastObj = { ref: 'lastMoved' };
    return out;
  }],
  // "Search your library for a creature card, reveal it, put it into your hand or graveyard, then shuffle"
  [/^search your library for (?:a|an) (.+?), reveal it, put it into your (hand|graveyard) or (?:hand|graveyard)(?:, then shuffle)?$/i, (m, ctx) => {
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1] : `a ${m[1]} card`);
    if (!noun) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: m[2].toLowerCase() as 'hand', reveal: true, shuffle: true }];
  }],
  // "Search your library for a card with the same name as that card, reveal it, put it into your hand, then shuffle"
  [/^search your library for (?:(?:a|an)|(up to \w+|any number of|\w+)) (.*?)cards? with the same name as (.+?)(?:, reveal (?:it|them|that card|those cards))?,? put (?:it|them|that card|those cards) (into your hand|onto the battlefield( tapped)?|into your graveyard)(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const base = m[2].trim();
    const noun = base ? parseNoun(`a ${base} card`) : { filter: {} as ObjectFilter };
    if (!noun) return null;
    const of = objRef(m[3], ctx);
    if (!of) return null;
    let count = 1;
    if (m[1]) {
      if (/any number of/i.test(m[1])) count = 99;
      else {
        const n = wordToNumber(m[1].replace(/^up to /i, ''));
        if (typeof n !== 'number') return null;
        count = n;
      }
    }
    ctx.lastObj = { ref: 'lastMoved' };
    const dest = /battlefield/i.test(m[4]) ? 'battlefield' : /graveyard/i.test(m[4]) ? 'graveyard' : 'hand';
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library', sameNameAs: of }, count, destination: dest, tapped: m[5] ? true : undefined, reveal: /reveal/i.test(m[0]), shuffle: true }];
  }],
  [/^(?:then )?shuffle(?: your library)?$/i, () => [{ kind: 'shuffle' }]],
  [/^(?:then )?(.+?) shuffles?(?: their library)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'shuffle', who }] : null;
  }],
  // Control
  [/^gain control of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'gainControl', what: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  [/^exchange control of (.+?) and (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = objRef(m[2], ctx);
    return a && b ? [{ kind: 'exchangeControl', a, b }] : null;
  }],
  // Fight / bite
  [/^(.+?) fights (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = objRef(m[2], ctx);
    return a && b ? [{ kind: 'fight', a, b }] : null;
  }],
  // Copy
  [/^copy (target (?:activated or triggered|activated|triggered) ability(?: you control| an opponent controls| you do ?n[o']t control)?(?: from an? \w+ source)?)(?:\. You may choose new targets for the copy)?$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || noun.kind !== 'activatedOrTriggered') return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'copySpell', what: ref }];
  }],
  // "Change the target of target spell with a single target."
  [/^change the targets? of (target (?:spell|spell or ability|activated or triggered ability)(?: with a single target)?)$/i, (m, ctx) => {
    const noun = parseNoun(m[1].replace(/ with a single target$/i, ''));
    if (!noun || !noun.target) return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'changeTargets', what: ref }];
  }],
  [/^copy (.+?)(?:,? except (?:that )?the copy is (?:white|blue|black|red|green|colorless|not legendary|legendary))?(?:\. You may choose new targets for the copy)?$/i, (m, ctx) => {
    // "copy that ability": the activated or triggered ability on the stack, not the permanent that has it.
    if (/^(?:that|the) (?:activated |triggered |activated or triggered )?ability$/i.test(m[1])) return [{ kind: 'copySpell', what: { ref: 'triggerStackItem' } }];
    const isCard = /\bcards?\b|^(?:the exiled card|that card|the revealed card|it)$/i.test(m[1]) && !/\bspell\b/i.test(m[1]);
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    if (isCard) {
      ctx.lastObj = { ref: 'lastCreated' };
      return [{ kind: 'copyCard', what: ref }];
    }
    return [{ kind: 'copySpell', what: ref }];
  }],
  [/^(?:you may )?cast the cop(?:y|ies)(?: without paying (?:its|their) mana costs?)?$/i, (m) => [{ kind: 'may', effects: [/without paying/i.test(m[0]) ? { kind: 'castWithoutPaying', what: { ref: 'lastCreated' } } : { kind: 'castFrom', what: { ref: 'lastCreated' } }] }]],
  // Attach
  [/^attach (.+) to (.+?)$/i, (m, ctx) => {
    // Resolve the host first: "attach ~ to it" must not let "~" become the antecedent of "it" (dozens of
    // "create a token, then attach ~ to it" Equipment attached themselves to themselves).
    // Targets register in the card's order, but the host's pronoun ("attach ~ to it", "attach target Equipment
    // to that creature") refers to what was in scope before this sentence, not to the thing being attached.
    const savedLast = ctx.lastObj;
    const a = objRef(m[1], ctx);
    ctx.lastObj = savedLast;
    const b = a ? objRef(m[2], ctx) : null;
    if (a && b) ctx.lastObj = b;
    return a && b ? [{ kind: 'attach', what: a, to: b }] : null;
  }],
  [/^transform (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'transform', what: ref }] : null;
  }],
  [/^goad (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'goad', what: ref }] : null;
  }],
  [/^regenerate (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'regenerate', what: ref }] : null;
  }],
  [/^(.+?) phases? out$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'phaseOut', what: ref }] : null;
  }],
  [/^you become the monarch$/i, () => [{ kind: 'becomeMonarch' }]],
  [/^(.+?) becomes the monarch$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'becomeMonarch', who }] : null;
  }],
  [/^(?:you )?take an extra turn after this one$/i, () => [{ kind: 'extraTurn' }]],
  [/^(.+?) takes an extra turn after this one$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'extraTurn', who }] : null;
  }],
  [/^you win the game$/i, () => [{ kind: 'winGame' }]],
  [/^you lose the game$/i, () => [{ kind: 'loseGame' }]],
  [/^(.+?) los(?:es|e) the game$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'loseGame', who }] : null;
  }],
  // Prevention
  [/^prevent all (combat |noncombat )?damage that would be dealt(?: to (.+?))? this turn(?: by (.+))?$/i, (m, ctx) => {
    const combat = /^combat/i.test(m[1] ?? '');
    let source: ObjectFilter | undefined;
    const pre: Effect[] = [];
    if (m[3] && /^sources of the color of your choice$/i.test(m[3])) {
      pre.push({ kind: 'chooseColor', key: 'color' });
      source = { chosenColor: true };
    } else if (m[3] && /^creatures blocking (?:it|~)$/i.test(m[3])) source = { types: ['Creature'], blockingSource: true };
    else if (m[3]) {
      const st = m[3].replace(/\bsources\b/i, 'permanents').replace(/\bsource\b/i, 'permanent');
      const sn = parseNoun(st) ?? parseNoun(`a ${st}`);
      if (!sn) return null;
      source = { ...sn.filter, zone: undefined };
    }
    let to: Extract<Effect, { kind: 'preventAll' }>['to'] = 'all';
    if (m[2]) {
      const l = m[2].toLowerCase();
      if (l === 'you') to = 'you';
      else if (l === 'you and planeswalkers you control' || l === 'you and each planeswalker you control') to = 'youAndPlaneswalkersYouControl';
      else if (l === 'you and creatures you control' || l === 'you and permanents you control') to = 'youAndCreaturesYouControl';
      else if (l === 'creatures you control') to = 'creaturesYouControl';
      else if (l === 'players' || l === 'each player') to = 'players';
      else if (l === 'creatures') to = 'creatures';
      else {
        const noun = parseNoun(m[2]);
        if (noun && (noun.each || noun.plural)) to = noun.filter;
        else {
          const ref = anyRef(m[2], ctx);
          if (!ref) return null;
          if (source || combat) return [...pre, { kind: 'preventAll', combat, source, to: 'all', toRef: ref }];
          return [{ kind: 'preventDamage', amount: 'all', to: ref, duration: 'endOfTurn' }];
        }
      }
    }
    if (/^noncombat/i.test(m[1] ?? '')) return null;
    return [...pre, { kind: 'preventAll', combat, source, to }];
  }],
  [/^prevent all (combat )?damage that would be dealt by (.+?) this turn$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  [/^prevent all (combat )?damage (?:that )?(.+?) would deal this turn$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    // Source-specific: remember the object as the prevention's source filter via a chosen ref is not expressible; use a rule on the source.
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^the next time (?:a|an) (?:(\w+) )?source of your choice would deal damage to you this turn, prevent that damage$/i, (m) => {
    const c = m[1] ? ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1].toLowerCase() as 'white'] : undefined;
    const source: ObjectFilter | undefined = m[1] ? (c ? { colors: [c] } : /^artifact$/i.test(m[1]) ? { types: ['Artifact'] } : undefined) : undefined;
    if (m[1] && !source) return null;
    return [{ kind: 'preventAll', to: 'you', source, once: true }];
  }],
  [/^the next time (.+?) would deal damage this turn, prevent that damage$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'preventAll', to: 'all', sourceRef: ref, once: true }] : null;
  }],
  // "Until end of turn, target player cannot cast instant or sorcery spells"
  [/^(.+?) cannot cast (.+?)(?: until end of turn| this turn)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const data: Record<string, unknown> = {};
    if (!/^spells$/i.test(m[2])) {
      const noun = /^spells? /i.test(m[2]) ? parseNoun(`a spell ${m[2].replace(/^spells? /i, '')}`) : parseNoun(`a ${m[2].replace(/ spells?$/i, '')} spell`);
      if (!noun) return null;
      data.filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantCastSpells', data }, on: who, duration: / until end of turn$| this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(.+?) cannot activate abilities(?: that are not mana abilities| that aren't mana abilities)?(?: until end of turn| this turn)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantActivateAbilities', data: /mana abilities/i.test(m[0]) ? { exceptMana: true } : {} }, on: who, duration: / until end of turn$| this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  // "you may pay {1}. If you do, copy that ability."
  // Narset: "Until end of turn, you may cast noncreature spells from among those cards without paying their mana costs."
  [/^(?:until end of turn, )?you may cast (noncreature|instant and sorcery|instant or sorcery|instant|sorcery|creature|noncreature, nonland) spells from among (?:those cards|them|the exiled cards)(?: this turn| until end of turn)? without paying their mana costs?(?: this turn| until end of turn)?$/i, (m, ctx) => {
    const k = m[1].toLowerCase();
    const filter: ObjectFilter = k === 'noncreature' ? { notTypes: ['Creature'] } : k === 'noncreature, nonland' ? { notTypes: ['Creature'], nonland: true } : /instant (?:and|or) sorcery/.test(k) ? { types: ['Instant', 'Sorcery'] } : { types: [k.charAt(0).toUpperCase() + k.slice(1)] };
    const pool: Ref = ctx.restKey ? { ref: 'chosen', key: ctx.restKey } : { ref: 'lastMoved' };
    return [{ kind: 'playFromExile', what: pool, duration: 'thisTurn', free: true, filter }];
  }],
  // Angel's Grace: "You can't lose the game this turn and your opponents can't win the game this turn."
  [/^you cannot lose the game this turn and your opponents cannot win the game this turn$/i, () => [
    { kind: 'grantPlayerRule', rule: { kind: 'cantLose' }, duration: 'thisTurn' },
    { kind: 'grantPlayerRule', who: { ref: 'eachOpponent' }, rule: { kind: 'custom', tag: 'cantWin' }, duration: 'thisTurn' },
  ]],
  // "Until end of turn, damage that would reduce your life total to less than 1 reduces it to 1 instead."
  [/^(?:until end of turn, )?damage that would reduce your life total to less than (\d+) reduces it to \1 instead(?: until end of turn| this turn)?$/i, (m) => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'lifeFloor', data: parseInt(m[1], 10) }, duration: 'thisTurn' }]],
  // Teferi's Protection: "Until your next turn, your life total can't change and you gain protection from everything."
  [/^(?:until your next turn, )?your life total cannot change and you gain protection from everything(?: until your next turn)?$/i, () => [
    { kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'lifeCantChange' }, duration: 'untilYourNextTurn' },
    { kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'protectionFromEverything' }, duration: 'untilYourNextTurn' },
  ]],
  // Gyruda: "Put a creature card with an even mana value from among the milled cards onto the battlefield under your control."
  [/^put (?:a|an|up to one) (.+?) from among (?:the milled cards|the cards milled this way|them|those cards) onto the battlefield( tapped)?(?: under your control)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const key = `pick_${Math.random().toString(36).slice(2, 6)}`;
    const pool: Ref = ctx.restKey ? { ref: 'chosen', key: ctx.restKey } : ctx.lastObj ?? { ref: 'lastMoved' };
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, from: pool, filter: { ...noun.filter, zone: undefined }, count: 1, key, upTo: true },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'you', ...(m[2] ? { tapped: true } : {}) },
    ];
  }],
  // Yidris: "as you cast spells from your hand this turn, they gain cascade"
  [/^as you cast spells from your hand this turn, they gain cascade$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'spellsGainCascade' }, duration: 'thisTurn' }]],
  // Feather: "exile that card instead of putting it into your graveyard as it resolves"
  [/^exile (?:that card|that spell|it) instead of putting it into (?:your|its owner's) graveyard as it resolves$/i, () => [{ kind: 'setMemory', key: 'exileOnResolve', value: true, on: { ref: 'triggerObject' } }]],
  // Chrome Mox: "Add one mana of any of the exiled card's colors."
  [/^add one mana of any of the exiled card's colou?rs$/i, () => [{ kind: 'addMana', mana: 'exiledColors' }]],
  // Thousand-Year Storm: "copy it for each other instant and sorcery spell you've cast before it this turn"
  [/^copy (?:it|that spell) for each other (instant and sorcery|instant or sorcery|instant|sorcery|creature|noncreature) spell you(?:'ve| have) cast before it this turn(?:\. you may choose new targets for the cop(?:y|ies))?$/i, (m) => {
    const kind = m[1].toLowerCase();
    const filter: ObjectFilter = /instant (?:and|or) sorcery/.test(kind) ? { types: ['Instant', 'Sorcery'] } : kind === 'noncreature' ? { notTypes: ['Creature'] } : { types: [kind.charAt(0).toUpperCase() + kind.slice(1)] };
    return [{ kind: 'copySpell', what: { ref: 'stackTarget' }, count: { kind: 'sum', parts: [{ kind: 'eventsThisTurn', event: 'cast', player: 'you', filter }, -1] } }];
  }],
  // Bonus Round: "that player copies it and may choose new targets for the copy"
  [/^(that player|its controller|you) cop(?:y|ies) (?:it|that spell)(?: and may choose new targets for the copy)?$/i, (m, ctx) => {
    const who: Ref = /^you$/i.test(m[1]) ? YOU : m[1].toLowerCase() === 'its controller' ? { ref: 'controllerOf', of: { ref: 'stackTarget' } } : ctx.lastPlayer ?? { ref: 'triggerPlayer' };
    return [{ kind: 'copySpell', what: { ref: 'stackTarget' }, controller: who }];
  }],
  [/^copy (?:that|the) (?:ability|spell or ability)(?: for each (.+))?$/i, (m, ctx) => {
    void ctx;
    if (m[1]) return null;
    return [{ kind: 'copySpell', what: { ref: 'triggerStackItem' } }];
  }],
  [/^copy (?:that|the) (?:activated or triggered )?ability\. you may choose new targets for the copy$/i, () => [{ kind: 'copySpell', what: { ref: 'triggerStackItem' } }]],
  [/^(?:you )?choose (?:one|(\w+)) of (?:them|those cards|those creatures|the exiled cards)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const pool = ctx.restKey ? { ref: 'chosen' as const, key: ctx.restKey } : ctx.lastObj ?? { ref: 'lastMoved' as const };
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', from: pool, filter: {}, count: n as Amount, key }];
  }],
  [/^choose another player$/i, (_m, ctx) => {
    ctx.lastPlayer = { ref: 'chosen', key: 'player' }; // "That player gains control of …" (Discerning Financier)
    return [{ kind: 'choosePlayer', key: 'player', who: 'opponent' }];
  }],
  [/^choose (?:a|an) (?:[\w, -]+ )?(?:card|creature card|artifact card|nonland card|land card) name(?: other than .+)?$/i, () => [{ kind: 'nameCard', key: 'cardName' }]],
  [/^choose a permanent type$/i, () => [{ kind: 'chooseCreatureType', key: 'cardType', pool: 'cardType' }]],
  // "Choose a Dwarf you control." / "Choose a nonlegendary creature on the battlefield."
  [/^choose (?:a|an|(\w+)) ((?:(?!counter\b)[\w' -])+?)(?: on the battlefield)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || !noun.confident || noun.target || noun.isCard || n === null) return null;
    ctx.lastObj = { ref: 'chosen', key: 'chosen' };
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' }, count: n, key: 'chosen' }];
  }],
  [/^end the turn$/i, () => [{ kind: 'endTurn' }]],
  // "Choose any target." (a later sentence refers to it)
  [/^choose (?:any target|another target)$/i, (m, ctx) => {
    ctx.targets.push({ description: 'any target', kind: 'any', playerFilter: 'any' });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.anyTarget = ctx.lastObj;
    return [];
  }],
  // "Double ~'s power until end of turn."
  [/^double (~'s|its|that creature's|target creature's|equipped creature's|enchanted creature's) (power|toughness|power and toughness)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^(?:~'s|its)$/i.test(m[1]) ? SELF : objRef(m[1].replace(/'s$/, ''), ctx);
    if (!ref) return null;
    const stat = /and/i.test(m[2]) ? 'both' : (m[2].toLowerCase() as 'power' | 'toughness');
    return [{ kind: 'doubleStat', on: ref, stat, duration: 'endOfTurn' }];
  }],
  // "You may cast spells this turn as though they had flash."
  [/^you may cast (.+?) this turn as though (?:they|it) had flash$/i, (m) => {
    if (/^spells$/i.test(m[1])) return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash' } }];
    const parts = m[1].split(/ and /i).map((x) => parseNoun(x.replace(/ spells?$/i, ' spell')));
    if (!parts.every((x) => x)) return null;
    const f = parts.length === 1 ? { ...parts[0]!.filter, zone: undefined } : { anyOf: parts.map((x) => ({ ...x!.filter, zone: undefined })) };
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: f } } }];
  }],
  // "Any player may sacrifice a land of their choice. If a player does, X"
  [/^any (?:player|opponent) may sacrifice (?:a|an) (.+?) of (?:their|his or her) choice$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    return noun ? [{ kind: 'anyPlayerMaySacrifice', filter: { ...noun.filter, zone: 'battlefield' } }] : null;
  }],
  // "Target creature cannot be regenerated this turn."
  [/^(.+?) cannot be regenerated this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'cantRegenerate' }, duration: 'endOfTurn' }] : null;
  }],
  // "if you have fewer than seven cards in hand, draw cards equal to the difference"
  [/^if you have fewer than (\w+) cards in hand,? draw cards equal to the difference$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'draw', amount: { kind: 'minus', a: n, b: { kind: 'handSize', ref: YOU } } }];
  }],
  // "you get six {E}"
  [/^(?:you|that player|target player|each player|each opponent) gets? ((?:\{E\})+|\w+|that many) \{E\}$/i, (m, ctx) => {
    const n = /^\{E\}/.test(m[1]) ? (m[1].match(/\{E\}/g) ?? []).length : /that many/i.test(m[1]) ? ({ kind: 'triggerAmount' } as Amount) : wordToNumber(m[1]);
    if (n === null) return null;
    const who = playerRef(m[0].replace(/ gets? .*$/i, ''), ctx) ?? YOU;
    return [{ kind: 'addCounters', counter: 'energy', amount: n, on: who }];
  }],
  // "Exile that many cards from the top of your library." / "look at that many cards from the top of your library"
  [/^(exile|look at|mill|reveal) (that many|\w+|X) cards? from the top of (your|their|that player's) library(?: face down)?$/i, (m, ctx) => {
    const n: Amount | null = /that many/i.test(m[2]) ? { kind: 'triggerAmount' } : wordToNumber(m[2]);
    if (n === null) return null;
    const who: Ref = /^your$/i.test(m[3]) ? YOU : ctx.lastPlayer ?? YOU;
    const v = m[1].toLowerCase();
    if (v === 'mill') return [{ kind: 'mill', amount: n, who }];
    if (v === 'exile') {
      ctx.lastObj = { ref: 'lastMoved' };
      return [{ kind: 'exileTop', amount: n, who }];
    }
    ctx.lastObj = { ref: 'memory', key: 'looked' };
    return [{ kind: 'lookAtTop', amount: n, who, reveal: v === 'reveal', then: 'hold', key: 'looked' }];
  }],
  // "sacrifice all Dragons you control"
  [/^sacrifice all (.+)$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(m[1]);
    if (!noun) return null;
    return [{ kind: 'sacrifice', what: { ref: 'all', filter: { ...noun.filter, controller: noun.filter.controller ?? 'you', zone: 'battlefield' } } }];
  }],
  // "Target land gains \"{T}: Add {C}{C}\" until ~ is cast from exile."
  [/^(.+?) gains? "(.+)" until ~ is cast from exile$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'grantAbility', text: m[2], on: ref, duration: 'permanent' }] : null;
  }],
  [/^discard any number of cards( at random)?$/i, (m) => [{ kind: 'discard', amount: 'hand', who: YOU, random: m[1] ? true : undefined }]],
  [/^(?:you )?discard up to (\w+) cards?, then draw that many cards$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    return [{ kind: 'discard', amount: n, who: YOU }, { kind: 'draw', amount: { kind: 'discardedThisWay', ref: YOU } }];
  }],
  [/^suspect (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'suspect', what: ref }] : null;
  }],
  [/^add (\w+) mana of different colors$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'addManaDifferentColors', amount: n }];
  }],
  [/^untap (~|it|that creature|that permanent) and remove it from combat$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? ctx.lastObj;
    return ref ? [{ kind: 'untap', what: ref }, { kind: 'removeFromCombat', what: ref }] : null;
  }],
  [/^~ has all activated abilities of (.+)$/i, (m) => {
    const noun = parseNoun(m[1]);
    return noun ? [{ kind: 'grantAllActivatedAbilities', on: SELF, from: { ...noun.filter, zone: 'battlefield' }, duration: 'permanent' }] : null;
  }],
  [/^you have no maximum hand size for the rest of the game$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'noMaxHandSize' } }]],
  // "Prevent all damage that would be dealt this turn to creatures you control."
  [/^prevent all damage that would be dealt this turn to (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    if (ref) return [{ kind: 'preventAll', to: 'all', toRef: ref }];
    const noun = parseNoun(m[1]);
    return noun ? [{ kind: 'preventAll', to: { ...noun.filter, zone: 'battlefield' } }] : null;
  }],
  // "Prevent all damage a red source of your choice would deal this turn."
  [/^prevent all damage (?:a|an) (.+?) of your choice would deal this turn$/i, (m) => {
    const st = m[1].replace(/\bsources?\b/i, 'permanent');
    const noun = /^permanent$/i.test(st) ? { filter: {} } : parseNoun(st) ?? parseNoun(`a ${st}`);
    return noun ? [{ kind: 'preventAll', to: 'all', source: { ...noun.filter, zone: undefined } }] : null;
  }],
  // "The next time a creature of the chosen type would deal damage to you this turn, prevent that damage."
  [/^the next time (?:a|an) (.+?) would deal damage to (.+?) this turn, prevent that damage$/i, (m, ctx) => {
    const to = objRef(m[2], ctx) ?? playerRef(m[2], ctx);
    return to ? [{ kind: 'preventAll', to: 'all', toRef: to, once: true }] : null;
  }],
  // "Target player reveals a number of cards from their hand equal to X."
  [/^(.+?) reveals? a number of cards from (?:their|his or her) hand equal to (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const a = amt(m[2], ctx);
    if (!who || a === null) return null;
    return [{ kind: 'revealHand', who }];
  }],
  // "The owner of target nonland permanent puts it into their library second from the top or on the bottom."
  [/^the owner of (.+?) puts it into (?:their|his or her) library second from the top or on the bottom$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'topOrBottom', what: ref, second: true }] : null;
  }],
  // "That player shuffles, then draws a card for each card exiled from their hand this way."
  [/^(?:that player|they) shuffles?, then draws a card for each card exiled from (?:their|his or her) hand this way$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    return who ? [{ kind: 'draw', amount: { kind: 'countRef', ref: { ref: 'lastMoved' } }, who }] : null;
  }],
  // "You may choose new targets for target spell or ability."
  [/^(?:you may )?choose new targets for (target spell(?: or ability)?|that spell|it)$/i, (m, ctx) => {
    if (/^(?:that spell|it)$/i.test(m[1])) {
      const r = ctx.lastObj;
      return r ? [{ kind: 'changeTargets', what: r }] : null;
    }
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'changeTargets', what: ref }];
  }],
  // "Prevent all combat damage that would be dealt to and dealt by enchanted creature."
  [/^prevent all (combat )?damage that would be dealt to and dealt by (.+?)(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    return [
      { kind: 'preventAll', combat: !!m[1], to: 'all', toRef: ref },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: / this turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' },
    ];
  }],
  // "Destroy target enchantment and all other enchantments with the same name as that enchantment."
  [/^destroy (target (\w+)) and all other \2s with the same name as that \2$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.target) return null;
    ctx.targets.push(toTargetSpec(noun));
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    const inner = parseNoun(`a ${m[2]}`);
    if (!inner) return null;
    return [
      { kind: 'destroy', what: { ref: 'all', filter: { ...inner.filter, zone: 'battlefield', sameNameAs: ref } } },
      { kind: 'destroy', what: ref },
    ];
  }],
  // "All lands target player controls become 3/3 creatures until end of turn."
  [/^(all|each) (.+?) become (\d+)\/(\d+) (.*?)creatures?(?: that are still lands)?(?: until end of turn)?$/i, (m, ctx) => {
    const noun = parseNoun(`all ${m[2]}`) ?? parseNoun(m[2]);
    if (!noun) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const words = (m[5] ?? '').trim().split(/\s+/).filter(Boolean);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    if (words.some((w) => !/^(white|blue|black|red|green|colorless|artifact|enchantment|land)$/i.test(w) && !/^[A-Z]/.test(w))) return null;
    const on: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    const out: Effect[] = [
      { kind: 'setPT', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on, duration: dur },
      { kind: 'addTypes', types: ['Creature'], subtypes, on, duration: dur },
    ];
    if (colors.length) out.push({ kind: 'setColors', colors, on, duration: dur });
    return out;
  }],
  // "~ deals five times X damage to each of up to X targets." (Crackle with Power)
  [/^(.+?) deals (\w+) times X damage to (.+)$/i, (m, ctx) => {
    const k = wordToNumber(m[2]);
    const src = damageSource(m[1], ctx);
    if (typeof k !== 'number' || !src) return null;
    return damageTo(m[3], { kind: 'times', a: 'X', b: k }, ctx, src);
  }],
  // "Exile all but the bottom card of target player's library." (Nicol Bolas, the Arisen)
  [/^exile all but the bottom card of (.+?)'s library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exileTop', who, amount: { kind: 'minus', a: { kind: 'librarySize', ref: who }, b: 1 } }];
  }],
  // "~ deals twice X damage to target creature."
  [/^(.+?) deals twice (X|\w+) damage to (.+)$/i, (m, ctx) => {
    const a: Amount | null = m[2].toUpperCase() === 'X' ? 'X' : wordToNumber(m[2]);
    if (a === null) return null;
    const r = parseSentence(`${m[1]} deals X damage to ${m[3]}`, ctx);
    return r ? r.map((e) => substituteX(e, { kind: 'times', a, b: 2 })) : null;
  }],
  // Piles ------------------------------------------------------------------
  // "look at the top five cards of your library and separate them into a face-down pile and a face-up pile"
  [/^(?:(.+?) )?looks? at the top (\w+|X) cards of (your|their) library and separates? them into (?:a face-down pile and a face-up pile|two piles)$/i, (m, ctx) => {
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    const by = m[1] ? actorRef(m[1], ctx) : YOU;
    if (!by) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [
      { kind: 'lookAtTop', amount: n, who: YOU, then: 'hold', key: 'piled' },
      { kind: 'separatePiles', what: { ref: 'memory', key: 'piled' }, by, faceUpDown: /face-down/i.test(m[0]) },
    ];
  }],
  // "Reveal the top X plus one cards of your library and separate them into two piles"
  [/^reveal the top (\w+|X)(?: plus one)? cards of your library and separate them into two piles$/i, (m, ctx) => {
    const base = wordToNumber(m[1]);
    if (base === null) return null;
    const n: Amount = / plus one/i.test(m[0]) ? { kind: 'sum', parts: [base, 1] } : base;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [
      { kind: 'lookAtTop', amount: n, who: YOU, reveal: true, then: 'hold', key: 'piled' },
      { kind: 'separatePiles', what: { ref: 'memory', key: 'piled' }, by: YOU },
    ];
  }],
  // "Separate all creature cards in your graveyard into two piles." / "Separate all creatures target player controls into two piles."
  [/^(?:(.+?) )?separates? (?:all|those) (.+?) into two piles$/i, (m, ctx) => {
    const by = m[1] ? actorRef(m[1], ctx) : YOU;
    if (!by) return null;
    const prev = ctx.lastObj;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    if (/^(?:cards|them|those cards)$/i.test(m[2])) return [{ kind: 'separatePiles', what: prev && (prev.ref === 'memory' || prev.ref === 'chosen') ? prev : { ref: 'lastMoved' }, by }];
    const noun = parseNoun(`all ${m[2]}`) ?? parseNoun(m[2]);
    if (!noun) return null;
    return [{ kind: 'separatePiles', what: { ref: 'all', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } }, by }];
  }],
  // "An opponent chooses one of those piles." / "the pile of that player's choice"
  [/^(.+?) chooses one of those piles$/i, (m, ctx) => {
    const by = actorRef(m[1], ctx);
    if (!by) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }];
  }],
  // "Put that pile into your hand and the other into your graveyard."
  [/^put (?:that|one) pile into (your hand|your graveyard|the battlefield)(?: and the (?:other|rest) into (your hand|your graveyard|their owners'? graveyards?))?$/i, (m, ctx) => {
    const dest = (t: string): Effect['kind'] | null => (/hand/i.test(t) ? 'putIntoHand' : /graveyard/i.test(t) ? 'putIntoGraveyard' : 'returnToBattlefield');
    const out: Effect[] = [];
    if (/^put one pile/i.test(m[0])) out.push({ kind: 'choosePile', by: YOU });
    const d1 = dest(m[1]);
    if (!d1) return null;
    out.push({ kind: d1, what: { ref: 'memory', key: 'chosenPile' } } as Effect);
    if (m[2]) {
      const d2 = dest(m[2]);
      if (!d2) return null;
      out.push({ kind: d2, what: { ref: 'memory', key: 'otherPile' } } as Effect);
    }
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return out;
  }],
  // "Look at the cards in the other pile."
  [/^look at the cards in the other pile$/i, (m, ctx) => {
    ctx.lastObj = { ref: 'memory', key: 'otherPile' };
    return [{ kind: 'setMemory', key: 'lookedOther', value: 1 }];
  }],
  // "Destroy all creatures in the pile of that player's choice."
  [/^(destroy|exile|tap) all (?:.+?) in the pile of (that player's|your|an opponent's|its controller's) choice$/i, (m, ctx) => {
    const by = /^your$/i.test(m[2]) ? YOU : m[2].toLowerCase().startsWith('an opponent') ? ({ ref: 'eachOpponent' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const k = m[1].toLowerCase() === 'destroy' ? 'destroy' : m[1].toLowerCase() === 'exile' ? 'exile' : 'tap';
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }, { kind: k, what: { ref: 'memory', key: 'chosenPile' } } as Effect];
  }],
  // "Exile the pile of an opponent's choice and return the other to the battlefield."
  [/^(exile|destroy|tap) the pile of (an opponent's|that player's|your) choice and (?:return|put) the other (?:to|onto) the battlefield$/i, (m, ctx) => {
    const by = /^your$/i.test(m[2]) ? YOU : m[2].toLowerCase().startsWith("an opponent") ? ({ ref: 'eachOpponent' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const k = m[1].toLowerCase() === 'exile' ? 'exile' : m[1].toLowerCase() === 'destroy' ? 'destroy' : 'tap';
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }, { kind: k, what: { ref: 'memory', key: 'chosenPile' } } as Effect, { kind: 'returnToBattlefield', what: { ref: 'memory', key: 'otherPile' }, controller: 'you' }];
  }],
  // "Put all cards from the pile of your choice onto the battlefield under your control and the rest into their owners' graveyards."
  [/^put all cards from the pile of (your|an opponent's|that player's) choice onto the battlefield under your control and the rest into their owners'? graveyards$/i, (m, ctx) => {
    const by = /^your$/i.test(m[1]) ? YOU : m[1].toLowerCase().startsWith("an opponent") ? ({ ref: 'eachOpponent' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [{ kind: 'choosePile', by }, { kind: 'returnToBattlefield', what: { ref: 'memory', key: 'chosenPile' }, controller: 'you' }, { kind: 'putIntoGraveyard', what: { ref: 'memory', key: 'otherPile' } }];
  }],
  // "Double the number of each kind of counter on target permanent."
  [/^double the number of each kind of counter on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'doubleCounters', on: ref }] : null;
  }],
  [/^double the number of each kind of counter (?:you|that player|target player) ha(?:ve|s)$/i, (m, ctx) => {
    const who = playerRef(m[0].replace(/^double the number of each kind of counter /i, '').replace(/ ha(?:ve|s)$/i, ''), ctx) ?? YOU;
    return [{ kind: 'doubleCounters', on: who }];
  }],
  // Licids: "~ loses this ability and becomes an Aura enchantment with enchant creature."
  [/^~ loses this ability and becomes an aura enchantment with enchant (creature|land|permanent|player|artifact)$/i, () => [
    { kind: 'addTypes', types: ['Enchantment'], setTypes: ['Enchantment'], subtypes: ['Aura'], on: SELF, duration: 'permanent' },
  ]],
  // The matching "You may pay {W} to end this effect." is compiled as a separate ability.
  [/^you may pay ((?:\{[^}]+\})+) to end this effect$/i, () => []],
  // "Exile the top three cards of your library. Choose one. You may play that card this turn."
  [/^choose one$/i, (m, ctx) => {
    const from = ctx.lastObj;
    if (!from || (from.ref !== 'lastMoved' && from.ref !== 'memory')) return null;
    ctx.lastObj = { ref: 'chosen', key: 'chosen' };
    return [{ kind: 'chooseObjects', from, filter: {}, count: 1, key: 'chosen' }];
  }],
  // "Your life total becomes 10."
  [/^(your|that player's|target player's|each player's) life total becomes (\d+)$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx);
    return who ? [{ kind: 'setLife', amount: parseInt(m[2], 10), who }] : null;
  }],
  // "Then those creatures fight each other."
  [/^(?:then )?those creatures fight each other$/i, (m, ctx) => {
    if (ctx.targets.length < 2) return null;
    return [{ kind: 'fight', a: { ref: 'target', slot: ctx.targets.length - 2 }, b: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "The player discards that card." (after "choose a card from it")
  [/^(?:the player|that player|they) discards that card$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    const what = ctx.lastObj;
    if (!who || !what) return null;
    return [{ kind: 'discardObjects', what }];
  }],
  // "choose an opponent at random"
  [/^choose an opponent at random$/i, () => [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent', random: true }]],
  // "exile all cards from your hand face down"
  [/^exile all cards from your hand face down$/i, () => [{ kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', owner: 'you' } }, faceDown: true, withSource: true }]],
  // "return all cards you own exiled with ~ to your hand"
  [/^return all cards (?:you own )?exiled with ~ to (?:your|their) hand$/i, () => [{ kind: 'putIntoHand', what: { ref: 'memory', key: 'exiledWith' } }]],
  // "the creature you control gets +1/+0 and gains indestructible until end of turn"
  [/^the creature you (?:control|do not control) (gets?.+)$/i, (m, ctx) => {
    const slot = /do not control/i.test(m[0]) ? ctx.targets.findIndex((t) => t.filter?.controller === 'opponent') : ctx.targets.findIndex((t) => t.filter?.controller === 'you');
    if (slot < 0) return null;
    const sub = { ...ctx, lastObj: { ref: 'target', slot } as Ref };
    return parseSentence(`it ${m[1]}`, sub);
  }],
  // "If that spell would be put into a graveyard, exile it instead."
  [/^if (?:that|a|an) (?:spell|card|instant or sorcery spell)(?: cast this way)? would be put into (?:your|a|its owner's) graveyard, exile it instead$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'exileInsteadOfGraveyard' }, duration: 'permanent' }];
  }],
  // "You may cast a spell from among them without paying its mana cost."
  [/^(?:you may )?cast (?:a|an) (.+?) from among them without paying its mana cost$/i, (m, ctx) => {
    const pool = poolRef(ctx);
    const noun = /^spell$/i.test(m[1]) ? { filter: { nonland: true } as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spell$/i, '')} card`);
    if (!noun) return null;
    const key = `amid${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'may', effects: [{ kind: 'chooseObjects', from: pool, filter: { ...noun.filter, nonland: true }, count: 1, key }, { kind: 'castWithoutPaying', what: { ref: 'chosen', key } }] }];
  }],
  // "You may cast it this turn, and mana of any type can be spent to cast that spell."
  [/^you may cast it this turn(?:, and mana of any type can be spent to cast that spell)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', anyMana: /any type/i.test(m[0]) || undefined }];
  }],
  // "The next sorcery spell you cast this turn can be cast as though it had flash"
  [/^the next (.+?) you cast this turn can be cast as though it had flash$/i, (m) => {
    const noun = parseNoun(`a ${m[1].replace(/ spells?$/i, ' spell')}`);
    if (!noun) return null;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castAsThoughFlash', data: { filter: f } } }];
  }],
  // "you get {E}" with no count
  [/^you get \{E\}$/i, () => [{ kind: 'addCounters', counter: 'energy', amount: 1, on: YOU }]],
  // "You get an amount of {E} equal to its mana value"
  [/^you get an amount of \{E\} equal to (.+)$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a == null ? null : [{ kind: 'addCounters', counter: 'energy', amount: a, on: YOU }];
  }],
  // "Exchange control of two target nonlegendary creatures"
  [/^exchange control of two target (.+?)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/^(\w+)s\b/, '$1')}`) ?? parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const spec = toTargetSpec(noun);
    if (!spec) return null;
    const a = ctx.targets.length;
    ctx.targets.push(spec, { ...spec });
    return [{ kind: 'exchangeControl', a: { ref: 'target', slot: a }, b: { ref: 'target', slot: a + 1 } }];
  }],
  // "Unattach all Equipment from target creature"
  [/^unattach all (Equipment|Auras) from (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'unattach', what: ref }] : null;
  }],
  // "You may put one of those cards back on top of your library"
  [/^(?:you may )?put (?:one|a card) of those cards back on top of your library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'top' }];
  }],
  // "Exile the top four cards of your library in a face-down pile, then exile the top four cards of your library in a face-up pile."
  [/^exile the top (\w+) cards of your library in a face-down pile, then exile the top \1 cards of your library in a face-up pile$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (n === null) return null;
    ctx.lastObj = { ref: 'memory', key: 'chosenPile' };
    return [
      { kind: 'exileTop', amount: { kind: 'times', a: n, b: 2 } as Amount, key: 'piled' },
      { kind: 'separatePiles', what: { ref: 'memory', key: 'piled' }, by: YOU, faceUpDown: true },
    ];
  }],
  // "choose artifact, creature, enchantment, instant, or sorcery" (a card type from a fixed list)
  [/^choose ((?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)(?:, (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle))*(?:,? or (?:artifact|creature|enchantment|instant|sorcery|land|planeswalker|battle)))$/i, () => [{ kind: 'chooseCreatureType', key: 'cardType', pool: 'cardType' }]],
  [/^choose a planeswalker type$/i, () => [{ kind: 'chooseCreatureType', key: 'planeswalkerType' }]],
  // "create a number of 1/1 black Harpy creature tokens with flying equal to your devotion to black"
  [/^create a number of (.+? tokens?(?: named [^,]+?)?(?: with .+?)?) equal to (.+)$/i, (m, ctx) => {
    const t = parseTokenPhrase(`a ${m[1].replace(/ tokens$/i, ' token')}`);
    const a = amt(m[2], ctx);
    if (!t || a === null) return null;
    ctx.lastObj = { ref: 'lastCreated' };
    return [{ kind: 'createToken', token: t.token, count: a }];
  }],
  // "put a number of +1/+1 counters equal to its power on each creature you control named ~"
  [/^put a number of ([+-]\d\/[+-]\d|\w+) counters equal to (.+?) on (.+)$/i, (m, ctx) => {
    const a = amt(m[2], ctx);
    const on = objRef(m[3], ctx);
    if (a === null || !on) return null;
    return [{ kind: 'addCounters', counter: m[1], amount: a, on }];
  }],
  // "put it into its owner's library third from the top"
  [/^(?:you may )?put it into its owner's library (second|third|fourth) from the top$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? SELF;
    const pos = ({ second: 1, third: 2, fourth: 3 } as Record<string, number>)[m[1].toLowerCase()];
    const e: Effect = { kind: 'putOnLibrary', what: ref, position: 'top', depth: pos };
    return [/^you may /i.test(m[0]) ? { kind: 'may', effects: [e] } : e];
  }],
  [/^put up to (X|\w+) ([+-]\d\/[+-]\d|\w+) counters on (.+)$/i, (m, ctx) => {
    const n: Amount | null = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    const on = /^~$/i.test(m[3]) ? SELF : objRef(m[3], ctx);
    if (n === null || !on) return null;
    return [{ kind: 'addCounters', counter: m[2], amount: n, on, upTo: true }];
  }],
  [/^put your commander into your hand from the command zone$/i, () => [{ kind: 'putIntoHand', what: { ref: 'all', filter: { zone: 'command', owner: 'you', isCommander: true } } }]],
  [/^each player shuffles their hand and graveyard into their library$/i, () => [
    { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'hand', to: 'library' },
    { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'library' },
    { kind: 'shuffle', who: { ref: 'eachPlayer' } },
  ]],
  [/^(.+?) becomes blocked$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'becomesBlocked' }, duration: 'endOfTurn' }] : null;
  }],
  // "~ gets +1/-1 or -1/+1 until end of turn."
  [/^(.+?) gets? ([+-]\d+)\/([+-]\d+) or ([+-]\d+)\/([+-]\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'chooseMode', options: [
      { text: `${m[2]}/${m[3]}`, effects: [{ kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' }] },
      { text: `${m[4]}/${m[5]}`, effects: [{ kind: 'pump', power: parseInt(m[4], 10), toughness: parseInt(m[5], 10), on: ref, duration: 'endOfTurn' }] },
    ] }];
  }],
  // "You choose a nonland card from that player's graveyard or hand and exile it."
  [/^choose (?:a|an) (.+?) from (that player's|target player's|their) (?:graveyard or hand|hand or graveyard) and exile it$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const owner = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    if (!owner) return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', filter: { ...noun.filter, anyOf: [{ zone: 'graveyard' }, { zone: 'hand' }] }, owner, count: 1, key },
      { kind: 'exile', what: { ref: 'chosen', key } },
    ];
  }],
  [/^choose odd or even$/i, () => [{ kind: 'chooseOption', key: 'choice', options: ['odd', 'even'] }]],
  [/^turn (~|it|that creature|that permanent) face down$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? SELF;
    return [{ kind: 'turnFaceDown', what: ref }];
  }],
  [/^exile any number of target players' graveyards$/i, (m, ctx) => {
    ctx.targets.push({ description: 'any number of target players', kind: 'player', playerFilter: 'any', min: 0, max: 6 });
    return [{ kind: 'moveAll', who: { ref: 'target', slot: ctx.targets.length - 1 }, from: 'graveyard', to: 'exile' }];
  }],
  [/^(.+?) cannot play lands this turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'cantPlayLands' } }] : null;
  }],
  [/^your opponents cannot gain life this turn$/i, () => [{ kind: 'grantPlayerRule', who: { ref: 'eachOpponent' }, rule: { kind: 'cantGainLife' } }]],
  [/^untap all creatures that attacked this turn$/i, () => [{ kind: 'untap', what: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', attackedThisTurn: true } } }]],
  [/^destroy target creature that dealt damage to you this turn$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target creature that dealt damage to you this turn', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield', dealtDamageToYouThisTurn: true } });
    return [{ kind: 'destroy', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^each player shuffles the cards from their hand into their library, then draws that many cards$/i, () => [{ kind: 'shuffleHandIntoLibraryAndDraw', who: { ref: 'eachPlayer' } }]],
  [/^shuffle the cards from your hand into your library, then draw that many cards$/i, () => [{ kind: 'shuffleHandIntoLibraryAndDraw', who: YOU }]],
  [/^its owner puts it on (?:their|his or her) choice of the top or bottom of (?:their|his or her) library$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    return ref ? [{ kind: 'topOrBottom', what: ref }] : null;
  }],
  [/^look at target face-down creature$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target face-down creature', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield', faceDown: true } });
    return [{ kind: 'log', text: 'looks at a face-down creature' }];
  }],
  // "Then discard a card unless you waterbend {2}." (Waterbending Lesson)
  [/^(?:then )?(.+?) unless you waterbend \{(\d+)\}$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    return inner ? [{ kind: 'unlessPays', who: YOU, cost: { waterbend: parseInt(m[2], 10) }, effects: inner }] : null;
  }],
  // "Then you may pay one or more {E}." (Territorial Aetherkite; the "When you do" sentence checks what was paid)
  [/^(?:then )?you may pay (any amount of|one or more|\w+) \{E\}$/i, (m) => {
    const max = /any amount|one or more/i.test(m[1]) ? 99 : wordToNumber(m[1]);
    return typeof max !== 'number' ? null : [{ kind: 'payEnergy', max, key: 'energyPaid' }];
  }],
  // "You get {E}{E}, then you may pay any amount of {E}." — the follow-up sentence uses "{E} paid this way".
  [/^(?:you )?gets? ((?:\{E\})+), then you may pay (any amount of|one or more|(?:\w+)) \{E\}$/i, (m) => {
    const got = (m[1].match(/\{E\}/g) ?? []).length;
    const max = /any amount|one or more/i.test(m[2]) ? 99 : wordToNumber(m[2]);
    if (max === null || typeof max !== 'number') return null;
    return [{ kind: 'addCounters', counter: 'energy', amount: got, on: YOU }, { kind: 'payEnergy', max, key: 'energyPaid' }];
  }],
  [/^choose a color of a card in your graveyard$/i, () => [{ kind: 'chooseColor', key: 'color', fromGraveyard: true }]],
  [/^add one mana of that color$/i, () => [{ kind: 'addMana', mana: 'chosenColor' }]],
  [/^for each color among permanents you control, add one mana of that color$/i, () => [{ kind: 'addManaPerColor', filter: { controller: 'you', zone: 'battlefield' } }]],
  [/^players cannot gain life this turn$/i, () => [{ kind: 'grantPlayerRule', who: { ref: 'eachPlayer' }, rule: { kind: 'cantGainLife' } }]],
  [/^put all cards exiled with ~ into their owner(?:'s|s'|s)? hands?$/i, () => [{ kind: 'putIntoHand', what: { ref: 'memory', key: 'exiled' } }]],
  [/^(?:each player exiles all (.+?) from their graveyards?|exile all (.+?) from (target player's|that player's|each player's|your) graveyard)$/i, (m, ctx) => {
    const what = m[1] ?? m[2];
    const noun = parseNoun(`all ${what}`) ?? parseNoun(what);
    if (!noun) return null;
    const owner = m[1] ? ({ ref: 'eachPlayer' } as Ref) : /^your$/i.test(m[3]) ? YOU : m[3].toLowerCase().startsWith('each') ? ({ ref: 'eachPlayer' } as Ref) : playerRef(m[3].replace(/'s$/, ''), ctx);
    if (!owner) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exile', what: { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', ownerRef: owner } }, remember: 'exiled' }];
  }],
  // Living Death: "…, then puts all cards they exiled this way onto the battlefield"
  [/^(?:each player |that player |they |you )?puts? all (?:the )?cards (?:they|you) exiled this way onto the battlefield(?: under (?:their|its) owner's control)?$/i, () => [{ kind: 'returnToBattlefield', what: { ref: 'chosen', key: 'exiled' }, controller: 'owner' }]],
  // "Until end of turn, ~ loses defender and gains flying."
  [/^(~|it|that creature|target creature|enchanted creature|equipped creature) loses (.+?) and gains (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? ctx.lastObj;
    const lose = parseKeywordList(m[2]);
    const gain = parseKeywordList(m[3]);
    if (!ref || !lose || !gain) return null;
    return [
      { kind: 'grantKeywords', keywords: gain, on: ref, duration: 'endOfTurn' },
      { kind: 'loseKeywords', keywords: lose, on: ref, duration: 'endOfTurn' },
    ];
  }],
  [/^(~|it|that creature|target creature|enchanted creature|equipped creature) loses ((?:flying|defender|trample|deathtouch|lifelink|haste|vigilance|reach|menace|first strike|double strike|hexproof|indestructible|shroud)(?:,? and .+)?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = /^~$/i.test(m[1]) ? SELF : objRef(m[1], ctx) ?? ctx.lastObj;
    const lose = parseKeywordList(m[2]);
    if (!ref || !lose) return null;
    return [{ kind: 'loseKeywords', keywords: lose, on: ref, duration: 'endOfTurn' }];
  }],
  // "Two target players each draw a card."
  [/^(\w+) target players each (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `${m[1]} target players`, kind: 'player', playerFilter: 'any', min: n, max: n, distinct: true });
    const who: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const sub = { ...ctx, lastPlayer: who };
    const inner = parseSentence(`they ${m[2]}`, sub);
    return inner;
  }],
  // "Each player chooses a creature type."
  [/^each player chooses a creature type$/i, () => [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'chooseCreatureType', key: 'creatureType' }] }]],
  // "Then you may discard a nonland card."
  [/^(?:then )?you may discard (?:a|an) (.+?) card$/i, (m) => {
    const noun = parseNoun(`a ${m[1]} card`);
    return noun ? [{ kind: 'may', effects: [{ kind: 'discard', amount: 1, who: YOU, filter: { ...noun.filter, zone: 'hand' } }] }] : null;
  }],
  // "Target opponent puts the cards from their hand on top of their library."
  [/^(.+?) puts the cards from (?:their|his or her) hand on top of (?:their|his or her) library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'moveAll', who, from: 'hand', to: 'library' }] : null;
  }],
  [/^counter all other spells$/i, (m, ctx) => [{ kind: 'counterSpell', what: { ref: 'all', filter: { zone: 'stack', other: true } } }]],
  [/^destroy target (Aura|Equipment) attached to (?:a|an) (\w+)$/i, (m, ctx) => {
    const host = parseNoun(`a ${m[2]}`);
    if (!host) return null;
    ctx.targets.push({ description: `target ${m[1]} attached to a ${m[2]}`, kind: 'object', filter: { subtypes: [m[1]], zone: 'battlefield', attachedToFilter: { ...host.filter, zone: undefined } } });
    return [{ kind: 'destroy', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^(?:have )?(\w+) target players exchange life totals$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `${m[1]} target players`, kind: 'player', playerFilter: 'any', min: n, max: n, distinct: true });
    const slot = ctx.targets.length - 1;
    return [{ kind: 'exchangeLife', a: { ref: 'target', slot }, b: { ref: 'target', slot } }];
  }],
  [/^flip (\w+) coins$/i, (m) => {
    const n = wordToNumber(m[1]);
    return typeof n === 'number' ? [{ kind: 'repeat', times: n, effects: [{ kind: 'flipCoin', win: [] }] }] : null;
  }],
  [/^destroy the chosen (?:creatures?|permanents?|cards?)$/i, () => [{ kind: 'destroy', what: { ref: 'chosen', key: 'chosen' } }]],
  [/^attach (~|it) to up to one target (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`target ${m[2]}`);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), min: 0, max: 1 });
    return [{ kind: 'attach', what: SELF, to: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^you may attach (?:a|an) (.+?) you control to it$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const host = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    if (!noun) return null;
    const key = `att${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'may', effects: [{ kind: 'chooseObjects', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, count: 1, key }, { kind: 'attach', what: { ref: 'chosen', key }, to: host }] }];
  }],
  // "Choose two target creatures controlled by the same player."
  [/^choose (\w+) target (.+?) controlled by the same (player|opponent)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[1]} target ${m[2]}`);
    if (typeof n !== 'number' || !noun) return null;
    ctx.targets.push({ description: `${m[1]} target ${m[2]} controlled by the same ${m[3]}`, kind: 'object', filter: { ...noun.filter, zone: 'battlefield', controller: m[3] === 'opponent' ? 'opponent' : undefined }, min: n, max: n, sameController: true });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "Turn target face-down creature face up."
  [/^turn (target face-down .+?) face up$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'turnFaceUp', what: ref }] : null;
  }],
  // "Return target creature card with total mana value 3 or less from your graveyard to the battlefield."
  [/^return (?:up to (\w+)|any number of|(\w+)) target (.+?) with total mana value (\d+) or less from your graveyard to (?:the battlefield|your hand)$/i, (m, ctx) => {
    const n = /any number of/i.test(m[0]) ? 20 : wordToNumber(m[1] ?? m[2]);
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (typeof n !== 'number' || !noun) return null;
    if (/to your hand$/i.test(m[0])) {
      ctx.targets.push({ description: `target ${m[3]} from your graveyard`, kind: 'object', filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, min: m[1] || /any number of/i.test(m[0]) ? 0 : n, max: n, totalManaValueLE: parseInt(m[4], 10) });
      return [{ kind: 'returnToHand', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
    }
    ctx.targets.push({ description: `target ${m[3]} from your graveyard`, kind: 'object', filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, min: m[1] || /any number of/i.test(m[0]) ? 0 : n, max: n, totalManaValueLE: parseInt(m[4], 10) });
    return [{ kind: 'returnToBattlefield', what: { ref: 'target', slot: ctx.targets.length - 1 }, controller: 'you' }];
  }],
  // "Destroy all Equipment attached to that creature."
  [/^destroy all (.+?) attached to (that creature|that permanent|it)$/i, (m, ctx) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(m[1]);
    const host = ctx.lastObj;
    if (!noun || !host) return null;
    return [{ kind: 'destroy', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', attachedToRef: host } } }];
  }],
  // "Destroy each creature chosen this way." / "Destroy the creatures chosen this way."
  [/^destroy (?:each|all|the) (?:creatures?|permanents?) chosen this way$/i, () => [{ kind: 'destroy', what: { ref: 'chosen', key: 'chosen' } }]],
  [/^forage$/i, () => [{ kind: 'forage' }]],
  // "Flip a coin until you lose a flip."
  [/^flip a coin until you lose a flip$/i, () => [{ kind: 'flipUntilLose' }]],
  // "~ enters under the control of an opponent of your choice."
  [/^~ enters under the control of an opponent of your choice$/i, () => [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }, { kind: 'gainControl', what: SELF, who: { ref: 'chosen', key: 'opponent' }, duration: 'permanent' }]],
  // "Return it to the battlefield tapped and transformed under its owner's control."
  [/^return it to the battlefield tapped and transformed under its owner's control$/i, (m, ctx) => [{ kind: 'returnToBattlefield', what: ctx.lastObj ?? SELF, tapped: true, transformed: true, controller: 'owner' }]],
  // "Look at the top card of that player's library, then exile it face down."
  [/^look at the top card of (that player's|target player's|their) library, then exile it face down$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : null);
    if (!who) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'exileTop', amount: 1, who, faceDown: true }];
  }],
  [/^choose a player$/i, () => [{ kind: 'choosePlayer', key: 'player', who: 'any' }]],
  [/^discard (it|that card|them|those cards)$/i, (m, ctx) => (ctx.lastObj ? [{ kind: 'discardObjects', what: ctx.lastObj }] : null)],
  [/^(?:they|that player|you) puts? (it|that card|them|those cards) onto the battlefield( tapped)?(?: under (?:their|your) control)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToBattlefield', what: ref, tapped: !!m[2], controller: 'owner' }] : null;
  }],
  [/^prevent the next (\d+|X) damage that would be dealt to (.+?) this turn$/i, (m, ctx) => {
    const ref = anyRef(m[2], ctx);
    return ref ? [{ kind: 'preventDamage', amount: parseInt(m[1], 10), to: ref, duration: 'endOfTurn' }] : null;
  }],
  // Look at top
  [/^look at the top (\w+|X) cards of your library(?:\.|,)? (?:then )?put (?:one|(\w+)) of (?:them|those cards) into your hand and (?:put )?the rest (?:on the bottom of your library in a random order|into your graveyard|on the bottom of your library in any order)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null || pick === null) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard/i.test(m[0]) ? 'handRestGraveyard' : 'handRestBottom', pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? put (?:up to one|one) of them on top of your library and the rest into your graveyard$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'lookAtTop', amount: n, then: 'topRestGraveyard', pick: 1 }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? put any number of them into your graveyard and the rest (?:back )?on top of your library in any order$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'lookAtTop', amount: n, then: 'graveyardRestTop' }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?put (?:one|(\w+)|up to (\w+)|any number) of them into your hand and the rest (?:on the bottom of your library in (?:a random|any) order|into your graveyard|(?:back )?on top of your library in any order)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : m[3] ? wordToNumber(m[3]) : /any number/i.test(m[0]) ? n : 1;
    if (n === null || pick === null) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard/i.test(m[0]) ? 'handRestGraveyard' : /on top/i.test(m[0]) ? 'handRestTop' : 'handRestBottom', pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?(?:reveal|put) (?:a|an|up to (\w+)|any number of) ([^.]+?) from among them(?: and put (?:it|them) into your hand)?(?:\.? put (?:it|them) into your hand)?\.? (?:then )?(?:put the rest|and the rest) (?:on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const pick = m[2] ? wordToNumber(m[2]) : /any number of/i.test(m[0]) ? n : 1;
    const noun = parseNoun(/\bcards?\b/i.test(m[3]) ? m[3].replace(/ cards$/i, ' card') : `${m[3]} card`);
    if (n === null || pick === null || !noun) return null;
    return [{ kind: 'lookAtTop', amount: n, then: /graveyard$/i.test(m[0]) ? 'handRestGraveyard' : 'handRestBottom', filter: noun.filter, pick }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? (?:you may )?put (?:a|an|up to (\w+)) ([^.]+?) from among them onto the battlefield( tapped)?(?: and the rest|\.? put the rest) (?:on the bottom of your library in (?:a random|any) order|into your graveyard)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(/\bcards?\b/i.test(m[3]) ? m[3].replace(/ cards$/i, ' card') : `${m[3]} card`);
    if (n === null || !noun) return null;
    return [{ kind: 'lookAtTop', amount: n, then: 'battlefieldRestBottom', filter: noun.filter, pick: m[2] ? (wordToNumber(m[2]) ?? 1) : 1 }];
  }],
  [/^look at the top (\w+|X) cards of your library, then put them back in any order$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'lookAtTop', amount: n, then: 'reorder' }];
  }],
  [/^look at the top (\w+|X) cards of your library\.? you may reveal (?:a|an) (.+?) card from among them and put it into your hand\.? put the rest on the bottom of your library in (?:a random|any) order$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`${m[2]} card`);
    return n === null || !noun ? null : [{ kind: 'lookAtTop', amount: n, then: 'handRestBottom', filter: noun.filter, pick: 1 }];
  }],
  [/^reveal the top card of your library\.? if it is (?:a|an) (.+?) card, put it into your hand\.? otherwise, put it (into your graveyard|on the bottom of your library)$/i, (m) => {
    const noun = parseNoun(`${m[1]} card`);
    return noun ? [{ kind: 'revealTop', ifMatches: noun.filter, then: [{ kind: 'putIntoHand', what: { ref: 'lastMoved' } }], destination: /graveyard/.test(m[2]) ? 'graveyard' : 'bottom' }] : null;
  }],
  // "If a creature would die this turn, exile it instead"
  [/^if (?:a|an) (.+?) would die this turn, exile it instead$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: 'endOfTurn' }];
  }],
  // "return all permanents to their owners' hands except for Giants, Wizards, and lands"
  [/^return all (.+?) to (?:their|its) owner(?:'s|s'|s)? hands? except for (.+)$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(`a ${singularize(m[1])}`);
    if (!noun) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
    for (const raw of m[2].split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean)) {
      const w = raw.trim().replace(/[.,]$/, '');
      const inner = parseNoun(`a ${singularize(w)}`);
      if (!inner) return null;
      if (inner.filter.types?.length) f.notTypes = [...(f.notTypes ?? []), ...inner.filter.types];
      else if (inner.filter.subtypes?.length) f.notSubtypes = [...(f.notSubtypes ?? []), ...inner.filter.subtypes];
      else return null;
    }
    return [{ kind: 'returnToHand', what: { ref: 'all', filter: f } }];
  }],
  // "Exchange control of two target permanents that share a card type"
  [/^exchange control of two target (.+?)s that share (?:a|an) (?:card|permanent) type$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const spec = toTargetSpec(noun);
    if (!spec) return null;
    const a = ctx.targets.length;
    ctx.targets.push(spec, { ...spec });
    return [{ kind: 'exchangeControl', a: { ref: 'target', slot: a }, b: { ref: 'target', slot: a + 1 } }];
  }],
  // "You control enchanted Equipment."
  [/^you control (enchanted .+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'gainControl', what: ref, duration: 'permanent' }] : null;
  }],
  // "that player returns a land they control to its owner's hand"
  [/^(each player|that player|target player|target opponent|each opponent|its controller|they) returns? (?:a|an|(\w+)) (.+?)(?: (?:they|you) control)? to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const c = chooseRef(`a ${m[3]}`, ctx, who, false);
    if (!c) return null;
    const pre0 = c.pre[0] as { filter: ObjectFilter };
    pre0.filter = { ...pre0.filter, controllerRef: who };
    return [...c.pre, { kind: 'returnToHand', what: c.ref }];
  }],
  // "Each player returns all artifact cards from their graveyard to the battlefield"
  [/^(each player|each opponent|that player|target player) returns? all (.+?) from (?:their|his or her) graveyard to the battlefield$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!who || !noun) return null;
    return [{ kind: 'returnToBattlefield', what: { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', ownerRef: who } }, controller: 'owner' }];
  }],
  // "~ gets +3/-1 until end of turn and can attack this turn as though it didn't have defender"
  [/^(.+? gets? [+-]\d+\/[+-]\d+(?: until end of turn)?) and can attack this turn as though it (?:didn't|did not) have defender$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    if (!inner) return null;
    const ref = ctx.lastObj ?? SELF;
    return [...inner, { kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "You may cast a creature spell from your graveyard this turn."
  [/^you may cast (.+?) from your graveyard this turn$/i, (m) => {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(m[1].replace(/ spells?$/i, ' spell'));
    if (!noun) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'castFromGraveyard', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }],
  // "Artifact spells you cast this turn cost {1} less to cast."
  [/^(.+?) you cast this turn cost \{(\d+)\} less to cast$/i, (m) => {
    let filter: ObjectFilter | undefined;
    if (!/^spells$/i.test(m[1])) {
      const noun = parseNoun(m[1].replace(/ spells?$/i, ' spell'));
      if (!noun) return null;
      filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'grantPlayerRule', rule: { kind: 'costReduction', amount: parseInt(m[2], 10), filter } }];
  }],
  // "Destroy all lands or all creatures."
  [/^destroy all (.+?) or all (.+)$/i, (m, ctx) => {
    const a = parseNoun(`all ${m[1]}`);
    const b = parseNoun(`all ${m[2]}`);
    if (!a || !b) return null;
    return [{ kind: 'chooseMode', options: [
      { text: `Destroy all ${m[1]}`, effects: [{ kind: 'destroy', what: { ref: 'all', filter: { ...a.filter, zone: 'battlefield' } } }] },
      { text: `Destroy all ${m[2]}`, effects: [{ kind: 'destroy', what: { ref: 'all', filter: { ...b.filter, zone: 'battlefield' } } }] },
    ], count: 1 }];
  }],
  // "You may cast red spells from among them this turn."
  [/^you may (?:cast|play) (.+?) from among them(?: this turn)?$/i, (m, ctx) => {
    const noun = /^(?:them|cards|spells)$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(m[1].replace(/ spells?$/i, ' spell').replace(/ cards?$/i, ' card'));
    if (!noun) return null;
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', filter: { ...noun.filter, zone: undefined } }];
  }],
  // "Those creatures fight each other."
  [/^(?:those|the two) creatures fight each other$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'fight', a: ref, b: ref }];
  }],
  // "Destroy target land unless its controller has ~ deal 2 damage to them"
  [/^(.+?) unless (its controller|that creature's controller|that player|they) has ~ deal (\d+) damage to (?:them|him or her|that player)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (!inner || !who) return null;
    return [{ kind: 'may', who, prompt: `Have ~ deal ${m[3]} damage to you instead?`, effects: [{ kind: 'damage', amount: parseInt(m[3], 10), to: who, source: { ref: 'self' } }], else: inner }];
  }],
  // "target opponent puts a card from their hand on top of their library"
  [/^(.+?) puts? (?:a|an|(\w+)) (.+?) from their hand on (?:the )?(top|bottom) of their library$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'hand', ownerRef: who }, count: n, key },
      { kind: 'putOnLibrary', what: { ref: 'chosen', key }, position: m[4].toLowerCase() === 'top' ? 'top' : 'bottom' },
    ];
  }],
  // "each opponent may put a legendary creature card from their hand onto the battlefield"
  [/^(each player|each opponent|target player|target opponent|that player) may put (?:a|an|(\w+)) (.+?) from their hand onto the battlefield$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const key = `hb${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'may', who: { ref: 'iter' }, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'hand', ownerRef: { ref: 'iter' } }, count: 1, key },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'owner' },
    ] }] }];
  }],
  // "You may look at and play those cards for as long as they remain exiled"
  [/^you may look at and (?:play|cast) those cards for as long as they remain exiled$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent' }];
  }],
  // "Target player returns an artifact, instant, or sorcery card from their graveyard to their hand"
  [/^(.+?) returns? (?:a|an|(\w+)) (.+?) from (?:their|his or her) graveyard to (?:their|his or her) hand$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const key = `gy${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'graveyard', ownerRef: who }, count: n, key },
      { kind: 'putIntoHand', what: { ref: 'chosen', key } },
    ];
  }],
  // "put all cards exiled with ~ into their owner's graveyard"
  [/^put (.+?) into (?:their|its) owners'? graveyards?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'putIntoGraveyard', what: ref }] : null;
  }],
  // "return three creatures you control to their owner's hand"
  [/^return (\w+) (.+?) to (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const c = chooseRef(`a ${singularize(m[2])}`, ctx, YOU, false);
    if (!c) return null;
    (c.pre[0] as { count: number }).count = n;
    return [...c.pre, { kind: 'returnToHand', what: c.ref }];
  }],
  // "Destroy all permanents except for artifacts and lands"
  [/^destroy all (?:other )?(.+?) except for (.+)$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`) ?? parseNoun(`a ${singularize(m[1])}`);
    if (!noun) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
    for (const raw of m[2].split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean)) {
      const inner = parseNoun(`a ${singularize(raw.trim().replace(/[.,]$/, ''))}`);
      if (!inner) return null;
      if (inner.filter.types?.length) f.notTypes = [...(f.notTypes ?? []), ...inner.filter.types];
      else if (inner.filter.subtypes?.length) f.notSubtypes = [...(f.notSubtypes ?? []), ...inner.filter.subtypes];
      else return null;
    }
    if (/^destroy all other /i.test(m[0])) f.other = true;
    return [{ kind: 'destroy', what: { ref: 'all', filter: f } }];
  }],
  // "investigate that many times" / "sacrifice that many permanents"
  [/^investigate that many times$/i, (m, ctx) => [{ kind: 'investigate', count: { kind: 'triggerAmount' } }]],
  [/^sacrifice that many (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    return noun ? [{ kind: 'sacrificeChoice', who: YOU, filter: { ...noun.filter, zone: 'battlefield' }, count: { kind: 'triggerAmount' } }] : null;
  }],
  // "destroy both creatures"
  [/^destroy both (?:creatures|permanents|of them)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'destroy', what: ref }];
  }],
  // "create a Food token or a Treasure token"
  [/^create (?:a|an) (.+?) token or (?:a|an) (.+?) token$/i, (m) => {
    const a = parseTokenPhrase(`a ${m[1]} token`);
    const b = parseTokenPhrase(`a ${m[2]} token`);
    if (!a || !b) return null;
    return [{ kind: 'chooseMode', options: [
      { text: `Create a ${m[1]} token`, effects: [{ kind: 'createToken', token: a.token, count: 1 }] },
      { text: `Create a ${m[2]} token`, effects: [{ kind: 'createToken', token: b.token, count: 1 }] },
    ], count: 1 }];
  }],
  // "Target creature and all other creatures with the same name as that creature get -3/-3 until end of turn"
  [/^(target .+?) and all other (.+?) with the same name as that \w+ (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!ref || !noun) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [
      { kind: 'pump', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: ref, duration: dur },
      { kind: 'pump', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', sameNameAs: ref } }, duration: dur },
    ];
  }],
  // "Each player's life total becomes the number of creatures they control"
  [/^(each player|each opponent|your|target player|that player)(?:'s)? life totals? becomes? (.+)$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1], ctx);
    const a = amt(m[2], ctx);
    return who && a != null ? [{ kind: 'setLife', amount: a, who }] : null;
  }],
  // "attach target Equipment you control to up to one target creature you control"
  [/^attach (.+?) to (.+)$/i, (m, ctx) => {
    const savedLast = ctx.lastObj;
    const what = objRef(m[1], ctx);
    ctx.lastObj = savedLast;
    const to = what ? objRef(m[2], ctx) : null;
    if (what && to) ctx.lastObj = to;
    return what && to ? [{ kind: 'attach', what, to }] : null;
  }],
  // "You may play that card for as long as it remains exiled, and mana of any type can be spent to cast it"
  [/^you may (?:play|cast) (.+?) for as long as it remains exiled, and mana of any type can be spent to cast it$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'playFromExile', what: ref, duration: 'permanent', anyMana: true }] : null;
  }],
  // "sacrifice it unless you tap an untapped permanent you control"
  [/^(.+?) unless you tap (?:a|an) (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const noun = inner ? parseNoun(`a ${m[2]}`) : null;
    if (!inner || !noun) return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { tap: { ...noun.filter, zone: 'battlefield' } }, effects: inner }];
  }],
  // "Exile target creature and all other creatures its controller controls with the same name as that creature"
  [/^exile (target .+?) and all other (.+?)(?: (?:its controller|that player) controls| your opponents control)? with the same name as that \w+$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!ref || !noun) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', sameNameAs: ref, other: true };
    if (/its controller controls|that player controls/i.test(m[0])) f.controllerRef = { ref: 'controllerOf', of: ref };
    if (/your opponents control/i.test(m[0])) f.controller = 'opponent';
    return [{ kind: 'exile', what: ref }, { kind: 'exile', what: { ref: 'all', filter: f } }];
  }],
  // "Destroy one of them at random" / "destroy one of those permanents at random"
  [/^(destroy|exile|sacrifice|tap) (?:one|(\w+)) of (?:them|those (?:creatures|permanents|cards|lands|tokens))(?: chosen)? at random$/i, (m, ctx) => {
    const src = pluralRef(ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (n === null) return null;
    const key = `rnd${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const verb = m[1].toLowerCase();
    const pick: Effect = { kind: 'chooseObjects', who: YOU, filter: {}, count: n, key, from: src, random: true };
    const ref: Ref = { ref: 'chosen', key };
    const act: Effect = verb === 'destroy' ? { kind: 'destroy', what: ref } : verb === 'exile' ? { kind: 'exile', what: ref } : verb === 'tap' ? { kind: 'tap', what: ref } : { kind: 'sacrifice', what: ref };
    return [pick, act];
  }],
  // "Remove up to three counters from target permanent"
  [/^remove up to (\w+) counters? from (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = n === null ? null : objRef(m[2], ctx);
    return ref && n !== null ? [{ kind: 'removeCounters', counter: 'any', amount: n, on: ref, upTo: true }] : null;
  }],
  [/^remove up to (\w+) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? from (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = n === null ? null : objRef(m[3], ctx);
    return ref && n !== null ? [{ kind: 'removeCounters', counter: m[2], amount: n, on: ref, upTo: true }] : null;
  }],
  // "double the power of target creature you control until end of turn"
  [/^double the (power|toughness) of (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'doubleStat', on: ref, stat: m[1].toLowerCase() === 'power' ? 'power' : 'toughness', duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  // "Return it to the battlefield with an additional +1/+1 counter on it" (from wherever it went)
  [/^return (.+?) to the battlefield( tapped)?(?: under (?:your|its owner's) control)? with (?:an additional |(\w+) additional |(?:a|an) )([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (!ref || typeof n !== 'number') return null;
    return [{ kind: 'returnToBattlefield', what: ref, tapped: m[2] ? true : undefined, counters: { counter: m[4], amount: n } }];
  }],
  // "you may put it onto the battlefield with a manifestation counter on it" (Arbiter of the Ideal)
  [/^put (it|that card|them|those cards|the revealed card) onto the battlefield( tapped)?(?: under your control)? with (?:(\w+) )?([+-]\d+\/[+-]\d+|[\w'-]+) counters? on (?:it|them|each of them)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const n = m[3] && !/^(?:a|an)$/i.test(m[3]) ? wordToNumber(m[3]) : 1;
    if (!ref || typeof n !== 'number') return null;
    return [{ kind: 'returnToBattlefield', what: ref, tapped: m[2] ? true : undefined, counters: { counter: m[4], amount: n } }];
  }],
  // "Return target creature card from your graveyard to the battlefield with an additional +1/+1 counter on it"
  [/^return (.+?) from your graveyard to the battlefield with (?:an additional|(\w+) additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!ref) return null;
    return [{ kind: 'returnToBattlefield', what: ref, counters: { counter: m[3], amount: typeof n === 'number' ? n : 1 } }];
  }],
  // "Creatures target player controls do not untap during that player's next untap step"
  [/^(.+?) (?:do not|don't|doesn't|does not) untap during (?:that player's|target player's|their|your) next untap step$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilYourNextTurn' }] : null;
  }],
  // "Kithkin creatures you control also gain first strike until end of turn"
  [/^(.+?) also (gains?|get) (.+)$/i, (m, ctx) => parseSentence(`${m[1]} ${m[2]} ${m[3]}`, ctx)],
  // "If that creature would leave the battlefield, exile it instead of putting it anywhere else"
  [/^if (?:that|the) (\w+) would leave the battlefield, exile it instead of putting it anywhere else$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfLeaves' }, on: ref, duration: 'permanent' }];
  }],
  [/^if it would leave the battlefield, exile it instead of putting it anywhere else$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfLeaves' }, on: ref, duration: 'permanent' }];
  }],
  // "Copy target instant or sorcery spell twice."
  [/^copy (.+?) (twice|three times|(\w+) times)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const n = /twice/i.test(m[2]) ? 2 : /three times/i.test(m[2]) ? 3 : wordToNumber(m[3]);
    if (n === null) return null;
    return [{ kind: 'copySpell', what: ref, count: n }];
  }],
  // "Proliferate X times" / "Populate X times"
  // "It's a Treasure artifact with "{T}, Sacrifice ~: Add one mana of any color," and it loses all
  // other card types." — a permanent type change on the object the sentence before just moved.
  [/^(?:it(?:'s| is)|(?:the chosen permanents|those permanents|they) becomes?) (?:a|an)? ?(.+?) with "(.+?),?"(?:,? and (?:it|they) loses? all other (?:card types|types|abilities))?$/i, (m, ctx) => {
    const probe = parseNoun(`a ${m[1]}`);
    if (!probe || !probe.confident || !probe.filter.types?.length) return null;
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [
      { kind: 'addTypes', types: [], on: ref, duration: 'permanent', setTypes: probe.filter.types, setSubtypes: probe.filter.subtypes ?? [] },
      { kind: 'grantAbility', text: m[2], on: ref, duration: 'permanent' },
    ];
  }],
  // "proliferate a number of times equal to the difference"
  [/^(proliferate|populate|investigate) a number of times equal to (.+)$/i, (m, ctx) => {
    const n = amt(m[2], ctx);
    if (n === null || n === undefined) return null;
    if (/investigate/i.test(m[1])) return [{ kind: 'investigate', count: n }];
    return [{ kind: 'repeat', times: n, effects: [/proliferate/i.test(m[1]) ? { kind: 'proliferate' } : { kind: 'populate' }] }];
  }],
  [/^(proliferate|populate|investigate) (?:(X|\w+) times|(twice|three times))$/i, (m, ctx) => {
    const n: Amount | null = m[3] ? (/twice/i.test(m[3]) ? 2 : 3) : m[2] === 'X' ? 'X' : wordToNumber(m[2]);
    if (n === null) return null;
    if (/investigate/i.test(m[1])) return [{ kind: 'investigate', count: n }];
    const one: Effect = /proliferate/i.test(m[1]) ? { kind: 'proliferate' } : { kind: 'populate' };
    return [{ kind: 'repeat', times: n, effects: [one] }];
  }],
  // "Move all counters from target creature onto another target creature"
  [/^move (all|any number of|(\w+)) (?:([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) )?counters? from (.+?) onto (.+?)(?: with the same controller)?$/i, (m, ctx) => {
    const from = objRef(m[4], ctx);
    const to = from ? objRef(m[5], ctx) : null;
    if (!from || !to) return null;
    const amount: Amount | undefined = /^all$/i.test(m[1]) ? undefined : /any number of/i.test(m[1]) ? undefined : (wordToNumber(m[2]) ?? undefined);
    return [{ kind: 'moveCounters', from, to, counter: m[3] ? m[3].trim() : undefined, amount }];
  }],
  // "Its controller manifests dread"
  [/^(.+?) manifests? dread$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'manifest', amount: 1, dread: true, who }] : null;
  }],
  // "Target opponent skips all combat phases of their next turn" — no combat is close enough to a skipped turn's combat.
  [/^(.+?) skips (?:all combat phases of (?:their|his or her) next turn|their next combat phase)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'skipCombat' } }] : null;
  }],
  // "Shuffle ~ and target creature with a stun counter on it into their owners' libraries"
  [/^shuffle (~|it) and (.+?) into their owners'? libraries$/i, (m, ctx) => {
    const other = objRef(m[2], ctx);
    if (!other) return null;
    return [{ kind: 'moveToZone', what: SELF, zone: 'library' }, { kind: 'moveToZone', what: other, zone: 'library' }, { kind: 'shuffle' }];
  }],
  // "Until end of turn, it gains haste and \"<ability>\""
  [/^(.+?) gains? ([\w ,]+?) and "(.+)"(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    if (!kws || !ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: dur }, { kind: 'grantAbility', text: m[3], on: ref, duration: dur }];
  }],
  // "If it is not a land card, discard it"
  [/^if it is not (?:a|an) (.+?), (discard|exile|sacrifice) it$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    if (!noun) return null;
    const act: Effect = /discard/i.test(m[2]) ? { kind: 'moveToZone', what: ref, zone: 'graveyard' } : /exile/i.test(m[2]) ? { kind: 'exile', what: ref } : { kind: 'sacrifice', what: ref };
    return [{ kind: 'conditional', if: { kind: 'not', c: { kind: 'amount', a: { kind: 'countRef', ref, filter: { ...noun.filter, zone: undefined } }, op: '>=', b: 1 } }, then: [act] }];
  }],
  // "have target creature block it this turn if able"
  [/^have (.+?) blocks? (?:it|~) this (?:turn|combat) if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlock', data: '__self__' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Exile ~ and target creature without flying that is attacking you"
  [/^exile (~|it) and (.+)$/i, (m, ctx) => {
    const other = objRef(m[2], ctx);
    return other ? [{ kind: 'exile', what: SELF }, { kind: 'exile', what: other }] : null;
  }],
  // "~ deals 2 damage to itself"
  [/^(.+?) deals (\d+|X) damage to itself$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'damage', amount: m[2] === 'X' ? 'X' : parseInt(m[2], 10), to: ref, source: ref }];
  }],
  // "Prevent all damage that ~ would deal to snow creatures"
  [/^prevent all (combat )?damage that (~|it) would deal(?: to (.+))?$/i, (m) => {
    const to = m[3] ? parseNoun(m[3]) ?? parseNoun(`a ${m[3]}`) : null;
    if (m[3] && !to) return null;
    return [{ kind: 'preventAll', combat: m[1] ? true : undefined, sourceRef: SELF, to: to ? { ...to.filter, zone: 'battlefield' } : 'all' }];
  }],
  // "For each of those tokens, you may attach an Equipment you control to it"
  [/^for each of (?:them|those (?:tokens|creatures|permanents|cards|lands|artifacts|players|opponents)), (.+)$/i, (m, ctx) => {
    const src = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastObj = { ref: 'iter' };
    sub.lastPlayer = { ref: 'controllerOf', of: { ref: 'iter' } };
    for (const body of [m[1], m[1].replace(/\bto it\b/i, 'to that permanent'), m[1].replace(/\b(?:that|this) (?:creature|permanent|card|token|land|artifact)\b/gi, 'it')]) {
      const saved = sub.targets.length;
      const inner = parseSentence(body, sub);
      if (inner) return [{ kind: 'forEach', over: src, effects: inner }];
      sub.targets.length = saved;
    }
    return null;
  }],
  // "Then you may put an instant, sorcery, or battle card from your graveyard on top of your library"
  [/^(?:then )?(?:you may )?put (?:a|an|(\w+)) (.+?) from your graveyard on (?:the )?(top|bottom) of your library$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `gyl${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const eff: Effect[] = [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: n, key, upTo: /you may/i.test(m[0]) },
      { kind: 'putOnLibrary', what: { ref: 'chosen', key }, position: m[3].toLowerCase() === 'top' ? 'top' : 'bottom' },
    ];
    return eff;
  }],
  // "that player untaps a land they control"
  [/^(that player|each player|target player|target opponent|each opponent|its controller) (untaps|taps) (?:a|an|(\w+)) (.+?)(?: (?:they|you) control)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[4]}`);
    if (!who || !noun) return null;
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (n === null) return null;
    const key = `ut${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: n, key },
      /untaps/i.test(m[2]) ? { kind: 'untap', what: { ref: 'chosen', key } } : { kind: 'tap', what: { ref: 'chosen', key } },
    ];
  }],
  // "that player discards that many cards"
  [/^(.+?) discards? that many cards$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'discard', amount: { kind: 'triggerAmount' }, who }] : null;
  }],
  // "For as long as that card remains exiled, its owner may play it"
  [/^for as long as that card remains exiled, its owner may play it$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', controller: 'owner' }];
  }],
  // "You may exile a nonland card from it" (from a hand just looked at)
  [/^(?:you may )?exile (?:a|an|(\w+)) (.+?) from (?:it|their hand|that player's hand)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `hx${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const owner = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand', ownerRef: owner }, count: n, key, upTo: /you may/i.test(m[0]) },
      { kind: 'exile', what: { ref: 'chosen', key }, remember: 'exiled' },
    ];
  }],
  // "Reveal target face-down permanent" — information only.
  [/^reveal (target .+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'log', text: `Reveal ${m[1]}.`, objectRef: ref }] : null;
  }],
  // "Choose a creature card exiled with ~"
  [/^choose (?:a|an|(\w+)) (.+? exiled with ~)$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]}`, ctx, YOU, false);
    if (!c) return null;
    if (m[1]) {
      const n = wordToNumber(m[1]);
      if (typeof n !== 'number') return null;
      (c.pre[0] as { count: number }).count = n;
    }
    return c.pre;
  }],
  // "put a creature card exiled with ~ onto the battlefield under your control with a finality counter on it"
  [/^put (?:a|an|(\w+)) (.+?) onto the battlefield(?: under your control)?(?: with (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it)?$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[2]}`, ctx, YOU, false);
    if (!c) return null;
    if (m[1]) {
      const n = wordToNumber(m[1]);
      if (typeof n !== 'number') return null;
      (c.pre[0] as { count: number }).count = n;
    }
    const counters = m[4] ? { counter: m[4], amount: (m[3] ? wordToNumber(m[3]) : 1) ?? 1 } : undefined;
    return [...c.pre, { kind: 'returnToBattlefield', what: c.ref, counters }];
  }],
  // "Return up to one target creature card and up to one target land card from your graveyard to your hand"
  [/^return (up to one target .+?) and (up to one target .+?) from your graveyard to your hand$/i, (m, ctx) => {
    const a = objRef(`${m[1]} in your graveyard`, ctx);
    const b = a ? objRef(`${m[2]} in your graveyard`, ctx) : null;
    return a && b ? [{ kind: 'putIntoHand', what: a }, { kind: 'putIntoHand', what: b }] : null;
  }],
  // "Each opponent attacking that player does the same" — repeat the previous sentence for each of them.
  // "They block this turn if able"
  [/^(?:they|those creatures) blocks? this turn if able$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlockAny' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Target creature blocks target creature this turn if able"
  [/^(target .+?) blocks (target .+?) this turn if able$/i, (m, ctx) => {
    const blocker = objRef(m[1], ctx);
    const attacker = blocker ? objRef(m[2], ctx) : null;
    if (!blocker || !attacker) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlock', data: '__target__' }, on: blocker, duration: 'endOfTurn' }];
  }],
  // "Target creature attacks target opponent this turn if able"
  [/^(target .+?) attacks (target opponent|target player|you) this turn if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    if (/^target/i.test(m[2])) playerRef(m[2], ctx);
    return [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Its activated abilities cannot be activated this turn" / "it assigns no combat damage this turn"
  [/^(?:its|their) activated abilities cannot be activated(?: this turn)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantActivateOwnAbilities' }, on: ref, duration: 'endOfTurn' }];
  }],
  [/^(?:it|that creature) assigns no combat damage this turn$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'assignsNoDamage' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "That player skips their next untap step"
  [/^(.+?) skips (?:their|his or her|your) next untap step$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'skipUntapStep' } }] : null;
  }],
  // "double your life total"
  [/^double (your|that player's|each player's) life totals?$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx) ?? YOU;
    return [{ kind: 'setLife', amount: { kind: 'times', a: 2, b: { kind: 'life', ref: who } }, who }];
  }],
  // "You may put that card on the bottom of that player's library" / "into their graveyard"
  [/^(?:you may )?put that card (?:on the bottom of (?:that player's|their|your) library|into (?:their|its owner's) graveyard)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const eff: Effect = /graveyard/i.test(m[0]) ? { kind: 'putIntoGraveyard', what: ref } : { kind: 'putOnLibrary', what: ref, position: 'bottom' };
    return /you may/i.test(m[0]) ? [{ kind: 'may', effects: [eff] }] : [eff];
  }],
  // "Put the exiled cards not cast this way on the bottom of your library in a random order"
  [/^(?:then )?put (?:the exiled cards not cast this way|all cards revealed this way that (?:were not|weren't) put onto the battlefield|the exiled cards that (?:were not|weren't) cast this way) (?:on the bottom of (?:your|their) library in a random order|into your graveyard)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [/graveyard/i.test(m[0]) ? { kind: 'putIntoGraveyard', what: ref } : { kind: 'putOnLibrary', what: ref, position: 'bottom' }];
  }],
  // "You may play those cards this turn, and you may spend mana as though it were mana of any color to cast those spells"
  [/^(?:you may )?(?:play|cast) (?:those cards|that card|spells from among those cards|spells from among cards exiled with ~|any number of spells from among cards exiled this way)(?: (?:this turn|until your next end step|until the beginning of your next upkeep|for as long as (?:they remain|it remains) exiled|for as long as you control ~))?(?: without paying (?:its|their) mana costs?)?(?:,? and (?:you may spend mana as though it were mana of any color to cast (?:those spells|it|them)|mana of any type can be spent to cast (?:those spells|that spell|them)))?(?: without paying their mana costs)?(?: for as long as (?:they remain|it remains) exiled)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const dur: 'thisTurn' | 'permanent' = /this turn|until your next end step|next upkeep/i.test(m[0]) ? 'thisTurn' : 'permanent';
    return [{ kind: 'playFromExile', what: ref, duration: dur, anyMana: /any color|any type/i.test(m[0]) || undefined, free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "that player draws two additional cards"
  [/^(.+?) draws? (\w+) additional cards?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = wordToNumber(m[2]);
    return who && typeof n === 'number' ? [{ kind: 'draw', amount: n, who }] : null;
  }],
  // "If you do, discard that many cards"
  [/^discard that many cards$/i, () => [{ kind: 'discard', amount: { kind: 'triggerAmount' } }]],
  // "remove target attacking or blocking creature from combat"
  [/^remove (.+?) from combat$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'removeFromCombat', what: ref }] : null;
  }],
  // "~ deals 4 damage to target creature and each other creature with the same name as that creature"
  [/^(~|it) deals (\d+|X) damage to (target .+?) and each other (.+?) (?:with the same name as that \w+|that shares a color with it)$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx);
    const noun = parseNoun(`all ${m[4]}`);
    if (!ref || !noun) return null;
    const amount: Amount = m[2] === 'X' ? 'X' : parseInt(m[2], 10);
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', other: true };
    if (/same name/i.test(m[0])) f.sameNameAs = ref;
    else f.sharesColorWith = ref;
    return [{ kind: 'damage', amount, to: ref, source: SELF }, { kind: 'damage', amount, to: { ref: 'all', filter: f }, source: SELF }];
  }],
  // "If a creature an opponent controls would die, exile it instead" on a spell
  [/^if (?:a|an) (.+?) would die, exile it instead$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    return noun ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: 'permanent' }] : null;
  }],
  // "Attach target Aura attached to a creature to another creature"
  [/^attach (target .+?) to (another .+|target .+)$/i, (m, ctx) => {
    const what = objRef(m[1], ctx);
    const to = what ? objRef(m[2].replace(/^another /i, 'another target '), ctx) : null;
    return what && to ? [{ kind: 'attach', what, to }] : null;
  }],
  // "Exile a card from your hand face down"
  [/^exile (?:a|an|(\w+)) cards? from your hand face down$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `fd${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { zone: 'hand', owner: 'you' }, count: n, key }, { kind: 'exile', what: { ref: 'chosen', key }, faceDown: true, remember: 'exiled' }];
  }],
  // "defending player may draw a card"
  [/^(defending player|that player|target player|each opponent) may (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = who;
    const inner = parseSentence(`${m[1]} ${m[2]}`, sub);
    return inner ? [{ kind: 'may', who, effects: inner }] : null;
  }],
  // "change ~'s base power and toughness to that creature's power and toughness until end of turn"
  [/^change (~|its|that creature)'s base power and toughness to (.+?)'s power and toughness(?: until end of turn)?$/i, (m, ctx) => {
    const target = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? SELF;
    const other = objRef(m[2], ctx);
    if (!other) return null;
    return [{ kind: 'setPT', power: { kind: 'power', ref: other }, toughness: { kind: 'toughness', ref: other }, on: target, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  // "It is a 2/2 Cyberman artifact creature"
  [/^(?:it|that permanent|that card) is (?:a|an) (\d+)\/(\d+) (.+?) creature$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const noun = parseNoun(`a ${m[3]} creature`);
    if (!noun) return null;
    const types = ['Creature', ...(noun.filter.types ?? []).filter((t) => t !== 'Creature')];
    return [
      { kind: 'addTypes', types, subtypes: noun.filter.subtypes, on: ref, duration: 'permanent' },
      { kind: 'setPT', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: ref, duration: 'permanent' },
    ];
  }],
  // "Search that player's library for that many cards"
  [/^search (that player's|target player's|their|your) library for that many cards$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx) ?? YOU;
    return [{ kind: 'searchLibrary', who, filter: {}, count: { kind: 'triggerAmount' }, destination: 'hand', shuffle: true }];
  }],
  // "Your life total becomes that number"
  [/^(your|that player's|each player's) life totals? becomes? that number$/i, (m, ctx) => {
    const who = /^your$/i.test(m[1]) ? YOU : playerRef(m[1].replace(/'s$/, ''), ctx) ?? YOU;
    return [{ kind: 'setLife', amount: { kind: 'memory', key: 'number' }, who }];
  }],
  // "The tokens are goaded for the rest of the game"
  [/^(?:the tokens?|they|those creatures|it|that creature) (?:are|is) goaded(?: for the rest of the game)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'goaded', data: '__you__' }, on: ref, duration: 'permanent' }];
  }],
  // "any opponent may have it deal 5 damage to them"
  [/^any (player|opponent) may have (?:it|~) deal (\d+|X) damage to (?:them|him or her)$/i, (m) => {
    const n: Amount = m[2] === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'anyPlayerMay', prompt: `Have it deal ${m[2]} damage to you?`, effects: [{ kind: 'damage', amount: n, to: { ref: 'controller' }, source: SELF }], ...(m[1].toLowerCase() === 'opponent' ? { opponentsOnly: true } : {}) }];
  }],
  // "choose a card in your hand"
  [/^choose (?:a|an|(\w+)) (.+?) in your hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `ch${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: n, key }];
  }],
  // "The next spell you cast this turn cannot be countered"
  [/^the next spell you cast this turn cannot be countered$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'nextSpellUncounterable' } }]],
  // "change a target of target spell or ability to ~"
  [/^change a target of (target spell or ability|target spell|that spell) to ~$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'changeTargets', what: ref, to: SELF }] : null;
  }],
  // "target opponent reveals cards from the top of their library until they reveal a creature card"
  [/^(.+?) reveals? cards from the top of (?:their|his or her) library until (?:they|he or she) reveals? (?:a|an) (.+?)(?:, then puts? those cards into (?:their|his or her) graveyard)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    return [{ kind: 'revealUntil', filter: { ...noun.filter, zone: undefined }, destination: 'hold', rest: /graveyard/i.test(m[0]) ? 'graveyard' : 'bottom', who }];
  }],
  // "You may have that player shuffle"
  [/^(?:you may )?have (that player|target player|each player|each opponent) shuffle$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const eff: Effect = { kind: 'shuffle', who };
    return /you may/i.test(m[0]) ? [{ kind: 'may', effects: [eff] }] : [eff];
  }],
  // "each player returns to the battlefield all cards they own exiled with it"
  [/^(each player|each opponent|that player) returns? to the battlefield all cards they own exiled with (?:it|~)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'returnToBattlefield', what: { ref: 'all', filter: { exiledWithSource: true, zone: 'exile', ownerRef: who } }, controller: 'owner' }] : null;
  }],
  // "~ deals 2 damage to any target and 3 damage to itself"
  [/^(~|it) deals (\d+|X) damage to (.+?) and (\d+|X) damage to itself$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx) ?? playerRef(m[3], ctx);
    if (!ref) return null;
    const a: Amount = m[2] === 'X' ? 'X' : parseInt(m[2], 10);
    const b: Amount = m[4] === 'X' ? 'X' : parseInt(m[4], 10);
    return [{ kind: 'damage', amount: a, to: ref, source: SELF }, { kind: 'damage', amount: b, to: SELF, source: SELF }];
  }],
  // "It has trample, haste, and \"At the beginning of the end step, sacrifice ~.\""
  [/^(?:it|they|that creature|those creatures) (?:has|have) ([\w ,]+?),? and "(.+)"$/i, (m, ctx) => {
    const kws = parseKeywordList(m[1]);
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    if (!kws) return null;
    return [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'permanent' }, { kind: 'grantAbility', text: m[2], on: ref, duration: 'permanent' }];
  }],
  // "destroy all tokens created with ~"
  // "Choose a number" / "Choose a player at random"
  [/^choose a player at random$/i, () => [{ kind: 'choosePlayer', key: 'player', who: 'any', random: true }]],
  // "draw two additional cards"
  [/^draws? (\w+) additional cards?$/i, (m) => {
    const n = wordToNumber(m[1]);
    return typeof n === 'number' ? [{ kind: 'draw', amount: n }] : null;
  }],
  // "Put ~ from your hand onto the battlefield"
  [/^put ~ from your hand onto the battlefield$/i, () => [{ kind: 'returnToBattlefield', what: SELF }]],
  // "Shuffle your library, then reveal the top card"
  [/^shuffle your library, then reveal the top card$/i, () => [{ kind: 'shuffle', who: YOU }, { kind: 'revealTop' }]],
  // "They may cast that card without paying its mana cost"
  [/^(?:they|its owner|that player) may (?:cast|play) that card(?: without paying its mana cost)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', controller: 'owner', free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "Prevent all damage that would be dealt to ~ by creatures it is blocking"
  [/^prevent all (combat )?damage that would be dealt to (~|it) by (.+?)( this turn)?$/i, (m, ctx) => {
    if (/^target /i.test(m[3])) {
      const tref = objRef(m[3], ctx);
      return tref ? [{ kind: 'preventAll', combat: m[1] ? true : undefined, toRef: SELF, to: 'all', sourceRef: tref }] : null;
    }
    const noun = parseNoun(m[3]) ?? parseNoun(`a ${m[3]}`);
    if (!noun) return null;
    return [{ kind: 'preventAll', combat: m[1] ? true : undefined, toRef: SELF, to: 'all', source: { ...noun.filter, zone: 'battlefield' } }];
  }],
  // "Target creature gains all creature types until end of turn"
  [/^(.+?) (?:gains?|loses?) all creature types(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [/loses/i.test(m[0]) ? { kind: 'addTypes', types: [], setSubtypes: [], on: ref, duration: dur } : { kind: 'grantKeywords', keywords: ['Changeling'], on: ref, duration: dur }];
  }],
  // "They are Zombies in addition to their other types"
  [/^(?:they are|it is|those creatures are) ([A-Z][\w-]+?)s?(?: creatures?)? in addition to (?:their|its) other types$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'addTypes', types: noun.filter.types ?? [], subtypes: noun.filter.subtypes, on: ref, duration: 'permanent' }];
  }],
  // "move any number of +1/+1 counters from other permanents you control onto ~"
  [/^move (all|any number of|(\w+)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? from (.+?) onto (?:~|it)$/i, (m, ctx) => {
    const from = objRef(m[4], ctx);
    if (!from) return null;
    const amount: Amount | undefined = /^all$/i.test(m[1]) || /any number of/i.test(m[1]) ? undefined : (wordToNumber(m[2]) ?? undefined);
    return [{ kind: 'moveCounters', from, to: SELF, counter: m[3], amount }];
  }],
  // "Put a stun counter on one of them"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? on one of them$/i, (m, ctx) => {
    const src = pluralRef(ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `one${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key, from: src }, { kind: 'addCounters', counter: m[2], amount: n, on: { ref: 'chosen', key } }];
  }],
  // "Put them on top of that player's library in any order"
  [/^put them on (?:the )?(top|bottom) of (?:that player's|their|your) library(?: in any order| in a random order)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: /top/i.test(m[1]) ? 'top' : 'bottom' }];
  }],
  // "Prevent all combat damage a creature of your choice would deal this turn"
  [/^prevent all (combat )?damage (?:a|an) (.+?) of your choice would deal this turn$/i, (m) => {
    const noun = parseNoun(`a ${m[2]}`);
    return noun ? [{ kind: 'preventAll', combat: m[1] ? true : undefined, source: { ...noun.filter, zone: 'battlefield' }, to: 'all', once: true }] : null;
  }],
  // "there is an additional combat phase after this phase followed by an additional main phase"
  [/^there is an additional combat phase after this phase(?: followed by an additional main phase)?$/i, () => [{ kind: 'extraCombat' }]],
  // "~ and another target creature each get +1/+0 until end of turn"
  [/^(?:~|it) and (another target .+?|up to one other target .+?|up to \w+ other target .+?|target .+?) each (?:gets?|get) ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: until end of turn)?$/i, (m, ctx) => {
    const other = objRef(m[1], ctx);
    if (!other) return null;
    const pw: Amount = m[2] === '+X' ? 'X' : parseInt(m[2], 10);
    const tg: Amount = m[3] === '+X' ? 'X' : parseInt(m[3], 10);
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'pump', power: pw, toughness: tg, on: SELF, duration: dur }, { kind: 'pump', power: pw, toughness: tg, on: other, duration: dur }];
  }],
  // "That opponent may cast the exiled card without paying its mana cost"
  [/^(?:that opponent|that player|they) may cast the exiled card(?: without paying its mana cost)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', controller: 'owner', free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "~ must be blocked each combat this turn if able"
  [/^(.+?) must be blocked(?: each combat)?(?: this turn)? if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBeBlocked' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Target snow land is no longer snow" / "Target nonsnow basic land becomes snow"
  [/^(.+?) (?:is no longer snow|becomes snow)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [/no longer/i.test(m[0]) ? { kind: 'addTypes', types: [], removeSupertypes: ['Snow'], on: ref, duration: 'permanent' } : { kind: 'addTypes', types: [], addSupertypes: ['Snow'], on: ref, duration: 'permanent' }];
  }],
  // "You may put a creature card exiled this way onto the battlefield"
  [/^(?:you may )?put (?:a|an|(\w+)) (.+?) exiled this way onto the battlefield(?: (tapped))?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2].replace(/ cards$/i, ' card')}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `ex${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    const pre: Effect = { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'exile', exiledWithSource: true }, count: n, key, upTo: /you may/i.test(m[0]) };
    ctx.lastObj = { ref: 'chosen', key };
    return [pre, { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, tapped: !!m[3] }];
  }],
  // "return it to the battlefield face down under your control"
  [/^return (?:it|that card|~) to the battlefield face down(?: under your control)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'returnToBattlefield', what: ref, faceDown: true }];
  }],
  // "put it on your choice of the top or bottom of its owner's library"
  [/^(?:you may )?put (?:it|that card|them|those cards) on (?:your|their|its owner's) choice of the top or bottom of (?:its owner's|their|your) librar(?:y|ies)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'ownerChoice' }];
  }],
  // "each player's life total becomes the highest life total among all players"
  // "The next spell you cast this turn has improvise"
  [/^the next spell you cast this turn has (convoke|improvise|delve)$/i, (m) => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'grantSpellKeyword', data: { keyword: m[1].toLowerCase() } } }]],
  // "roll a four-sided die" / "Roll two d8 and choose one result"
  [/^rolls? (?:a|an) (four|six|eight|ten|twelve|twenty)-sided die$/i, (m) => {
    const sides = ({ four: 4, six: 6, eight: 8, ten: 10, twelve: 12, twenty: 20 } as Record<string, number>)[m[1].toLowerCase()];
    return [{ kind: 'rollDie', sides, results: [] }];
  }],
  // "It gets +2/+2 until end of turn and can block an additional creature this turn"
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)? and can block an additional creature(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [
      { kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'extraBlock' }, on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "Each creature dealt damage this way attacks this turn if able"
  [/^each (.+?) dealt damage this way attacks this turn if able$/i, () => [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  // "You may unattach an Equipment from a creature you control"
  [/^(?:you may )?unattach (?:a|an) (Equipment|Aura) from (?:a|an) (.+)$/i, (m, ctx) => {
    const c = chooseRef(`an ${m[1]} attached to a ${m[2]}`, ctx, YOU, /you may/i.test(m[0]));
    if (!c) return null;
    ctx.lastObj = { ref: 'memory', key: 'unattachedFrom' }; // "If you do, tap that creature": the creature it came off
    return [...c.pre, { kind: 'unattach', what: c.ref }];
  }],
  // "An opponent chooses a creature card from among them"
  [/^(an opponent|target opponent|that player|target player|each opponent) chooses (?:a|an|(\w+)) (.+?) from among them$/i, (m, ctx) => {
    const who = playerRef(m[1] === 'an opponent' ? 'each opponent' : m[1], ctx);
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    if (!who || !noun) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (typeof n !== 'number') return null;
    const src = pluralRef(ctx);
    const key = `opp${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: undefined }, count: n, key, from: src }];
  }],
  // "double the number of +1/+1 counters on it"
  [/^double the number of ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'doubleCounters', counter: m[1], on: ref }] : null;
  }],
  // "Roll two d8 and choose one result"
  [/^roll (\w+) d(\d+)(?: and choose one result)?$/i, (m) => {
    const sides = parseInt(m[2], 10);
    return [{ kind: 'rollDie', sides, results: [] }];
  }],
  // "If that spell would be put into their graveyard, exile it instead"
  [/^if that (?:spell|card|creature|permanent) would be put into (?:their|its owner's|your) graveyard, exile it instead$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: ref, duration: 'permanent' }];
  }],
  // "Until end of turn, creatures your opponents control lose hexproof and shroud and cannot have hexproof or shroud"
  [/^(.+?) lose ([\w ]+?)(?: and ([\w ]+?))? and cannot (?:have or gain|have) [\w ]+?(?: or [\w ]+?)?(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList([m[2], m[3]].filter(Boolean).join(', '));
    const ref = kws ? objRef(m[1], ctx) : null;
    return kws && ref ? [{ kind: 'removeKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Exile all cards from all opponents' hands and graveyards"
  [/^exile all cards from all opponents'? (hands and graveyards|hands|graveyards)$/i, (m) => {
    const out: Effect[] = [];
    if (/hand/i.test(m[1])) out.push({ kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', owner: 'opponent' } } });
    if (/graveyard/i.test(m[1])) out.push({ kind: 'exile', what: { ref: 'all', filter: { zone: 'graveyard', owner: 'opponent' } } });
    return out;
  }],
  // "Turn target creature with a morph ability face down"
  [/^turn (?:any number of |up to \w+ )?(target .+?) face down$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'turnFaceDown', what: ref }] : null;
  }],
  // "You skip your next untap step"
  [/^(?:you|that player|each opponent|target player) skips? (?:your|their) next untap step$/i, (m, ctx) => {
    const who = /^you /i.test(m[0]) ? YOU : playerRef(m[0].split(' ')[0] === 'each' ? 'each opponent' : m[0].split(' ').slice(0, 2).join(' '), ctx) ?? YOU;
    return [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'skipUntapStep' } }];
  }],
  // "each opponent cannot cast instant or sorcery spells during that player's next turn"
  [/^(each opponent|each player|target opponent|target player|that player) cannot cast (.+?) during (?:that player's|their) next turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = /^spells$/i.test(m[2]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[2].replace(/ spells?$/i, '')} spell`);
    if (!who || !noun) return null;
    return [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'cantCastSpells', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }],
  // "A creature dealt damage this way cannot block this turn"
  [/^(?:a|each) (.+?) dealt damage this way cannot (block|attack)(?: this turn)?$/i, (m) => [{ kind: 'applyRule', rule: /block/i.test(m[2]) ? { kind: 'cantBlock' } : { kind: 'cantAttack' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  // "Prevent the next 1 damage that would be dealt by ~ this turn"
  [/^prevent the next (\d+) damage that would be dealt by (~|it) this turn$/i, (m) => [{ kind: 'preventAll', amount: parseInt(m[1], 10), sourceRef: SELF, to: 'all', once: true }]],
  // "Prevent all combat damage that would be dealt by target blocked creature this turn"
  [/^prevent all (combat )?damage that would be dealt by (target .+?) this turn$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'preventAll', combat: m[1] ? true : undefined, sourceRef: ref, to: 'all' }] : null;
  }],
  // "Double target player's life total"
  [/^double (target player|target opponent|that player|each player|each opponent|its controller|the controller of that creature)'s life totals?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'setLife', amount: { kind: 'times', a: 2, b: { kind: 'life', ref: who } }, who }] : null;
  }],
  // "Untap and goad that creature"
  [/^untap and goad (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'untap', what: ref }, { kind: 'applyRule', rule: { kind: 'custom', tag: 'goaded', data: '__you__' }, on: ref, duration: 'permanent' }] : null;
  }],
  // "have it connive"
  [/^have (it|that creature|~) connives?$/i, (m, ctx) => parseSentence(`${m[1]} connives`, ctx)],
  // "You gain hexproof until your next turn"
  [/^(?:you|that player|target player) gains? (hexproof|shroud|protection from everything)(?: until your next turn| until end of turn)?$/i, (m, ctx) => {
    const who = /^you /i.test(m[0]) ? YOU : ctx.lastPlayer ?? YOU;
    return [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: m[1].toLowerCase().replace(/ /g, '') } }];
  }],
  // "Put ~ from your graveyard into your library third from the top"
  [/^put (~|it|that card) from your graveyard into your library (\w+) from the top$/i, (m, ctx) => {
    const depth = wordToNumber(m[2].replace(/^(first|second|third|fourth|fifth|sixth|seventh)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five', sixth: 'six', seventh: 'seven' } as Record<string, string>)[w.toLowerCase()] ?? w));
    if (typeof depth !== 'number') return null;
    const ref = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'top', depth: depth - 1 }];
  }],
  // "Put up to four target cards from your graveyard on the bottom of your library in any order"
  [/^put (up to \w+ target .+?|target .+?) from your graveyard on (?:the )?(top|bottom) of your library(?: in any order)?$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} in your graveyard`, ctx);
    return ref ? [{ kind: 'putOnLibrary', what: ref, position: /top/i.test(m[2]) ? 'top' : 'bottom' }] : null;
  }],
  // "Destroy up to one target artifact, up to one target creature, and up to one target land"
  [/^(destroy|exile|tap) ((?:up to one target|target) [\w -]+?), ((?:up to one target|target) [\w -]+?),? and ((?:up to one target|target) [\w -]+)$/i, (m, ctx) => {
    const refs = [m[2], m[3], m[4]].map((t) => objRef(t, ctx));
    if (refs.some((r) => !r)) return null;
    const verb = m[1].toLowerCase();
    return refs.map((r) => (verb === 'destroy' ? { kind: 'destroy', what: r! } : verb === 'exile' ? { kind: 'exile', what: r! } : { kind: 'tap', what: r! }) as Effect);
  }],
  // "Simultaneously untap all tapped creatures and tap all untapped creatures"
  [/^simultaneously untap all tapped (.+?) and tap all untapped (.+)$/i, (m) => {
    const a = parseNoun(`all ${m[1]}`);
    const b = parseNoun(`all ${m[2]}`);
    if (!a || !b) return null;
    return [
      { kind: 'untap', what: { ref: 'all', filter: { ...a.filter, zone: 'battlefield', tapped: true } } },
      { kind: 'tap', what: { ref: 'all', filter: { ...b.filter, zone: 'battlefield', untapped: true } } },
    ];
  }],
  // "Counter target instant spell if it is blue"
  [/^counter (target .+?) if it is (white|blue|black|red|green)$/i, (m, ctx) => {
    const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, 'W' | 'U' | 'B' | 'R' | 'G'>)[m[2].toLowerCase()];
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'conditional', if: { kind: 'objectMatches', ref, filter: { colors: [cn] } }, then: [{ kind: 'counterSpell', what: ref }] }];
  }],
  // "Target player scries 3" / "Target player puts the bottom card of their library into their graveyard"
  [/^(.+?) scries (\d+|X)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'scry', amount: m[2] === 'X' ? 'X' : parseInt(m[2], 10), who }] : null;
  }],
  [/^(.+?) puts the bottom card of their library into their graveyard$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'mill', amount: 1, who, fromBottom: true }] : null;
  }],
  // "Exile one of those creatures and put two +1/+1 counters on the other"
  [/^exile one of those (.+?) and put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|(?:first |double )?[\w'-]+) counters? on the other$/i, (m, ctx) => {
    const src = pluralRef(ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    const key = `pick${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key, from: src },
      { kind: 'exile', what: { ref: 'chosen', key } },
      { kind: 'addCounters', counter: m[3], amount: n, on: src },
    ];
  }],
  // "You may have any number of them phase out"
  [/^(?:you may have )?any number of them phase out$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'may', effects: [{ kind: 'phaseOut', what: ref }] }];
  }],
  // "Players cannot cast noncreature spells this turn"
  [/^players cannot cast (.+?)(?: this turn)?$/i, (m) => {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spells?$/i, '')} spell`);
    if (!noun) return null;
    return [{ kind: 'grantPlayerRule', who: { ref: 'eachPlayer' }, rule: { kind: 'custom', tag: 'cantCastSpells', data: { filter: { ...noun.filter, zone: undefined } } } }];
  }],
  // "Prevent all damage that creatures would deal to players this turn"
  [/^prevent all (combat )?damage that (.+?) would deal to (players|creatures|you)(?: this turn)?$/i, (m) => {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    return [{ kind: 'preventAll', combat: m[1] ? true : undefined, source: { ...noun.filter, zone: 'battlefield' }, to: /players/i.test(m[3]) ? 'players' : /creatures/i.test(m[3]) ? 'creatures' : 'you' }];
  }],
  // "Target opponent blights 2"
  [/^(.+?) blights (\d+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'addCounters', counter: '-1/-1', amount: parseInt(m[2], 10), on: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', controllerRef: who } } }] : null;
  }],
  // "That creature is black and is a Nightmare in addition to its other creature types"
  [/^(?:that creature|it) is (white|blue|black|red|green) and is (?:a|an) ([A-Z][\w-]+) in addition to its other creature types$/i, (m, ctx) => {
    const cn = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as Record<string, 'W' | 'U' | 'B' | 'R' | 'G'>)[m[1].toLowerCase()];
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'setColors', colors: [cn], on: ref, duration: 'permanent' }, { kind: 'addTypes', types: [], subtypes: [m[2]], on: ref, duration: 'permanent' }];
  }],
  // "Until your next turn, creatures cannot attack you"
  [/^creatures cannot attack you(?: until your next turn)?$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'cantBeAttacked', data: { filter: { types: ['Creature'] } } } }]],
  // "Until your next turn, creatures your opponents control enter tapped"
  [/^creatures your opponents control enter tapped(?: until your next turn)?$/i, () => [{ kind: 'grantPlayerRule', who: { ref: 'eachOpponent' }, rule: { kind: 'entersTapped' } }]],
  // "~ deals 1 damage to any target, 2 damage to another target, and 3 damage to a third target"
  [/^(?:~|it) deals (\d+) damage to (any target|target [\w -]+?), (\d+) damage to (another target|target [\w -]+?),? and (\d+) damage to (?:a third target|another target|target [\w -]+)$/i, (m, ctx) => {
    const a = objRef(m[2], ctx) ?? playerRef(m[2], ctx);
    const b = a ? objRef(m[4] === 'another target' ? 'any target' : m[4], ctx) ?? playerRef(m[4], ctx) : null;
    const c = b ? objRef('any target', ctx) : null;
    if (!a || !b || !c) return null;
    return [
      { kind: 'damage', amount: parseInt(m[1], 10), to: a, source: SELF },
      { kind: 'damage', amount: parseInt(m[3], 10), to: b, source: SELF },
      { kind: 'damage', amount: parseInt(m[5], 10), to: c, source: SELF },
    ];
  }],
  // "Target legendary creature card in your graveyard gains escape until end of turn"
  [/^(target .+? in (?:your|a) graveyard) gains ([\w ]+?)(?: until end of turn)?$/i, (m, ctx) => {
    const kws = parseKeywordList(m[2]);
    const ref = kws ? objRef(m[1], ctx) : null;
    return kws && ref ? [{ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Put target spell or nonland permanent into its owner's library second from the top"
  [/^put (target .+?) into (?:its owner's|their owner's) library (\w+) from the top$/i, (m, ctx) => {
    const depth = wordToNumber(m[2].replace(/^(first|second|third|fourth|fifth|sixth|seventh)$/i, (w) => ({ first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five', sixth: 'six', seventh: 'seven' } as Record<string, string>)[w.toLowerCase()] ?? w));
    const ref = typeof depth === 'number' ? objRef(m[1], ctx) : null;
    return ref && typeof depth === 'number' ? [{ kind: 'putOnLibrary', what: ref, position: 'top', depth: depth - 1 }] : null;
  }],
  // "Search your library for up to three creature cards, reveal them, then shuffle and put those cards on top in any order"
  [/^search your library for (?:up to (\w+)|(\w+)) (.+?), reveal them, then shuffle and put those cards on top in any order$/i, (m) => {
    const noun = parseNoun(`a ${m[3].replace(/ cards$/i, ' card')}`);
    const n = wordToNumber(m[1] ?? m[2]);
    if (!noun || typeof n !== 'number') return null;
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: undefined }, count: n, destination: 'top', reveal: true, shuffle: true }];
  }],
  // "Create two tokens that are copies of the sacrificed creature"
  [/^create (\w+) tokens? that (?:is|are) cop(?:y|ies) of the sacrificed creature$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'createToken', token: { name: 'Copy', typeLine: 'Creature', colors: [], copyOf: { ref: 'chosen', key: 'sacrificed' } }, count: n }];
  }],
  // "Enchanted creature and other creatures that share a creature type with it get +1/+1 until end of turn"
  [/^(?:enchanted|equipped) creature and other creatures that share a creature type with it (?:(?:gets?|get) ([+-]\d+)\/([+-]\d+))?(?:and )?(?:gains? ([\w ,]+?))?(?: and gain ([\w ,]+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const host: Ref = { ref: 'attachedTo' };
    const others: Ref = { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', other: true, sharesCreatureTypeWithSource: true } };
    const out: Effect[] = [];
    if (m[1]) {
      out.push({ kind: 'pump', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: host, duration: 'endOfTurn' });
      out.push({ kind: 'pump', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: others, duration: 'endOfTurn' });
    }
    const kwText = [m[3], m[4]].filter(Boolean).join(', ');
    if (kwText) {
      const kws = parseKeywordList(kwText.replace(/\bfrom /g, ''));
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: host, duration: 'endOfTurn' });
      out.push({ kind: 'grantKeywords', keywords: kws, on: others, duration: 'endOfTurn' });
    }
    return out.length ? out : null;
  }],
  // "prevent the next 5 damage that would be dealt this turn to any number of targets, divided as you choose"
  [/^prevent the next (\d+) damage that would be dealt this turn to any number of targets, divided as you choose$/i, (m) => [{ kind: 'preventAll', amount: parseInt(m[1], 10), to: 'all', once: true }]],
  // "If a permanent dealt damage this way would die this turn, exile it instead"
  [/^if (?:a|an) (.+?) dealt damage this way would (?:die|be destroyed) this turn, exile it instead$/i, () => [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  // "If a card would be put into your graveyard from anywhere this turn, exile that card instead"
  [/^if (?:a|an) (.+?) would be put into your graveyard from anywhere this turn, exile that \w+ instead$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'exileInsteadOfGraveyard' } }]],
  // "If you would roll one or more dice, roll that many dice plus one and ignore the lowest roll instead"
  [/^if you would roll one or more dice, (?:instead )?roll that many dice plus (\w+) and ignore the lowest roll(?: instead)?$/i, (m) => {
    const n = wordToNumber(m[1]);
    return typeof n === 'number' ? [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraDice', data: n } }] : null;
  }],
  // "copy it, except the copy is not legendary"
  [/^copy it, except the copy is not legendary$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'copySpell', what: ref, count: 1 }];
  }],
  // "Put the rest on the bottom in a random order"
  [/^put the rest on the bottom(?: of your library)?(?: in a random order| in any order)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'putOnLibrary', what: ref, position: 'bottom' }];
  }],
  // "for each kind of counter on target permanent, put another counter of that kind on it" — proliferate, spelled out.
  [/^for each kind of counter on (target permanent(?: or player)?|it|that permanent), (?:put another counter of that kind on it(?: or remove one from it)?|give that permanent or player another counter of that kind)$/i, (m, ctx) => {
    if (/^target/i.test(m[1])) objRef('target permanent', ctx);
    return [{ kind: 'proliferate' }];
  }],
  // "~ gets +3/-1 until end of turn and can attack this turn as though it didn't have defender"
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)? and can attack(?: this turn)? as though it (?:didn't|did not) have defender$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [
      { kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' },
    ];
  }],
  // Extra combat
  [/^(?:after this main phase, there is an additional combat phase followed by an additional main phase|untap all creatures you control\. after this phase, there is an additional combat phase)$/i, () => [{ kind: 'untap', what: { ref: 'all', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' } } }, { kind: 'extraCombat' }]],
  // Play from exile
  [/^(?:you may (?:play|cast) (.+?) (?:this turn|until end of turn|for as long as (?:it remains|they remain) exiled))$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'playFromExile', what: ref, duration: /this turn|until end of turn/i.test(m[0]) ? 'thisTurn' : 'permanent' }] : null;
  }],
  [/^(?:you may cast|cast) (.+?) without paying (?:its|their) mana costs?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'may', effects: [{ kind: 'castWithoutPaying', what: ref }] }] : null;
  }],
  // Choices
  [/^choose any number of (.+)$/i, (m, ctx) => {
    const ch = chooseRef(`any number of ${m[1]}`, ctx);
    return ch ? ch.pre : null;
  }],
  [/^(you|that player|target player|target opponent|each opponent|its controller) skips? (?:your|their|his or her) next turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'skipTurn', who }] : null;
  }],
  // "Return an instant or sorcery card at random from your graveyard to your hand."
  [/^exile (?:a|an|(\w+)) (.+?) at random from (?:your|their) graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n === null) return null;
    const key = `rand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: n, key, random: true }, { kind: 'exile', what: { ref: 'chosen', key }, remember: 'exiled' }];
  }],
  [/^return (?:a|an|(\w+)) (.+?) at random from (your|that player's|their) graveyard to (?:your|their) hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || n === null) return null;
    const who: Ref = /^your$/i.test(m[3]) ? YOU : ctx.lastPlayer ?? YOU;
    return [{ kind: 'searchLibrary', who, filter: { ...noun.filter, zone: 'graveyard' }, zones: ['graveyard'], count: n, destination: 'hand', random: true }];
  }],
  // "Target creature becomes that type until end of turn." (after "choose a creature type")
  [/^(.+?) becomes? that type until end of turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'setSubtypes', on: ref, choose: 'creatureType', duration: 'endOfTurn' }];
  }],
  // "The next 1 damage that would be dealt to ~ this turn is dealt to target creature you control instead."
  [/^the next (\w+) damage that would be dealt to (~|it|you|equipped creature|enchanted creature) this turn is dealt to (.+?) instead$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const to = objRef(m[3], ctx) ?? playerRef(m[3], ctx);
    if (!to) return null;
    const victim = /^you$/i.test(m[2]) ? YOU : objRef(m[2], ctx) ?? SELF;
    return [{ kind: 'preventAll', to: 'all', toRef: victim, amount: n, effects: [{ kind: 'damage', amount: { kind: 'triggerAmount' }, to, source: SELF }] }];
  }],
  // "The next time a source of your choice would deal damage to target creature this turn, prevent that damage."
  [/^the next time (?:a source of your choice|a source of your choice|any source) would deal damage to (.+?) this turn, prevent that damage$/i, (m, ctx) => {
    const to = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    return to ? [{ kind: 'preventAll', to: 'all', toRef: to, once: true }] : null;
  }],
  // Ability words with fixed meanings whose reminder text is stripped.
  [/^recruit$/i, () => {
    const nonland = parseNoun('a nonland card');
    if (!nonland) return null;
    return [
      { kind: 'draw', amount: 1 },
      { kind: 'discard', amount: 1 },
      { kind: 'conditional', if: { kind: 'objectMatches', ref: { ref: 'lastDiscarded' }, filter: nonland.filter }, then: [{ kind: 'createToken', token: { name: 'Human Soldier', typeLine: 'Creature — Human Soldier', power: '1', toughness: '1', colors: ['W'] }, count: 1 }] },
    ];
  }],
  // "learn": the Lesson sideboard is not modelled, so only the discard-to-draw half applies.
  [/^learn$/i, () => [{ kind: 'may', effects: [{ kind: 'discard', amount: 1 }, { kind: 'draw', amount: 1 }] }]],
  // "It's an enchantment." / "It is a Spirit in addition to its other types."
  [/^(?:it|that permanent|that creature|that card) is (?:a|an) ([A-Za-z][\w' -]*?)(?: in addition to its other types)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const replace = !/in addition to/i.test(m[0]);
    const words = m[1].split(/\s+/).filter((w) => w.length);
    const types = words.filter((w) => /^(artifact|creature|enchantment|land|planeswalker|battle)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    if (!types.length && !subtypes.length) return null;
    if (replace && !types.length) return null;
    return [{ kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, setTypes: replace ? types : undefined, on: ref, duration: 'permanent' }];
  }],
  // "If that creature or planeswalker would die this turn, exile it instead."
  [/^if (?:that|the) (.+?) would die this turn, exile it instead$/i, (_m, ctx) => {
    const ref = ctx.lastObj;
    return ref ? [{ kind: 'applyRule', on: ref, rule: { kind: 'custom', tag: 'exileIfDies' }, duration: 'endOfTurn' }] : null;
  }],
  // "Up to two target creatures you control each deal damage equal to their power to target creature an opponent controls."
  [/^(.+?) (?:each )?deals? damage equal to their power to (.+)$/i, (m, ctx) => {
    const a = objRef(m[1], ctx);
    const b = a ? objRef(m[2], ctx) ?? playerRef(m[2], ctx) : null;
    if (!a || !b) return null;
    return [{ kind: 'forEach', over: a, effects: [{ kind: 'damage', amount: { kind: 'power', ref: { ref: 'iter' } as Ref }, to: b, source: { ref: 'iter' } as Ref }] }];
  }],
  // "it endures 3"
  [/^(~|it|that creature|equipped creature|enchanted creature|.+?) endures (\w+|X)$/i, (m, ctx) => {
    const n = wordToNumber(m[2]);
    if (n === null) return null;
    const ref = /^(?:~|it)$/i.test(m[1]) ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'endure', on: ref, amount: n }] : null;
  }],
  // "Target opponent exiles a creature they control."
  [/^(.+?) exiles? (?:a|an|(\w+)) (.+?) (?:they|it|that player) controls?(?: of (?:their|its) choice)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || !noun || n === null) return null;
    return [{ kind: 'exileChoice', who, filter: { ...noun.filter, zone: 'battlefield' }, count: n }];
  }],
  // "Target player reveals a card at random from their hand."
  [/^(.+?) reveals? (?:a|an|(\w+)) cards? at random from (?:their|his or her|your) hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealRandomFromHand', who, count: n }];
  }],
  // "The owner of target nonland permanent puts it on their choice of the top or bottom of their library."
  [/^the owner of (.+?) puts it on (?:their|his or her) choice of the top or bottom of (?:their|his or her) library$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'topOrBottom', what: ref }] : null;
  }],
  // "Each player gains control of all nontoken permanents they own."
  [/^each player gains control of all (.+?) they own$/i, (m) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    return [{ kind: 'forEach', over: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, effects: [{ kind: 'gainControl', what: { ref: 'iter' }, who: { ref: 'ownerOf', of: { ref: 'iter' } }, duration: 'permanent' }] }];
  }],
  // "Put a card an opponent owns from exile into that player's graveyard."
  [/^put (?:a|an|(\w+)) (.+?) from exile into (?:that player's|their|its owner's) graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]} from exile`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || n === null) return null;
    return [{ kind: 'chooseObjects', filter: { ...noun.filter, zone: 'exile' }, count: n, key: 'fromExile' }, { kind: 'putIntoGraveyard', what: { ref: 'chosen', key: 'fromExile' } }];
  }],
  // "Another target creature you control cannot be blocked this turn except by Spirits."
  [/^(.+?) cannot be blocked this turn except by (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const by = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    if (!ref || !by) return null;
    return [{ kind: 'applyRule', on: ref, rule: { kind: 'cantBeBlockedExceptBy', filter: { ...by.filter, zone: undefined } }, duration: 'endOfTurn' }];
  }],
  [/^choose a color$/i, () => [{ kind: 'chooseColor', key: 'color' }]],
  [/^choose a creature type(?: other than \w+)?$/i, () => [{ kind: 'chooseCreatureType', key: 'creatureType' }]],
  [/^choose a (?:basic )?land type$/i, () => [{ kind: 'chooseCreatureType', key: 'landType', pool: 'land' }]],
  [/^choose a card type$/i, () => [{ kind: 'chooseCreatureType', key: 'cardType', pool: 'cardType' }]],
  [/^exchange life totals with (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'exchangeLife', a: YOU, b: who }] : null;
  }],
  [/^(.+?) explores?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (ref) ctx.exploreRef = ref;
    return ref ? [{ kind: 'log', text: 'explored', event: 'explored', objectRef: ref }, { kind: 'revealTop', ifMatches: { types: ['Land'] }, then: [{ kind: 'putIntoHand', what: { ref: 'lastMoved' } }], else: [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: ref }, { kind: 'may', prompt: 'Put the revealed card into your graveyard?', effects: [{ kind: 'moveToZone', what: { ref: 'lastMoved' }, zone: 'graveyard' }] }] }] : null;
  }],
  [/^empower (\w+) (\w+)$/i, (m) => {
    const n = wordToNumber(m[2]);
    return n === null ? null : [{ kind: 'empower', token: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), amount: n }];
  }],
  [/^airbend (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'exile', what: ref, remember: 'airbended' }, { kind: 'playFromExile', what: { ref: 'chosen', key: 'airbended' }, duration: 'permanent', forCost: '{2}', owner: true }];
  }],
  [/^(that card|it) gains? flashback (\{[^}]+\})(?: until end of turn)? instead if (.+)$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    const cond = parseCondition(m[3], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, triggerHasPlayer: ctx.triggerHasPlayer });
    if (!cond || cond.kind === 'manual') return null;
    return [{ kind: 'conditional', if: cond, then: [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', forCost: m[2], fromGraveyard: true, exileAfter: true }] }];
  }],
  [/^(.+?) gains? flashback(?: (\{[^}]+\}))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', forCost: m[2], fromGraveyard: true, exileAfter: true }];
  }],
  // "Search target opponent's graveyard, hand, and library for any number of cards with the chosen name and exile them."
  [/^search (?:its controller's|that player's|target (player|opponent)'s) graveyard, hand, and library for (?:all|any number of|up to (?:\w+)) cards with the chosen name and exile them$/i, (m, ctx) => {
    ctx.targets.push({ description: `target ${m[1] ?? 'player'}`, kind: 'player', playerFilter: m[1] === 'opponent' ? 'opponent' : 'any' });
    const who: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastPlayer = who;
    return [{ kind: 'searchLibrary', who, filter: { nameIsChosen: 'cardName', zone: 'library' }, zones: ['library', 'graveyard'], count: 99, destination: 'exile', shuffle: true }];
  }],
  [/^(?:then )?search (?:its controller's|its owner's|that player's|target (?:player|opponent)'s) graveyard, hand, and library for (?:all|any number of|up to (?:\w+)) cards with (?:the same name as that (?:spell|card|land|creature|permanent)|that name) and exile them$/i, (m, ctx) => {
    void m;
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? { ref: 'triggerPlayer' as const } : { ref: 'controllerOf' as const, of: ctx.lastObj ?? { ref: 'stackTarget' as const } });
    const same = ctx.lastObj ?? { ref: 'stackTarget' as const };
    return [{ kind: 'searchLibrary', who, filter: { sameNameAs: same, zone: 'library' }, zones: ['library', 'graveyard'], count: 99, destination: 'exile', shuffle: true }];
  }],
  [/^venture into the dungeon$/i, () => [{ kind: 'ventureIntoDungeon' }]],
  [/^tap or untap (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'chooseMode', options: [{ text: 'Tap it', effects: [{ kind: 'tap', what: ref }] }, { text: 'Untap it', effects: [{ kind: 'untap', what: ref }] }], count: 1 }] : null;
  }],
  [/^(~|it|that creature|.+?) becomes (prepared|unprepared)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'setMemory', key: 'prepared', value: /^unprepared$/i.test(m[2]) ? 0 : 1, on: ref }] : null;
  }],
  [/^it becomes (day|night)$/i, (m) => [{ kind: 'setDayNight', to: m[1].toLowerCase() as 'day' | 'night' }]],
  [/^if it is neither day nor night, it becomes (day|night)(?: as ~ enters)?$/i, (m) => [{ kind: 'setDayNight', to: m[1].toLowerCase() === 'day' ? 'startDay' : 'startNight' }]],
  // Manifest / manifest dread / cloak
  [/^manifest(?: the top card of your library| the top (\w+|X) cards of your library)?$/i, (m, ctx) => {
    const n = m[1] ? (m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1])) : 1;
    ctx.lastObj = { ref: 'lastMoved' }; // "Manifest the top card of your library, then put two +1/+1 counters on it"
    return n === null ? null : [{ kind: 'manifest', amount: n as Amount }];
  }],
  [/^manifest dread$/i, (_m, ctx) => {
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'manifest', amount: 1, dread: true }];
  }],
  [/^cloak the top card of your library$/i, (_m, ctx) => {
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'manifest', amount: 1, ward: '{2}' }];
  }],
  [/^(?:you may )?turn (~|it|that creature|that permanent|equipped creature|enchanted creature|.+?) face up$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const eff: Effect = { kind: 'turnFaceUp', what: ref };
    return /^you may /i.test(m[0]) ? [{ kind: 'may', effects: [eff] }] : [eff];
  }],
  [/^monstrosity (\w+|X)$/i, (m) => {
    const n = wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'monstrosity', amount: n }];
  }],
  [/^flip a coin$/i, () => [{ kind: 'flipCoin', win: [] }]],
  // ---- Round 103 ----
  // "Target unblocked attacking creature becomes blocked."
  [/^(.+?) becomes blocked$/i, (m, ctx) => {
    const r = objRef(m[1], ctx);
    return r ? [{ kind: 'becomeBlocked', what: r }] : null;
  }],
  // "Return the top creature card of your graveyard to the battlefield."
  [/^return the top (.+?) of your graveyard to the battlefield( tapped)?$/i, (m) => {
    const noun = parseNoun(`the top ${m[1]} of your graveyard`);
    if (!noun) return null;
    return [{ kind: 'returnToBattlefield', what: { ref: 'all', filter: noun.filter }, tapped: m[2] ? true : undefined }];
  }],
  // "Each opponent who has three or more poison counters loses 3 life."
  [/^each opponent who has (\w+) or more (poison|experience|energy) counters loses (\w+) life$/i, (m) => {
    const n = wordToNumber(m[1]);
    const l = wordToNumber(m[3]);
    if (typeof n !== 'number' || typeof l !== 'number') return null;
    return [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'conditional', if: { kind: 'playerStat', stat: m[2].toLowerCase() as 'poison', ref: { ref: 'iter' }, op: '>=', value: n }, then: [{ kind: 'loseLife', amount: l, who: { ref: 'iter' } }] }] }];
  }],
  // "each opponent loses life equal to the life they lost this turn"
  [/^each opponent loses life equal to the life they lost this turn$/i, () => [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'loseLife', amount: { kind: 'playerTurnStat', key: 'lifeLostAmount', ref: { ref: 'iter' } }, who: { ref: 'iter' } }] }]],
  // "Add an amount of mana of that color equal to your devotion to that color." (after "Choose a color")
  [/^add an amount of mana of that color equal to your devotion to that color$/i, () => [{ kind: 'addMana', mana: 'chosenColor', amount: { kind: 'devotion', colors: [], chosenKey: 'color' } }]],
  // "~ deals damage to target spell's controller equal to that spell's mana value."
  [/^~ deals damage to target spell's controller equal to that spell's mana value$/i, (ctxm, ctx) => {
    void ctxm;
    ctx.targets.push({ description: 'target spell', kind: 'spell' });
    const slot = ctx.targets.length - 1;
    return [{ kind: 'damage', amount: { kind: 'manaValue', ref: { ref: 'target', slot } }, to: { ref: 'controllerOf', of: { ref: 'target', slot } } }];
  }],
  // "Artifacts you control become artifact creatures with base power and toughness 5/5 until end of turn."
  // "Forests you control become 2/3 creatures until end of turn."
  [/^(.+?) becomes? (\d+)\/(\d+) (?:(\w+) )?creatures?(?: with (.+?))?(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const types = ['Creature'];
    const subtypes: string[] = [];
    if (m[4]) {
      const extra = m[4].charAt(0).toUpperCase() + m[4].slice(1).toLowerCase();
      if (['Artifact', 'Enchantment', 'Land'].includes(extra)) types.unshift(extra);
      else if (/^[A-Z][a-z]+$/.test(m[4])) subtypes.push(m[4]);
      else return null;
    }
    const out: Effect[] = [
      { kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, on: ref, duration: 'endOfTurn' },
      { kind: 'setPT', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
    ];
    if (m[5]) {
      const kws = parseKeywordList(m[5]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: ref, duration: 'endOfTurn' });
    }
    return out;
  }],
  // "Exile the bottom card of target player's graveyard."
  [/^(exile|destroy|return) the (top|bottom) (.+?) of target (player|opponent)'s graveyard(?: to their hand)?$/i, (m, ctx) => {
    const inner = parseNoun(`a ${m[3]}`);
    if (!inner) return null;
    const who = playerRef(`target ${m[4]}`, ctx);
    if (!who) return null;
    const f: ObjectFilter = { ...inner.filter, zone: 'graveyard', ownerRef: who, custom: m[2].toLowerCase() === 'top' ? 'topOfGraveyard' : 'bottomOfGraveyard' };
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return [m[1].toLowerCase() === 'exile' ? { kind: 'exile', what: ref } : m[1].toLowerCase() === 'destroy' ? { kind: 'destroy', what: ref } : { kind: 'returnToHand', what: ref }];
  }],
  [/^(.+?) become (?:(\w+) )?creatures with base power and toughness (\d+)\/(\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const types = ['Creature'];
    if (m[2]) {
      const extra = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
      if (!['Artifact', 'Enchantment', 'Land'].includes(extra)) return null;
      types.unshift(extra);
    }
    return [
      { kind: 'addTypes', types, on: ref, duration: 'endOfTurn' },
      { kind: 'setPT', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "Target creature gains protection from the color of its controller's choice until end of turn."
  [/^(.+?) gains protection from the color of (its controller's|your|their) choice until end of turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const who: Ref | undefined = /its controller's/i.test(m[2]) ? { ref: 'controllerOf', of: ref } : undefined;
    return [
      { kind: 'chooseColor', key: 'protColor', who },
      { kind: 'grantKeywords', keywords: ['protection from the chosen color'], on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "put the cards in your hand on the bottom of your library in any order, then draw that many cards"
  [/^put the cards in your hand on the bottom of your library in any order, then draw that many cards$/i, () => [{ kind: 'shuffleHandIntoLibraryAndDraw', who: YOU, bottom: true }]],
  // "Then you may attach an Equipment you control to ~."
  [/^(?:then )?you may attach (?:a|an) (.+?) you control to (~|it|that creature|enchanted creature|equipped creature)$/i, (m, ctx) => {
    const c = chooseRef(`a ${m[1]} you control`, ctx);
    const to = /^~$/.test(m[2]) ? SELF : objRef(m[2], ctx);
    if (!c || !to) return null;
    return [{ kind: 'may', effects: [...c.pre, { kind: 'attach', what: c.ref, to }] }];
  }],
  // "If target opponent has more cards in hand than you, draw cards equal to the difference."
  [/^if (that player|target opponent|target player|an opponent) has more cards in hand than you, draw cards equal to the difference$/i, (m, ctx) => {
    const who = objRef(m[1], ctx) ?? playerRef(m[1], ctx);
    if (!who) return null;
    return [{ kind: 'draw', amount: { kind: 'minus', a: { kind: 'handSize', ref: who }, b: { kind: 'handSize', ref: YOU } }, who: YOU }];
  }],
  // "This turn, each creature you control enters with an additional +1/+1 counter on it."
  [/^this turn, (?:each|all) (.+?) enters? with an additional ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on (?:it|them)$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: { ...noun.filter, zone: undefined }, counter: m[2], amount: 1 } }, duration: 'thisTurn' }];
  }],
  // "it gets -2/-1 until end of turn for each creature blocking it beyond the first"
  [/^(.+?) gets ([+-]\d+)\/([+-]\d+) until end of turn for each creature blocking it beyond the first$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const n: Amount = { kind: 'minus', a: { kind: 'count', filter: { blockingSource: true, zone: 'battlefield' } }, b: 1 };
    return [{ kind: 'pump', power: { kind: 'times', a: parseInt(m[2], 10), b: n }, toughness: { kind: 'times', a: parseInt(m[3], 10), b: n }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Exile ~ and target creature without flying that is attacking you."
  [/^exile ~ and (target .+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'exile', what: SELF }, { kind: 'exile', what: ref }];
  }],
  // Time travel / collect evidence as effects.
  [/^time travel$/i, () => [{ kind: 'timeTravel' }]],
  [/^time travel, then time travel$/i, () => [{ kind: 'timeTravel' }, { kind: 'timeTravel' }]],
  [/^collect evidence (\d+)$/i, (m) => [{ kind: 'collectEvidence', n: parseInt(m[1], 10) }]],
  // "Until your next end step, you may play that card." — the duration leads instead of trailing.
  [/^until (?:your next (?:end step|turn)|the beginning of your next upkeep|end of combat on your next turn|end of turn), ((?:you may )?(?:play|cast) (?:that card|those cards|it|them)(?: without paying (?:its|their) mana costs?)?)$/i, (m, ctx) => parseSentence(`${m[1]} this turn`, ctx)],
  // "Search your library for an Equipment card, put it onto the battlefield, attach it to a creature you control, then shuffle."
  [/^search your library for (?:a|an) (.+?), put it onto the battlefield, attach it to (.+?), then shuffle$/i, (m, ctx) => {
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1] : `a ${m[1]} card`);
    if (!noun) return null;
    const host = chooseRef(m[2], ctx);
    if (!host) return null;
    return [
      { kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'battlefield', shuffle: true },
      ...host.pre,
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host.ref },
    ];
  }],
  // "Return to the battlefield tapped all artifact and creature cards in your graveyard that were put there from the battlefield this turn."
  [/^return to (your hand|the battlefield)( tapped)? (all .+)$/i, (m, ctx) => {
    const noun = parseNoun(m[3]);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone && !f.zoneIn) f.zone = 'graveyard';
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return /hand/i.test(m[1])
      ? [{ kind: 'returnToHand', what: ref }]
      : [{ kind: 'returnToBattlefield', what: ref, tapped: m[2] ? true : undefined, controller: 'owner' }];
  }],
  // "return to your hand all creature cards in your graveyard that were put there from the battlefield this turn"
  // "Draw cards equal to the power of target creature you control."
  [/^(?:you )?draw cards equal to (?:the )?(power|toughness|mana value|loyalty) of (target .+?|~|it)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[2]) ? SELF : objRef(m[2], ctx);
    if (!ref) return null;
    const a: Amount = m[1].toLowerCase() === 'mana value' ? { kind: 'manaValue', ref } : m[1].toLowerCase() === 'loyalty' ? { kind: 'countersOn', ref, counter: 'loyalty' } : { kind: m[1].toLowerCase() as 'power', ref };
    return [{ kind: 'draw', amount: a }];
  }],
  // "Draw another card if you've completed a dungeon."
  [/^draw another card$/i, () => [{ kind: 'draw', amount: 1 }]],
  // "Each opponent chooses a creature card in their graveyard."
  [/^(each player|each opponent|target player|target opponent|that player|an opponent) chooses (?:a|an) (.+?) in their graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const key = `pick_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'graveyard', ownerRef: { ref: 'iter' } }, count: 1, key }] }];
  }],
  // "You lose all poison counters." / "Target player loses all rad counters."
  [/^(?:you )?loses? all ([\w'-]+) counters$/i, (m) => [{ kind: 'loseAllCounters', counter: m[1].toLowerCase(), who: YOU }]],
  // "You skip your next draw step." / "Target player skips their next combat phase this turn."
  [/^(?:you )?skips? (?:your|their) next (untap|upkeep|draw|combat|end|first main|second main) (?:step|phase)(?: this turn)?$/i, (m) => [{ kind: 'skipStep', step: m[1].toLowerCase().replace(/ /g, ''), who: YOU }]],
  // "Target player takes two extra turns after this one."
  [/^(?:you )?takes? (\w+) extra turns? after this one$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const out: Effect[] = [];
    for (let i = 0; i < n; i++) out.push({ kind: 'extraTurn', who: YOU });
    return out;
  }],
  // "You gain X plus 3 life." / "Target player gains twice X life."
  [/^(?:you )?gains? (.+?) life$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a === null ? null : [{ kind: 'gainLife', amount: a, who: YOU }];
  }],
  [/^(?:you )?loses? (.+?) life$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a === null ? null : [{ kind: 'loseLife', amount: a, who: YOU }];
  }],
  // "Triple target creature's power and toughness until end of turn."
  [/^(double|triple) (.+?)'s power and toughness(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    const f = /triple/i.test(m[1]) ? 2 : 1;
    return [{ kind: 'pump', power: { kind: 'times', a: f, b: { kind: 'power', ref } }, toughness: { kind: 'times', a: f, b: { kind: 'toughness', ref } }, on: ref, duration: 'endOfTurn' }];
  }],
  // "That creature cannot block this combat."
  [/^(.+?) cannot (block|attack|attack or block) (?:this combat|this turn)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const kinds: ('cantAttack' | 'cantBlock')[] = /attack or block/i.test(m[2]) ? ['cantAttack', 'cantBlock'] : /attack/i.test(m[2]) ? ['cantAttack'] : ['cantBlock'];
    return kinds.map((k) => ({ kind: 'applyRule' as const, rule: { kind: k }, on: ref, duration: 'endOfTurn' as const }));
  }],
  // "That creature explores, then it explores again."
  [/^(.+?) explores, then it explores again$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'explore', what: ref }, { kind: 'explore', what: ref }];
  }],
  // "That spell's controller may draw a card."
  [/^(?:that|the) (?:spell|permanent|creature|card)'s (controller|owner) (.+)$/i, (m, ctx) => {
    // "that creature's controller" in a trigger about a creature is that creature's controller; only a spell context means the spell on the stack.
    const of: Ref = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'stackTarget' });
    const who: Ref = m[1].toLowerCase() === 'controller' ? { ref: 'controllerOf', of } : { ref: 'ownerOf', of };
    const prev = ctx.lastPlayer;
    ctx.lastPlayer = who;
    const inner = parseSentence(`that player ${m[2]}`, ctx);
    ctx.lastPlayer = prev;
    return inner;
  }],
  // "You get an additional poison counter." / "That player gets a rad counter."
  [/^(?:you )?gets? (?:an additional|a|an|(\w+)) ([\w'-]+) counters?$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'addCounters', counter: m[2].toLowerCase(), amount: n, on: YOU }];
  }],
  // "That player flips a coin."
  [/^(?:you )?flips? a coin$/i, () => [{ kind: 'flipCoin', win: [] }]],
  // "Sacrifice ~ unless you remove a +1/+1 counter from it." / "unless any player pays {3}"
  [/^sacrifice (~|it|that creature|that permanent) unless (you|any player|its controller|that player) (.+)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const who = playerRef(m[2] === 'any player' ? 'each player' : m[2], ctx);
    if (!who) return null;
    const pay = m[3].match(/^pays? ((?:\{[^}]+\})+|\d+ life)$/i);
    const sac: Effect[] = [{ kind: 'sacrifice', what: ref }];
    if (pay) {
      const lm = pay[1].match(/^(\d+) life$/i);
      const eff: Effect = lm ? { kind: 'unlessPays', who, cost: { payLife: parseInt(lm[1], 10) }, effects: sac } : { kind: 'unlessPays', who, cost: pay[1], effects: sac };
      return [eff];
    }
    const spec = parseCost(m[3].replace(/^[a-z]/, (c) => c.toUpperCase()));
    if (!spec) return null;
    if (spec.mana) { const e2: Effect = { kind: 'unlessPays', who, cost: spec.mana, effects: sac }; return [e2]; }
    if (spec.payLife !== undefined && typeof spec.payLife === 'number') { const e2: Effect = { kind: 'unlessPays', who, cost: { payLife: spec.payLife }, effects: sac }; return [e2]; }
    if (spec.sacrifice) { const e2: Effect = { kind: 'unlessPays', who, cost: { sacrifice: spec.sacrifice.filter, count: typeof spec.sacrifice.count === 'number' ? spec.sacrifice.count : 1 }, effects: sac }; return [e2]; }
    if (spec.discard && typeof spec.discard === 'object') { const e2: Effect = { kind: 'unlessPays', who, cost: { discard: typeof spec.discard.count === 'number' ? spec.discard.count : 1, random: spec.discard.random, filter: spec.discard.filter }, effects: sac }; return [e2]; }
    if (spec.mill !== undefined) { const e2: Effect = { kind: 'unlessPays', who, cost: { discard: spec.mill }, effects: sac }; return [e2]; }
    return null;
  }],
  // "Counter target spell unless its controller discards their hand."
  [/^counter (target .+?) unless (?:its controller|that player|they|the controller|that spell's controller) (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const who: Ref = { ref: 'controllerOf', of: ref };
    const body = m[2].trim();
    const counter: Effect[] = [{ kind: 'counterSpell', what: ref }];
    const pay = body.match(/^pays? ((?:\{[^}]+\})+)$/i);
    if (pay) { const e2: Effect = { kind: 'unlessPays', who, cost: pay[1], effects: counter }; return [e2]; }
    const both = body.match(/^pays? ((?:\{[^}]+\})+) and (\d+) life$/i);
    if (both) { const e2: Effect = { kind: 'unlessPays', who, cost: { mana: both[1], payLife: parseInt(both[2], 10) }, effects: counter }; return [e2]; }
    const life = body.match(/^pays? (\d+) life$/i);
    if (life) { const e2: Effect = { kind: 'unlessPays', who, cost: { payLife: parseInt(life[1], 10) }, effects: counter }; return [e2]; }
    if (/^discards their hand$/i.test(body)) { const e2: Effect = { kind: 'unlessPays', who, cost: { discard: 99 }, effects: counter }; return [e2]; }
    const sac = body.match(/^sacrifices (?:a|an) (.+)$/i);
    if (sac) {
      const noun = parseNoun(`a ${sac[1]}`);
      if (!noun) return null;
      const e2: Effect = { kind: 'unlessPays', who, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' }, count: 1 }, effects: counter };
      return [e2];
    }
    return null;
  }],
  // "You get half X rad counters, rounded up."
  [/^(?:(.+?) )?gets? (half X, rounded (?:up|down)|half X|X|\d+|[a-z]+) ([\w'-]+) counters?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    if (!who) return null;
    const raw = m[2].toLowerCase();
    const a: Amount | null = /^half x/.test(raw)
      ? { kind: 'half', a: 'X', round: /rounded down/.test(raw) ? 'down' : 'up' }
      : raw === 'x' ? 'X' : (wordToNumber(m[2]) as Amount | null);
    if (a === null) return null;
    return [{ kind: 'addCounters', counter: m[3], amount: a, on: who }];
  }],
  // "That player looks at the top three cards of your library, then puts them back in any order."
  [/^(.+?) looks? at the top (\w+|X) cards? of (your|their|that player's) library, then puts? them back in any order$/i, (m, ctx) => {
    const looker = playerRef(m[1], ctx);
    const owner = /^your$/i.test(m[3]) ? YOU : playerRef('that player', ctx);
    const n = m[2].toUpperCase() === 'X' ? 'X' : wordToNumber(m[2]);
    if (!looker || !owner || n === null) return null;
    return [{ kind: 'lookAtTop', amount: n as Amount, who: owner, looker, then: 'reorder' }];
  }],
  // "Remove a lore counter from each of any number of Sagas you control."
  [/^remove (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? from each of any number of (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[3])}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || !noun.confident || typeof n !== 'number') return null;
    const key = `loseCtr${ctx.targets.length}`;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'battlefield' }, count: 99, key, upTo: true },
      { kind: 'removeCounters', counter: m[2], amount: n, on: { ref: 'chosen', key } },
    ];
  }],
  // "You may play that card from exile this turn."
  [/^(?:you may|they may) play (?:that card|it|those cards|them) from exile this turn$/i, (m, ctx) => {
    const ref = objRef('that card', ctx);
    return ref ? [{ kind: 'playFromExile', what: ref, duration: 'thisTurn', owner: /^they may/i.test(m[0]) }] : null;
  }],
  // "Put its +1/+1 counters on target creature you control."
  [/^put its ([+-]\d\/[+-]\d|[\w'-]+) counters on (.+)$/i, (m, ctx) => {
    const from = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' as const } : SELF);
    const to = objRef(m[2], ctx);
    return to ? [{ kind: 'moveCounters', from, to, counter: m[1] }] : null;
  }],
  // "Sacrifice ~ unless you remove a counter from a permanent you control."
  [/^(.+?) unless you remove (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? from (?:a|an) (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const noun = parseNoun(`a ${m[4]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!inner || !noun || !noun.confident || typeof n !== 'number') return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { removeCounters: { counter: m[3], amount: n, filter: { ...noun.filter, zone: 'battlefield' } } }, effects: inner, text: m[0].slice(m[1].length + 8) }];
  }],
  // "Return it to your hand unless target opponent pays 3 life."
  [/^(.+?) unless (target opponent|target player) pays (\d+) life$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (!inner || !who) return null;
    return [{ kind: 'unlessPays', who, cost: { payLife: parseInt(m[3], 10) }, effects: inner, text: m[0].slice(m[1].length + 8) }];
  }],
  // "Each of them searches their library for a card, then shuffles and puts that card on top."
  [/^(.+?) searches? their library for (?:a|an) (.+?)(, reveals? it)?, then shuffles? and puts? (?:the|that) card on top$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = /^cards?$/i.test(m[2]) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(`a ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    return [{ kind: 'searchLibrary', who, filter: noun.filter, count: 1, destination: 'top', reveal: !!m[3], shuffle: true }];
  }],
  // "Look at the top two cards of target opponent's library and exile those cards face down."
  [/^look at the top (\w+|X) cards? of (.+?)'s library and exile (?:them|it|those cards|that card) face down$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    const n = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    return who && n !== null ? [{ kind: 'exileTop', who, amount: n as Amount, faceDown: true }] : null;
  }],
  // "Put all commanders you own from the command zone and from your graveyard into your hand."
  [/^put all commanders you own from the command zone and from your graveyard into your hand$/i, () => [
    { kind: 'moveToZone', what: { ref: 'all', filter: { isCommander: true, zoneIn: ['command', 'graveyard'], owner: 'you' } }, zone: 'hand' },
  ]],
  // "During target player's next turn, each creature that player controls attacks if able."
  [/^during (target player|target opponent|that player)'s next turn, (?:each )?creatures? that player controls attacks? if able$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    return [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', controllerRef: who } }, duration: 'untilYourNextTurn' }];
  }],
  // "Target player discards two cards, then draws as many cards as they discarded this way."
  [/^(.+?) draws? as many cards as (?:they|you) discarded this way$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'draw', amount: { kind: 'discardedThisWay', ref: who }, who }] : null;
  }],
  // "Put a land card from their graveyard onto the battlefield tapped under your control."
  [/^put (?:a|an) (.+?) from (their|that player's|target player's|an opponent's) graveyard onto the battlefield( tapped)?(?: under your control)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const who = playerRef(/^their$|^that player's$/i.test(m[2]) ? 'that player' : m[2].replace(/'s$/, ''), ctx);
    if (!noun || !noun.confident || !who) return null;
    const key = `gyPut${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', ownerRef: who }, count: 1, key },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, tapped: !!m[3], controller: 'you' },
    ];
  }],
  // ---- Round 297 ----
  // "You may behold a Dragon": reveal one from your hand or choose one you control.
  [/^(?:you may )?behold (?:a|an) ([A-Z][\w-]*)$/i, (m) => {
    const type = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return [{
      kind: 'may',
      effects: [
        { kind: 'chooseObjects', who: YOU, filter: { subtypes: [type], anyOf: [{ zone: 'hand', owner: 'you' }, { zone: 'battlefield', controller: 'you' }] }, count: 1, key: 'beheld' },
        { kind: 'setMemory', key: 'beheld', value: true },
      ],
    }];
  }],
  // "Shuffle and put that card on top." — the tail of a search that held the card.
  [/^shuffle and put (?:that card|it) on top(?: of your library)?$/i, (m, ctx) => (ctx.lastObj ? [{ kind: 'shuffle' }, { kind: 'putOnLibrary', what: ctx.lastObj, position: 'top' }] : null)],
  // ---- Round 284 ----
  // "That player reveals their hand, you choose a nonland card from it, then that player discards that card."
  [/^(.+?) reveals? (?:their|your) hand, you choose (?:(?:a|an)|(\w+)) (.+?) from it, then (?:that player|they|.+?) discards? (?:that card|those cards|them)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    const noun = parseNoun(`a ${typeof n === 'number' && n > 1 ? singularize(m[3]) : m[3]}`);
    if (!who || !noun || typeof n !== 'number') return null;
    const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'revealHand', who },
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand' }, owner: who, count: n, key },
      { kind: 'discardObjects', what: { ref: 'chosen', key } },
    ];
  }],
  // "That player reveals their hand and exiles all cards with the same name as that creature from it."
  [/^(.+?) reveals? (?:their|your) hand and (discards?|exiles?) all cards(?: from it)? with the same name as (.+?)(?: from it| from (?:their|your) hand and graveyard)?$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const of = objRef(m[3], ctx);
    if (!who || !of) return null;
    return [
      { kind: 'revealHand', who },
      ...(/^exile/i.test(m[2])
        ? [{ kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', ownerRef: who, sameNameAs: of } } } as Effect]
        : [{ kind: 'discard', amount: 'hand', who, filter: { sameNameAs: of } } as Effect]),
    ];
  }],
  // "Target player reveals their hand and discards all cards with that spell's mana value."
  [/^(.+?) reveals? (?:their|your) hand and discards? all cards with that spell's mana value$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    return who ? [{ kind: 'revealHand', who }, { kind: 'discard', amount: 'hand', who, filter: { cmcEQRef: { ref: 'triggerObject' } } }] : null;
  }],
  // "Its controller reveals cards from the top of their library until they reveal a creature card,
  //  puts it onto the battlefield, then shuffles the rest into their library."
  [/^(?:for each .+?, )?(.+?) reveals? cards from the top of (?:their|your) library until (?:they|you) reveals? (?:a|an) (.+?), puts? (?:it|that card) (onto the battlefield|into (?:their|your) hand|into (?:their|your) graveyard), then (?:shuffles? the rest into (?:their|your) library|puts? the rest on the bottom of (?:their|your) library in a random order)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const noun = parseNoun(`a ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    const dest = /battlefield/i.test(m[3]) ? 'battlefield' : /hand/i.test(m[3]) ? 'hand' : 'graveyard';
    return [{ kind: 'revealUntil', filter: { ...noun.filter, zone: 'library' }, destination: dest, rest: /shuffle/i.test(m[0]) ? 'shuffle' : 'bottom', who }];
  }],
  // "Then that player reveals their hand and exiles all cards with that name from their hand and graveyard."
  [/^(.+?) reveals? (?:their|your) hand and exiles? all cards with that name from (?:their|your) hand and graveyard$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    if (!who) return null;
    return [
      { kind: 'revealHand', who },
      { kind: 'exile', what: { ref: 'all', filter: { zoneIn: ['hand', 'graveyard'], ownerRef: who, nameIsChosen: 'cardName' } } },
    ];
  }],
  // ---- Round 275 ----
  // "Put a land card from a graveyard onto the battlefield tapped under your control."
  [/^put (?:a|an) (.+?) from a graveyard onto the battlefield( tapped)?(?: under your control)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const key = `gyAny${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard' }, count: 1, key },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, tapped: !!m[2], controller: 'you' },
    ];
  }],
  // ---- Round 269 ----
  // "Permanents you control can't be the targets of blue or black spells your opponents control this turn."
  [/^(.+?) cannot be the targets? of ((?:white|blue|black|red|green)(?: or (?:white|blue|black|red|green))*) spells (?:your opponents control|an opponent controls)(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const map = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const;
    const colors = m[2].split(/ or /i).map((w) => map[w.trim().toLowerCase() as 'white']);
    return [{ kind: 'applyRule', rule: { kind: 'cantBeTargeted', filter: { colors, controller: 'opponent' } }, on: ref, duration: 'endOfTurn' }];
  }],
  // A permissive fallback for searches the main pattern's fixed word order misses:
  // "Search your library for a land card of each basic land type, put those cards onto the
  // battlefield, then shuffle." / "..., reveal it, put it into your hand, then shuffle."
  [/^search (your|target player's|that player's|their) library for (?:(any number of|up to \w+|\w+) )?(.+?),(?: reveal (?:it|them|those cards|that card),?)?(?: and)?(?: then)? put (?:it|them|that card|those cards) (into your hand|onto the battlefield tapped|onto the battlefield|into your graveyard|on top of your library)(?:,? (?:and )?(?:then )?shuffle(?: your library)?)?$/i, (m, ctx) => {
    const raw = m[3].replace(/ cards$/i, ' card');
    const noun = /^cards?$/i.test(m[3]) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(/\bcards?\b/i.test(raw) ? raw : `${raw} card`);
    if (!noun || !noun.confident) return null;
    const n: Amount | null = m[2] ? (/any number of/i.test(m[2]) ? 20 : (wordToNumber(m[2].replace(/^up to /i, '')) as Amount | null)) : 1;
    if (n === null) return null;
    let who: Ref | undefined;
    if (!/^your$/i.test(m[1])) {
      who = playerRef(m[1].replace(/'s$/, ''), ctx) ?? undefined;
      if (!who) return null;
    }
    const dest = /hand/.test(m[4]) ? 'hand' : /battlefield/.test(m[4]) ? 'battlefield' : /top/.test(m[4]) ? 'top' : 'graveyard';
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'searchLibrary', who, filter: { ...noun.filter, zone: 'library' }, count: n, destination: dest, tapped: /tapped/i.test(m[4]), reveal: /reveal/i.test(m[0]), shuffle: /shuffle/i.test(m[0]) }];
  }],
  // "Add an amount of mana of that color equal to the number of creatures you control of the chosen type."
  [/^add an amount of mana of (?:that|the chosen) colou?r equal to (.+)$/i, (m, ctx) => {
    const a = amt(m[1], ctx);
    return a === null ? null : [{ kind: 'addMana', mana: 'chosenColor', amount: a }];
  }],
  // "Target player exiles all cards from their hand face down, then draws that many cards."
  [/^(.+?) exiles? all cards from their hand(?: face down)?, then draws? that many cards$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    return [
      { kind: 'moveAll', who, from: 'hand', to: 'exile' },
      { kind: 'draw', amount: { kind: 'countRef', ref: { ref: 'lastMoved' } }, who },
    ];
  }],
  // ---- Round 265 ----
  // "Return to your hand the creature card in your graveyard with the greatest power."
  [/^(return|put) to your (hand|graveyard) (?:the|a|an) (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[3]}`);
    if (!noun || !noun.confident) return null;
    const key = `theOne${ctx.targets.length}`;
    const f = { ...noun.filter };
    if (!f.zone && !f.zoneIn) f.zone = 'graveyard';
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: f, count: 1, key },
      /hand/i.test(m[2]) ? { kind: 'returnToHand', what: { ref: 'chosen', key } } : { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'graveyard' },
    ];
  }],
  // ---- Round 264 ----
  // Processors: "You may put a card an opponent owns from exile into that player's graveyard."
  [/^(you may )?put (?:a|an) card an opponent owns from exile into that player's graveyard$/i, (m, ctx) => {
    const key = `processed${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    const steps: Effect[] = [
      { kind: 'chooseObjects', who: YOU, filter: { zone: 'exile', owner: 'opponent' }, count: 1, key, upTo: !!m[1] },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'graveyard' },
    ];
    return m[1] ? [{ kind: 'may', effects: steps }] : steps;
  }],
  // ---- Round 255 ----
  // "When that creature dies this turn, return it to the battlefield under your control."
  [/^when (that creature|it|that permanent|that card) (dies|leaves the battlefield) this turn, (.+)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? { ref: 'triggerObject' as const } : null);
    if (!ref) return null;
    const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: false });
    const inner = parseSentence(m[3], sub);
    if (!inner) return null;
    return [{ kind: 'delayedTrigger', event: /dies/i.test(m[2]) ? 'dies' : 'leavesBattlefield', filter: { objectRef: ref }, effects: inner, text: m[0], once: true }];
  }],
  // "Put all commanders from the command zone onto the battlefield under your control."
  [/^put all commanders from the command zone onto the battlefield under your control$/i, () => [
    { kind: 'returnToBattlefield', what: { ref: 'all', filter: { isCommander: true, zone: 'command' } }, controller: 'you' },
  ]],
  // "Until your next turn, creatures your opponents control attack each combat if able."
  [/^(.+?) attacks? each combat if able$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: ref, duration: 'untilYourNextTurn' }] : null;
  }],
  // ---- Round 252 ----
  // "Look at the top two cards of your library and exile them face down."
  [/^look at the top (\w+|X) cards? of your library and exile (?:them|it|those cards|that card) face down$/i, (m) => {
    const n = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    return n === null ? null : [{ kind: 'exileTop', who: YOU, amount: n as Amount, faceDown: true }];
  }],
  // "You choose two of those cards and put them into that player's graveyard."
  [/^you choose (?:a|an|(\w+)) of those cards and put (?:it|them) into (.+?)'s graveyard$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const who = playerRef(m[2], ctx);
    if (n === null || !who) return null;
    const key = `ofThose${ctx.targets.length}`;
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, from: { ref: 'lastMoved' }, count: n as Amount, key },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'graveyard' },
    ];
  }],
  // ---- Round 249 ----
  // "Put any number of target artifact cards from target player's graveyard on top of their library in any order."
  [/^put (?:(any number of|up to \w+|\w+) )?(target .+? cards?) from (.+?)'s graveyard on (?:the )?(top|bottom) of (?:their|its owner's|that player's) library(?: in any order)?$/i, (m, ctx) => {
    const ref = objRef(`${m[2]} in ${/^target (?:player|opponent)/i.test(m[3]) ? "that player's" : 'a'} graveyard`, ctx) ?? objRef(m[2], ctx);
    if (!ref) return null;
    return [{ kind: 'moveToZone', what: ref, zone: 'library', position: /^top$/i.test(m[4]) ? 'top' : 'bottom' }];
  }],
  // "Put a +1/+1 counter and a lifelink counter on that creature."
  [/^put (?:a|an) ([+-]\d\/[+-]\d|[\w'-]+) counter and (?:a|an) ([+-]\d\/[+-]\d|[\w'-]+) counter on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx);
    if (!ref) return null;
    return [
      { kind: 'addCounters', counter: m[1], amount: 1, on: ref },
      { kind: 'addCounters', counter: m[2], amount: 1, on: ref },
    ];
  }],
  // ---- Round 248 ----
  // "Put ~ and target creature on top of their owners' libraries, then those players shuffle."
  [/^put ~ and (.+?) on top of their owners'? libraries(?:, then those players shuffle(?: their libraries)?)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [
      { kind: 'moveToZone', what: SELF, zone: 'library', position: 'top' },
      { kind: 'moveToZone', what: ref, zone: 'library', position: 'top' },
      { kind: 'shuffle', who: { ref: 'eachPlayer' } },
    ];
  }],
  // "Return two creature cards at random from your graveyard to the battlefield."
  [/^return (?:(\w+|X) )?(.+?) at random from your graveyard to the (battlefield|your hand|hand)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[2])}`);
    const n = m[1] ? (m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1])) : 1;
    if (!noun || !noun.confident || n === null) return null;
    const key = `randGy${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', controller: 'you' }, count: n as Amount, key, random: true },
      /battlefield/i.test(m[3])
        ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key } }
        : { kind: 'returnToHand', what: { ref: 'chosen', key } },
    ];
  }],
  // ---- Round 247 ----
  // "Target player chooses three cards from their hand and puts them on top of their library in any order."
  [/^(.+?) chooses (?:a|an|(\w+)) cards? from their hand and puts? (?:it|them) on top of their library(?: in any order)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    const key = `fromHand${ctx.targets.length}`;
    return [
      { kind: 'chooseObjects', who, filter: { zone: 'hand', ownerRef: who }, count: n as Amount, key },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'library', position: 'top' },
    ];
  }],
  // "Enchanted creature's controller may have it assign its combat damage as though it weren't blocked."
  [/^(.+?) may have (.+?) assign (?:its|their) combat damage(?: this turn)? as though (?:it|they) (?:were not|weren't) blocked$/i, (m, ctx) => {
    const on: Ref | null = /^(?:it|~|that creature)$/i.test(m[2])
      ? (/^(?:enchanted|equipped) \w+'s controller$/i.test(m[1]) ? { ref: 'attachedTo' } : objRef(m[1].replace(/'s controller$/i, ''), ctx) ?? SELF)
      : objRef(m[2], ctx);
    return on ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'assignAsUnblocked' }, on, duration: 'endOfTurn' }] : null;
  }],
  // "Return target creature you control and all Auras you control attached to it to their owner's hand."
  [/^return ((?:another |up to one )?target .+?) and all (Auras|Equipment)(?: you control)? attached to (?:it|them) to (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [
      { kind: 'returnToHand', what: ref },
      { kind: 'returnToHand', what: { ref: 'all', filter: { subtypes: [/^Auras$/i.test(m[2]) ? 'Aura' : 'Equipment'], zone: 'battlefield', attachedToRef: ref } } },
    ];
  }],
  // ---- Round 246 ----
  // "X target blocked creatures assign their combat damage this turn as though they weren't blocked."
  [/^(.+?) assigns? (?:its|their) combat damage(?: this turn)? as though (?:it|they) (?:were not|weren't) blocked$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'assignAsUnblocked' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Destroy target nonland permanent and all other permanents with the same name as that permanent."
  [/^(destroy|exile) (target .+?) and all other (.+?) with the same name as that (?:permanent|creature|card)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (!ref || !noun || !noun.confident) return null;
    const all: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', sameNameAs: ref, other: true } };
    return /^destroy$/i.test(m[1])
      ? [{ kind: 'destroy', what: ref }, { kind: 'destroy', what: all }]
      : [{ kind: 'moveToZone', what: ref, zone: 'exile' }, { kind: 'moveToZone', what: all, zone: 'exile' }];
  }],
  // "You may cast any number of spells from among those nonland cards without paying their mana costs."
  [/^you may cast any number of (.+?) from among (?:those (?:.+? )?cards|them|the exiled cards) without paying (?:their|its) mana costs?$/i, (m, ctx) => {
    const noun = /^spells$/i.test(m[1]) ? { filter: {} as ObjectFilter, confident: true } : parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const key = `anyNum${ctx.targets.length}`;
    const f = { ...noun.filter };
    delete f.zone;
    return [
      { kind: 'chooseObjects', who: YOU, filter: f, from: { ref: 'lastMoved' }, count: 99, key, upTo: true },
      { kind: 'castFrom', what: { ref: 'chosen', key }, free: true },
    ];
  }],
  // "Return target Equipment card from your graveyard to the battlefield attached to ~."
  [/^return (target .+? card) from your graveyard to the battlefield attached to (~|it|(?:a|an) .+)$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} from your graveyard`, ctx);
    if (!ref) return null;
    if (/^(?:~|it)$/i.test(m[2])) return [{ kind: 'returnToBattlefield', what: ref }, { kind: 'attach', what: { ref: 'lastMoved' }, to: SELF }];
    const noun = parseNoun(m[2]);
    if (!noun || !noun.confident) return null;
    const key = `attachHost${ctx.targets.length}`;
    return [
      { kind: 'returnToBattlefield', what: ref },
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'battlefield' }, count: 1, key },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: { ref: 'chosen', key } },
    ];
  }],
  // "Sacrifice it unless you return a basic land card from your graveyard to your hand."
  [/^(.+?) unless you return (?:a|an) (.+?) from your graveyard to your hand$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    const noun = parseNoun(`a ${m[2]}`);
    if (!inner || !noun || !noun.confident) return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { returnToHand: { ...noun.filter, zone: 'graveyard' }, count: 1 }, effects: inner, text: m[0].slice(m[1].length + 8) }];
  }],
  // ---- Round 245 ----
  // "Target creature can't be the target of spells or abilities your opponents control this turn."
  [/^(.+?) cannot be the target of spells or abilities your opponents control(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'cantBeTargeted', by: 'opponents' }, on: ref, duration: 'endOfTurn' }] : null;
  }],
  // "Mill four cards, then return a creature card and a land card from your graveyard to your hand."
  [/^return (?:(up to one|a|an) )?(.+?) card and (?:(?:up to one|a|an) )?(.+?) card from your graveyard to your hand$/i, (m, ctx) => {
    const n1 = parseNoun(`a ${m[2]} card`);
    const n2 = parseNoun(`a ${m[3]} card`);
    if (!n1 || !n1.confident || !n2 || !n2.confident) return null;
    const upTo = /^up to one$/i.test(m[1] ?? '');
    const k1 = `gy${ctx.targets.length}a`;
    const k2 = `gy${ctx.targets.length}b`;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...n1.filter, zone: 'graveyard', controller: 'you' }, count: 1, key: k1, upTo },
      { kind: 'returnToHand', what: { ref: 'chosen', key: k1 } },
      { kind: 'chooseObjects', who: YOU, filter: { ...n2.filter, zone: 'graveyard', controller: 'you' }, count: 1, key: k2, upTo },
      { kind: 'returnToHand', what: { ref: 'chosen', key: k2 } },
    ];
  }],
  // "Change the target of target instant or sorcery spell with a single target to ~."
  [/^change the targets? of (target .+?spell(?: with a single target)?) to (~|it)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'changeTargets', what: ref, to: SELF }] : null;
  }],
  // "Target player chooses a creature they control and puts two +1/+1 counters on it."
  [/^(.+?) chooses (?:a|an) (.+?)(?: they control| of their choice)? and puts (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? on it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (!who || !noun || !noun.confident || n === null) return null;
    const key = `oppPut${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: 1, key },
      { kind: 'addCounters', counter: m[4], amount: n as Amount, on: { ref: 'chosen', key } },
    ];
  }],
  // ---- Round 244 ----
  // "Choose a nonland card exiled this way."
  [/^choose (?:a|an) (.+?) (?:exiled|milled|discarded|revealed) this way$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const key = `thisWay${ctx.targets.length}`;
    const f = { ...noun.filter };
    delete f.zone;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: f, from: { ref: 'lastMoved' }, count: 1, key }];
  }],
  // "You may cast a spell from among those cards without paying its mana cost."
  // "Play one of them without paying its mana cost."
  [/^(?:you may (?:cast|play) (?:a|an) (.+?) from among (?:those cards|them)|(?:you may )?play one of them)( without paying its mana cost)?$/i, (m, ctx) => {
    const noun = m[1] ? parseNoun(`a ${m[1]}`) : { filter: {} as ObjectFilter, confident: true };
    if (!noun || !noun.confident) return null;
    const key = `amongThose${ctx.targets.length}`;
    const f = { ...noun.filter };
    delete f.zone;
    return [
      { kind: 'chooseObjects', who: YOU, filter: f, from: { ref: 'lastMoved' }, count: 1, key, upTo: true },
      { kind: 'castFrom', what: { ref: 'chosen', key }, free: !!m[2] },
    ];
  }],
  // "Put target card from a graveyard on the bottom of its owner's library."
  // "Put target card from a graveyard on your choice of the top or bottom of its owner's library."
  [/^put (target .+?) (?:from (?:a|an|your|their|an opponent's) graveyard )?on (?:the (top|bottom)|your choice of the top or bottom) of (?:its owner's|their|that player's|your) library$/i, (m, ctx) => {
    const ref = objRef(`${m[1]}${/graveyard/i.test(m[0]) ? ' in a graveyard' : ''}`, ctx) ?? objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'moveToZone', what: ref, zone: 'library', position: m[2] && /^top$/i.test(m[2]) ? 'top' : 'bottom' }];
  }],
  // "Target player returns each commander they control from the battlefield to the command zone."
  [/^(.+?) returns each commander they control from the battlefield to the command zone$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'moveToZone', what: { ref: 'all', filter: { isCommander: true, zone: 'battlefield', controllerRef: who } }, zone: 'command' }] : null;
  }],
  // "Target player mills five cards, then puts each Goblin card milled this way into their hand."
  [/^(.+?) puts each (.+?) milled this way into their hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    return [{ kind: 'moveToZone', what: { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', ownerRef: who } }, zone: 'hand' }];
  }],
  // ---- Round 243 ----
  // "~ deals half X damage, rounded down, to any target."
  [/^(.+?) deals half X damage, rounded (up|down), to (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    if (!src) return null;
    return damageTo(m[3], { kind: 'half', a: 'X', round: m[2].toLowerCase() as 'up' | 'down' }, ctx, src);
  }],
  // "Search your library for a creature card, reveal it, then shuffle and put the card on top."
  [/^search your library for (?:a|an) (.+?)(, reveal it)?, then shuffle and put (?:the|that) card on top$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'searchLibrary', filter: noun.filter, count: 1, destination: 'top', reveal: !!m[2], shuffle: true }];
  }],
  // "Put up to one land card discarded this way onto the battlefield tapped under your control."
  [/^put up to one (.+?) (?:discarded|milled|exiled|revealed) this way onto the battlefield( tapped)?(?: under your control)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const key = `thisWay${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard' }, from: { ref: 'lastMoved' }, count: 1, key, upTo: true },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, tapped: !!m[2] },
    ];
  }],
  // "Exile an instant or sorcery card with mana value 3 or less from your graveyard at random."
  [/^exile (?:a|an) (.+?) from your graveyard at random$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const key = `randGy${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard' }, count: 1, key, random: true },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'exile' },
    ];
  }],
  // "Return ~ and up to one other target creature card from your graveyard to the battlefield."
  [/^return ~ and (up to one other target .+? card) from your graveyard to the battlefield( tapped)?$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} from your graveyard`, ctx);
    if (!ref) return null;
    return [
      { kind: 'returnToBattlefield', what: SELF, tapped: !!m[2] },
      { kind: 'returnToBattlefield', what: ref, tapped: !!m[2] },
    ];
  }],
  // ---- Round 242 ----
  // "That player shuffles, then draws a card for each card exiled from their hand this way."
  [/^(.+?) shuffles?, then draws? a card for each card exiled from their hand this way$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'shuffle', who }, { kind: 'draw', amount: { kind: 'countRef', ref: { ref: 'lastMoved' } }, who }] : null;
  }],
  // "Prevent the next 4 damage that would be dealt this turn to target creature you control."
  [/^prevent the next (\d+|X) ((?:combat |noncombat )?)damage that would be dealt this turn to (.+)$/i, (m, ctx) =>
    parseSentence(`prevent the next ${m[1]} ${m[2]}damage that would be dealt to ${m[3]} this turn`, ctx)],
  // "Shuffle all creature cards from target player's graveyard into that player's library."
  [/^shuffle all (.+?) from (.+?)'s graveyard into (?:that player's|their|its owner's) library$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!who || !noun || !noun.confident) return null;
    return [
      { kind: 'moveToZone', what: { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', ownerRef: who } }, zone: 'library' },
      { kind: 'shuffle', who },
    ];
  }],
  // "Put all creature cards exiled with ~ onto the battlefield face down under your control."
  [/^put (?:all|each) (.+?) (exiled with (?:~|it)|(?:milled|exiled|discarded) this way) onto the battlefield( face down)?(?: under your control)?(?: with (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? on (?:it|them))?$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const thisWay = !/^exiled with/i.test(m[2]);
    const n = m[4] ? wordToNumber(m[4]) : 1;
    if (m[5] && n === null) return null;
    const what: Ref = thisWay
      ? { ref: 'all', filter: { ...noun.filter, zone: 'graveyard' } }
      : { ref: 'all', filter: { ...noun.filter, zone: 'exile', exiledWithSource: true } };
    const out: Effect[] = [{ kind: 'returnToBattlefield', what, faceDown: !!m[3] }];
    if (m[5]) out.push({ kind: 'addCounters', counter: m[5], amount: n as Amount, on: { ref: 'lastMoved' } });
    return out;
  }],
  // "Target opponent chooses a permanent they control and returns it to its owner's hand."
  [/^(.+?) chooses (?:a|an) (.+?)(?: they control| of their choice)? and (returns it to its owner's hand|sacrifices it|exiles it)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    const key = `oppChoice${ctx.targets.length}`;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', controllerRef: who };
    ctx.lastObj = { ref: 'chosen', key };
    const pick: Effect = { kind: 'chooseObjects', who, filter: f, count: 1, key };
    const what: Ref = { ref: 'chosen', key };
    if (/returns it/i.test(m[3])) return [pick, { kind: 'returnToHand', what }];
    if (/sacrifices it/i.test(m[3])) return [pick, { kind: 'sacrifice', what }];
    return [pick, { kind: 'moveToZone', what, zone: 'exile' }];
  }],
  // "Each of those creatures is a black Zombie in addition to its other colors and types."
  // "They are black Zombies in addition to their other colors and types."
  [/^(?:each of those creatures is|each of them is|they are) (?:a |an )?((?:white|blue|black|red|green) )?([A-Z][\w-]+?)s? in addition to (?:its|their) other colors and types$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? { ref: 'lastMoved' as const };
    const out: Effect[] = [{ kind: 'addTypes', types: ['Creature'], subtypes: [m[2].replace(/s$/, '')], on: ref, duration: 'permanent' }];
    if (m[1]) {
      const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1].trim().toLowerCase() as 'white'];
      out.unshift({ kind: 'setColors', colors: [c], on: ref, duration: 'permanent', add: true });
    }
    return out;
  }],
  // "You may play target Elemental card from your graveyard without paying its mana cost."
  [/^you may (?:play|cast) (target .+?) from your graveyard without paying its mana cost$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} from your graveyard`, ctx);
    return ref ? [{ kind: 'castFrom', what: ref, free: true }] : null;
  }],
  // ---- Round 241 ----
  // "~ becomes a 4/3 creature with vigilance and all creature types until end of turn"
  [/^(.+?) becomes? (?:a|an) ([\dX]+)\/([\dX]+)((?: [A-Za-z]+)*?) creature with (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const g = parseGrantList(m[5]);
    if (!ref || !g) return null;
    const words = m[4].trim() ? m[4].trim().split(/\s+/) : [];
    if (words.some((w) => !/^(white|blue|black|red|green|artifact|enchantment|legendary|snow)$/i.test(w) && !/^[A-Z]/.test(w))) return null;
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const supers = words.filter((w) => /^(legendary|snow)$/i.test(w)).map((w) => (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) as 'Legendary');
    const dur: Duration = 'endOfTurn';
    const out: Effect[] = [
      { kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, addSupertypes: supers.length ? supers : undefined, on: ref, duration: dur },
      { kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur },
    ];
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: ref, duration: dur });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: ref, duration: dur });
    return out;
  }],
  // "Create Ashaya, the Awoken World, a legendary 4/4 green Elemental creature token."
  [/^create ([A-Z~][\w' ,.~-]+?), (a legendary .+? token)$/i, (m) => {
    const tok = parseTokenPhrase(m[2]);
    if (!tok) return null;
    return [{ kind: 'createToken', token: { ...tok.token, name: m[1], legendary: true }, count: tok.count, tapped: tok.tapped, attacking: tok.attacking }];
  }],
  // "Create a 0/0 green and blue Fractal creature token and put X +1/+1 counters on it."
  [/^create (.+? token) and put (X|\d+|\w+) ([+-]\d\/[+-]\d|[\w'-]+) counters? on it$/i, (m) => {
    const tok = parseTokenPhrase(m[1]);
    const n: Amount | null = m[2].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[2]) as Amount | null);
    if (!tok || n === null) return null;
    return [{ kind: 'createToken', token: tok.token, count: tok.count, tapped: tok.tapped, attacking: tok.attacking, counters: { counter: m[3], amount: n } }];
  }],
  // "You may play it without paying its mana cost for as long as it remains exiled."
  [/^(?:you|its owner) may (?:play|cast) (?:it|that card) without paying its mana cost for as long as it remains exiled$/i, (m, ctx) => {
    const ref = objRef('that card', ctx);
    return ref ? [{ kind: 'playFromExile', what: ref, duration: 'permanent', forCost: '{0}' }] : null;
  }],
  // "You may cast a spell from among cards exiled with ~ without paying its mana cost."
  [/^(you may )?cast (?:a|an) (.+?) from among (?:the )?(?:other )?cards exiled with (?:~|it)(?: this turn)?( without paying its mana cost)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun) return null;
    const key = `castEx${ctx.targets.length}`;
    const f = { ...noun.filter };
    delete f.zone;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...f, zone: 'exile', exiledWithSource: true }, count: 1, key, upTo: true },
      { kind: 'castFrom', what: { ref: 'chosen', key }, free: m[3] ? true : undefined },
    ];
  }],
  // "Each of them is a 1/1 Spirit with flying in addition to its other types."
  [/^each of them is (?:a|an) (\d+)\/(\d+) ([A-Z][\w-]+)(?: with (.+?))? in addition to (?:its|their) other types$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? { ref: 'lastMoved' as const };
    const out: Effect[] = [
      { kind: 'setPT', on: ref, power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), duration: 'permanent' },
      { kind: 'addTypes', types: ['Creature'], subtypes: [m[3]], on: ref, duration: 'permanent' },
    ];
    if (m[4]) {
      const g = parseGrantList(m[4]);
      if (!g || g.abilities.length) return null;
      out.push({ kind: 'grantKeywords', on: ref, keywords: g.keywords, duration: 'permanent' });
    }
    return out;
  }],
  // "Mill five cards, then return a creature card milled this way to your hand."
  [/^return (?:a|an|one) (.+?) milled this way to your hand$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const key = `milled${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard' }, from: { ref: 'lastMoved' }, count: 1, key },
      { kind: 'returnToHand', what: { ref: 'chosen', key } },
    ];
  }],
  // "Return ~ and target land card from your graveyard to the battlefield tapped."
  [/^return ~ and (target .+? card) from your graveyard to the battlefield( tapped)?$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} from your graveyard`, ctx);
    if (!ref) return null;
    const tapped = !!m[2];
    return [
      { kind: 'returnToBattlefield', what: SELF, tapped },
      { kind: 'returnToBattlefield', what: ref, tapped },
    ];
  }],
  // ---- Round 240 ----
  // "Exile any number of target creatures and all Auras attached to them."
  [/^return all (Auras|Equipment) attached to (.+?) to (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    return [{ kind: 'returnToHand', what: { ref: 'all', filter: { subtypes: [/^Auras$/i.test(m[1]) ? 'Aura' : 'Equipment'], zone: 'battlefield', attachedToRef: ref } } }];
  }],
  [/^(exile|destroy) (.+?) and all (Auras|Equipment) attached to (?:them|it)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    const f: ObjectFilter = { subtypes: [/^Auras$/i.test(m[3]) ? 'Aura' : 'Equipment'], zone: 'battlefield', attachedToRef: ref };
    const all: Ref = { ref: 'all', filter: f };
    // Moving the host detaches everything on it, so take the attachments first; the host is what "that card" means afterwards.
    ctx.lastObj = { ref: 'lastMoved' };
    return /^exile$/i.test(m[1])
      ? [{ kind: 'exile', what: all, remember: 'exiled' }, { kind: 'exile', what: ref, remember: 'exiled' }]
      : [{ kind: 'destroy', what: all }, { kind: 'destroy', what: ref }];
  }],
  // "Choose a creature card at random from target opponent's graveyard."
  [/^choose (?:a|an|one) (.+?) at random from (.+?)'s graveyard$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const who = playerRef(m[2], ctx);
    if (!noun || !who) return null;
    const key = `rand${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', ownerRef: who }, count: 1, key, random: true }];
  }],
  // "Choose a card at random that was exiled with ~."
  [/^choose (?:a|an|one) (.+?) at random (?:that was |)exiled with (?:~|it)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    const key = `rand${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'exile', exiledWithSource: true }, count: 1, key, random: true }];
  }],
  // "Return ~ and the exiled card to their owner's hand."
  [/^return ~ and the exiled cards? to (?:their|its) owner(?:'s|s'|s)? hands?$/i, () => [
    { kind: 'returnToHand', what: SELF },
    { kind: 'returnToHand', what: { ref: 'chosen', key: 'exiled' } },
  ]],
  // ---- Round 238 ----
  // "As ~ is turned face up, you may attach it to a creature."
  [/^attach (~|it) to (?:a|an) (.+)$/i, (m, ctx) => {
    const what = /^~$/.test(m[1]) ? SELF : objRef('it', ctx) ?? SELF;
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun || !noun.confident) return null;
    const key = `attachTo${ctx.targets.length}`;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
    if (!f.controller && !f.controllerRef) f.controller = 'you';
    return [{ kind: 'chooseObjects', filter: f, count: 1, key }, { kind: 'attach', what, to: { ref: 'chosen', key } }];
  }],
  // ---- Round 237 ----
  // "If it's a land card, that player puts it into their hand." (Goblin Guide)
  [/^(.+?) puts? (?:it|that card) into their hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const what = objRef('that card', ctx);
    return who && what ? [{ kind: 'moveToZone', what, zone: 'hand' }] : null;
  }],
  // "~ deals X damage divided evenly, rounded down, among any number of targets"
  // "~ deals X plus 1 damage divided as you choose among any number of targets"
  [/^(~|it|that creature|.+?) deals (X|\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?: plus (\d+))? damage divided (?:evenly, rounded down,|as you choose) among (.+)$/i, (m, ctx) => {
    const src = damageSource(m[1], ctx);
    if (!src) return null;
    const base: Amount | null = /^X$/i.test(m[2]) ? 'X' : (wordToNumber(m[2]) as Amount | null);
    if (base === null) return null;
    const a: Amount = m[3] ? { kind: 'sum', parts: [base, parseInt(m[3], 10)] } : base;
    return damageTo(`x, divided as you choose among ${m[4]}`, a, ctx, src);
  }],
  // "You may then have that player shuffle that library." (Visions)
  [/^(?:you may then have|you may have) (.+?) shuffle (?:that|their|his or her) library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'may', effects: [{ kind: 'shuffle', who }] }] : null;
  }],
  // ---- Round 236 ----
  // "That player reveals the top two cards of their library"
  [/^(.+?) reveals? the top (?:(\w+) cards|card) of their library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || typeof n !== 'number') return null;
    ctx.lastObj = { ref: 'lastRevealed' };
    return [{ kind: 'revealTop', who, amount: n, destination: 'stay' }];
  }],
  // "It deals damage equal to its power to you and any target"
  [/^(it|~) deals damage equal to its power to you and any target$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    ctx.targets.push({ description: 'any target', kind: 'any', playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const pw: Amount = { kind: 'power', ref: src };
    return [{ kind: 'damage', amount: pw, source: src, to: YOU }, { kind: 'damage', amount: pw, source: src, to: ref }];
  }],
  // "It deals that much damage to any target that is not a Dinosaur"
  [/^(it|~) deals that much damage to any target that is not (?:a|an) ([A-Z][\w-]+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    ctx.targets.push({ description: `any target that is not a ${m[2]}`, kind: 'any', filter: { notSubtypes: [singularize(m[2])], zone: 'battlefield' }, playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return [{ kind: 'damage', amount: { kind: 'triggerAmount' }, source: src, to: ref }];
  }],
  // "It gets +1/+0 until end of turn for each {B} or {R} spent this way"
  [/^(it|~) gets ([+-]\d+)\/([+-]\d+) until end of turn for each ((?:\{[^}]+\})+(?: or (?:\{[^}]+\})+)?) spent this way$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const per: Amount = { kind: 'manaSpent', of: 'total', symbols: m[4].replace(/ or /g, '') };
    const mul = (n: number): Amount => (n === 0 ? 0 : n === 1 ? per : { kind: 'times', a: n as Amount, b: per });
    return [{ kind: 'pump', power: mul(parseInt(m[2], 10)), toughness: mul(parseInt(m[3], 10)), on: ref, duration: 'endOfTurn' }];
  }],
  // "If you're the monarch, each of those players mills ten cards instead"
  [/^if you(?:'re| are) the monarch, (.+?) instead$/i, (m, ctx) => {
    const inner = parseSentence(m[1], newCtx({ ...ctx, targets: ctx.targets }));
    return inner ? [{ kind: 'conditional', if: { kind: 'isMonarch', ref: YOU }, then: inner }] : null;
  }],
  // "The token enters with half that many +1/+1 counters on it, rounded down"
  [/^the tokens? enters? with half that many ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it,? rounded (up|down)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    return [{ kind: 'addCounters', counter: m[1] as never, amount: { kind: 'half', a: { kind: 'triggerAmount' }, round: /up/i.test(m[2]) ? 'up' : 'down' }, on: ref }];
  }],
  // "For each flip you won, create a token that is a copy of that creature"
  [/^for each flip you won, create (?:a|an) token that is a copy of (that creature|it|~)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'createToken', token: { name: 'Copy', typeLine: '', colors: [], copyOf: src }, count: { kind: 'ctxMemory', key: 'flipsWon' } }];
  }],
  // "As long as ~ remains on the battlefield, that creature is also goaded"
  [/^as long as ~ remains on the battlefield, (?:that creature|it) is also goaded$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'goaded', data: '__you__' }, on: ref, duration: 'untilSourceLeaves' }];
  }],
  // "Choose up to one target creature spell or planeswalker spell"
  [/^choose up to one (target .+? spell) or (.+? spell)$/i, (m, ctx) => {
    const a = parseNoun(m[1]);
    const b = parseNoun(`a ${m[2]}`);
    if (!a || !b) return null;
    ctx.targets.push({ description: `${m[1]} or ${m[2]}`, kind: 'spell', filter: { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }], zone: 'stack' }, min: 0, max: 1 });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "~ deals 2 damage to that player unless they sacrifice enchanted artifact"
  [/^(.+?) deals (\d+|X) damage to that player unless they sacrifice (enchanted \w+|~)$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const victim = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const sacRef = /^~$/.test(m[3]) ? SELF : objRef(m[3], ctx);
    if (!src || !sacRef) return null;
    const amt236: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'unlessPays', who: victim, cost: { sacrifice: { self: true, zone: 'battlefield' }, count: 1 }, effects: [{ kind: 'damage', amount: amt236, source: src, to: victim }] }];
  }],
  // ---- Round 235 ----
  // "Then each player gains control of each permanent for which they were chosen"
  [/^each player gains control of each (.+?) for which they were chosen$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'gainControl', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, who: { ref: 'iter' }, duration: 'permanent' }] }];
  }],
  // "If a permanent dealt damage by ~ would die this turn, exile it instead"
  [/^if (?:a|an) (.+?) dealt damage by ~ would die this turn, exile it instead$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'exileIfDies' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', damagedBySource: true } }, duration: 'endOfTurn' }];
  }],
  // "Counter up to one target creature spell if {U} was spent to cast ~"
  [/^counter up to one (target .+?) if ((?:\{[^}]+\})+) was spent to cast ~$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), min: 0, max: 1 });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'conditional', if: { kind: 'amount', a: { kind: 'manaSpent', of: 'total', symbols: m[2] }, op: '>=', b: 1 }, then: [{ kind: 'counterSpell', what: ref }] }];
  }],
  // "For each of those creatures, its controller may pay {1} or {2}"
  [/^for each of those (.+?), its controller may pay ((?:\{[^}]+\})+)(?: or ((?:\{[^}]+\})+))?$/i, (m, ctx) => {
    const base = ctx.lastObj;
    if (!base) return null;
    const opts = [m[2], m[3]].filter(Boolean) as string[];
    return [{ kind: 'forEach', over: base, effects: [{ kind: 'chooseMode', count: 1, options: opts.map((c) => ({ text: `Pay ${c}`, effects: [{ kind: 'ifPays' as const, who: { ref: 'controllerOf', of: { ref: 'iter' } }, cost: c, effects: [] }] })) }] }];
  }],
  // "Choose a card at random you exiled with cards named ~"
  [/^choose (?:a|an) card at random you exiled with cards named ~$/i, (m, ctx) => {
    const key = 'randEx235';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { zone: 'exile', exiledWithSource: true }, count: 1, key, random: true }];
  }],
  // "Add one mana of any of the exiled cards' colors"
  [/^add one mana of any of the exiled cards?' colou?rs$/i, () => [{ kind: 'addMana', mana: 'anyColor', amount: 1 }]],
  // "Then repeat this process for an enchantment and a planeswalker"
  [/^repeat this process for (?:a|an) (.+?) and (?:a|an) (.+?)$/i, (m, ctx) => {
    const a = parseNoun(`a ${m[1]}`);
    const b = parseNoun(`a ${m[2]}`);
    if (!a || !b || !a.confident || !b.confident) return null;
    return [];
  }],
  // "If denial gets more votes, counter the spell"
  [/^if (\w+) gets more votes(?: or the vote is tied)?, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[2], newCtx({ ...ctx, targets: ctx.targets }));
    return inner ? [{ kind: 'conditional', if: { kind: 'amount', a: { kind: 'voteCount', option: m[1].toLowerCase() }, op: '>=', b: 1 }, then: inner }] : null;
  }],
  // "Until end of turn, you may pay {1} any time you could cast an instant"
  [/^(?:until end of turn, )?you may pay ((?:\{[^}]+\})+) any time you could cast an instant$/i, (m) => [
    { kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'mayPayAnytime', data: m[1] }, duration: 'thisTurn' },
  ]],
  // ---- Round 233 ----
  // "Each opponent loses life equal to the number of creatures attacking them"
  [/^each (opponent|player) (loses|gains) life equal to the number of (.+?) attacking them$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (!noun || !noun.confident) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const amt233: Amount = { kind: 'count', filter: { ...noun.filter, zone: 'battlefield', attacking: true, attackingRef: { ref: 'iter' } } };
    return [{ kind: 'forEach', over, effects: [/loses/i.test(m[2]) ? { kind: 'loseLife', amount: amt233, who: { ref: 'iter' } } : { kind: 'gainLife', amount: amt233, who: { ref: 'iter' } }] }];
  }],
  // "Draw a card for each Aura you controlled that was attached to it"
  [/^(?:you )?draws? (?:a card|(\w+|X) cards?) for each (Aura|Equipment) you controlled that (?:was|were) attached to it$/i, (m, ctx) => {
    const base = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof base !== 'number') return null;
    const host = ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF;
    const per: Amount = { kind: 'count', filter: { subtypes: [m[2]], controller: 'you', attachedToRef: host } };
    return [{ kind: 'draw', amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), who: YOU }];
  }],
  // "Copy it for each kind of counter among permanents you control"
  [/^copy (?:it|that spell) for each kind of counter among (.+?)$/i, (m, ctx) => {
    const noun = parseNoun(m[1]) ?? parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const ref = ctx.lastObj ?? SELF;
    return [{ kind: 'copySpell', what: ref, count: { kind: 'distinctCounterKinds', ref: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } } } }];
  }],
  // "Put one of those cards with that name into its owner's hand"
  [/^put one of those cards with that name into (?:its owner's|your) hand$/i, (m, ctx) => {
    const base = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [
      { kind: 'chooseObjects', who: YOU, filter: { nameIsChosen: 'cardName' }, count: 1, key: 'named233', from: base },
      { kind: 'moveToZone', what: { ref: 'chosen', key: 'named233' }, zone: 'hand' },
    ];
  }],
  // "Until your next end step, you may play one of those cards"
  [/^(?:until your next end step, )?you may play one of those cards$/i, (m, ctx) => {
    const base = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: base, duration: 'thisTurn' }];
  }],
  // "When you next attack this turn, untap each creature you control"
  [/^when you next attack this turn, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true }));
    return inner ? [{ kind: 'delayedTrigger', event: 'attacks', filter: { player: 'you', firstEachTurn: true }, effects: inner, text: m[0], once: true, untilEndOfTurn: true }] : null;
  }],
  // "Each opponent who voted for a choice you didn't vote for loses 2 life"
  [/^each (opponent|player) who voted for a choice you (?:didn't|did not) vote for (loses|gains) (\d+) life$/i, (m) => {
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const n = parseInt(m[3], 10);
    return [{ kind: 'forEach', over, effects: [/loses/i.test(m[2]) ? { kind: 'loseLife', amount: n, who: { ref: 'iter' } } : { kind: 'gainLife', amount: n, who: { ref: 'iter' } }] }];
  }],
  // "You and each opponent who voted for a choice you voted for may scry 2"
  [/^you and each (?:opponent|player) who voted for a choice you voted for may (.+)$/i, (m, ctx) => {
    const inner = parseSentence(`you ${m[1]}`, newCtx({ ...ctx, targets: ctx.targets }));
    if (!inner) return null;
    return [{ kind: 'may', prompt: m[1], effects: inner }, { kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'may', prompt: m[1], who: { ref: 'iter' }, effects: retargetToPlayer(inner, { ref: 'iter' }) }] }];
  }],
  // "It deals 2 damage to you unless it came under your control this turn"
  [/^(it|~) deals (\d+|X) damage to you unless it came under your control this turn$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? SELF;
    const amt233b: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'conditional', if: { kind: 'not', c: { kind: 'objectMatches', ref: src, filter: { enteredThisTurn: true } } }, then: [{ kind: 'damage', amount: amt233b, source: src, to: YOU }] }];
  }],
  // "They put the same number and kind of counters on ~"
  [/^(?:they|that player|its controller) puts? the same number and kind of counters on ~$/i, () => [
    { kind: 'addCounters', counter: 'any' as never, amount: { kind: 'ctxMemory', key: 'countersAdded' }, on: SELF },
  ]],
  // ---- Round 231 ----
  // "Destroy target artifact, enchantment, emblem, or gameplay tracker"
  [/^(destroy|exile) target (.+?), (.+?), (.+?), or (.+?)$/i, (m, ctx) => {
    const ns = [m[2], m[3], m[4], m[5]].map((x) => parseNoun(`a ${x}`));
    if (ns.some((n) => !n || !n.confident)) return null;
    ctx.targets.push({ description: `target ${m[2]}, ${m[3]}, ${m[4]} or ${m[5]}`, kind: 'object', filter: { anyOf: ns.map((n) => ({ ...n!.filter, zone: undefined })), zone: 'battlefield' } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [/destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : { kind: 'moveToZone', what: ref, zone: 'exile' }];
  }],
  // "Draw four cards, then choose X cards in your hand and discard the rest"
  [/^choose (X|\w+) cards in your hand and discard the rest$/i, (m) => {
    const n = m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1]);
    if (n === null) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { zone: 'hand', owner: 'you' }, count: n as Amount, key: 'keep231' },
      { kind: 'discard', amount: 'hand', who: YOU, except: { ref: 'chosen', key: 'keep231' } },
    ];
  }],
  // "An opponent chooses target creature they control"
  [/^an opponent chooses (target .+?) they control$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), filter: { ...noun.filter, zone: 'battlefield', controller: 'opponent' } });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "Prevent all damage that black sources and red sources would deal this turn"
  [/^prevent all damage that (.+?) sources and (.+?) sources would deal this turn$/i, (m) => {
    const a = parseNoun(`a ${m[1]} permanent`);
    const b = parseNoun(`a ${m[2]} permanent`);
    if (!a || !b) return null;
    return [{ kind: 'preventAll', to: 'all', source: { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }] } }];
  }],
  // "~ deals 1 damage to any target that was dealt damage this turn"
  [/^(.+?) deals (\d+|X) damage to any target that was dealt damage this turn$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!src) return null;
    ctx.targets.push({ description: 'any target that was dealt damage this turn', kind: 'any', filter: { damaged: true, zone: 'battlefield' }, playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const amt231: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt231, source: src, to: ref }];
  }],
  // "If ~ was kicked, it deals 3 damage to another target"
  [/^(?:it|~) deals (\d+|X) damage to another target$/i, (m, ctx) => {
    ctx.targets.push({ description: 'another target', kind: 'any', playerFilter: 'any', distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const amt231b: Amount = m[1].toUpperCase() === 'X' ? 'X' : parseInt(m[1], 10);
    return [{ kind: 'damage', amount: amt231b, source: SELF, to: ref }];
  }],
  // "Take an extra turn after this one for each coin that comes up heads"
  [/^take an extra turn after this one for each coin that comes up heads$/i, () => [
    { kind: 'repeat', times: { kind: 'ctxMemory', key: 'flipsWon' }, effects: [{ kind: 'extraTurn' }] },
  ]],
  // "Until end of turn, you may tap lands you do not control for mana"
  [/^(?:until end of turn, )?you may tap (.+?) you (?:do not|don't) control for mana$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'mayTapOthersForMana', data: { filter: { ...noun.filter, zone: 'battlefield' } } }, duration: 'thisTurn' }];
  }],
  // "For each land, destroy that land unless any player pays 1 life"
  [/^for each (.+?), (destroy|sacrifice) that \1 unless any player pays (\d+) life$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'forEach', over: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, effects: [
      { kind: 'unlessPays', who: { ref: 'eachPlayer' }, cost: { payLife: parseInt(m[3], 10) }, effects: [{ kind: 'destroy', what: { ref: 'iter' }, cantRegenerate: false }] },
    ] }];
  }],
  // "Then ~ deals 5 damage to each opponent who discarded their hand this way"
  [/^(.+?) deals (\d+|X) damage to each (opponent|player) who (?:discarded|sacrificed|drew|lost) .+? this way$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!src) return null;
    const amt231c: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt231c, source: src, to: /opponent/i.test(m[3]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' } }];
  }],
  // ---- Round 230 ----
  // "Create a token that is a copy of one of them" / "... of one of those permanents"
  [/^create (?:a|an) token that is a copy of one of (?:them|those (?:permanents|creatures|cards))$/i, (m, ctx) => {
    const base = ctx.lastObj;
    if (!base) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key: 'copy230', from: base },
      { kind: 'createToken', token: { name: 'Copy', typeLine: '', colors: [], copyOf: { ref: 'chosen', key: 'copy230' } }, count: 1 },
    ];
  }],
  // "Otherwise, exile the top card of each opponent's library"
  [/^exile the top card of each (opponent's|player's) library$/i, (m) => [
    { kind: 'exileTop', amount: 1, who: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' } },
  ]],
  // "Put a card you own exiled with ~ into your hand"
  [/^put (?:a|an) card you own exiled with ~ into your hand$/i, () => [
    { kind: 'chooseObjects', who: YOU, filter: { zone: 'exile', exiledWithSource: true, owner: 'you' }, count: 1, key: 'ex230' },
    { kind: 'moveToZone', what: { ref: 'chosen', key: 'ex230' }, zone: 'hand' },
  ]],
  // "Return ~ from your graveyard to the battlefield face up or face down"
  [/^return ~ from your graveyard to the battlefield face up or face down$/i, () => [
    { kind: 'chooseMode', count: 1, options: [
      { text: 'Face up', effects: [{ kind: 'returnToBattlefield', what: SELF }] },
      { text: 'Face down', effects: [{ kind: 'returnToBattlefield', what: SELF, faceDown: true }] },
    ] },
  ]],
  // "That attacking player may tap or untap target permanent of their choice"
  [/^(that attacking player|the attacking player|that player|target opponent) may tap or untap (target .+?)(?: of their choice)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const ref = who ? objRef(m[2], ctx) : null;
    if (!who || !ref) return null;
    return [{ kind: 'may', prompt: 'Tap or untap it?', who, effects: [{ kind: 'chooseMode', count: 1, options: [
      { text: 'Tap', effects: [{ kind: 'tap', what: ref }] },
      { text: 'Untap', effects: [{ kind: 'untap', what: ref }] },
    ] }] }];
  }],
  // "That player may pay {R}{R} or 2 life"
  [/^(.+?) may pay ((?:\{[^}]+\})+) or (\d+) life$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    return [{ kind: 'chooseMode', count: 1, options: [
      { text: `Pay ${m[2]}`, effects: [{ kind: 'ifPays', who, cost: m[2], effects: [] }] },
      { text: `Pay ${m[3]} life`, effects: [{ kind: 'loseLife', amount: parseInt(m[3], 10), who }] },
    ] }];
  }],
  // "You may cast a spell from among those cards without paying its mana cost"
  [/^you may cast (?:a|an) (.+?) from among (?:those cards|them)(?: without paying its mana cost)?$/i, (m, ctx) => {
    const base = ctx.lastObj;
    const noun = parseNoun(`a ${m[1]}`);
    if (!base || !noun) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: undefined }, count: 1, key: 'cast230', from: base, upTo: true },
      { kind: 'playFromExile', what: { ref: 'chosen', key: 'cast230' }, duration: 'thisTurn', free: /without paying/i.test(m[0]) || undefined },
    ];
  }],
  // "Cast target card with the same name as that spell from your graveyard"
  [/^cast target card with the same name as that spell from your graveyard$/i, (m, ctx) => {
    const cmp = ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : ({ ref: 'stackTarget' } as Ref);
    ctx.targets.push({ description: 'target card with the same name as that spell', kind: 'object', filter: { zone: 'graveyard', owner: 'you', sameNameAs: cmp } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'castFrom', what: ref }];
  }],
  // "Investigate once for each opponent who has more cards in hand than you"
  [/^investigate once for each (opponent|player) who has more cards in hand than you$/i, (m) => [
    { kind: 'investigate', count: { kind: 'playersComparingCount', who: /opponent/i.test(m[1]) ? 'opponent' : 'any', filter: { zone: 'hand' }, cmp: 'more' } },
  ]],
  // "You may look at and play that card this turn"
  [/^you may look at and play that card this turn$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn' }];
  }],
  // "All creatures banded with it gain first strike until end of turn"
  [/^all creatures banded with (?:it|~) (?:gain|gains) (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const g = parseGrantList(m[1]);
    if (!g || !g.keywords.length || g.abilities.length) return null;
    return [{ kind: 'grantKeywords', keywords: g.keywords, on: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', attacking: true } }, duration: 'endOfTurn' }];
  }],
  // ---- Round 228 ----
  // "Exile up to that many target cards from their graveyard" / "Choose up to that many target creatures you control"
  [/^(choose|exile|destroy|tap|return) up to that many (target .+?)$/i, (m, ctx) => {
    const noun = parseNoun(m[2]);
    if (!noun) return null;
    const gy = /graveyard/i.test(m[2]);
    ctx.targets.push({ ...toTargetSpec(noun), min: 0, max: 1, maxAmount: { kind: 'triggerAmount' } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    const k = m[1].toLowerCase();
    if (k === 'choose') return [];
    if (k === 'exile') return [{ kind: 'moveToZone', what: ref, zone: 'exile' }];
    if (k === 'destroy') return [{ kind: 'destroy', what: ref, cantRegenerate: false }];
    if (k === 'return') return [{ kind: 'returnToHand', what: ref }];
    void gy;
    return [{ kind: 'tap', what: ref }];
  }],
  // "~ and up to one other target creature cannot be blocked this turn"
  [/^~ and (up to one other target .+?|another target .+?) cannot be blocked this turn$/i, (m, ctx) => {
    const other = objRef(m[1], ctx);
    if (!other) return null;
    return [
      { kind: 'applyRule', rule: { kind: 'cantBeBlocked' }, on: SELF, duration: 'endOfTurn' },
      { kind: 'applyRule', rule: { kind: 'cantBeBlocked' }, on: other, duration: 'endOfTurn' },
    ];
  }],
  // "Each of your teammates creates a token that is a copy of ~"
  [/^each of your teammates creates (?:a|an) token that is a copy of ~$/i, () => [
    { kind: 'createToken', token: { name: 'Copy', typeLine: '', colors: [], copyOf: SELF }, count: 1, who: { ref: 'eachOpponent' } },
  ]],
  // "Choose target nontoken creature that is attacking that player"
  [/^choose (target .+?) that is attacking (that player|you|that opponent)$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), filter: { ...noun.filter, zone: 'battlefield', attacking: true } });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "Choose a land of each basic land type, then destroy those lands"
  [/^choose (?:a|an) (.+?) of each basic land type, then (destroy|exile) those (?:lands|permanents)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const key = 'basics228';
    const ref: Ref = { ref: 'chosen', key };
    ctx.lastObj = ref;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'battlefield', subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] }, count: 5, key, upTo: true },
      /destroy/i.test(m[2]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : { kind: 'moveToZone', what: ref, zone: 'exile' },
    ];
  }],
  // "You may pay any amount of life. If you do, draw that many cards"
  [/^you may pay any amount of life\. if you do, draw that many cards$/i, () => [
    { kind: 'chooseNumber', min: 0, max: 20, key: 'lifePaid' },
    { kind: 'loseLife', amount: { kind: 'ctxMemory', key: 'lifePaid' }, who: YOU },
    { kind: 'draw', amount: { kind: 'ctxMemory', key: 'lifePaid' }, who: YOU },
  ]],
  // "Only land creatures can attack during that combat phase" / "Only creatures in the pile of their choice can attack this turn"
  [/^only (.+?) can attack (?:during that combat phase|this turn|this combat)$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantAttack' }, on: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', notMatching: { ...noun.filter, zone: undefined } } as never }, duration: 'endOfTurn' }];
  }],
  // "If you do, it is goaded for as long as they control it"
  [/^(?:it|that creature) is goaded for as long as they control it$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'goad', what: ref }];
  }],
  // "Destroy enchanted land unless that player pays {1} or 1 life"
  [/^(destroy|sacrifice) (enchanted \w+|~) unless (?:that player|its controller|you) pays ((?:\{[^}]+\})+) or (\d+) life$/i, (m, ctx) => {
    const ref = /^~$/.test(m[2]) ? SELF : objRef(m[2], ctx);
    if (!ref) return null;
    const who: Ref = /^~$/.test(m[2]) ? YOU : { ref: 'controllerOf', of: ref };
    const inner: Effect = /destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : { kind: 'sacrifice', what: ref };
    return [{ kind: 'unlessPays', who, cost: { mana: m[3], payLife: 0 }, effects: [{ kind: 'unlessPays', who, cost: { payLife: parseInt(m[4], 10) }, effects: [inner] }] }];
  }],
  // ---- Round 227 ----
  [/^each of them enters with (?:an additional|(\w+) additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: {}, counter: m[2], amount: n } }, duration: 'thisTurn' }];
  }],
  [/^if the ((?:\{[^}]+\})+) cost was paid, (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[2], newCtx({ ...ctx, targets: ctx.targets }));
    return inner ? [{ kind: 'conditional', if: { kind: 'memoryFlag', key: 'additionalCostPaid' }, then: inner }] : null;
  }],
  [/^choose one of your opponents$/i, () => [{ kind: 'choosePlayer', key: 'opponent', who: 'opponent' }]],
  [/^(.+?) loses all "([^"]+)" abilities(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'loseKeywords', keywords: [m[2].replace(/^\w/, (c) => c.toUpperCase())], on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  [/^(destroy|exile|tap) (target .+?) that entered since your last turn ended$/i, (m, ctx) => {
    const noun = parseNoun(m[2]);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), filter: { ...noun.filter, zone: 'battlefield', enteredThisTurn: true } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [/destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : /exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'tap', what: ref }];
  }],
  // "Choose any number of target players or planeswalkers." (Kaboom!)
  [/^choose any number of target players or planeswalkers$/i, (m, ctx) => {
    ctx.targets.push({ description: 'any number of target players or planeswalkers', kind: 'any', filter: { types: ['Planeswalker'], zone: 'battlefield' }, playerFilter: 'any', min: 0, max: 20 });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.anyTarget = ctx.lastObj;
    return [];
  }],
  [/^choose any number of target (.+?), (.+?),? and\/or players$/i, (m, ctx) => {
    const a = parseNoun(`a ${singularize(m[1])}`);
    const b = parseNoun(`a ${singularize(m[2])}`);
    if (!a || !b) return null;
    ctx.targets.push({ description: `any number of target ${m[1]}, ${m[2]} and/or players`, kind: 'any', filter: { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }], zone: 'battlefield' }, playerFilter: 'any', min: 0, max: 6 });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  [/^the controller of (target .+?) copies it$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'copySpell', what: ref }] : null;
  }],
  [/^during that player's next untap step, (.+?) they control (?:do not|don't) untap$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    const who = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', controllerRef: who } }, duration: 'untilYourNextTurn' }];
  }],
  [/^choose (\w+) cards in each graveyard$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const key = 'gyEach227';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'chooseObjects', who: YOU, filter: { zone: 'graveyard', ownerRef: { ref: 'iter' } }, count: n, key, upTo: true }] }];
  }],
  [/^if you control (?:a|an) (.+?), (.+?) also (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    const inner = noun ? parseSentence(`${m[2]} ${m[3]}`, newCtx({ ...ctx, targets: ctx.targets })) : null;
    if (!noun || !noun.confident || !inner) return null;
    return [{ kind: 'conditional', if: { kind: 'count', filter: { ...noun.filter, zone: 'battlefield', controller: 'you' }, op: '>=', value: 1 }, then: inner }];
  }],
  // ---- Round 225 ----
  // "If you do, you may choose new targets for the spell"
  [/^(?:you may )?choose new targets for (?:the|that) (spell|ability|copy)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'changeTargets', what: ref }];
  }],
  // "It deals 6 damage to each creature it blocked this combat"
  [/^(it|~) deals (\d+|X) damage to each creature it blocked this (?:combat|turn)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const amt225: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt225, source: src, to: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', blockedBySource: true } } }];
  }],
  // "Sacrifice half the non-Demon permanents you control, rounded up"
  [/^sacrifice half the (.+?) you control,? rounded (up|down)$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', controller: 'you' };
    return [{ kind: 'sacrificeChoice', who: YOU, filter: f, count: { kind: 'half', a: { kind: 'count', filter: f }, round: /up/i.test(m[2]) ? 'up' : 'down' } }];
  }],
  // "That Mount or Vehicle gets +2/+0 and gains trample until end of turn"
  [/^that (Mount or Vehicle|Vehicle|Mount|Equipment|creature) gets ([+-]\d+)\/([+-]\d+) and (?:gains?|has) (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    const g = parseGrantList(m[4]);
    if (!ref || !g) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [{ kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: dur }];
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: ref, duration: dur });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: ref, duration: dur });
    return out;
  }],
  // "Exile one of them from your graveyard"
  [/^(exile|return) one of them from your graveyard(?: to your hand)?$/i, (m, ctx) => {
    const base = ctx.lastObj;
    if (!base) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key: 'oneOf225', from: base },
      /exile/i.test(m[1]) ? { kind: 'moveToZone', what: { ref: 'chosen', key: 'oneOf225' }, zone: 'exile' } : { kind: 'returnToHand', what: { ref: 'chosen', key: 'oneOf225' } },
    ];
  }],
  // "Choose a noncreature, nonland card from among them and copy it"
  [/^choose (?:a|an) (.+?) from among them and (copy|exile|cast) it$/i, (m, ctx) => {
    const base = ctx.lastObj;
    const noun = parseNoun(`a ${m[1]}`);
    if (!base || !noun) return null;
    const key = `amongst225`;
    const ref: Ref = { ref: 'chosen', key };
    const pick: Effect = { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: undefined }, count: 1, key, from: base };
    ctx.lastObj = ref;
    if (/copy/i.test(m[2])) return [pick, { kind: 'copyCard', what: ref }];
    if (/exile/i.test(m[2])) return [pick, { kind: 'moveToZone', what: ref, zone: 'exile' }];
    return [pick, { kind: 'castFrom', what: ref }];
  }],
  // "Then choose another attacking creature with lesser power"
  [/^choose another attacking creature with lesser power$/i, (ctx0, ctx) => {
    const key = 'lesser225';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: { types: ['Creature'], attacking: true, zone: 'battlefield', other: true, custom: 'powerLessThanSource' }, count: 1, key }];
  }],
  // "Attach target Equipment you control with mana value 2 or 3 to ~"
  [/^attach (target .+?) to ~$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'attach', what: ref, to: SELF }] : null;
  }],
  // "Put a lore counter on each of any number of target Sagas you control"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on each of any number of (target .+?)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(m[3]);
    if (typeof n !== 'number' || !noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), min: 0, max: 6 });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'addCounters', counter: m[2] as never, amount: n, on: ref }];
  }],
  // "Return it to the battlefield face down under its owner's control"
  [/^return (?:it|that card) to the battlefield face down under (?:its owner's|your) control$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'returnToBattlefield', what: ref, controller: /owner/i.test(m[0]) ? 'owner' : undefined, faceDown: true } as never];
  }],
  // "They may tap that permanent"
  [/^(?:they|that player|its controller) may tap that permanent$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const who = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    return [{ kind: 'may', prompt: 'Tap that permanent?', who, effects: [{ kind: 'tap', what: ref }] }];
  }],
  // "That player mills a card for each 1 damage dealt to them"
  [/^(.+?) mills (?:a card|(\w+) cards) for each 1 damage dealt to them$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const base = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || typeof base !== 'number') return null;
    const per: Amount = { kind: 'triggerAmount' };
    return [{ kind: 'mill', amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), who }];
  }],
  // ---- Round 224 ----
  // "Counter target spell that is the second spell cast this turn"
  [/^counter (target .+?) that is the (second|third|fourth) spell cast this turn$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    const nth = m[2].toLowerCase() === 'second' ? 2 : m[2].toLowerCase() === 'third' ? 3 : 4;
    ctx.targets.push({ ...toTargetSpec(noun), filter: { ...noun.filter, zone: 'stack', nthSpellThisTurn: nth } as never });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'counterSpell', what: ref }];
  }],
  // "Put a +1/+1 counter on the creature tapped to pay ~'s additional cost"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on the creature tapped to pay ~'s additional cost$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'addCounters', counter: m[2] as never, amount: n, on: { ref: 'chosen', key: 'tapped' } }];
  }],
  // "You may cast that exiled card without paying its mana cost"
  [/^you may cast that exiled card(?: without paying its mana cost)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "Each creature gets twice -X/-X until end of turn"
  [/^each (.+?) gets twice ([+-]X)\/([+-]X)(?: until end of turn)?$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const sign = m[2].startsWith('-') ? -2 : 2;
    const amount: Amount = { kind: 'times', a: sign as Amount, b: 'X' };
    return [{ kind: 'pump', power: amount, toughness: amount, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: 'endOfTurn' }];
  }],
  // "Counter that spell instead if its controller has three or more poison counters"
  [/^counter that spell instead if its controller has (\w+) or more (poison|rad|experience|energy) counters$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'conditional', if: { kind: 'playerStat', stat: m[2].toLowerCase() as never, ref: { ref: 'controllerOf', of: ref }, op: '>=', value: n }, then: [{ kind: 'counterSpell', what: ref }] }];
  }],
  // "Double the amount of each type of unspent mana you have"
  [/^double the amount of each type of unspent mana you have$/i, () => [{ kind: 'doubleMana', who: YOU } as never]],
  // ---- Round 223 ----
  // "You draw a card for each Mountain and red card in it"
  [/^(?:you )?draws? (?:a card|(\w+|X) cards?) for each ([A-Z][\w-]+) and (\w+) card in it$/i, (m, ctx) => {
    const base = m[1] ? wordToNumber(m[1]) : 1;
    const a1 = parseNoun(`a ${m[2]} card`);
    const a2 = parseNoun(`a ${m[3]} card`);
    if (typeof base !== 'number' || !a1 || !a2) return null;
    const who = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const per: Amount = { kind: 'count', filter: { anyOf: [{ ...a1.filter, zone: undefined }, { ...a2.filter, zone: undefined }], zone: 'hand', ownerRef: who } };
    return [{ kind: 'draw', amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), who: YOU }];
  }],
  // "You may choose new targets for target instant or sorcery spell"
  [/^(?:you may )?choose new targets for (target .+?)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'changeTargets', what: ref }] : null;
  }],
  // "Target player other than ~'s owner gains control of it"
  [/^target player other than ~'s owner gains control of it$/i, (m, ctx) => {
    ctx.targets.push({ description: "target player other than ~'s owner", kind: 'player', playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return [{ kind: 'gainControl', what: SELF, who: ref, duration: 'permanent' }];
  }],
  // "Put four +1/+1 counters on each artifact that became a creature this way"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on each (.+?) that became (?:a|an) creature this way$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const base = ctx.lastObj;
    if (typeof n !== 'number' || !base) return null;
    return [{ kind: 'addCounters', counter: m[2] as never, amount: n, on: base }];
  }],
  // "Then that player discards all cards with that name revealed this way"
  [/^(.+?) discards all cards with that name(?: revealed this way)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'discard', amount: 'hand', who, filter: { nameIsChosen: 'cardName' } }] : null;
  }],
  // "Each of those creatures deals damage equal to its toughness to the other"
  [/^each of those creatures deals damage equal to its (power|toughness) to the other$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    return [{ kind: 'fight', a: ref, b: ref, useToughness: /toughness/i.test(m[1]) || undefined }];
  }],
  // "For each creature, its controller sacrifices it unless they pay X life"
  [/^for each (.+?), its controller sacrifices it unless they pay (X|\d+) life$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const life = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'forEach', over: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, effects: [
      { kind: 'unlessPays', who: { ref: 'controllerOf', of: { ref: 'iter' } }, cost: { payLife: life as never }, effects: [{ kind: 'sacrifice', what: { ref: 'iter' } }] },
    ] }];
  }],
  // "The attacking player chooses how each creature blocks each combat."
  [/^the (attacking|defending) player chooses how each creature blocks each combat$/i, (m) => [
    { kind: 'grantPlayerRule', who: /attacking/i.test(m[1]) ? { ref: 'eachPlayer' } : YOU, rule: { kind: 'custom', tag: 'attackerChoosesBlocks' } },
  ]],
  // ---- Round 222 ----
  // "Destroy target non-Elf creature whose power and toughness aren't equal"
  [/^(destroy|exile|tap) (target .+?) whose power and toughness (?:aren't|are not) equal$/i, (m, ctx) => {
    const noun = parseNoun(m[2]);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), filter: { ...noun.filter, zone: 'battlefield', custom: 'powerNotEqualToughness' } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [/destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : /exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'tap', what: ref }];
  }],
  // "Destroy all permanents with that spell's mana value"
  [/^(destroy|exile) all (.+?) with that spell's mana value$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!noun || !noun.confident) return null;
    const cmp = ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : ({ ref: 'stackTarget' } as Ref);
    const ref: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', cmcEQRef: cmp } };
    return [/destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : { kind: 'moveToZone', what: ref, zone: 'exile' }];
  }],
  // "That planeswalker enters with an additional loyalty counter on it"
  [/^that (planeswalker|creature|artifact|permanent) enters with (?:an additional|(\w+) additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!noun || typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: { ...noun.filter, zone: undefined }, counter: m[3], amount: n } }, duration: 'thisTurn' }];
  }],
  // "Any opponent may tap an untapped creature they control"
  [/^any opponent may tap (?:a|an) (.+?) they control$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'may', prompt: `Tap a ${m[1]}?`, who: { ref: 'iter' }, effects: [{ kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } }, count: 1, key: 'tap222' }, { kind: 'tap', what: { ref: 'chosen', key: 'tap222' } }] }] }];
  }],
  // "At end of combat, destroy it and all creatures it blocked this turn"
  [/^at end of combat, destroy (?:it|~) and all creatures it blocked this turn$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? SELF;
    return [{ kind: 'delayedTrigger', event: 'endOfCombat', text: m[0], once: true, effects: [
      { kind: 'destroy', what: ref, cantRegenerate: false },
      { kind: 'destroy', what: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', blockedBySource: true } }, cantRegenerate: false },
    ] }];
  }],
  // "Each player gains control of each land they own that you control"
  [/^each player gains control of each (.+?) they own that you control$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'gainControl', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', ownerRef: { ref: 'iter' }, controller: 'you' } }, who: { ref: 'iter' }, duration: 'permanent' }] }];
  }],
  // "Exchange control of ~ and target permanent you neither own nor control"
  [/^exchange control of ~ and (target .+?)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'exchangeControl', a: SELF, b: ref } as never] : null;
  }],
  // "Have target land become a Plains until ~ leaves the battlefield"
  [/^have (target .+?) become (?:a|an) ([A-Z][\w-]+)(?: until ~ leaves the battlefield)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'addTypes', types: [], setSubtypes: [m[2]], on: ref, duration: / until ~ leaves the battlefield$/i.test(m[0]) ? 'untilSourceLeaves' : 'permanent' }];
  }],
  // "Put a +1/+1 counter on ~ for each 1 damage dealt to you this turn"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on (~|it) for each 1 damage dealt to you this turn$/i, (m, ctx) => {
    const base = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof base !== 'number') return null;
    const ref = /^~$/.test(m[3]) ? SELF : ctx.lastObj ?? SELF;
    const per: Amount = { kind: 'playerTurnStat', key: 'damageTaken' };
    return [{ kind: 'addCounters', counter: m[2] as never, amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), on: ref }];
  }],
  // ---- Round 221 ----
  [/^(.+?) deals (\d+|X) damage to each of those (.+?)$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (!src || !noun || !noun.confident) return null;
    const amt221: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt221, source: src, to: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } } }];
  }],
  [/^(.+?) deals (\d+|X) damage to each (.+?) not chosen this way$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (!src || !noun || !noun.confident) return null;
    const amt221b: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt221b, source: src, to: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } } }];
  }],
  [/^exile one of those (.+?) and put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on the other$/i, (m, ctx) => {
    const base = ctx.lastObj;
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!base || typeof n !== 'number') return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key: 'oneOf221', from: base },
      { kind: 'moveToZone', what: { ref: 'chosen', key: 'oneOf221' }, zone: 'exile' },
      { kind: 'addCounters', counter: m[2] as never, amount: n, on: base },
    ];
  }],
  [/^put one back and the rest into (?:that player's|its owner's|their) graveyard$/i, (m, ctx) => {
    const base = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [
      { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key: 'keep221', from: base },
      { kind: 'moveToZone', what: base, zone: 'graveyard' },
    ];
  }],
  [/^choose (target spell or permanent) that is (.+?)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]} permanent`);
    if (!noun || !noun.confident) return null;
    ctx.targets.push({ description: m[1], kind: 'objectOrSpell', filter: { ...noun.filter, zone: undefined } });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  [/^(.+?) discards another card at random unless they pay ((?:\{[^}]+\})+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'unlessPays', who, cost: m[2], effects: [{ kind: 'discard', amount: 1, who, random: true }] }] : null;
  }],
  [/^add one mana of that colou?r unless any player pays ((?:\{[^}]+\})+)$/i, (m) => [
    { kind: 'unlessPays', who: { ref: 'eachPlayer' }, cost: m[1], effects: [{ kind: 'addMana', mana: 'chosenColor', amount: 1 }] },
  ]],
  // ---- Round 220 ----
  // "Put a +1/+1 counter on ~ for each flip you won" / "For each flip you won, create a token ..."
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on (~|it) for each flip you won$/i, (m, ctx) => {
    const base = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof base !== 'number') return null;
    const ref = /^~$/.test(m[3]) ? SELF : ctx.lastObj ?? SELF;
    const per: Amount = { kind: 'ctxMemory', key: 'flipsWon' };
    return [{ kind: 'addCounters', counter: m[2] as never, amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), on: ref }];
  }],
  // "Put a random creature card from among them onto the battlefield"
  [/^put (?:a|an) random (.+?) from among them onto the battlefield$/i, (m, ctx) => {
    const base = ctx.lastObj;
    const noun = parseNoun(`a ${m[1]}`);
    if (!base || !noun) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: undefined }, count: 1, key: 'rand220', from: base, random: true },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key: 'rand220' } },
    ];
  }],
  // "Sacrifice it and attach ~ to a creature you control"
  [/^sacrifice it and attach ~ to (?:a|an) (.+?)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    const noun = parseNoun(`a ${m[1]}`);
    if (!ref || !noun || !noun.confident) return null;
    return [
      { kind: 'sacrifice', what: ref },
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'battlefield' }, count: 1, key: 'host220' },
      { kind: 'attach', what: SELF, to: { ref: 'chosen', key: 'host220' } },
    ];
  }],
  // "Sacrifice it unless you exile a creature you control other than ~"
  [/^sacrifice it unless you exile (?:a|an) (.+?) other than ~$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { exileFromGraveyard: { ...noun.filter, zone: 'battlefield', other: true }, count: 1 }, effects: [{ kind: 'sacrifice', what: ref }] }];
  }],
  // "That player chooses artifact, creature, land, or non-Aura enchantment"
  [/^(.+?) chooses ((?:[\w -]+)(?:, [\w -]+)*,? or [\w -]+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const opts = m[2].split(/,? or |, /).map((x) => x.trim()).filter(Boolean);
    if (!who || opts.length < 2 || opts.length > 6) return null;
    if (!opts.every((o) => parseNoun(`a ${o}`)?.confident)) return null;
    return [{ kind: 'chooseOption', key: 'cardType', options: opts }];
  }],
  // "Destroy target land with an activated ability that is not a mana ability"
  [/^(destroy|exile|tap) (target .+?) with an activated ability that is not a mana ability$/i, (m, ctx) => {
    const noun = parseNoun(m[2]);
    if (!noun) return null;
    ctx.targets.push({ ...toTargetSpec(noun), filter: { ...noun.filter, zone: 'battlefield', custom: 'hasNonManaActivatedAbility' } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [/destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : /exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'tap', what: ref }];
  }],
  // "All unblocked creatures attacking you become blocked by ~"
  [/^all unblocked creatures attacking you become blocked by ~$/i, () => [
    { kind: 'applyRule', rule: { kind: 'custom', tag: 'blockedBySource' }, on: { ref: 'all', filter: { types: ['Creature'], attacking: true, zone: 'battlefield', custom: 'unblocked' } }, duration: 'endOfTurn' },
  ]],
  // "If you do, the first creature assigns no combat damage this turn"
  [/^the (?:first|other) creature assigns no combat damage this turn$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'assignsNoCombatDamage' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Put target face-up card they own in exile on the bottom of their library"
  [/^put (target face-up card they own in exile|target face-up exiled card) on the (bottom|top) of (?:their|its owner's) library$/i, (m, ctx) => {
    ctx.targets.push({ description: m[1], kind: 'object', filter: { zone: 'exile', faceDown: false } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'putOnLibrary', what: ref, position: /bottom/i.test(m[2]) ? 'bottom' : 'top' }];
  }],
  // "Exile up to one card of each card type from defending player's graveyard"
  [/^exile up to one card of each card type from (defending player's|target player's|that player's|your) graveyard$/i, (m, ctx) => {
    const who = /your/i.test(m[1]) ? YOU : m[1].startsWith('defending') ? ({ ref: 'defendingPlayer' } as Ref) : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    return [
      { kind: 'chooseObjects', who: YOU, filter: { zone: 'graveyard', ownerRef: who }, count: 7, key: 'typeEx', upTo: true },
      { kind: 'moveToZone', what: { ref: 'chosen', key: 'typeEx' }, zone: 'exile' },
    ];
  }],
  // ---- Round 217 ----
  // "Have ~'s base power and toughness become 4/1 or 1/4 until end of turn"
  [/^have (.+?)'s base power and toughness become ([\dX]+)\/([\dX]+) or ([\dX]+)\/([\dX]+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const mk = (p: string, t: string): Effect => ({ kind: 'setPT', power: p === 'X' ? 'X' : parseInt(p, 10), toughness: t === 'X' ? 'X' : parseInt(t, 10), on: ref, duration: 'endOfTurn' });
    return [{ kind: 'chooseMode', count: 1, options: [
      { text: `${m[2]}/${m[3]}`, effects: [mk(m[2], m[3])] },
      { text: `${m[4]}/${m[5]}`, effects: [mk(m[4], m[5])] },
    ] }];
  }],
  // "Sacrifice up to three Zombies"
  [/^sacrifice up to (\w+) (.+?)$/i, (m) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    return [{ kind: 'sacrificeChoice', who: YOU, filter: { ...noun.filter, zone: 'battlefield', controller: 'you' }, count: n, upTo: true }];
  }],
  // "That player untaps ~ and gains control of it"
  [/^(that player|target opponent|target player|the attacking player) untaps ~ and gains control of it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'untap', what: SELF }, { kind: 'gainControl', what: SELF, who, duration: 'permanent' }] : null;
  }],
  // "Return ~ to its owner's hand unless you remove two oil counters from it"
  [/^return ~ to its owner's hand unless you remove (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? from it$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { removeCounters: { counter: m[2] as never, amount: n } } as never, effects: [{ kind: 'returnToHand', what: SELF }] }];
  }],
  // "Put two level counters on each creature you control with level up"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on each (.+?)$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    return [{ kind: 'addCounters', counter: m[2] as never, amount: n, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } } }];
  }],
  // "Unlock a locked door of up to one target Room you control"
  [/^unlock a locked door of (?:up to one )?(target .+?)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'unlockDoor', door: 1 }] : null;
  }],
  // "You may return one of those Dragons to its owner's hand"
  [/^you may return one of (?:those|them) ?(.*?) to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const base = ctx.lastObj;
    if (!base) return null;
    return [{ kind: 'may', prompt: 'Return one to its owner’s hand?', effects: [{ kind: 'chooseObjects', who: YOU, filter: { zone: 'battlefield' }, count: 1, key: 'oneOf217', from: base }, { kind: 'returnToHand', what: { ref: 'chosen', key: 'oneOf217' } }] }];
  }],
  // "Create a token that is a copy of one of them" / "Play one of them without paying its mana cost"
  [/^(?:create a token that is a copy of|play|cast) one of them(?: without paying its mana cost)?$/i, (m, ctx) => {
    const base = ctx.lastObj;
    if (!base) return null;
    const pick: Effect = { kind: 'chooseObjects', who: YOU, filter: {}, count: 1, key: 'oneOf217b', from: base };
    const ref: Ref = { ref: 'chosen', key: 'oneOf217b' };
    if (/^create/i.test(m[0])) return [pick, { kind: 'createToken', token: { name: 'Copy', typeLine: '', colors: [], copyOf: ref }, count: 1 }];
    return [pick, { kind: 'playFromExile', what: ref, duration: 'thisTurn', free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "Exile cards equal to its power from the top of its owner's library"
  [/^exile cards equal to its power from the top of (?:its owner's|their|that player's) library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const who: Ref = ctx.lastPlayer ?? { ref: 'ownerOf', of: ref };
    return [{ kind: 'exileTop', amount: { kind: 'power', ref }, who }];
  }],
  // "You create a Food token for each player being attacked"
  [/^you create (?:a|an) ([\w' -]+?) token for each player being attacked$/i, (m) => {
    const t = parseTokenPhrase(`a ${m[1]} token`);
    if (!t) return null;
    return [{ kind: 'createToken', token: t.token, count: { kind: 'count', filter: { types: ['Creature'], attacking: true, zone: 'battlefield' } } }];
  }],
  // "You manifest the top card of that player's library"
  [/^you manifest the top card of (that player's|target player's|your) library$/i, (m, ctx) => {
    const who = /your/i.test(m[1]) ? YOU : ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    return [{ kind: 'manifest', amount: 1, who }];
  }],
  // ---- Round 216 ----
  // "Exile all other spells and counter all abilities"
  [/^exile all other spells and counter all abilities$/i, () => [
    { kind: 'moveToZone', what: { ref: 'all', filter: { zone: 'stack', other: true } }, zone: 'exile' },
  ]],
  // "Each player who sacrificed a creature this way draws two cards"
  [/^each player who (sacrificed|discarded|drew|lost) (?:a|an|(\w+)) (.+?) this way (.+)$/i, (m, ctx) => {
    const inner = parseSentence(`each player ${m[4]}`, newCtx({ ...ctx, targets: ctx.targets }));
    return inner && inner.length ? inner : null;
  }],
  // "Each player sacrifices that many creatures of their choice"
  [/^each (player|opponent) sacrifices that many (.+?)(?: of their choice)?$/i, (m) => {
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!noun || !noun.confident) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } }, count: { kind: 'chosenNumber' } }] }];
  }],
  // "Target Mount you control becomes saddled until end of turn"
  [/^(target .+?|it|that creature|~) becomes (saddled|crewed|monstrous)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const tag = m[2].toLowerCase() === 'saddled' ? 'saddled' : m[2].toLowerCase() === 'crewed' ? 'crewed' : 'monstrous';
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag }, on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  // "Return the other to the battlefield under your control"
  [/^return the other to the battlefield under your control$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'returnToBattlefield', what: ref }];
  }],
  // "You may put that card into that player's graveyard"
  [/^you may put that card into (that player's|its owner's|your) graveyard$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'may', prompt: 'Put that card into its graveyard?', effects: [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] }];
  }],
  // "~ becomes that color until end of turn"
  [/^(.+?) becomes that colou?r(?: until end of turn)?$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'setColors', colors: [], chosenKey: 'color', on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  // "Leave the chosen cards in your graveyard and put the rest into your hand"
  [/^leave the chosen cards in your graveyard and put the rest into your hand$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'hand' }];
  }],
  // "Target opponent may choose to put those cards into your hand"
  [/^(target opponent|that player|an opponent) may choose to put those cards into your hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return who ? [{ kind: 'may', prompt: 'Put those cards into their hand?', who, effects: [{ kind: 'moveToZone', what: ref, zone: 'hand' }] }] : null;
  }],
  // "Target opponent exiles a creature they control and their graveyard"
  [/^(target opponent|target player|that player) exiles (?:a|an) (.+?) they control and their graveyard$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    return [
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: 1, key: 'oppExile' },
      { kind: 'moveToZone', what: { ref: 'chosen', key: 'oppExile' }, zone: 'exile' },
      { kind: 'moveAll', who, from: 'graveyard', to: 'exile' },
    ];
  }],
  // "Incubate 2, then transform an Incubator token you control"
  [/^incubate (\w+|X), then transform an Incubator token you control$/i, (m) => {
    const n = wordToNumber(m[1]) ?? (m[1].toUpperCase() === 'X' ? 'X' : null);
    if (n === null) return null;
    return [
      { kind: 'createToken', token: { name: 'Incubator', typeLine: 'Artifact — Incubator', colors: [], preset: 'Incubator' }, count: 1 },
      { kind: 'addCounters', counter: '+1/+1', amount: n as Amount, on: { ref: 'lastCreated' } },
      { kind: 'transform', what: { ref: 'lastCreated' } },
    ];
  }],
  // "The controller of each of those artifacts gains life equal to its mana value"
  [/^the controller of each of those (.+?) gains life equal to its mana value$/i, (m, ctx) => {
    const base = ctx.lastObj;
    if (!base) return null;
    return [{ kind: 'forEach', over: base, effects: [{ kind: 'gainLife', amount: { kind: 'manaValue', ref: { ref: 'iter' } }, who: { ref: 'controllerOf', of: { ref: 'iter' } } }] }];
  }],
  // ---- Round 215 ----
  // "That land's controller may attach ~ to a land of their choice" / "That player attaches ~ to a land of their choice"
  [/^(.+?) (?:may attach|attaches) ~ to (?:a|an) (.+?)(?: of their choice)?$/i, (m, ctx) => {
    const who = playerRef(m[1].replace(/'s controller$/i, "'s controller"), ctx);
    const noun = parseNoun(`a ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    const key = `host215_${ctx.targets.length}`;
    const pick: Effect = { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield' }, count: 1, key };
    const body: Effect[] = [pick, { kind: 'attach', what: SELF, to: { ref: 'chosen', key } }];
    return /may attach/i.test(m[0]) ? [{ kind: 'may', prompt: `Attach ~ to a ${m[2]}?`, who, effects: body }] : body;
  }],
  // "Each opponent gets a number of rad counters equal to its power"
  [/^each (opponent|player) gets a number of (rad|poison|energy|experience) counters equal to (.+?)$/i, (m, ctx) => {
    const a215 = amt(m[3], ctx);
    if (a215 === null) return null;
    const stat = m[2].toLowerCase();
    return [{ kind: 'addCounters', counter: stat as never, amount: a215, on: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' } }];
  }],
  // "Destroy all Equipment attached to that creature at end of combat"
  [/^(destroy|exile) all (Equipment|Auras) attached to (that creature|it) at end of combat$/i, (m, ctx) => {
    const host = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    if (!host) return null;
    const sub = /^Auras$/i.test(m[2]) ? 'Aura' : 'Equipment';
    const inner: Effect = /destroy/i.test(m[1])
      ? { kind: 'destroy', what: { ref: 'all', filter: { subtypes: [sub], zone: 'battlefield', attachedToRef: host } }, cantRegenerate: false }
      : { kind: 'moveToZone', what: { ref: 'all', filter: { subtypes: [sub], zone: 'battlefield', attachedToRef: host } }, zone: 'exile' };
    return [{ kind: 'delayedTrigger', event: 'endOfCombat', effects: [inner], text: m[0], once: true }];
  }],
  // "Sacrifice a permanent other than that creature or ~"
  [/^sacrifice (?:a|an) (.+?) other than (?:that creature|it) or ~$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'sacrificeChoice', who: YOU, filter: { ...noun.filter, zone: 'battlefield', controller: 'you', other: true }, count: 1 }];
  }],
  // "Choose a creature you control and an opponent"
  [/^choose (?:a|an) (.+?) you control and an opponent$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} you control`);
    if (!noun || !noun.confident) return null;
    const key = `c215_${ctx.targets.length}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'battlefield' }, count: 1, key },
      { kind: 'choosePlayer', key: 'opponent', who: 'opponent' },
    ];
  }],
  // "Choose new targets for any number of other spells and/or abilities"
  [/^choose new targets for any number of other spells(?: and\/or abilities)?$/i, () => [
    { kind: 'changeTargets', what: { ref: 'all', filter: { zone: 'stack', other: true } } },
  ]],
  // "Reselect its target at random"
  [/^reselect its target at random$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'changeTargets', what: ref }];
  }],
  // "Target opponent chosen at random gains control of ~"
  [/^target (opponent|player) chosen at random gains control of ~$/i, (m) => [
    { kind: 'choosePlayer', key: 'randomPlayer', who: /opponent/i.test(m[1]) ? 'opponent' : 'any', random: true },
    { kind: 'gainControl', what: SELF, who: { ref: 'chosen', key: 'randomPlayer' }, duration: 'permanent' },
  ]],
  // "Then attach ~ to another one of your opponents chosen at random"
  [/^attach ~ to another one of your opponents chosen at random$/i, () => [
    { kind: 'choosePlayer', key: 'randomPlayer', who: 'opponent', random: true },
    { kind: 'attach', what: SELF, to: { ref: 'chosen', key: 'randomPlayer' } },
  ]],
  // "Any opponent may have you put that card into your graveyard"
  [/^any opponent may have you put that card into your (graveyard|hand)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'may', prompt: `Put that card into its owner's ${m[1]}?`, who: { ref: 'iter' }, effects: [{ kind: 'moveToZone', what: ref, zone: /graveyard/i.test(m[1]) ? 'graveyard' : 'hand' }] }] }];
  }],
  // "An opponent chooses a permanent you control other than ~ and exiles it"
  [/^an opponent chooses (?:a|an) (.+?) you control other than ~ and exiles it$/i, (m) => {
    const noun = parseNoun(`a ${m[1]} you control`);
    if (!noun || !noun.confident) return null;
    return [
      { kind: 'choosePlayer', key: 'opponent', who: 'opponent' },
      { kind: 'chooseObjects', who: { ref: 'chosen', key: 'opponent' }, filter: { ...noun.filter, zone: 'battlefield', other: true }, count: 1, key: 'oppPick' },
      { kind: 'moveToZone', what: { ref: 'chosen', key: 'oppPick' }, zone: 'exile' },
    ];
  }],
  // "The exiled card's owner may cast that card without paying its mana cost"
  [/^the exiled card's owner may cast that card(?: without paying its mana cost)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', owner: true, free: /without paying/i.test(m[0]) || undefined }];
  }],
  // ---- Round 213 ----
  // "~ deals 2 damage to target player or battle"
  [/^(.+?) deals (\d+|X) damage to target player or battle$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!src) return null;
    ctx.targets.push({ description: 'target player or battle', kind: 'objectOrPlayer', filter: { types: ['Battle'], zone: 'battlefield' }, playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const amt2: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt2, source: src, to: ref }];
  }],
  // "~ deals 1 damage to target creature token, player, or planeswalker"
  [/^(.+?) deals (\d+|X) damage to target (.+?), player, or planeswalker$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    if (!src || !noun) return null;
    ctx.targets.push({ description: `target ${m[3]}, player, or planeswalker`, kind: 'any', filter: { anyOf: [{ ...noun.filter, zone: undefined }, { types: ['Planeswalker'] }], zone: 'battlefield' }, playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const amt3: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt3, source: src, to: ref }];
  }],
  // "~ deals 2 damage to any target chosen at random"
  [/^(.+?) deals (\d+|X) damage to any target chosen at random$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!src) return null;
    ctx.targets.push({ description: 'any target', kind: 'any', playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const amt4: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt4, source: src, to: ref }];
  }],
  // "Destroy all creatures with power greater than target creature's power"
  [/^destroy all creatures with (power|toughness) greater than target creature's \1$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target creature', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield' } });
    const tref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    const key = /power/i.test(m[1]) ? 'powerGTRef' : 'toughnessGTRef';
    return [{ kind: 'destroy', what: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', [key]: tref } as never }, cantRegenerate: false }];
  }],
  // "Destroy each creature with the same mana value as the sacrificed creature"
  [/^destroy each creature with the same mana value as the sacrificed creature$/i, () => [
    { kind: 'destroy', what: { ref: 'all', filter: { types: ['Creature'], zone: 'battlefield', cmcEQRef: { ref: 'chosen', key: 'sacrificed' } } as never }, cantRegenerate: false },
  ]],
  // "Return half the creatures they control to their owner's hand, rounded up"
  [/^return half the (.+?) they control to (?:their|its) owner'?s'? hands?,? rounded (up|down)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const who = ctx.lastPlayer ?? ({ ref: 'triggerPlayer' } as Ref);
    const cnt: Amount = { kind: 'half', a: { kind: 'count', filter: { ...noun.filter, zone: 'battlefield', controllerRef: who } }, round: /up/i.test(m[2]) ? 'up' : 'down' };
    return [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'battlefield', controllerRef: who }, count: cnt, key: 'halfBounce' }, { kind: 'returnToHand', what: { ref: 'chosen', key: 'halfBounce' } }];
  }],
  // "Target player loses 2 life plus 2 life for each Spirit sacrificed this way"
  [/^(.+?) loses (\d+) life plus (\d+) life for each (.+?) sacrificed this way$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const per: Amount = { kind: 'countRef', ref: { ref: 'chosen', key: 'sacrificed' } };
    const extra: Amount = parseInt(m[3], 10) === 1 ? per : { kind: 'times', a: parseInt(m[3], 10) as Amount, b: per };
    return [{ kind: 'loseLife', amount: { kind: 'sum', parts: [parseInt(m[2], 10), extra] }, who }];
  }],
  // "You gain control of all Equipment that were attached to it"
  [/^you gain control of all (Equipment|Auras) that (?:were|was) attached to (it|that creature)$/i, (m, ctx) => {
    const host = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    if (!host) return null;
    const sub = /^Auras$/i.test(m[1]) ? 'Aura' : 'Equipment';
    return [{ kind: 'gainControl', what: { ref: 'all', filter: { subtypes: [sub], zone: 'battlefield', attachedToRef: host } }, who: YOU, duration: 'permanent' }];
  }],
  // "Exile target Spirit, creature with disturb, or enchantment"
  [/^(exile|destroy|tap) target (.+?), (.+?), or (.+?)$/i, (m, ctx) => {
    const ns = [m[2], m[3], m[4]].map((x) => parseNoun(`a ${x}`));
    if (ns.some((n) => !n || !n.confident)) return null;
    ctx.targets.push({ description: `target ${m[2]}, ${m[3]}, or ${m[4]}`, kind: 'object', filter: { anyOf: ns.map((n) => ({ ...n!.filter, zone: undefined })), zone: 'battlefield' } });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [/exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : /destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : { kind: 'tap', what: ref }];
  }],
  // "Put each creature card milled this way onto the battlefield"
  [/^put each (.+?) card milled this way onto the battlefield$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun) return null;
    return [{ kind: 'returnToBattlefield', what: { ref: 'lastMoved' } }];
  }],
  // ---- Round 212 ----
  // "Target creature gets +2/+2 until end of turn for each of its colors"
  [/^(.+?) (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)? for each of its colou?rs$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const per: Amount = { kind: 'colorCount', ref };
    return [{ kind: 'pump', power: { kind: 'times', a: parseInt(m[2], 10) as Amount, b: per }, toughness: { kind: 'times', a: parseInt(m[3], 10) as Amount, b: per }, on: ref, duration: 'endOfTurn' }];
  }],
  // "You gain 2 life for each green mana symbol in those cards' mana costs"
  [/^you gain (\d+) life for each (white|blue|black|red|green) mana symbol in those cards' mana costs$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    const per: Amount = { kind: 'manaSymbolCount', ref, color: ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[2].toLowerCase() as 'white'] };
    const n = parseInt(m[1], 10);
    return [{ kind: 'gainLife', amount: n === 1 ? per : ({ kind: 'times', a: n as Amount, b: per } as Amount), who: YOU }];
  }],
  // "You may have it become no longer suspected"
  [/^you may have (?:it|that creature) become no longer suspected$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'may', prompt: 'Remove suspected?', effects: [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'suspected', data: '__clear__' }, on: ref, duration: 'permanent' }] }];
  }],
  // "Destroy any of them that are Walls"
  [/^(destroy|exile|tap) any of them that are (.+?)$/i, (m, ctx) => {
    const base = ctx.lastObj;
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!base || !noun || !noun.confident) return null;
    const ref: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    return [/destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : /exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'tap', what: ref }];
  }],
  // ---- Round 211 ----
  // "Have ~'s base power and toughness become 4/2 until end of turn"
  [/^have (.+?)'s base power and toughness become ([\dX]+)\/([\dX]+)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur }];
  }],
  // "Have it assign no combat damage this turn"
  [/^have (it|~|that creature) assign no combat damage this turn$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'assignsNoCombatDamage' }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Put that number of +1/+1 counters on target creature"
  [/^put that number of ([+-]\d+\/[+-]\d+|[\w'-]+) counters on (.+?)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[1] as never, amount: { kind: 'chosenNumber' }, on: ref }] : null;
  }],
  // "Put a number of +1/+1 counters equal to that artifact's mana value on ~"
  [/^put a number of ([+-]\d+\/[+-]\d+|[\w'-]+) counters equal to (.+?) on (.+?)$/i, (m, ctx) => {
    const a = amt(m[2], ctx);
    const ref = m[3] === '~' ? SELF : objRef(m[3], ctx);
    return a !== null && ref ? [{ kind: 'addCounters', counter: m[1] as never, amount: a, on: ref }] : null;
  }],
  // "The token created this way gains haste"
  [/^the tokens? created this way (?:gains?|has|have) (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const g = parseGrantList(m[1]);
    if (!g) return null;
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [];
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: ref, duration: dur });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: ref, duration: dur });
    return out.length ? out : null;
  }],
  // "Each player chooses two nontoken, non-Vehicle creatures they control"
  [/^each player chooses (?:a|an|(\w+)) (.+?) they control$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    const ref: Ref = { ref: 'chosen', key: 'chosenEach' };
    ctx.lastObj = ref;
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } }, count: n, key: 'chosenEach', upTo: true }] }];
  }],
  // "For each player, destroy up to one nonbasic land that player controls"
  [/^for each player, (destroy|exile|tap) up to one (.+?) that player controls$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun || !noun.confident) return null;
    const filter: ObjectFilter = { ...noun.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } };
    const pick: Effect = { kind: 'chooseObjects', who: YOU, filter, count: 1, key: 'perPlayer', upTo: true };
    const ref: Ref = { ref: 'chosen', key: 'perPlayer' };
    const act: Effect = /destroy/i.test(m[1]) ? { kind: 'destroy', what: ref, cantRegenerate: false } : /exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'tap', what: ref };
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [pick, act] }];
  }],
  // "You gain 1 life for each of the chosen colors it is"
  [/^you gain (\d+) life for each of the chosen colou?rs it is$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const per: Amount = { kind: 'colorCount', ref };
    const n = parseInt(m[1], 10);
    return [{ kind: 'gainLife', amount: n === 1 ? per : ({ kind: 'times', a: n as Amount, b: per } as Amount), who: YOU }];
  }],
  // "Put a +1/+1 counter on ~ for each of that spell's colors"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on (~|it) for each of that spell's colou?rs$/i, (m, ctx) => {
    const base = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof base !== 'number') return null;
    const ref = /^~$/.test(m[3]) ? SELF : ctx.lastObj ?? SELF;
    const per: Amount = { kind: 'colorCount', ref: ctx.triggerHasObject ? { ref: 'triggerObject' } : { ref: 'stackTarget' } };
    return [{ kind: 'addCounters', counter: m[2] as never, amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), on: ref }];
  }],
  // "The attacking player gains control of ~ and untaps it"
  [/^(the attacking player|that attacking player|that player|target opponent) gains control of ~ and untaps it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'gainControl', what: SELF, who, duration: 'permanent' }, { kind: 'untap', what: SELF }] : null;
  }],
  // "Exile ~, then return it to the battlefield under an opponent's control"
  [/^exile ~, then return it to the battlefield under (an opponent's|its owner's|your) control$/i, (m) => [
    { kind: 'moveToZone', what: SELF, zone: 'exile' },
    { kind: 'returnToBattlefield', what: { ref: 'lastMoved' }, controller: /owner/i.test(m[1]) ? 'owner' : undefined },
  ]],
  // ---- Round 210 ----
  // "Target opponent's life total becomes 10"
  [/^(.+?)'s life total becomes (\d+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'setLife', amount: parseInt(m[2], 10), who }] : null;
  }],
  // "Draw a card for each spell countered this way"
  [/^(?:you )?draws? (?:a card|(\w+|X) cards?) for each spell countered this way$/i, (m) => {
    const base = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof base !== 'number') return null;
    const per: Amount = { kind: 'ctxMemory', key: 'countered' };
    return [{ kind: 'draw', amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), who: YOU }];
  }],
  // "Choose two target creatures that share no creature types"
  [/^choose (\w+) target (.+?) that share no creature types$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (typeof n !== 'number' || !noun) return null;
    ctx.targets.push({ description: `target ${m[2]}`, kind: 'object', filter: { ...noun.filter, zone: 'battlefield' }, min: n, max: n, distinct: true });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "Target player dealt damage by ~ this turn loses 1 life"
  [/^target player dealt damage by ~ this turn (loses|gains) (\d+) life$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target player dealt damage by ~ this turn', kind: 'player', playerFilter: 'any' });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastPlayer = ref;
    return [/loses/i.test(m[1]) ? { kind: 'loseLife', amount: parseInt(m[2], 10), who: ref } : { kind: 'gainLife', amount: parseInt(m[2], 10), who: ref }];
  }],
  // "Choose target creature that is blocking equipped creature"
  [/^choose (target .+?) that is blocking (equipped creature|enchanted creature|~)$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    const spec = toTargetSpec(noun);
    ctx.targets.push({ ...spec, filter: { ...(spec.filter ?? {}), blockingSource: /~/.test(m[2]) ? true : undefined, custom: /equipped|enchanted/i.test(m[2]) ? 'blockingAttached' : undefined } });
    ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    return [];
  }],
  // "During your next turn, you may play that card"
  [/^during your next turn, you may play (that card|it|those cards)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'thisTurn' }];
  }],
  // "Each player chooses a land they control of each basic land type"
  [/^each player chooses (?:a|an) (.+?) they control of each basic land type$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun) return null;
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'battlefield', controllerRef: { ref: 'iter' }, subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] }, count: 5, key: 'chosenLands', upTo: true }] }];
  }],
  // "Counter all spells with those names"
  [/^counter all spells with (?:that name|those names)$/i, () => [
    { kind: 'counterSpell', what: { ref: 'all', filter: { zone: 'stack', nameIsChosen: 'cardName' } } },
  ]],
  // "It blocks each attacking creature this turn if able"
  [/^(it|~|that creature) blocks each attacking creature this turn if able$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'mustBlockAll' }, on: ref, duration: 'endOfTurn' }];
  }],
  // ---- Round 208 ----
  // "That attacking player may discard a card" / "defending player may have you draw a card"
  [/^(that attacking player|the attacking player|defending player|that player|any opponent|target opponent) may (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const body = m[2].replace(/^have you /i, 'you ');
    const inner = parseSentence(/^have you /i.test(m[2]) ? body : `${m[1]} ${body}`, newCtx({ ...ctx, targets: ctx.targets, lastPlayer: who }));
    if (!inner || !inner.length) return null;
    return [{ kind: 'may', prompt: m[2], who, effects: inner }];
  }],
  // "That Mount or Vehicle gains flying until end of turn"
  [/^that (Mount or Vehicle|Vehicle|Mount|Equipment|Aura) (gains?|has) (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    const g = parseGrantList(m[3]);
    if (!ref || !g) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const out: Effect[] = [];
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: ref, duration: dur });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: ref, duration: dur });
    return out.length ? out : null;
  }],
  // "Destroy all Auras attached to that creature"
  [/^destroy all (Auras|Equipment) attached to (that creature|it|that permanent)$/i, (m, ctx) => {
    const host = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    if (!host) return null;
    const sub = /^Auras$/i.test(m[1]) ? 'Aura' : 'Equipment';
    return [{ kind: 'destroy', what: { ref: 'all', filter: { subtypes: [sub], zone: 'battlefield', attachedToRef: host } }, cantRegenerate: false }];
  }],
  // "It deals 2 damage to another creature you control"
  [/^(it|~) deals (\d+|X) damage to another (.+?)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const c = chooseRef(`a ${m[3]}`, ctx);
    if (!c) return null;
    const amt: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [...c.pre, { kind: 'damage', amount: amt, source: src, to: c.ref }];
  }],
  // "Remove all counters from up to one target permanent or opponent"
  [/^remove all counters from (up to one target permanent or opponent|target permanent|up to one target permanent)$/i, (m, ctx) => {
    const spec: TargetSpec = /opponent/i.test(m[1])
      ? { description: m[1], kind: 'objectOrPlayer', filter: { zone: 'battlefield' }, playerFilter: 'opponent', min: 0, max: 1 }
      : { description: m[1], kind: 'object', filter: { zone: 'battlefield' }, min: /up to/i.test(m[1]) ? 0 : 1, max: 1 };
    ctx.targets.push(spec);
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'removeCounters', counter: 'any', amount: 'all', on: ref }];
  }],
  // "Remove any number of +1/+1 counters from among creatures you control"
  [/^remove any number of ([+-]\d+\/[+-]\d+|[\w'-]+) counters from among (.+?)$/i, (m, ctx) => {
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'removeCounters', counter: m[1] as never, amount: 'X', on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } } }];
  }],
  // "Choose a card at random in your graveyard"
  [/^choose (?:a|an) card at random in your graveyard$/i, (m, ctx) => {
    const key = `gyRand${ctx.targets.length}`;
    const ref: Ref = { ref: 'chosen', key };
    ctx.lastObj = ref;
    return [{ kind: 'chooseObjects', who: YOU, filter: { zone: 'graveyard', owner: 'you' }, count: 1, key, random: true }];
  }],
  // "Otherwise, you may return ~ to its owner's hand"
  [/^you may return ~ to its owner'?s'? hand$/i, () => [{ kind: 'may', prompt: "Return ~ to its owner's hand?", effects: [{ kind: 'returnToHand', what: SELF }] }]],
  // "Put a stun counter on each of those creatures you don't control"
  [/^put (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on each of those (.+?) you (?:do not|don't) control$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${singularize(m[3])} you do not control`);
    if (typeof n !== 'number' || !noun) return null;
    return [{ kind: 'addCounters', counter: m[2] as never, amount: n, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } } }];
  }],
  // "Counter all abilities your opponents control"
  [/^counter all (abilities|spells) your opponents control$/i, (m) => [
    { kind: 'counterSpell', what: { ref: 'all', filter: { zone: 'stack', controller: 'opponent' } } },
  ]],
  // "Any player may sacrifice two creatures of their choice"
  [/^any player may sacrifice (?:a|an|(\w+)) (.+?)(?: of their choice)?$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'may', prompt: `Sacrifice ${n}?`, who: { ref: 'iter' }, effects: [{ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter: { ...noun.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } }, count: n }] }] }];
  }],
  // ---- Round 207 ----
  // "Until end of turn, target creature has base power 1 or base toughness 1"
  [/^(?:until end of turn, )?(.+?) has base power (\d+) or base toughness (\d+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'chooseMode', count: 1, options: [
      { text: `Base power ${m[2]}`, effects: [{ kind: 'setPT', power: parseInt(m[2], 10), on: ref, duration: 'endOfTurn' }] },
      { text: `Base toughness ${m[3]}`, effects: [{ kind: 'setPT', toughness: parseInt(m[3], 10), on: ref, duration: 'endOfTurn' }] },
    ] }];
  }],
  // "~ gets +1/+1 until end of turn unless any player pays {2}"
  [/^(.+?) (gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)? unless any player pays ((?:\{[^}]+\})+)$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx) ?? (ctx.lastObj ?? null);
    if (!ref) return null;
    const pump: Effect = { kind: 'pump', power: parseInt(m[3], 10), toughness: parseInt(m[4], 10), on: ref, duration: 'endOfTurn' };
    return [{ kind: 'unlessPays', who: { ref: 'eachPlayer' }, cost: m[5], effects: [pump] }];
  }],
  // "They get an additional +0/+2 until end of turn unless any player pays {2}"
  [/^(?:they|those creatures) get an additional ([+-]\d+)\/([+-]\d+)(?: until end of turn)? unless any player pays ((?:\{[^}]+\})+)$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    const pump: Effect = { kind: 'pump', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: ref, duration: 'endOfTurn' };
    return [{ kind: 'unlessPays', who: { ref: 'eachPlayer' }, cost: m[3], effects: [pump] }];
  }],
  // "Until end of turn, lands you control become 2/2 creatures that are still lands"
  [/^(.+?) become ([\dX]+)\/([\dX]+) creatures that are still (lands|artifacts|enchantments)$/i, (m, ctx) => {
    const noun = parseNoun(m[1]) ?? parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const ref: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    return [
      { kind: 'addTypes', types: ['Creature'], on: ref, duration: 'endOfTurn' },
      { kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: 'endOfTurn' },
    ];
  }],
  // "~ and each other creature with the same name as it get +3/+3 until end of turn"
  [/^~ and each other (.+?) with the same name as it (?:gets?|get) ([+-]\d+)\/([+-]\d+)(?: until end of turn)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    const pw = parseInt(m[2], 10);
    const tg = parseInt(m[3], 10);
    return [
      { kind: 'pump', power: pw, toughness: tg, on: SELF, duration: dur },
      { kind: 'pump', power: pw, toughness: tg, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', other: true, sameNameAs: SELF } }, duration: dur },
    ];
  }],
  // "Until your next upkeep, target permanent cannot phase out"
  [/^(?:until your next upkeep, )?(target .+?) cannot phase out$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantPhaseOut' }, on: ref, duration: 'untilYourNextTurn' }] : null;
  }],
  // ---- Round 206 ----
  // "Target creature loses first strike or swampwalk until end of turn"
  [/^(.+?) loses ([\w' -]+?) or ([\w' -]+?)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const g1 = parseGrantList(m[2]);
    const g2 = parseGrantList(m[3]);
    if (!g1 || !g2 || g1.keywords.length !== 1 || g2.keywords.length !== 1 || g1.abilities.length || g2.abilities.length) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [{ kind: 'chooseMode', count: 1, options: [g1, g2].map((g) => ({ text: `Lose ${g.keywords[0]}`, effects: [{ kind: 'loseKeywords' as const, keywords: g.keywords, on: ref, duration: dur }] })) }];
  }],
  // "Change the target of target activated ability with a single target" / "... target spell that targets only ~"
  [/^(?:you may )?change the target of (target .+?)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'changeTargets', what: ref }] : null;
  }],
  // "You may change any targets of target Arcane spell"
  [/^(?:you may )?change any targets of (target .+?)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'changeTargets', what: ref }] : null;
  }],
  // "Look at target player's hand and choose up to two cards from it"
  [/^look at (.+?)'s hand and choose (?:a|an|up to (\w+)|(\w+)) cards? from it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[1] && (m[2] ?? m[3]) ? wordToNumber((m[2] ?? m[3])!) : 1;
    if (!who || typeof n !== 'number') return null;
    const key = `look${ctx.targets.length}`;
    const ref: Ref = { ref: 'chosen', key };
    ctx.lastObj = ref;
    return [
      { kind: 'revealHand', who },
      { kind: 'chooseObjects', who: YOU, filter: { zone: 'hand', ownerRef: who }, count: n, key, upTo: m[2] ? true : undefined },
    ];
  }],
  // "That player discards a card with that name"
  [/^(.+?) discards (?:a|an) card with that name$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'discard', amount: 'hand', who, filter: { nameIsChosen: 'cardName' } }] : null;
  }],
  // "It phases out until ~ leaves the battlefield"
  [/^(?:it|that creature|that permanent|~) phases out(?: until ~ leaves the battlefield)?$/i, (m, ctx) => {
    const ref = /^~/.test(m[0]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    return [{ kind: 'phaseOut', what: ref }];
  }],
  // "Tap all lands target player controls and that player loses all unspent mana"
  [/^tap all (.+?) (target player|target opponent|that player) controls and that player loses all unspent mana$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!who || !noun || !noun.confident) return null;
    return [
      { kind: 'tap', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', controllerRef: who } } },
      { kind: 'loseUnspentMana', who },
    ];
  }],
  // "Starting with you, each player may pay any amount of mana"
  [/^starting with you, each player may pay any amount of mana$/i, () => [
    { kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'payRepeatedly', who: { ref: 'iter' }, cost: '{1}', effects: [] }] },
  ]],
  // "You control target player during that player's next turn"
  [/^you control (target player|target opponent|that player) during that player's next turn$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', who, rule: { kind: 'custom', tag: 'controlledByOpponent', data: 'nextTurn' } }] : null;
  }],
  // ---- Round 205 ----
  // "Then each creature you control is no longer goaded"
  [/^(each|all) (.+?) (?:is|are) no longer goaded$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'goaded', data: '__clear__' }, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: 'permanent' }];
  }],
  // "Then shuffle the rest into your library"
  [/^shuffle the rest into your library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'library' }, { kind: 'shuffle', who: YOU }];
  }],
  // "Until your next turn, spells your opponents cast cost {1} more to cast"
  [/^(until your next turn, )?(?:(.+?) )?spells (your opponents|you) casts? cost \{(\d+)\} (more|less) to cast( until your next turn| this turn)?$/i, (m) => {
    let filter: ObjectFilter | undefined;
    if (m[2]) {
      const n = parseNoun(`a ${m[2]} spell`);
      if (!n || !n.confident) return null;
      filter = { ...n.filter, zone: undefined };
    }
    const untilNext = Boolean(m[1] || (m[6] && /next turn/i.test(m[6])));
    return [{ kind: 'grantPlayerRule', who: /opponents/i.test(m[3]) ? { ref: 'eachOpponent' } : YOU, rule: { kind: /more/i.test(m[5]) ? 'costIncrease' : 'costReduction', amount: parseInt(m[4], 10), ...(filter ? { filter } : {}) }, duration: untilNext ? 'untilYourNextTurn' : 'thisTurn' }];
  }],
  // "~ deals 2 damage to the creature with the least toughness"
  [/^(.+?) deals (\d+|X) damage to the (.+?) with the (least|greatest|lowest|highest) (power|toughness|mana value)$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (!src || !noun || !noun.confident) return null;
    const least = /least|lowest/i.test(m[4]);
    const stat = m[5].toLowerCase();
    const sel: ObjectFilter | null =
      least && stat === 'toughness' ? { lowestToughness: true }
      : least && stat === 'power' ? { lowestPower: true }
      : !least && stat === 'power' ? { highestPower: true }
      : !least && stat === 'mana value' ? { highestManaValue: true }
      : null;
    if (!sel) return null;
    const filter: ObjectFilter = { ...noun.filter, zone: 'battlefield', ...sel };
    const amt: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: amt, source: src, to: { ref: 'all', filter } }];
  }],
  // "That player discards cards equal to the damage"
  [/^(.+?) discards cards equal to the damage$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'discard', amount: { kind: 'triggerAmount' }, who }] : null;
  }],
  // "It and Zombies you control gain deathtouch until end of turn"
  [/^(it|~) and (.+?) (gain|gains|have|has) (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    const a = /^~$/.test(m[1]) ? SELF : ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : SELF);
    const noun = parseNoun(m[2]) ?? parseNoun(`a ${singularize(m[2])}`);
    const g = parseGrantList(m[4]);
    if (!noun || !noun.confident || !g || !g.keywords.length || g.abilities.length) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [
      { kind: 'grantKeywords', keywords: g.keywords, on: a, duration: dur },
      { kind: 'grantKeywords', keywords: g.keywords, on: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, duration: dur },
    ];
  }],
  // "Target opponent gains control of ~ and puts a charge counter on it"
  [/^(target opponent|target player|that player|an opponent) gains control of ~ and puts (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || typeof n !== 'number') return null;
    return [{ kind: 'gainControl', what: SELF, who, duration: 'permanent' }, { kind: 'addCounters', counter: m[3] as never, amount: n, on: SELF }];
  }],
  // "~ deals 3 damage to you and attacks this turn if able"
  [/^(.+?) deals (\d+|X) damage to you and attacks this turn if able$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!src) return null;
    const amt: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [
      { kind: 'damage', amount: amt, source: src, to: YOU },
      { kind: 'applyRule', rule: { kind: 'custom', tag: 'mustAttack' }, on: src, duration: 'endOfTurn' },
    ];
  }],
  // ---- Round 203 ----
  // "This ability still resolves if its target becomes illegal." — a rules reminder.
  [/^this ability still resolves if its target becomes illegal$/i, () => []],
  // "Any player may exile a card from their graveyard." / "... three cards ..."
  [/^any player may exile (?:a|an|(\w+)) cards? from their graveyard$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'forEach', over: { ref: 'eachPlayer' }, effects: [{ kind: 'may', prompt: `Exile ${n} card(s) from your graveyard?`, who: { ref: 'iter' }, effects: [{ kind: 'chooseObjects', who: { ref: 'iter' }, filter: { zone: 'graveyard', ownerRef: { ref: 'iter' } }, count: n, key: 'gyExile' }, { kind: 'moveToZone', what: { ref: 'chosen', key: 'gyExile' }, zone: 'exile' }] }] }];
  }],
  // "Each of its controller's opponents draws a card and gains 2 life"
  [/^each of (?:its controller's|that player's|their) opponents (.+)$/i, (m, ctx) => {
    const inner = parseSentence(`each opponent ${m[1]}`, newCtx({ ...ctx, targets: ctx.targets }));
    return inner && inner.length ? inner : null;
  }],
  // "Draw a card for each opponent who controls fewer creatures than you"
  [/^(?:you )?draws? (?:a card|(\w+|X) cards?) for each (opponent|player) who controls (fewer|more) (.+?) than you$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[4])}`);
    if (!noun || !noun.confident) return null;
    const base = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof base !== 'number') return null;
    const per: Amount = { kind: 'playersComparingCount', who: /opponent/i.test(m[2]) ? 'opponent' : 'any', filter: { ...noun.filter, zone: 'battlefield' }, cmp: /more/i.test(m[3]) ? 'more' : 'fewer' };
    return [{ kind: 'draw', amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), who: YOU }];
  }],
  // "Exile that creature." / "Destroy that creature." with only the trigger's object in scope
  [/^(exile|destroy|tap|untap|sacrifice) that (creature|permanent|artifact|land|token)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    if (!ref) return null;
    const k = m[1].toLowerCase();
    if (k === 'exile') return [{ kind: 'moveToZone', what: ref, zone: 'exile' }];
    if (k === 'destroy') return [{ kind: 'destroy', what: ref, cantRegenerate: false }];
    if (k === 'sacrifice') return [{ kind: 'sacrifice', what: ref }];
    return [{ kind: k === 'tap' ? 'tap' : 'untap', what: ref }];
  }],
  // "Sacrifice ~ unless you remove a +1/+1 counter from it"
  [/^sacrifice ~ unless you remove (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? from it$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'unlessPays', who: YOU, cost: { removeCounters: { counter: m[2] as never, amount: n } } as never, effects: [{ kind: 'sacrifice', what: SELF }] }];
  }],
  // "You gain protection from the color of your choice until end of turn"
  [/^you gain protection from the colou?r of your choice(?: until end of turn)?$/i, () => [
    { kind: 'chooseColor', key: 'color' },
    { kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'protectionFromChosenColor' } },
  ]],
  // "Exile all tokens with the same name as that creature"
  [/^(exile|destroy) all tokens with the same name as (?:that|the) creature$/i, (m, ctx) => {
    const ref: Ref = { ref: 'all', filter: { isToken: true, zone: 'battlefield', sameNameAs: ctx.lastObj ?? { ref: 'triggerObject' } } };
    return [/exile/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'destroy', what: ref, cantRegenerate: false }];
  }],
  // ---- Round 202 ----
  // "Choose a number greater than 0 and a color"
  [/^choose a number greater than (\d+) and a colou?r$/i, (m) => [
    { kind: 'chooseNumber', min: parseInt(m[1], 10) + 1, max: 20 },
    { kind: 'chooseColor', key: 'color' },
  ]],
  // "That player puts those cards into their hand, then shuffles"
  [/^(.+?) puts those cards into their hand,? then shuffles$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return who ? [{ kind: 'moveToZone', what: ref, zone: 'hand' }, { kind: 'shuffle', who }] : null;
  }],
  // "Then put the last chosen card into your hand"
  [/^put the last chosen card into your hand$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'chosen', key: 'chosen' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'hand' }];
  }],
  // "Unless target player pays {3}, that player loses 5 life and you gain 5 life"
  [/^unless (target player|target opponent|that player|its controller) pays ((?:\{[^}]+\})+), (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const inner = parseSentence(m[3], newCtx({ ...ctx, targets: ctx.targets, lastPlayer: who }));
    return inner ? [{ kind: 'unlessPays', who, cost: m[2], effects: inner }] : null;
  }],
  // "Put target creature on top of its owner's library, then fateseal 2"
  [/^(put .+? on (?:top|the bottom) of (?:its|their) owner'?s'? library), then (.+)$/i, (m, ctx) => {
    const a = parseSentence(m[1], ctx);
    const b = a ? parseSentence(m[2], ctx) : null;
    return a && b ? [...a, ...b] : null;
  }],
  // "Target creature's controller reveals a card at random from their hand"
  [/^(target creature's controller|its controller|that creature's controller) reveals? (?:a|an) card at random from their hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'revealHand', who, count: 1, random: true }] : null;
  }],
  // ---- Round 201 ----
  // "Choose a number."
  [/^(?:(.+?) )?chooses? a number$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : undefined;
    if (m[1] && !who) return null;
    return [{ kind: 'chooseNumber', min: 0, max: 20, who: who ?? undefined }];
  }],
  // "Choose two colors." / "Choose a color."
  [/^choose (\w+) colou?rs$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number' || n < 1 || n > 5) return null;
    const out: Effect[] = [];
    for (let i = 0; i < n; i++) out.push({ kind: 'chooseColor', key: i === 0 ? 'color' : `color${i + 1}` });
    return out;
  }],
  // "Choose any number of creatures with different powers"
  [/^choose any number of (.+?) with different (powers|toughnesses|names|mana values)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun || !noun.confident) return null;
    const key = `diff${ctx.targets.length}`;
    const ref: Ref = { ref: 'chosen', key };
    ctx.lastObj = ref;
    return [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' }, count: 'X', key, upTo: true }];
  }],
  // ---- Round 200 ----
  // "Put a charge counter on it or remove one from it"
  [/^put (?:a|an) ([+-]\d+\/[+-]\d+|[\w'-]+) counter on (it|~) or remove (?:one|a \1 counter) from (?:it|~)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[2]) ? SELF : objRef(m[2], ctx) ?? SELF;
    return [{ kind: 'chooseMode', count: 1, options: [
      { text: `Put a ${m[1]} counter on it`, effects: [{ kind: 'addCounters', counter: m[1] as never, amount: 1, on: ref }] },
      { text: `Remove a ${m[1]} counter from it`, effects: [{ kind: 'removeCounters', counter: m[1] as never, amount: 1, on: ref }] },
    ] }];
  }],
  // "Choose a number between 0 and 13"
  [/^(?:(.+?) )?chooses? a number between (\d+) and (\d+)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : undefined;
    if (m[1] && !who) return null;
    return [{ kind: 'chooseNumber', min: parseInt(m[2], 10), max: parseInt(m[3], 10), who: who ?? undefined }];
  }],
  // "Choose left or right" / "choose friend or foe"
  [/^(?:(.+?) )?chooses? (left or right|friend or foe|odd or even|heads or tails)$/i, (m, ctx) => {
    const opts = m[2].toLowerCase().split(' or ');
    const key = opts[0] === 'left' ? 'direction' : opts[0] === 'friend' ? 'allegiance' : 'choice';
    if (!m[1] || /^you$/i.test(m[1])) return [{ kind: 'chooseOption', key, options: opts }];
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'forEach', over: who, effects: [{ kind: 'chooseOption', key, options: opts }] }] : null;
  }],
  // "For each player, choose friend or foe"
  [/^for each (player|opponent), choose (friend or foe|left or right)$/i, (m) => {
    const opts = m[2].toLowerCase().split(' or ');
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'chooseOption', key: opts[0] === 'friend' ? 'allegiance' : 'direction', options: opts }] }];
  }],
  // "You may pay {2}{R} any number of times." / "you may pay {1} up to three times."
  [/^(?:you may|(.+?) may) pay ((?:\{[^}]+\})+) (?:any number of times|up to (\w+) times)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    if (!who) return null;
    const cap = m[3] ? wordToNumber(m[3]) : undefined;
    if (m[3] && typeof cap !== 'number') return null;
    return [{ kind: 'payRepeatedly', who, cost: m[2], effects: [], max: typeof cap === 'number' ? cap : undefined }];
  }],
  // "That player discards those cards"
  [/^(.+?) discards those cards$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return who ? [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] : null;
  }],
  // "Return those cards from your graveyard to your hand"
  [/^return those cards from your graveyard to your hand$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'returnToHand', what: ref }];
  }],
  // "Its owner puts it on their choice of the top or bottom of their library"
  [/^(?:its owner|that player|they) puts? (?:it|that card) on their choice of the top or bottom of (?:their|its owner's) library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'chooseMode', count: 1, options: [
      { text: 'Top of library', effects: [{ kind: 'putOnLibrary', what: ref, position: 'top' }] },
      { text: 'Bottom of library', effects: [{ kind: 'putOnLibrary', what: ref, position: 'bottom' }] },
    ] }];
  }],
  // "They are 2/2 Cyberman artifact creatures"
  [/^(?:they are|it is|those tokens are|each of them is) (?:(?:a|an) )?([\dX]+)\/([\dX]+)((?: [\w-]+)*?)(?: with ([\w ,]+?))?(?: in addition to (?:its|their) other types)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const words = m[3].trim().split(/\s+/).filter(Boolean);
    const types = words.filter((w) => /^(artifact|creature|enchantment|land)s?$/i.test(w)).map((w) => w.replace(/s$/i, '').replace(/^\w/, (c) => c.toUpperCase()));
    const subs = words.filter((w) => /^[A-Z]/.test(w)).map((w) => singularize(w));
    if (!types.length) return null;
    return [
      { kind: 'addTypes', types, subtypes: subs.length ? subs : undefined, on: ref, duration: 'permanent' },
      { kind: 'setPT', power: m[1] === 'X' ? 'X' : parseInt(m[1], 10), toughness: m[2] === 'X' ? 'X' : parseInt(m[2], 10), on: ref, duration: 'permanent' },
    ];
  }],
  // ---- Round 199 ----
  // "Turn all other nontoken creatures face down."
  [/^turn (all|each) (.+?) face (down|up)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!noun || !noun.confident) return null;
    const ref: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    return [/down/i.test(m[3]) ? { kind: 'turnFaceDown', what: ref } : { kind: 'turnFaceUp', what: ref }];
  }],
  // "Return ~ and target green or blue creature you control to their owner's hand"
  [/^return ~ and (target .+?) to (?:their|its) owner'?s'? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: SELF }, { kind: 'returnToHand', what: ref }] : null;
  }],
  // "Attach it to another permanent it can enchant"
  [/^attach (it|~|that Equipment|that Aura) to another (permanent|creature) it can (?:enchant|equip)$/i, (m, ctx) => {
    const what = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx) ?? SELF;
    const key = `host${ctx.targets.length}`;
    const filter: ObjectFilter = /creature/i.test(m[2]) ? { types: ['Creature'], zone: 'battlefield', other: true } : { zone: 'battlefield', other: true };
    return [{ kind: 'chooseObjects', who: YOU, filter, count: 1, key }, { kind: 'attach', what, to: { ref: 'chosen', key } }];
  }],
  // ---- Round 198 ----
  // "~ becomes a 2/2 creature with all creature types until end of turn"
  [/^(.+?) becomes? (?:a|an) ([\dX]+)\/([\dX]+)((?: [\w-]+)*?) creature with all creature types(?: until end of turn)?$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!ref) return null;
    const words = m[4].trim().split(/\s+/).filter(Boolean);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const dur: Duration = 'endOfTurn';
    const out: Effect[] = [
      { kind: 'addTypes', types, on: ref, duration: dur },
      { kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur },
      { kind: 'grantKeywords', keywords: ['Changeling'], on: ref, duration: dur },
    ];
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    return out;
  }],
  // "Target player chooses a card in their hand and discards the rest"
  [/^(.+?) chooses (?:a|an|(\w+)) cards? in their hand and discards the rest$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || typeof n !== 'number') return null;
    const key = `keep${ctx.targets.length}`;
    return [
      { kind: 'chooseObjects', who, filter: { zone: 'hand', ownerRef: who }, count: n, key },
      { kind: 'discard', amount: 'hand', who, except: { ref: 'chosen', key } },
    ];
  }],
  // ---- Round 197 ----
  // "You and another target player each draw a card"
  [/^you and (another target player|target player|target opponent|the attacking player|that player|its controller|that creature's controller|each opponent) each (.+)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const mine = parseSentence(`you ${m[2]}`, newCtx({ ...ctx, targets: ctx.targets }));
    if (!mine) return null;
    return [...mine, ...retargetToPlayer(mine, who)];
  }],
  // "You can't become the monarch this turn."
  [/^you cannot become the monarch(?: this turn)?$/i, () => [
    { kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'cantBecomeMonarch' }, duration: 'thisTurn' },
  ]],
  // "Put the cards exiled with it into their owner's hand"
  [/^put (.+?) into (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  // "Remove a +1/+1 counter from each of two creatures you control"
  [/^remove (?:a|an|(\w+)) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? from each of ((?:a|an|two|three|four|five) .+)$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const c = chooseRef(m[3], ctx);
    if (typeof n !== 'number' || !c) return null;
    return [...c.pre, { kind: 'removeCounters', counter: m[2] as never, amount: n, on: c.ref }];
  }],
  // "Put it onto the battlefield attacking"
  [/^put (it|that card|that creature|them) onto the battlefield( tapped)?(?: and)? attacking(?: that player)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx) ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'returnToBattlefield', what: ref, tapped: m[2] ? true : undefined, attacking: true }];
  }],
  // ---- Round 196 ----
  // "It is a Spirit Detective."
  [/^(?:[Ii]t|[Tt]hey) (?:is|are) (?:a|an) ((?:[A-Z][\w-]+)(?: [A-Z][\w-]+)*)$/, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastCreated' } as Ref);
    const subs = m[1].split(/\s+/);
    return [{ kind: 'addTypes', types: [], subtypes: subs, on: ref, duration: 'permanent' }];
  }],
  // "The blocking creature gets +1/+1 until end of turn"
  [/^the (blocking|attacking|blocked) creature (gets|gains) (.+)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    if (!ref) return null;
    const sub = newCtx({ ...ctx, targets: ctx.targets, lastObj: ref });
    return parseSentence(`it ${m[2]} ${m[3]}`, sub);
  }],
  // "That spell gains rebound." / "That spell gains cascade."
  [/^that spell (?:gains|has) ([\w-]+)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'stackTarget' } as Ref);
    return [{ kind: 'grantKeywords', keywords: [m[1].replace(/^\w/, (c) => c.toUpperCase())], on: ref, duration: 'permanent' }];
  }],
  // "The next spell you cast this turn costs {1} less to cast" / "The next Giant spell you cast this turn costs {2} less to cast"
  [/^the next (.*?)spells? you cast this turn costs? \{(\d+)\} less to cast$/i, (m) => {
    const pre = m[1].trim();
    let filter: ObjectFilter | undefined;
    if (pre) {
      const noun = parseNoun(`a ${pre} spell`);
      if (!noun || !noun.confident) return null;
      filter = { ...noun.filter, zone: undefined };
    }
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'nextSpellCostReduction', data: { amount: parseInt(m[2], 10), filter } }, duration: 'thisTurn' }];
  }],
  // "Exile one or more creature cards from your graveyard"
  [/^(exile|return) (one or more|any number of) (.+?) from your graveyard(?: to your hand)?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[3])}`);
    if (!noun || !noun.confident) return null;
    const key = `gy${ctx.targets.length}`;
    const ref: Ref = { ref: 'chosen', key };
    ctx.lastObj = ref;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: 'X', key, upTo: true },
      /^exile$/i.test(m[1]) ? { kind: 'moveToZone', what: ref, zone: 'exile' } : { kind: 'returnToHand', what: ref },
    ];
  }],
  // "Put a creature you control on top of its owner's library"
  [/^put ((?:a|an) .+? you control) on (top|the bottom) of (?:its|their) owner'?s'? library$/i, (m, ctx) => {
    const c = chooseRef(m[1], ctx);
    return c ? [...c.pre, { kind: 'putOnLibrary', what: c.ref, position: /^top$/i.test(m[2]) ? 'top' : 'bottom' }] : null;
  }],
  // "Put a flying, lifelink, or +1/+1 counter on it"
  [/^put (?:a|an) ([\w'+/-]+(?:, [\w'+/-]+)*),? or ([\w'+/-]+) counter on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx);
    if (!ref) return null;
    const kinds = [...m[1].split(/, /), m[2]].map((x) => x.trim()).filter(Boolean);
    return [{ kind: 'chooseMode', count: 1, options: kinds.map((k) => ({ text: `${k} counter`, effects: [{ kind: 'addCounters' as const, counter: k as never, amount: 1, on: ref }] })) }];
  }],
  // "Put that card onto the battlefield or into your hand"
  [/^put that card (onto the battlefield|into your hand|into your graveyard) or (onto the battlefield|into your hand|into your graveyard)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const mk = (where: string): Effect =>
      /battlefield/i.test(where) ? { kind: 'returnToBattlefield', what: ref } : { kind: 'moveToZone', what: ref, zone: /hand/i.test(where) ? 'hand' : 'graveyard' };
    return [{ kind: 'chooseMode', count: 1, options: [m[1], m[2]].map((w) => ({ text: `Put it ${w}`, effects: [mk(w)] })) }];
  }],
  // ---- Round 195 ----
  // "Mill a card for each shred counter on ~"
  [/^(?:(.+?) )?mills? (?:a card|(\w+|X) cards?) for each (.+)$/i, (m, ctx) => {
    const who = subjectPlayer(m[1], ctx);
    const per = amt(m[3], ctx);
    const base = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || per === null || base === null) return null;
    return [{ kind: 'mill', amount: base === 1 ? per : ({ kind: 'times', a: base as Amount, b: per } as Amount), who }];
  }],
  // "Sacrifice it when you lose control of ~"
  [/^sacrifice (it|the creature|that creature|the permanent) when you lose control of ~$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'delayedTrigger', event: 'controlChanged', text: m[0], filter: { self: true }, effects: [{ kind: 'sacrifice', what: ref }], once: true }];
  }],
  // "Each opponent who doesn't control an Elf loses 1 life"
  [/^each (opponent|player) who (?:does not|doesn't) control (?:a|an) (.+?) (loses|gains) (\d+) life$/i, (m) => {
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun || !noun.confident) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const inner: Effect = /loses/i.test(m[3])
      ? { kind: 'loseLife', amount: parseInt(m[4], 10), who: { ref: 'iter' } }
      : { kind: 'gainLife', amount: parseInt(m[4], 10), who: { ref: 'iter' } };
    return [{ kind: 'forEach', over, effects: [{ kind: 'conditional', if: { kind: 'not', c: { kind: 'count', filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, op: '>=', value: 1 } }, then: [inner] }] }];
  }],
  // "It deals 4 damage to target opponent chosen at random"
  [/^(.+?) deals (\d+|X) damage to (?:a|an|target) (opponent|player) chosen at random$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    if (!src) return null;
    const amt: Amount = m[2].toUpperCase() === 'X' ? 'X' : parseInt(m[2], 10);
    return [
      { kind: 'choosePlayer', key: 'randomPlayer', who: /opponent/i.test(m[3]) ? 'opponent' : 'any', random: true },
      { kind: 'damage', amount: amt, source: src, to: { ref: 'chosen', key: 'randomPlayer' } },
    ];
  }],
  // "It deals 7 damage to a creature an opponent controls chosen at random" / "It fights target creature an opponent controls chosen at random"
  [/^(.+?) (deals (\d+|X) damage to|fights) (?:a|an|target) (.+?) chosen at random$/i, (m, ctx) => {
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const noun = parseNoun(`a ${m[4]}`);
    if (!src || !noun || !noun.confident) return null;
    const key = `rand${ctx.targets.length}`;
    const pick: Effect = { kind: 'chooseObjects', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' }, count: 1, key, random: true };
    const ref: Ref = { ref: 'chosen', key };
    if (/^fights$/i.test(m[2])) return [pick, { kind: 'fight', a: src, b: ref }];
    const amt: Amount = m[3].toUpperCase() === 'X' ? 'X' : parseInt(m[3], 10);
    return [pick, { kind: 'damage', amount: amt, source: src, to: ref }];
  }],
  // "That creature enters with an additional +1/+1 counter on it"
  [/^that (creature|permanent|artifact) enters with (?:an additional|(\w+) additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!noun || typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: { ...noun.filter, zone: undefined }, counter: m[3], amount: n } }, duration: 'thisTurn' }];
  }],
  // "Search your library for an artifact card, reveal it, then shuffle"
  [/^(?:you may )?search your library for (?:a|an) (.+?), reveal (?:it|that card), then shuffle$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'searchLibrary', filter: { ...noun.filter, zone: 'library' }, count: 1, destination: 'hold', key: 'searched', reveal: true, shuffle: true }];
  }],
  // ---- Round 194 ----
  // "Return two lands you control to their owner's hand"
  [/^return ((?:a|an|two|three|four|five|X) .+?) to (?:its|their) owner'?s'? hands?$/i, (m, ctx) => {
    const c = chooseRef(m[1], ctx);
    return c ? [...c.pre, { kind: 'returnToHand', what: c.ref }] : null;
  }],
  // "Return the exiled cards to their owner's graveyard"
  [/^return (.+?) to (?:its|their) owner'?s'? graveyards?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] : null;
  }],
  // "~ becomes the chosen color"
  [/^(.+?) becomes the (?:last )?chosen colou?r(?: until end of turn)?$/i, (m, ctx) => {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    return ref ? [{ kind: 'setColors', colors: [], chosenKey: 'color', on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  // "That creature cannot attack during its controller's next turn" (approximated as "until your next turn")
  [/^(.+?) cannot attack during (?:its controller's|your) next turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'cantAttack' }, on: ref, duration: 'untilYourNextTurn' }] : null;
  }],
  // ---- Round 192 ----
  // "Put any of those cards you didn't play into your graveyard"
  [/^put (.+?) into (?:your|their|his or her) graveyards?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] : null;
  }],
  // "It has flying and is an Angel in addition to its other types"
  [/^(it|they|those creatures) (has|have) (.+?) and (is|are) ((?:a|an) [A-Z][\w-]+(?: creature)? in addition to (?:its|their) other types)$/i, (m, ctx) => {
    const a = parseSentence(`${m[1]} ${m[2]} ${m[3]}`, ctx);
    const b = parseSentence(`${m[1]} ${m[4]} ${m[5]}`, ctx);
    return a && b ? [...a, ...b] : null;
  }],
  // "When you lose control of the creature, tap it" (a delayed trigger left behind by a gain-control spell)
  [/^when you lose control of (?:the|that) (creature|permanent|artifact|land|Equipment|Aura|Vehicle), (.+)$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    const inner = parseSentence(m[2], ctx);
    if (!inner) return null;
    return [{ kind: 'delayedTrigger', event: 'controlChanged', text: m[0], filter: { objectRef: ref }, effects: inner, once: true }];
  }],
  // ---- Round 191 ----
  // "Target player sacrifices an artifact and a land of their choice."
  [/^(target player|target opponent|that player|that opponent|each opponent|each player|you) (?:sacrifices?|sacrifice) ((?:a|an) [\w -]+(?:, (?:a|an) [\w -]+)*,? and (?:a|an) [\w -]+)(?: of (?:their|its) choice)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const items = splitItemList(m[2]);
    const nouns = items.map((x) => parseNoun(x));
    if (nouns.length < 2 || nouns.some((n) => !n || !n.confident)) return null;
    return nouns.map((n) => ({ kind: 'sacrificeChoice' as const, who, filter: { ...n!.filter, controllerRef: who, zone: 'battlefield' as const }, count: 1 }));
  }],
  // "Create your choice of a Blood token, a Clue token, or a Food token."
  [/^create your choice of ((?:a|an) [\w' -]+ token(?:, (?:a|an) [\w' -]+ token)*,? or (?:a|an) [\w' -]+ token)$/i, (m) => {
    const items = m[1].split(/,? or |, /i).map((x) => x.trim()).filter(Boolean);
    const specs = items.map((x) => parseTokenPhrase(x));
    if (specs.length < 2 || specs.some((s) => !s)) return null;
    return [{ kind: 'chooseMode', count: 1, options: specs.map((s, i) => ({ text: `Create ${items[i]}`, effects: [{ kind: 'createToken' as const, token: s!.token, count: s!.count }] })) }];
  }],
  // ---- Round 190 ----
  [/^counter target (spell|spell or ability) that targets you or (?:a|an) (?:permanent|creature) you control$/i, (m, ctx) => {
    ctx.targets.push({ description: `target ${m[1]} that targets you or a permanent you control`, kind: m[1] === 'spell' ? 'spell' : 'spellOrAbility', min: 1, max: 1, filter: { custom: 'targetsYouOrYours' } });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^starting with you, each player chooses (?:a|an) (.+)$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'chooseObjects', who: { ref: 'eachPlayer' }, filter: { ...noun.filter, zone: 'battlefield' }, owner: { ref: 'iter' }, count: 1, key: 'eachPick' }];
  }],
  [/^you may put (?:a|an) (.+?) card from it onto the battlefield under your control$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1]} card`);
    const owner = ctx.lastPlayer;
    if (!noun || !noun.confident || !owner) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand' }, owner, count: 1, key: 'urge', upTo: true },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key: 'urge' }, controller: 'you' },
    ];
  }],
  [/^attach ~ to target creature other than (?:enchanted|equipped) creature$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target creature other than enchanted creature', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield' }, min: 1, max: 1 });
    return [{ kind: 'attach', what: SELF, to: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^change ~'s base power to target creature's power$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target creature', kind: 'object', filter: { types: ['Creature'], zone: 'battlefield' }, min: 1, max: 1 });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return [{ kind: 'setPT', on: SELF, power: { kind: 'power', ref }, duration: 'permanent' }];
  }],
  // ---- Round 189 ----
  [/^(.+?) can block any number of creatures(?: this turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    // Each extraBlock rule allows one more blocked attacker; twenty covers any real board.
    return Array.from({ length: 20 }, () => ({ kind: 'applyRule' as const, rule: { kind: 'custom' as const, tag: 'extraBlock' }, on: ref, duration: 'endOfTurn' as const }));
  }],
  // ---- Round 187 ----
  [/^your maximum hand size is reduced by (\w+)(?: for the rest of the game)?$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'maxHandSize', delta: -n } }];
  }],
  [/^you may put the revealed cards into their owners'? graveyards$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'may', effects: [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] }];
  }],
  [/^(.+?) loses? (\d+) life, then reveals a card at random from their hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    ctx.lastPlayer = who;
    return [{ kind: 'loseLife', amount: parseInt(m[2], 10), who }, { kind: 'revealHand', who, count: 1, random: true }];
  }],
  [/^(.+?) reveals a card at random from their hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    ctx.lastPlayer = who;
    return [{ kind: 'revealHand', who, count: 1, random: true }];
  }],
  [/^(?:a|an) player of your choice adds ((?:\{[^}]+\})+)$/i, (m) => {
    const syms = m[1].match(/\{([^}]+)\}/g)?.map((s) => s.slice(1, -1)) ?? [];
    if (!syms.every((s) => /^[WUBRGC]$/.test(s))) return null;
    return [
      { kind: 'choosePlayer', key: 'manaPlayer', who: 'any' },
      { kind: 'addMana', mana: syms as ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[], who: { ref: 'chosen', key: 'manaPlayer' } },
    ];
  }],
  // ---- Round 186 ----
  [/^its owner shuffles it into their library, then investigates$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    const who: Ref = { ref: 'ownerOf', of: ref };
    return [{ kind: 'moveToZone', what: ref, zone: 'library' }, { kind: 'shuffle', who }, { kind: 'investigate', who }];
  }],
  [/^(.+?) reveals their hand and discards (?:a|an) (.+?) card at random$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[2]} card`);
    if (!who || !noun || !noun.confident) return null;
    ctx.lastPlayer = who;
    return [
      { kind: 'revealHand', who },
      { kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'hand' }, owner: who, count: 1, key: 'rand', random: true },
      { kind: 'discardObjects', what: { ref: 'chosen', key: 'rand' } },
    ];
  }],
  [/^(?:that|the) player sacrifices one of them of their choice$/i, (m, ctx) => {
    const who = ctx.lastPlayer;
    const pool = ctx.lastObj;
    if (!who || !pool) return null;
    return [
      { kind: 'chooseObjects', who, from: pool, filter: {}, count: 1, key: 'sacOne' },
      { kind: 'sacrifice', what: { ref: 'chosen', key: 'sacOne' } },
    ];
  }],
  // ---- Round 185 ----
  [/^investigate an additional time$/i, () => [{ kind: 'investigate', count: 1 }]],
  [/^put ([+-]\d+\/[+-]\d+) counters on (.+?) equal to its power$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[1], amount: { kind: 'power', ref }, on: ref }] : null;
  }],
  [/^put (\w+) ([\w' -]+?) counters? on each (.+?) you control with (.+)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`a ${m[3]} with ${m[4]}`);
    void ctx;
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    return [{ kind: 'addCounters', counter: m[2].toLowerCase(), amount: n, on: { ref: 'all', filter: { ...noun.filter, controller: 'you', zone: 'battlefield' } } }];
  }],
  [/^(?:you )?gain life equal to the power of (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'gainLife', amount: { kind: 'power', ref } }] : null;
  }],
  [/^you gain (\d+) life for each card in (.+?)'s hand$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    if (!who) return null;
    const a: Amount = { kind: 'handSize', ref: who };
    return [{ kind: 'gainLife', amount: parseInt(m[1], 10) === 1 ? a : { kind: 'times', a, b: parseInt(m[1], 10) } }];
  }],
  [/^it becomes equal to your starting life total$/i, () => [{ kind: 'setLife', amount: 40, who: YOU }]],
  [/^(?:they|each opponent|that player) loses? (\d+) life for each spell they(?:'ve| have) cast this turn$/i, (m, ctx) => {
    const who = ctx.lastPlayer ?? (ctx.triggerHasPlayer ? ({ ref: 'triggerPlayer' } as Ref) : { ref: 'eachOpponent' as const });
    const a: Amount = { kind: 'eventsThisTurn', event: 'cast', player: 'opponent' };
    return [{ kind: 'loseLife', amount: parseInt(m[1], 10) === 1 ? a : { kind: 'times', a, b: parseInt(m[1], 10) }, who }];
  }],
  [/^(?:that|the) player puts (?:the|all) (?:rest of the )?revealed cards into their graveyard$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }];
  }],
  [/^(?:then )?put the revealed card on the bottom of your library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastRevealed' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'library', position: 'bottom' }];
  }],
  [/^exile any number of other nonland permanents you own and control$/i, (_m, ctx) => {
    // Yorion: the cards come back at the next end step whatever happens to Yorion, so this is a plain exile.
    ctx.lastObj = { ref: 'chosen', key: 'yorion' };
    return [
      { kind: 'chooseObjects', who: YOU, filter: { nonland: true, controller: 'you', owner: 'you', zone: 'battlefield', other: true }, count: 99, key: 'yorion', upTo: true },
      { kind: 'exile', what: { ref: 'chosen', key: 'yorion' } },
    ];
  }],
  // ---- Round 184 ----
  [/^you skip your next (\w+) turns?$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return Array.from({ length: n }, () => ({ kind: 'skipTurn' as const, who: YOU }));
  }],
  [/^(.+?) cannot gain life for the rest of the game$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'grantPlayerRule', rule: { kind: 'cantGainLife' }, who }] : null;
  }],
  [/^(.+?) draws (\w+) cards? and gains control of ~$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!who || typeof n !== 'number') return null;
    return [{ kind: 'draw', amount: n, who }, { kind: 'gainControl', what: SELF, who, duration: 'permanent' }];
  }],
  [/^turn (?:a|an|up to one) face-down (.+?) you control face up$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, controller: 'you', zone: 'battlefield', faceDown: true }, count: 1, key: 'flipUp' },
      { kind: 'turnFaceUp', what: { ref: 'chosen', key: 'flipUp' } },
    ];
  }],
  [/^(?:that|the) token (?:gains (.+?) until end of turn and )?attacks this combat if able$/i, (m) => {
    const out: Effect[] = [];
    if (m[1]) {
      const kws = parseKeywordList(m[1]);
      if (!kws) return null;
      out.push({ kind: 'grantKeywords', keywords: kws, on: { ref: 'lastCreated' }, duration: 'endOfTurn' });
    }
    out.push({ kind: 'applyRule', rule: { kind: 'mustAttack' }, on: { ref: 'lastCreated' }, duration: 'endOfTurn' });
    return out;
  }],
  [/^you gain life and draw cards equal to its power$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? SELF;
    const a: Amount = { kind: 'power', ref };
    return [{ kind: 'gainLife', amount: a }, { kind: 'draw', amount: a }];
  }],
  [/^each player returns to their hand all cards they own exiled with (?:it|~)$/i, () => [
    { kind: 'moveToZone', what: { ref: 'all', filter: { zone: 'exile', exiledWithSource: true } }, zone: 'hand' },
  ]],
  // ---- Round 183 ----
  [/^exile all cards from (.+?)'s hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', ownerRef: who } } }] : null;
  }],
  [/^return (\w+) (.+?) you control to (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`a ${m[2]}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    const key = `ret${ctx.targets.length}`;
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, controller: 'you', zone: 'battlefield' }, count: n, key },
      { kind: 'returnToHand', what: { ref: 'chosen', key } },
    ];
  }],
  [/^discard any number of (.+?) cards$/i, (m) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun || !noun.confident) return null;
    const key = 'discAny';
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'hand', owner: 'you' }, count: 99, key, upTo: true },
      { kind: 'discardObjects', what: { ref: 'chosen', key } },
    ];
  }],
  [/^each player chooses (?:a|an) (.+?) and puts (?:a|an) ([\w' -]+?) counter on it$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [
      { kind: 'chooseObjects', who: { ref: 'eachPlayer' }, filter: { ...noun.filter, zone: 'battlefield' }, count: 1, key: 'doom' },
      { kind: 'addCounters', counter: m[2].toLowerCase(), amount: 1, on: { ref: 'chosen', key: 'doom' } },
    ];
  }],
  [/^put (?:a|an) (.+?) card from your hand or graveyard onto the battlefield( tapped)?$/i, (m) => {
    const noun = parseNoun(`a ${m[1]} card`);
    if (!noun || !noun.confident) return null;
    const key = 'fromHandGy';
    return [
      { kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: ['hand', 'graveyard'], owner: 'you' }, count: 1, key },
      { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, tapped: !!m[2] },
    ];
  }],
  [/^~ and that creature phase out$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? (ctx.triggerHasObject ? ({ ref: 'triggerObject' } as Ref) : null);
    return ref ? [{ kind: 'phaseOut', what: SELF }, { kind: 'phaseOut', what: ref }] : null;
  }],
  [/^reveal your hand and put all land cards from it onto the battlefield$/i, () => [
    { kind: 'revealHand', who: YOU },
    { kind: 'returnToBattlefield', what: { ref: 'all', filter: { zone: 'hand', owner: 'you', types: ['Land'] } } },
  ]],
  // ---- Round 177 ----
  [/^(?:the|that) cop(?:y|ies) gains? (.+)$/i, (m) => {
    const g = parseGrantList(m[1]);
    if (!g || (!g.keywords.length && !g.abilities.length)) return null;
    const out: Effect[] = [];
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: { ref: 'lastCreated' }, duration: 'permanent' });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: { ref: 'lastCreated' }, duration: 'permanent' });
    return out;
  }],
  // ---- Round 174 ----
  [/^(.+?) cannot block or be blocked by (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const by = parseNoun(m[2]);
    if (!ref || !by || !by.confident) return null;
    const f = { ...by.filter, zone: undefined };
    return [
      { kind: 'applyRule', rule: { kind: 'cantBlockFilter', filter: f }, on: ref, duration: 'permanent' },
      { kind: 'applyRule', rule: { kind: 'cantBeBlockedBy', filter: f }, on: ref, duration: 'permanent' },
    ];
  }],
  // ---- Round 173 ----
  [/^at (?:this turn's next end of combat|the beginning of the next end of combat|the end of combat this turn), (.+)$/i, (m, ctx) => {
    const inner = parseSentence(m[1], ctx);
    return inner ? [{ kind: 'delayedTrigger', event: 'endOfCombat', text: m[0], effects: inner, once: true }] : null;
  }],
  [/^at the beginning of (?:your |the )?next (upkeep|first main phase|main phase|precombat main phase|postcombat main phase|combat phase|combat|end step|draw step)(?: this turn)?, (.+)$/i, (m, ctx) => {
    const EV = {
      upkeep: 'beginningOfUpkeep',
      'first main phase': 'beginningOfPrecombatMain',
      'main phase': 'beginningOfPrecombatMain',
      'precombat main phase': 'beginningOfPrecombatMain',
      'postcombat main phase': 'beginningOfPostcombatMain',
      'combat phase': 'beginningOfCombat',
      combat: 'beginningOfCombat',
      'end step': 'beginningOfEndStep',
      'draw step': 'beginningOfDraw',
    } as const;
    const ev = EV[m[1].toLowerCase() as keyof typeof EV];
    const inner = parseSentence(m[2], ctx);
    return ev && inner ? [{ kind: 'delayedTrigger', event: ev, text: m[0], effects: inner, once: true }] : null;
  }],
  // ---- Round 171 ----
  // "Target player reveals their hand and discards all cards of that color / with that name."
  [/^(.+?) reveals their hand and discards all (.+?)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`all ${m[2]}`);
    if (!who || !noun || !noun.confident) return null;
    ctx.lastPlayer = who;
    return [
      { kind: 'revealHand', who },
      { kind: 'discardObjects', what: { ref: 'all', filter: { ...noun.filter, zone: 'hand', ownerRef: who } } },
    ];
  }],
  [/^(?:the|that) player puts those cards into their hand, then shuffles$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    const who = ctx.lastPlayer;
    if (!ref || !who) return null;
    return [{ kind: 'moveToZone', what: ref, zone: 'hand' }, { kind: 'shuffle', who }];
  }],
  [/^target creature loses all landwalk abilities(?: until end of turn)?$/i, (m, ctx) => {
    const noun = parseNoun('target creature');
    if (!noun) return null;
    ctx.targets.push(toTargetSpec(noun));
    return [{ kind: 'removeKeywords', keywords: ['Plainswalk', 'Islandwalk', 'Swampwalk', 'Mountainwalk', 'Forestwalk', 'Landwalk'], on: { ref: 'target', slot: ctx.targets.length - 1 }, duration: 'endOfTurn' }];
  }],
  [/^(?:that|this) creature can block up to (\w+) additional creatures?(?: this turn)?$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const ref = ctx.lastObj;
    if (typeof n !== 'number' || !ref) return null;
    // Each "extraBlock" rule allows one more blocked attacker.
    return Array.from({ length: n }, () => ({ kind: 'applyRule' as const, rule: { kind: 'custom' as const, tag: 'extraBlock' }, on: ref, duration: 'endOfTurn' as const }));
  }],
  // ---- Round 168 ----
  // "Destroy target artifact, target creature, target enchantment, and target land."
  [/^destroy target (\w+), target (\w+), target (\w+)(?:, target (\w+))?,? and target (\w+)$/i, (m, ctx) => {
    const kinds = [m[1], m[2], m[3], m[4], m[5]].filter(Boolean);
    const out: Effect[] = [];
    for (const k of kinds) {
      const noun = parseNoun(`target ${k}`);
      if (!noun || !noun.confident) return null;
      ctx.targets.push(toTargetSpec(noun));
      out.push({ kind: 'destroy', what: { ref: 'target', slot: ctx.targets.length - 1 } });
    }
    return out;
  }],
  [/^each player chooses (?:a|one) colou?r$/i, () => [{ kind: 'chooseColor', key: 'color', who: { ref: 'eachPlayer' } }]],
  [/^each player chooses (?:a|one) card in their hand$/i, () => [{ kind: 'chooseObjects', who: { ref: 'eachPlayer' }, filter: { zone: 'hand' }, owner: { ref: 'iter' }, count: 1, key: 'handPick' }]],
  [/^each player shuffles all (.+?) they own into their library$/i, (m) => {
    const noun = parseNoun(`all ${m[1]}`);
    if (!noun || !noun.confident) return null;
    return [{ kind: 'moveToZone', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } }, zone: 'library' }, { kind: 'shuffle', who: { ref: 'eachPlayer' } }];
  }],
  // ---- Round 167 ----
  [/^(exile them|return ~ to its owner's hand|sacrifice ~|exile ~) at the beginning of the next cleanup step$/i, (m, ctx) => {
    const verb = m[1].toLowerCase();
    const what = verb === 'exile them' ? ctx.lastObj : SELF;
    if (!what) return null;
    const inner: Effect = verb.startsWith('return') ? { kind: 'returnToHand', what } : verb.startsWith('sacrifice') ? { kind: 'sacrifice', what } : { kind: 'exile', what };
    return [{ kind: 'delayedTrigger', event: 'cleanup', text: m[0], effects: [inner], once: true }];
  }],
  // ---- Round 166b ----
  // Chain spells: "Then that player may sacrifice a land. If the player does, they may copy ~ …"
  [/^(?:(?:if (?:the|that) player does, )?(?:they|that player)|you) may copy ~(?: and may choose (?:a )?new targets? for that copy)?$/i, (m, ctx) => {
    const who = /^you /i.test(m[0]) ? YOU : ctx.lastPlayer;
    if (!who) return null;
    return [{ kind: 'may', who, prompt: 'Copy the spell?', effects: [{ kind: 'copySpell', what: SELF }] }];
  }],
  [/^return ~ and (.+?) to (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: SELF }, { kind: 'returnToHand', what: ref }] : null;
  }],
  [/^put (?:a|an) ([+-]\d+\/[+-]\d+) counter or (?:a|an) ([+-]\d+\/[+-]\d+) counter on (.+)$/i, (m, ctx) => {
    const ref = objRef(m[3], ctx);
    return ref ? [{ kind: 'addCounters', counter: m[1], amount: 1, on: ref, counterOptions: [m[1], m[2]] }] : null;
  }],
  [/^its controller loses life equal to its power plus its toughness$/i, (m, ctx) => {
    const ref = ctx.lastObj;
    if (!ref) return null;
    return [{ kind: 'loseLife', amount: { kind: 'sum', parts: [{ kind: 'power', ref }, { kind: 'toughness', ref }] }, who: { ref: 'controllerOf', of: ref } }];
  }],
  // ---- Round 166 ----
  [/^(.+?) reveals (\w+) cards? from their hand$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const n = wordToNumber(m[2]);
    if (!who || typeof n !== 'number') return null;
    ctx.lastPlayer = who;
    return [{ kind: 'revealHand', who, count: n }];
  }],
  [/^choose (?:a|one) colou?r(?: of (?:a|an) permanent you control| of your choice)?$/i, () => [{ kind: 'chooseColor', key: 'color' }]],
  [/^creatures dealt damage this way cannot block this turn$/i, () => [{ kind: 'applyRule', rule: { kind: 'cantBlock' }, on: { ref: 'chosen', key: 'lastDamaged' }, duration: 'endOfTurn' }]],
  [/^(equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+) and is all creature types$/i, (m) => [
    { kind: 'pump', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: { ref: 'attachedTo' }, duration: 'permanent' },
    { kind: 'grantKeywords', keywords: ['Changeling'], on: { ref: 'attachedTo' }, duration: 'permanent' },
  ]],
  // ---- Round 164 ----
  [/^choose (?:a|an) (?:nonbasic |basic )?land type$/i, () => [{ kind: 'chooseCreatureType', key: 'landType', pool: 'land' }]],
  [/^attach (it|~|that equipment|those equipment|that aura) to (.+)$/i, (m, ctx) => {
    const what = /^(?:it|~)$/i.test(m[1]) ? ctx.lastObj ?? SELF : m[1].toLowerCase().startsWith('those') ? ({ ref: 'memory', key: 'lastMoved' } as Ref) : ctx.lastObj ?? SELF;
    const to = objRef(m[2], ctx);
    return to ? [{ kind: 'attach', what, to }] : null;
  }],
  // ---- Round 160 ----
  [/^put (\w+) ([+-]\d+\/[+-]\d+|\w+) counters? on up to (\w+) (creature|artifact|land|permanent|planeswalker|enchantment)s?$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const max = wordToNumber(m[3]);
    if (n === null || typeof max !== 'number') return null;
    const type = m[4].charAt(0).toUpperCase() + m[4].slice(1).toLowerCase();
    ctx.targets.push({ description: `up to ${m[3]} target ${m[4]}s`, kind: 'object', filter: { zone: 'battlefield', types: [type] }, min: 0, max });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'addCounters', counter: m[2], amount: n, on: ref }];
  }],
  // ---- Round 159 ----
  [/^support x$/i, (m, ctx) => {
    ctx.targets.push({ description: 'up to X other target creatures', kind: 'object', filter: { zone: 'battlefield', types: ['Creature'], other: true }, min: 0, countX: { upTo: true } });
    return [{ kind: 'addCounters', counter: '+1/+1', amount: 1, on: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  [/^attacking creatures become blocked$/i, () => [{ kind: 'becomeBlocked', what: { ref: 'all', filter: { zone: 'battlefield', types: ['Creature'], attacking: true } } }]],
  [/^exile all creatures and graveyards$/i, () => [
    { kind: 'exile', what: { ref: 'all', filter: { zone: 'battlefield', types: ['Creature'] } } },
    { kind: 'moveAll', who: { ref: 'eachPlayer' }, from: 'graveyard', to: 'exile' },
  ]],
  [/^the player whose turn it is may end the turn$/i, () => [{ kind: 'may', who: { ref: 'activePlayer' }, prompt: 'End the turn?', effects: [{ kind: 'endTurn' }] }]],
  [/^all creatures of that type get ([+-]\d+)\/([+-]\d+)$/i, (m) => [{ kind: 'pump', power: parseInt(m[1], 10), toughness: parseInt(m[2], 10), on: { ref: 'all', filter: { zone: 'battlefield', types: ['Creature'], chosenSubtypeKey: 'creatureType' } }, duration: 'endOfTurn' }]],
  // ---- Round 158 ----
  // "X target attacking creatures become blocked."
  [/^(?:(\w+|X) )?target (.+?) become blocked$/i, (m, ctx) => {
    const n = m[1] ? (m[1].toUpperCase() === 'X' ? 'X' : wordToNumber(m[1])) : 1;
    const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
    if (n === null || !noun || !noun.confident) return null;
    const spec = toTargetSpec({ ...noun, target: true } as never);
    if (!spec) return null;
    if (n === 'X') ctx.targets.push({ ...spec, countX: { times: 1 }, distinct: true });
    else ctx.targets.push({ ...spec, min: n as number, max: n as number, distinct: true });
    return [{ kind: 'becomeBlocked', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Those players each discard two cards at random."
  [/^(those players|they|each of those players) each discards? (?:a card|(\w+|X) cards?)( at random)?$/i, (m, ctx) => {
    const who = playerRef(/those players|each of those players/i.test(m[1]) ? 'they' : m[1], ctx);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || n === null) return null;
    return [{ kind: 'discard', amount: n as Amount, who, random: !!m[3] || undefined }];
  }],
  // "They may discard up to X cards." / "You may discard up to two cards."
  [/^(?:(.+?) )?may discard up to (\w+|X) cards?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    return [{ kind: 'discard', amount: n as Amount, who, upTo: true }];
  }],
  // "~ becomes all colors until end of turn."
  [/^(.+?) becomes? all colors(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'setColors', colors: ['W', 'U', 'B', 'R', 'G'], on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }] : null;
  }],
  // "You have no maximum hand size until your next turn."
  [/^you have no maximum hand size(?: until your next turn| for the rest of the game| this turn)?$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'noMaxHandSize' } }]],
  // "You can cast only one more spell this turn."
  [/^you can cast only (\w+) more spells? this turn$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'maxSpellsPerTurn', data: { count: n, fromNow: true } } }];
  }],
  // "Proliferate, then proliferate again."
  [/^proliferate, then proliferate again$/i, () => [{ kind: 'proliferate' }, { kind: 'proliferate' }]],
  // "Then draw half X cards, rounded down."
  [/^(?:then )?draw (half|a third of) X cards(?:, rounded (up|down))?$/i, (m) => {
    const round: 'up' | 'down' = m[2]?.toLowerCase() === 'up' ? 'up' : 'down';
    const amount: Amount = /half/i.test(m[1]) ? { kind: 'half', a: 'X', round } : { kind: 'divide', a: 'X', by: 3, round };
    return [{ kind: 'draw', amount }];
  }],
  // "Its controller manifests the top card of their library."
  [/^(.+?) manifests the top card of their library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'manifest', amount: 1, who }] : null;
  }],
  // "~ loses defender and becomes a Human until end of turn."
  [/^(.+?) loses (.+?) and becomes? (?:a|an) ([A-Z][\w' -]*)(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const kws = parseKeywordList(m[2]);
    if (!ref || !kws) return null;
    const dur: Duration = / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent';
    return [
      { kind: 'removeKeywords', keywords: kws, on: ref, duration: dur },
      { kind: 'addTypes', types: [], subtypes: [m[3]], on: ref, duration: dur },
    ];
  }],
  // ---- Round 156 ----
  // "End the combat phase."
  [/^end the combat phase$/i, () => [{ kind: 'endCombatPhase' }]],
  // "Reveal the top card of target opponent's library."
  [/^reveal the top card of (target (?:opponent|player)|that player)'s library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (who) ctx.lastObj = { ref: 'lastMoved' }; // Prophecy: "If it's a land, you gain 1 life"
    return who ? [{ kind: 'revealTop', who, amount: 1 }] : null;
  }],
  // "Return all artifacts target player owns to their hand."
  [/^return all (.+?) (target (?:player|opponent)|that player) (?:owns|controls) to (?:their|its owner's) hand$/i, (m, ctx) => {
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${singularize(m[1])}`) ?? parseNoun(`a ${m[1]}`);
    if (!who || !noun || !noun.confident) return null;
    const key = / owns /i.test(m[0]) ? 'ownerRef' : 'controllerRef';
    return [{ kind: 'returnToHand', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', [key]: who } } }];
  }],
  // "Shuffle ~ and your graveyard into their owner's library."
  [/^shuffle ~ and your graveyard into (?:their owner's|your) library$/i, () => [
    { kind: 'moveToZone', what: SELF, zone: 'library' },
    { kind: 'shuffleZoneIntoLibrary', zone: 'graveyard', who: YOU },
    { kind: 'shuffle' },
  ]],
  // "Skip the untap step of that turn."
  [/^skip the (untap|draw|upkeep|end) step of (?:that|this) turn$/i, (m) => [{ kind: 'skipStep', step: m[1].toLowerCase() === 'untap' ? 'untap' : m[1].toLowerCase() === 'draw' ? 'draw' : m[1].toLowerCase() === 'upkeep' ? 'upkeep' : 'end' }]],
  // "Spells you control cannot be countered this turn."
  [/^spells you control cannot be countered this turn$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'spellsCantBeCountered' } }]],
  // "Look at twice X cards from the top of your library."
  [/^look at (twice|three times) X cards from the top of your library$/i, (m, ctx) => {
    const key = 'looked';
    ctx.restKey = key;
    ctx.lastObj = { ref: 'memory', key };
    return [{ kind: 'lookAtTop', amount: { kind: 'times', a: 'X', b: /twice/i.test(m[1]) ? 2 : 3 }, then: 'hold', key }];
  }],
  // "Target creature cannot be blocked by Walls this turn."
  [/^(.+?) cannot be blocked by (.+?) this turn$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(m[2]);
    if (!ref || !noun || !noun.confident) return null;
    return [{ kind: 'applyRule', rule: { kind: 'cantBeBlockedBy', filter: { ...noun.filter, zone: undefined } }, on: ref, duration: 'endOfTurn' }];
  }],
  // "Tap and goad the chosen creatures."
  [/^tap and goad (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'tap', what: ref }, { kind: 'goad', what: ref }] : null;
  }],
  // ---- Round 155 ----
  // "Counter target spell if its mana value is X." / "... if no mana was spent to cast it."
  [/^counter target spell if (.+)$/i, (m, ctx) => {
    const cond = parseCondition(m[1], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject });
    const spec: TargetSpec = { description: 'target spell', kind: 'spell' };
    if (/^its mana value is X$/i.test(m[1])) spec.filter = { cmcEQ: 'X' };
    else if (/^no mana was spent to cast it$/i.test(m[1])) spec.filter = { custom: 'noManaSpent' };
    else if (!cond || cond.kind === 'manual') return null;
    ctx.targets.push(spec);
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Counter target spell that targets ~." / "Counter target spell or ability that targets a creature."
  [/^counter target (spell|spell or ability|triggered ability or colorless spell) that targets (.+)$/i, (m, ctx) => {
    const kind = /^spell$/i.test(m[1]) ? 'spell' : 'spellOrAbility';
    let filter: ObjectFilter | undefined;
    if (/^~$/.test(m[2].trim())) filter = { spellTargets: { nameIs: '~' } };
    else {
      const noun = parseNoun(m[2]);
      if (!noun || !noun.confident) return null;
      filter = { spellTargets: { ...noun.filter, zone: undefined } };
    }
    ctx.targets.push({ description: `target ${m[1]} that targets ${m[2]}`, kind: kind as TargetSpec['kind'], filter });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Counter up to four target spells and/or abilities."
  [/^counter (?:up to )?(\w+) target spells and\/or abilities$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    ctx.targets.push({ description: `${m[1]} target spells and/or abilities`, kind: 'spellOrAbility', min: /up to/i.test(m[0]) ? 0 : n, max: n, distinct: true });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Choose a creature at random, then destroy the rest." / "Choose up to two creatures, then destroy the rest."
  [/^choose (?:(?:up to )?(\w+)|a) (.+?)(?: at random)?, then (destroy|exile|sacrifice) the rest$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    const key = 'keepRest';
    const base: ObjectFilter = { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' };
    const rest: Ref = { ref: 'all', filter: { ...base, notChosenKey: key } };
    const act = m[3].toLowerCase();
    return [
      { kind: 'chooseObjects', who: YOU, filter: base, count: n, key, upTo: /up to/i.test(m[0]) || undefined, random: / at random/i.test(m[0]) || undefined },
      act === 'destroy' ? { kind: 'destroy', what: rest } : act === 'exile' ? { kind: 'exile', what: rest } : { kind: 'sacrifice', what: rest },
    ];
  }],
  // ---- Round 150 ----
  // "Target creature gains flying, lifelink, and \"Whenever ~ attacks, draw a card.\" until end of turn"
  [/^(?:until end of turn, )?(.+?) gains? (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    if (!/"/.test(m[2])) return null;
    const ref = objRef(m[1], ctx);
    const g = parseGrantList(m[2]);
    if (!ref || !g) return null;
    const out: Effect[] = [];
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: ref, duration: 'endOfTurn' });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: ref, duration: 'endOfTurn' });
    return out;
  }],
  // "~ becomes a 3/3 black Beholder creature with menace and \"Whenever ~ attacks, ...\" until end of turn"
  [/^(.+?) becomes? (?:a|an) ([\dX]+)\/([\dX]+) (.+?) creature with (.+?)(?: until end of turn)?$/i, (m, ctx) => {
    if (!/"/.test(m[5])) return null;
    const ref = objRef(m[1], ctx);
    const g = parseGrantList(m[5]);
    if (!ref || !g) return null;
    const words = m[4].split(/\s+/);
    const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
    const subtypes = words.filter((w) => /^[A-Z]/.test(w));
    const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
    const dur: Duration = 'endOfTurn';
    const out: Effect[] = [
      { kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, on: ref, duration: dur },
      { kind: 'setPT', power: m[2] === 'X' ? 'X' : parseInt(m[2], 10), toughness: m[3] === 'X' ? 'X' : parseInt(m[3], 10), on: ref, duration: dur },
    ];
    if (colors.length) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
    if (g.keywords.length) out.push({ kind: 'grantKeywords', keywords: g.keywords, on: ref, duration: dur });
    for (const a of g.abilities) out.push({ kind: 'grantAbility', text: a, on: ref, duration: dur });
    return out;
  }],
  // ---- Round 147 ----
  // "You may pay {E}{E}." / "You may pay {1} and 1 life."
  [/^(?:(.+?) )?may pay ((?:\{E\})+)$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    if (!who) return null;
    return [{ kind: 'ifPays', who, cost: '', energy: (m[2].match(/\{E\}/g) ?? []).length, effects: [] }];
  }],
  [/^(?:(.+?) )?may pay ((?:\{[^}]+\})+)(?: and (\d+) life)?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : YOU;
    if (!who || /\{E\}/.test(m[2])) return null;
    return [{ kind: 'ifPays', who, cost: m[2], payLife: m[3] ? parseInt(m[3], 10) : undefined, effects: [] }];
  }],
  // "Put all cards exiled with ~ into their owner's graveyard."
  [/^put (all|(\w+)) cards? (?:exiled with ~|your opponents own from exile) into (?:their|its) owner(?:'s|s'|s)? graveyards?$/i, (m) => {
    const n = m[1].toLowerCase() === 'all' ? null : wordToNumber(m[2]);
    const filter: ObjectFilter = /exiled with ~/i.test(m[0]) ? { zone: 'exile', exiledWithSource: true } : { zone: 'exile', owner: 'opponent' };
    if (n === null) return [{ kind: 'moveToZone', what: { ref: 'all', filter }, zone: 'graveyard' }];
    if (typeof n !== 'number') return null;
    const key = 'exGy';
    return [
      { kind: 'chooseObjects', who: YOU, filter, count: n, key, upTo: true },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'graveyard' },
    ];
  }],
  // "The next instant or sorcery spell you cast this turn has storm."
  [/^the next (.+?) you cast this turn (?:has|gains) ([\w-]+(?: \d+| \{[^}]+\})?)$/i, (m) => {
    const kws = parseKeywordList(m[2]);
    const label = m[1].trim();
    const noun = /^spell$/i.test(label) ? { filter: {} as ObjectFilter, confident: true } : /\bspells?\b/i.test(label) ? parseNoun(`a ${label}`) : parseNoun(`a ${label} spell`);
    if (!kws || !noun || !noun.confident) return null;
    const f = { ...noun.filter };
    delete f.zone;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'spellsHaveKeywords', data: { keywords: kws, filter: Object.keys(f).length ? f : undefined, once: true } } }];
  }],
  // ---- Round 145 ----
  // "Search your graveyard, hand, and/or library for an Aura card and put it onto the battlefield attached to ~."
  [/^search your ((?:library|graveyard|hand)(?:(?:,|,? and|,? and\/or|,? or|\/or) (?:your )?(?:library|graveyard|hand))*) for (?:a|an) (.+?)(?:, reveal (?:it|that card),?)?(?:,? and| then)? put (?:it|that card) onto the battlefield attached to (.+?)(?:, then shuffle| and shuffle)?$/i, (m, ctx) => {
    const zones = [...new Set((m[1].match(/library|graveyard|hand/gi) ?? []).map((z) => z.toLowerCase()))] as ('library' | 'graveyard' | 'hand')[];
    const noun = parseNoun(/\bcards?\b/i.test(m[2]) ? m[2].replace(/ cards$/i, ' card') : `${m[2]} card`);
    const host = /^~$/.test(m[3].trim()) ? SELF : objRef(m[3], ctx);
    if (!noun || !host || !zones.length) return null;
    const f = { ...noun.filter };
    delete f.zone;
    const key = 'searchedAttach';
    return [
      { kind: 'searchLibrary', filter: f, count: 1, destination: 'hold', key, reveal: true, shuffle: true, zones },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'battlefield' },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host },
    ];
  }],
  // "Put an Aura or Equipment card from your hand or graveyard onto the battlefield attached to ~."
  [/^(?:you may )?put (?:a|an) (.+?) from your (hand|graveyard|hand or graveyard|graveyard or hand) onto the battlefield attached to (.+?)$/i, (m, ctx) => {
    const zones: ('hand' | 'graveyard')[] = /hand or graveyard|graveyard or hand/i.test(m[2]) ? ['hand', 'graveyard'] : /graveyard/i.test(m[2]) ? ['graveyard'] : ['hand'];
    const noun = parseNoun(/\bcards?\b/i.test(m[1]) ? m[1].replace(/ cards$/i, ' card') : `${m[1]} card`);
    const host = /^~$/.test(m[3].trim()) ? SELF : objRef(m[3], ctx);
    if (!noun || !host) return null;
    const f = { ...noun.filter, zone: zones.length === 1 ? zones[0] : zones, owner: 'you' as const };
    const key = 'handAttach';
    return [
      { kind: 'chooseObjects', who: YOU, filter: f, count: 1, key, upTo: true },
      { kind: 'moveToZone', what: { ref: 'chosen', key }, zone: 'battlefield' },
      { kind: 'attach', what: { ref: 'lastMoved' }, to: host },
    ];
  }],
  // ---- Round 143 ----
  // "You may draw up to three cards."
  [/^(?:(.+?) )?draws? up to (\w+|X) cards?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer ?? YOU;
    const n = wordToNumber(m[2]);
    if (!who || n === null) return null;
    return [{ kind: 'may', who, effects: [{ kind: 'draw', amount: n as Amount, who }] }];
  }],
  // "That player puts a creature card from their hand onto the battlefield."
  [/^(.+?) puts? (?:a|an|(\w+)) (.+?) from their (hand|graveyard) (onto the battlefield|into their hand)( tapped)?$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || !noun || !noun.confident || typeof n !== 'number') return null;
    const key = `plrPut${ctx.targets.length}`;
    const zone = m[4].toLowerCase() === 'hand' ? 'hand' : 'graveyard';
    const eff: Effect[] = [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone, ownerRef: who }, count: n, key, upTo: true }];
    eff.push(/battlefield/i.test(m[5]) ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'owner', tapped: !!m[6] } : { kind: 'putIntoHand', what: { ref: 'chosen', key } });
    return eff;
  }],
  // "That player returns a creature card from their graveyard to the battlefield."
  [/^(.+?) returns? (?:a|an|(\w+)) (.+?) from their graveyard to (the battlefield|their hand)$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    const noun = parseNoun(`a ${m[3]}`);
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (!who || !noun || !noun.confident || typeof n !== 'number') return null;
    const key = `plrRet${ctx.targets.length}`;
    const eff: Effect[] = [{ kind: 'chooseObjects', who, filter: { ...noun.filter, zone: 'graveyard', ownerRef: who }, count: n, key, upTo: true }];
    eff.push(/battlefield/i.test(m[4]) ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'owner' } : { kind: 'putIntoHand', what: { ref: 'chosen', key } });
    return eff;
  }],
  // "Put it into its owner's library third from the top."
  [/^(?:(.+?) )?puts? (.+?) into (?:its owner's|their|your|that player's) library (\w+) from the top$/i, (m, ctx) => {
    const ORD: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9 };
    const depth = ORD[m[3].toLowerCase()];
    if (depth === undefined) return null;
    const ref = objRef(m[2], ctx) ?? (/^~$/.test(m[2].trim()) ? SELF : null);
    if (!ref) return null;
    return [{ kind: 'putOnLibrary', what: ref, position: depth === 0 ? 'top' : depth === 1 ? 'secondFromTop' : 'top', depth }];
  }],
  // "Each other player may draw up to three cards."
  [/^each other player may (.+)$/i, (m, ctx) => {
    const sub = newCtx({ ...ctx, targets: ctx.targets });
    sub.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(`that player ${m[1]}`, sub) ?? parseSentence(m[1], sub);
    if (!inner) return null;
    return [{ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [{ kind: 'may', who: { ref: 'iter' }, effects: inner }] }];
  }],
  // "Each opponent sacrifices a tenth of the creatures they control of their choice, rounded up."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?sacrifices? (half|a third|a quarter|a tenth) (?:of )?the (.+?) (?:they|you) control of (?:their|your) choice(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    const noun = parseNoun(`a ${singularize(m[3])}`) ?? parseNoun(`a ${m[3]}`);
    if (!who || !noun || !noun.confident) return null;
    const round: 'up' | 'down' = m[4]?.toLowerCase() === 'up' ? 'up' : 'down';
    const by = m[2].toLowerCase() === 'half' ? 2 : m[2].toLowerCase() === 'a third' ? 3 : m[2].toLowerCase() === 'a quarter' ? 4 : 10;
    const filter: ObjectFilter = { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' };
    const n: Amount = { kind: 'count', filter };
    const count: Amount = by === 2 ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by, round };
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter, count }] }];
  }],
  // "Counter up to one target activated or triggered ability."
  [/^counter up to one target (activated or triggered|activated|triggered) ability$/i, (m, ctx) => {
    ctx.targets.push({ description: `target ${m[1]} ability`, kind: m[1].toLowerCase() === 'activated or triggered' ? 'activatedOrTriggered' : 'activatedOrTriggered', min: 0, max: 1 });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Counter target instant spell, sorcery spell, activated ability, or triggered ability."
  [/^counter target (?:instant spell, sorcery spell, activated ability, or triggered ability|spell or ability|triggered ability or colorless spell|activated or triggered ability)$/i, (m, ctx) => {
    ctx.targets.push({ description: 'target spell or ability', kind: 'spellOrAbility', min: 1, max: 1 });
    return [{ kind: 'counterSpell', what: { ref: 'target', slot: ctx.targets.length - 1 } }];
  }],
  // "Create half X Food tokens, rounded up."
  [/^create (half|a third) (X|\w+) (.+? tokens?(?: with .+)?)(?:, rounded (up|down))?$/i, (m) => {
    const tok = parseTokenPhrase(`a ${m[3].replace(/ tokens\b/i, ' token')}`);
    if (!tok) return null;
    const base: Amount = m[2].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[2]) as Amount);
    if (base === null) return null;
    const round: 'up' | 'down' = m[4]?.toLowerCase() === 'up' ? 'up' : 'down';
    const count: Amount = m[1].toLowerCase() === 'half' ? { kind: 'half', a: base, round } : { kind: 'divide', a: base, by: 3, round };
    return [{ kind: 'createToken', token: tok.token, count }];
  }],
  // ---- Round 141 ----
  // "The next time a black or red source of your choice would deal damage this turn, prevent that damage."
  [/^the next time (.+?) would deal (combat |noncombat )?damage(?: to (.+?))?(?: this turn)?, (?:prevent that damage|prevent all of that damage)$/i, (m, ctx) => {
    const src = preventionSource(m[1], ctx);
    if (!src) return null;
    const dst = m[3] ? preventionTo(m[3], ctx) : { to: 'all' as const };
    if (!dst) return null;
    return [{ kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, once: true, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined }];
  }],
  // "The next time damage would be dealt to target creature this turn, prevent that damage."
  [/^the next time (combat |noncombat )?damage would be dealt to (.+?)(?: this turn)?, prevent (?:that damage|all of that damage)$/i, (m, ctx) => {
    const dst = preventionTo(m[2], ctx);
    if (!dst) return null;
    return [{ kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, once: true, combat: m[1] && /^combat/i.test(m[1]) ? true : undefined }];
  }],
  // "The next time a source of your choice would deal damage to you this turn, that damage is dealt to ~ instead."
  [/^the next time (.+?) would deal (combat |noncombat )?damage(?: to (.+?))?(?: this turn)?, (?:instead )?(?:that damage|that source deals that (?:much )?damage|that spell deals that damage|that creature deals that damage|that source deals that damage)(?: is dealt)? to (.+?)(?: instead)?$/i, (m, ctx) => {
    const src = preventionSource(m[1], ctx);
    if (!src) return null;
    const dst = m[3] ? preventionTo(m[3], ctx) : { to: 'all' as const };
    if (!dst) return null;
    const spec: Effect = { kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, once: true, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined };
    const target = m[4].trim();
    if (/^(?:its|that source's|that spell's|that creature's) controller$/i.test(target)) spec.redirectToSourceController = true;
    else if (/^itself$/i.test(target) && src.sourceRef) spec.redirectTo = src.sourceRef;
    else {
      const r = anyRef(target, ctx);
      if (!r) return null;
      spec.redirectTo = r;
    }
    return [spec];
  }],
  // "The next time damage would be dealt to ~ and/or you this turn, that damage is dealt to any target instead."
  [/^the next time (combat |noncombat )?damage would be dealt to (.+?)(?: this turn)?, that damage is dealt to (.+?) instead$/i, (m, ctx) => {
    const dst = preventionTo(m[2], ctx);
    if (!dst) return null;
    const spec: Effect = { kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, once: true, combat: m[1] && /^combat/i.test(m[1]) ? true : undefined };
    const r = anyRef(m[3], ctx);
    if (!r) return null;
    spec.redirectTo = r;
    return [spec];
  }],
  // "The next 2 damage that a source of your choice would deal to you and/or permanents you control this turn is dealt to ~ instead."
  [/^the next (\d+|X) (combat |noncombat )?damage that (.+?) would deal to (.+?)(?: this turn)? is dealt to (.+?) instead$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? undefined : parseInt(m[1], 10);
    const src = preventionSource(m[3], ctx);
    const dst = preventionTo(m[4], ctx);
    if (!src || !dst) return null;
    const spec: Effect = { kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, amount: n, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined };
    const r = anyRef(m[5], ctx);
    if (!r) return null;
    spec.redirectTo = r;
    return [spec];
  }],
  // "Prevent the next 3 damage that a source of your choice would deal to you and/or permanents you control this turn."
  [/^prevent the next (\d+|X) (combat |noncombat )?damage that (.+?) would deal to (.+?)(?: this turn)?$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? undefined : parseInt(m[1], 10);
    const src = preventionSource(m[3], ctx);
    const dst = preventionTo(m[4], ctx);
    if (!src || !dst) return null;
    return [{ kind: 'preventAll', to: dst.to ?? 'all', toRef: dst.toRef, source: src.source, sourceRef: src.sourceRef, amount: n, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined }];
  }],
  // "The next time you would draw a card this turn, you gain 5 life instead."
  [/^the next time you would draw a card this turn, (?:instead )?(.+?)(?: instead)?$/i, (m, ctx) => {
    const pe = parseEffects(m[1], newCtx({ ...ctx, targets: ctx.targets }));
    if (pe.unhandled.length || !pe.effects.length) return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'drawReplacement', data: { effects: pe.effects, once: true } } }];
  }],
  // ---- Round 140 ----
  // "Return to their owners' hands all creatures with toughness 2 or less."
  [/^return to (?:their owners'|its owner's|your|their) hands? (all .+|each .+)$/i, (m, ctx) => parseSentence(`return ${m[1]} to their owners' hands`, ctx)],
  // "Return two target creature cards that share a creature type from your graveyard to your hand."
  [/^return (\w+) target (.+?) that share (?:a|an) (creature type|card type|colou?r) from your graveyard to (your hand|the battlefield)$/i, (m, ctx) => {
    const n = wordToNumber(m[1]);
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (typeof n !== 'number' || !noun) return null;
    ctx.targets.push({ description: `target ${m[2]} from your graveyard`, kind: 'object', filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, min: n, max: n, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return /your hand/i.test(m[4]) ? [{ kind: 'returnToHand', what: ref }] : [{ kind: 'returnToBattlefield', what: ref, controller: 'you' }];
  }],
  // "Return target creature card and all other cards with the same name as that card from your graveyard to your hand."
  [/^return (target .+?) and all other (.+?) with the same name as that \w+ from your graveyard to (your hand|the battlefield)$/i, (m, ctx) => {
    const ref = objRef(`${m[1]} in your graveyard`, ctx) ?? objRef(m[1], ctx);
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!ref || !noun) return null;
    const others: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'graveyard', owner: 'you', sameNameAs: ref, other: true } };
    return /your hand/i.test(m[3])
      ? [{ kind: 'returnToHand', what: ref }, { kind: 'returnToHand', what: others }]
      : [{ kind: 'returnToBattlefield', what: ref, controller: 'you' }, { kind: 'returnToBattlefield', what: others, controller: 'you' }];
  }],
  // "Return target nonland permanent and all other permanents with the same name as that permanent to their owners' hands."
  [/^return (target .+?) and (?:all other|each other) (.+?) with the same name as that \w+ to (?:their owners'|its owner's) hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    const noun = parseNoun(`a ${singularize(m[2])}`);
    if (!ref || !noun) return null;
    return [
      { kind: 'returnToHand', what: ref },
      { kind: 'returnToHand', what: { ref: 'all', filter: { ...noun.filter, zone: 'battlefield', sameNameAs: ref, other: true } } },
    ];
  }],
  // "Return target commander you own from the battlefield to your hand."
  [/^return (target .+?) from the battlefield to (your hand|its owner's hand)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    return ref ? [{ kind: 'returnToHand', what: ref }] : null;
  }],
  // "Return that many creature cards from your graveyard to the battlefield."
  [/^return that many (.+?) from your graveyard to (the battlefield|your hand)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun) return null;
    const key = 'retGy';
    const eff: Effect[] = [{ kind: 'chooseObjects', who: YOU, filter: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: { kind: 'triggerAmount' }, key, upTo: true }];
    eff.push(/the battlefield/i.test(m[2]) ? { kind: 'returnToBattlefield', what: { ref: 'chosen', key }, controller: 'you' } : { kind: 'returnToHand', what: { ref: 'chosen', key } });
    return eff;
  }],
  // "Return half the creatures they control to their owner's hand, rounded up."
  [/^return (half|a third) the (.+?) (?:they|you) control to (?:their|its) owner(?:'s|s'|s)? hands?(?:, rounded (up|down))?$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[2])}`) ?? parseNoun(`a ${m[2]}`);
    const who = ctx.lastPlayer;
    if (!noun || !who) return null;
    const round: 'up' | 'down' = m[3]?.toLowerCase() === 'up' ? 'up' : 'down';
    const filter: ObjectFilter = { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' };
    const n: Amount = { kind: 'count', filter };
    const count: Amount = m[1].toLowerCase() === 'half' ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by: 3, round };
    const key = 'retHalf';
    return [{ kind: 'forEach', over: who, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter, count, key },
      { kind: 'returnToHand', what: { ref: 'chosen', key } },
    ] }];
  }],
  // ---- Round 139 ----
  // "Put target face-up exiled card into its owner's graveyard."
  [/^put (.+?) into (?:its|their) owner(?:'s|s'|s)? graveyards?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx) ?? (/^(?:a|an|each) card exiled with ~$/i.test(m[1]) ? ({ ref: 'all', filter: { zone: 'exile', exiledWithSource: true } } as Ref) : null);
    return ref ? [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }] : null;
  }],
  // "Put ~ and target creature on top of their owners' libraries, then those players shuffle their libraries."
  [/^put (.+?) on top of their owners'? libraries$/i, (m, ctx) => {
    const parts = m[1].split(/ and (?=~|target |each )/i).map((x) => x.trim()).filter(Boolean);
    const refs = parts.map((x) => (x === '~' ? SELF : objRef(x, ctx)));
    if (!refs.length || refs.some((r) => !r)) return null;
    return refs.map((r) => ({ kind: 'putOnLibrary' as const, what: r as Ref, position: 'top' as const }));
  }],
  // ---- Round 137 ----
  // "Prevent the next 3 damage that would be dealt to any target this turn by a source of your choice."
  [/^prevent the next (\d+|X) (combat |noncombat )?damage that would be dealt to (.+?)(?: this turn)?(?: by (.+?))?(?: this turn)?$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? null : parseInt(m[1], 10);
    let source: ObjectFilter | undefined;
    if (m[4] && !/^a source of your choice$/i.test(m[4])) {
      const st = m[4].replace(/\bsources\b/i, 'permanents').replace(/\bsource\b/i, 'permanent');
      const sn = parseNoun(st) ?? parseNoun(`a ${st}`);
      if (!sn) return null;
      source = { ...sn.filter, zone: undefined };
    }
    const spec: Effect = { kind: 'preventAll', to: 'all', combat: m[2] && /^combat/i.test(m[2]) ? true : undefined, source, amount: n ?? undefined };
    const l = m[3].trim().toLowerCase();
    if (l === 'you') spec.to = 'you';
    else if (l === 'you and/or permanents you control' || l === 'you and permanents you control' || l === 'you and/or creatures you control' || l === 'you and creatures you control') spec.to = 'youAndCreaturesYouControl';
    else if (l === 'any target') spec.to = 'all';
    else {
      const ref = anyRef(m[3], ctx);
      if (!ref) return null;
      spec.toRef = ref;
    }
    if (n === null) spec.amount = undefined;
    return [spec];
  }],
  // "The next 1 damage that would be dealt to target creature this turn is dealt to another target creature instead."
  [/^the next (\d+|X) (combat |noncombat )?damage that would be dealt(?: this turn)? to (.+?)(?: this turn)? is dealt to (.+?) instead$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? undefined : parseInt(m[1], 10);
    const toRef = anyRef(m[3], ctx);
    if (!toRef) return null;
    const redirectTo = /^its controller$/i.test(m[4].trim()) ? null : anyRef(m[4], ctx);
    if (!redirectTo && !/^its controller$/i.test(m[4].trim())) return null;
    const spec: Effect = { kind: 'preventAll', to: 'all', toRef, amount: n, combat: m[2] && /^combat/i.test(m[2]) ? true : undefined };
    if (redirectTo) spec.redirectTo = redirectTo;
    else spec.redirectToSourceController = true;
    return [spec];
  }],
  // "The next time a source of your choice would deal damage to you this turn, that damage is dealt to ~ instead."
  [/^the next time (?:(?:a|an) source of your choice|damage) would (?:deal damage to|be dealt to) (.+?) this turn, (?:that damage is dealt to|instead that source deals that much damage to) (.+?) instead$/i, (m, ctx) => {
    const toRef = anyRef(m[1], ctx);
    if (!toRef) return null;
    const redirectTo = /^its controller$/i.test(m[2].trim()) ? null : anyRef(m[2], ctx);
    const spec: Effect = { kind: 'preventAll', to: 'all', toRef, once: true };
    if (redirectTo) spec.redirectTo = redirectTo;
    else spec.redirectToSourceController = true;
    return [spec];
  }],
  // "Prevent all damage a source of your choice would deal to you this turn."
  [/^prevent all (combat |noncombat )?damage (?:a|an) source of your choice would deal to (.+?) this turn$/i, (m, ctx) => {
    const spec: Effect = { kind: 'preventAll', to: 'all', once: true, combat: m[1] && /^combat/i.test(m[1]) ? true : undefined };
    if (/^you$/i.test(m[2].trim())) spec.to = 'you';
    else {
      const ref = anyRef(m[2], ctx);
      if (!ref) return null;
      spec.toRef = ref;
    }
    return [spec];
  }],
  // "If a source you control would deal damage this turn, it deals double that damage instead."
  [/^if (.+?) would deal (?:(\d+) or more )?(combat |noncombat )?damage(?: this turn)?(?: to (.+?))?(?: this turn)?, (?:instead )?(?:it|that source|that spell|that creature|that permanent) deals (.+)$/i, (m) => {
    const srcSpec = damageSourceFilter(m[1]);
    const dest = m[4] ? damageDestFilter(m[4]) : {};
    const mod = damageModifier(m[5]);
    if (!srcSpec || srcSpec.selfOnly || !dest || dest.host || !mod || !/ this turn[, ]/i.test(m[0])) return null;
    const data: Record<string, unknown> = { ...srcSpec, ...dest, ...mod };
    delete data.host;
    if (m[2]) data.ifAtLeast = parseInt(m[2], 10);
    if (m[3] && /^combat/i.test(m[3])) data.combatOnly = true;
    if (m[3] && /^noncombat/i.test(m[3])) data.noncombatOnly = true;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'damageModify', data } }];
  }],
  // ---- Round 135 ----
  // "That player shuffles their hand into their library."
  [/^(.+?) shuffles? (?:their|his or her) (graveyard|hand)(?: and (?:their )?(graveyard|hand))? into (?:their|his or her) library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    if (!who) return null;
    const zones = [m[2], m[3]].filter(Boolean).map((z) => (z.toLowerCase() === 'hand' ? 'hand' : 'graveyard')) as ('hand' | 'graveyard')[];
    return zones.map((z) => ({ kind: 'shuffleZoneIntoLibrary' as const, zone: z, who }));
  }],
  // "Exile X target cards from target player's graveyard." / "Exile up to twice X target cards from graveyards."
  [/^exile (?:up to )?(twice X|X|\w+) target cards? from (graveyards|a graveyard|.+?'s graveyard)$/i, (m, ctx) => {
    const isX = /X/i.test(m[1]);
    const n = isX ? null : wordToNumber(m[1]);
    if (!isX && typeof n !== 'number') return null;
    const pm = m[2].match(/^(target (?:player|opponent))'s graveyard$/i);
    let ownerRef: Ref | undefined;
    if (pm) {
      const who = playerRef(pm[1], ctx);
      if (!who) return null;
      ownerRef = who;
    }
    const base = pm || /^(?:graveyards|a graveyard)$/i.test(m[2]) ? parseNoun('a card in a graveyard') : parseNoun(`a card in ${m[2]}`);
    if (!base) return null;
    const spec = toTargetSpec(base);
    if (!spec) return null;
    if (ownerRef) spec.filter = { ...spec.filter, ownerRef };
    const upTo = /^exile up to /i.test(m[0]) || undefined;
    ctx.targets.push(isX
      ? { ...spec, countX: { times: /twice/i.test(m[1]) ? 2 : 1, upTo }, distinct: true }
      : { ...spec, min: upTo ? 0 : (n as number), max: n as number, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [{ kind: 'exile', what: ref }];
  }],
  // "Choose a creature or planeswalker card in that player's graveyard."
  [/^(?:you )?choose (?:a|an|(\w+)) (.+? (?:in|from) (?:a graveyard|graveyards|[\w' ]+?'s graveyard|your graveyard))$/i, (m, ctx) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${m[2]}`);
    if (!noun || !noun.confident || typeof n !== 'number') return null;
    const key = 'chosenCards';
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who: YOU, filter: noun.filter, count: n, key, append: true }]; // a second "choose" in the same ability adds to "those cards"
  }],
  // "Exile all cards from target player's hand and graveyard." / "... from all hands and graveyards."
  [/^exile all (.+?) from (all hands and graveyards|.+?'s hand and graveyard|.+? hand and graveyard)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[1].replace(/ cards$/i, ' card').replace(/^cards$/i, 'card')}`);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter, zone: ['hand', 'graveyard'] };
    if (!/^all hands/i.test(m[2])) {
      const who = playerRef(m[2].replace(/'s hand and graveyard$/i, '').replace(/ hand and graveyard$/i, ''), ctx);
      if (!who) return null;
      f.ownerRef = who;
    }
    return [{ kind: 'exile', what: { ref: 'all', filter: f } }];
  }],
  // "Exile all cards from target player's library, then that player shuffles their hand into their library."
  [/^exile all cards from (.+?)'s library$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'exile', what: { ref: 'all', filter: { zone: 'library', ownerRef: who } } }] : null;
  }],
  // "Exile all the cards from your hand, then draw that many cards."
  [/^exile all (?:the )?cards from your hand, then draw that many cards$/i, () => [
    { kind: 'exile', what: { ref: 'all', filter: { zone: 'hand', owner: 'you' } } },
    { kind: 'draw', amount: { kind: 'ctxMemory', key: 'lastMoved' } },
  ]],
  // "For each color, return up to one target card of that color from your graveyard to your hand."
  [/^for each (color|permanent type), return up to one (?:target )?(.*?)card of that (?:color|type) from your graveyard to (your hand|the battlefield)$/i, (m) => {
    const extra = m[2].trim() ? parseNoun(`a ${m[2].trim()} card`) : null;
    if (m[2].trim() && (!extra || !extra.confident)) return null;
    const groups: ObjectFilter[] = /color/i.test(m[1])
      ? (['W', 'U', 'B', 'R', 'G'] as Color[]).map((c) => ({ colors: [c] }))
      : ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].map((t) => ({ types: [t] }));
    const key = 'byGroup';
    const effects: Effect[] = groups.map((gf) => ({
      kind: 'chooseObjects',
      who: YOU,
      filter: { ...(extra ? { ...extra.filter } : {}), ...gf, zone: 'graveyard', owner: 'you' },
      count: 1,
      key,
      upTo: true,
      append: true, // one pick per group, all returned together
    }));
    effects.push(/your hand/i.test(m[3]) ? { kind: 'returnToHand', what: { ref: 'chosen', key } } : { kind: 'returnToBattlefield', what: { ref: 'chosen', key } });
    return effects;
  }],
  // ---- Round 134 ----
  // "Each player discards all the cards in their hand, then creates that many 2/2 black Zombie creature tokens."
  [/^each (player|opponent) discards (?:all the cards in their hand|their hand), then creates that many (.+? tokens?(?: with .+)?)$/i, (m) => {
    const tok = parseTokenPhrase(`a ${m[2].replace(/ tokens\b/i, ' token')}`);
    if (!tok) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [
      { kind: 'discard', amount: 'hand', who: { ref: 'iter' } },
      { kind: 'createToken', token: tok.token, count: { kind: 'ctxMemory', key: 'discardedCount' }, who: { ref: 'iter' } },
    ] }];
  }],
  // "Each opponent loses all counters."
  [/^(each player|each opponent|you|that player|they|target player|target opponent) loses? all counters$/i, (m, ctx) => {
    const who = playerRef(m[1], ctx);
    return who ? [{ kind: 'loseAllCounters', counter: 'all', who }] : null;
  }],
  // "Each player discards half the cards in their hand, rounded down."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?discards? (half|a third|a quarter) (?:of )?the cards in (?:their|your) hand(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    if (!who) return null;
    const round: 'up' | 'down' = m[3]?.toLowerCase() === 'up' ? 'up' : 'down';
    const n: Amount = { kind: 'handSize', ref: { ref: 'iter' } };
    const amount: Amount = m[2].toLowerCase() === 'half' ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by: m[2].toLowerCase() === 'a third' ? 3 : 4, round };
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'discard', amount, who: { ref: 'iter' } }] }];
  }],
  // "Each player sacrifices half the creatures they control, rounded down."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?sacrifices? (half|a third|a quarter) (?:of )?the (.+?) (?:they|you) control(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    const noun = parseNoun(`a ${singularize(m[3])}`) ?? parseNoun(`a ${m[3]}`);
    if (!who || !noun || !noun.confident) return null;
    const round: 'up' | 'down' = m[4]?.toLowerCase() === 'up' ? 'up' : 'down';
    const filter: ObjectFilter = { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' };
    const n: Amount = { kind: 'count', filter };
    const count: Amount = m[2].toLowerCase() === 'half' ? { kind: 'half', a: n, round } : { kind: 'divide', a: n, by: m[2].toLowerCase() === 'a third' ? 3 : 4, round };
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter, count }] }];
  }],
  // "Each player loses a third of their life."
  [/^(?:(each player|each opponent|you|that player|they|target player|target opponent) )?loses? (a third|a quarter) of (?:their|your) life(?:, rounded (up|down))?$/i, (m, ctx) => {
    const who = m[1] ? playerRef(m[1], ctx) : ctx.lastPlayer;
    if (!who) return null;
    const round: 'up' | 'down' = m[3]?.toLowerCase() === 'up' ? 'up' : 'down';
    return [{ kind: 'forEach', over: who, effects: [{ kind: 'loseLife', amount: { kind: 'divide', a: { kind: 'life', ref: { ref: 'iter' } }, by: m[2].toLowerCase() === 'a third' ? 3 : 4, round }, who: { ref: 'iter' } }] }];
  }],
  // "Each opponent chooses two cards in their graveyard and exiles the rest."
  [/^each (player|opponent) chooses (?:up to )?(\w+) (.+?) (they control|in their graveyard|in their hand)(?:, then | and )(sacrifices|exiles|discards) (?:the rest|all (?:the )?others|all other .+)$/i, (m) => {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${singularize(m[3])}`) ?? parseNoun(`a ${m[3]}`);
    if (!noun || !noun.confident || typeof n !== 'number') return null;
    const where = m[4].toLowerCase();
    const base: ObjectFilter = where === 'they control'
      ? { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }
      : { ...noun.filter, ownerRef: { ref: 'iter' }, zone: where === 'in their graveyard' ? 'graveyard' : 'hand' };
    const key = `keep_${m[5].toLowerCase()}_${n}`;
    const rest: Ref = { ref: 'all', filter: { ...base, notChosenKey: key } };
    const act = m[5].toLowerCase();
    const doIt: Effect = act === 'sacrifices' ? { kind: 'sacrifice', what: rest } : act === 'exiles' ? { kind: 'exile', what: rest } : { kind: 'discardObjects', what: rest };
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter: base, count: n, key, upTo: true },
      doIt,
    ] }];
  }],
  // "Each player chooses from among the permanents they control an artifact, a creature, an enchantment, and a land, then sacrifices the rest."
  [/^each (player|opponent) chooses (?:from among |from )(?:the )?(.+?) they control ((?:a|an) .+?), then (sacrifices|exiles) the rest$/i, (m) => buildKeepList(m[1], m[2], m[3], m[4])],
  // "Each opponent chooses an artifact, a creature, an enchantment, and a planeswalker from among the nonland permanents they control, then sacrifices the rest."
  [/^each (player|opponent) chooses ((?:a|an) .+?) from among (?:the )?(.+?) they control, then (sacrifices|exiles) the rest$/i, (m) => buildKeepList(m[1], m[3], m[2], m[4])],
  // "Each player chooses a land they control of each basic land type, then sacrifices the rest."
  [/^each (player|opponent) chooses (?:from )?(?:the )?(?:a |an )?(.+?) they control of each basic land type, then (sacrifices|exiles) the rest$/i, (m) => buildKeepList(m[1], m[2], 'a Plains, an Island, a Swamp, a Mountain, and a Forest', m[3])],
  // "Each player sacrifices an artifact, a creature, an enchantment, a land, and a planeswalker of their choice."
  [/^each (player|opponent) (sacrifices|exiles) ((?:a|an) [\w -]+(?:, (?:a|an) [\w -]+)*,? and (?:a|an) [\w -]+)(?: of (?:their|its) choice)?$/i, (m) => {
    const items = splitItemList(m[3]);
    const nouns = items.map((x) => parseNoun(x));
    if (!nouns.length || nouns.some((n) => !n || !n.confident)) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const effects: Effect[] = nouns.map((n) => ({ kind: 'sacrificeChoice', who: { ref: 'iter' }, filter: { ...n!.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, count: 1 }));
    return [{ kind: 'forEach', over, effects }];
  }],
  // "Each player returns all black and all red creature cards from their graveyard to the battlefield."
  [/^each (player|opponent) returns all (.+?) and all (.+?) cards? from their graveyard to the battlefield$/i, (m) => {
    const a = parseNoun(`a ${m[2]} card`);
    const b = parseNoun(`a ${m[3]} card`);
    if (!a || !b || !a.confident || !b.confident) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const filter: ObjectFilter = { anyOf: [{ ...a.filter, zone: undefined }, { ...b.filter, zone: undefined }], ownerRef: { ref: 'iter' }, zone: 'graveyard' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'returnToBattlefield', what: { ref: 'all', filter }, controller: 'owner' }] }];
  }],
  // ---- Round 131 ----
  // "Return ~ and target creature you control to their owner's hand."
  [/^return ~ and (.+?) to (?:their|its) owner(?:'s|s'|s)? hands?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'returnToHand', what: SELF }, { kind: 'returnToHand', what: ref }];
  }],
  // "Return ~ from your graveyard to the battlefield transformed."
  [/^return ~ from (?:your graveyard|exile|your graveyard or from exile) to the battlefield( tapped)?( transformed)?$/i, (m) => [
    { kind: 'returnToBattlefield', what: SELF, tapped: m[1] ? true : undefined, transformed: m[2] ? true : undefined },
  ]],
  // "Put ~ from exile onto the battlefield tapped." / "Put ~ onto the battlefield from the command zone."
  [/^put ~ (?:from (?:exile|your graveyard|your hand|the command zone) )?onto the battlefield( tapped)?( and attacking)?( transformed)?(?: from the command zone)?$/i, (m) => [
    { kind: 'returnToBattlefield', what: SELF, tapped: m[1] ? true : undefined, attacking: m[2] ? true : undefined, transformed: m[3] ? true : undefined },
  ]],
  // "Shuffle a card from your hand into your library."
  [/^shuffle (?:a|an|(\w+)) cards? from your hand into your library$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'handToLibrary', count: n, shuffle: true }];
  }],
  // "Shuffle your graveyard and hand into your library, then draw seven cards."
  [/^shuffle your (graveyard|hand)(?: and (graveyard|hand))? into your library$/i, (m) => {
    const zones = [m[1], m[2]].filter(Boolean).map((z) => (z === 'hand' ? 'hand' : 'graveyard')) as ('hand' | 'graveyard')[];
    return zones.map((z) => ({ kind: 'shuffleZoneIntoLibrary' as const, zone: z, who: YOU }));
  }],
  [/^shuffle ~ into your library(?: from your graveyard)?$/i, () => [{ kind: 'moveToZone', what: SELF, zone: 'library' }, { kind: 'shuffle' }]],
  // "Put the bottom card of your library into your graveyard."
  [/^put the bottom card of your library into your graveyard$/i, () => [{ kind: 'millBottom', amount: 1, who: YOU }]],
  // "Put the top card of your graveyard on the bottom of your library."
  [/^put the top card of your graveyard on the bottom of your library$/i, () => [{ kind: 'moveToZone', what: { ref: 'all', filter: { zone: 'graveyard', owner: 'you', custom: 'topOfGraveyard' } }, zone: 'library', position: 'bottom' }]],
  // "Put that card on top of that player's library."
  [/^put (?:that card|it|them|those cards) on (?:top|the bottom) of (?:that player's|its owner's|their owner's|your) library$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'moveToZone', what: ref, zone: 'library', position: /bottom/i.test(m[0]) ? 'bottom' : 'top' }];
  }],
  // "Put a card exiled with ~ into its owner's graveyard."
  [/^put (?:a|an|(\w+)|all|target) (?:cards?|face-up exiled cards?) exiled with ~ into (?:its|their) owner(?:'s|s'|s)? graveyards?$/i, () => [
    { kind: 'moveToZone', what: { ref: 'all', filter: { exiledWithSource: true, zone: 'exile' } }, zone: 'graveyard' },
  ]],
  // "Remove any number of counters from target creature you control."
  [/^remove any number of ([+-]\d+\/[+-]\d+|[\w'-]+ )?counters? from (.+)$/i, (m, ctx) => {
    const ref = objRef(m[2], ctx);
    if (!ref) return null;
    return [{ kind: 'removeCounters', counter: (m[1] ?? 'any').trim(), amount: 'all', on: ref, upTo: true }];
  }],
  // "Spells with the chosen name cost {3} more to cast."
  [/^spells with the chosen name cost \{(\d+)\} (less|more) to cast(?: this turn)?$/i, (m) => [
    { kind: 'grantPlayerRule', rule: { kind: m[2].toLowerCase() === 'less' ? 'costReduction' : 'costIncrease', amount: parseInt(m[1], 10), filter: { nameIsChosen: 'cardName' } }, who: { ref: 'eachPlayer' }, duration: /this turn/i.test(m[0]) ? 'thisTurn' : 'permanent' },
  ]],
  // ---- Round 130 ----
  // "Unattach it." / "Unattach ~."
  [/^unattach (it|~|that Equipment|equipped \w+|enchanted \w+)$/i, (m, ctx) => {
    const ref = /^~$/.test(m[1]) ? SELF : objRef(m[1], ctx) ?? SELF;
    return [{ kind: 'unattach', what: ref }];
  }],
  // "Prevent the next 2 damage." / "Prevent the next 2 damage that would be dealt to it this turn."
  [/^prevent the next (\d+|X) damage$/i, (m, ctx) => {
    const n = m[1].toUpperCase() === 'X' ? 'X' : parseInt(m[1], 10);
    const ref = ctx.lastObj ?? SELF;
    return [{ kind: 'preventAll', to: 'all', toRef: ref, amount: typeof n === 'number' ? n : undefined, once: true }];
  }],
  // "It also gets +3/+0 until end of turn." / "~ also deals 3 damage to X."
  [/^(.+?) also (gets?|gains?|deals?|has|have|draws?|loses?) (.+)$/i, (m, ctx) => parseSentence(`${m[1]} ${m[2]} ${m[3]}`, ctx)],
  // "They are no longer suspected."
  [/^(?:they|it|those creatures|all suspected creatures) (?:is|are) no longer suspected$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? SELF;
    return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'clearSuspected' }, on: ref, duration: 'permanent' }];
  }],
  // ---- Round 127 ----
  // "Choose a creature at random, then destroy the rest."
  [/^choose (?:a|an|(\w+)) (.+?) at random$/i, (m, ctx) => {
    const noun = parseNoun(`a ${m[2]}`);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!noun || typeof n !== 'number') return null;
    const key = `rnd_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone) f.zone = 'battlefield';
    return [{ kind: 'chooseObjects', filter: f, count: n, key, random: true }];
  }],
  // "An opponent chooses one of them." / "An opponent chooses a creature card from among them."
  [/^(an opponent|target opponent|each opponent|that player|target player) chooses (?:a|an|one|(\w+))(?: (?:of (?:them|those cards|the piles)|(.+?) from among them))?$/i, (m, ctx) => {
    const who = playerRef(m[1].toLowerCase() === 'an opponent' ? 'target opponent' : m[1], ctx);
    if (!who) return null;
    const n = m[2] ? wordToNumber(m[2]) : 1;
    if (typeof n !== 'number') return null;
    const pool = ctx.restKey ? ({ ref: 'chosen', key: ctx.restKey } as Ref) : ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const key = `opp_${Math.random().toString(36).slice(2, 6)}`;
    ctx.lastObj = { ref: 'chosen', key };
    return [{ kind: 'chooseObjects', who, from: pool, filter: {}, count: n, key }];
  }],
  // "All creatures able to block ~ do so."
  [/^all (.+?) able to block (~|it|that creature|equipped creature|enchanted creature)(?: or (?:~|equipped creature|enchanted creature))?(?: this turn)? do so$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun) return null;
    const on: Ref = { ref: 'all', filter: { ...noun.filter, zone: 'battlefield' } };
    void ctx;
    return [{ kind: 'applyRule', rule: { kind: 'mustBlock' }, on, duration: 'endOfTurn' }];
  }],
  // ---- Round 123 ----
  // "You may play up to two additional lands this turn."
  [/^(?:you may )?play up to (\w+) additional lands?(?: on each of your turns| this turn)?$/i, (m) => {
    const n = wordToNumber(m[1]);
    if (typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'extraLandDrop', count: n }, duration: / this turn$/i.test(m[0]) ? 'thisTurn' : 'permanent' }];
  }],
  [/^(?:you may )?play any number of lands on each of your turns$/i, () => [{ kind: 'grantPlayerRule', rule: { kind: 'extraLandDrop', count: 99 } }]],
  // "You may play lands and cast spells from your graveyard." / "You may play Forests from your graveyard."
  [/^(?:you may )?(?:play|cast) (?:lands and cast |)(.+?) from your graveyard(?: as long as (.+))?$/i, (m, ctx) => {
    void ctx;
    const what = m[1].trim();
    let filter: ObjectFilter | undefined;
    if (!/^(?:spells|cards)$/i.test(what)) {
      const noun = parseNoun(what.replace(/ spells$/i, ' spell'));
      if (!noun || !noun.confident) return null;
      filter = { ...noun.filter, zone: undefined };
    }
    if (/^you may (?:play lands and cast|play lands)/i.test(m[0])) filter = undefined;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'playFromGraveyard', data: { filter } } }];
  }],
  // "You may play cards exiled this way until the end of your next turn."
  [/^(?:you may )?(?:play|cast) (it|them|that card|those cards|the exiled cards?|cards exiled this way|cards exiled with ~|up to \w+ of those cards|lands from among those cards|lands and cast spells from among cards exiled with ~|lands and cast spells from among the exiled cards)(?: (?:this turn|until the end of your next turn|until your next end step|until your next turn|until the beginning of your next upkeep|for as long as (?:it remains|they remain) exiled|for as long as you control ~|until you exile another card with ~))?(?: without paying (?:its|their) mana costs?)?$/i, (m, ctx) => {
    // "the exiled cards" / "cards exiled this way" are everything this source exiled, not whatever "it" last pointed at.
    const ref: Ref = /exiled/i.test(m[1]) ? { ref: 'chosen', key: 'exiled' } : ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    const dur = playUntil(m[0]);
    return [{ kind: 'playFromExile', what: ref, duration: dur, free: /without paying/i.test(m[0]) || undefined }];
  }],
  // "cast it from your graveyard this turn"
  [/^cast (it|that card|them) from your graveyard(?: this turn| as an Adventure until the end of your next turn| until the end of your next turn)?$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: playUntil(m[0]), fromGraveyard: true }];
  }],
  // "destroy all Auras attached to target land"
  [/^destroy all (.+?) attached to (.+)$/i, (m, ctx) => {
    const noun = parseNoun(`a ${singularize(m[1])}`);
    if (!noun) return null;
    const host = /^you$/i.test(m[2]) ? null : objRef(m[2], ctx);
    if (!host && !/^you$/i.test(m[2])) return null;
    const f: ObjectFilter = { ...noun.filter, zone: 'battlefield', ...(host ? { attachedToRef: host } : { attachedToRef: YOU }) };
    return [{ kind: 'destroy', what: { ref: 'all', filter: f } }];
  }],
  // ---- Round 117 ----
  // "You skip your draw step this turn." / "you cannot cast spells until your next turn"
  [/^(?:you )?skip your (draw|untap|combat|end|upkeep|first main|second main) (?:step|phase)(?: this turn)?$/i, (m) => [{ kind: 'skipStep', step: m[1].toLowerCase().replace(/ /g, ''), who: YOU }]],
  [/^you cannot cast (?:additional )?spells(?: this turn| until your next turn)?$/i, (m) => [{ kind: 'applyRule', rule: { kind: 'cantCast', filter: {} }, on: YOU, duration: /until your next turn/i.test(m[0]) ? 'untilYourNextTurn' : 'endOfTurn' }]],
  // "Its controller investigates." / "Its controller loses life equal to its power plus its toughness."
  [/^(?:its|their) controller (.+)$/i, (m, ctx) => {
    const who: Ref = { ref: 'controllerOf', of: ctx.lastObj ?? { ref: 'lastMoved' } };
    const prev = ctx.lastPlayer;
    ctx.lastPlayer = who;
    const inner = parseSentence(`that player ${m[1]}`, ctx);
    ctx.lastPlayer = prev;
    return inner;
  }],
  // "It does not untap during its controller's next two untap steps."
  [/^(.+?) (?:does not|doesn't) untap during (?:its controller's|your|their) next (\w+ )?untap steps?$/i, (m, ctx) => {
    const ref = /^(?:it|~|that creature|that permanent)$/i.test(m[1]) ? (ctx.lastObj ?? SELF) : objRef(m[1], ctx);
    if (!ref) return null;
    const n = m[2] ? wordToNumber(m[2].trim()) : 1;
    if (typeof n !== 'number') return null;
    const out: Effect[] = [];
    for (let i = 0; i < n; i++) out.push({ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'untilNextUntap' });
    return out;
  }],
  // "Look at the top card of your library, then exile it face down."
  [/^look at the top (\w+ )?cards? of your library, then exile (?:it|them)(?: face down)?$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1].trim()) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'exileTop', amount: n, faceDown: /face down/i.test(m[0]) || undefined }];
  }],
  // "Look at a card at random in target player's hand."
  [/^look at (?:a|an|(\w+)) cards? at random in (.+?)(?:'s)? hand$/i, (m, ctx) => {
    const who = playerRef(m[2].replace(/'s$/, ''), ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (!who || typeof n !== 'number') return null;
    return [{ kind: 'revealHand', who, count: n, random: true }];
  }],
  // "Manifest a card from your hand."
  [/^manifest (?:a|an|(\w+)) cards? from your hand$/i, (m) => {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (typeof n !== 'number') return null;
    return [{ kind: 'manifest', amount: n, fromHand: true }];
  }],
  // "Lands you control gain all basic land types until end of turn."
  [/^(.+?) (?:gain|gains|become) all basic land types(?: until end of turn)?$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    return [{ kind: 'addTypes', types: [], subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'], on: ref, duration: / until end of turn$/i.test(m[0]) ? 'endOfTurn' : 'permanent' }];
  }],
  // ---- Round 113 ----
  // "Each opponent may sacrifice a creature. For each opponent who doesn't, you draw a card."
  [/^for each (?:opponent|player) who (cannot|does not|doesn't|didn't [^,]*|does|did), (.+)$/i, (m, ctx) => {
    const negative = /^(?:cannot|does not|doesn't|didn't)/i.test(m[1]);
    const inner = parseSentence(m[2], ctx);
    if (!inner) return null;
    return [{ kind: 'repeat', times: { kind: 'ctxMemory', key: negative ? 'declinedCount' : 'acceptedCount' }, effects: inner }];
  }],
  // "If damage would be dealt to ~, put that many +1/+1 counters on it instead."
  [/^if damage would be dealt to (~|it), put that many ([+-]\d+\/[+-]\d+|[\w'-]+) counters on it instead$/i, (m) => [
    { kind: 'applyRule', rule: { kind: 'custom', tag: 'damageToCounters', data: { counter: m[2] } }, on: SELF, duration: 'permanent' },
  ]],
  // "If a creature enters this way, it enters with an additional +1/+1 counter on it."
  [/^if (?:a|an) (.+?) enters this way, it enters with (?:an additional|(\w+) additional|two additional) ([+-]\d+\/[+-]\d+|[\w'-]+) counters? on it$/i, (m) => {
    const noun = parseNoun(`a ${m[1]}`);
    const n = m[2] ? wordToNumber(m[2]) : /two additional/i.test(m[0]) ? 2 : 1;
    if (!noun || typeof n !== 'number') return null;
    return [{ kind: 'grantPlayerRule', rule: { kind: 'custom', tag: 'extraEnterCounters', data: { filter: { ...noun.filter, zone: undefined }, counter: m[3], amount: n } }, duration: 'thisTurn' }];
  }],
  // "For as long as that card remains exiled, you may play it."
  [/^for as long as (?:that card|those cards|it|they) remains? exiled, (?:you|its owner) may (?:play|cast) (?:it|them)$/i, (m, ctx) => {
    const ref = ctx.lastObj ?? ({ ref: 'lastMoved' } as Ref);
    return [{ kind: 'playFromExile', what: ref, duration: 'permanent', owner: /its owner/i.test(m[0]) || undefined }];
  }],
  // "Exchange your life total with ~'s power."
  [/^exchange your life total with ~'s (power|toughness)$/i, (m) => [{ kind: 'exchangeLifeWith', what: SELF, stat: m[1].toLowerCase() as 'power' }]],
  [/^exchange target opponent's life total with ~'s (power|toughness)$/i, (m, ctx) => {
    const who = objRef('target opponent', ctx);
    if (!who) return null;
    return [{ kind: 'exchangeLifeWith', what: SELF, stat: m[1].toLowerCase() as 'power', who }];
  }],
  // "Exchange your hand and graveyard." / "Exchange your graveyard and library."
  [/^exchange your (hand|graveyard|library) and (?:your )?(hand|graveyard|library)(?:, then shuffle)?$/i, (m) => [
    { kind: 'exchangeZones', a: m[1].toLowerCase() as 'hand', b: m[2].toLowerCase() as 'hand', shuffle: /shuffle/i.test(m[0]) || undefined },
  ]],
  // ---- Round 112 ----
  // "Each player who controls a multicolored creature draws a card."
  [/^each (player|opponent) who ((?:does not|doesn't) control .+?|controls .+?|discarded a card this way|drew a card this way|sacrificed a creature this way|sacrificed a permanent this way|drew a card this turn|lost life this turn|gained life this turn) ((?:draws|loses|gains|discards|sacrifices|mills|investigates|creates|exiles|puts|returns|taps|untaps|may)\b.*)$/i, (m, ctx) => {
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    let cond: Condition | null = null;
    const cm = m[2].match(/^controls (.+)$/i);
    if (cm) {
      const most = cm[1].match(/^the most (.+)$/i);
      const noun = parseNoun(most ? `a ${singularize(most[1])}` : cm[1]) ?? parseNoun(`a ${cm[1]}`);
      if (!noun || !noun.confident) return null;
      cond = most
        ? { kind: 'controlsMost', filter: { ...noun.filter, zone: 'battlefield' }, who: { ref: 'iter' } }
        : { kind: 'count', filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, op: '>=', value: 1 };
    } else if (/discarded a card this way/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'discard', who: { ref: 'iter' } };
    else if (/drew a card this (?:turn|way)/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'drawCard', who: { ref: 'iter' } };
    else if (/lost life this turn/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'lifeLost', who: { ref: 'iter' } };
    else if (/gained life this turn/i.test(m[2])) cond = { kind: 'eventThisTurn', event: 'lifeGained', who: { ref: 'iter' } };
    if (!cond) return null;
    const saved = ctx.targets.length;
    const prevPlayer = ctx.lastPlayer;
    ctx.lastPlayer = { ref: 'iter' };
    const inner = parseSentence(`that player ${m[3]}`, ctx) ?? parseSentence(m[3], ctx);
    ctx.lastPlayer = prevPlayer;
    if (!inner) {
      ctx.targets.length = saved;
      return null;
    }
    return [{ kind: 'forEach', over, effects: [{ kind: 'conditional', if: cond, then: inner }] }];
  }],
  // "Each player chooses three permanents they control, then sacrifices the rest."
  [/^each (player|opponent) chooses (?:up to )?(\w+) (.+?) they control, then sacrifices the rest$/i, (m) => {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${singularize(m[3])}`) ?? parseNoun(`a ${m[3]}`);
    if (!noun || typeof n !== 'number') return null;
    const key = `keep_${Math.random().toString(36).slice(2, 6)}`;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [
      { kind: 'chooseObjects', who: { ref: 'iter' }, filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield' }, count: n, key, upTo: /up to /i.test(m[0]) || undefined },
      { kind: 'sacrifice', what: { ref: 'all', filter: { ...noun.filter, controllerRef: { ref: 'iter' }, zone: 'battlefield', notChosenKey: key } } },
    ] }];
  }],
  // "Each player discards any number of cards, then draws that many cards."
  [/^each (player|opponent) discards any number of cards, then draws that many cards$/i, (m) => {
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    return [{ kind: 'forEach', over, effects: [{ kind: 'discard', amount: 99, upTo: true, who: { ref: 'iter' } }, { kind: 'draw', amount: { kind: 'ctxMemory', key: 'discardedCount' }, who: { ref: 'iter' } }] }];
  }],
  // "Each player returns all creature cards from their graveyard to their hand."
  [/^each (player|opponent) (?:returns?|puts?) (.+?) from their graveyard (?:to|onto) (their hand|the battlefield)$/i, (m) => {
    const noun = parseNoun(m[2]);
    if (!noun || !noun.confident || noun.target) return null;
    const over: Ref = /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
    const f: ObjectFilter = { ...noun.filter, zone: 'graveyard', ownerRef: { ref: 'iter' } };
    const all = noun.each || (noun.plural && !noun.indefinite && noun.count === 1);
    const inner: Effect[] = [];
    let what: Ref;
    if (all) what = { ref: 'all', filter: f };
    else {
      const key = `gy_${Math.random().toString(36).slice(2, 6)}`;
      inner.push({ kind: 'chooseObjects', who: { ref: 'iter' }, filter: f, count: noun.count, key, upTo: noun.upTo || undefined });
      what = { ref: 'chosen', key };
    }
    inner.push(/hand/i.test(m[3]) ? { kind: 'returnToHand', what } : { kind: 'returnToBattlefield', what, controller: 'owner' });
    return [{ kind: 'forEach', over, effects: inner }];
  }],
  // "Each player's life total becomes the lowest life total among all players."
  [/^each player's life total becomes the (lowest|highest) life total among all players$/i, (m) => [{ kind: 'setLife', amount: { kind: m[1].toLowerCase() === 'lowest' ? 'lowestLife' : 'highestLife' }, who: { ref: 'eachPlayer' } }]],
  // "Counter target spell if its mana value is 3 or less\"
  [/^counter (target .+?) if (.+)$/i, (m, ctx) => {
    const ref = objRef(m[1], ctx);
    if (!ref) return null;
    const cond = parseCondition(m[2], { self: SELF, lastObj: ref, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
    if (!cond || cond.kind === 'manual') return null;
    return [{ kind: 'conditional', if: cond, then: [{ kind: 'counterSpell', what: ref }] }];
  }],
  // "~ deals X damage divided evenly, rounded down, among all creatures target opponent controls"
  [/^(.+?) deals (\d+|X) damage divided (?:evenly, rounded down,|as you choose) among (.+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? undefined : (objRef(m[1], ctx) ?? undefined);
    if (!/^~$/.test(m[1]) && !src) return null;
    const to = objRef(m[3], ctx);
    if (!to) return null;
    const a: Amount = /^X$/i.test(m[2]) ? 'X' : parseInt(m[2], 10);
    return [{ kind: 'damage', amount: a, to, source: src, divided: true }];
  }],
  // "~ deals 1 damage to any target and 1 damage to any target of an opponent's choice\"
  // "~ deals X damage to target creature and 1 damage to each other creature with the same controller"
  [/^(.+?) deals (\d+|X) damage to (.+?) and (\d+|X|half X, rounded (?:up|down)) damage to (.+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? undefined : (objRef(m[1], ctx) ?? undefined);
    if (!/^~$/.test(m[1]) && !src) return null;
    const amtOf = (w: string): Amount | null => {
      if (/^\d+$/.test(w)) return parseInt(w, 10);
      if (/^X$/i.test(w)) return 'X';
      const half = w.match(/^half X, rounded (up|down)$/i);
      if (half) return { kind: 'half', a: 'X', round: half[1].toLowerCase() as 'up' | 'down' };
      return null;
    };
    const a1 = amtOf(m[2]);
    const a2 = amtOf(m[4]);
    if (a1 === null || a2 === null) return null;
    const t1 = objRef(m[3], ctx);
    if (!t1) return null;
    const t2 = objRef(m[5], ctx);
    if (!t2) return null;
    return [
      { kind: 'damage', amount: a1, to: t1, source: src },
      { kind: 'damage', amount: a2, to: t2, source: src },
    ];
  }],
  // "~ deals 3 damage to target creature and each other creature that shares a creature type with it"
  [/^(.+?) deals (\d+|X) damage to (.+?) and (each other .+|each .+)$/i, (m, ctx) => {
    const src = /^~$/.test(m[1]) ? undefined : (objRef(m[1], ctx) ?? undefined);
    if (!/^~$/.test(m[1]) && !src) return null;
    const a: Amount = /^X$/i.test(m[2]) ? 'X' : parseInt(m[2], 10);
    const t1 = objRef(m[3], ctx);
    if (!t1) return null;
    const t2 = objRef(m[4], ctx);
    if (!t2) return null;
    return [
      { kind: 'damage', amount: a, to: t1, source: src },
      { kind: 'damage', amount: a, to: t2, source: src },
    ];
  }],
  [/^return (all .+?) to your hand$/i, (m, ctx) => {
    const noun = parseNoun(m[1]);
    if (!noun || !noun.confident) return null;
    const f: ObjectFilter = { ...noun.filter };
    if (!f.zone && !f.zoneIn) f.zone = 'graveyard';
    const ref: Ref = { ref: 'all', filter: f };
    ctx.lastObj = ref;
    return [{ kind: 'returnToHand', what: ref }];
  }],
];

/**
 * "…and you may spend mana as though it were mana of any color to cast it": mark the
 * play-from-exile (or cast) effect this rider belongs to. Returns false when there is none.
 */
/** "If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost." */
function setPayLife(list: Effect[]): boolean {
  for (let k = list.length - 1; k >= 0; k--) {
    const e = list[k];
    if (e.kind === 'playFromExile') {
      e.payLife = true;
      return true;
    }
    if (e.kind === 'castFrom') {
      e.payLifeInsteadOfMana = true;
      return true;
    }
    const nested = (e as { effects?: Effect[] }).effects;
    if (Array.isArray(nested) && setPayLife(nested)) return true;
  }
  return false;
}

function setAnyMana(list: Effect[]): boolean {
  for (let k = list.length - 1; k >= 0; k--) {
    const e = list[k];
    if (e.kind === 'playFromExile') {
      e.anyMana = true;
      return true;
    }
    if (e.kind === 'castFrom') {
      e.anyManaType = true;
      return true;
    }
    const nested = (e as { effects?: Effect[] }).effects;
    if (Array.isArray(nested) && setAnyMana(nested)) return true;
  }
  return false;
}

/** How long a "you may play/cast … " permission lasts, from the sentence's trailing duration. */
function playUntil(text: string): 'thisTurn' | 'permanent' | 'untilYourNextTurn' | 'untilEndOfYourNextTurn' {
  if (/until the end of your next turn/i.test(text)) return 'untilEndOfYourNextTurn';
  if (/until your next turn|until the beginning of your next upkeep/i.test(text)) return 'untilYourNextTurn';
  if (/this turn|until end of turn|next end step/i.test(text)) return 'thisTurn';
  return 'permanent';
}

/**
 * The source of a damage sentence ("~ deals 2 damage to it"). Resolving "~" would otherwise point "it"/"them"/
 * "that creature" at ~ itself (Aether Flash, Caltrops, Lightning Dart, Comet Storm all hit their own source), so the
 * antecedent in scope is kept for the recipient.
 */
function damageSource(phrase: string, ctx: ParseCtx): Ref | null {
  const savedLast = ctx.lastObj;
  const src = objRef(phrase, ctx) ?? (/^(it|that creature)$/i.test(phrase) ? SELF : null);
  if (/^(?:~|this)$/i.test(phrase.trim())) {
    ctx.lastObj = savedLast;
    // With nothing else in scope, ~ becomes the antecedent for the *next* sentence ("If …, it deals 3 damage instead"),
    // once damageTo has resolved this sentence's recipient (see the end of damageTo).
    if (!savedLast) ctx.pendingSubject = SELF;
  }
  return src;
}

function damageTo(targetText: string, amount: Amount, ctx: ParseCtx, source: Ref): Effect[] | null {
  const r = damageToInner(targetText, amount, ctx, source);
  if (ctx.pendingSubject) {
    if (r && !ctx.lastObj) ctx.lastObj = ctx.pendingSubject;
    ctx.pendingSubject = undefined;
  }
  return r;
}

function damageToInner(targetText: string, amount: Amount, ctx: ParseCtx, source: Ref): Effect[] | null {
  let t = targetText.trim();
  let divided = false;
  const dm = t.match(/^(.+?),? divided as you choose among (.+)$/i);
  if (dm) {
    divided = true;
    t = dm[2];
  }
  const l = t.toLowerCase();
  const out: Effect[] = [];
  const mk = (to: Ref): Effect => ({ kind: 'damage', amount, to, source: source.ref === 'self' ? undefined : source, divided });
  if (l === 'each creature and each player' || l === 'each creature and each opponent' || l === 'each creature and each planeswalker') {
    out.push(mk({ ref: 'all', filter: { types: ['Creature'], zone: 'battlefield' } }));
    if (l.includes('player')) out.push(mk({ ref: 'eachPlayer' }));
    else if (l.includes('opponent')) out.push(mk({ ref: 'eachOpponent' }));
    else out.push(mk({ ref: 'all', filter: { types: ['Planeswalker'], zone: 'battlefield' } }));
    return out;
  }
  if (l === 'each opponent and each creature they control') return [mk({ ref: 'eachOpponent' }), mk({ ref: 'all', filter: { types: ['Creature'], controller: 'opponent', zone: 'battlefield' } })];
  if (l === 'each creature without flying') return [mk({ ref: 'all', filter: { types: ['Creature'], withoutKeywords: ['Flying'], zone: 'battlefield' } })];
  if (l === 'each other creature') return [mk({ ref: 'all', filter: { types: ['Creature'], other: true, zone: 'battlefield' } })];
  if (l === 'each creature and each player' ) return null;
  // "X and Y" pairs of refs
  const parts = t.split(/ and /i);
  if (parts.length === 2 && !/target/i.test(parts[1]) && !/target/i.test(parts[0])) {
    const a = anyRef(parts[0], ctx);
    const b = anyRef(parts[1], ctx);
    if (a && b) return [mk(a), mk(b)];
  }
  // "each of up to six targets" / "each of two targets" / "each of one or two targets"
  let em: RegExpMatchArray | null;
  if ((em = t.match(/^each of (?:(up to) )?(?:(\w+) or (\w+)|(X|\w+)) targets$/i))) {
    const lo = em[3] ? wordToNumber(em[2]) : em[1] ? 0 : null;
    const hiRaw = em[3] ?? em[4];
    const hi = hiRaw.toUpperCase() === 'X' ? 'X' : wordToNumber(hiRaw);
    if (hi === null) return null;
    const max = hi === 'X' ? 20 : hi;
    // "each of up to X targets": exactly X (or up to X) targets, X being the spell's X.
    if (hi === 'X') ctx.targets.push({ description: t, kind: 'any', min: em[1] ? 0 : 1, max, countX: { upTo: Boolean(em[1]) }, distinct: true });
    else ctx.targets.push({ description: t, kind: 'any', min: lo === null || lo === 'X' ? max : lo, max, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [mk(ref)];
  }
  if (/^any other target$/i.test(t)) {
    ctx.targets.push({ description: t, kind: 'any', min: 1, max: 1, distinct: true });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    return [mk(ref)];
  }
  if (/^(?:any number of|up to \w+) targets?$/i.test(t) || /^any target$/i.test(t) || /^up to (\w+) targets?$/i.test(t) || /^one or two targets$/i.test(t) || /^one, two, or three targets$/i.test(t)) {
    const um = t.match(/^up to (\w+) targets?$/i);
    const n = um ? wordToNumber(um[1]) : /^one or two/i.test(t) ? 2 : /^one, two, or three/i.test(t) ? 3 : 1;
    ctx.targets.push({ description: t, kind: 'any', min: um ? 0 : 1, max: typeof n === 'number' ? n : 10 });
    const ref: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.lastObj = ref;
    return [mk(ref)];
  }
  // "~ deals X damage to each of them" after "Choose any target, then choose another target …": every slot.
  if (/^(?:each of them|them|each of those targets)$/i.test(t) && ctx.anyTargets?.length) return ctx.anyTargets.map((r) => mk(r));
  // "~ deals 1 damage to them" with only a player in scope: that player (Roiling Vortex's "each player's upkeep").
  // A single trigger object is never "them"; the player is (Adrenaline Jockey: "Whenever a player casts a spell, … deals
  // 4 damage to them"). Batch triggers ("one or more creatures") keep their objects.
  if (l === 'them' && !ctx.lastObj && (ctx.lastPlayer || (ctx.triggerHasPlayer && !ctx.triggerBatch))) return [mk(ctx.lastPlayer ?? { ref: 'triggerPlayer' })];
  const ref = anyRef(t, ctx);
  if (ref) return [mk(ref)];
  return null;
}

/** "except it has haste and it is a Nightmare in addition to its other types" → token copy exceptions. */
export function parseCopyExceptions(text: string): TokenSpec['exceptions'] | null {
  const ex: NonNullable<TokenSpec['exceptions']> = {};
  // Split on commas/ands outside quoted rules text.
  const masked = text.replace(/"[^"]*"/g, (q) => '\u0001'.repeat(q.length));
  const bounds: number[] = [];
  for (const bm of masked.matchAll(/,? and (?=(?:it|they|its|is|has|have|are|loses|lose)\b)|, /gi)) bounds.push(bm.index!, bm.index! + bm[0].length);
  const parts: string[] = [];
  let at = 0;
  for (let bi = 0; bi < bounds.length; bi += 2) {
    parts.push(text.slice(at, bounds[bi]));
    at = bounds[bi + 1];
  }
  parts.push(text.slice(at));
  for (const part of parts) {
    const p = part.trim();
    let m: RegExpMatchArray | null;
    const p2 = p
      .replace(/^and /i, '')
      .replace(/^(?:the token|the copy|that token|those tokens|the tokens|the copies|those creatures|that creature) /i, 'it ')
      .replace(/^(?=(?:is|has|have|are|loses|lose) )/i, 'it ')
      .replace(/\b(?:aren't|are not|isn't)\b/gi, 'is not');
    if ((m = p2.match(/^(?:it|they) (?:is|are) (white|blue|black|red|green|colorless)$/i))) {
      const cc = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: '' } as const;
      ex.colors = cc[m[1].toLowerCase() as 'white'] ? [cc[m[1].toLowerCase() as 'white'] as never] : [];
      continue;
    }
    if (/^(?:it|they) (?:has|have) this ability$/i.test(p2)) {
      ex.thisAbility = true;
      continue;
    }
    // Spark Double: "it enters with an additional +1/+1 counter on it if it is a creature, … loyalty counter … if it is a planeswalker"
    if (/^(?:it|they) (?:enters? with|has|have) an additional \+1\/\+1 counter on (?:it|them) if (?:it|they) (?:is|are) (?:a )?creatures?$/i.test(p2) || /^(?:it|they) (?:enters? with|has|have) an additional loyalty counter on (?:it|them) if (?:it|they) (?:is|are) (?:a )?planeswalkers?$/i.test(p2)) {
      ex.extraCounterByType = true;
      continue;
    }
    // Sakashima of a Thousand Faces: "it has ~'s other abilities"
    if (/^(?:it|they) (?:has|have) ~'s other abilities$/i.test(p2)) {
      ex.ownOtherAbilities = true;
      continue;
    }
    if ((m = p2.match(/^its name is (.+)$/i))) {
      ex.name = m[1].replace(/^~'s /, '');
      continue;
    }
    if ((m = p2.match(/^(?:it|they) (?:has|have) (.+)$/i))) {
      // "it has haste and \"At the beginning of the end step, sacrifice ~.\"" — keywords and quoted text mixed.
      const body = m[1];
      const maskedBody = body.replace(/"[^"]*"/g, (q) => '\u0001'.repeat(q.length));
      const cuts: number[] = [];
      for (const cm of maskedBody.matchAll(/,? and /gi)) cuts.push(cm.index!, cm.index! + cm[0].length);
      const pieces: string[] = [];
      let at2 = 0;
      for (let ci = 0; ci < cuts.length; ci += 2) {
        pieces.push(body.slice(at2, cuts[ci]));
        at2 = cuts[ci + 1];
      }
      pieces.push(body.slice(at2));
      for (const piece of pieces) {
        const q = piece.trim().match(/^"(.+)"$/);
        if (q) {
          ex.abilities = [...(ex.abilities ?? []), q[1]];
          continue;
        }
        if (/^this ability$/i.test(piece.trim())) {
          ex.thisAbility = true;
          continue;
        }
        const kws = parseKeywordList(piece.trim());
        if (!kws) return null;
        ex.keywords = [...(ex.keywords ?? []), ...kws];
      }
    } else if ((m = p2.match(/^(?:it|they) loses? (.+)$/i))) {
      const gone = m[1].split(/,? and |, /i).map((k) => k.trim()).filter(Boolean);
      if (!gone.length || gone.some((k) => !/^[\w' -]+$/.test(k))) return null;
      ex.losesAbilities = [...(ex.losesAbilities ?? []), ...gone.map((k) => k.replace(/^\w/, (ch) => ch.toUpperCase()))];
    } else if ((m = p2.match(/^(?:it|they) enters? with (?:an additional|a|an|(\w+)) ([+-]\d\/[+-]\d|\w+) counters? on (?:it|them)$/i))) {
      const n308 = m[1] ? wordToNumber(m[1]) : 1;
      if (typeof n308 !== 'number') return null;
      ex.counters = { counter: m[2], amount: n308 };
    } else if (/^(?:it|they) (?:is|are) not legendary$/i.test(p2)) ex.notLegendary = true;
    else if (/^(?:it|they) (?:is|are) legendary$/i.test(p2)) ex.legendary = true;
    else if ((m = p2.match(/^(?:it|they) (?:is|are) (?:a|an) (.+?)(?: in addition to its other types)?$/i)) && /^(?:artifact|creature|enchantment|land|legendary|[A-Z]\w+)(?: \w+)*$/.test(m[1]) && !/\d\/\d/.test(m[1])) {
      const words = m[1].split(/\s+/);
      ex.addTypes = [...(ex.addTypes ?? []), ...words.filter((w) => /^(artifact|creature|enchantment|land)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
      ex.addSubtypes = [...(ex.addSubtypes ?? []), ...words.filter((w) => /^[A-Z]/.test(w))];
    } else if ((m = p2.match(/^(?:it|they) (?:is|are) (\d+)\/(\d+)$/i))) {
      ex.power = m[1];
      ex.toughness = m[2];
    } else if ((m = p2.match(/^(?:it|they) (?:is|are) (?:a|an) (?:(legendary) )?(\d+)\/(\d+) (.+?)(?: creatures?)?(?: with ([\w, ]+))?(?: in addition to (?:its|their) other (?:types|colors|colors and types))?$/i))) {
      if (m[1]) ex.legendary = true;
      m = [m[0], m[2], m[3], m[4], m[5]] as unknown as RegExpMatchArray;
      ex.power = m[1];
      ex.toughness = m[2];
      if (m[4]) {
        const kws = parseKeywordList(m[4]);
        if (!kws) return null;
        ex.keywords = [...(ex.keywords ?? []), ...kws];
      }
      for (const w of m[3].split(/\s+/)) {
        const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white'];
        if (c) ex.colors = [...(ex.colors ?? []), c];
        else if (/^colorless$/i.test(w)) ex.colors = [];
        else if (/^and$/i.test(w)) continue;
        else if (/^(artifact|creature|enchantment|land)$/i.test(w)) ex.addTypes = [...(ex.addTypes ?? []), w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()];
        else if (/^legendary$/i.test(w)) ex.legendary = true;
        else if (/^[A-Z]/.test(w)) ex.addSubtypes = [...(ex.addSubtypes ?? []), w];
        else return null;
      }
    } else if ((m = p2.match(/^(?:it|they) (?:is|are) (white|blue|black|red|green|colorless)$/i))) {
      const c = ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[m[1].toLowerCase() as 'white'];
      ex.colors = c ? [c] : [];
    } else return null;
  }
  return ex;
}

/**
 * Trailing sentences that add nothing the rest of the line needs and that no other
 * compiler branch consumes, so they can be trimmed off before a line is parsed.
 */
export function isTrailingNoise(text: string): boolean {
  const t = text.trim().replace(/\.$/, '').replace(/^until (?:end of (?:turn|combat)|your next turn)(?: on your next turn)?, /i, '');
  if (/^(?:a deck can have up to \w+ cards named ~|a deck with this commander has no maximum deck size|a deck can have any number of cards named ~)$/i.test(t)) return true;
  return /^(x cannot be 0|this effect cannot reduce the mana in that cost to less than one mana|you do not lose this mana as steps end|(?:the|its) (?:replicate|foretell|escape|casualty|cycling|flashback|buyback|scavenge|unearth|embalm|eternalize|transmute) cost is .+|x cannot be (?:greater|less) than .+|(?:the )?damage cannot be prevented|counters remain on ~ as it moves to any zone other than a player's hand or library|a creature dealt damage this way cannot be regenerated this turn|this ability cannot cause .+|spend only \w+ mana on x|you may look at cards exiled with ~|each mode must target a different \w+|each copy targets a different one of those \w+|the same is true for .+|th(?:is|at) mana cannot be spent to cast .+|(?:then )?(?:that|each) player shuffles(?: their library)?|reveal (?:it|them|that card|those cards)|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|(?:it|they) cannot be regenerated)$/i.test(t);
}

/** Informational text the engine needs no code for (or that players handle trivially by hand). */
export function isNoOpSentence(text: string): boolean {
  if (/^(?:a deck can have up to \w+ cards named ~|a deck with this commander has no maximum deck size|a deck can have any number of cards named ~)\.?$/i.test(text.trim())) return true;
  if (/^ante ~\.?$/i.test(text.trim()) || /\bante(?:s|d)?\b (?:the top card|a card|~)/i.test(text)) return true;
  if (/^it is still an? [\w-]+(?: [\w-]+)?\.?$/i.test(text.trim())) return true;
  if (/^only creatures can be enchanted this way\.?$/i.test(text.trim())) return true;
  if (/^only th(?:is|at) creature'?s owner may activate this ability\.?$/i.test(text.trim())) return true;
  if (/^other noncreature artifacts are mono and continuous\.?$/i.test(text.trim())) return true;
  if (/^the player who wins this game also wins the match\.?$/i.test(text.trim())) return true;
  if (/^th(?:is|at) mana cannot be spent to pay generic mana costs\.?$/i.test(text.trim())) return true;
  if (/^during that turn, damage cannot be prevented\.?$/i.test(text.trim())) return true;
  if (/^th(?:is|at) ability cannot be copied and x cannot be 0\.?$/i.test(text.trim())) return true;
  if (/^roll the planar die\.?$/i.test(text.trim())) return true;
  if (/^(?:target |that )?(?:creature |noncreature |instant |sorcery )?spells?(?: you cast this turn)? cannot be countered\.?$/i.test(text.trim())) return true;
  if (/^the "legend rule" does not apply\.?$/i.test(text.trim())) return true;
  if (/^target (?:permanent|creature|player|opponent|spell)\.?$/i.test(text.trim())) return true;
  if (/^counters remain on ~ as it moves to any zone other than a player's hand or library\.?$/i.test(text.trim())) return true;
  if (/^you may look at (?:each )?face-down creatures?[\w' -]*(?: any time)?\.?$/i.test(text.trim())) return true;
  if (/^x cannot be (?:greater|less) than .+\.?$/i.test(text.trim())) return true;
  if (/^you may choose (?:a )?new targets? for (?:the|that) cop(?:y|ies)\.?$/i.test(text.trim())) return true;
  if (/^th(?:is|at) ability does not affect its colou?r identity\.?$/i.test(text.trim())) return true;
  if (/^creatures? dealt damage this way cannot be regenerated this turn\.?$/i.test(text.trim())) return true;
  if (/^(?:then )?(?:that|each) player shuffles(?: their library)?\.?$/i.test(text.trim())) return true;
  if (/^the same is true for .+$/i.test(text.trim())) return true;
  if (/^you may reveal (?:a|an) .+? (?:you own )?from outside the game and put it into your hand$/i.test(text.trim())) return true;
  if (/^th(?:is|at) mana cannot be spent to cast .+$/i.test(text.trim())) return true;
  if (/^the flashback cost is equal to its mana cost\.?$/i.test(text.trim())) return true;
  if (/^(?:then )?each player who searched their library this way shuffles\.?$/i.test(text.trim())) return true;
  if (/^[\w' -]+(?: destroyed| exiled| sacrificed)? (?:this way )?cannot be regenerated\.?$/i.test(text.trim())) return true;
  if (/\bdraft(ed|ing)?\b/i.test(text) || /^x cannot be 0\.?$/i.test(text.trim())) return true;
  if (/^th(?:is|at) ability cannot cause .+$/i.test(text.trim())) return true;
  if (/^th(?:is|at) effect reduces only the amount of (?:colored|\w+) mana you pay\.?$/i.test(text.trim())) return true;
  if (/^mana of any type can be spent to cast (?:it|that spell|this spell|those spells) this way\.?$/i.test(text.trim())) return true;
  if (/^if it does ?n[o']t have suspend, it gains suspend\.?$/i.test(text.trim())) return true;
  if (/^(?:players|your opponents|each opponent) play with (?:their hands|the top card of their libraries) revealed\.?$/i.test(text.trim())) return true;
  if (/^spend only \w+ mana on x\.?$/i.test(text.trim())) return true;
  if (/^you may look at cards exiled with ~\.?$/i.test(text.trim())) return true;
  if (/^this ability triggers only once\.?$/i.test(text.trim())) return true;
  if (/^you cannot cast ~ during your (?:first|second|third)(?:, (?:first|second|third))*(?:,? or (?:first|second|third))? turns? of the game\.?$/i.test(text.trim())) return true;
  if (/^~ saddles mounts and crews vehicles as though its power were \d+ greater\.?$/i.test(text.trim())) return true;
  return /^(if you cast a spell this way, mana of any type can be spent to cast it|draft ~ face up|play with the top card of your library revealed|spend this mana only to .+|you may spend mana as though it were mana of any color|mana of any type can be spent to cast (?:spells|a spell) this way|you may spend mana as though it were mana of any color to activate those abilities|you may look at (?:it|that card|those cards) for as long as (?:it remains|they remain) exiled|reveal the first card you draw each turn|this change in ownership is permanent|the new target must be a player|you may reveal the first card you draw each turn as you draw it|a spell cast this way costs .+|spend this mana only on costs that contain .+|it is still a land|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|it cannot be regenerated|they cannot be regenerated|you may choose the same mode more than once|~ can be your commander|any player may activate this ability(?: but only as a sorcery)?|you may look at the top card of your library any time|you may choose not to untap ~ during your untap step|~'s power and toughness are each equal to .+|doctor's companion|fuse|~ enters prepared|partner|friends forever|choose a background|this ability triggers only once each turn|do this only once each turn|reveal it|reveal them|reveal that card|reveal those cards)\.?$/i.test(text.trim());
}

/** Rewrite an effect compiled for "you" so it applies to another player instead. */
function retargetToPlayer<T>(value: T, who: Ref): T {
  if (Array.isArray(value)) return value.map((v) => retargetToPlayer(v, who)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'owner' && v === 'you') {
      out.ownerRef = who;
      continue;
    }
    if (k === 'controller' && v === 'you') {
      out.controllerRef = who;
      continue;
    }
    if (k === 'who' && (v === undefined || (typeof v === 'object' && v !== null && (v as { ref?: string }).ref === 'controller'))) {
      out.who = who;
      continue;
    }
    out[k] = retargetToPlayer(v, who);
  }
  if (typeof src.kind === 'string' && !('who' in src) && ['draw', 'gainLife', 'loseLife', 'setLife', 'discard', 'mill', 'millBottom', 'scry', 'surveil', 'investigate', 'treasure', 'createToken', 'shuffle', 'skipTurn', 'skipStep', 'extraTurn', 'revealHand', 'manifest', 'searchLibrary', 'exileTop', 'loseAllCounters', 'handToLibrary', 'shuffleZoneIntoLibrary', 'chooseObjects', 'lookAtTop'].includes(src.kind as string)) {
    out.who = who;
  }
  return out as unknown as T;
}

/** Parse one sentence; returns null if not understood. */
/**
 * "Up to X target creatures …, where X is the number of Bobbleheads you control": target slots counted by X take their
 * count from the defining amount instead of a mana X (which an ability without {X} in its cost never has).
 */
function bindCountX(ctx: ParseCtx, _from: number, a: Amount): void {
  // Every X-counted slot of this ability: a card never has both a mana X and a "where X is" X, and the slot may have
  // been registered by an earlier clause of the same sentence ("… get +1/+0 and gain indestructible, where X is …").
  for (let i = 0; i < ctx.targets.length; i++) {
    const t = ctx.targets[i];
    if (!t.countX) continue;
    const times = t.countX.times ?? 1;
    const n: Amount = times === 1 ? a : { kind: 'times', a: times, b: a };
    if (t.countX.upTo) {
      t.maxAmount = n;
      t.min = 0;
    } else t.countAmount = n;
    delete t.countX;
  }
}

/** The plural antecedent ("them", "one of them", "each of them"): the object in scope, else a batch trigger's objects, else what last moved. */
function pluralRef(ctx: ParseCtx): Ref {
  return ctx.lastObj ?? (ctx.triggerBatch ? { ref: 'triggerObjects' } : { ref: 'lastMoved' });
}

/** Does this effect list (looking inside conditionals, may, forEach) contain a becomeCopy? */
function hasCopy(effects: Effect[]): boolean {
  return effects.some((e) => e.kind === 'becomeCopy' || (e.kind === 'conditional' && (hasCopy(e.then) || hasCopy(e.else ?? []))) || ((e.kind === 'may' || e.kind === 'forEach') && hasCopy(e.effects)));
}
/** "… becomes a copy of X until end of turn": stamp the duration on every copy effect, wherever it ended up. */
function retimeCopies(effects: Effect[]): Effect[] {
  return effects.map((e) => {
    if (e.kind === 'becomeCopy') return e.duration ? e : { ...e, duration: 'endOfTurn' as const };
    if (e.kind === 'conditional') return { ...e, then: retimeCopies(e.then), ...(e.else ? { else: retimeCopies(e.else) } : {}) };
    if (e.kind === 'may' || e.kind === 'forEach') return { ...e, effects: retimeCopies(e.effects) };
    return e;
  });
}

export function parseSentence(s: string, ctx: ParseCtx): Effect[] | null {
  if (/^you may shuffle(?: your library)?\.?$/i.test(s.trim())) return [{ kind: 'may', effects: [{ kind: 'shuffle' }] }];
  // Tiamat: "Dragon cards … that each have different names" is the usual "with different names".
  if (/ that each have different names\b/i.test(s)) s = s.replace(/ that each have different names\b/gi, ' with different names');
  let text = s.trim().replace(/\.$/, '');
  if (!text) return [];
  text = text.replace(/^then,? /i, '');
  text = text.replace(/^you (create|tap|untap|flip a coin)\b/i, '$1');
  text = text.replace(/\bthat player or that planeswalker's controller controls\b/gi, 'that player controls');
  text = text.replace(/^(for each (?:opponent|player)), you (create|draw|gain|lose|put|exile|destroy|sacrifice|mill|scry|return)\b/i, '$1, $2');
  text = rephraseFirstPerson(text);
  let m: RegExpMatchArray | null;
  // Temporary copies with a leading duration or with the duration after the exceptions:
  // "Until end of turn, ~ becomes a copy of X, except …" (Mindlink Mech, Mirror of the Forebears, Dermotaxi) and
  // "~ becomes a copy of X, except … until end of turn". Handled before the comma/and splitter takes the last
  // exception apart, and retimed here since the copy handlers below know nothing about durations.
  if (((m = text.match(/^until end of turn, (.+?) becomes? a copy of (.+?)(?:, except (.+))?$/i)) || (m = text.match(/^(.+?) becomes? a copy of (.+?), except (.+?) until end of turn$/i))) && !/^if /i.test(m[1])) {
    const saved = ctx.targets.length;
    const inner = parseSentence(`${m[1]} becomes a copy of ${m[2]}${m[3] ? `, except ${m[3]}` : ''}`, ctx);
    if (inner && hasCopy(inner)) return retimeCopies(inner);
    ctx.targets.length = saved;
  }
  // Comet Storm: "Choose any target, then choose another target for each time this spell was kicked."
  if (/^choose any target, then choose another target for each time (?:~|this spell|it) was kicked$/i.test(text)) {
    ctx.targets.push({ description: 'any target', kind: 'any', playerFilter: 'any' });
    const first: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.targets.push({ description: 'another target for each time ~ was kicked', kind: 'any', playerFilter: 'any', min: 0, max: 20, countAmount: { kind: 'kickCount' }, distinct: true });
    const rest: Ref = { ref: 'target', slot: ctx.targets.length - 1 };
    ctx.anyTargets = [first, rest];
    ctx.anyTarget = first;
    ctx.lastObj = first;
    return [];
  }
  // "~ gets +3/-1 until end of turn and can attack this turn as though it didn't have defender"
  if ((m = text.match(/^(.+? (?:gets?|get) [+-]\d+\/[+-]\d+(?: until end of turn)?) and can attack(?: this turn)? as though it (?:didn't|did not) have defender$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) {
      const ref = ctx.lastObj ?? SELF;
      return [...inner, { kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }];
    }
  }
  // "put all cards exiled with ~ into their owner's graveyard"
  if ((m = text.match(/^put (all cards exiled with ~|all .+? exiled with ~) into (?:their|its) owners'? graveyards?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'putIntoGraveyard', what: ref }];
  }
  // "destroy the creature with the least power"
  if ((m = text.match(/^(destroy|exile|tap) the (.+? with the (?:least|greatest) (?:power|toughness))$/i))) {
    const noun = parseNoun(`a ${m[2]}`);
    if (noun) {
      const f: ObjectFilter = { ...noun.filter, zone: 'battlefield' };
      const verb = m[1].toLowerCase();
      return [verb === 'destroy' ? { kind: 'destroy', what: { ref: 'all', filter: f } } : verb === 'exile' ? { kind: 'exile', what: { ref: 'all', filter: f } } : { kind: 'tap', what: { ref: 'all', filter: f } }];
    }
  }
  // Cards that pick a colour before the game and then are that colour.
  if (/^if ~ is your commander, choose a color before the game begins$/i.test(text)) return [{ kind: 'chooseColor', key: 'color' }];
  if (/^~ is the chosen color$/i.test(text)) return [{ kind: 'setColors', colors: [], chosenKey: 'color', on: SELF, duration: 'permanent' }];
  // "each player searches their library for up to two basic land cards, puts them onto the battlefield, then shuffles"
  if ((m = text.match(/^(each player|each opponent|that player|target player|target opponent|its controller) search(?:es)? their library for (.+?)(?:,| and) (reveals? (?:it|them), )?puts? (.+?)(?:, then shuffles?)?$/i))) {
    const who = playerRef(m[1], ctx);
    if (who) {
      const saved = ctx.lastPlayer;
      ctx.lastPlayer = who;
      const r = parseSentence(`search their library for ${m[2]}, ${m[3] ? 'reveal it, ' : ''}put ${m[4]}, then shuffle`, ctx);
      if (r) return r;
      ctx.lastPlayer = saved;
    }
  }
  if ((m = text.match(/^(.+?) (?:does not|doesn't|do not|don't) untap during (?:its controller's|their controller's|its controllers'|your|their) untap steps?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'cantUntap' }, on: ref, duration: 'permanent' }];
  }
  // "have target creature get -2/-2 until end of turn" → "target creature gets -2/-2 until end of turn"
  if ((m = text.match(/^have (.+?) (get|gain|lose|become) (.+)$/i))) {
    const r = parseSentence(`${m[1]} ${m[2]}s ${m[3]}`, ctx);
    if (r) return r;
  }
  // "put your choice of a +1/+1, first strike, or trample counter on that creature"
  if ((m = text.match(/^put your choice of (?:a|an) (.+?) counter on (.+)$/i))) {
    const options = m[1].split(/,? or |, /).map((x) => x.replace(/^(?:a|an) /i, '').trim()).filter(Boolean);
    const ref = objRef(m[2], ctx);
    if (ref && options.length > 1) return [{ kind: 'addCounters', counter: options[0], counterOptions: options, amount: 1, on: ref }];
  }
  // "return target creature card from your graveyard to the battlefield tapped and attacking"
  if ((m = text.match(/^(return .+? to the battlefield(?: under (?:your|its owner's|their owner's|that player's) control)?) tapped and attacking$/i))) {
    const inner = parseSentence(`${m[1]} tapped`, ctx);
    if (inner) return inner.map((e) => (e.kind === 'returnToBattlefield' ? { ...e, attacking: true } : e));
  }
  if ((m = text.match(/^when (that creature|it|that permanent) becomes blocked this turn, (.+)$/i))) {
    const ref = objRef(m[1], ctx);
    const inner = ref ? parseSentence(m[2], ctx) : null;
    if (ref && inner) return [{ kind: 'delayedTrigger', event: 'becomesBlocked', filter: { objectRef: ref }, effects: inner, text, once: true }];
  }
  // "You may cast a spell with mana value 4 or less from your hand without paying its mana cost"
  if ((m = text.match(/^(?:you may )?cast (?:a|an) (.+?) (?:card |spell )?(?:from (your hand|your graveyard|a graveyard) )?(?:with mana value (\d+|X) or less )?(?:from (your hand|your graveyard|a graveyard) )?without paying its mana cost$/i))) {
    const noun = /^spell$/i.test(m[1]) ? { filter: { nonland: true } as ObjectFilter } : parseNoun(`a ${m[1].replace(/ spell$/i, '')} card`);
    if (noun) {
      const key = `hand${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
      const where = (m[2] ?? m[4] ?? 'your hand').toLowerCase();
      const f: ObjectFilter = { ...noun.filter, zone: where.includes('graveyard') ? 'graveyard' : 'hand', nonland: true };
      if (where === 'your hand' || where === 'your graveyard') f.owner = 'you';
      if (m[3]) f.cmcLE = m[3] === 'X' ? 'X' : parseInt(m[3], 10);
      ctx.lastObj = { ref: 'chosen', key };
      return [{ kind: 'may', effects: [{ kind: 'chooseObjects', filter: f, count: 1, key }, { kind: 'castWithoutPaying', what: { ref: 'chosen', key } }] }];
    }
  }
  if ((m = text.match(/^(?:until end of turn, )?(.+?) assigns? combat damage equal to (?:its|their) toughness rather than (?:its|their) power(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'damageByToughness' }, on: ref, duration: 'endOfTurn' }];
  }
  if (/^after this (?:phase|combat phase|main phase), there is an additional combat phase(?: followed by an additional main phase)?$/i.test(text)) return [{ kind: 'extraCombat' }];
  if (/^exile ~, then return it to the battlefield transformed under (?:your|its owner's) control$/i.test(text)) return [{ kind: 'exile', what: SELF }, { kind: 'returnToBattlefield', what: { ref: 'lastMoved' } }, { kind: 'transform', what: { ref: 'lastMoved' } }];
  if ((m = text.match(/^prevent all (combat )?damage that would be dealt to and dealt by (.+?) this turn$/i))) {
    const ref = objRef(m[2], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: m[1] ? 'combat' : 'all' }, on: ref, duration: 'endOfTurn' }, { kind: 'applyRule', rule: { kind: 'custom', tag: 'preventDamageTo', data: { combat: m[1] ? 'combat' : undefined } }, on: ref, duration: 'endOfTurn' }];
  }
  if ((m = text.match(/^(.+?) deals (\w+|X) damage to (target player|target opponent|any target|target player or planeswalker|that player|each opponent) and (each .+)$/i))) {
    const a = parseSentence(`${m[1]} deals ${m[2]} damage to ${m[3]}`, ctx);
    const b = a ? parseSentence(`${m[1]} deals ${m[2]} damage to ${m[4]}`, ctx) : null;
    if (a && b) return [...a, ...b];
  }
  if ((m = text.match(/^(.+?) can block an additional creature (?:this turn|each combat)$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'extraBlock' }, on: ref, duration: / this turn$/i.test(text) ? 'endOfTurn' : 'permanent' }];
  }
  if ((m = text.match(/^put (.+?) into its owner's library second from the top$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'putOnLibrary', what: ref, position: 'secondFromTop' }];
  }
  if ((m = text.match(/^choose ((?:any number of|up to \w+|\w+) target .+)$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) {
      ctx.anyTarget = ref; // later "that creature"/"that permanent" means this choice
      return [];
    }
  }
  if ((m = text.match(/^(.+?) becomes? the (basic land type|creature type) of your choice(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'setSubtypes', on: ref, choose: m[2].toLowerCase() === 'basic land type' ? 'basicLandType' : 'creatureType', duration: / until end of turn$/i.test(text) ? 'endOfTurn' : 'permanent' }];
  }
  if ((m = text.match(/^you and (permanents|creatures) you control gain (hexproof|indestructible|hexproof and indestructible) until end of turn$/i))) {
    const kws = m[2].split(' and ').map((k) => k.charAt(0).toUpperCase() + k.slice(1));
    const out: Effect[] = [{ kind: 'grantKeywords', keywords: kws, on: { ref: 'all', filter: { controller: 'you', zone: 'battlefield', ...(m[1].toLowerCase() === 'creatures' ? { types: ['Creature'] } : {}) } }, duration: 'endOfTurn' }];
    if (/hexproof/i.test(m[2])) out.push({ kind: 'applyRule', rule: { kind: 'custom', tag: 'hexproof' }, on: YOU, duration: 'endOfTurn' });
    return out;
  }
  if ((m = text.match(/^blight (\d+|X)$/i))) {
    const key = `blight${ctx.targets.length}_${Math.random().toString(36).slice(2, 6)}`;
    return [{ kind: 'chooseObjects', filter: { types: ['Creature'], controller: 'you', zone: 'battlefield' }, count: 1, key }, { kind: 'addCounters', counter: '-1/-1', amount: m[1] === 'X' ? 'X' : parseInt(m[1], 10), on: { ref: 'chosen', key } }];
  }
  if ((m = text.match(/^return (it|that card|~|them) to the battlefield transformed(?: under (?:your|its owner's|their owner's) control)?(?: tapped)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'returnToBattlefield', what: ref, transformed: true, controller: /owner's/i.test(text) ? 'owner' : 'you', tapped: / tapped$/i.test(text) || undefined }];
  }
  if (/^reveal the top card of your library$/i.test(text)) {
    ctx.lastObj = { ref: 'lastMoved' };
    return [{ kind: 'revealTop', destination: 'stay' }];
  }
  if ((m = text.match(/^(each player|each opponent|target player|target opponent|that player|you) reveals? the top card of (?:their|your) library$/i))) {
    const who = playerRef(m[1], ctx);
    if (who) {
      ctx.lastObj = { ref: 'lastMoved' };
      return [{ kind: 'revealTop', who, destination: 'stay' }];
    }
  }
  if ((m = text.match(/^exert (~|it|that creature)$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'exert', what: ref }];
  }
  // Earthbend N: target land you control becomes a 0/0 creature with haste (still a land) with N +1/+1 counters; it comes back tapped if it dies or is exiled.
  if ((m = text.match(/^earthbend (\d+|X)$/i))) {
    const n: Amount = m[1] === 'X' ? 'X' : parseInt(m[1], 10);
    const ref = objRef('target land you control', ctx);
    if (ref) {
      return [
        { kind: 'addTypes', types: ['Creature'], on: ref, duration: 'permanent' },
        { kind: 'setPT', power: 0, toughness: 0, on: ref, duration: 'permanent' },
        { kind: 'grantKeywords', keywords: ['Haste'], on: ref, duration: 'permanent' },
        { kind: 'addCounters', counter: '+1/+1', amount: n, on: ref },
        { kind: 'delayedTrigger', event: 'dies', filter: { objectRef: ref }, effects: [{ kind: 'returnToBattlefield', what: { ref: 'triggerObject' }, tapped: true, controller: 'owner' }], text: 'Earthbend: when it dies, return it to the battlefield tapped.', once: true },
        { kind: 'delayedTrigger', event: 'exiled', filter: { objectRef: ref }, effects: [{ kind: 'returnToBattlefield', what: { ref: 'triggerObject' }, tapped: true, controller: 'owner' }], text: 'Earthbend: when it is exiled, return it to the battlefield tapped.', once: true },
      ];
    }
  }
  // "~ becomes a Construct artifact creature with "..." until end of turn"
  if ((m = text.match(/^(.+?) becomes? (?:a|an) (\d+)\/(\d+) (.+?) creature(?: with (.+?))?(?: in addition to (?:its|their) other types)?(?: until end of turn)?(?: that(?:'s| is) still (?:a |an )?\w+)?$/i)) && !/"/.test(text)) {
    const ref = objRef(m[1], ctx);
    if (ref) {
      const words = m[4].split(/\s+/);
      const colors = words.filter((w) => /^(white|blue|black|red|green)$/i.test(w)).map((w) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[w.toLowerCase() as 'white']);
      const subtypes = words.filter((w) => /^[A-Z]/.test(w));
      const rest = words.filter((w) => !/^(white|blue|black|red|green|and|colorless|artifact|enchantment)$/i.test(w) && !/^[A-Z]/.test(w));
      if (!rest.length) {
        const dur: Duration = / until end of turn/i.test(text) ? 'endOfTurn' : 'permanent';
        const types = ['Creature', ...words.filter((w) => /^(artifact|enchantment)$/i.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())];
        const out: Effect[] = [{ kind: 'addTypes', types, subtypes: subtypes.length ? subtypes : undefined, on: ref, duration: dur }, { kind: 'setPT', power: parseInt(m[2], 10), toughness: parseInt(m[3], 10), on: ref, duration: dur }];
        if (colors.length || /colorless/i.test(m[4])) out.push({ kind: 'setColors', colors, on: ref, duration: dur });
        const kws5 = m[5] ? parseKeywordList(m[5]) : [];
        if (m[5] && !kws5) {
          // Fall through: a later pattern may read the tail differently.
        } else {
          if (kws5?.length) out.push({ kind: 'grantKeywords', keywords: kws5, on: ref, duration: dur });
          return out;
        }
      }
    }
  }
  if ((m = text.match(/^(.+?) becomes? (?:a|an) (.+?) (artifact creature|creature|artifact|enchantment creature) with "(.+)"(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) {
      const dur: Duration = / until end of turn"?$/i.test(text) || / until end of turn$/i.test(text) ? 'endOfTurn' : 'permanent';
      const types = m[3].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1));
      const subtypes = m[2].split(/\s+/).filter((w) => /^[A-Z]/.test(w));
      return [{ kind: 'addTypes', types, subtypes, on: ref, duration: dur }, { kind: 'grantAbility', text: m[4], on: ref, duration: dur }];
    }
  }
  // "~ deals damage equal to the discarded card's mana value to that permanent or player" → "~ deals X damage to ..., where X is ..."
  if ((m = text.match(/^(.+?) deals damage equal to (.+?) to (.+)$/i)) && !/\bwhere X is\b/i.test(text) && !/\. |, | and /.test(m[1])) {
    // Resolve the subject, then the amount, then the damage target: "its power" is the subject's
    // (Soul's Fire) and "that card's mana value" is what an earlier sentence set up (Kindle the
    // Carnage), not the creature being damaged.
    const saved = ctx.targets.length;
    const savedLast = ctx.lastObj;
    // "Each creature you control with a +1/+1 counter on it deals damage equal to its power to that creature":
    // one damage event per creature, each measured on itself.
    const each = m[1].match(/^each (?:of )?(.+)$/i);
    if (each && /^its\b/i.test(m[2])) {
      let over: Ref | null = null;
      if (/^(?:those creatures|them)$/i.test(each[1])) over = { ref: 'lastDamaged' };
      else {
        const noun = parseNoun(`a ${singularize(each[1])}`);
        if (noun && noun.confident && !noun.target) over = { ref: 'all', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } };
      }
      if (over) {
        const sub = newCtx({ ...ctx, targets: ctx.targets });
        sub.lastObj = { ref: 'iter' };
        const a = amt(m[2], sub);
        const inner = a !== null ? damageTo(m[3], a, sub, { ref: 'iter' }) : null;
        if (inner) return [{ kind: 'forEach', over, effects: inner }];
        ctx.targets.length = saved;
      }
    }
    // A "~" subject must not become "that card": keep whatever an earlier sentence set up.
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    let a: Amount | null = null;
    if (src && /^its\b/i.test(m[2])) {
      // "X deals damage equal to its power": "its" is the subject X.
      const keep = ctx.lastObj;
      ctx.lastObj = src;
      a = amt(m[2], ctx);
      ctx.lastObj = keep;
    } else if (src) a = amt(m[2], ctx);
    const direct = src && a !== null ? damageTo(m[3], a, ctx, src) : null;
    if (direct) return direct;
    ctx.targets.length = saved;
    ctx.lastObj = savedLast;
    const r = parseSentence(`${m[1]} deals X damage to ${m[3]}, where X is ${m[2]}`, ctx);
    if (r) return r;
  }
  if ((m = text.match(/^(.+?) deals damage to (.+?) equal to (.+)$/i)) && !/\bwhere X is\b/i.test(text) && !/\. |, /.test(m[1])) {
    // Same ordering as above: subject, then amount, then the damage target (Undying Flames: "deals damage to any
    // target equal to that card's mana value" is the exiled card's, not the target's).
    const saved = ctx.targets.length;
    const savedLast = ctx.lastObj;
    const src = m[1] === '~' ? SELF : objRef(m[1], ctx) ?? (/^(it|that creature)$/i.test(m[1]) ? SELF : null);
    let direct: Effect[] | null = null;
    if (src && /^each (player|opponent)$/i.test(m[2].trim()) && /\b(?:that player|that opponent|their|they)\b/i.test(m[3])) {
      // "deals damage to each player equal to half that player's life total": one damage event per player.
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastPlayer = { ref: 'iter' };
      const a = amt(m[3], sub);
      if (a !== null) return [{ kind: 'forEach', over: /opponent/i.test(m[2]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: [{ kind: 'damage', amount: a, to: { ref: 'iter' }, ...(src.ref === 'self' ? {} : { source: src }) }] }];
    }
    if (src && /\b(?:that player|that opponent|their|its|that creature's|that permanent's|they)\b/i.test(m[3])) {
      // "deals damage to target player equal to the number of cards in that player's hand": the amount names the target.
      direct = damageTo(m[2], 0, ctx, src);
      const a = direct ? amt(m[3], ctx) : null;
      if (direct && a !== null) {
        for (const e of direct) if (e.kind === 'damage') e.amount = a;
      } else direct = null;
    } else if (src) {
      const a = amt(m[3], ctx);
      direct = a !== null ? damageTo(m[2], a, ctx, src) : null;
    }
    if (direct) return direct;
    ctx.targets.length = saved;
    ctx.lastObj = savedLast;
    const r = parseSentence(`${m[1]} deals X damage to ${m[2]}, where X is ${m[3]}`, ctx);
    if (r) return r;
  }
  // "For each creature card exiled this way, create a token that is a copy of it"
  if ((m = text.match(/^for each (.+?) (exiled|destroyed|sacrificed|returned|discarded|milled|revealed) this way, (.+)$/i))) {
    const noun = parseNoun(`a ${m[1].replace(/ cards?$/i, ' card')}`);
    if (noun) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastObj = { ref: 'iter' };
      const inner = parseSentence(m[3].replace(/\b(?:that|this) (?:creature|permanent|card|land|token)\b/gi, 'it'), sub);
      if (inner) return [{ kind: 'forEach', over: { ref: 'lastMoved' }, effects: inner, filter: { ...noun.filter, zone: undefined } } as Effect];
    }
  }
  if ((m = text.match(/^(.+?) can attack this turn as though (?:it|they) (?:did not|didn't) have defender$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'canAttackWithDefender' }, on: ref, duration: 'endOfTurn' }];
  }
  if ((m = text.match(/^(target (?:creature|permanent|artifact|nonland permanent)[^']*?)'s owner puts it on their choice of the top or bottom of their library$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'putOnLibrary', what: ref, position: 'ownerChoice' }];
  }
  // "~ becomes a copy of X until end of turn(, except ...)": a temporary copy. Re-parse without the duration and
  // retime the copy effect (Impossible Man, Mirror of the Forebears, Saheeli, Shuri, Mindlink Mech were permanent copies).
  if ((m = text.match(/^(.+?) becomes? a copy of (.+?) until end of turn(?:, except (.+))?$/i)) && !/^if /i.test(m[1])) {
    const saved = ctx.targets.length;
    const alt = parseSentence(`${m[1]} becomes a copy of ${m[2]}${m[3] ? `, except ${m[3]}` : ''}`, ctx);
    if (alt && hasCopy(alt)) return retimeCopies(alt);
    ctx.targets.length = saved;
  }
  if ((m = text.match(/^(.+?) becomes? a copy of (.+?)(?:, except (.+))?$/i)) && !/until end of turn/i.test(text) && !/^(?:until|if) /i.test(m[1])) {
    // Resolve the source first: naming "~" as the subject points "it"/"that card" at ~, and Vesuvan Drifter's
    // "~ becomes a copy of that card" must still copy the revealed card.
    const savedLast = ctx.lastObj;
    const savedT = ctx.targets.length;
    const of = objRef(m[2], ctx);
    ctx.lastObj = savedLast;
    const what = of ? objRef(m[1], ctx) : null;
    const ex = m[3] ? parseCopyExceptions(m[3]) : undefined;
    if (what && of && (!m[3] || ex)) return [{ kind: 'becomeCopy', what, of, exceptions: ex ?? undefined }];
    // A rejected parse must not leave the copy source registered as a target (Volrath, The Animus, Aurora Shifter
    // ended up asking for the same target twice).
    ctx.targets.length = savedT;
    ctx.lastObj = savedLast;
  }
  if ((m = text.match(/^put (it|that card|them|those cards|~) into (?:your|its owner's|their owner's|their owners') graveyards?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'moveToZone', what: ref, zone: 'graveyard' }];
  }
  if ((m = text.match(/^return ~ from your graveyard to the battlefield attached to (.+)$/i))) {
    const host = objRef(m[1], ctx);
    if (host) return [{ kind: 'returnToBattlefield', what: SELF, attachTo: host }];
  }
  if ((m = text.match(/^put (?:its|~'s) counters on (.+)$/i))) {
    const to = objRef(m[1], ctx);
    if (to) return [{ kind: 'moveCounters', from: ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF, to }];
  }
  if (/^~ assigns no combat damage this turn$/i.test(text)) return [{ kind: 'applyRule', rule: { kind: 'custom', tag: 'dealsNoDamage', data: 'combat' }, on: SELF, duration: 'endOfTurn' }];
  if (/^until end of turn, you (?:do not|don't) lose this mana as steps and phases end$/i.test(text) || /^you (?:do not|don't) lose this mana as steps and phases end(?: this turn)?$/i.test(text)) return [{ kind: 'turnFlag', flag: 'keepMana' }];
  if (/^clash with an opponent$/i.test(text)) {
    ctx.lastPlayer = { ref: 'chosen', key: 'clashOpponent' }; // "Otherwise, that player gains control of enchanted creature"
    return [{ kind: 'clash' }];
  }
  if ((m = text.match(/^detain (.+)$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'applyRule', rule: { kind: 'cantAttack' }, on: ref, duration: 'untilYourNextTurn' }, { kind: 'applyRule', rule: { kind: 'cantBlock' }, on: ref, duration: 'untilYourNextTurn' }, { kind: 'applyRule', rule: { kind: 'custom', tag: 'cantActivate' }, on: ref, duration: 'untilYourNextTurn' }];
  }
  if ((m = text.match(/^double the number of ([+\-\w\/]+) counters on (.+)$/i))) {
    // Kalonian Hydra: each creature's own count is doubled, not the total across all of them.
    const ref = objRef(m[2], ctx);
    if (ref) return [{ kind: 'doubleCounters', counter: m[1], on: ref }];
  }
  // "destroy that creature at end of combat" / "sacrifice it at end of combat"
  if ((m = text.match(/^(.+?) at (?:the )?end of combat$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) return [{ kind: 'delayedTrigger', event: 'endOfCombat', effects: inner, text, once: true }];
  }
  // "~ gets +1/+0 until end of turn and cannot be blocked this turn"
  if ((m = text.match(/^((~|it|that creature|target creature[^,]*?|enchanted creature|equipped creature) (?:gets?|gains?) .+? until end of turn) and ((?:cannot|can't|must|doesn't|does not) .+?)(?: this turn)?$/i))) {
    const savedT = ctx.targets.length;
    const a = parseSentence(m[1], ctx);
    // The second clause is about the same creature: a "target creature" subject is already registered, so refer back to it.
    const subj = /^target /i.test(m[2]) && ctx.lastObj ? 'it' : m[2];
    const b = a ? parseSentence(`${subj} ${m[3]} this turn`, ctx) ?? parseSentence(`${subj} ${m[3]}`, ctx) : null;
    if (a && b) return [...a, ...b];
    ctx.targets.length = savedT;
  }
  if ((m = text.match(/^(.+?) becomes? the color (?:or colors )?of your choice(?: until end of turn)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'setColors', colors: [], chooseColors: true, on: ref, duration: / until end of turn$/i.test(text) ? 'endOfTurn' : 'permanent' }];
  }
  if ((m = text.match(/^put (it|that card|~|them|those cards) onto the battlefield transformed(?: under (?:your|its owner's|their owner's) control)?(?: with (?:a|an|(\w+)) ([+\-\w\/]+) counters? on it)?$/i))) {
    const ref = objRef(m[1], ctx);
    if (ref) return [{ kind: 'returnToBattlefield', what: ref, transformed: true, counters: m[3] ? { counter: m[3], amount: m[2] ? (wordToNumber(m[2]) as number) ?? 1 : 1 } : undefined }];
  }
  if ((m = text.match(/^exile the top (?:card|(\w+|X) cards)(?: of your library)?(?: face down)?$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (n !== null) {
      ctx.lastObj = { ref: 'lastMoved' };
      return [{ kind: 'exileTop', amount: n }];
    }
  }
  if ((m = text.match(/^exile the top (?:card|(\w+|X) cards) of (target player|target opponent|that player|each player|each opponent)'s library(?: face down)?$/i))) {
    const who = playerRef(m[2], ctx);
    const n = m[1] ? wordToNumber(m[1]) : 1;
    if (who && n !== null) {
      ctx.lastObj = { ref: 'lastMoved' }; // "that card" in the next sentence
      return [{ kind: 'exileTop', who, amount: n }];
    }
  }
  // "Whenever a creature blocks this turn, X" (a spell setting up a this-turn trigger)
  if ((m = text.match(/^(whenever [^,]+?) this turn, (.+)$/i))) {
    const head = parseTriggerHead(`${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}, ${m[2]}`);
    if (head && !head.also) {
      const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer });
      const inner = parseSentence(head.rest, sub);
      if (inner) return [{ kind: 'delayedTrigger', event: head.event, filter: head.filter, effects: inner, text, untilEndOfTurn: true }];
    }
  }
  // "Gain control of target creature for as long as ~ remains tapped" / "... for as long as you control ~"
  if ((m = text.match(/^(.+?) for as long as (~ remains tapped|you control ~|~ remains on the battlefield|~ remains untapped|you control ~ and ~ remains tapped|~ remains tapped and you control ~|~ remains tapped and that creature's power remains less than or equal to ~'s power)$/i))) {
    const savedT = ctx.targets.length; // a rejected inner parse must not leave its target behind (Hedge Whisperer registered its land twice)
    const inner = parseSentence(m[1], ctx);
    const dur: Duration = /remains tapped/i.test(m[2]) ? 'whileSourceTapped' : /you control/i.test(m[2]) ? 'whileYouControlSource' : 'untilSourceLeaves';
    if (inner && inner.length && inner.every((e) => e.kind === 'gainControl' || e.kind === 'applyRule' || e.kind === 'pump' || e.kind === 'setPT' || e.kind === 'grantKeywords' || e.kind === 'addTypes' || e.kind === 'setSubtypes' || e.kind === 'setColors' || e.kind === 'grantAbility' || e.kind === 'loseAllAbilities')) {
      return inner.map((e) => ('duration' in e ? ({ ...e, duration: dur } as Effect) : e));
    }
    ctx.targets.length = savedT;
  }
  // "Until end of turn, whenever X, Y": a delayed trigger that fires repeatedly this turn.
  if ((m = text.match(/^until end of turn, (whenever .+)$/i))) {
    const head = parseTriggerHead(m[1]);
    if (head && !head.also) {
      const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer });
      const inner = parseSentence(head.rest, sub);
      if (inner) return [{ kind: 'delayedTrigger', event: head.event, filter: head.filter, effects: inner, text, untilEndOfTurn: true }];
    }
  }
  // "Pay {3}{U}{U}. If you don't, you lose the game."
  if ((m = text.match(/^(?:you may )?pay (\{.+?\}|\d+ life)\. if you (?:do not|don't), (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (inner) {
      const life = m[1].match(/^(\d+) life$/);
      return [{ kind: 'unlessPays', who: YOU, cost: life ? { payLife: parseInt(life[1], 10) } : m[1], effects: inner, text }];
    }
  }
  // "You may pay X life, where X is …. If you do, draw X cards"
  if ((m = text.match(/^(?:you may )?pay X life, where X is (.+?)\. if you do, (.+)$/i))) {
    const a = amt(m[1], ctx);
    const inner = a !== null ? parseSentence(m[2], ctx) : null;
    if (a !== null && inner) {
      ctx.boundX = a;
      return [{ kind: 'ifPays', cost: '', payLifeAmount: a, effects: inner.map((e) => substituteXDeep(e, a)) }];
    }
  }
  // "You may X. If you do, Y" is split by the caller; handle "you may X" here.
  // "You may pay {1} and 1 life. If you do, draw a card" (Miara, Purgatory): mana plus life.
  if ((m = text.match(/^(?:you may )?pay ((?:\{[^}]+\})+) and (\d+) life\. if you do, (.+)$/i))) {
    const inner = parseSentence(m[3], ctx);
    if (inner) return [{ kind: 'ifPays', cost: m[1], payLife: parseInt(m[2], 10), effects: inner }];
  }
  if ((m = text.match(/^(?:you may )?pay (\{.+?\}|\d+ life|\w+ \{E\})\. if you do, (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (inner) {
      const life = m[1].match(/^(\d+) life$/);
      const energy = m[1].match(/^(?:\{E\})+$/) ?? (/^\w+ \{E\}$/.test(m[1]) && wordToNumber(m[1].split(' ')[0]) !== null ? { count: wordToNumber(m[1].split(' ')[0]) as number } : null);
      return [life ? { kind: 'ifPays', cost: '', payLife: parseInt(life[1], 10), effects: inner } : energy ? { kind: 'ifPays', cost: '', energy: 'count' in energy ? energy.count : (m[1].match(/\{E\}/g) ?? []).length, effects: inner } : { kind: 'ifPays', cost: m[1], effects: inner }];
    }
  }
  // "You may tap three untapped creatures you control. If you do, Y" / "you may discard a nonland card. If you do, Y"
  if ((m = text.match(/^(?:you may )?((?:tap|discard|sacrifice|exile|return|reveal|remove) .+?)\. if you do, (.+)$/i))) {
    const cost = parseCost(m[1].replace(/^[a-z]/, (c) => c.toUpperCase()));
    // "Discard a card at random. If you do, ~ deals damage equal to that card's mana value": "that card" is what the cost moved.
    // A discarded card is only ever "that card"; a sacrificed or exiled object can be "that creature/permanent" too.
    if (cost?.discard && /\bthat card\b/i.test(m[2])) ctx.lastObj = { ref: 'lastDiscarded' };
    else if ((cost?.sacrifice || cost?.exileObjects || cost?.exileFromGraveyard) && /\bthat (?:card|creature|permanent)\b/i.test(m[2])) ctx.lastObj = { ref: 'lastMoved' };
    const inner = cost ? parseSentence(m[2], ctx) : null;
    if (cost && inner) return [{ kind: 'ifPays', cost: '', payCostSpec: cost, effects: inner, text: `${m[1]}?` }];
  }
  if ((m = text.match(/^at (?:this turn's next end of combat|the next end of combat(?: this turn)?), (.+)$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) return [{ kind: 'delayedTrigger', event: 'endOfCombat', effects: inner, text, once: true }];
  }
  if ((m = text.match(/^at the beginning of the next (?:post-?combat )?main phase(?: this turn)?, (.+)$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) return [{ kind: 'delayedTrigger', event: 'beginningOfPostcombatMain', effects: inner, text, once: true }];
  }
  if ((m = text.match(/^at the beginning of (the next end step|your next end step|that turn's end step|the next turn's upkeep|your next upkeep|the next upkeep|the next cleanup step), (.+)$/i))) {
    const inner = parseSentence(m[2], ctx);
    if (inner) {
      const upkeep = /upkeep/i.test(m[1]);
      return [{ kind: 'delayedTrigger', event: upkeep ? 'beginningOfUpkeep' : /cleanup/i.test(m[1]) ? 'cleanup' : 'beginningOfEndStep', filter: /your next/i.test(m[1]) ? { player: 'you' } : undefined, effects: inner, text, once: true }];
    }
  }
  text = text.replace(/^when you cast your next (.+?) this turn, /i, 'when you next cast $1 this turn, ');
  if ((m = text.match(/^when you next cast (.+?) this turn, (.+)$/i))) {
    const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true });
    const inner = parseSentence(m[2].replace(/\bcopy it\b/i, 'copy that spell'), sub);
    if (inner) {
      const types = /instant or sorcery/i.test(m[1]) ? ['Instant', 'Sorcery'] : /^a spell$/i.test(m[1]) ? undefined : /^an instant spell$/i.test(m[1]) ? ['Instant'] : /^a sorcery spell$/i.test(m[1]) ? ['Sorcery'] : null;
      if (types !== null) return [{ kind: 'delayedTrigger', event: 'cast', filter: { player: 'you', object: types ? { types } : undefined }, effects: inner, text, once: true }];
      const noun = parseNoun(m[1].replace(/ spells$/i, ' spell'));
      if (noun) {
        const f = { ...noun.filter };
        delete f.zone;
        return [{ kind: 'delayedTrigger', event: 'cast', filter: { player: 'you', object: f }, effects: inner, text, once: true }];
      }
    }
  }
  // "At this turn's next end of combat, X" / "At end of combat, X" on a spell.
  if ((m = text.match(/^at (?:this turn's next end of combat|the end of combat|end of combat), (.+)$/i))) {
    const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true });
    const inner = parseSentence(m[1], sub);
    if (inner) return [{ kind: 'delayedTrigger', event: 'endOfCombat', effects: inner, text, once: true }];
  }
  // "When you discard a nonland card this way, X" (same paragraph as the discard): X happens if a matching card moved.
  if ((m = text.match(/^(?:when|if) (?:you )?(discard|exile|sacrifice|reveal|mill|destroy|return) (?:a|an|one or more) (.+?) this way, (.+)$/i))) {
    const noun = parseNoun(`a ${m[2].replace(/ cards?$/i, ' card')}`);
    if (noun) {
      const saved = ctx.lastObj;
      // "If you discard a creature card this way, ~ deals damage equal to that card's power": the card just discarded.
      const moved: Ref = m[1].toLowerCase() === 'discard' ? { ref: 'lastDiscarded' } : { ref: 'lastMoved' };
      ctx.lastObj = moved;
      const inner = parseSentence(m[3], ctx);
      if (inner) return [{ kind: 'conditional', if: { kind: 'amount', a: { kind: 'countRef', ref: moved, filter: { ...noun.filter, zone: undefined } }, op: '>=', b: 1 }, then: inner }];
      ctx.lastObj = saved;
    }
  }
  if ((m = text.match(/^when (that creature|that permanent|it|that token|those creatures|target creature(?: other than ~)?|target permanent|~|the permanent you (?:do not|don't) control|the creature an opponent controls|the creature put onto the battlefield with ~) (?:dies|die|leaves the battlefield|is put into a graveyard|is put into your graveyard|dies under your control) this turn, (.+)$/i))) {
    const ref = m[1] === '~' ? SELF : objRef(m[1], ctx);
    const inner = ref ? parseSentence(m[2], ctx) : null;
    if (ref && inner) return [{ kind: 'delayedTrigger', event: /leaves the battlefield/i.test(m[0]) ? 'leavesBattlefield' : 'dies', filter: { objectRef: ref }, effects: inner, text, once: true }];
  }
  // "Whenever that creature is dealt damage this turn, ..." / "Whenever target creature deals damage this turn, ..."
  if ((m = text.match(/^when(?:ever)? (that creature|that permanent|it|those creatures|target creature(?: other than ~)?) (is dealt damage by an attacking creature|is dealt damage|deals combat damage|deals damage) this turn, (.+)$/i))) {
    const dref = objRef(m[1], ctx);
    const dinner = dref ? parseSentence(m[3], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true })) : null;
    if (dref && dinner) {
      const dealt = /is dealt damage/i.test(m[2]);
      return [{ kind: 'delayedTrigger', event: dealt ? 'dealtDamage' : 'dealsDamage', filter: { objectRef: dref, ...(/combat/i.test(m[2]) && !dealt ? { combat: true } : {}), ...(/by an attacking creature/i.test(m[2]) ? { source: { attacking: true } } : {}) }, effects: dinner, text, untilEndOfTurn: true }];
    }
  }
  // "Whenever it deals combat damage to a player this turn, ..." / "Whenever that creature attacks one of your opponents this turn, ..."
  if ((m = text.match(/^when(?:ever)? (that creature|that permanent|it|those creatures|target creature) (deals combat damage to a player|attacks one of your opponents|attacks|becomes tapped) this turn, (.+)$/i))) {
    const tref = objRef(m[1], ctx);
    const tinner = tref ? parseSentence(m[3], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true })) : null;
    if (tref && tinner) {
      const ev = /combat damage/i.test(m[2]) ? 'dealtCombatDamageToPlayer' : /attacks/i.test(m[2]) ? 'attacks' : 'tapped';
      return [{ kind: 'delayedTrigger', event: ev, filter: { objectRef: tref }, effects: tinner, text, untilEndOfTurn: true }];
    }
  }
  // "Whenever a creature dealt damage by that creature dies this turn, ..."
  if ((m = text.match(/^when(?:ever)? (?:a|an) (.+?) dealt damage by (?:that creature|it) (?:this turn )?dies this turn, (.+)$/i))) {
    const dn2 = parseNoun(`a ${m[1]}`);
    const di2 = dn2 ? parseSentence(m[2], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true })) : null;
    if (dn2 && di2) return [{ kind: 'delayedTrigger', event: 'dies', filter: { object: { ...dn2.filter, zone: undefined, damaged: true } }, effects: di2, text, untilEndOfTurn: true }];
  }
  // "When you spend this mana to cast a Dragon creature spell, ..." — approximated as a delayed cast trigger.
  if ((m = text.match(/^when (?:you spend this mana to cast|that mana is spent to cast) (?:a|an|your) (.+?), (.+)$/i))) {
    const noun209 = /^commander$/i.test(m[1]) ? { filter: { isCommander: true } as ObjectFilter, confident: true } : parseNoun(m[1].replace(/ spells?$/i, ' spell'));
    const inner209 = noun209 ? parseSentence(m[2], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true })) : null;
    if (noun209 && inner209) return [{ kind: 'delayedTrigger', event: 'cast', filter: { player: 'you', object: { ...noun209.filter, zone: undefined } }, effects: inner209, text, once: true, untilEndOfTurn: true }];
  }
  // "When you spend this mana to cast a spell or activate an ability, ..." / "When that mana is spent, ..."
  if ((m = text.match(/^when (?:you spend this mana(?: to cast a spell or activate an ability)?|that mana is spent), (.+)$/i))) {
    const inner209b = parseSentence(m[1], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true, triggerHasPlayer: true }));
    if (inner209b) return [{ kind: 'delayedTrigger', event: 'cast', filter: { player: 'you' }, effects: inner209b, text, once: true, untilEndOfTurn: true }];
  }
  // "When a creature dealt damage this way dies this turn, ..."
  if ((m = text.match(/^when(?:ever)? (?:a|an) (.+?) dealt damage this way dies this turn, (.+)$/i))) {
    const dn = parseNoun(`a ${m[1]}`);
    const di = dn ? parseSentence(m[2], newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: true })) : null;
    if (dn && di) return [{ kind: 'delayedTrigger', event: 'dies', filter: { object: { ...dn.filter, zone: undefined, damagedBySource: true } }, effects: di, text, untilEndOfTurn: true }];
  }
  // Delayed triggers: "X at the beginning of the next end step" / "…of the next turn's upkeep"
  if ((m = text.match(/^(.+?) at the beginning of (?:the next end step|your next end step|the next turn's upkeep|your next upkeep|the next upkeep)$/i))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) {
      const upkeep = /upkeep/i.test(m[0]);
      const yours = /your next/i.test(m[0]);
      return [{ kind: 'delayedTrigger', event: upkeep ? 'beginningOfUpkeep' : 'beginningOfEndStep', filter: yours ? { player: 'you' } : undefined, effects: inner, text: text, once: true }];
    }
  }
  // No-op / informational sentences
  if (isNoOpSentence(text)) return [];
  if (/^(it is still a land|it is still an? \w+|they are still lands|you may choose new targets for the cop(?:y|ies)|it cannot be regenerated|they cannot be regenerated|then shuffle|shuffle|you may choose the same mode more than once|~ can be your commander|this ability costs .+? less to activate.*|do this .+? times?|any player may activate this ability(?: but only as a sorcery)?|you may look at the top card of your library any time|you may choose not to untap ~ during your untap step|~'s power and toughness are each equal to .+|that player may .+? for as long as .+)$/i.test(text)) return [];
  if ((m = text.match(/^(.+?) unless (.+?) pays? (\{.+?\})$/i)) && !/^counter /i.test(text)) {
    // The head names the object ("Exile target attacking creature unless its controller pays {X}"), so parse it first.
    const savedT = ctx.targets.length;
    const savedLast = ctx.lastObj;
    const inner = parseSentence(m[1], ctx);
    // "Exile target attacking creature unless its controller pays {X}": the payer is the target's controller as the
    // spell resolves, not the controller of a card already in exile; "create a 3/3 Ogre unless that creature's
    // controller pays {3}" (Kazuul) means the creature in scope before the head, not the token.
    const afterHead = ctx.lastObj;
    if (inner && (ctx.lastObj?.ref === 'lastMoved' || ctx.lastObj?.ref === 'lastCreated')) ctx.lastObj = ctx.targets.length > savedT ? { ref: 'target', slot: savedT } : savedLast;
    const who = inner ? playerRef(m[2], ctx) : null;
    ctx.lastObj = afterHead;
    if (who && inner) {
      return [{ kind: 'unlessPays', who, cost: m[3], effects: inner }];
    }
    ctx.targets.length = savedT;
  }
  // "Counter that spell unless you put two cards from your graveyard on the bottom of your library."
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|an opponent) puts? (?:a|an|(\w+)) cards? from (?:their|your) graveyard on the bottom of (?:their|your) library$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (who && inner && typeof n === 'number')
      return [{ kind: 'unlessPays', who, cost: { putFromGraveyardOnBottom: n }, effects: inner, text: m[0].slice(m[1].length + 8) }];
  }
  // "~ blocks that creature this turn unless its controller has ~ deal damage to them equal to its power."
  if ((m = text.match(/^(.+?) unless (they|that player|a player|you|its controller|that creature's controller|that opponent|an opponent) has ~ deal (.+?) damage to (?:them|you|him or her)$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(/^a player$/i.test(m[2]) ? 'that player' : m[2].replace(/^that creature's controller$/i, 'its controller'), ctx);
    const dmg = amt(m[3], ctx);
    if (who && inner && dmg !== null)
      return [{ kind: 'unlessPays', who, cost: { takeDamageFromSource: dmg }, effects: inner, text: m[0].slice(m[1].length + 8) }];
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) returns? (?:a|an|another|(\w+)) (.+?)(?: (?:you|they) control)? to (?:its|their) owner'?s'? hands?$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${m[4]}`);
    const n = m[3] ? wordToNumber(m[3]) : 1;
    if (who && inner && noun && typeof n === 'number') {
      return [{ kind: 'unlessPays', who, cost: { returnToHand: noun.filter, count: n }, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) discards? (?:a|an|(\w+)) (.+?) cards?$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    const noun = parseNoun(`a ${m[4]} card`);
    if (who && inner && noun) {
      return [{ kind: 'unlessPays', who, cost: { discard: m[3] ? (wordToNumber(m[3]) as number) ?? 1 : 1, filter: noun.filter }, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) discards? (?:a card|(\w+) cards?) at random$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (who && inner) {
      return [{ kind: 'unlessPays', who, cost: { discard: m[3] ? (wordToNumber(m[3]) as number) ?? 1 : 1, random: true }, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  // "unless they sacrifice a nonland permanent of their choice or discard a card"
  // "Each opponent loses 3 life unless they discard a card or sacrifice a creature."
  // "Each opponent loses 3 life unless that player …": one decision per opponent, affecting only that opponent.
  const unlessFor = (head: string, whoText: string, mk: (who: Ref, inner: Effect[]) => Effect): Effect[] | null => {
    const each = /^each (opponent|player)$/i.exec(whoText) ?? (/^(?:they|that player)$/i.test(whoText) ? /^each (opponent|player)\b/i.exec(head) : null);
    if (each) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastPlayer = { ref: 'iter' };
      const inner = parseSentence(head.replace(/^each (?:opponent|player)/i, 'that player'), sub);
      if (!inner) return null;
      return [{ kind: 'forEach', over: /opponent/i.test(each[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: [mk({ ref: 'iter' }, inner)] }];
    }
    const saved = ctx.targets.length;
    const inner = parseSentence(head, ctx);
    const who = inner ? playerRef(whoText, ctx) : null;
    if (!inner || !who) {
      ctx.targets.length = saved;
      return null;
    }
    return [mk(who, inner)];
  };
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) discards? a card or sacrifices? (?:a|an) (.+?)(?: of (?:their|its) choice)?$/i))) {
    const noun = parseNoun(`a ${m[3]}`);
    const r = noun ? unlessFor(m[1], m[2], (who, inner) => ({ kind: 'unlessPays', who, cost: { discard: 1 }, effects: [{ kind: 'unlessPays', who, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' } }, effects: inner }] })) : null;
    if (r) return r;
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) sacrifices? (?:a|an) (.+?) of (?:their|its) choice or discards? a card$/i))) {
    const noun = parseNoun(`a ${m[3]}`);
    const r = noun ? unlessFor(m[1], m[2], (who, inner) => ({ kind: 'unlessPays', who, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' } }, effects: [{ kind: 'unlessPays', who, cost: { discard: 1 }, effects: inner }] })) : null;
    if (r) return r;
  }
  // "unless you exile the top creature card of your graveyard" / "unless you exile a card from your graveyard"
  if ((m = text.match(/^(.+?) unless you exile (?:the top (.+?) card of your graveyard|(?:a|an) (.+?) from your graveyard)$/i))) {
    const noun = parseNoun(`a ${(m[2] ?? m[3]).replace(/ card$/i, '')} card`);
    const inner = noun ? parseSentence(m[1], ctx) : null;
    if (noun && inner) return [{ kind: 'unlessPays', who: YOU, cost: { exileFromGraveyard: { ...noun.filter, zone: 'graveyard', owner: 'you' }, count: 1 }, effects: inner }];
  }
  // "unless you sacrifice two Islands" / "unless you sacrifice two lands"
  if ((m = text.match(/^(.+?) unless you sacrifice (\w+) (.+?)$/i))) {
    const n = wordToNumber(m[2]);
    const noun = parseNoun(`a ${singularize(m[3])}`);
    const inner = typeof n === 'number' && noun ? parseSentence(m[1], ctx) : null;
    if (typeof n === 'number' && noun && inner) return [{ kind: 'unlessPays', who: YOU, cost: { sacrifice: { ...noun.filter, zone: 'battlefield' }, count: n }, effects: inner }];
  }
  if ((m = text.match(/^(.+?) unless (they|that player|you|its controller|that opponent|each opponent|an opponent) (?:discards? (?:a card|(\w+) cards?)|sacrifices? (?:a|an|another) (.+?)|pays? (\d+) life)$/i))) {
    const inner = parseSentence(m[1], ctx);
    const who = playerRef(m[2], ctx);
    if (who && inner) {
      let cost: { discard: number } | { sacrifice: ObjectFilter } | { payLife: number } | null = null;
      if (m[5]) cost = { payLife: parseInt(m[5], 10) };
      else if (m[4]) {
        const noun = parseNoun(`a ${m[4]}`);
        if (!noun) cost = null;
        else cost = { sacrifice: { ...noun.filter, other: /another/i.test(m[0]) || undefined } };
      } else cost = { discard: m[3] ? (wordToNumber(m[3]) as number) ?? 1 : 1 };
      if (cost) return [{ kind: 'unlessPays', who, cost, effects: inner, text: m[0].slice(m[1].length + 8) }];
    }
  }
  // "~ deals 2 damage to that player unless they control a commander": do it unless the condition holds.
  if ((m = text.match(/^(.+?) unless (.+)$/i)) && !/^counter /i.test(text) && !/ pays? /i.test(m[2]) && !/^(?:they|that player|you|its controller|that opponent|each opponent|an opponent) (?:discards?|sacrifices?|returns?)/i.test(m[2])) {
    const cond = parseCondition(m[2].replace(/^they control/i, 'that player controls').replace(/^they have/i, 'that player has'), { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
    if (cond && cond.kind !== 'manual') {
      const saved = ctx.targets.length;
      const inner = parseSentence(m[1], ctx);
      if (inner) return [{ kind: 'conditional', if: { kind: 'not', c: cond }, then: inner }];
      ctx.targets.length = saved;
    }
  }
  if ((m = text.match(/^(you|each player|each opponent|target player|target opponent|that player|that opponent|its controller|its owner|~'s owner|that (?:creature|permanent|card|spell)'s (?:controller|owner)|each of that player's opponents|that player's opponents|defending player|the chosen player) may (.+)$/i)) && !/^you may (?:play|cast) /i.test(text)) {
    const saved = ctx.targets.length;
    const savedPlayer = ctx.lastPlayer;
    const who = playerRef(m[1], ctx);
    if (who && who.ref !== 'controller') ctx.lastPlayer = who;
    // "its controller may draw a card": the draw is that player's, so parse it with them as the subject first.
    let inner: Effect[] | null = null;
    // "Each player may draw a card": whoever says yes is the one who draws (the engine binds each such player as the iteration item).
    if (who && /^each /i.test(m[1]) && /^(?:draw|discard|gain|lose|mill|scry|surveil|sacrifice|create|search|exile the top|reveal|look at|tap|untap|put (?:a|an|\w+) [+\-\w\/]+ counters? on)\b/i.test(m[2]) && !/copy of/i.test(m[2])) {
      const afterWho = ctx.targets.length;
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastPlayer = { ref: 'iter' };
      inner = parseSentence(`that player ${m[2]}`, sub);
      // "put two +1/+1 counters on a creature they control": imperative form, the chooser follows "they".
      if (!inner && /^(?:put|tap|untap) /i.test(m[2])) inner = parseSentence(m[2], sub);
      if (inner) return [{ kind: 'may', effects: inner, who }];
      ctx.targets.length = afterWho;
    }
    if (who && who.ref !== 'controller' && !/^each /i.test(m[1])) {
      const afterWho = ctx.targets.length; // keep the subject's own target registration on rollback
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      // A "target opponent" subject is already registered: refer back to it instead of registering a second target.
      const isTarget = /^target /i.test(m[1]);
      sub.lastPlayer = isTarget ? who : savedPlayer; // otherwise the subject phrase re-resolves "that player" itself
      inner = parseSentence(`${isTarget ? 'that player' : m[1]} ${m[2]}`, sub);
      if (inner) ctx.lastObj = sub.lastObj;
      else ctx.targets.length = afterWho;
    }
    if (!inner && who) inner = parseSentence(rephraseFirstPerson(m[2]), ctx);
    if (who && inner) return [{ kind: 'may', effects: inner, who: who.ref === 'controller' ? undefined : who }];
    ctx.targets.length = saved;
    ctx.lastPlayer = savedPlayer;
  }
  if ((m = text.match(/^until (?:the end of your next turn|end of turn|your next turn), you may (?:play|cast) (.+)$/i)) && !/ as though (?:they|it) had flash$/i.test(m[1])) {
    // Narset: "… you may cast noncreature spells from among those cards without paying their mana costs."
    const free = / without paying (?:its|their) mana costs?$/i.test(m[1]);
    let body = m[1].replace(/ without paying (?:its|their) mana costs?$/i, '');
    let filter: ObjectFilter | undefined;
    const km = body.match(/^(noncreature|instant and sorcery|instant or sorcery|instant|sorcery|creature|noncreature, nonland|artifact|enchantment|nonland|permanent) (?:spells|cards) from among (those cards|them|the exiled cards)$/i);
    if (km) {
      const k = km[1].toLowerCase();
      filter = k === 'noncreature' ? { notTypes: ['Creature'] } : k === 'noncreature, nonland' ? { notTypes: ['Creature'], nonland: true } : k === 'nonland' ? { nonland: true } : k === 'permanent' ? { permanentCard: true } : /instant (?:and|or) sorcery/.test(k) ? { types: ['Instant', 'Sorcery'] } : { types: [k.charAt(0).toUpperCase() + k.slice(1)] };
      body = km[2];
    }
    const ref = objRef(body, ctx) ?? ctx.lastObj ?? { ref: 'lastMoved' as const };
    return [{ kind: 'playFromExile', what: ref, duration: playUntil(m[0].split(',')[0]), ...(free ? { free: true } : {}), ...(filter ? { filter } : {}) }];
  }
  // "If <condition>, <effects>" — the condition may itself contain commas ("If you control a God, a
  // Demigod, or a legendary enchantment, ..."), so try every split, real conditions first.
  if (/^if /i.test(text) && !/ would /i.test(text.split(',')[0])) {
    // "If target creature has toughness 5 or greater, it gets +4/-4 until end of turn" (Blood Lust): the condition
    // itself names the target, so register it and ask the condition about "that creature".
    const tm = text.match(/^if (target [\w' -]+?) ((?:has|is|isn't|is not|was|doesn't|does not|shares|cannot|can't) .+?), (.+)$/i);
    if (tm) {
      const saved = ctx.targets.length;
      const savedObj = ctx.lastObj;
      const savedPlayer = ctx.lastPlayer;
      const isPlayer = /^target (?:player|opponent)$/i.test(tm[1]);
      const ref = isPlayer ? playerRef(tm[1], ctx) : objRef(tm[1], ctx);
      if (ref) {
        if (isPlayer) ctx.lastPlayer = ref;
        else ctx.lastObj = ref;
        const noun = tm[1].replace(/^target /i, '').split(' ')[0];
        const subj = isPlayer ? 'that player' : `that ${/^(?:creature|permanent|land|artifact|enchantment|planeswalker)$/i.test(noun) ? noun : 'permanent'}`;
        const cond = parseCondition(`${subj} ${tm[2]}`, { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer, boundX: ctx.boundX });
        const inner = cond ? parseSentence(tm[3], ctx) : null;
        if (cond && inner) return [{ kind: 'conditional', if: cond, then: inner }];
        ctx.targets.length = saved;
        ctx.lastObj = savedObj;
        ctx.lastPlayer = savedPlayer;
      }
    }
    const cuts: number[] = [];
    for (let k = 3; k < text.length; k++) if (text[k] === ',') cuts.push(k);
    const rctx = { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer, boundX: ctx.boundX };
    for (const pass of [0, 1]) {
      for (const k of cuts) {
        const condText = text.slice(3, k).trim();
        const rest = text.slice(k + 1).trim();
        if (!condText || !rest) continue;
        const cond = parseCondition(condText, rctx);
        if (pass === 0 ? !cond : !!cond) continue;
        const saved = ctx.targets.length;
        const inner = parseSentence(rest, ctx);
        if (inner) return [{ kind: 'conditional', if: cond ?? { kind: 'manual', text: `Is this true: "${condText}"?` }, then: inner }];
        ctx.targets.length = saved;
      }
    }
  }
  // "<effects> if <condition>" — likewise try each " if " boundary.
  if (/ if /i.test(text) && !/^counter /i.test(text)) {
    const cuts: number[] = [];
    // ". If you do, …" is a sentence boundary, not a trailing condition ("you may exile X. If you do, gain 2 life").
    for (const mm of text.matchAll(/ if /gi)) if (mm.index !== undefined && text[mm.index - 1] !== '.') cuts.push(mm.index);
    for (const k of cuts) {
      const head = text.slice(0, k);
      const condText = text.slice(k + 4);
      const saved = ctx.targets.length;
      const inner = parseSentence(head, ctx);
      if (inner) {
        const cond = parseCondition(condText, { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject });
        return [{ kind: 'conditional', if: cond ?? { kind: 'manual', text: `Is this true: "${condText}"?` }, then: inner }];
      }
      ctx.targets.length = saved;
    }
  }
  text = text.replace(/^((?:any number of |up to \w+ |one or two |one, two, or three |\w+ )?(?:target |they|those creatures)[^,]*?) each (gets?|gains?|deals?|loses?|has|have|becomes?|cannot|can't|draws?|discards?|sacrifices?|mills?)\b/i, '$1 $2');
  // "Until end of turn, if you tap a land for mana, it produces {U} instead of any other type."
  if ((m = text.match(/^until (?:end of turn|your next turn), (if .+?|whenever .+?)$/i))) {
    const inner = parseStatic(m[1].replace(/^if (?:you|a player|an opponent) taps? (?:a|an) (.+?) for mana,/i, (_x, n: string) => `If a ${n.replace(/ you control$/i, '')} is tapped for mana,`), true);
    if (inner && inner.length && inner.every((ab) => ab.kind === 'static' ? !!ab.rule && !!ab.ruleAffects : ab.kind === 'replacement')) {
      const out: Effect[] = [];
      for (const ab of inner) {
        if (ab.kind === 'static' && ab.rule) {
          const who: Ref | undefined = ab.ruleAffects === 'opponents' ? { ref: 'eachOpponent' } : ab.ruleAffects === 'allPlayers' ? { ref: 'eachPlayer' } : undefined;
          out.push({ kind: 'grantPlayerRule', rule: ab.rule, who });
        } else if (ab.kind === 'replacement') out.push({ kind: 'grantReplacement', spec: ab });
      }
      if (out.length) return out;
    }
  }
  text = text.replace(/^until your next turn, (.+?)$/i, (_m, rest: string) => (/ until your next turn$/i.test(rest) ? rest : `${rest} until your next turn`));
  text = text.replace(/^until the end of your next turn, (.+?)$/i, (_m, rest: string) => (/ until the end of your next turn$/i.test(rest) ? rest : `${rest} until the end of your next turn`));
  // Patterns are written for "until end of turn"; retime whatever they produce. Play/cast permissions carry their own
  // duration ("you may play those cards until the end of your next turn"), so leave them to their handler.
  for (const [suffix, dur] of [[' until your next turn', 'untilYourNextTurn'], [' until end of combat', 'endOfCombat'], [' until the end of your next turn', 'untilYourNextTurn']] as const) {
    if (text.toLowerCase().endsWith(suffix) && !/^(?:you may )?(?:play|cast) (?:it|them|that card|those cards|the exiled|cards exiled|lands|up to)/i.test(text)) {
      const saved = ctx.targets.length;
      const inner = parseSentence(text.slice(0, -suffix.length) + ' until end of turn', ctx);
      if (inner) return inner.map((e) => retime(e, dur));
      ctx.targets.length = saved;
    }
  }
  text = text.replace(/^until end of turn, (.+?)$/i, (_m, rest: string) => (/ until end of turn$/i.test(rest) ? rest : /, where X is /i.test(rest) ? rest.replace(/, where X is /i, ' until end of turn, where X is ') : `${rest} until end of turn`));
  if ((m = text.match(/^(.+?), where X is ([^,]+?), (.+)$/i)) && /\bX\b/.test(m[1])) {
    // Parse the effect first so "where X is that creature's power" can see the target it just named.
    const saved = ctx.targets.length;
    const inner = parseSentence(`${m[1]}, ${m[3]}`, ctx);
    const a = inner ? amt(m[2], ctx) : null;
    if (inner && a !== null) {
      ctx.boundX = a;
      bindCountX(ctx, saved, a);
      return inner.map((e) => substituteX(e, a));
    }
    ctx.targets.length = saved;
  }
  if ((m = text.match(/^(.+?), where X is (\d+) minus (.+)$/i))) {
    const mm = m;
    const b = amt(mm[3], ctx);
    const inner = b !== null ? parseSentence(mm[1], ctx) : null;
    if (inner && b !== null) return inner.map((e) => substituteX(e, { kind: 'minus', a: parseInt(mm[2], 10), b }));
  }
  if ((m = text.match(/^(.+), where X is (.+)$/i))) {
    // "…deals X damage…, where X is the number of…" → substitute amount.
    // Fall through when either half fails: a later pattern may take the whole sentence.
    const saved = ctx.targets.length;
    const lastBefore = ctx.lastObj;
    const inner = parseSentence(m[1], ctx);
    // "~ deals X damage to any target, where X is the sacrificed creature's power / that spell's mana value": the
    // amount refers to what came before the sentence, not to the thing just damaged. Only "its …" / "that
    // creature's …" name the object the effect itself just pointed at.
    const lastAfter = ctx.lastObj;
    const itsAmt = /^its\b/i.test(m[2].trim());
    // The subject of the clause that deals X damage ("… and that creature deals X damage to you").
    const subj = m[1].match(/(?:^|,? and |, then |\. )(~|it|this creature|that creature|[^.,]+?) deals X damage\b/i)?.[1];
    if (inner && itsAmt && subj && /^(?:~|it|this creature)$/i.test(subj)) ctx.lastObj = /^it$/i.test(subj) && ctx.triggerHasObject ? { ref: 'triggerObject' } : SELF; // "~ deals X damage …, where X is its power"
    else if (inner && !itsAmt && (lastBefore || !/^that (?:creature|permanent)'s\b/i.test(m[2].trim()))) ctx.lastObj = lastBefore;
    else if (inner && !itsAmt && ctx.triggerHasObject) {
      // "put X counters on ~, where X is that creature's power" in an ETB/dies trigger: the creature that triggered it,
      // unless the sentence itself just named a target of that kind ("put X counters on target creature, where X is that creature's power").
      const word = m[2].trim().match(/^that (creature|permanent|card|spell|land|artifact|player)'s/i)?.[1];
      const desc = lastAfter?.ref === 'target' ? ctx.targets[lastAfter.slot ?? 0]?.description ?? '' : '';
      if (!(lastAfter?.ref === 'target' && word && new RegExp(word, 'i').test(desc))) ctx.lastObj = { ref: 'triggerObject' };
    }
    // Mercy Killing: "…, then creates X tokens, where X is that creature's power" — the token just created is not
    // "that creature"; the creature the sentence targeted is.
    if (inner && !itsAmt && ctx.lastObj?.ref === 'lastCreated' && ctx.targets.length > saved && /^that (?:creature|permanent)'s\b/i.test(m[2].trim())) ctx.lastObj = { ref: 'target', slot: saved };
    const a = inner ? amt(m[2], ctx) : null;
    ctx.lastObj = lastAfter;
    if (inner && a !== null) {
      ctx.boundX = a;
      bindCountX(ctx, saved, a);
      return inner.map((e) => substituteX(e, a));
    }
    ctx.targets.length = saved;
  }
  if ((m = text.match(/^for each (.+?), (.+)$/i))) {
    // "Choose any number of target creatures. For each of them, …": iterate over what was just chosen.
    if (/^(?:of )?(?:them|those (?:creatures|permanents|players|cards|targets))$/i.test(m[1]) && (ctx.lastObj || ctx.triggerBatch)) {
      const over: Ref = ctx.lastObj ?? { ref: 'triggerObjects' }; // Kambal: "Whenever one or more tokens … enter, for each of them, …"
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastObj = { ref: 'iter' };
      sub.lastPlayer = { ref: 'iter' };
      sub.anyTarget = { ref: 'iter' };
      const inner = parseSentence(m[2], sub); // "that permanent or player" / "that player" resolve to the iteration item
      if (inner) return [{ kind: 'forEach', over, effects: inner }];
    }
    const noun = parseNoun(m[1]);
    if (noun) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastObj = { ref: 'iter' };
      const inner = parseSentence(m[2].replace(/\b(that|this) (creature|permanent|player|opponent|land|card)\b/gi, 'it'), sub);
      if (inner) return [{ kind: 'forEach', over: { ref: 'all', filter: noun.filter.zone ? noun.filter : { ...noun.filter, zone: 'battlefield' } }, effects: inner }];
    }
    if (/^(opponent|player)$/i.test(m[1])) {
      const sub = newCtx({ ...ctx, targets: ctx.targets });
      sub.lastPlayer = { ref: 'iter' };
      const inner = parseSentence(m[2].replace(/\bthat (player|opponent)\b/gi, 'that player'), sub);
      if (inner) return [{ kind: 'forEach', over: /opponent/i.test(m[1]) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' }, effects: inner }];
    }
    // "For each color among permanents you control, add one mana of that color": one mana of each such color,
    // not a free choice repeated once per color.
    {
      const col = m[1].match(/^colou?r among (.+)$/i);
      if (col && /^add one mana of that colou?r$/i.test(m[2])) {
        const noun = parseNoun(col[1]);
        if (noun) return [{ kind: 'addManaPerColor', filter: { ...noun.filter, zone: noun.filter.zone ?? 'battlefield' } }];
      }
    }
    // "For each counter removed this way, ~ gets +1/+0 until end of turn": a countable quantity.
    {
      const times = amt(m[1], ctx) ?? amt(`the number of ${m[1]}`, ctx);
      if (times !== null && times !== undefined) {
        const saved = ctx.targets.length;
        const inner = parseSentence(m[2], ctx);
        if (inner) return [{ kind: 'repeat', times, effects: inner }];
        ctx.targets.length = saved;
      }
    }
  }
  for (const [re, fn] of POOL_PATTERNS) {
    const pm = text.match(re);
    if (pm) {
      const saved = ctx.targets.length;
      const r = fn(pm, ctx);
      if (r) return r;
      ctx.targets.length = saved; // a rejected pattern must not leave its target registered (Architects of Will)
    }
  }
  for (const [re, fn] of PATTERNS) {
    const mm = text.match(re);
    if (!mm) continue;
    const saved = ctx.targets.length;
    const r = fn(mm, ctx);
    if (r && process.env.COMPILER_TRACE) console.error(`[pattern] ${re.source.slice(0, 100)}  <=  ${text}`);
    if (r) return r;
    ctx.targets.length = saved;
  }
  // "you may copy ~ and may choose a new target for the copy"
  if (/ and may choose (?:a new target|new targets) for (?:the|that) copy$/i.test(text)) {
    const r = parseSentence(text.replace(/ and may choose (?:a new target|new targets) for (?:the|that) copy$/i, '. You may choose new targets for the copy'), ctx);
    if (r) return r;
  }
  // "~ deals 5 damage to that permanent or player and the damage cannot be prevented instead"
  if (/ and (?:the )?damage cannot be prevented(?: instead)?$/i.test(text)) {
    const r = parseSentence(text.replace(/ and (?:the )?damage cannot be prevented(?: instead)?$/i, ''), ctx);
    if (r) return [...r, { kind: 'turnFlag', flag: 'noPrevention' }];
  }
  // "~ cannot be countered and the damage cannot be prevented"
  if (/^~ cannot be countered and (?:the )?damage cannot be prevented$/i.test(text)) return [{ kind: 'turnFlag', flag: 'noPrevention' }];
  // "It gets an additional -1/-1 until end of turn for each Desert you control."
  if (/\b(?:gets?|get) an additional [+-]/i.test(text)) {
    const r = parseSentence(text.replace(/\b(gets?|get) an additional /i, '$1 '), ctx);
    if (r) return r;
  }
  // "Investigate X times, where X is the total number of creatures those players control."
  if ((m = text.match(/^(.+?) (twice|three times|four times|(?:\w+|X) times)(?:, where X is (.+?))?$/i)) && !/ for each /i.test(m[1])) {
    const word = m[2].toLowerCase();
    const times = word === 'twice' ? 2 : word === 'three times' ? 3 : word === 'four times' ? 4 : /^x times$/.test(word) ? (m[3] ? amt(m[3], ctx) : ('X' as Amount)) : wordToNumber(word.replace(/ times$/, ''));
    if (times !== null && times !== undefined) {
      const saved = ctx.targets.length;
      const inner = parseSentence(m[1], ctx);
      if (inner) return [{ kind: 'repeat', times: times as Amount, effects: inner }];
      ctx.targets.length = saved;
    }
  }
  // "It gets +2/+2 until end of turn and can block an additional creature this turn."
  if ((m = text.match(/^(.+?) and (can block an additional creature this turn|cannot be blocked this turn)$/i))) {
    const saved = ctx.targets.length;
    const savedObj = ctx.lastObj;
    const subj = m[1].match(/^(.+?) (?:gets?|gains?|has|have)\b/i);
    const left = parseSentence(m[1], ctx);
    // Both clauses describe the same object: reuse the target the left clause chose
    // rather than naming the subject again, which would add a second target slot.
    if (left && ctx.targets.length > saved) ctx.lastObj = { ref: 'target', slot: ctx.targets.length - 1 };
    const right = !left ? null : ctx.lastObj ? parseSentence(`it ${m[2]}`, ctx) : subj ? parseSentence(`${subj[1]} ${m[2]}`, ctx) : null;
    if (left && right) return [...left, ...right];
    ctx.lastObj = savedObj;
    ctx.targets.length = saved;
  }
  // "It is a 1/1 Spirit creature with flying in addition to its other types" → treat as "becomes".
  if ((m = text.match(/^(it|they|that creature|those creatures|~) (?:is|are) ((?:a|an) [\dX]+\/[\dX]+ .+|[\dX]+\/[\dX]+ .+)$/i))) {
    const r = parseSentence(`${m[1]} becomes ${m[2]}`, ctx);
    if (r) return r;
  }
  // "also put a +1/+1 counter on each other creature you control" → drop the connective.
  if (/^also /i.test(text)) {
    const r = parseSentence(text.replace(/^also /i, ''), ctx);
    if (r) return r;
  }
  // "you scry 2" → "scry 2"
  if ((m = text.match(/^you ((?:scry|surveil|mill|proliferate|investigate|explore|manifest|venture|amass|adapt|monstrosity|bolster|support|fateseal|clash|populate|learn|discover|incubate|connive) .*|(?:proliferate|investigate|populate|learn|connive))$/i))) {
    const r = parseSentence(m[1], ctx);
    if (r) return r;
  }
  // "each opponent sacrifices a creature for each death vote" → repeat the action once per unit.
  if ((m = text.match(/^(.+?) for each ([^,]+)$/i)) && !/^(?:draw|you gain|you lose|create|put|exile|mill|scry)\b/i.test(text)) {
    const saved = ctx.targets.length;
    const inner = parseSentence(m[1], ctx);
    const per = inner ? perEach(m[2], ctx) : null;
    if (inner && per !== null) return [{ kind: 'repeat', times: per, effects: inner }];
    ctx.targets.length = saved;
  }
  for (const [re, fn] of [...SEARCH_PATTERNS, ...REVEAL_UNTIL_PATTERNS]) {
    const sm = text.match(re);
    if (sm) {
      const saved = ctx.targets.length;
      const r = fn(sm, ctx);
      if (r) return r;
      ctx.targets.length = saved;
    }
  }
  // Compound: "A and B" / "A, then B"
  const CLAUSE_VERB = /\b(?:gets?|gains?|loses?|becomes?|deals?|draws?|discards?|sacrifices?|creates?|destroys?|exiles?|returns?|puts?|taps?|untaps?|mills?|has|have|is|are|cannot|can)\b/i;
  const splitters = [/, then /i, /\. then /i, / and then /i, /, and /i, / and /i, /, (?=(?:then )?(?:discards?|loses?|gains?|draws?|sacrifices?|mills?|creates?|exiles?|destroys?|returns?|puts?|scry|untaps?|taps?)\b)/i, /, (?=(?:up to |any number of |another |each |all |target |that |those |the |you |it |they |~)[^,]*?\b(?:gets?|gains?|loses?|becomes?|deals?|draws?|discards?|sacrifices?|creates?|destroys?|exiles?|returns?|puts?|taps?|untaps?|mills?|has|have|is|are|cannot|can)\b)/i, /, (?=(?:gets?|gains?|loses?|becomes?|has|have|is|are|cannot|can|deals?|must|doesn't|does not)\s)/i];
  const qSpans: [number, number][] = [];
  {
    let open = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '"') continue;
      if (open < 0) open = i;
      else {
        qSpans.push([open, i]);
        open = -1;
      }
    }
    if (open >= 0) qSpans.push([open, text.length]);
  }
  const inQuote = (i: number) => qSpans.some(([a, b]) => i > a && i < b);
  for (const sp of splitters) {
    // Never split inside quoted rules text ("create a token with flying and \"~ attacks each combat if able.\"").
    const g = new RegExp(sp.source, sp.flags.includes('g') ? sp.flags : `${sp.flags}g`);
    let parts: string[] = [];
    let last = 0;
    let mm: RegExpExecArray | null;
    while ((mm = g.exec(text)) !== null) {
      if (mm[0].length === 0) g.lastIndex++;
      if (mm.index <= 0 || inQuote(mm.index)) continue;
      parts.push(text.slice(last, mm.index));
      last = mm.index + mm[0].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    if (parts.length < 2) continue;
    // "A, B, and C until end of turn": the trailing duration applies to every clause.
    {
      // "… and gain indestructible until end of turn, where X is …": the X definition trails the duration.
      const dm = parts[parts.length - 1].match(/ (until end of turn|until your next turn|until end of combat)(?:, where X is .+)?$/i);
      const stative = /\b(?:gets?|gains?|becomes?|has|have|is|are|cannot|can|loses? (?:all abilities|flying|\w+))\b/i;
      if (dm && parts.length > 1 && !parts.slice(0, -1).some((x) => new RegExp(dm[1], 'i').test(x)) && parts.every((x) => stative.test(x))) {
        parts = parts.map((x, i) => (i === parts.length - 1 ? x : `${x} ${dm[1]}`));
      }
    }
    const saved = ctx.targets.length;
    const out: Effect[] = [];
    let ok = true;
    const verb = parts[0].match(/^(put|destroy|exile|return|create|tap|untap|sacrifice|counter|draw|discard|gain|lose|remove|reveal|search|mill|scry)\b/i)?.[1];
    // "Each player discards their hand, then draws seven cards": a later clause that starts with a
    // third-person verb keeps the first clause's player subject.
    const sharedSubject = parts[0].match(/^((?:target |each |that |the |another )?(?:players?|opponents?|its controller|its owner|defending player|the monarch|each other player))\b/i)?.[1] ?? null;
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      let r: Effect[] | null = null;
      if (pi > 0 && sharedSubject && /^(?:then )?(?:loses?|gains?|deals?|draws?|discards?|mills?|sacrifices?|puts?|exiles?|reveals?|shuffles?|creates?|taps?|untaps?|returns?|destroys?|search(?:es)?|scr(?:y|ies)|surveils?|investigates?|gets?)\b/i.test(p)) r = parseSentence(`${/^target /i.test(sharedSubject) ? 'that player' : sharedSubject} ${p.replace(/^then /i, '')}`, ctx);
      if (!r) r = parseSentence(p, ctx);
      if (!r && pi > 0 && verb && !/^(you|each player|each opponent|target player|target opponent|that player|those players|it|they|~|its|their)\b/i.test(p)) r = parseSentence(`${verb} ${p}`, ctx);
      // "target creature gains haste and gets +X/+0": the second clause shares the first clause's
      // subject. Reuse the target the first clause chose rather than adding a second target slot.
      if (!r && pi > 0 && /^(gets?|gains?|loses?|has|have|cannot|can|becomes?|is|deals?|must|fights?|doesn't|does not)\b/i.test(p)) {
        const subject = ctx.lastObj ?? (ctx.targets.length > saved ? ({ ref: 'target', slot: ctx.targets.length - 1 } as Ref) : null);
        if (subject) {
          const prev = ctx.lastObj;
          ctx.lastObj = subject;
          r = parseSentence(`it ${p}`, ctx);
          if (!r) ctx.lastObj = prev;
        }
      }
      if (!r) {
        ok = false;
        break;
      }
      out.push(...r);
    }
    if (ok) return out;
    ctx.targets.length = saved;
  }
  // "Target player investigates." — parse the verb phrase as if the subject were you, then retarget.
  {
    const pm = text.match(/^(target player|target opponent|each player|each opponent|that player|that opponent|the player to your (?:left|right)|its controller|its owner|each other player|any player|the monarch|defending player|the chosen player|enchanted player|they) (.+)$/i);
    if (pm) {
      const who = playerRef(pm[1], ctx);
      const DECONJUGATE: Record<string, string> = {
        investigates: 'investigate', loses: 'lose', gains: 'gain', draws: 'draw', discards: 'discard',
        mills: 'mill', scries: 'scry', surveils: 'surveil', puts: 'put', reveals: 'reveal',
        untaps: 'untap', taps: 'tap', sacrifices: 'sacrifice', skips: 'skip', takes: 'take',
        creates: 'create', exiles: 'exile', shuffles: 'shuffle', searches: 'search',
        flips: 'flip', gets: 'get', plays: 'play', casts: 'cast', attaches: 'attach', removes: 'remove',
        manifests: 'manifest', explores: 'explore', connives: 'connive', proliferates: 'proliferate',
        ventures: 'venture', returns: 'return', destroys: 'destroy', chooses: 'choose', copies: 'copy',
      };
      const vm = pm[2].match(/^(\w+)(.*)$/);
      const base = vm ? DECONJUGATE[vm[1].toLowerCase()] : undefined;
      if (who && base) {
        const saved = ctx.targets.length;
        const savedPlayer = ctx.lastPlayer;
        const inner = parseSentence(`you ${base}${vm![2]}`, ctx);
        const RETARGETABLE = new Set(['draw', 'gainLife', 'loseLife', 'setLife', 'discard', 'mill', 'millBottom', 'scry', 'surveil', 'investigate', 'treasure', 'createToken', 'shuffle', 'skipTurn', 'skipStep', 'extraTurn', 'revealHand', 'manifest', 'searchLibrary', 'exileTop', 'addPoison', 'loseAllCounters', 'ventureIntoDungeon', 'explore', 'proliferate', 'connive', 'clue', 'food', 'lookAtTop', 'handToLibrary', 'shuffleZoneIntoLibrary', 'addCounters', 'flipCoin', 'sacrifice', 'exile', 'destroy', 'returnToHand', 'moveToZone', 'tap', 'untap', 'chooseObjects', 'putIntoGraveyard']);
        if (inner && inner.length && inner.every((e) => RETARGETABLE.has(e.kind))) {
          ctx.lastPlayer = who;
          return inner.map((e) => retargetToPlayer(e, who));
        }
        ctx.targets.length = saved;
        ctx.lastPlayer = savedPlayer;
      }
    }
  }
  // "Return to your hand the creature card in your graveyard with the greatest power."
  if ((m = text.match(/^(return|put|move) (to your hand|into your hand|onto the battlefield|into your graveyard) (the .+)$/i))) {
    const saved = ctx.targets.length;
    const alt = parseSentence(`${m[1]} ${m[3]} ${m[2]}`, ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "Starting with you, each player ...": the engine already asks players in turn order.
  // "If your life total is less than your starting life total, ~ costs {X} less, where X is the
  // difference." A bare "the difference" is the gap the sentence's own condition just described.
  if (/\bthe difference\b/i.test(text) && !/difference between/i.test(text)) {
    let spelled: string | null = null;
    let md: RegExpMatchArray | null;
    if ((md = text.match(/^if (.+?) (?:is|are) (?:less|fewer) than (.+?), (.+)$/i))) spelled = `If ${md[1]} is less than ${md[2]}, ${md[3].replace(/\bthe difference\b/i, `the difference between ${md[2]} and ${md[1]}`)}`;
    else if ((md = text.match(/^if (.+?) (?:is|are) (?:greater|more) than (.+?), (.+)$/i))) spelled = `If ${md[1]} is greater than ${md[2]}, ${md[3].replace(/\bthe difference\b/i, `the difference between ${md[1]} and ${md[2]}`)}`;
    else if ((md = text.match(/^if (?:it|that creature) had power greater than (.+?), (.+)$/i))) spelled = md[2].replace(/\bthe difference\b/i, `the difference between its power and ${md[1]}`);
    else if ((md = text.match(/^if (.+?) (?:has|have) more than (\w+) cards in hand, (.+)$/i))) spelled = md[3].replace(/\bthe difference\b/i, `the difference between the number of cards in ${md[1]}'s hand and ${md[2]}`);
    if (spelled && spelled !== text) {
      const saved = ctx.targets.length;
      const alt = parseSentence(spelled, ctx);
      if (alt) return alt;
      ctx.targets.length = saved;
    }
  }
  // "When you pay this cost one or more times, put that many valor counters on ~" — the Adversary
  // cycle's follow-up to "you may pay {1}{W} any number of times".
  // "You may cast any number of the copies without paying their mana costs."
  if (/^you may cast any number of the copies without paying their mana costs$/i.test(text))
    return [{ kind: 'may', effects: [{ kind: 'castWithoutPaying', what: { ref: 'lastCreated' } }] }];
  // "When you cast ~, ... counter ~": the spell counters itself, which is the spell that triggered it.
  if (/^counter (?:~|this spell)$/i.test(text)) return [{ kind: 'counterSpell', what: { ref: 'triggerObject' } }];
  if ((m = text.match(/^any player may pay (\d+) life$/i))) return [{ kind: 'anyPlayerMay', effects: [], cost: `${m[1]} life`, prompt: `Pay ${m[1]} life?` }];
  if ((m = text.match(/^any player may pay ((?:\{[^}]+\})+)$/i))) return [{ kind: 'anyPlayerMay', effects: [], cost: m[1], prompt: `Pay ${m[1]}?` }];
  if ((m = text.match(/^when you pay (?:this|that) cost one or more times, put that many ([+\-\w\/]+) counters on (.+)$/i))) {
    const on = objRef(m[2], ctx);
    if (on) return [{ kind: 'addCounters', counter: m[1], amount: { kind: 'ctxMemory', key: 'timesPaid' }, on }];
  }
  if ((m = text.match(/^when you pay (?:this|that) cost one or more times, (.+)$/i))) {
    const saved = ctx.targets.length;
    const inner = parseSentence(m[1].replace(/\bthat many\b/gi, 'the number of times you paid this cost'), ctx);
    if (inner) return [{ kind: 'conditional', if: { kind: 'amount', a: { kind: 'ctxMemory', key: 'timesPaid' }, op: '>=', b: 1 }, then: inner }];
    ctx.targets.length = saved;
  }
  if (/^starting with (?:you|the player to your left), /i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/^starting with (?:you|the player to your left), /i, ''), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "... as you activate this ability": says when the choice happens, which is when it happens.
  if (/ as you (?:activate this ability|cast (?:this spell|~))$/i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/ as you (?:activate this ability|cast (?:this spell|~))$/i, ''), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "You gain control of it": "you" is the default subject, so retry without it.
  if (/^you [a-z]/i.test(text) && !/^you may /i.test(text)) {
    const saved = ctx.targets.length;
    const inner = parseSentence(text.replace(/^you /i, ''), ctx);
    if (inner) return inner;
    ctx.targets.length = saved;
  }
  // Flavor ability word left on a mode or line ("Gigaflare — Destroy target permanent").
  if (/^(?:he|she) /i.test(text)) {
    const inner = parseSentence(text.replace(/^(?:he|she) /i, '~ '), ctx);
    if (inner) return inner;
  }
  if ((m = text.match(/^[A-Z][^\u2014]{0,40}\u2014 (.+)$/))) {
    const inner = parseSentence(m[1], ctx);
    if (inner) return inner;
  }
  if (/ this combat$/i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/ this combat$/i, ' this turn'), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // Some patterns spell the end-of-turn duration " this turn"; try that wording last.
  if (/ until end of turn$/i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/ until end of turn$/i, ' this turn'), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "… become 2/2 creatures that are still lands": becoming a creature never removes the land type.
  if (/ that (?:are|is) still (?:a )?lands?\b/i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/ that (?:are|is) still (?:a )?lands?\b/i, ''), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "You may play the exiled card for as long as it remains exiled, and you may spend mana as
  // though it were mana of any color to cast it."
  if ((m = text.match(/^(.+?),? and (?:you|they) may spend mana as though it (?:were|was) mana of any (?:colou?r|type) to (?:cast|pay) .+$/i))) {
    const saved = ctx.targets.length;
    const inner = parseSentence(m[1], ctx);
    if (inner && setAnyMana(inner)) return inner;
    ctx.targets.length = saved;
  }
  // "Exile those tokens when ~ leaves the battlefield": the trigger trails its effect.
  if ((m = text.match(/^(.+?) (when(?:ever)? .+)$/i)) && !/^(?:if|when|whenever|until|unless|as long as)\b/i.test(text)) {
    const saved = ctx.targets.length;
    const head = parseTriggerHead(`${m[2].charAt(0).toUpperCase()}${m[2].slice(1)}, do that`);
    const inner = head && /^do that$/i.test(head.rest) ? parseSentence(m[1], ctx) : null;
    if (head && inner) {
      const mk = (h: { event: TriggerHead['event']; filter?: TriggerHead['filter'] }): Effect =>
        ({ kind: 'delayedTrigger', event: h.event, filter: h.filter, effects: inner, text, once: true });
      return [mk(head), ...(head.also ?? []).map(mk)];
    }
    ctx.targets.length = saved;
  }
  // A trigger written inside an ability's body is a delayed trigger the ability sets up:
  // "{2}{B}, {T}: Put target creature card from a graveyard onto the battlefield under your
  // control. When ~ becomes untapped or you lose control of ~, exile that creature."
  if (/^(?:When|Whenever|At the beginning)\b/i.test(text)) {
    const saved = ctx.targets.length;
    const head = parseTriggerHead(`${text.charAt(0).toUpperCase()}${text.slice(1)}`);
    if (head) {
      const sub = newCtx({ ...ctx, targets: ctx.targets, triggerHasObject: head.hasObject, triggerHasPlayer: head.hasPlayer });
      const inner = parseSentence(head.rest, sub);
      if (inner) {
        const mk = (h: { event: TriggerHead['event']; filter?: TriggerHead['filter'] }): Effect =>
          ({ kind: 'delayedTrigger', event: h.event, filter: h.filter, effects: inner, text, once: true });
        return [mk(head), ...(head.also ?? []).map(mk)];
      }
    }
    ctx.targets.length = saved;
  }
  // "Target opponent loses 3 life and puts a card from their hand on top of their library":
  // two steps in one sentence that no pattern spells out together.
  if ((m = text.match(/^(.+?) and (.+)$/i)) && !/^(?:if|when|whenever|until|unless|as long as)\b/i.test(text) && !/"/.test(text)) {
    const saved = ctx.targets.length;
    const a = parseSentence(m[1], ctx);
    let b = a ? parseSentence(m[2], ctx) : null;
    if (a && !b) {
      // "Target opponent loses 3 life and puts a card ...": the second half shares the subject.
      const sub = m[1].match(/^((?:target |each |that |the )?[~\w' -]+?) (?:loses?|gains?|loses|deals?|fights?|attacks?|blocks?|gains?|draws?|discards?|mills?|sacrifices?|puts?|exiles?|reveals?|shuffles?|creates?|taps?|untaps?|returns?|destroys?|searches)\b/i);
      if (sub) b = parseSentence(`${sub[1]} ${m[2]}`, ctx);
    }
    if (a && b) return [...a, ...b];
    ctx.targets.length = saved;
  }
  // "... and an additional 1 damage to each green creature": "additional" only relates the clauses.
  if (/ and (?:an )?additional \d+ damage to /i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/ and (?:an )?additional (\d+) damage to /i, ' and $1 damage to '), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "~ deals damage equal to its power divided as you choose among any number of target creatures"
  if ((m = text.match(/^(.+?) deals damage equal to (.+?) divided (as you choose|evenly, rounded down,) among (.+)$/i))) {
    const saved = ctx.targets.length;
    const alt = parseSentence(`${m[1]} deals X damage divided ${m[3]} among ${m[4]}, where X is ${m[2]}`, ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "White creatures get an additional +1/+1": the "additional" only relates it to another line.
  if (/ gets? an additional [+-]\d+\/[+-]\d+/i.test(text)) {
    const saved = ctx.targets.length;
    const alt = parseSentence(text.replace(/ (gets?) an additional ([+-]\d+\/[+-]\d+)/i, ' $1 $2'), ctx);
    if (alt) return alt;
    ctx.targets.length = saved;
  }
  // "You create a Food token for each player being attacked": whatever the effect is, repeat it
  // that many times. Only as a last resort — the specific "for each" patterns come first.
  if ((m = text.match(/^(.+?) for each (.+)$/i)) && !/\bthis way\b/i.test(m[2])) {
    const saved = ctx.targets.length;
    const n = amt(`the number of ${m[2]}`, ctx) ?? amt(m[2], ctx);
    const inner = n !== null ? parseSentence(m[1], ctx) : null;
    if (n !== null && inner) return [{ kind: 'repeat', times: n, effects: inner }];
    ctx.targets.length = saved;
  }
  // "~ deals 2 damage to each attacking creature or ~ deals 2 damage to each blocking creature":
  // a choice between two whole effects. Only when neither half wants a target, since a mode's
  // targets would otherwise all have to be chosen up front.
  if ((m = text.match(/^(.+?) or (.+)$/i)) && !/"/.test(text) && !/^(?:if|when|whenever|until|unless|as long as)\b/i.test(text)) {
    const saved = ctx.targets.length;
    const a = parseSentence(m[1], ctx);
    const b = a && ctx.targets.length === saved ? parseSentence(m[2], ctx) : null;
    if (a && b && ctx.targets.length === saved) {
      return [{ kind: 'chooseMode', options: [{ text: m[1], effects: a }, { text: m[2], effects: b }], count: 1 }];
    }
    ctx.targets.length = saved;
  }
  // "Choose a card name, then reveal a card at random from your hand": two steps in one
  // sentence that no pattern spells out together.
  if ((m = text.match(/^(.+?), then (.+)$/i)) && !/^(?:if|when|whenever|until|unless)\b/i.test(text)) {
    const saved = ctx.targets.length;
    const a = parseSentence(m[1], ctx) ?? parseSentence(`you ${m[1]}`, ctx);
    // "Each player discards their hand, then draws seven cards": a third-person verb after ", then"
    // keeps the first clause's subject (an imperative "then draw a card" is still you).
    const sub = m[1].match(/^((?:target |each |that |the )?[~\w' -]+?) (?:loses?|gains?|deals?|fights?|attacks?|blocks?|draws?|discards?|mills?|sacrifices?|puts?|exiles?|reveals?|shuffles?|creates?|taps?|untaps?|returns?|destroys?|searches)\b/i);
    const thirdPerson = /^(?:loses|gains|deals|fights|attacks|blocks|draws|discards|mills|sacrifices|puts|exiles|reveals|shuffles|creates|taps|untaps|returns|destroys|searches|scries|surveils|gets|has|may|can't|cannot)\b/i.test(m[2]);
    // "Target creature's controller sacrifices it, then creates …": naming the subject again would register the
    // target twice, so a subject that named a target continues as "that player".
    const subj = sub && /\btarget\b/i.test(sub[1]) && ctx.lastPlayer ? 'that player' : sub?.[1];
    let b = a && subj && thirdPerson ? parseSentence(`${subj} ${m[2]}`, ctx) : null;
    if (a && !b) b = parseSentence(m[2], ctx) ?? parseSentence(`you ${m[2]}`, ctx);
    if (a && !b) {
      // "Each player discards their hand, then returns up to three cards ...": shared subject.
      if (subj) b = parseSentence(`${subj} ${m[2]}`, ctx);
    }
    if (a && b) return [...a, ...b];
    ctx.targets.length = saved;
  }
  return null;
}

/** substituteX through nested effect lists ("if you do", "may", conditional branches). */
export function substituteXDeep(e: Effect, a: Amount): Effect {
  const out = substituteX(e, a) as unknown as Record<string, unknown>;
  for (const k of ['effects', 'then', 'else']) {
    const v = out[k];
    if (Array.isArray(v)) out[k] = (v as Effect[]).map((x) => substituteXDeep(x, a));
  }
  return out as unknown as Effect;
}

export function substituteX(e: Effect, a: Amount): Effect {
  const rep = (v: unknown): unknown => (v === 'X' ? a : v);
  const out: Record<string, unknown> = { ...e };
  for (const k of ['amount', 'power', 'toughness', 'count']) if (k in out) out[k] = rep(out[k]);
  // "unless that player pays {X}, where X is …"
  if (e.kind === 'unlessPays' && e.cost === '{X}') out.cost = { genericMana: a };
  if (e.kind === 'unlessPays' && Array.isArray(e.effects)) out.effects = e.effects.map((x) => substituteX(x, a));
  return out as unknown as Effect;
}

/** "draw a card" after "you may" is already imperative; "have ~ deal" → "~ deals". */
function rephraseFirstPerson(s: string): string {
  return s
    .replace(/^have (.+?) deal /i, '$1 deals ')
    .replace(/^have (.+?) fight /i, '$1 fights ')
    .replace(/^have (.+?) (lose|gain|draw|discard|sacrifice|mill|exile|shuffle|reveal|scry|surveil|create) /i, (_m, who: string, verb: string) => `${who} ${verb}s `);
}

function ctx0(): void {
  /* marker for patterns that need no context */
}

/** Parse a full effect text (multiple sentences). */
/** "If X is less than Y, ... equal to the difference": the gap the sentence's comparison names. */
function deriveDifference(s: string, ctx: ParseCtx): Amount | null {
  const A = (t: string): Amount | null => amt(t.trim(), ctx) ?? null;
  const pair = (a: Amount | null, b: Amount | null): Amount | null => (a !== null && b !== null ? { kind: 'difference', a, b } : null);
  let cm: RegExpMatchArray | null;
  // "If you put fewer than two lands onto the battlefield this way, ..."
  if ((cm = s.match(/\b(?:you |they )?(?:put|drew|drawn) (?:fewer|less|more) than (\w+) ([\w ]+?) (onto the battlefield|into your graveyard) this way\b/i))) {
    const n = wordToNumber(cm[1]);
    if (typeof n === 'number') return pair(n, A(`the number of ${cm[2]} you put ${cm[3]} this way`));
  }
  // "If fewer than two cards were discarded this way, ..."
  if ((cm = s.match(/\b(?:fewer|less|more) than (\w+) ([\w ]+?) (?:were|was) ([\w]+) this way\b/i))) {
    const n = wordToNumber(cm[1]);
    if (typeof n === 'number') return pair(n, A(`the number of ${cm[2]} ${cm[3]} this way`));
  }
  // "If its controller has more than four cards in hand, ..."
  if ((cm = s.match(/\b(you|they|its controller|that player|target player|target opponent) (?:has|have) (?:more|fewer|less|greater) than (\w+) cards? in (?:hand|their hand|your hand)\b/i))) {
    const n = wordToNumber(cm[2]);
    const poss = /^you$/i.test(cm[1]) ? 'your' : 'their';
    if (typeof n === 'number') return pair(A(`the number of cards in ${poss} hand`), n);
  }
  // "If they control fewer lands than you, ..."
  if ((cm = s.match(/\b(you|they|that player|target player|target opponent) controls? (?:fewer|less|more) ([\w ]+?) than (you|they|that player)\b/i))) {
    const one = /^you$/i.test(cm[1]) ? 'you control' : 'they control';
    const two = /^you$/i.test(cm[3]) ? 'you control' : 'they control';
    return pair(A(`the number of ${cm[2]} ${one}`), A(`the number of ${cm[2]} ${two}`));
  }
  // "if the amount of mana spent to cast it was less than its mana value, ..."
  if ((cm = s.match(/^(?:if )?(.+?) (?:is|are|was|were) (?:less|fewer|greater|more) than ([^,]+),/i))) return pair(A(cm[1]), A(cm[2]));
  return null;
}

/** The cost in "X unless <player> pays {2}" / "... unless they put a -1/-1 counter on a creature". */
function unlessCost(text: string, ctx: ParseCtx): Extract<Effect, { kind: 'unlessPays' }>['cost'] | null {
  const t = text.trim().replace(/[.,;]$/, '');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^pays? ((?:\{[^}]+\})+)$/i))) return m[1];
  if ((m = t.match(/^pays? (\d+) life$/i))) return { payLife: parseInt(m[1], 10) };
  if ((m = t.match(/^pays? life equal to (.+)$/i))) {
    const a = amt(m[1], ctx);
    return a === null || a === undefined ? null : { payLifeAmount: a };
  }
  if ((m = t.match(/^pays? an amount of \{E\} equal to (.+)$/i))) {
    const a = amt(m[1], ctx);
    return a === null || a === undefined ? null : { energy: a };
  }
  if ((m = t.match(/^pays? (?:mana equal to (.+)|\{1\} for each (.+))$/i))) {
    const a = amt(m[1] ?? `the number of ${m[2]}`, ctx);
    return a === null || a === undefined ? null : { genericMana: a };
  }
  if ((m = t.match(/^puts? (?:a|an|(\w+)) ([+-]\d\/[+-]\d|[\w'-]+) counters? on (?:a|an) (.+)$/i))) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const noun = parseNoun(`a ${m[3]}`);
    if (typeof n !== 'number' || !noun || !noun.confident) return null;
    return { putCounter: { counter: m[2], amount: n, filter: { ...noun.filter, zone: undefined } } };
  }
  const spec = parseCost(t.replace(/^[a-z]/, (c) => c.toUpperCase()));
  if (spec?.mana) return spec.mana;
  if (typeof spec?.payLife === 'number') return { payLife: spec.payLife };
  if (spec?.sacrifice) return { sacrifice: spec.sacrifice.filter, count: typeof spec.sacrifice.count === 'number' ? spec.sacrifice.count : 1 };
  if (spec?.discard && typeof spec.discard === 'object') return { discard: typeof spec.discard.count === 'number' ? spec.discard.count : 1 };
  return null;
}

export function parseEffects(text: string, ctx: ParseCtx): { effects: Effect[]; unhandled: string[] } {
  const effects: Effect[] = [];
  const unhandled: string[] = [];
  let m: RegExpMatchArray | null;
  // "Count the number of cards in your library. Your life total becomes that number." → inline the count.
  if ((m = text.match(/^Count (the number of [^.]+)\. (.+)$/i)) && /\bthat number\b/i.test(m[2])) text = m[2].replace(/\bthat number\b/gi, m[1]);
  // Whole-ability engine primitives.
  if (/^Exile any number of cards from your hand face down\. Put that many cards from the top of your library into your hand\. Then look at the exiled cards and put them on top of your library in any order\.?$/i.test(text.trim())) {
    return { effects: [{ kind: 'scrollRack' }], unhandled: [] };
  }
  if ((m = text.trim().match(/^you may draw (\w+) additional cards?\. If you do, choose (\w+) cards? in your hand drawn this turn\. For each of those cards, pay (\d+) life or put the card on top of your library\.?$/i))) {
    const n = wordToNumber(m[1]);
    if (typeof n === 'number' && wordToNumber(m[2]) === n) return { effects: [{ kind: 'sylvanLibrary', draws: n, life: parseInt(m[3], 10) }], unhandled: [] };
  }
  const sents = sentences(text);
  let lastStart = 0;
  let curStart = 0;
  for (let i = 0; i < sents.length; i++) {
    let s = sents[i];
    // `lastStart` is where the previous sentence's effects begin: "X. If ~ was kicked, Y instead." replaces them.
    lastStart = curStart;
    curStart = effects.length;
    // Bind "the difference" from whatever comparison this line set up (it may be a prior sentence).
    if (/\bthe difference\b/i.test(text)) {
      const d = deriveDifference(s, ctx);
      if (d) ctx.difference = d;
    }
    if (process.env.COMPILER_TRACE) console.error(`[sentence] ${s}`);
    // A sentence that failed rolls ctx.targets back; don't let a stale "last" ref
    // keep pointing at a target slot that no longer exists.
    if (ctx.lastObj?.ref === 'target' && (ctx.lastObj.slot ?? 0) >= ctx.targets.length) ctx.lastObj = null;
    if (ctx.lastPlayer?.ref === 'target' && (ctx.lastPlayer.slot ?? 0) >= ctx.targets.length) ctx.lastPlayer = null;
    // "If you cast a spell this way, you may spend mana as though it were mana of any color to
    // cast it." — a rider on the play-from-exile effect before it.
    if (/^(?:if you cast a spell this way, )?(?:you|they) may spend mana as though it (?:were|was) mana of any (?:colou?r|type) to (?:cast|pay)\b/i.test(s) && setAnyMana(effects)) continue;
    if (/^mana of any (?:colou?r|type) can be spent to (?:cast|play) (?:it|them|that spell|those spells|that card|those cards)$/i.test(s) && setAnyMana(effects)) continue;
    // "If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost."
    if (/^if you cast a spell this way, (?:you )?pay life equal to (?:its|that spell's|the spell's) mana value rather than pay(?:ing)? its mana cost$/i.test(s) && setPayLife(effects)) continue;
    // "Any player may pay 5 life. If a player does, counter ~." — the follow-up hangs off the offer.
    if ((m = s.match(/^if (?:a|any) player does, (.+?)\.?$/i))) {
      const host = [...effects].reverse().find((e) => e.kind === 'anyPlayerMay' || e.kind === 'anyPlayerMaySacrifice') as
        | (Effect & { then?: Effect[] })
        | undefined;
      if (host) {
        const inner = parseSentence(m[1], ctx);
        if (inner) {
          host.then = [...(host.then ?? []), ...inner];
          continue;
        }
      }
    }
    // "Exile it instead of putting it into a graveyard as it resolves." — a rider on the cast.
    if (/^exile (?:it|that card|them) instead of putting (?:it|them) into (?:a|its owner's|that player's|your) graveyards? as (?:it|they) resolves?$/i.test(s)) {
      const find = (list: Effect[]): Effect | null => {
        for (let k = list.length - 1; k >= 0; k--) {
          const e = list[k];
          if (e.kind === 'castFrom' || e.kind === 'playFromExile') return e;
          const nested = (e as { effects?: Effect[] }).effects;
          if (Array.isArray(nested)) { const inner = find(nested); if (inner) return inner; }
        }
        return null;
      };
      const c = find(effects);
      if (c && (c.kind === 'castFrom' || c.kind === 'playFromExile')) { c.exileAfter = true; continue; }
    }
    // "If that spell is countered this way, put it on top of its owner's library instead of into
    // that player's graveyard." — a rider on the counter before it.
    if ((m = s.match(/^if that spell (?:is countered this way|would be put into (?:a|its owner's|that player's) graveyard), put it (?:on (?:the )?(top|bottom) of (?:its owner's|that player's) library|into (?:its owner's|that player's) hand)(?: instead.*)?$/i))) {
      const to = m[1] ? (/^top$/i.test(m[1]) ? 'libraryTop' : 'libraryBottom') : 'hand';
      const find = (list: Effect[]): Extract<Effect, { kind: 'counterSpell' }> | null => {
        for (let k = list.length - 1; k >= 0; k--) {
          const e = list[k];
          if (e.kind === 'counterSpell') return e;
          const nested = (e as { effects?: Effect[] }).effects;
          if (Array.isArray(nested)) { const inner = find(nested); if (inner) return inner; }
          const thenEff = (e as { then?: Effect[] }).then;
          if (Array.isArray(thenEff)) { const inner = find(thenEff); if (inner) return inner; }
        }
        return null;
      };
      const c = find(effects);
      if (c) { c.to = to; continue; }
    }
    // "The tokens enter tapped and attacking." — a rider on the create-token effect before it.
    if ((m = s.match(/^(?:the tokens?|it) enters? (tapped and attacking|tapped|attacking)$/i))) {
      const find = (list: Effect[]): Extract<Effect, { kind: 'createToken' }> | null => {
        for (let k = list.length - 1; k >= 0; k--) {
          const e = list[k];
          if (e.kind === 'createToken') return e;
          if ((e.kind === 'forEach' || e.kind === 'repeat') && e.effects) {
            const inner = find(e.effects);
            if (inner) return inner;
          }
        }
        return null;
      };
      const tok = find(effects);
      if (tok) {
        if (/tapped/i.test(m[1])) tok.tapped = true;
        if (/attacking/i.test(m[1])) tok.attacking = true;
        continue;
      }
    }
    // "Prevent all damage … this turn. You gain life equal to the damage prevented this way."
    if (/^prevent |^the next time /i.test(s) && sents[i + 1] && /damage prevented this way/i.test(sents[i + 1])) {
      const followText = sents[i + 1].replace(/^for each 1 damage prevented this way, /i, '').replace(/\bthe damage prevented this way\b/i, 'that much');
      const saved = ctx.targets.length;
      const eff = parseSentence(s, ctx);
      const inner = eff ? parseSentence(followText, ctx) : null;
      if (eff && inner) {
        const last = eff[eff.length - 1];
        const perOne = /^for each 1 damage prevented this way, /i.test(sents[i + 1]);
        const body: Effect[] = perOne ? [{ kind: 'repeat', times: { kind: 'triggerAmount' }, effects: inner }] : inner;
        if (last.kind === 'preventAll') last.effects = body;
        else if (last.kind === 'preventDamage') eff[eff.length - 1] = { kind: 'preventAll', to: 'all', toRef: last.to, effects: body, amount: last.amount === 'all' ? undefined : typeof last.amount === 'number' ? last.amount : undefined };
        else eff.push(...body);
        effects.push(...eff);
        i++;
        continue;
      }
      ctx.targets.length = saved;
    }
    // "Repeat the following process X times." — the next sentence is the body.
    if ((m = s.match(/^repeat the following process (X|\w+) times?$/i)) && sents[i + 1]) {
      const times: Amount | null = m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as Amount | null);
      const saved = ctx.targets.length;
      const body = times !== null ? parseSentence(sents[i + 1], ctx) : null;
      if (body) {
        effects.push({ kind: 'repeat', times: times as Amount, effects: body });
        i++;
        continue;
      }
      ctx.targets.length = saved;
    }
    // "Then repeat this process X more times." — do the previous sentence again.
    if ((m = s.match(/^(?:then )?repeat this process (X|\w+) (?:more )?times?$/i)) && effects.length > 0) {
      const times: Amount | null = m[1].toUpperCase() === 'X' ? 'X' : (wordToNumber(m[1]) as Amount | null);
      // The "process" is the previous sentence's effects, or the last one produced if that
      // sentence only refined what came before ("… may discard a card. If they do not, …").
      const from = effects.length > lastStart ? lastStart : effects.length - 1;
      if (times !== null) {
        const body = effects.splice(from);
        effects.push(...body, { kind: 'repeat', times, effects: body.map((e) => structuredClone(e)) });
        curStart = from;
        continue;
      }
    }
    // "Each opponent sacrifices a creature." + "Each opponent who cannot loses 3 life."
    if ((m = s.match(/^each (?:player|opponent) who (?:cannot|can't|does not|doesn't) (.+)$/i)) && effects.length) {
      const prev = effects[effects.length - 1];
      if (prev.kind === 'sacrificeChoice' || prev.kind === 'discard') {
        const saved = ctx.targets.length;
        const inner = parseSentence(`that player ${m[1]}`, ctx) ?? parseSentence(m[1], ctx);
        if (inner) {
          const cost = prev.kind === 'sacrificeChoice' ? { sacrifice: prev.filter, count: 1 } : { discard: 1 };
          effects[effects.length - 1] = { kind: 'unlessPays', who: prev.who ?? { ref: 'eachOpponent' }, cost, effects: inner };
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    // "The tokens have \"Whenever ~ attacks, you may mill a card.\"" — a rider on the tokens just created.
    if ((m = s.match(/^(?:the tokens?|they|it) (?:has|have) "(.+)"$/i)) && effects.length) {
      const prev = effects[effects.length - 1];
      if (prev.kind === 'createToken') {
        prev.token = { ...prev.token, oracleText: prev.token.oracleText ? `${prev.token.oracleText}\n${m[1]}` : m[1] };
        continue;
      }
    }
    // "The token has enchant creature and \"Whenever ...\""
    if ((m = s.match(/^(?:the tokens?|they|it) (?:has|have) (.+)$/i)) && /"/.test(m[1]) && effects.length) {
      const prev = effects[effects.length - 1];
      const g = parseGrantList(m[1]);
      if (prev.kind === 'createToken' && g) {
        const extra = [...g.keywords.filter((k) => /^enchant /i.test(k)), ...g.abilities];
        const kws = g.keywords.filter((k) => !/^enchant /i.test(k));
        prev.token = {
          ...prev.token,
          keywords: kws.length ? [...(prev.token.keywords ?? []), ...kws] : prev.token.keywords,
          oracleText: extra.length ? [prev.token.oracleText, ...extra].filter(Boolean).join('\n') : prev.token.oracleText,
        };
        continue;
      }
    }
    // "You may repeat this process any number of times." — the whole paragraph so far loops
    // (Ad Nauseam: reveal, put into hand, lose life; Kindle the Carnage: discard, deal damage).
    if (/^(?:you may )?repeat this process any number of times$/i.test(s) && effects.length > 0) {
      const body = effects.slice(0);
      effects.length = 0;
      effects.push({ kind: 'repeatWhile', effects: body, optional: true });
      curStart = 0;
      continue;
    }
    // "Otherwise, X" completes the previous conditional, optional effect or payment.
    if (/^otherwise, /i.test(s) && effects.length) {
      // The branch this completes is usually the last effect, but may sit behind later refinements
      // ("Reveal ... . Put it into your hand. Otherwise, ...") or inside a for-each.
      const branchKinds = ['conditional', 'revealTop', 'may', 'ifPays', 'flipCoin'];
      let prev = effects[effects.length - 1];
      if (!branchKinds.includes(prev.kind)) {
        for (let k = effects.length - 1; k >= 0; k--) {
          const e = effects[k];
          if (branchKinds.includes(e.kind)) {
            prev = e;
            break;
          }
          if (e.kind === 'forEach') {
            const innerBranch = [...e.effects].reverse().find((x) => branchKinds.includes(x.kind));
            if (innerBranch) {
              prev = innerBranch;
              break;
            }
          }
        }
      }
      if (prev.kind === 'conditional' || prev.kind === 'revealTop' || prev.kind === 'may' || prev.kind === 'ifPays' || prev.kind === 'flipCoin') {
        const saved = ctx.targets.length;
        const inner = parseSentence(s.replace(/^otherwise, /i, ''), ctx);
        if (inner) {
          if (prev.kind === 'flipCoin') prev.lose = [...(prev.lose ?? []), ...inner];
          else prev.else = [...(prev.else ?? []), ...inner];
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    // Merge "You may pay X." + "If you do, Y."
    // "Tap three untapped creatures you control." + "If you do, Y." — only when the merge parses.
    if (/^(?:you may )?(?:tap|discard|sacrifice|exile|reveal|remove) /i.test(s) && sents[i + 1] && /^(?:if|when) you do, /i.test(sents[i + 1]) && !/ instead of putting it into (?:your|its owner's) graveyard as it resolves$/i.test(s)) {
      const merged = `${s}. ${sents[i + 1].replace(/^when you do, /i, 'If you do, ')}`;
      const savedT = ctx.targets.length;
      const tryIt = parseSentence(merged, ctx);
      if (tryIt) {
        effects.push(...tryIt);
        i++;
        continue;
      }
      ctx.targets.length = savedT;
    }
    // "Excess damage is dealt to that creature's controller instead." refines the damage just dealt.
    {
      const prev = effects[effects.length - 1];
      if (/^excess damage is dealt to that creature's controller instead$/i.test(s) && prev && prev.kind === 'damage') {
        (prev as { excessToController?: boolean }).excessToController = true;
        continue;
      }
    }
    // "Each opponent attacking that player does the same." repeats what the sentence before did.
    {
      const same = s.match(/^each (?:opponent|player)(?: attacking that player)? does the same$/i);
      if (same && effects.length) {
        effects.push({ kind: 'forEach', over: { ref: 'eachOpponent' }, effects: [effects[effects.length - 1]] });
        continue;
      }
    }
    // "If ~ was kicked, create twelve of those tokens instead." replaces the creation just made.
    {
      const kick = s.match(/^if ~ was kicked, create (\w+) of those tokens instead$/i);
      const prev = effects[effects.length - 1];
      if (kick && prev && prev.kind === 'createToken') {
        const n = wordToNumber(kick[1]);
        if (typeof n === 'number') {
          effects[effects.length - 1] = { kind: 'conditional', if: { kind: 'wasKicked' }, then: [{ ...prev, count: n }], else: [prev] };
          continue;
        }
      }
    }
    // "Create a token. The token enters tapped and attacking." refines the creation just made.
    {
      const ta = s.match(/^(?:the token|the tokens|it|they|[A-Z][\w' ,-]*) enters? (tapped and attacking|tapped|attacking)(?: that player)?$/i);
      const prev = effects[effects.length - 1];
      const refineTarget = prev && prev.kind === 'forEach' ? [...prev.effects].reverse().find((e) => e.kind === 'createToken' || e.kind === 'populate') : prev;
      if (ta && refineTarget && (refineTarget.kind === 'createToken' || refineTarget.kind === 'populate' || refineTarget.kind === 'returnToBattlefield')) {
        if (/tapped/i.test(ta[1])) (refineTarget as { tapped?: boolean }).tapped = true;
        if (/attacking/i.test(ta[1])) (refineTarget as { attacking?: boolean }).attacking = true;
        continue;
      }
      if (ta && prev && (prev.kind === 'createToken' || prev.kind === 'populate' || prev.kind === 'returnToBattlefield')) {
        if (/tapped/i.test(ta[1])) (prev as { tapped?: boolean }).tapped = true;
        if (/attacking/i.test(ta[1])) (prev as { attacking?: boolean }).attacking = true;
        continue;
      }
    }
    // "That player may pay {2}." + "If they do, Y." (+ "Otherwise, Z.")
    {
      const pm = s.match(/^(that player|target player|target opponent|each opponent|each player|any player|any opponent|they|its controller) may pay ((?:\{[^}]+\})+|\d+ life)$/i);
      const nxt = pm && sents[i + 1]?.match(/^if (?:they|that player|the player|a player|any player|an opponent) (do(?:es)?(?: not|n't)?), (.+)$/i);
      if (pm && nxt) {
        const who = /^any (?:player|opponent)$/i.test(pm[1]) ? ({ ref: 'eachPlayer' } as Ref) : playerRef(pm[1], ctx);
        const saved = ctx.targets.length;
        const inner = who ? parseSentence(nxt[2], ctx) : null;
        if (who && inner) {
          const negative = /not|n't/i.test(nxt[1]);
          const els = !negative ? sents[i + 2]?.match(/^otherwise, (.+)$/i) : null;
          const elseE = els ? parseSentence(els[1], ctx) : null;
          const lm = pm[2].match(/^(\d+) life$/i);
          const cost = lm ? { payLife: parseInt(lm[1], 10) } : pm[2];
          effects.push(negative ? { kind: 'unlessPays', who, cost, effects: inner } : { kind: 'unlessPays', who, cost, effects: elseE ?? [], thenEffects: inner });
          i += elseE ? 2 : 1;
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    if ((/^(?:you may )?pay/i.test(s) || /, pay (?:\{[^}]+\})+$/i.test(s)) && sents[i + 1] && /^(?:if|when) you do, |^if you (?:do not|don't), /i.test(sents[i + 1])) {
      s = `${s}. ${sents[i + 1].replace(/^when you do, /i, 'If you do, ')}`;
      i++;
    }
    // "Reveal the top card of your library. If it is a permanent card, A. Otherwise, B."
    if (/^reveal the top card of your library$/i.test(s) && sents[i + 1] && /^if it is (?:not )?(?:a|an) .+? card(?: with [^,]+?)?, /i.test(sents[i + 1])) {
      // "If it is not a creature card, put it into your graveyard. Otherwise, put that card onto the battlefield" (Impromptu
      // Raid) swaps the branches; "If it is a land card, put it into your graveyard and repeat this process" (Countryside
      // Crusher) keeps revealing while the card matches.
      const cm = sents[i + 1].match(/^if it is (not )?(?:a|an) (.+? card(?: with [^,]+?)?), (.+?)(,? and repeat this process)?$/i)!;
      const noun = parseNoun(`a ${cm[2]}`);
      const sub = { ...ctx, lastObj: { ref: 'lastMoved' } as Ref };
      const thenE = noun ? parseSentence(cm[3], sub) : null;
      let elseE: Effect[] | null = null;
      let used = 1;
      if (thenE && sents[i + 2] && /^otherwise, /i.test(sents[i + 2])) {
        elseE = parseSentence(sents[i + 2].replace(/^otherwise, /i, ''), sub);
        if (elseE) used = 2;
      }
      if (noun && thenE) {
        const reveal: Effect = cm[1] ? { kind: 'revealTop', ifMatches: noun.filter, then: elseE ?? [], else: thenE, destination: 'stay' } : { kind: 'revealTop', ifMatches: noun.filter, then: thenE, else: elseE ?? undefined, destination: 'stay' };
        effects.push(cm[4] ? { kind: 'repeatWhile', effects: [reveal], condition: { kind: 'objectMatches', ref: { ref: 'lastMoved' }, filter: noun.filter }, checkAfter: true, max: 50 } : reveal);
        i += used;
        continue;
      }
    }
    if (/^reveal cards from the top of your library until you reveal /i.test(s) && sents[i + 1] && /^(put|you may put) /i.test(sents[i + 1])) {
      let merged = `${s}. ${sents[i + 1]}`;
      let used = 1;
      if (sents[i + 2] && /^(put the rest|and the rest)/i.test(sents[i + 2])) {
        merged = `${merged}. ${sents[i + 2]}`;
        used = 2;
      }
      // Prefer the single merged effect; otherwise leave the sentences apart so the held-pool patterns handle them.
      if (parseSentence(merged, newCtx({ ...ctx, targets: [...ctx.targets] }))) {
        s = merged;
        i += used;
      }
    }
    // "Search your library for a basic land card. Put it onto the battlefield tapped, then shuffle."
    if (/^search your library for (?:a|an|up to \w+|\w+) [^,]+$/i.test(s) && sents[i + 1] && /^(?:reveal (?:it|them|that card|those cards), )?(?:put|you may put) (?:it|them|that card|those cards) /i.test(sents[i + 1])) {
      const merged = parseSentence(`${s}, ${lc(sents[i + 1])}`, ctx);
      if (merged) {
        effects.push(...merged);
        i++;
        continue;
      }
    }
    // Merge "Reveal the top N cards of your library" with its follow-up sentences.
    if (/^reveal the top (?:\w+|X) cards of your library$/i.test(s)) {
      let j = i + 1;
      let merged = s;
      while (sents[j] && /^(you may put|put (?:all|any number|a |an |up to|the rest)|and the rest)/i.test(sents[j])) {
        merged = `${merged}. ${sents[j]}`;
        j++;
      }
      const probe = newCtx({ ...ctx, targets: [...ctx.targets] });
      if (j > i + 1 && parseSentence(merged, probe)) {
        s = merged;
        i = j - 1;
      }
    }
    // Merge "Look at the top N cards…" with its follow-up sentences.
    let whereX = '';
    const lw = s.match(/^(look at the top X cards of your library), where X is (.+)$/i);
    if (lw) {
      s = lw[1];
      whereX = lw[2];
    }
    if (/^look at the top (?:\w+|X) cards of your library$/i.test(s)) {
      let j = i + 1;
      let merged = s;
      while (sents[j] && /^(you may reveal|you may put|put (?:one|two|three|up to|any number|the rest|the other|a |an |it|them)|reveal (?:a|an|up to)|then put|and the rest)/i.test(sents[j])) {
        merged = `${merged}. ${sents[j].replace(/\bthe other\b/i, 'the rest').replace(/\bone of those cards\b/i, 'one of them').replace(/on the bottom of your library$/i, 'on the bottom of your library in a random order')}`;
        j++;
      }
      if (whereX) merged = `${merged}, where X is ${whereX}`;
      // Prefer the single merged effect; otherwise fall back to a held pool + compositional follow-up sentences.
      const probe = newCtx({ ...ctx, targets: [...ctx.targets] });
      if (j > i + 1 && parseSentence(merged, probe)) {
        s = merged;
        i = j - 1;
      } else {
        // "Look at the top X cards… You may put … from among them onto the battlefield, where X is your life total."
        if (!whereX && /top X cards/i.test(s)) {
          for (let k = i + 1; k < sents.length; k++) {
            const wm = sents[k].match(/^(.+), where X is (.+?)\.?$/i);
            if (wm) {
              whereX = wm[2];
              sents[k] = wm[1];
              break;
            }
          }
        }
        if (whereX) s = `${s}, where X is ${whereX}`;
      }
    }
    if (/^reveal the top card of your library$/i.test(s) && sents[i + 1] && /^if it is /i.test(sents[i + 1])) {
      s = `${s}. ${sents[i + 1]}`;
      i++;
      if (sents[i + 1] && /^otherwise, /i.test(sents[i + 1])) {
        s = `${s}. ${sents[i + 1]}`;
        i++;
      }
    }
    // "You get {E}{E}, then you may pay eight {E}. When you do, X": X happens only if the whole amount was paid.
    {
      const lastE = effects[effects.length - 1];
      if (/^(?:if|when) you do, /i.test(s) && lastE && lastE.kind === 'payEnergy') {
        const inner = parseSentence(s.replace(/^(?:if|when) you do, /i, ''), ctx);
        if (inner) {
          // "one or more {E} … deals that much damage": "that much" is the energy paid.
          const paid: Amount = { kind: 'ctxMemory', key: lastE.key };
          const body = lastE.max >= 99 ? (JSON.parse(JSON.stringify(inner).replace(/\{"kind":"triggerAmount"\}/g, JSON.stringify(paid))) as Effect[]) : inner;
          effects.push({ kind: 'conditional', if: { kind: 'amount', a: paid, op: '>=', b: lastE.max >= 99 ? 1 : lastE.max }, then: body });
          continue;
        }
      }
      // "You may cast it without paying its mana cost. If you don't, put it into your hand" (Breaching Dragonstorm, Djinn of Wishes):
      // the cast happens as this resolves, so "don't" is known right away.
      {
        const lastC = effects[effects.length - 1];
        const castKinds = new Set(['castWithoutPaying', 'castFrom']);
        const hasCast = (list: Effect[]): boolean => list.some((e) => castKinds.has(e.kind) || (e.kind === 'may' && !e.else?.length && hasCast(e.effects)) || (e.kind === 'conditional' && hasCast(e.then) && !e.else?.length));
        const isCast = lastC && (castKinds.has(lastC.kind) || ((lastC.kind === 'may' || lastC.kind === 'conditional') && hasCast([lastC])));
        if (/^if you (?:don't|do not), /i.test(s) && isCast) {
          const inner = parseSentence(s.replace(/^if you (?:don't|do not), /i, ''), ctx);
          if (inner) {
            effects.push({ kind: 'conditional', if: { kind: 'amount', a: { kind: 'ctxMemory', key: 'acceptedCount' }, op: '==', b: 0 }, then: inner });
            continue;
          }
        }
      }
      // "You may sacrifice a creature. If you do, X. If you don't, Y" (Crovax, Entrails Feaster): Y is the cost block's else branch.
      {
        const lastP = effects[effects.length - 1];
        if (/^if you (?:don't|do not), /i.test(s) && lastP && lastP.kind === 'ifPays' && !lastP.else?.length) {
          const inner = parseSentence(s.replace(/^if you (?:don't|do not), /i, ''), ctx);
          if (inner) {
            lastP.else = inner;
            continue;
          }
        }
        // "That player sacrifices a creature of their choice. If the player can't, they lose 5 life." (Cruel Reality): the
        // sacrifice records what was given up, so "can't" is "fewer than asked were sacrificed".
        if (/^if (?:the player|they|that player) (?:can't|cannot), /i.test(s) && lastP && lastP.kind === 'sacrificeChoice' && typeof lastP.count === 'number') {
          const inner = parseSentence(s.replace(/^if (?:the player|they|that player) (?:can't|cannot), /i, ''), ctx);
          if (inner) {
            effects.push({ kind: 'conditional', if: { kind: 'amount', a: { kind: 'countRef', ref: { ref: 'lastMoved' } }, op: '<', b: lastP.count }, then: inner });
            continue;
          }
        }
        // "Sacrifice a creature. If you can't, sacrifice this artifact." (Eldrazi Monument): the forced sacrifice needs a candidate.
        if (/^if you (?:can't|cannot), /i.test(s) && lastP && lastP.kind === 'sacrificeChoice' && typeof lastP.count === 'number' && (!lastP.who || lastP.who.ref === 'controller')) {
          const inner = parseSentence(s.replace(/^if you (?:can't|cannot), /i, ''), ctx);
          if (inner) {
            effects.pop();
            effects.push({ kind: 'conditional', if: { kind: 'count', filter: { ...lastP.filter, controller: 'you', zone: 'battlefield' }, op: '>=', value: lastP.count }, then: [lastP], else: inner });
            continue;
          }
        }
      }
      // "Remove a pupa counter from ~. If you can't, sacrifice it, …" (Cocoon): the removal only happens when a counter is there.
      const lastR = effects[effects.length - 1];
      if (/^if you (?:can't|cannot), /i.test(s) && lastR && lastR.kind === 'removeCounters' && typeof lastR.amount === 'number' && lastR.counter !== 'any') {
        const inner = parseSentence(s.replace(/^if you (?:can't|cannot), /i, ''), ctx);
        if (inner) {
          effects.pop();
          effects.push({ kind: 'conditional', if: { kind: 'hasCounter', ref: lastR.on, counter: lastR.counter, op: '>=', value: lastR.amount }, then: [lastR], else: inner });
          continue;
        }
      }
      // "You may reveal it and put it into your hand. If you don't put the card into your hand, you may put it into your
      // graveyard" (Archghoul of Thraben) / "If you didn't put a card into your hand this way" / "If you don't cast it".
      {
        const nd = s.match(/^if you (?:don't|do not|didn't|did not) (?:put (?:the|that|a) card (?:into your hand|onto the battlefield)(?: this way)?|put it (?:into your hand|onto the battlefield)|cast (?:it|that card|a spell this way|a card this way)|reveal (?:it|a card)), (.+)$/i);
        if (nd && /"kind":"(?:may|ifPays)"/.test(JSON.stringify(effects))) {
          const inner = parseSentence(nd[1], ctx);
          if (inner) {
            effects.push({ kind: 'conditional', if: { kind: 'amount', a: { kind: 'ctxMemory', key: 'acceptedCount' }, op: '==', b: 0 }, then: inner });
            continue;
          }
        }
      }
      // "any player may …. If a player does, X" / "If no one does, X" / "If the player does, X" / "If that player doesn't, X"
      {
        const pd = s.match(/^if (a player|any player|no one|no player|the player|that player|they) (does|do|does not|doesn't|do not|don't)(?:,| then) (.+)$/i);
        const hadMay = pd && /"kind":"(?:may|anyPlayerMay)"/.test(JSON.stringify(effects));
        // A positive "If they do, X" right after a "may" is merged into that block by the handlers below; take the rest here.
        const lastIsMay = effects[effects.length - 1]?.kind === 'may';
        const negative = pd ? /not|n't/i.test(pd[2]) : false;
        const anyoneForm = pd ? /^(?:a|any) player|no one|no player/i.test(pd[1]) : false;
        if (pd && hadMay && (anyoneForm || negative || !lastIsMay)) {
          const inner = parseSentence(pd[3], ctx);
          if (inner) {
            const anyone = /^(?:a|any) player|no one|no player/i.test(pd[1]);
            const yes = /^(?:does|do)$/i.test(pd[2]) !== /^no /i.test(pd[1]);
            const a: Amount = { kind: 'ctxMemory', key: anyone ? 'acceptedTotal' : 'acceptedCount' };
            effects.push({ kind: 'conditional', if: yes ? { kind: 'amount', a, op: '>=', b: 1 } : { kind: 'amount', a, op: '==', b: 0 }, then: inner });
            continue;
          }
        }
      }
      // "Pay {E}{E}. If you can't, return ~ to its owner's hand and you get {E}." (Greenbelt Rampager)
      const pe = s.match(/^pay ((?:\{E\})+)$/i);
      if (pe && sents[i + 1] && /^if you (?:can't|cannot), /i.test(sents[i + 1])) {
        const inner = parseSentence(sents[i + 1].replace(/^if you (?:can't|cannot), /i, ''), ctx);
        if (inner) {
          effects.push({ kind: 'unlessPays', who: YOU, cost: { energy: (pe[1].match(/\{E\}/g) ?? []).length }, effects: inner });
          i++;
          continue;
        }
      }
      // "… you may put it onto the battlefield. If you do, repeat this process." (Primal Surge): loop the paragraph while accepted.
      if (/^if you do, repeat this process$/i.test(s) && effects.length > 0) {
        const body = effects.splice(0);
        effects.push({ kind: 'repeatWhile', effects: body, condition: { kind: 'amount', a: { kind: 'ctxMemory', key: 'acceptedCount' }, op: '>=', b: 1 }, checkAfter: true });
        curStart = 0;
        continue;
      }
    }
    // Flip a coin. If you win the flip, X. If you lose the flip, Y.
    if (/^flip a coin$/i.test(s)) {
      const win = sents[i + 1]?.match(/^if you win the flip, (.+)$/i);
      const lose = sents[i + 2]?.match(/^if you lose the flip, (.+)$/i);
      if (win) {
        const w = parseSentence(win[1], ctx);
        const l = lose ? parseSentence(lose[1], ctx) : [];
        if (w && l) {
          effects.push({ kind: 'flipCoin', win: w, lose: l });
          i += lose ? 2 : 1;
          continue;
        }
      }
    }
    // Rounding instructions apply to every "half" amount in the text.
    if (/^round (up|down) each time$/i.test(s)) {
      const round = /up/i.test(s) ? 'up' : 'down';
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (o.kind === 'half') o.round = round;
          Object.values(o).forEach(walk);
        }
      };
      walk(effects);
      continue;
    }
    // "Search your library for two cards. Put one into your hand and the other into your graveyard, then shuffle."
    if (/^search your library for (?:two|\w+) cards$/i.test(s) && sents[i + 1] && /^put one into your hand and the other /i.test(sents[i + 1])) {
      const merged = parseSentence(`${s}, ${lc(sents[i + 1])}`, ctx);
      if (merged) {
        effects.push(...merged);
        i++;
        continue;
      }
    }
    // "If that spell is countered this way, exile it instead of putting it into its owner's graveyard."
    if (/^if that spell is countered this way, exile it instead/i.test(s) || /^if that spell would be put into (?:a|their|its owner's|that player's) graveyard(?: this way)?, exile it instead$/i.test(s)) {
      const last = effects[effects.length - 1];
      if (last && last.kind === 'counterSpell') {
        last.exileInstead = true;
        continue;
      }
    }
    // "Do X. If you do, Y." — the follow-up belongs to the optional effect just made.
    {
      const fu = s.match(/^if (?:you|the player|that player|they) do(?:es)?, (.+)$/i);
      const prev = effects[effects.length - 1];
      if (fu && prev && (prev.kind === 'may' || prev.kind === 'ifPays')) {
        const saved = ctx.targets.length;
        const savedPlayer = ctx.lastPlayer;
        // "If the player does, …": the player is whoever was offered the choice.
        if (!/^you do/i.test(fu[0]) && prev.who) ctx.lastPlayer = prev.who;
        const inner = parseSentence(fu[1], ctx);
        if (inner) {
          prev.effects = [...prev.effects, ...inner];
          continue;
        }
        ctx.lastPlayer = savedPlayer;
        ctx.targets.length = saved;
      }
    }
    // "Discard a card. If you do, draw a card" (Yuna's Decision): after a mandatory action, "if you do" means it happened.
    {
      const fu2 = s.match(/^if you do, (.+)$/i);
      const prev = effects[effects.length - 1];
      const movers = new Set(['discard', 'exile', 'exileChoice', 'sacrifice', 'sacrificeChoice', 'destroy', 'returnToHand', 'moveToZone', 'mill', 'searchLibrary', 'putIntoHand', 'removeCounters', 'returnToBattlefield']);
      if (fu2 && prev && movers.has(prev.kind)) {
        const saved = ctx.targets.length;
        const inner = parseSentence(fu2[1], ctx);
        if (inner) {
          const ref: Ref = prev.kind === 'discard' ? { ref: 'lastDiscarded' } : { ref: 'lastMoved' };
          effects.push(prev.kind === 'removeCounters' ? { kind: 'conditional', if: { kind: 'amount', a: { kind: 'ctxMemory', key: 'acceptedCount' }, op: '>=', b: 1 }, then: inner } : { kind: 'conditional', if: { kind: 'amount', a: { kind: 'countRef', ref }, op: '>=', b: 1 }, then: inner });
          continue;
        }
        ctx.targets.length = saved;
      }
    }
    // "Do X. If <condition>, repeat this process." — loop the previous sentence's effects.
    {
      const rp = s.match(/^(?:if (.+?), )?repeat this process(?: once| any number of times| again)?$/i);
      if (rp && effects.length > lastStart) {
        const cond = rp[1] ? parseCondition(rp[1], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer }) : { kind: 'manual' as const, text: 'Repeat this process?' };
        if (cond) {
          const previous = effects.slice(lastStart);
          effects.push({ kind: 'repeatWhile', condition: cond, effects: previous, max: /once/i.test(s) ? 1 : 50 });
          continue;
        }
      }
    }
    // "X. If ~ was kicked, Y instead." → if kicked, Y; otherwise X.
    s = s.replace(/^if (.+?), instead (.+)$/i, 'If $1, $2 instead');
    if ((m = s.match(/^(.+?) instead if (.+)$/i)) && effects.length > lastStart && !/ would /i.test(m[2])) s = `If ${m[2]}, ${m[1]} instead`;
    if ((m = s.match(/^if (.+?), (.+?) instead$/i)) && effects.length > lastStart && !/ would /i.test(m[1])) {
      const cond = parseCondition(m[1], { self: SELF, lastObj: ctx.lastObj, triggerHasObject: ctx.triggerHasObject, lastPlayer: ctx.lastPlayer, triggerHasPlayer: ctx.triggerHasPlayer });
      let inner = cond && cond.kind !== 'manual' ? parseSentence(m[2], ctx) : null;
      // "~ deals 5 damage instead": same targets as the previous damage effect, new amount.
      const dm = !inner && m[2].match(/^(?:~|it|.+?) deals (\w+|X) damage$/i);
      if (dm && cond && cond.kind !== 'manual') {
        const n = wordToNumber(dm[1]);
        const prev = effects.slice(lastStart);
        if (n !== null && prev.some((e) => e.kind === 'damage')) inner = prev.map((e) => (e.kind === 'damage' ? { ...e, amount: n } : e));
      }
      // "create three of those tokens instead": the same token with a different count.
      const tk = !inner && m[2].match(/^create (\w+|X) of (?:those|these) tokens$/i);
      if (tk && cond && cond.kind !== 'manual') {
        const n = tk[1].toUpperCase() === 'X' ? ('X' as const) : wordToNumber(tk[1]);
        const prev = effects.slice(lastStart);
        if (n !== null && prev.some((e) => e.kind === 'createToken')) inner = prev.map((e) => (e.kind === 'createToken' ? { ...e, count: n } : e));
      }
      // "~ deals twice that much damage instead" / "draw twice that many cards instead": scale the previous amount.
      const mult = !inner && m[2].match(/^(?:.+? )?deals (twice|three times|half) that much damage$/i);
      if (mult && cond && cond.kind !== 'manual') {
        const prev = effects.slice(lastStart);
        const f = /twice/i.test(mult[1]) ? 2 : /three/i.test(mult[1]) ? 3 : 0.5;
        if (prev.some((e) => e.kind === 'damage')) {
          inner = prev.map((e) => (e.kind === 'damage' ? { ...e, amount: f === 0.5 ? { kind: 'half' as const, a: e.amount, round: 'down' as const } : { kind: 'times' as const, a: f, b: e.amount } } : e));
        }
      }
      if (cond && inner) {
        const previous = effects.splice(lastStart);
        // "Target creature gets -1/-1 until end of turn. That creature gets -4/-4 instead if …": the replacement
        // keeps the duration the sentence it replaces had (Festering Newt).
        const prevDur = (kind: string) => previous.find((e): e is Extract<Effect, { kind: 'pump' | 'grantKeywords' }> => e.kind === kind && 'duration' in e)?.duration;
        inner = inner.map((e) => ((e.kind === 'pump' || e.kind === 'grantKeywords') && e.duration === 'permanent' && prevDur(e.kind) && prevDur(e.kind) !== 'permanent' ? { ...e, duration: prevDur(e.kind) } : e));
        effects.push({ kind: 'conditional', if: cond, then: inner, else: previous });
        continue;
      }
    }
    // "If a spell cast this way would be put into a graveyard, exile it instead."
    if (/^if (?:a spell cast this way|that spell|it) would be put into (?:a|your|its owner's) graveyard(?: this way)?, exile it instead$/i.test(s)) {
      const last = effects[effects.length - 1];
      if (last && (last.kind === 'castFrom' || last.kind === 'castWithoutPaying')) {
        last.exileAfter = true;
        continue;
      }
      if (last && last.kind === 'may' && last.effects.some((x) => x.kind === 'castFrom' || x.kind === 'castWithoutPaying')) {
        for (const x of last.effects) if (x.kind === 'castFrom' || x.kind === 'castWithoutPaying') x.exileAfter = true;
        continue;
      }
    }
    // "X is the mana value of the exiled card." defines X for the effects before it.
    if ((m = s.match(/^X is (.+)$/i)) && effects.length) {
      const a = amt(m[1], ctx);
      if (a !== null) {
        for (let k = 0; k < effects.length; k++) effects[k] = substituteX(effects[k], a);
        continue;
      }
    }
    // "If you don't, X" after a "you may ..." sentence is the optional block's else branch.
    if (/^if (?:you|they) (?:do not|don't), /i.test(s) && effects.length) {
      const last = effects[effects.length - 1];
      const inner = last && last.kind === 'may' ? parseSentence(s.replace(/^if (?:you|they) (?:do not|don't), /i, ''), ctx) : null;
      if (inner && last && last.kind === 'may') {
        last.else = [...(last.else ?? []), ...inner];
        continue;
      }
    }
    // "If you do, X" / "When you do, X" after a "you may ..." sentence belongs inside the optional block.
    if (/^(?:if|when) (?:you|they) do, /i.test(s) && effects.length) {
      const inner = parseSentence(s.replace(/^(?:if|when) (?:you|they) do, /i, ''), ctx);
      if (inner) {
        const last = effects[effects.length - 1];
        if (last && last.kind === 'may') last.effects.push(...inner);
        else effects.push(...inner);
        continue;
      }
    }
    // Feather: "exile that card instead … as it resolves. If you do, return it to your hand at the beginning of the next end step."
    // Marking the spell always succeeds, so the follow-up is unconditional.
    {
      const last = effects[effects.length - 1];
      if (/^if you do, /i.test(s) && last && last.kind === 'setMemory' && last.key === 'exileOnResolve') s = s.replace(/^if you do, /i, '');
    }
    // "Each player chooses a creature they control. Destroy the rest." — everything matching the choice's filter that wasn't chosen.
    {
      const rm = s.match(/^(destroy|exile|sacrifice) the rest$/i);
      const last = effects[effects.length - 1];
      if (rm && last && last.kind === 'chooseObjects' && last.key) {
        const { controllerRef: _cr, ...base } = last.filter;
        void _cr;
        const rest: Ref = { ref: 'all', filter: { ...base, zone: base.zone ?? 'battlefield', notChosenKey: last.key } };
        const act = rm[1].toLowerCase();
        effects.push(act === 'destroy' ? { kind: 'destroy', what: rest } : act === 'exile' ? { kind: 'exile', what: rest } : { kind: 'sacrifice', what: rest });
        continue;
      }
    }
    // "Destroy all creatures. They can't be regenerated." — the second sentence qualifies the first.
    if (/^(?:it|they|that (?:creature|permanent)|those (?:creatures|permanents)|(?:a|any) (?:creature|permanent|artifact|enchantment|land)s? destroyed this way|(?:creatures|permanents) destroyed this way) cannot be regenerated(?: this turn)?$/i.test(s)) {
      let marked = false;
      for (let k = lastStart; k < effects.length; k++) {
        const e = effects[k];
        if (e.kind === 'destroy') {
          e.cantRegenerate = true;
          marked = true;
        }
      }
      if (marked) {
        curStart = lastStart; // the rider adds no effects: a following "If …, instead …" still replaces the destroy
        continue;
      }
    }
    let r = parseSentence(s, ctx);
    // "For as long as ~ remains on the battlefield, that creature gets +2/+2" — the duration reads
    // the same trailing the clause it modifies, which is the form the patterns know.
    if (!r && (m = s.match(/^((?:for as long as|as long as|until) [^,]+), (.+)$/i))) {
      r = parseSentence(`${m[2]} ${m[1].toLowerCase()}`, ctx);
    }
    // "~ deals 3 damage to that player unless they put a -1/-1 counter on a creature they control."
    if (!r && (m = s.match(/^(.+?) unless (you|they|that player|its controller|the player|target player|target opponent|any player) (.+)$/i))) {
      // Head first: "Destroy target creature unless its controller pays life equal to its toughness" — both the payer
      // and the amount refer to the creature the head just targeted (Essence Vortex, Excise).
      const savedT = ctx.targets.length;
      const savedLast = ctx.lastObj;
      const head = parseSentence(m[1], ctx);
      const afterHead = ctx.lastObj;
      if (head && (ctx.lastObj?.ref === 'lastMoved' || ctx.lastObj?.ref === 'lastCreated')) ctx.lastObj = ctx.targets.length > savedT ? { ref: 'target', slot: savedT } : savedLast;
      const who = head ? playerRef(/^any player$/i.test(m[2]) ? 'each player' : m[2], ctx) : null;
      const cost = who ? unlessCost(m[3], ctx) : null;
      ctx.lastObj = afterHead;
      if (who && cost && head) r = [{ kind: 'unlessPays', who, cost, effects: head }];
      else ctx.targets.length = savedT;
    }
    // "~ deals 1 damage to that player or a planeswalker that player controls."
    if (!r && (m = s.match(/^(.+ damage to .+?) or (?:a|any) planeswalkers? (?:that player|they|that opponent|that player's) controls?$/i))) {
      const inner = parseSentence(m[1], ctx);
      if (inner && inner.some((e) => e.kind === 'damage')) {
        for (const e of inner) if (e.kind === 'damage') e.orPlaneswalker = true;
        r = inner;
      }
    }
    // "..., and mana of any type can be spent to cast that spell" — a clause on the permission.
    if (!r && (m = s.match(/^(.+?),? and mana of any (?:colou?r|type) can be spent to (?:cast|play) (?:it|them|that spell|those spells|that card|those cards)$/i))) {
      const inner = parseSentence(m[1], ctx);
      if (inner && setAnyMana(inner)) r = inner;
    }
    // "You may cast that card by paying life equal to its mana value rather than paying its mana
    // cost": the alternative cost rides on whatever permission the rest of the sentence grants.
    if (!r && (m = s.match(/^(.+?) by paying life equal to (?:its|that spell's|the spell's) mana value rather than pay(?:ing)? its mana cost$/i))) {
      const inner = parseSentence(m[1], ctx);
      if (inner && setPayLife(inner)) r = inner;
    }
    // "~ has base power and toughness 4/2 until end of turn and gains first strike until end of
    // turn": one subject, two effects, each carrying its own duration.
    if (!r && (m = s.match(/^(.+?) (until end of turn|until your next turn) and ((?:gains?|has|have|gets?|becomes?) .+)$/i))) {
      const subj = m[1].match(/^(.+?) (?:has|have|gets?|gains?|becomes?)\b/i);
      if (subj) {
        const a = parseSentence(`${m[1]} ${m[2]}`, ctx);
        const b = a ? parseSentence(`${subj[1]} ${m[3]}`, ctx) : null;
        if (a && b) r = [...a, ...b];
      }
    }
    if (r) effects.push(...r);
    else {
      unhandled.push(s);
      effects.push({ kind: 'manual', text: s });
    }
  }
  // "…, where X is your devotion to blue. … If X is greater than …, you win the game": once a sentence has
  // defined X, every sentence of the ability means that X.
  if (ctx.boundX !== undefined) for (let i = 0; i < effects.length; i++) effects[i] = substituteXDeep(effects[i], ctx.boundX);
  // "Reveal cards … until you reveal X. Put that card into your hand and exile all other cards revealed
  // this way." — the reveal-until already parks the non-matches somewhere, so the follow-up decides where.
  for (let i = 0; i < effects.length; i++) {
    const r = effects[i];
    if (r.kind !== 'revealUntil' || r.destination !== 'hold' || !r.key) continue;
    const j = effects.findIndex((e, k) => k > i && e.kind === 'moveRest' && e.key === r.key);
    if (j < 0) continue;
    const to = (effects[j] as { to: string }).to;
    const rest = ({ exile: 'exile', graveyard: 'graveyard', hand: 'hand', bottom: 'bottom', bottomRandom: 'bottom', top: 'top', shuffle: 'shuffle' } as Record<string, typeof r.rest | undefined>)[to];
    if (!rest) continue;
    r.rest = rest;
    effects.splice(j, 1);
  }
  return { effects, unhandled };
}

/** "an artifact, a creature, an enchantment, and a land" → the individual noun phrases. */
function splitItemList(text: string): string[] {
  return text
    .split(/,? and |, /i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * "Each player chooses from among the permanents they control an artifact, a creature, ...,
 * then sacrifices the rest": keep one of each listed kind, lose everything else matching the base noun.
 */
function buildKeepList(whoWord: string, baseText: string, listText: string, act: string): Effect[] | null {
  const base = parseNoun(`a ${singularize(baseText)}`) ?? parseNoun(`a ${baseText}`);
  const items = splitItemList(listText).map((x) => parseNoun(x));
  if (!base || !base.confident || !items.length || items.some((n) => !n || !n.confident)) return null;
  const key = `keep_${baseText.replace(/\W+/g, '')}`;
  const over: Ref = /opponent/i.test(whoWord) ? { ref: 'eachOpponent' } : { ref: 'eachPlayer' };
  const effects: Effect[] = items.map((n) => ({
    kind: 'chooseObjects',
    who: { ref: 'iter' },
    filter: { ...base.filter, ...n!.filter, zone: 'battlefield', controllerRef: { ref: 'iter' } },
    count: 1,
    key,
    upTo: true,
    append: true, // every kept pick survives; only the rest is sacrificed
  }));
  const rest: Ref = { ref: 'all', filter: { ...base.filter, zone: 'battlefield', controllerRef: { ref: 'iter' }, notChosenKey: key } };
  effects.push(act.toLowerCase() === 'exiles' ? { kind: 'exile', what: rest } : { kind: 'sacrifice', what: rest });
  return [{ kind: 'forEach', over, effects }];
}

/** "a black or red source of your choice" / "~" / "target creature": the damage source a prevention watches. */
function preventionSource(text: string, ctx: ParseCtx): { source?: ObjectFilter; sourceRef?: Ref } | null {
  const t = text.trim();
  const l = t.toLowerCase();
  if (l === '~') return { sourceRef: SELF };
  const choice = l.match(/^(?:a|an) (.*?)\s*sources? of your choice$/);
  if (choice) {
    const qual = choice[1].trim();
    if (!qual) return {};
    const cols = qual.split(/ or |\/| and\/or /).map((c) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[c.trim() as 'white']);
    if (cols.every((c) => !!c)) return { source: { colors: cols as Color[] } };
    const noun = parseNoun(`a ${qual} permanent`);
    if (noun && noun.confident) return { source: { ...noun.filter, zone: undefined } };
  }
  const ofChoice = l.match(/^(?:a|an) (.+?) of your choice$/);
  if (ofChoice) {
    const noun = parseNoun(`a ${ofChoice[1]}`);
    if (noun && noun.confident) return { source: { ...noun.filter, zone: undefined } };
  }
  if (/^target /i.test(t)) {
    const ref = objRef(t, ctx);
    if (ref) return { sourceRef: ref };
  }
  const noun = parseNoun(t);
  if (noun && noun.confident && noun.kind !== 'player') {
    const f = { ...noun.filter };
    delete f.zone;
    return { source: f };
  }
  return null;
}

/** "you and/or creatures you control" / "target creature": who a prevention protects. */
function preventionTo(text: string, ctx: ParseCtx): { to?: Extract<Effect, { kind: 'preventAll' }>['to']; toRef?: Ref } | null {
  const l = text.trim().toLowerCase().replace(/ this turn$/, '');
  if (l === 'you') return { to: 'you' };
  if (/^you and(?:\/or| or)? (?:creatures|permanents) you control$/.test(l) || /^(?:creatures|permanents) you control and(?:\/or)? you$/.test(l)) return { to: 'youAndCreaturesYouControl' };
  if (/^you and(?:\/or| or)? planeswalkers you control$/.test(l)) return { to: 'youAndPlaneswalkersYouControl' };
  if (/^~ and(?:\/or| or)? you$/.test(l) || /^you and(?:\/or| or)? ~$/.test(l)) return { to: 'you' };
  if (l === 'creatures you control') return { to: 'creaturesYouControl' };
  if (l === 'any target' || l === 'anything') return { to: 'all' };
  if (l === 'each creature and each player') return { to: 'all' };
  if (l === '~') return { to: 'all', toRef: SELF };
  const noun = parseNoun(text.trim());
  if (noun && (noun.each || noun.plural) && noun.kind !== 'player') return { to: { ...noun.filter, zone: 'battlefield' } };
  const ref = anyRef(text.trim(), ctx);
  if (ref) return { to: 'all', toRef: ref };
  return null;
}

/** Rewrite endOfTurn durations produced by an "until end of turn" pattern to another duration. */
function retime<T>(value: T, dur: Duration): T {
  if (Array.isArray(value)) return value.map((v) => retime(v, dur)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'duration' && v === 'endOfTurn' ? dur : retime(v, dur);
    }
    return out as unknown as T;
  }
  return value;
}

/** Split a "has flying, lifelink, and \"Whenever ...\"" grant list into keywords and quoted abilities. */
export function parseGrantList(text: string): { keywords: string[]; abilities: string[] } | null {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    // A closing quote followed directly by another item ("…+2/+0," equip {2}) also separates.
    if (c === '"' && !quoted && text[i + 1] === ' ' && !text.startsWith(' and ', i + 1) && !text.startsWith(', ', i + 1)) {
      parts.push(`${cur}"`);
      cur = '';
      i += 1;
      continue;
    }
    if (!quoted) {
      if (text.startsWith(', and ', i)) {
        parts.push(cur);
        cur = '';
        i += 5;
        continue;
      }
      if (text.startsWith(' and ', i)) {
        parts.push(cur);
        cur = '';
        i += 4;
        continue;
      }
      if (c === ',' && text[i + 1] === ' ') {
        parts.push(cur);
        cur = '';
        i += 1;
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const keywords: string[] = [];
  const abilities: string[] = [];
  for (const raw of parts.map((p) => p.trim().replace(/\.$/, '')).filter(Boolean)) {
    const q = raw.match(/^"(.*)"$/s);
    if (q) {
      abilities.push(q[1]);
      continue;
    }
    if (/^all creature types$/i.test(raw)) {
      keywords.push('Changeling');
      continue;
    }
    const kws = parseKeywordList(raw);
    if (!kws) return null;
    keywords.push(...kws);
  }
  return keywords.length || abilities.length ? { keywords, abilities } : null;
}
