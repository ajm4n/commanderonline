/**
 * The Game: owns all state and drives the rules. Control flow uses generators:
 * every procedure that may need a player decision is a generator that yields
 * a Decision and receives a Response. `submit()` resumes the game.
 */
import {
  type CardData,
  type ContinuousEffect,
  type Decision,
  type GameConfig,
  type GameEvent,
  type GameEventName,
  type GameObject,
  type LogEntry,
  type ObjectId,
  type Player,
  type PlayerId,
  type PlayerSetup,
  type Response,
  type StackItem,
  type Step,
  type Target,
  type TurnState,
  type ZoneName,
  type ManualAction,
  type Color,
  DEFAULT_CONFIG,
  emptyPool,
} from './types.js';
import { Rng } from './rng.js';
import { type Characteristics, computeCharacteristics } from './characteristics.js';
import type { Amount, CardScript, Condition, Effect, Ref, TriggeredAbilitySpec, TriggerFilter, TargetSpec } from './script.js';
import { matchesFilter, objectsMatching, legalTargets, sameTarget, type FilterContext } from './filters.js';
import { parseTypeLine } from './typeline.js';
import { ENFORCED_KEYWORDS } from './keywords.js';
import { executeEffects, enterBattlefield, type EffectContext } from './effects.js';
import { buildPriorityDecision, castSpell, activateAbility, playLand, abilitiesOf } from './casting.js';
import { resolveTopOfStack } from './resolve.js';
import { runCombatStep } from './combat.js';
import { checkStateBasedActions } from './sba.js';
import { manaValue } from './mana.js';

export type Gen<T = void> = Generator<Decision, T, Response>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A decision without its id (assigned by the engine). */
export type DecisionInput = DistributiveOmit<Decision, 'id'>;

export interface PendingTrigger {
  sourceId: ObjectId;
  controller: PlayerId;
  ability: TriggeredAbilitySpec;
  context: Record<string, unknown>;
  /** Snapshot of the source if it has left the battlefield. */
  snapshot?: GameObject;
  delayedId?: number;
}

export interface DelayedTrigger {
  id: number;
  event: GameEventName;
  filter?: TriggerFilter;
  effects: Effect[];
  text: string;
  controller: PlayerId;
  sourceId: ObjectId;
  once: boolean;
  /** Extra context captured when the delayed trigger was created. */
  context: Record<string, unknown>;
  /** When set, the trigger refers to that specific object: it only fires while the source is still in this zone (rule 400.7). */
  sourceZone?: ZoneName;
  /** Removed at cleanup of the turn it was created. */
  thisTurn?: boolean;
}

export interface GameState {
  players: Record<PlayerId, Player>;
  playerOrder: PlayerId[];
  objects: Record<ObjectId, GameObject>;
  /** Battlefield order (for display). */
  battlefield: ObjectId[];
  stack: StackItem[];
  turn: TurnState;
  continuousEffects: ContinuousEffect[];
  delayedTriggers: DelayedTrigger[];
  /** Turn-wide damage prevention (Fog effects); cleared at cleanup. */
  /** objectId -> sources that dealt damage to it this turn. */
  damagedBy: Record<number, ObjectId[]>;
  /** turnStats of the previous turn ("if a player cast two or more spells last turn"). */
  lastTurnStats: Record<string, number>;
  /** Player rules granted for the rest of the turn ("You may cast spells this turn as though they had flash"). */
  turnRules?: { player: PlayerId; rule: import('./types.js').RuleModification }[];
  /** Day/night cycle: undefined until a card starts it. */
  dayNight?: 'day' | 'night';
  preventions: { effects?: import('./script.js').Effect[]; /** Only damage from these specific sources. */ sourceIds?: ObjectId[]; /** Shield: prevents at most this much, then wears off. */ amount?: number; combat: boolean; source?: import('./types.js').ObjectFilter; to: 'all' | 'you' | 'creaturesYouControl' | 'youAndCreaturesYouControl' | 'youAndPlaneswalkersYouControl' | 'players' | 'creatures' | import('./types.js').ObjectFilter; controller: PlayerId; sourceId: ObjectId | null; once?: boolean; /** Specific recipients ("prevent all damage that would be dealt to target creature this turn by red sources"). */ ids?: ObjectId[]; playerIds?: PlayerId[] }[];
  log: LogEntry[];
  monarch: PlayerId | null;
  initiative: PlayerId | null;
  started: boolean;
  over: boolean;
  winner: PlayerId | null;
  /** Bumped on every mutation; used to invalidate characteristic caches. */
  version: number;
  timestamp: number;
  nextObjectId: number;
  nextStackId: number;
  nextEffectId: number;
  nextDecisionId: number;
  /** Cards drawn / etc. this turn per player for triggers. */
  turnStats: Record<string, number>;
}

export type ScriptProvider = (card: CardData) => CardScript;

/** Fallback script: keywords only, everything else manual. */
export function keywordsOnlyScript(card: CardData): CardScript {
  return { name: card.name, abilities: [], coverage: 'none', origin: 'keywordsOnly', unhandledText: card.oracleText ? card.oracleText.split('\n') : [] };
}

export class Game {
  state: GameState;
  config: GameConfig;
  rng: Rng;
  pending: Decision | null = null;
  history: { player: PlayerId; response: Response }[] = [];
  private loop: Gen | null = null;
  private scriptProvider: ScriptProvider;
  private scriptCache = new Map<string, CardScript>();
  private chCache = new Map<ObjectId, { v: number; ch: Characteristics }>();
  private pendingTriggers: PendingTrigger[] = [];
  /** Queue a trigger from outside (state-based actions). */
  queueTrigger(t: PendingTrigger): void {
    this.pendingTriggers.push(t);
  }
  /** Objects exiled "until this leaves" whose source has left; returned by SBA. */
  pendingReturns: ObjectId[] = [];
  /** Player who dealt combat damage to the initiative holder this damage step; takes the initiative afterwards. */
  pendingInitiative: PlayerId | null = null;
  private computing = new Set<ObjectId>();
  /** Hook for tests / UI: called after each mutation batch. */
  onChange: (() => void) | null = null;
  private setups: PlayerSetup[];

  constructor(setups: PlayerSetup[], config: Partial<GameConfig> = {}, scriptProvider: ScriptProvider = keywordsOnlyScript) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = new Rng(this.config.seed);
    this.scriptProvider = scriptProvider;
    this.setups = setups;
    const players: Record<PlayerId, Player> = {};
    const objects: Record<ObjectId, GameObject> = {};
    let nextId = 1;
    for (const s of setups) {
      players[s.id] = {
        id: s.id,
        name: s.name,
        life: this.config.startingLife,
        poison: 0,
        experience: 0,
        energy: 0,
        manaPool: emptyPool(),
        commanderDamage: {},
        library: [],
        hand: [],
        graveyard: [],
        exile: [],
        command: [],
        landsPlayedThisTurn: 0,
        maxLandsPerTurn: 1,
        spellsCastThisTurn: 0,
        lost: false,
        mulligansTaken: 0,
        keptHand: false,
        attemptedDrawFromEmpty: false,
        flags: {},
        turnStats: {},
        designations: [],
        ringLevel: 0,
        dungeon: null,
        dungeonsCompleted: 0,
      };
      for (const card of s.deck.mainboard) {
        const id = nextId++;
        objects[id] = this.newObject(id, card, s.id, 'library');
        players[s.id].library.push(id);
      }
      for (const card of s.deck.commanders) {
        const id = nextId++;
        const obj = this.newObject(id, card, s.id, 'command');
        obj.isCommander = true;
        objects[id] = obj;
        players[s.id].command.push(id);
      }
    }
    const order = this.rng.shuffle(setups.map((s) => s.id));
    this.state = {
      players,
      playerOrder: order,
      objects,
      battlefield: [],
      stack: [],
      turn: { number: 0, activePlayer: order[0], phase: 'beginning', step: 'untap', extraTurns: [], skipSteps: [], firstStrikeHappened: false, attackers: [] },
      continuousEffects: [],
      delayedTriggers: [],
      dayNight: undefined,
      preventions: [],
      damagedBy: {},
      lastTurnStats: {},
      log: [],
      monarch: null,
      initiative: null,
      started: false,
      over: false,
      winner: null,
      version: 0,
      timestamp: 1,
      nextObjectId: nextId,
      nextStackId: 1,
      nextEffectId: 1,
      nextDecisionId: 1,
      turnStats: {},
    };
    for (const p of Object.values(this.state.players)) this.rng.shuffle(p.library);
  }

  /** Rebuild a game from its inputs and decision history (event sourcing). */
  static replay(setups: PlayerSetup[], config: Partial<GameConfig>, history: { player: PlayerId; response: Response }[], scriptProvider?: ScriptProvider): Game {
    const g = new Game(setups, config, scriptProvider);
    g.start();
    for (const h of history) g.submit(h.player, h.response);
    return g;
  }

  private newObject(id: ObjectId, card: CardData, owner: PlayerId, zone: ZoneName): GameObject {
    return {
      id,
      card,
      faceIndex: 0,
      owner,
      controller: owner,
      baseController: owner,
      zone,
      tapped: false,
      flipped: false,
      faceDown: false,
      controlSinceTurn: 0,
      timestamp: 0,
      counters: {},
      damage: 0,
      deathtouchDamage: false,
      attachedTo: null,
      attachments: [],
      isCommander: false,
      commanderCasts: 0,
      attacking: null,
      blocking: [],
      blockedBy: [],
      wasBlocked: false,
      phasedOut: false,
      chosen: {},
      enteredThisTurn: false,
      wasCast: false,
      additionalCostsPaid: [],
      memory: {},
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    if (this.state.started) return;
    this.state.started = true;
    this.loop = this.play();
    this.advance(undefined);
  }

  submit(player: PlayerId, response: Response) {
    if (this.state.over) throw new Error('Game is over');
    if (!this.pending) throw new Error('No pending decision');
    if (this.pending.player !== player) throw new Error(`Not ${player}'s decision (waiting on ${this.pending.player})`);
    this.history.push({ player, response });
    this.advance(response);
  }

  /** Manual state edits by any player, at any time. Untap-style escape hatch. */
  manual(player: PlayerId, action: ManualAction) {
    this.history.push({ player, response: { type: 'manual', action } });
    this.applyManual(player, action);
    this.touch();
    if (this.pending) this.refreshDecision(this.pending);
    this.onChange?.();
  }

  /** Recompute a priority decision in place after the state changed underneath it. */
  refreshDecision(decision: Decision = this.pending as Decision) {
    if (!decision || decision.type !== 'priority') return;
    const fresh = buildPriorityDecision(this, decision.player);
    Object.assign(decision, fresh, { id: decision.id });
  }

  private advance(response: Response | undefined) {
    if (!this.loop) return;
    const r = this.loop.next(response as Response);
    if (r.done) {
      this.pending = null;
      this.state.over = true;
    } else {
      this.pending = r.value;
    }
    this.onChange?.();
  }

  /** Yield a decision and validate the response type. Re-asks on invalid input. */
  *ask(d: DecisionInput, opts: { reuseId?: number; error?: string } = {}): Gen<Response> {
    const decision = { ...d, id: opts.reuseId ?? this.state.nextDecisionId++ } as Decision;
    if (opts.error) (decision as { error?: string }).error = opts.error;
    for (;;) {
      const resp: Response = yield decision;
      if (resp && resp.type === 'manual') {
        this.applyManual(decision.player, resp.action);
        this.refreshDecision(decision);
        continue;
      }
      if (resp && resp.type === 'cancel') return resp;
      const err = this.validateResponse(decision, resp);
      if (!err) return resp;
      (decision as { error?: string }).error = err;
    }
  }

  private validateResponse(d: Decision, r: Response | undefined): string | null {
    if (!r) return 'No response';
    const expect: Record<Decision['type'], Response['type'][]> = {
      priority: ['pass', 'playLand', 'cast', 'activate'],
      chooseTargets: ['targets'],
      yesNo: ['yesNo'],
      chooseOption: ['options'],
      chooseObjects: ['objects'],
      orderObjects: ['order'],
      declareAttackers: ['attackers'],
      declareBlockers: ['blockers'],
      payMana: ['payMana'],
      chooseNumber: ['number'],
      mulligan: ['mulligan'],
      distribute: ['distribute'],
      manualTrigger: ['manualDone'],
    };
    if (!expect[d.type].includes(r.type)) return `Expected ${expect[d.type].join('/')} response, got ${r.type}`;
    switch (d.type) {
      case 'chooseObjects': {
        const ids = (r as { ids: ObjectId[] }).ids;
        if (ids.length < d.min || ids.length > d.max) return `Choose between ${d.min} and ${d.max}`;
        if (ids.some((id) => !d.candidates.includes(id))) return 'Invalid choice';
        if (new Set(ids).size !== ids.length) return 'Duplicate choice';
        break;
      }
      case 'chooseOption': {
        const ids = (r as { ids: string[] }).ids;
        if (ids.length < d.min || ids.length > d.max) return `Choose between ${d.min} and ${d.max}`;
        if (ids.some((id) => !d.options.some((o) => o.id === id && !o.disabled))) return 'Invalid option';
        break;
      }
      case 'chooseNumber': {
        const v = (r as { value: number }).value;
        if (!Number.isInteger(v) || v < d.min || v > d.max) return `Choose a number between ${d.min} and ${d.max}`;
        break;
      }
      case 'orderObjects': {
        const ids = (r as { ids: number[] }).ids;
        const expected = d.items ? d.items.map((i) => i.id) : d.objectIds;
        if (ids.length !== expected.length || [...ids].sort().join() !== [...expected].sort().join()) return 'Must order all items';
        break;
      }
      case 'chooseTargets': {
        const t = (r as { targets: Target[][] }).targets;
        if (t.length !== d.slots.length) return 'Wrong number of target slots';
        for (let i = 0; i < d.slots.length; i++) {
          const slot = d.slots[i];
          if (t[i].length < slot.min || t[i].length > slot.max) return `${slot.description}: choose ${slot.min}-${slot.max}`;
          for (const tt of t[i]) if (!slot.legal.some((l) => sameTarget(l, tt))) return `Illegal target for ${slot.description}`;
        }
        break;
      }
      case 'distribute': {
        const a = (r as { amounts: number[] }).amounts;
        if (a.length !== d.targets.length) return 'One amount per target';
        if (a.reduce((x, y) => x + y, 0) !== d.amount) return `Amounts must total ${d.amount}`;
        if (a.some((x) => x < d.minPer)) return `Each target needs at least ${d.minPer}`;
        break;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Basic accessors
  // -------------------------------------------------------------------------

  obj(id: ObjectId): GameObject {
    const o = this.state.objects[id];
    if (!o) throw new Error(`No object ${id}`);
    return o;
  }
  player(id: PlayerId): Player {
    const p = this.state.players[id];
    if (!p) throw new Error(`No player ${id}`);
    return p;
  }
  activePlayers(): PlayerId[] {
    return this.state.playerOrder.filter((p) => !this.state.players[p].lost);
  }
  opponentsOf(p: PlayerId): PlayerId[] {
    return this.activePlayers().filter((x) => x !== p);
  }
  /** Players in APNAP order starting from the active player. */
  apnap(): PlayerId[] {
    const order = this.activePlayers();
    const i = order.indexOf(this.state.turn.activePlayer);
    if (i < 0) return order;
    return [...order.slice(i), ...order.slice(0, i)];
  }
  /** Players in turn order, starting with the given player ("starting with you, each player votes"). */
  votingOrder(start: PlayerId): PlayerId[] {
    const order = this.activePlayers();
    const i = order.indexOf(start);
    return i < 0 ? order : [...order.slice(i), ...order.slice(0, i)];
  }
  /** Extra votes granted by static abilities ("While voting, you get an additional vote"). */
  extraVotes(p: PlayerId): number {
    let n = 0;
    for (const r of this.playerRules(p)) if (r.kind === 'custom' && r.tag === 'extraVote') n += typeof r.data === 'number' ? r.data : 1;
    return n;
  }
  /** Day/night: set the cycle and fire "whenever day becomes night" triggers. */
  setDayNight(to: 'day' | 'night'): void {
    const from = this.state.dayNight;
    if (from === to) return;
    this.state.dayNight = to;
    this.log(`It becomes ${to}.`);
    this.touch();
    if (from !== undefined) this.emit({ name: 'dayNightChanged', data: { from, to } });
  }
  nextPlayerAfter(p: PlayerId): PlayerId {
    const order = this.state.playerOrder;
    let i = order.indexOf(p);
    for (let k = 0; k < order.length; k++) {
      i = (i + 1) % order.length;
      if (!this.state.players[order[i]].lost) return order[i];
    }
    return p;
  }
  touch() {
    this.state.version++;
  }
  now(): number {
    return this.state.timestamp++;
  }
  isMainPhase(): boolean {
    return this.state.turn.step === 'main1' || this.state.turn.step === 'main2';
  }

  log(text: string, extra: Partial<LogEntry> = {}) {
    this.state.log.push({ seq: this.state.log.length, turn: this.state.turn.number, text, ...extra });
  }

  nameOf(id: ObjectId): string {
    const o = this.state.objects[id];
    if (!o) return `#${id}`;
    if (o.faceDown) return 'a face-down card';
    return this.characteristics(id).name || o.card.name;
  }
  targetName(t: Target): string {
    if (t.kind === 'player') return this.state.players[t.id]?.name ?? t.id;
    if (t.kind === 'object') return this.nameOf(t.id);
    if (t.kind === 'stackItem') return this.state.stack.find((s) => s.id === t.id)?.text ?? 'a spell';
    return 'nothing';
  }

  // -------------------------------------------------------------------------
  // Scripts and characteristics
  // -------------------------------------------------------------------------

  scriptFor(obj: GameObject): CardScript {
    const card = obj.copyOf ?? obj.card;
    const key = card.oracleId || card.name;
    let s = this.scriptCache.get(key);
    if (!s) {
      s = this.scriptProvider(card);
      this.scriptCache.set(key, s);
    }
    if (obj.faceIndex > 0 && s.faces?.[obj.faceIndex - 1]) s = s.faces[obj.faceIndex - 1];
    // Mutate: a merged permanent has every ability of the cards in its stack.
    if (obj.mergedCards?.length) {
      const mkey = `merged:${key}:${obj.mergedCards.map((c) => c.oracleId || c.name).join('|')}`;
      let ms = this.scriptCache.get(mkey);
      if (!ms) {
        const extraAbilities = obj.mergedCards.flatMap((c) => {
          const cs = this.scriptCache.get(c.oracleId || c.name) ?? this.scriptProvider(c);
          this.scriptCache.set(c.oracleId || c.name, cs);
          return cs.abilities.filter((ab) => ab.kind !== 'spell');
        });
        ms = { ...s, abilities: [...s.abilities, ...extraAbilities] };
        this.scriptCache.set(mkey, ms);
      }
      s = ms;
    }
    // Granted rules text ("gains 'When this creature dies, ...'") compiles like any other oracle text.
    const granted: string[] = [];
    for (const ce of this.state.continuousEffects) {
      if (ce.modification.layer !== 6 || !ce.modification.addAbilityText?.length) continue;
      if (ce.affected.kind === 'fixed' ? !ce.affected.ids.includes(obj.id) : !matchesFilter(this, obj, ce.affected.filter, { sourceId: ce.sourceId, controller: ce.controller })) continue;
      granted.push(...ce.modification.addAbilityText);
    }
    if (card.typeLine === 'Emblem' && obj.zone === 'command') s = { ...s, abilities: s.abilities.map((ab) => (ab.kind === 'static' || ab.kind === 'triggered' || ab.kind === 'activated' ? ({ ...ab, zone: 'command' } as typeof ab) : ab)) };
    if (!granted.length) return s;
    const extra: CardScript['abilities'] = [];
    for (const text of granted) {
      const gkey = `grant:${card.name}:${text}`;
      let gs = this.scriptCache.get(gkey);
      if (!gs) {
        // A distinct identity so the provider compiles the granted text instead of returning the card's own cached script.
        gs = this.scriptProvider({ ...card, name: `${card.name} (granted)`, oracleId: gkey, oracleText: text, faces: undefined });
        this.scriptCache.set(gkey, gs);
      }
      extra.push(...gs.abilities.filter((ab) => ab.kind !== 'spell'));
    }
    return { ...s, abilities: [...s.abilities, ...extra] };
  }

  characteristics(id: ObjectId): Characteristics {
    const cached = this.chCache.get(id);
    if (cached && cached.v === this.state.version) return cached.ch;
    if (this.computing.has(id)) {
      // Re-entrancy guard (e.g. P/T defined by counting creatures): return base.
      const obj = this.obj(id);
      const parsed = parseTypeLine(obj.card.typeLine);
      return {
        name: obj.card.name,
        manaCost: obj.card.manaCost,
        manaValue: manaValue(obj.card.manaCost),
        types: parsed.types,
        supertypes: parsed.supertypes,
        subtypes: parsed.subtypes,
        colors: obj.card.colors,
        keywords: new Set(obj.card.keywords),
        protections: [],
        hexproofFrom: [],
        power: obj.card.power ? parseInt(obj.card.power, 10) || 0 : null,
        toughness: obj.card.toughness ? parseInt(obj.card.toughness, 10) || 0 : null,
        loyalty: null,
        oracleText: obj.card.oracleText,
        rules: [],
        lostAllAbilities: false,
        controller: obj.controller,
      };
    }
    this.computing.add(id);
    try {
      const ch = computeCharacteristics(this, id);
      this.chCache.set(id, { v: this.state.version, ch });
      return ch;
    } finally {
      this.computing.delete(id);
    }
  }

  /** Characteristic-defining P/T ("*"). Scripts may define `starPT` via memory; default counts. */
  evaluateStarPT(obj: GameObject): number | null {
    const text = obj.card.oracleText;
    const ctx: FilterContext = { sourceId: obj.id, controller: obj.controller };
    let m: RegExpMatchArray | null;
    if ((m = text.match(/power and toughness are each equal to the number of (\w+)s? you control/i))) {
      const word = m[1];
      const typeWord = word.charAt(0).toUpperCase() + word.slice(1);
      const isCardType = ['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker'].includes(typeWord);
      return objectsMatching(this, isCardType ? { types: [typeWord], controller: 'you' } : { subtypes: [typeWord], controller: 'you' }, ctx).length;
    }
    if ((m = text.match(/equal to the number of cards in your hand/i))) return this.player(obj.controller).hand.length;
    if ((m = text.match(/equal to the number of cards in your graveyard/i))) return this.player(obj.controller).graveyard.length;
    if ((m = text.match(/equal to the number of lands you control/i))) return objectsMatching(this, { types: ['Land'], controller: 'you' }, ctx).length;
    if ((m = text.match(/equal to the number of creatures you control/i))) return objectsMatching(this, { types: ['Creature'], controller: 'you' }, ctx).length;
    if ((m = text.match(/equal to your life total/i))) return this.player(obj.controller).life;
    if ((m = text.match(/equal to the number of (\+1\/\+1|charge|\w+) counters on (it|this creature|\w+)/i))) return obj.counters[m[1]] ?? 0;
    return null;
  }

  private keywordCache = new Map<string, string[]>();
  keywordsFromText(text: string): string[] {
    let r = this.keywordCache.get(text);
    if (r) return r;
    r = [];
    for (const line of text.split('\n')) {
      // Level / station blocks grant their keywords conditionally (handled by scripts), not always.
      if (/^(LEVEL|STATION) \d/.test(line)) break;
      // Keyword lines: "Flying, first strike" / "Trample" / "Ward {2}" / "Flying; Haste"
      const clean = line.replace(/\s*\([^)]*\)/g, '').trim();
      if (!clean) continue;
      const parts = clean.split(/[,;]\s*/);
      const all = parts.every((p) => {
        const k = p.trim();
        const base = k.replace(/\s*(\{.*|\d+|—.*|from .*)$/, '').trim();
        const norm = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
        return ENFORCED_KEYWORDS.has(norm) || /^(Protection|Hexproof) from/i.test(k) || /^Equip/i.test(k) || /^Enchant /i.test(k) || /^Ward/i.test(k) || /^Landwalk/i.test(k);
      });
      if (!all || parts.length === 0) continue;
      for (const p of parts) {
        const k = p.trim();
        if (/^Protection from/i.test(k) || /^Hexproof from/i.test(k)) continue;
        const base = k.replace(/\s*(\{.*|\d+$|—.*)$/, '').trim();
        r.push(base.charAt(0).toUpperCase() + base.slice(1).toLowerCase() === 'First strike' ? 'First strike' : base.charAt(0).toUpperCase() + base.slice(1).toLowerCase());
      }
    }
    this.keywordCache.set(text, r);
    return r;
  }
  protectionsFromText(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/(?:^|[,;]\s*|\n)Protection from ([^\n,;(]+?)(?: and from ([^\n,;(]+?))?(?=[\n,;(]|$)/gi)) {
      out.push(m[1].trim());
      if (m[2]) out.push(m[2].trim());
    }
    return out;
  }
  hexproofFromText(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/Hexproof from ([^\n,;(]+?)(?=[\n,;(]|$)/gi)) out.push(m[1].trim());
    return out;
  }

  /** Does this player have a rule flag from any static ability (e.g. "you have no maximum hand size")? */
  playerRules(p: PlayerId): import('./types.js').RuleModification[] {
    const out: import('./types.js').RuleModification[] = [];
    for (const src of Object.values(this.state.objects)) {
      if (src.zone !== 'battlefield' && src.zone !== 'command') continue;
      const script = this.scriptFor(src);
      for (const ab of script.abilities) {
        if (ab.kind !== 'static' || !ab.rule) continue;
        if ((ab.zone ?? 'battlefield') !== src.zone) continue;
        const who = ab.ruleAffects;
        const applies =
          (who === 'controller' && src.controller === p) ||
          (who === 'opponents' && src.controller !== p) ||
          who === 'allPlayers' ||
          (who === 'attachedToController' && src.attachedTo !== null && this.state.objects[src.attachedTo]?.controller === p);
        if (!applies) continue;
        if (ab.rule.kind === 'custom') {
          out.push({ ...ab.rule, sourceId: src.id, sourceController: src.controller } as import('./types.js').RuleModification);
          continue;
        }
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: src.id, controller: src.controller })) continue;
        out.push(ab.rule);
      }
    }
    for (const t of this.state.turnRules ?? []) if (t.player === p) out.push(t.rule);
    return out;
  }

  // -------------------------------------------------------------------------
  // Zones
  // -------------------------------------------------------------------------

  zoneList(player: PlayerId, zone: ZoneName): ObjectId[] {
    const p = this.player(player);
    switch (zone) {
      case 'library':
        return p.library;
      case 'hand':
        return p.hand;
      case 'graveyard':
        return p.graveyard;
      case 'exile':
        return p.exile;
      case 'command':
        return p.command;
      case 'battlefield':
        return this.state.battlefield;
      case 'stack':
        return [];
    }
  }

  private removeFromZone(obj: GameObject) {
    if (obj.zone === 'stack') {
      this.state.stack = this.state.stack.filter((s) => !(s.kind === 'spell' && s.sourceId === obj.id));
      return;
    }
    const list = obj.zone === 'battlefield' ? this.state.battlefield : this.zoneList(obj.zone === 'exile' || obj.zone === 'command' ? obj.owner : obj.owner, obj.zone);
    // Library/hand/graveyard belong to the owner.
    const idx = list.indexOf(obj.id);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Move an object between zones. Handles LKI snapshots, resetting state when
   * leaving the battlefield, and emitting zone-change events (which collect
   * triggers). Returns the (possibly same) object, or null if it ceased to exist.
   */
  moveObject(id: ObjectId, toZone: ZoneName, opts: { position?: 'top' | 'bottom' | number; tapped?: boolean; controller?: PlayerId; faceDown?: boolean; skipEvents?: boolean; counters?: Record<string, number>; attackingFor?: PlayerId | ObjectId; cause?: 'destroy' | 'sacrifice' | 'exile' | 'bounce' | 'discard' | 'mill' | 'countered' | 'resolve' | 'cast' | 'draw' | 'other'; sourceId?: ObjectId } = {}): GameObject | null {
    const obj = this.state.objects[id];
    if (!obj) return null;
    const fromZone = obj.zone;
    // "If that creature would die this turn, exile it instead" (a rule granted by a resolved effect).
    if (opts.cause === 'discard') obj.memory['discardedThisTurn'] = true;
    // "If a spell or ability an opponent controls causes you to discard ~, put it onto the battlefield instead."
    {
      const dtb = this.scriptFor(obj).abilities.find((ab) => ab.kind === 'static' && ab.rule?.kind === 'custom' && ab.rule.tag === 'discardToBattlefield');
      if (opts.cause === 'discard' && toZone === 'graveyard' && dtb) {
        const r = this.moveObject(id, 'battlefield', { ...opts, cause: 'other' });
        const d = ((dtb as { rule?: { data?: unknown } }).rule?.data as { counter?: string; amount?: number } | undefined) ?? {};
        if (r && d.counter && d.amount) this.addCounters(r.id, d.counter, d.amount);
        return r;
      }
    }
    if (!opts.skipEvents && toZone === 'graveyard' && fromZone === 'battlefield' && this.characteristics(id).rules.some((r) => r.kind === 'custom' && r.tag === 'exileIfDies')) {
      return this.moveObject(id, 'exile', { ...opts, cause: 'exile' });
    }
    // "If that spell would be put into a graveyard, exile it instead." (from any zone)
    if (!opts.skipEvents && toZone === 'graveyard' && this.characteristics(id).rules.some((r) => r.kind === 'custom' && r.tag === 'exileInsteadOfGraveyard')) {
      return this.moveObject(id, 'exile', { ...opts, cause: 'exile' });
    }
    // Other permanents' replacements: "If a creature an opponent controls would die, exile it instead." / Rest in Peace
    if (!opts.skipEvents && toZone === 'graveyard') {
      for (const srcId of this.state.battlefield) {
        const src = this.state.objects[srcId];
        if (!src || srcId === id) continue;
        for (const ab of this.scriptFor(src).abilities) {
          if (ab.kind !== 'replacement' || (ab.event !== 'dies' && ab.event !== 'putIntoGraveyard') || !('filter' in ab) || !('instead' in ab)) continue;
          if (ab.event === 'dies' && fromZone !== 'battlefield') continue;
          if (!matchesFilter(this, obj, { ...ab.filter, zone: undefined }, { sourceId: srcId, controller: src.controller, zoneOverride: fromZone })) continue;
          return this.moveObject(id, 'exile', { ...opts, cause: 'exile' });
        }
      }
    }
    // Self replacement effects: "If ~ would die / be put into a graveyard, exile it instead."
    if (!opts.skipEvents && toZone === 'graveyard' && !obj.card.isToken) {
      for (const ab of this.scriptFor(obj).abilities) {
        if (ab.kind !== 'replacement' || !('self' in ab) || !ab.self || (ab.event !== 'dies' && ab.event !== 'putIntoGraveyard' && ab.event !== 'leavesBattlefield')) continue;
        if (ab.event === 'dies' && fromZone !== 'battlefield') continue;
        if (ab.event === 'leavesBattlefield' && fromZone !== 'battlefield') continue;
        if ((ab as { instead: string }).instead === 'exile') return this.moveObject(id, 'exile', { ...opts, cause: 'exile' });
        if ((ab as { instead: string }).instead === 'returnToHand') return this.moveObject(id, 'hand', { ...opts, cause: 'bounce' });
        if ((ab as { instead: string }).instead === 'shuffleIntoLibrary') {
          const r = this.moveObject(id, 'library', { ...opts });
          this.shuffleLibrary(obj.owner);
          return r;
        }
        if ((ab as { instead: string }).instead === 'commandZone') return this.moveObject(id, 'command', { ...opts, skipEvents: true });
      }
    }
    const snapshot: GameObject = JSON.parse(JSON.stringify(obj));
    const lkiCh = fromZone === 'battlefield' ? this.characteristics(id) : null;
    this.touch();

    // Commander replacement: would go to hand/library → owner may put in command zone instead.
    // (Graveyard/exile handled by SBA per rule 903.9a; we do the same choice there.)
    this.removeFromZone(obj);

    // Detach anything attached to it; unattach it from whatever it's on.
    if (fromZone === 'battlefield') {
      for (const aId of [...obj.attachments]) {
        const a = this.state.objects[aId];
        if (a) {
          a.attachedTo = null;
          this.emit({ name: 'becomesUnattached', objectId: aId, sourceId: id });
        }
      }
      obj.attachments = [];
      if (obj.attachedTo !== null) {
        const host = this.state.objects[obj.attachedTo];
        if (host) host.attachments = host.attachments.filter((x) => x !== id);
        obj.attachedTo = null;
      }
      // Effects that last until the source leaves end now.
      this.state.continuousEffects = this.state.continuousEffects.filter((ce) => !(ce.duration === 'untilSourceLeaves' && ce.sourceId === id));
    }
    if (fromZone !== toZone) {
      const exiled = obj.memory['exiledUntilLeaves'] as ObjectId[] | undefined;
      if (exiled?.length) this.pendingReturns.push(...exiled);
    }
    // A zone change makes a new object: effects locked onto the old one end (rule 400.7). This happens after the
    // leave events below have fired, so granted "when this dies" abilities still see the object (rule 603.10).
    const pruneFixed = () => {
      if (fromZone === toZone) return;
      this.state.continuousEffects = this.state.continuousEffects
        .map((ce) => (ce.affected.kind === 'fixed' && ce.affected.ids.includes(id) ? { ...ce, affected: { kind: 'fixed' as const, ids: ce.affected.ids.filter((x) => x !== id) } } : ce))
        .filter((ce) => !(ce.affected.kind === 'fixed' && ce.affected.ids.length === 0));
    };
    // Tokens cease to exist outside the battlefield (after events fire).
    const willCease = obj.card.isToken && toZone !== 'battlefield' && toZone !== 'stack';

    // Reset object state (it's a new object per rule 400.7).
    obj.tapped = opts.tapped ?? false;
    obj.damage = 0;
    obj.deathtouchDamage = false;
    obj.counters = opts.counters ? { ...opts.counters } : {};
    obj.attacking = null;
    obj.blocking = [];
    obj.blockedBy = [];
    obj.wasBlocked = false;
    obj.phasedOut = false;
    obj.faceDown = opts.faceDown ?? false;
    obj.copyOf = undefined;
    obj.flipped = false;
    obj.enteredThisTurn = toZone === 'battlefield';
    obj.controlSinceTurn = this.state.turn.number;
    if (toZone !== 'stack' && toZone !== 'battlefield') {
      obj.controller = obj.owner;
      obj.baseController = obj.owner;
      obj.xValue = undefined;
      obj.modes = undefined;
      obj.additionalCostsPaid = [];
      obj.wasCast = false;
      // Exile keeps "you may cast this from exile" style memory; other zones start clean.
      if (toZone !== 'exile') obj.memory = {};
      else obj.memory = Object.fromEntries(Object.entries(obj.memory).filter(([k]) => ['playableBy', 'playableUntil', 'plotted', 'freeCast', 'sorceryOnly', 'adventureExiled', 'exileOnResolve'].includes(k)));
      obj.chosen = {};
      if (toZone !== 'exile' || !opts.sourceId) obj.faceIndex = 0;
    } else if (opts.controller) {
      obj.controller = opts.controller;
      obj.baseController = opts.controller;
    }
    if (toZone === 'battlefield') obj.baseController = obj.controller;
    if (toZone === 'battlefield' && fromZone === 'stack') {
      // Spells resolving keep controller/X/modes.
    }
    // Transform DFCs return front-face up unless entering transformed.
    if (toZone === 'battlefield' && fromZone !== 'stack' && obj.card.layout === 'transform') obj.faceIndex = 0;
    obj.zone = toZone;
    obj.timestamp = this.now();
    obj.lastKnownInfo = snapshot;
    obj.lastZoneChange = { from: fromZone, turn: this.state.turn.number };

    // Insert into destination.
    if (toZone === 'battlefield') {
      this.state.battlefield.push(id);
      if (opts.attackingFor !== undefined) obj.attacking = opts.attackingFor;
      // Planeswalkers enter with loyalty counters.
      const ch = this.characteristics(id);
      if (ch.types.includes('Planeswalker') && obj.card.loyalty && !obj.counters['loyalty']) obj.counters['loyalty'] = parseInt(obj.card.loyalty, 10) || 0;
      if (ch.types.includes('Battle') && obj.card.defense && !obj.counters['defense']) obj.counters['defense'] = parseInt(obj.card.defense, 10) || 0;
    } else if (toZone === 'stack') {
      // Caller adds the StackItem.
    } else {
      const list = this.zoneList(obj.owner, toZone);
      if (toZone === 'library') {
        if (opts.position === 'bottom') list.push(id);
        else if (typeof opts.position === 'number') list.splice(Math.min(opts.position, list.length), 0, id);
        else list.unshift(id); // top = index 0
      } else list.push(id);
    }

    if (!opts.skipEvents) {
      const base: Partial<GameEvent> = { objectId: id, fromZone, toZone, snapshot, sourceId: opts.sourceId, data: { cause: opts.cause, lkiCh } };
      if (fromZone === 'battlefield') {
        this.emit({ name: 'leavesBattlefield', ...base, playerId: snapshot.controller });
        if (toZone === 'graveyard') this.emit({ name: 'dies', ...base, playerId: snapshot.controller });
      }
      if (toZone === 'graveyard') this.emit({ name: 'putIntoGraveyard', ...base, playerId: obj.owner });
      if (fromZone === 'graveyard') this.emit({ name: 'leftGraveyard', ...base, playerId: obj.owner });
      if (toZone === 'exile') this.emit({ name: 'exiled', ...base, playerId: obj.owner });
      if (toZone === 'hand' && fromZone !== 'library') this.emit({ name: 'returnedToHand', ...base, playerId: obj.owner });
      if (toZone === 'battlefield') this.emit({ name: 'entersBattlefield', ...base, playerId: obj.controller });
      if (opts.cause === 'sacrifice') this.emit({ name: 'sacrifice', ...base, playerId: snapshot.controller });
      if (opts.cause === 'discard') this.emit({ name: 'discard', ...base, playerId: obj.owner });
      if (opts.cause === 'mill') this.emit({ name: 'mill', ...base, playerId: obj.owner });
    }
    pruneFixed();

    if (willCease) {
      // Remove after triggers were collected (they hold a snapshot).
      this.removeFromZone(obj);
      delete this.state.objects[id];
      this.touch();
      return null;
    }
    return obj;
  }

  /** Create a token / emblem object directly on the battlefield (or another zone). */
  createObject(card: CardData, owner: PlayerId, zone: ZoneName, opts: { tapped?: boolean; controller?: PlayerId; attacking?: PlayerId | ObjectId; counters?: Record<string, number>; skipEvents?: boolean } = {}): GameObject {
    const id = this.state.nextObjectId++;
    const obj = this.newObject(id, card, owner, zone);
    obj.controller = opts.controller ?? owner;
    obj.baseController = obj.controller;
    obj.tapped = opts.tapped ?? false;
    obj.counters = opts.counters ? { ...opts.counters } : {};
    obj.timestamp = this.now();
    obj.enteredThisTurn = zone === 'battlefield';
    obj.controlSinceTurn = this.state.turn.number;
    this.state.objects[id] = obj;
    this.touch();
    if (zone === 'battlefield') {
      this.state.battlefield.push(id);
      if (opts.attacking !== undefined) obj.attacking = opts.attacking;
      if (!opts.skipEvents) {
        if (card.isToken) this.emit({ name: 'tokenCreated', objectId: id, playerId: obj.controller });
        this.emit({ name: 'entersBattlefield', objectId: id, toZone: 'battlefield', playerId: obj.controller });
      }
    } else {
      this.zoneList(owner, zone).push(id);
    }
    return obj;
  }

  // -------------------------------------------------------------------------
  // Events and triggers
  // -------------------------------------------------------------------------

  /** Record an event and collect any triggered abilities it fires. */
  emit(event: GameEvent) {
    this.touch();
    // Turn stats used by "first time each turn" / "nth spell" conditions.
    const key = `${event.name}:${event.playerId ?? ''}`;
    this.state.turnStats[key] = (this.state.turnStats[key] ?? 0) + 1;
    if (event.playerId) {
      const p = this.state.players[event.playerId];
      if (p) p.turnStats[event.name] = (p.turnStats[event.name] ?? 0) + 1;
    }
    this.collectTriggers(event);
    this.collectRingTriggers(event);
  }

  /** The Ring's levels 2-4 are triggered abilities of the ring-bearer's controller. */
  private collectRingTriggers(event: GameEvent) {
    if (event.objectId === undefined) return;
    if (event.name !== 'attacks' && event.name !== 'becomesBlocked' && event.name !== 'dealtCombatDamageToPlayer') return;
    const obj = this.state.objects[event.objectId];
    if (!obj || obj.zone !== 'battlefield') return;
    if (!this.characteristics(obj.id).rules.some((r) => r.kind === 'custom' && r.tag === 'ringBearer')) return;
    const p = this.player(obj.controller);
    if (event.name === 'attacks' && p.ringLevel >= 2) this.pendingTriggers.push({ sourceId: obj.id, controller: p.id, ability: { kind: 'triggered', text: 'The Ring: whenever your Ring-bearer attacks, draw a card, then discard a card.', event: 'attacks', effects: [{ kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }] }, context: this.triggerContextFrom(event) });
    if (event.name === 'becomesBlocked' && p.ringLevel >= 3) this.pendingTriggers.push({ sourceId: obj.id, controller: p.id, ability: { kind: 'triggered', text: "The Ring: whenever your Ring-bearer becomes blocked by a creature, that creature's controller sacrifices it at end of combat.", event: 'becomesBlocked', effects: [{ kind: 'delayedTrigger', event: 'endOfCombat', text: 'Sacrifice blockers of the Ring-bearer', effects: [{ kind: 'sacrifice', what: { ref: 'chosen', key: 'ringBlockers' } }] }] }, context: { ...this.triggerContextFrom(event), ringBlockers: [...obj.blockedBy] } });
    if (event.name === 'dealtCombatDamageToPlayer' && p.ringLevel >= 4) this.pendingTriggers.push({ sourceId: obj.id, controller: p.id, ability: { kind: 'triggered', text: 'The Ring: whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.', event: 'dealtCombatDamageToPlayer', effects: [{ kind: 'loseLife', amount: 3, who: { ref: 'eachOpponent' } }] }, context: this.triggerContextFrom(event) });
  }

  private collectTriggers(event: GameEvent) {
    const lkiCh = (event.data?.lkiCh as Characteristics | undefined) ?? undefined;
    // "Creatures entering do not cause abilities to trigger." (Hushwing Gryff)
    if (event.name === 'entersBattlefield' && event.objectId !== undefined) {
      const entering = this.state.objects[event.objectId];
      if (entering) {
        for (const r of this.playerRules(entering.controller)) {
          if (r.kind !== 'custom' || r.tag !== 'noEtbTriggers') continue;
          const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter;
          if (!f || matchesFilter(this, entering, { ...f, zone: undefined }, { sourceId: null, controller: entering.controller })) return;
        }
      }
    }
    for (const obj of Object.values(this.state.objects)) {
      if (obj.phasedOut) continue;
      // A face-down permanent has no abilities, so it triggers nothing.
      if (obj.faceDown && obj.zone === 'battlefield') continue;
      const script = this.scriptFor(obj);
      for (const ab of script.abilities) {
        if (ab.kind !== 'triggered' || ab.event !== event.name) continue;
        const zones = ab.zone ? (Array.isArray(ab.zone) ? ab.zone : [ab.zone]) : ['battlefield'];
        const isSelfLeaving = event.objectId === obj.id && event.snapshot && event.fromZone === 'battlefield' && (event.name === 'dies' || event.name === 'leavesBattlefield' || event.name === 'exiled' || event.name === 'putIntoGraveyard');
        const isSelfEntering = event.objectId === obj.id && event.name === 'entersBattlefield';
        if (!isSelfLeaving && !zones.includes(obj.zone)) continue;
        // Enter triggers ("When ~ enters") only if ability functions on battlefield.
        if (isSelfEntering && !zones.includes('battlefield')) continue;
        const controller = isSelfLeaving && event.snapshot ? event.snapshot.controller : obj.controller;
        const evalObj = isSelfLeaving && event.snapshot ? event.snapshot : obj;
        if (event.name === 'tappedForMana' && ab.effects.every((e) => e.kind === 'addMana')) continue; // already resolved as a mana ability
        if (!this.triggerMatches(ab.filter, event, evalObj, controller, lkiCh)) continue;
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: obj.id, controller, triggerContext: this.triggerContextFrom(event) })) continue;
        if (ab.oncePerTurn) {
          const k = `once:${obj.id}:${ab.text}`;
          if (this.state.turnStats[k]) continue;
          this.state.turnStats[k] = 1;
        }
        this.pendingTriggers.push({ sourceId: obj.id, controller, ability: ab, context: this.triggerContextFrom(event), snapshot: isSelfLeaving ? event.snapshot : undefined });
        // Panharmonicon-style: "that ability triggers an additional time".
        for (const r of this.playerRules(controller)) {
          if (r.kind !== 'custom' || r.tag !== 'doubleTriggers') continue;
          const d = r.data as { filter?: import('./types.js').ObjectFilter; event?: GameEventName; eventObject?: import('./types.js').ObjectFilter } | undefined;
          if (d?.event && event.name !== d.event) continue;
          if (d?.filter && !matchesFilter(this, obj, { ...d.filter, zone: undefined }, { sourceId: obj.id, controller })) continue;
          if (d?.eventObject) {
            const eo = event.objectId !== undefined ? this.state.objects[event.objectId] ?? (event.snapshot as GameObject | undefined) : undefined;
            if (!eo || !matchesFilter(this, eo, { ...d.eventObject, zone: undefined }, { sourceId: obj.id, controller })) continue;
          }
          this.pendingTriggers.push({ sourceId: obj.id, controller, ability: ab, context: this.triggerContextFrom(event), snapshot: isSelfLeaving ? event.snapshot : undefined });
        }
      }
    }
    // Delayed triggers
    for (const dt of [...this.state.delayedTriggers]) {
      if (dt.event !== event.name) continue;
      const src = this.state.objects[dt.sourceId];
      const evalObj = src ?? (event.snapshot as GameObject);
      const watch = dt.context['watchIds'] as ObjectId[] | undefined;
      if (watch && (event.objectId === undefined || !watch.includes(event.objectId))) continue;
      if (dt.sourceZone && src?.zone !== dt.sourceZone) {
        // The object it referred to has changed zones: it is a new object and the delayed trigger does nothing.
        if (dt.once) this.state.delayedTriggers = this.state.delayedTriggers.filter((x) => x.id !== dt.id);
        continue;
      }
      if (dt.filter && !this.triggerMatches(dt.filter, event, evalObj, dt.controller, lkiCh)) continue;
      this.pendingTriggers.push({
        sourceId: dt.sourceId,
        controller: dt.controller,
        ability: { kind: 'triggered', text: dt.text, event: dt.event, effects: dt.effects },
        context: { ...dt.context, ...this.triggerContextFrom(event) },
        delayedId: dt.id,
      });
      if (dt.once) this.state.delayedTriggers = this.state.delayedTriggers.filter((x) => x.id !== dt.id);
    }
  }

  /** Players attacked this turn, for "for each opponent you're attacking". */
  attackedPlayerCount(pid: PlayerId): number {
    return new Set(this.state.battlefield.map((id) => this.state.objects[id]).filter((o) => o && o.controller === pid && typeof o.attacking === 'string').map((o) => o!.attacking as PlayerId)).size;
  }

  triggerContextFrom(event: GameEvent): Record<string, unknown> {
    return {
      triggerObject: event.objectId,
      triggerSource: event.sourceId,
      triggerPlayer: event.playerId,
      triggerOtherPlayer: event.otherPlayerId,
      triggerAmount: event.amount,
      triggerSnapshot: event.snapshot,
      triggerEvent: event.name,
      triggerData: event.data,
      stackItemId: (event.data as { stackItemId?: number } | undefined)?.stackItemId,
    };
  }

  triggerMatches(f: TriggerFilter | undefined, e: GameEvent, obj: GameObject, controller: PlayerId, lkiCh?: Characteristics): boolean {
    if (!f) return true;
    const ctx: FilterContext = { sourceId: obj.id, controller };
    if (f.self && e.objectId !== obj.id) return false;
    if (f.object) {
      if (e.objectId === undefined) return false;
      const target = e.snapshot && (e.name === 'dies' || e.name === 'leavesBattlefield' || e.name === 'exiled' || e.name === 'putIntoGraveyard' || e.name === 'sacrifice') ? e.snapshot : this.state.objects[e.objectId];
      if (!target) return false;
      const fctx: FilterContext = e.snapshot && target === e.snapshot ? { ...ctx, chOverride: lkiCh, zoneOverride: e.fromZone ?? 'battlefield' } : ctx;
      const filter = { ...f.object };
      // "other" relative to the trigger's source
      if (filter.other && e.objectId === obj.id) return false;
      delete filter.other;
      if (!matchesFilter(this, target, filter, fctx)) return false;
    }
    if (f.objectController && e.objectId !== undefined) {
      const target = e.snapshot ?? this.state.objects[e.objectId];
      if (!target) return false;
      if (f.objectController === 'you' && target.controller !== controller) return false;
      if (f.objectController === 'opponent' && target.controller === controller) return false;
    }
    if (f.source) {
      if (e.sourceId === undefined) return false;
      const src = this.state.objects[e.sourceId];
      if (!src || !matchesFilter(this, src, { ...f.source, zone: undefined }, ctx)) return false;
    }
    if (f.player) {
      if (f.player === 'you' && e.playerId !== controller) return false;
      if ((f.player === 'opponent' || f.player === 'notYou') && e.playerId === controller) return false;
      if (f.player !== 'any' && e.playerId === undefined) return false;
    }
    if (f.otherPlayer) {
      if (f.otherPlayer === 'you' && e.otherPlayerId !== controller) return false;
      if (f.otherPlayer === 'opponent' && e.otherPlayerId === controller) return false;
    }
    if (f.combat !== undefined && (e.combat ?? false) !== f.combat) return false;
    if (f.yourTurn && this.state.turn.activePlayer !== controller) return false;
    if (f.notYourTurn && this.state.turn.activePlayer === controller) return false;
    if (f.fromZone && e.fromZone !== f.fromZone) return false;
    if (f.notFromZone && e.fromZone === f.notFromZone) return false;
    if (f.notToZone && e.toZone === f.notToZone) return false;
    if (f.attachedToSource) {
      const src = this.state.objects[obj.id] ?? obj;
      const attachedTo = src.attachedTo ?? (src.lastKnownInfo as GameObject | undefined)?.attachedTo ?? null;
      if (e.objectId === undefined || attachedTo !== e.objectId) return false;
    }
    if (f.sourceAttachedTo) {
      const src = this.state.objects[obj.id] ?? obj;
      const attachedTo = src.attachedTo ?? (src.lastKnownInfo as GameObject | undefined)?.attachedTo ?? null;
      if (e.sourceId === undefined || attachedTo !== e.sourceId) return false;
    }
    if (f.targetsControlled) {
      const item = this.state.stack.find((s) => s.kind === 'spell' && s.sourceId === e.objectId);
      if (!item || !item.targets.some((t) => t.kind === 'object' && this.state.objects[t.id] && this.state.objects[t.id].controller === controller && matchesFilter(this, this.state.objects[t.id], { ...f.targetsControlled, zone: undefined }, { sourceId: obj.id, controller }))) return false;
    }
    if (f.custom === 'exhaust' && !(e.data as { exhaust?: boolean } | undefined)?.exhaust) return false;
    if (f.custom === 'wonFlip' && !(e.data as { won?: boolean } | undefined)?.won) return false;
    if (f.custom === 'attachedToSelf' && e.sourceId !== obj.id) return false;
    if (f.custom === 'declareAttackersStep' && this.state.turn.step !== 'declareAttackers') return false;
    if (f.custom === 'attacksEnchantedPlayer' && (obj.attachedTo === null || e.otherPlayerId === undefined || e.otherPlayerId !== this.state.objects[obj.attachedTo]?.controller)) return false;
    if (f.custom === 'becomesNight' && (e.data as { to?: string } | undefined)?.to !== 'night') return false;
    if (f.custom === 'becomesDay' && (e.data as { to?: string } | undefined)?.to !== 'day') return false;
    if (f.custom?.startsWith('door:') && (e.data as { door?: number } | undefined)?.door !== Number(f.custom.slice(5))) return false;
    if (f.custom === 'lostFlip' && (e.data as { won?: boolean } | undefined)?.won) return false;
    if (f.custom === 'nonManaAbility' && (e.data as { mana?: boolean } | undefined)?.mana) return false;
    if (f.custom === 'chosenPlayersStep') {
      const src = this.state.objects[obj.id] ?? obj;
      const chosen = src.memory['opponent'] ?? src.memory['player'] ?? src.memory['chosenPlayer'];
      if (typeof chosen !== 'string' || e.playerId !== chosen) return false;
    }
    if (f.custom?.startsWith('expend:') && (e.data as { n?: number } | undefined)?.n !== Number(f.custom.slice(7))) return false;
    if (f.custom === 'kicked') {
      const cast = e.objectId !== undefined ? this.state.objects[e.objectId] : undefined;
      if (!cast || !cast.additionalCostsPaid.includes('kicker')) return false;
    }
    if (f.custom === 'attachedControllersUpkeep') {
      const src = this.state.objects[obj.id] ?? obj;
      const host = src.attachedTo !== null ? this.state.objects[src.attachedTo] : undefined;
      if (!host || e.playerId !== host.controller) return false;
    }
    if (f.targetsSource) {
      const item = this.state.stack.find((s) => s.kind === 'spell' && s.sourceId === e.objectId);
      if (!item || !item.targets.some((t) => t.kind === 'object' && t.id === obj.id)) return false;
    }
    if (f.toZone && e.toZone !== f.toZone) return false;
    if (f.counterType && e.counterType !== f.counterType) return false;
    if (f.minAmount !== undefined && (e.amount ?? 0) < f.minAmount) return false;
    if (f.toPlayer && e.playerId === undefined) return false;
    if (f.attacksYou) {
      // 'attacks' events carry otherPlayerId = defending player; planeswalker attacks carry sourceId.
      const defender = e.otherPlayerId;
      if (defender !== controller) return false;
    }
    if (f.firstEachTurn) {
      const key = `${e.name}:${e.playerId ?? ''}`;
      if ((this.state.turnStats[key] ?? 0) !== 1) return false;
    }
    if (f.nthThisTurn !== undefined) {
      const key = `${e.name}:${e.playerId ?? ''}`;
      if ((this.state.turnStats[key] ?? 0) !== f.nthThisTurn) return false;
    }
    if (f.minNthThisTurn !== undefined) {
      const key = `${e.name}:${e.playerId ?? ''}`;
      if ((this.state.turnStats[key] ?? 0) < f.minNthThisTurn) return false;
    }
    return true;
  }

  hasPendingTriggers(): boolean {
    return this.pendingTriggers.length > 0;
  }

  /** Put all pending triggers on the stack in APNAP order, asking players to order theirs. */
  *putTriggersOnStack(): Gen {
    while (this.pendingTriggers.length > 0) {
      const batch = this.pendingTriggers;
      this.pendingTriggers = [];
      for (const pid of this.apnap()) {
        const mine = batch.filter((t) => t.controller === pid);
        if (mine.length === 0) continue;
        let ordered = mine;
        const distinctTexts = new Set(mine.map((t) => t.ability.text)).size;
        if (mine.length > 1 && distinctTexts > 1) {
          const items = mine.map((t, i) => ({ id: i, text: `${this.nameOf(t.sourceId)}: ${t.ability.text}` }));
          const resp = yield* this.ask({ type: 'orderObjects', player: pid, prompt: 'Order your triggered abilities (first chosen resolves last)', objectIds: mine.map((t) => t.sourceId), context: 'triggers', items });
          if (resp.type === 'order') ordered = resp.ids.map((i) => mine[i]);
        }
        for (const t of ordered) yield* this.pushTrigger(t);
      }
    }
  }

  private *pushTrigger(t: PendingTrigger): Gen {
    const src = this.state.objects[t.sourceId];
    // Unscripted trigger: prompt the player to handle it manually at the right time.
    const isManual = t.ability.effects.length === 1 && t.ability.effects[0].kind === 'manual' && !t.ability.targets?.length;
    let targets: Target[] = [];
    if (t.ability.targets?.length) {
      const chosen = yield* this.chooseTargets(t.controller, t.sourceId, t.ability.targets, t.context, `${this.nameOf(t.sourceId)}: ${t.ability.text}`);
      if (chosen === null) {
        this.log(`${this.nameOf(t.sourceId)}'s trigger has no legal targets and is removed.`);
        return;
      }
      targets = chosen;
    }
    const item: StackItem = {
      id: this.state.nextStackId++,
      kind: 'triggered',
      sourceId: t.sourceId,
      controller: t.controller,
      text: `${src?.card.name ?? t.snapshot?.card.name ?? 'Ability'}: ${t.ability.text}`,
      abilityRef: t.ability.text,
      targets,
      targetStamps: this.stampTargets(targets),
      triggerContext: { ...t.context, ability: t.ability, snapshot: t.snapshot, isManual },
      timestamp: this.now(),
    };
    this.state.stack.push(item);
    this.log(`Trigger: ${item.text}`, { kind: 'trigger', data: { sourceId: t.sourceId, controller: t.controller } });
    this.touch();
  }

  /** Ask a player to choose targets for a list of specs. Returns null if a required slot has no legal targets. */
  *chooseTargets(player: PlayerId, sourceId: ObjectId | null, specs: TargetSpec[], ctx: Record<string, unknown>, prompt: string, x?: number): Gen<Target[] | null> {
    const slots = specs.map((spec) => {
      const legal = legalTargets(this, spec, sourceId, player, x);
      return { description: spec.description, legal, min: spec.optional ? 0 : (spec.min ?? 1), max: spec.max ?? 1 };
    });
    if (slots.some((s) => s.legal.length < s.min)) return null;
    // Auto-choose when there's exactly one legal option for every required slot.
    const forced = slots.every((s) => s.legal.length === s.min || s.min === 0 && s.legal.length === 0);
    let targets: Target[][];
    if (forced && slots.every((s) => s.max === 1 || s.legal.length <= s.max)) {
      targets = slots.map((s) => s.legal.slice(0, Math.max(s.min, Math.min(s.legal.length, s.max))));
      if (slots.some((s) => s.min === 0 && s.legal.length > 0 && s.max >= 1)) {
        // Optional target with candidates: still ask.
        const resp = yield* this.ask({ type: 'chooseTargets', player, prompt, sourceId: sourceId ?? undefined, slots });
        if (resp.type === 'cancel') return null;
        targets = (resp as { targets: Target[][] }).targets;
      }
    } else {
      const resp = yield* this.ask({ type: 'chooseTargets', player, prompt, sourceId: sourceId ?? undefined, slots });
      if (resp.type === 'cancel') return null;
      targets = (resp as { targets: Target[][] }).targets;
    }
    // Flatten preserving slot order; pad empty slots with 'none'.
    const flat: Target[] = [];
    for (const slotTargets of targets) {
      if (slotTargets.length === 0) flat.push({ kind: 'none' });
      else flat.push(...slotTargets);
    }
    for (const t of flat) if (t.kind === 'object') this.emit({ name: 'becomesTarget', objectId: t.id, sourceId: sourceId ?? undefined, playerId: player });
    // Committing a crime: targeting an opponent, or anything they control or own.
    const crime = flat.some((t) =>
      t.kind === 'player'
        ? t.id !== player
        : t.kind === 'object'
          ? (() => {
              const o = this.state.objects[t.id];
              return !!o && (o.controller !== player || o.owner !== player);
            })()
          : false,
    );
    if (crime) this.emit({ name: 'committedCrime', playerId: player, sourceId: sourceId ?? undefined });
    return flat;
  }

  // -------------------------------------------------------------------------
  // Conditions, amounts, refs
  // -------------------------------------------------------------------------

  checkCondition(c: Condition, ctx: { sourceId: ObjectId | null; controller: PlayerId; triggerContext?: Record<string, unknown>; targets?: Target[]; x?: number; modes?: number[] }): boolean {
    const ectx: EffectContext = { sourceId: ctx.sourceId, controller: ctx.controller, targets: ctx.targets ?? [], triggerContext: ctx.triggerContext ?? {}, x: ctx.x ?? 0, modes: ctx.modes ?? [], memory: {} };
    const cmp = (a: number, op: string, b: number) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '==' ? a === b : op === '>' ? a > b : op === '<' ? a < b : a !== b);
    switch (c.kind) {
      case 'count':
        return cmp(objectsMatching(this, this.bindFilter(c.filter, ectx), { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x }).length, c.op, this.resolveAmount(c.value, ectx));
      case 'life': {
        const ps = this.resolvePlayers(c.ref, ectx);
        return ps.every((p) => cmp(this.player(p).life, c.op, this.resolveAmount(c.value, ectx)));
      }
      case 'yourTurn':
        return this.state.turn.activePlayer === ctx.controller;
      case 'notYourTurn':
        return this.state.turn.activePlayer !== ctx.controller;
      case 'handSize':
        return this.resolvePlayers(c.ref, ectx).every((p) => cmp(this.player(p).hand.length, c.op, this.resolveAmount(c.value, ectx)));
      case 'graveyard':
        return this.resolvePlayers(c.ref, ectx).every((p) => {
          const ids = this.player(p).graveyard.filter((id) => !c.filter || matchesFilter(this, this.obj(id), { ...c.filter, zone: 'graveyard' }, { sourceId: ctx.sourceId, controller: ctx.controller }));
          return cmp(ids.length, c.op, this.resolveAmount(c.value, ectx));
        });
      case 'objectMatches': {
        const objs = this.resolveObjects(c.ref, ectx);
        return objs.length > 0 && objs.every((o) => matchesFilter(this, o, { ...c.filter, zone: c.filter.zone ?? undefined }, { sourceId: ctx.sourceId, controller: ctx.controller }));
      }
      case 'hasCounter':
        return this.resolveObjects(c.ref, ectx).every((o) => cmp(o.counters[c.counter] ?? 0, c.op ?? '>=', c.value !== undefined ? this.resolveAmount(c.value, ectx) : 1));
      case 'isTapped':
        return this.resolveObjects(c.ref, ectx).every((o) => o.tapped);
      case 'isAttacking':
        return this.resolveObjects(c.ref, ectx).every((o) => o.attacking !== null);
      case 'isMonarch':
        return this.resolvePlayers(c.ref, ectx).every((p) => this.state.monarch === p);
      case 'castFrom': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return src?.castFromZone === c.zone;
      }
      case 'wasKicked': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return !!src?.additionalCostsPaid.includes('kicker');
      }
      case 'modeChosen':
        return (ctx.modes ?? []).includes(c.mode);
      case 'amount':
        return cmp(this.resolveAmount(c.a, ectx), c.op, this.resolveAmount(c.b, ectx));
      case 'memoryFlag': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return !!src?.memory[c.key];
      }
      case 'turnStat':
        return cmp(this.state.players[ctx.controller]?.turnStats[c.key] ?? 0, c.op, c.value);
      case 'controlsCommander':
        return this.state.battlefield.some((id) => this.obj(id).isCommander && this.obj(id).controller === ctx.controller);
      case 'commanderOnBattlefield':
        return this.state.battlefield.some((id) => this.obj(id).isCommander && this.obj(id).owner === ctx.controller);
      case 'inZone':
        return this.resolveObjects(c.ref, ectx).every((o) => o.zone === c.zone);
      case 'playerStat': {
        const ps = c.ref ? this.resolvePlayers(c.ref, ectx) : [ctx.controller];
        return ps.every((p) => cmp(this.player(p)[c.stat], c.op, this.resolveAmount(c.value, ectx)));
      }
      case 'hasInitiative': {
        const ps = c.ref ? this.resolvePlayers(c.ref, ectx) : [ctx.controller];
        return ps.every((p) => this.state.initiative === p);
      }
      case 'eventThisTurn': {
        const who: PlayerId[] = c.who ? this.resolvePlayers(c.who, ectx) : c.player === 'opponent' ? this.opponentsOf(ctx.controller) : c.player === 'any' ? this.activePlayers() : [ctx.controller];
        const total = who.reduce((n, p) => n + (this.state.turnStats[`${c.event}:${p}`] ?? 0), 0);
        return cmp(total, c.op ?? '>=', c.value ?? 1);
      }
      case 'not':
        return !this.checkCondition(c.c, ctx);
      case 'turnStep': {
        const t = this.state.turn;
        if (!c.steps.includes(t.step) && !c.steps.includes(t.phase)) return false;
        if (c.player === 'you' && t.activePlayer !== ctx.controller) return false;
        if (c.player === 'opponent' && t.activePlayer === ctx.controller) return false;
        if (c.beforeAttackers && t.attackers.length > 0) return false;
        return true;
      }
      case 'abilityResolvedThisTurn': {
        const key = (ctx.triggerContext as Record<string, unknown> | undefined)?.resolvedKey as string | undefined;
        return cmp(key ? (this.state.turnStats[key] ?? 0) : 0, c.op, c.value);
      }
      case 'ctxFlag':
        return !!((ctx as { memory?: Record<string, unknown> }).memory ?? ectx.memory)[c.key];
      case 'eventLastTurn': {
        const who = c.player ?? 'any';
        const players = who === 'you' ? [ctx.controller] : who === 'opponent' ? this.opponentsOf(ctx.controller) : this.state.playerOrder;
        const n = players.reduce((s, p) => s + (this.state.lastTurnStats[`${c.event}:${p}`] ?? 0), 0);
        return cmp(n, c.op ?? '>=', c.value ?? 1);
      }
      case 'opponentCompare': {
        const mine = c.what === 'life' ? this.player(ctx.controller).life : objectsMatching(this, { ...c.what, controller: 'you', zone: (c.what as import('./types.js').ObjectFilter).zone ?? 'battlefield' }, { sourceId: ctx.sourceId, controller: ctx.controller }).length;
        return this.opponentsOf(ctx.controller).some((o) => {
          const theirs = c.what === 'life' ? this.player(o).life : objectsMatching(this, { ...(c.what as import('./types.js').ObjectFilter), controller: 'you', zone: (c.what as import('./types.js').ObjectFilter).zone ?? 'battlefield' }, { sourceId: ctx.sourceId, controller: o }).length;
          return cmp(theirs, c.op, mine);
        });
      }
      case 'voteMost': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : undefined;
        const tally = ((src?.memory['votes'] ?? ctx.triggerContext?.['votes']) as Record<string, number> | undefined) ?? {};
        const mine = tally[c.option] ?? 0;
        return mine > 0 && Object.entries(tally).every(([k, v]) => k === c.option || v < mine);
      }
      case 'paired': {
        const o = this.resolveObjects(c.ref ?? { ref: 'self' }, { targets: [], triggerContext: {}, x: 0, modes: [], memory: {}, ...ctx })[0];
        return !!o && o.pairedWith !== null && o.pairedWith !== undefined && !!this.state.objects[o.pairedWith] && this.state.objects[o.pairedWith].zone === 'battlefield';
      }
      case 'faceDown': {
        const o = this.resolveObjects(c.ref ?? { ref: 'self' }, { targets: [], triggerContext: {}, x: 0, modes: [], memory: {}, ...ctx })[0];
        return !!o && o.faceDown;
      }
      case 'doorUnlocked': {
        const o = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : undefined;
        const doors = (o?.memory['unlockedDoors'] as number[] | undefined) ?? [];
        return c.not ? !doors.includes(c.door) : doors.includes(c.door);
      }
      case 'dayNight': {
        const v = this.state.dayNight;
        return c.is === 'neither' ? v === undefined : v === c.is;
      }
      case 'cityBlessing': {
        const pid = c.ref ? this.resolvePlayers(c.ref, { targets: [], triggerContext: {}, x: 0, modes: [], memory: {}, ...ctx })[0] : ctx.controller;
        const pl = pid !== undefined ? this.state.players[pid] : undefined;
        return !!pl?.flags['cityBlessing'];
      }
      case 'and':
        return c.cs.every((x) => this.checkCondition(x, ctx));
      case 'or':
        return c.cs.some((x) => this.checkCondition(x, ctx));
      case 'manual':
        return true; // asked interactively during resolution
    }
  }

  resolveAmount(a: Amount, ctx: EffectContext): number {
    if (typeof a === 'number') return a;
    if (a === 'X') return ctx.x;
    const fctx: FilterContext = { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x };
    switch (a.kind) {
      case 'count':
        return objectsMatching(this, this.bindFilter(a.filter, ctx), fctx).length + (a.plus ?? 0);
      case 'countersOn':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (a.counter === 'any' ? Object.values(o.counters).reduce((t, v) => t + (v ?? 0), 0) : (o.counters[a.counter] ?? 0)), 0);
      case 'power':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (this.characteristics(o.id).power ?? 0), 0);
      case 'toughness':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (this.characteristics(o.id).toughness ?? 0), 0);
      case 'manaValue':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + this.characteristics(o.id).manaValue, 0);
      case 'life':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).life, 0);
      case 'handSize':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).hand.length, 0);
      case 'graveyardSize':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).graveyard.filter((id) => !a.filter || matchesFilter(this, this.obj(id), { ...a.filter, zone: 'graveyard' }, fctx)).length, 0);
      case 'triggerAmount':
        return (ctx.triggerContext.triggerAmount as number) ?? 0;
      case 'devotion': {
        let n = 0;
        for (const id of this.state.battlefield) {
          const o = this.obj(id);
          if (o.controller !== ctx.controller) continue;
          const cost = this.characteristics(id).manaCost;
          for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
            const sym = m[1];
            if (a.colors.some((c) => sym.includes(c))) n++;
          }
        }
        return n;
      }
      case 'landsYouControl':
        return objectsMatching(this, { types: ['Land'], controller: 'you' }, fctx).length;
      case 'opponents':
        return this.opponentsOf(ctx.controller).length;
      case 'commanderTax': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return src ? src.commanderCasts * 2 : 0;
      }
      case 'cardsDrawnThisTurn':
        return this.player(ctx.controller).turnStats['drawCard'] ?? 0;
      case 'spellsCastThisTurn':
        return this.player(ctx.controller).spellsCastThisTurn;
      case 'turnStat':
        return this.player(ctx.controller).turnStats[a.key] ?? 0;
      case 'memory': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        const v = src?.memory[a.key];
        return typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0;
      }
      case 'sum':
        return a.parts.reduce<number>((s, p) => s + this.resolveAmount(p, ctx), 0);
      case 'times':
        return this.resolveAmount(a.a, ctx) * this.resolveAmount(a.b, ctx);
      case 'max':
        return Math.max(this.resolveAmount(a.a, ctx), this.resolveAmount(a.b, ctx));
      case 'minus':
        return Math.max(0, this.resolveAmount(a.a, ctx) - this.resolveAmount(a.b, ctx));
      case 'chosenNumber':
        return (ctx.memory['chosenNumber'] as number) ?? 0;
      case 'ctxMemory': {
        const v = ctx.memory[a.key];
        return typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0;
      }
      case 'half': {
        const v = this.resolveAmount(a.a, ctx);
        return a.round === 'up' ? Math.ceil(v / 2) : Math.floor(v / 2);
      }
      case 'librarySize':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).library.length, 0);
      case 'countRef':
        return this.resolveObjects(a.ref, ctx).filter((o) => !a.filter || matchesFilter(this, o, { ...a.filter, zone: a.filter.zone ?? o.zone }, fctx)).length;
      case 'partySize': {
        const roles = ['Cleric', 'Rogue', 'Warrior', 'Wizard'];
        const creatures = objectsMatching(this, { types: ['Creature'], controller: 'you', zone: 'battlefield' }, fctx).map((o) => this.characteristics(o.id));
        // Greedy assignment is exact for four roles: count distinct roles coverable by distinct creatures.
        const used = new Set<number>();
        let n = 0;
        for (const role of roles) {
          const i = creatures.findIndex((ch, idx) => !used.has(idx) && (ch.subtypes.includes(role) || ch.keywords.has('Changeling')));
          if (i >= 0) {
            used.add(i);
            n++;
          }
        }
        return n;
      }
      case 'kickCount': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return (src?.memory['kicks'] as number) ?? (src?.additionalCostsPaid.includes('kicker') ? 1 : 0);
      }
      case 'maxOf': {
        let best = 0;
        for (const o of objectsMatching(this, a.filter, fctx)) {
          const ch = this.characteristics(o.id);
          const v = a.stat === 'power' ? ch.power : a.stat === 'toughness' ? ch.toughness : ch.manaValue;
          if (v !== null && v > best) best = v;
        }
        return best;
      }
      case 'totalPower':
        return objectsMatching(this, a.filter, fctx).reduce((s, o) => s + (this.characteristics(o.id).power ?? 0), 0);
      case 'playerTurnStat': {
        if (a.key === 'attackedPlayers') return this.attackedPlayerCount(ctx.controller);
        if (a.opponents) return this.opponentsOf(ctx.controller).reduce((s, p) => s + (this.state.players[p]?.turnStats[a.key] ?? 0), 0);
        const pid = a.ref ? this.resolvePlayers(a.ref, ctx)[0] : ctx.controller;
        return pid !== undefined ? (this.state.players[pid]?.turnStats[a.key] ?? 0) : 0;
      }
      case 'distinctValues': {
        const vals = new Set<string | number>();
        for (const o of objectsMatching(this, a.filter, fctx)) {
          const ch = this.characteristics(o.id);
          vals.add(a.stat === 'name' ? ch.name : a.stat === 'manaValue' ? ch.manaValue : (ch[a.stat] ?? 0));
        }
        return vals.size;
      }
      case 'domain': {
        const types = new Set<string>();
        for (const id of this.state.battlefield) {
          const o = this.state.objects[id];
          if (!o || o.controller !== ctx.controller) continue;
          const ch = this.characteristics(id);
          if (!ch.types.includes('Land')) continue;
          for (const t of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) if (ch.subtypes.includes(t)) types.add(t);
        }
        return types.size;
      }
      case 'cardTypesAmong': {
        const types = new Set<string>();
        for (const o of objectsMatching(this, a.filter, fctx)) for (const t of this.characteristics(o.id).types) types.add(t);
        return types.size;
      }
      case 'manaSpent': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : undefined;
        const pool = (src?.memory['manaSpentPool'] as Record<string, number> | undefined) ?? {};
        if (a.of === 'total') return Object.values(pool).reduce((s, v) => s + v, 0);
        if (a.symbols) {
          const need: Record<string, number> = {};
          for (const sym of a.symbols.match(/\{([WUBRGC])\}/g) ?? []) {
            const k = sym.slice(1, -1);
            need[k] = (need[k] ?? 0) + 1;
          }
          const times = Object.entries(need).map(([k, n]) => Math.floor((pool[k] ?? 0) / n));
          return times.length ? Math.min(...times) : 0;
        }
        return Object.entries(pool).filter(([k, v]) => k !== 'C' && v > 0).length;
      }
      case 'voteCount': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : undefined;
        const tally = ((ctx.memory['votes'] ?? src?.memory['votes'] ?? ctx.triggerContext['votes']) as Record<string, number> | undefined) ?? {};
        return tally[a.option] ?? 0;
      }
      case 'commanderCasts':
        return this.state.battlefield.concat(this.player(ctx.controller).command, this.player(ctx.controller).graveyard, this.player(ctx.controller).exile)
          .map((id) => this.state.objects[id])
          .filter((o) => o && o.isCommander && o.owner === ctx.controller)
          .reduce((n, o) => n + o.commanderCasts, 0);
      case 'startingLife':
        return this.config.startingLife;
      case 'lastRoll':
        return (ctx.memory['lastRoll'] as number | undefined) ?? (ctx.triggerContext['rollResult'] as number | undefined) ?? 0;
      case 'colorCount': {
        if (a.filter) {
          const set = new Set<string>();
          for (const o of objectsMatching(this, this.bindFilter(a.filter, ctx), fctx)) for (const c of this.characteristics(o.id).colors) set.add(c);
          return set.size;
        }
        return a.ref ? this.resolveObjects(a.ref, ctx).reduce((s, o) => s + this.characteristics(o.id).colors.length, 0) : 0;
      }
      case 'totalToughness':
        return objectsMatching(this, this.bindFilter(a.filter, ctx), fctx).reduce((s, o) => s + (this.characteristics(o.id).toughness ?? 0), 0);
      case 'totalManaValue':
        return objectsMatching(this, a.filter, fctx).reduce((s, o) => s + this.characteristics(o.id).manaValue, 0);
      case 'eventsThisTurn': {
        const who = a.player ?? 'any';
        const players = who === 'you' ? [ctx.controller] : who === 'opponent' ? this.opponentsOf(ctx.controller) : this.state.playerOrder;
        return players.reduce((s, p) => s + (this.state.players[p]?.turnStats[a.event] ?? 0), 0);
      }
      case 'discardedThisWay':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + ((ctx.memory[`discarded:${p}`] as number) ?? 0), 0);
      case 'differenceLife': {
        const f = this.resolvePlayers(a.from, ctx)[0];
        const t = this.resolvePlayers(a.to, ctx)[0];
        return f && t ? Math.max(0, this.player(f).life - this.player(t).life) : 0;
      }
    }
  }

  /** Bind a filter's `controllerRef` to a concrete player for this effect context. */
  bindFilter(filter: import('./types.js').ObjectFilter, ctx: EffectContext): import('./types.js').ObjectFilter {
    if (!filter.controllerRef) return filter;
    const p = this.resolvePlayers(filter.controllerRef, ctx)[0];
    const { controllerRef: _cr, ...rest } = filter;
    void _cr;
    return p ? { ...rest, controller: p } : { ...rest, controller: '__nobody__' };
  }

  /** Resolve a Ref to concrete targets (objects and/or players). */
  resolveRef(ref: Ref, ctx: EffectContext): Target[] {
    const objT = (ids: (ObjectId | undefined | null)[]): Target[] => ids.filter((x): x is ObjectId => typeof x === 'number' && !!this.state.objects[x]).map((id) => ({ kind: 'object', id }));
    const plT = (ids: (PlayerId | undefined)[]): Target[] => ids.filter((x): x is PlayerId => typeof x === 'string' && !!this.state.players[x]).map((id) => ({ kind: 'player', id }));
    switch (ref.ref) {
      case 'target': {
        const slot = ref.slot ?? 0;
        // Targets are flattened: slot i corresponds to index i when each slot has one target.
        // For multi-target slots the caller passes them all as consecutive entries; we return all
        // targets when slot is 0 and there is exactly one spec, else the indexed one.
        if (ctx.targetSlots) {
          const s = ctx.targetSlots[slot];
          return s ? s.filter((t) => t.kind !== 'none') : [];
        }
        const t = ctx.targets[slot];
        return t && t.kind !== 'none' ? [t] : [];
      }
      case 'self':
        return objT([ctx.sourceId]);
      case 'controller':
        return plT([ctx.controller]);
      case 'owner':
        return plT([ctx.sourceId !== null ? this.state.objects[ctx.sourceId]?.owner : undefined]);
      case 'eachOpponent':
        return plT(this.opponentsOf(ctx.controller));
      case 'defenderOf': {
        const out: Target[] = [];
        for (const o of this.resolveObjects(ref.of, ctx)) {
          if (o.attacking === null || o.attacking === undefined) continue;
          out.push(typeof o.attacking === 'string' ? { kind: 'player', id: o.attacking } : { kind: 'object', id: o.attacking as ObjectId });
        }
        return out;
      }
      case 'eachOtherOpponent': {
        const tp = (ctx.triggerContext.triggerPlayer ?? ctx.triggerContext.playerId) as PlayerId | undefined;
        return plT(this.opponentsOf(ctx.controller).filter((p) => p !== tp));
      }
      case 'eachPlayer':
        return plT(this.apnap());
      case 'triggerObject':
        return objT([ctx.triggerContext.triggerObject as ObjectId]);
      case 'triggerPlayer':
        return plT([ctx.triggerContext.triggerPlayer as PlayerId]);
      case 'triggerSource':
        return objT([ctx.triggerContext.triggerSource as ObjectId]);
      case 'triggerController': {
        const id = ctx.triggerContext.triggerObject as ObjectId;
        const snap = ctx.triggerContext.triggerSnapshot as GameObject | undefined;
        const o = this.state.objects[id];
        return plT([o?.controller ?? snap?.controller]);
      }
      case 'attachedTo':
        return objT([ctx.sourceId !== null ? this.state.objects[ctx.sourceId]?.attachedTo : undefined]);
      case 'attachments':
        return objT(ctx.sourceId !== null ? this.state.objects[ctx.sourceId]?.attachments ?? [] : []);
      case 'all':
        return objT(objectsMatching(this, this.bindFilter(ref.filter, ctx), { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x }).map((o) => o.id));
      case 'iter':
        return ctx.iter ? [ctx.iter] : [];
      case 'players':
        return ref.of.flatMap((r) => this.resolveRef(r, ctx));
      case 'lastCreated':
        return objT((ctx.memory['lastCreated'] as ObjectId[]) ?? []);
      case 'lastMoved':
        return objT((ctx.memory['lastMoved'] as ObjectId[]) ?? []);
      case 'lastDiscarded':
        return objT((ctx.memory['lastDiscarded'] as ObjectId[]) ?? []);
      case 'memory': {
        const fromCtx = ctx.memory[ref.key] as ObjectId[] | undefined;
        if (fromCtx) return objT(fromCtx);
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return objT((src?.memory[ref.key] as ObjectId[] | undefined) ?? []);
      }
      case 'defendingPlayer': {
        const d = ctx.triggerContext.triggerOtherPlayer as PlayerId | undefined;
        if (d) return plT([d]);
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        if (src && typeof src.attacking === 'string') return plT([src.attacking]);
        if (src && typeof src.attacking === 'number') return plT([this.state.objects[src.attacking]?.controller]);
        return [];
      }
      case 'activePlayer':
        return plT([this.state.turn.activePlayer]);
      case 'chosen': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        const v = (ctx.memory[ref.key] ?? src?.memory[ref.key] ?? ctx.triggerContext[ref.key]) as ObjectId[] | PlayerId | undefined;
        if (Array.isArray(v)) return objT(v);
        if (typeof v === 'string') return plT([v]);
        return [];
      }
      case 'triggerStackItem': {
        const sid = (ctx.triggerContext['stackItemId'] ?? (ctx.triggerContext['triggerData'] as { stackItemId?: number } | undefined)?.stackItemId) as number | undefined;
        if (sid !== undefined && this.state.stack.some((s) => s.id === sid)) return [{ kind: 'stackItem', id: sid }];
        const top = this.state.stack[this.state.stack.length - 1];
        return top ? [{ kind: 'stackItem', id: top.id }] : [];
      }
      case 'stackTarget': {
        const t = ctx.targets.find((x) => x.kind === 'stackItem');
        return t ? [t] : [];
      }
      case 'player':
        return plT([ref.id]);
      case 'controllerOf':
        return plT([...new Set(this.resolveRef(ref.of, ctx).map((t) => (t.kind === 'object' ? this.state.objects[t.id]?.controller : t.kind === 'stackItem' ? this.state.stack.find((s) => s.id === t.id)?.controller : t.kind === 'player' ? t.id : undefined)))]);
      case 'ownerOf':
        return plT([...new Set(this.resolveRef(ref.of, ctx).map((t) => (t.kind === 'object' ? this.state.objects[t.id]?.owner : t.kind === 'player' ? t.id : undefined)))]);
      case 'blockersOf':
        return objT(this.resolveObjects(ref.of, ctx).flatMap((o) => o.blockedBy));
      case 'ringBearer':
        return objT(this.state.battlefield.filter((id) => this.obj(id).controller === ctx.controller && this.characteristics(id).rules.some((r) => r.kind === 'custom' && r.tag === 'ringBearer')));
    }
  }
  resolveObjects(ref: Ref, ctx: EffectContext): GameObject[] {
    return this.resolveRef(ref, ctx)
      .filter((t): t is { kind: 'object'; id: ObjectId } => t.kind === 'object')
      .map((t) => this.state.objects[t.id])
      .filter(Boolean);
  }
  resolvePlayers(ref: Ref, ctx: EffectContext): PlayerId[] {
    return this.resolveRef(ref, ctx)
      .map((t) => (t.kind === 'player' ? t.id : t.kind === 'object' ? this.state.objects[t.id]?.controller : undefined))
      .filter((x): x is PlayerId => !!x && !this.player(x).lost);
  }

  // -------------------------------------------------------------------------
  // Continuous effects
  // -------------------------------------------------------------------------

  addContinuousEffect(ce: Omit<ContinuousEffect, 'id' | 'timestamp'>): ContinuousEffect {
    const full: ContinuousEffect = { ...ce, id: this.state.nextEffectId++, timestamp: this.now() };
    this.state.continuousEffects.push(full);
    this.touch();
    return full;
  }
  expireEffects(duration: ContinuousEffect['duration']) {
    const before = this.state.continuousEffects.length;
    this.state.continuousEffects = this.state.continuousEffects.filter((ce) => ce.duration !== duration);
    if (duration === 'thisTurn' && this.state.delayedTriggers.some((dt) => dt.thisTurn)) this.state.delayedTriggers = this.state.delayedTriggers.filter((dt) => !dt.thisTurn);
    if (this.state.continuousEffects.length !== before) this.touch();
  }

  /** Creature types present in the game (for "choose a creature type" prompts). */
  creatureTypeOptions(): string[] {
    const types = new Set<string>();
    for (const o of Object.values(this.state.objects)) if (this.characteristics(o.id).types.includes('Creature')) this.characteristics(o.id).subtypes.forEach((s) => types.add(s));
    const out = [...types].sort();
    return out.length ? out : ['Human'];
  }

  /** Drop effects whose duration is tied to the source staying tapped / under its controller's control. */
  pruneConditionalDurations() {
    const before = this.state.continuousEffects.length;
    this.state.continuousEffects = this.state.continuousEffects.filter((ce) => {
      if (ce.duration !== 'whileSourceTapped' && ce.duration !== 'whileYouControlSource') return true;
      const src = ce.sourceId !== null ? this.state.objects[ce.sourceId] : undefined;
      if (!src || src.zone !== 'battlefield') return false;
      // Both flavours end when the source leaves or changes control; "remains tapped" also ends when it untaps.
      if (src.controller !== ce.controller) return false;
      return ce.duration === 'whileSourceTapped' ? src.tapped : true;
    });
    if (this.state.continuousEffects.length !== before) this.touch();
  }

  // -------------------------------------------------------------------------
  // Player-level primitives
  // -------------------------------------------------------------------------

  drawCards(pid: PlayerId, n: number): ObjectId[] {
    const p = this.player(pid);
    const drawn: ObjectId[] = [];
    if (n > 0 && this.playerRules(pid).some((r) => r.kind === 'custom' && r.tag === 'cantDraw')) {
      this.log(`${p.name} cannot draw cards.`);
      return drawn;
    }
    for (let i = 0; i < n; i++) {
      // Draw replacements ("If you would draw a card, draw two cards instead").
      const repl = this.drawReplacementFor(pid);
      if (repl) {
        if (repl.ab.effects?.length) {
          this.state.turnStats[`drawReplaced:${pid}`] = (this.state.turnStats[`drawReplaced:${pid}`] ?? 0) + 1;
          this.pendingTriggers.push({ sourceId: repl.sourceId, controller: pid, ability: { kind: 'triggered', text: repl.ab.text, event: 'drawCard', effects: repl.ab.effects }, context: { playerId: pid } });
          continue;
        }
        if (repl.ab.draws !== undefined && repl.ab.draws !== 1) {
          this.state.turnStats[`drawReplacing:${pid}`] = 1;
          const extra = this.drawCards(pid, repl.ab.draws);
          delete this.state.turnStats[`drawReplacing:${pid}`];
          drawn.push(...extra);
          continue;
        }
      }
      const id = p.library.shift();
      if (id === undefined) {
        p.attemptedDrawFromEmpty = true;
        this.log(`${p.name} tries to draw from an empty library.`);
        break;
      }
      const o = this.obj(id);
      o.zone = 'hand';
      o.timestamp = this.now();
      p.hand.push(id);
      drawn.push(id);
      this.touch();
      this.emit({ name: 'drawCard', objectId: id, playerId: pid, fromZone: 'library', toZone: 'hand' });
    }
    if (drawn.length) this.log(`${p.name} draws ${drawn.length} card${drawn.length === 1 ? '' : 's'}.`, { kind: 'draw', data: { player: pid, count: drawn.length } });
    return drawn;
  }

  /** The draw replacement that applies to this player's next draw, if any. */
  private drawReplacementFor(pid: PlayerId): { ab: Extract<import('./script.js').ReplacementSpec, { event: 'drawCard' }>; sourceId: ObjectId } | null {
    if (this.state.turnStats[`drawReplacing:${pid}`]) return null; // don't re-replace the replacement draws
    for (const id of this.state.battlefield) {
      const src = this.state.objects[id];
      if (!src) continue;
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind !== 'replacement' || ab.event !== 'drawCard') continue;
        const applies = ab.who === 'any' || (ab.who === 'you' && src.controller === pid) || (ab.who === 'opponent' && src.controller !== pid);
        if (!applies) continue;
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: id, controller: pid })) continue;
        if (ab.exceptFirstEachDrawStep && !(this.player(pid).turnStats['drawCard'] ?? 0)) continue;
        return { ab, sourceId: id };
      }
    }
    return null;
  }

  gainLife(pid: PlayerId, n: number, sourceId?: ObjectId) {
    if (n <= 0) return;
    const p = this.player(pid);
    if (this.playerRules(pid).some((r) => r.kind === 'cantGainLife')) return;
    // Lifegain replacement (e.g. doubling) from scripts
    let amount = n;
    for (const src of this.state.battlefield.map((id) => this.obj(id))) {
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind === 'replacement' && ab.event === 'lifeGain') {
          const applies = (ab.who === 'you' && src.controller === pid) || (ab.who === 'opponent' && src.controller !== pid);
          if (!applies) continue;
          if (ab.multiply) amount *= ab.multiply;
          if (ab.add) amount += ab.add;
        }
      }
    }
    p.life += amount;
    this.touch();
    this.log(`${p.name} gains ${amount} life (${p.life}).`, { kind: 'life', data: { player: pid, delta: amount, life: p.life } });
    this.state.turnStats[`lifeGainedAmount:${pid}`] = (this.state.turnStats[`lifeGainedAmount:${pid}`] ?? 0) + amount;
    this.player(pid).turnStats['lifeGainedAmount'] = (this.player(pid).turnStats['lifeGainedAmount'] ?? 0) + amount;
    this.emit({ name: 'lifeGained', playerId: pid, amount, sourceId });
  }

  loseLife(pid: PlayerId, n: number, sourceId?: ObjectId) {
    if (n <= 0) return;
    const p = this.player(pid);
    // "Damage that would reduce your life total to less than 1 reduces it to 1 instead."
    let floor: number | null = null;
    for (const r of this.playerRules(pid)) if (r.kind === 'custom' && r.tag === 'lifeFloor' && typeof r.data === 'number') floor = Math.max(floor ?? 0, r.data);
    if (floor !== null && p.life - n < floor) n = Math.max(0, p.life - floor);
    if (n <= 0) return;
    p.life -= n;
    this.touch();
    this.log(`${p.name} loses ${n} life (${p.life}).`, { kind: 'life', data: { player: pid, delta: -n, life: p.life } });
    this.state.turnStats[`lifeLostAmount:${pid}`] = (this.state.turnStats[`lifeLostAmount:${pid}`] ?? 0) + n;
    p.turnStats['lifeLostAmount'] = (p.turnStats['lifeLostAmount'] ?? 0) + n;
    this.emit({ name: 'lifeLost', playerId: pid, amount: n, sourceId });
  }

  /** Deal damage from a source to a target (object or player). Handles infect, wither, lifelink, deathtouch, prevention. */
  /** Does a turn-wide prevention effect stop this damage? */
  /** How much of this damage a turn-wide prevention effect stops (0 = none, Infinity = all of it). */
  private preventedByFog(sourceId: ObjectId | null, target: Target, combat: boolean, amount = 0): number {
    if (this.state.turnStats['noPrevention']) return 0;
    const src = sourceId !== null ? this.state.objects[sourceId] : null;
    // "Prevent all (combat) damage that would be dealt by [this source] this turn."
    if (src && src.zone === 'battlefield') {
      const noDmg = this.characteristics(src.id).rules.find((r) => r.kind === 'custom' && (r.tag === 'dealsNoDamage' || r.tag === 'dealsAndTakesNoDamage')) as { data?: string } | undefined;
      if (noDmg && (noDmg.data === 'combat' ? combat : noDmg.data === 'noncombat' ? !combat : true)) return Infinity;
    }
    // "If damage would be dealt to ~, prevent that damage and put that many +1/+1 counters on it." (a replacement on the recipient)
    if (target.kind === 'object') {
      const tobj = this.state.objects[target.id];
      // "Prevent all combat damage that would be dealt to and dealt by enchanted creature."
      if (tobj && tobj.zone === 'battlefield') {
        const noTake = this.characteristics(tobj.id).rules.find((r) => r.kind === 'custom' && r.tag === 'dealsAndTakesNoDamage') as { data?: string } | undefined;
        if (noTake && (noTake.data === 'combat' ? combat : true)) return Infinity;
      }
      if (tobj && tobj.zone === 'battlefield') {
        for (const ab of this.scriptFor(tobj).abilities) {
          if (ab.kind !== 'replacement' || ab.event !== 'damage' || ab.to !== 'self' || ab.prevent !== 'all') continue;
          if (ab.combatOnly && !combat) continue;
          if (ab.condition && !this.checkCondition(ab.condition, { sourceId: tobj.id, controller: tobj.controller })) continue;
          if (ab.fromFilter && (!src || !matchesFilter(this, src, { ...ab.fromFilter, zone: undefined }, { sourceId: tobj.id, controller: tobj.controller }))) continue;
          const eff = (ab as { effects?: import('./script.js').Effect[] }).effects;
          if (eff?.length) this.pendingTriggers.push({ sourceId: tobj.id, controller: tobj.controller, ability: { kind: 'triggered', text: ab.text, event: 'dealtDamage', effects: eff }, context: { triggerAmount: amount, amount, objectId: tobj.id, sourceId } });
          return Infinity;
        }
      }
    }
    // "Prevent all damage that would be dealt to ~ by artifact creatures." (a static on the recipient)
    {
      type PD = { data?: { combat?: 'combat' | 'noncombat'; source?: import('./types.js').ObjectFilter; amount?: number } };
      const rules = target.kind === 'object' && this.state.objects[target.id]?.zone === 'battlefield' ? this.characteristics(target.id).rules : target.kind === 'player' ? this.playerRules(target.id) : [];
      for (const r of rules) {
        if (r.kind !== 'custom' || r.tag !== 'preventDamageTo') continue;
        const d = (r as PD).data ?? {};
        if (d.combat === 'combat' && !combat) continue;
        if (d.combat === 'noncombat' && combat) continue;
        if (d.source && (!src || !matchesFilter(this, src, { ...d.source, zone: undefined }, { sourceId: target.kind === 'object' ? target.id : src.id, controller: src.controller }))) continue;
        // "prevent 1 of that damage" only stops part of it.
        return d.amount !== undefined ? Math.min(d.amount, amount) : Infinity;
      }
    }
    if (!this.state.preventions.length) return 0;
    for (const pv of this.state.preventions) {
      if (pv.combat && !combat) continue;
      if (pv.sourceIds && (sourceId === null || !pv.sourceIds.includes(sourceId))) continue;
      if (pv.source && (!src || !matchesFilter(this, src, { ...pv.source, zone: undefined }, { sourceId: pv.sourceId, controller: pv.controller }))) continue;
      const to = pv.to;
      let hit = false;
      if (pv.ids || pv.playerIds) hit = target.kind === 'object' ? !!pv.ids?.includes(target.id) : target.kind === 'player' ? !!pv.playerIds?.includes(target.id) : false;
      else if (to === 'all') hit = true;
      else if (target.kind === 'player') hit = to === 'players' || ((to === 'you' || to === 'youAndCreaturesYouControl' || to === 'youAndPlaneswalkersYouControl') && target.id === pv.controller);
      else if (target.kind === 'object') {
        const obj = this.state.objects[target.id];
        if (obj) {
          if (to === 'creatures') hit = true;
          else if ((to === 'creaturesYouControl' || to === 'youAndCreaturesYouControl') && obj.controller === pv.controller) hit = true;
          else if (to === 'youAndPlaneswalkersYouControl' && obj.controller === pv.controller && this.characteristics(obj.id).types.includes('Planeswalker')) hit = true;
          else if (typeof to === 'object' && matchesFilter(this, obj, { ...to, zone: undefined }, { sourceId: pv.sourceId, controller: pv.controller })) hit = true;
        }
      }
      if (!hit) continue;
      // A shield prevents at most `amount` and wears off once used up.
      const stopped = pv.amount === undefined ? Infinity : Math.min(pv.amount, amount);
      if (pv.amount !== undefined) {
        pv.amount -= stopped;
        if (pv.amount <= 0) this.state.preventions = this.state.preventions.filter((x) => x !== pv);
      } else if (pv.once) this.state.preventions = this.state.preventions.filter((x) => x !== pv);
      if (pv.effects?.length) {
        // "…prevent that damage. You gain life equal to the damage prevented this way."
        const prevented = stopped === Infinity ? amount : stopped;
        this.pendingTriggers.push({ sourceId: pv.sourceId ?? -1, controller: pv.controller, ability: { kind: 'triggered', text: 'Prevention follow-up', event: 'dealtDamage', effects: pv.effects }, context: { triggerAmount: prevented, amount: prevented, sourceId: pv.sourceId ?? undefined } });
      }
      return stopped;
    }
    return 0;
  }

  dealDamage(sourceId: ObjectId | null, target: Target, amount: number, combat: boolean): number {
    if (amount <= 0) return 0;
    // Redirection: "All damage that would be dealt to you and other permanents you control is dealt to ~ instead."
    for (const id of this.state.battlefield) {
      const holder = this.state.objects[id];
      if (!holder || (target.kind === 'object' && target.id === id)) continue;
      const rule = this.characteristics(id).rules.find((r) => r.kind === 'custom' && r.tag === 'redirectDamage') as { data?: { player?: boolean; permanents?: boolean; combatOnly?: boolean } } | undefined;
      if (!rule) continue;
      const d = rule.data ?? {};
      if (d.combatOnly && !combat) continue;
      const hit = (target.kind === 'player' && d.player && target.id === holder.controller) || (target.kind === 'object' && d.permanents && this.state.objects[target.id]?.controller === holder.controller);
      if (!hit) continue;
      this.log(`Damage is redirected to ${this.nameOf(id)}.`);
      target = { kind: 'object', id };
      break;
    }
    {
      const stopped = this.preventedByFog(sourceId, target, combat, amount);
      if (stopped > 0) {
        const name = target.kind === 'player' ? this.player(target.id).name : target.kind === 'object' ? this.nameOf(target.id) : 'something';
        if (stopped >= amount) {
          this.log(`Damage to ${name} is prevented.`);
          return 0;
        }
        this.log(`${stopped} damage to ${name} is prevented.`);
        amount -= stopped;
      }
    }
    const src = sourceId !== null ? this.state.objects[sourceId] : null;
    const sch = src ? this.characteristics(src.id) : null;
    const controller = src?.controller;
    let dealt = amount;
    // "If a source you control would deal damage, it deals double that damage instead."
    for (const id of this.state.battlefield) {
      const holder = this.state.objects[id];
      if (!holder) continue;
      for (const r of this.characteristics(id).rules) {
        if (r.kind !== 'custom' || (r.tag !== 'damageMultiplier' && r.tag !== 'damagePlus')) continue;
        const d = r.data as { filter?: import('./types.js').ObjectFilter; times?: number; plus?: number | Amount; combatOnly?: boolean; noncombatOnly?: boolean; toOpponents?: boolean } | undefined;
        if (!d) continue;
        if (d.combatOnly && !combat) continue;
        if (d.noncombatOnly && combat) continue;
        if (d.toOpponents) {
          const tc = target.kind === 'player' ? target.id : target.kind === 'object' ? this.state.objects[target.id]?.controller : undefined;
          if (tc === undefined || tc === holder.controller) continue;
        }
        if (d.filter && (!src || !matchesFilter(this, src, { ...d.filter, zone: undefined }, { sourceId: id, controller: holder.controller }))) continue;
        if (r.tag === 'damageMultiplier') dealt *= d.times ?? 1;
        else dealt += typeof d.plus === 'number' ? d.plus : d.plus ? this.resolveAmount(d.plus, { sourceId: id, controller: holder.controller, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} }) : 0;
      }
    }
    if (target.kind === 'player') {
      const p = this.player(target.id);
      // Prevention rules on player
      if (!this.state.turnStats['noPrevention']) for (const r of this.playerRules(target.id)) if (r.kind === 'damagePrevention') dealt = r.amount === 'all' ? 0 : Math.max(0, dealt - r.amount);
      if (dealt <= 0) return 0;
      if (sch?.keywords.has('Infect')) {
        p.poison += dealt;
        this.log(`${this.nameOf(sourceId!)} deals ${dealt} damage to ${p.name} as poison counters (${p.poison}).`);
      } else {
        p.life -= dealt;
        this.log(`${src ? this.nameOf(src.id) : 'Something'} deals ${dealt} damage to ${p.name} (${p.life}).`, { kind: 'damage', data: { player: target.id, amount: dealt, sourceId } });
        if (combat && src?.isCommander) {
          p.commanderDamage[src.id] = (p.commanderDamage[src.id] ?? 0) + dealt;
        }
        if (combat && this.state.initiative === target.id && src && src.controller !== target.id) this.pendingInitiative = src.controller;
      }
      if (sch?.keywords.has('Toxic') && combat) {
        const tox = parseInt(sch.oracleText.match(/Toxic (\d+)/)?.[1] ?? '1', 10);
        p.poison += tox;
      }
      p.turnStats['damageTaken'] = (p.turnStats['damageTaken'] ?? 0) + dealt;
      this.touch();
      this.emit({ name: 'dealsDamage', sourceId: sourceId ?? undefined, playerId: target.id, amount: dealt, combat, otherPlayerId: controller });
      this.emit({ name: 'dealtDamage', sourceId: sourceId ?? undefined, playerId: target.id, amount: dealt, combat, otherPlayerId: controller });
      if (combat) {
        this.emit({ name: 'dealsCombatDamage', sourceId: sourceId ?? undefined, playerId: target.id, amount: dealt, combat: true, otherPlayerId: controller });
        this.emit({ name: 'dealtCombatDamageToPlayer', sourceId: sourceId ?? undefined, objectId: sourceId ?? undefined, playerId: target.id, amount: dealt, combat: true, otherPlayerId: controller });
      }
    } else if (target.kind === 'object') {
      const obj = this.state.objects[target.id];
      if (!obj || obj.zone !== 'battlefield') return 0;
      const ch = this.characteristics(obj.id);
      // Protection prevents damage from sources with that quality.
      if (sch) {
        for (const prot of ch.protections) {
          const { protectionApplies } = require_filters();
          if (protectionApplies(prot, sch.colors, sch.types, sch.subtypes, src!.controller !== obj.controller)) return 0;
        }
      }
      for (const r of ch.rules) if (r.kind === 'damagePrevention') dealt = r.amount === 'all' ? 0 : Math.max(0, dealt - r.amount);
      if (dealt <= 0) return 0;
      if (ch.types.includes('Planeswalker')) {
        obj.counters['loyalty'] = Math.max(0, (obj.counters['loyalty'] ?? 0) - dealt);
      } else if (ch.types.includes('Battle')) {
        obj.counters['defense'] = Math.max(0, (obj.counters['defense'] ?? 0) - dealt);
      } else if (sch?.keywords.has('Infect') || sch?.keywords.has('Wither')) {
        obj.counters['-1/-1'] = (obj.counters['-1/-1'] ?? 0) + dealt;
      } else {
        obj.damage += dealt;
        if (sch?.keywords.has('Deathtouch')) obj.deathtouchDamage = true;
      }
      if (src) (this.state.damagedBy[obj.id] ??= []).push(src.id);
      this.touch();
      this.log(`${src ? this.nameOf(src.id) : 'Something'} deals ${dealt} damage to ${this.nameOf(obj.id)}.`, { kind: 'damage', data: { objectId: obj.id, amount: dealt, sourceId } });
      this.emit({ name: 'dealsDamage', sourceId: sourceId ?? undefined, objectId: obj.id, amount: dealt, combat, otherPlayerId: controller });
      this.emit({ name: 'dealtDamage', sourceId: sourceId ?? undefined, objectId: obj.id, amount: dealt, combat, playerId: undefined, otherPlayerId: controller });
      if (combat) this.emit({ name: 'dealsCombatDamage', sourceId: sourceId ?? undefined, objectId: obj.id, amount: dealt, combat: true, otherPlayerId: controller });
    } else return 0;
    if (sch?.keywords.has('Lifelink') && src) this.gainLife(src.controller, dealt, src.id);
    return dealt;
  }

  tap(id: ObjectId) {
    const o = this.state.objects[id];
    if (!o || o.tapped || o.zone !== 'battlefield') return;
    o.tapped = true;
    this.touch();
    this.emit({ name: 'tapped', objectId: id, playerId: o.controller });
  }
  untap(id: ObjectId) {
    const o = this.state.objects[id];
    if (!o || !o.tapped) return;
    o.tapped = false;
    this.touch();
    this.emit({ name: 'untapped', objectId: id, playerId: o.controller });
  }
  addCounters(id: ObjectId, type: string, n: number, sourceId?: ObjectId) {
    const o = this.state.objects[id];
    if (!o || n <= 0) return;
    // Counter-doubling replacements (e.g. Doubling Season / Hardened Scales)
    let amount = n;
    for (const src of this.state.battlefield.map((x) => this.obj(x))) {
      if (src.controller !== o.controller) continue;
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind === 'replacement' && ab.event === 'counterAdded') {
          if (ab.counterType && ab.counterType !== type) continue;
          if (ab.filter && !matchesFilter(this, o, ab.filter, { sourceId: src.id, controller: src.controller })) continue;
          if (ab.multiply) amount *= ab.multiply;
          amount += ab.extra;
        }
      }
    }
    o.counters[type] = (o.counters[type] ?? 0) + amount;
    this.touch();
    this.log(`${amount} ${type} counter${amount === 1 ? '' : 's'} placed on ${this.nameOf(id)}.`, { kind: 'counters', data: { objectId: id, type, delta: amount } });
    for (let i = 0; i < amount; i++) this.emit({ name: 'counterAdded', objectId: id, counterType: type, amount: 1, playerId: o.controller, sourceId });
  }
  removeCounters(id: ObjectId, type: string, n: number) {
    const o = this.state.objects[id];
    if (!o) return 0;
    const have = o.counters[type] ?? 0;
    const removed = Math.min(have, n);
    if (removed <= 0) return 0;
    o.counters[type] = have - removed;
    if (o.counters[type] === 0) delete o.counters[type];
    this.touch();
    for (let i = 0; i < removed; i++) this.emit({ name: 'counterRemoved', objectId: id, counterType: type, amount: 1, playerId: o.controller });
    return removed;
  }
  shuffleLibrary(pid: PlayerId) {
    const p = this.player(pid);
    this.rng.shuffle(p.library);
    this.touch();
    this.log(`${p.name} shuffles.`);
    this.emit({ name: 'shuffle', playerId: pid });
  }

  playerLoses(pid: PlayerId, reason: string) {
    const p = this.player(pid);
    if (p.lost) return;
    p.lost = true;
    p.lossReason = reason;
    this.log(`${p.name} loses the game: ${reason}.`, { kind: 'loss', data: { player: pid, reason } });
    // Rule 800.4a: all objects owned by the player leave the game; effects giving them control end.
    for (const obj of Object.values(this.state.objects)) {
      if (obj.owner === pid) {
        this.removeFromZone(obj);
        delete this.state.objects[obj.id];
      } else if (obj.controller === pid && obj.zone === 'battlefield') {
        obj.controller = obj.owner;
      }
    }
    this.state.stack = this.state.stack.filter((s) => s.controller !== pid && this.state.objects[s.sourceId]);
    this.state.continuousEffects = this.state.continuousEffects.filter((ce) => ce.controller !== pid);
    if (this.state.monarch === pid) this.state.monarch = null;
    this.touch();
    this.emit({ name: 'playerLost', playerId: pid });
    const alive = this.activePlayers();
    if (alive.length === 1) {
      this.state.winner = alive[0];
      this.state.over = true;
      this.log(`${this.player(alive[0]).name} wins the game!`, { kind: 'win', data: { player: alive[0] } });
    } else if (alive.length === 0) {
      this.state.over = true;
      this.log('The game is a draw.');
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private *play(): Gen {
    this.log('Game start. Turn order: ' + this.state.playerOrder.map((p) => this.player(p).name).join(', '));
    yield* this.mulligans();
    let first = true;
    while (!this.state.over) {
      const next = this.state.turn.extraTurns.shift() ?? (first ? this.state.playerOrder[0] : this.nextPlayerAfter(this.state.turn.activePlayer));
      first = false;
      if (this.player(next).lost) continue;
      yield* this.takeTurn(next);
    }
  }

  private *mulligans(): Gen {
    for (const pid of this.state.playerOrder) this.drawCards(pid, this.config.startingHandSize);
    let anyPending = true;
    while (anyPending) {
      anyPending = false;
      for (const pid of this.state.playerOrder) {
        const p = this.player(pid);
        if (p.keptHand) continue;
        const resp = yield* this.ask({ type: 'mulligan', player: pid, prompt: `Keep this hand? (mulligans taken: ${p.mulligansTaken})`, hand: [...p.hand], mulligansTaken: p.mulligansTaken });
        if (resp.type !== 'mulligan') continue;
        if (resp.keep) {
          // London mulligan: bottom N cards where N = mulligans taken (first is free in Commander).
          const toBottom = Math.max(0, p.mulligansTaken - (this.config.freeMulligan ? 1 : 0));
          if (toBottom > 0) {
            let bottom = resp.bottom ?? [];
            if (bottom.length !== toBottom || bottom.some((id) => !p.hand.includes(id))) {
              const r2 = yield* this.ask({ type: 'chooseObjects', player: pid, prompt: `Put ${toBottom} card${toBottom === 1 ? '' : 's'} on the bottom of your library`, candidates: [...p.hand], min: toBottom, max: toBottom, revealToChooser: true });
              bottom = r2.type === 'objects' ? r2.ids : p.hand.slice(0, toBottom);
            }
            for (const id of bottom) this.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
          }
          p.keptHand = true;
          this.log(`${p.name} keeps ${p.hand.length} cards.`);
        } else {
          for (const id of [...p.hand]) this.moveObject(id, 'library', { position: 'bottom', skipEvents: true });
          this.shuffleLibrary(pid);
          p.mulligansTaken++;
          this.drawCards(pid, this.config.startingHandSize);
          anyPending = true;
        }
      }
    }
    this.pendingTriggers = []; // draws during mulligan don't trigger anything
    // Leylines: "If ~ is in your opening hand, you may begin the game with it on the battlefield."
    for (const pid of this.state.playerOrder) {
      for (const id of [...this.player(pid).hand]) {
        const o = this.state.objects[id];
        if (!o || !this.scriptFor(o).abilities.some((ab) => ab.kind === 'static' && ab.rule?.kind === 'custom' && ab.rule.tag === 'leyline')) continue;
        const r = yield* this.ask({ type: 'yesNo', player: pid, prompt: `Begin the game with ${o.card.name} on the battlefield?`, sourceId: id });
        if (r.type === 'yesNo' && r.value) {
          yield* enterBattlefield(this, id, pid, {});
          this.log(`${this.player(pid).name} begins the game with ${this.nameOf(id)} on the battlefield.`);
        }
      }
    }
    // "You may reveal ~ from your opening hand. If you do, …"
    for (const pid of this.state.playerOrder) {
      for (const id of [...this.player(pid).hand]) {
        const o = this.state.objects[id];
        if (!o) continue;
        const ab = this.scriptFor(o).abilities.find((a) => a.kind === 'static' && a.rule?.kind === 'custom' && a.rule.tag === 'openingHandReveal');
        const eff = ab ? ((ab as { rule?: { data?: unknown } }).rule?.data as { effects?: import('./script.js').Effect[] } | undefined)?.effects : undefined;
        if (!eff?.length) continue;
        const r = yield* this.ask({ type: 'yesNo', player: pid, prompt: `Reveal ${o.card.name} from your opening hand?`, sourceId: id });
        if (r.type === 'yesNo' && r.value) {
          this.log(`${this.player(pid).name} reveals ${this.nameOf(id)} from their opening hand.`);
          yield* executeEffects(this, eff, { sourceId: id, controller: pid, targets: [], triggerContext: {}, x: 0, modes: [], memory: {} });
        }
      }
    }
    this.pendingTriggers = [];
    this.state.turnStats = {};
    this.state.turnRules = [];
    for (const p of Object.values(this.state.players)) p.turnStats = {};
  }

  private *takeTurn(pid: PlayerId): Gen {
    const t = this.state.turn;
    t.number++;
    t.activePlayer = pid;
    t.skipSteps = [];
    t.attackers = [];
    this.state.turnStats = {};
    for (const p of Object.values(this.state.players)) {
      p.turnStats = {};
      p.landsPlayedThisTurn = 0;
      p.spellsCastThisTurn = 0;
    }
    for (const o of Object.values(this.state.objects)) o.enteredThisTurn = false;
    // "until your next turn" effects of the active player end.
    this.state.continuousEffects = this.state.continuousEffects.filter((ce) => !(ce.duration === 'untilYourNextTurn' && ce.controller === pid));
    this.log(`--- Turn ${t.number}: ${this.player(pid).name} ---`, { kind: 'turn', data: { player: pid, turn: t.number } });
    this.emit({ name: 'beginningOfTurn', playerId: pid });

    const steps: { step: Step; phase: TurnState['phase'] }[] = [
      { step: 'untap', phase: 'beginning' },
      { step: 'upkeep', phase: 'beginning' },
      { step: 'draw', phase: 'beginning' },
      { step: 'main1', phase: 'precombatMain' },
      { step: 'beginCombat', phase: 'combat' },
      { step: 'declareAttackers', phase: 'combat' },
      { step: 'declareBlockers', phase: 'combat' },
      { step: 'firstStrikeDamage', phase: 'combat' },
      { step: 'combatDamage', phase: 'combat' },
      { step: 'endCombat', phase: 'combat' },
      { step: 'main2', phase: 'postcombatMain' },
      { step: 'end', phase: 'ending' },
      { step: 'cleanup', phase: 'ending' },
    ];
    for (let i = 0; i < steps.length; i++) {
      if (this.state.over) return;
      if (this.player(pid).lost) return;
      const { step, phase } = steps[i];
      if (t.skipSteps.includes(step)) continue;
      // "End the turn.": skip straight to cleanup.
      if (this.state.turnStats['endTheTurn'] && step !== 'cleanup') continue;
      // Skip combat steps after declare attackers if nothing attacks.
      if ((step === 'declareBlockers' || step === 'firstStrikeDamage' || step === 'combatDamage') && t.attackers.length === 0) continue;
      if (step === 'firstStrikeDamage' && !this.combatHasFirstStrike()) continue;
      t.step = step;
      t.phase = phase;
      this.touch();
      yield* this.doStep(step);
      // Mana empties between steps.
      for (const p of Object.values(this.state.players)) if (!this.state.turnStats[`keepMana:${p.id}`] && !this.playerRules(p.id).some((r) => r.kind === 'custom' && r.tag === 'keepMana')) p.manaPool = emptyPool();
      // Extra combat handling: scripts can request an additional combat phase via memory.
      if (step === 'main2' && this.state.turnStats['extraCombat']) {
        this.state.turnStats['extraCombat'] = 0;
        t.attackers = [];
        for (const o of Object.values(this.state.objects)) {
          o.attacking = null;
          o.blocking = [];
          o.blockedBy = [];
          o.wasBlocked = false;
        }
        i = steps.findIndex((s) => s.step === 'beginCombat') - 1;
      }
    }
  }

  private combatHasFirstStrike(): boolean {
    return Object.values(this.state.objects).some((o) => o.zone === 'battlefield' && (o.attacking !== null || o.blocking.length > 0) && (this.characteristics(o.id).keywords.has('First strike') || this.characteristics(o.id).keywords.has('Double strike')));
  }

  private *doStep(step: Step): Gen {
    const pid = this.state.turn.activePlayer;
    switch (step) {
      case 'untap': {
        this.state.turn.firstStrikeHappened = false;
        for (const id of [...this.state.battlefield]) {
          const o = this.obj(id);
          if (o.controller !== pid) continue;
          o.memory['__wasTapped'] = o.tapped || undefined;
          if (o.phasedOut) {
            o.phasedOut = false;
            this.emit({ name: 'phasedIn', objectId: id, playerId: o.controller });
            continue;
          }
          const ch = this.characteristics(id);
          if (ch.rules.some((r) => r.kind === 'cantUntap')) continue;
          if (o.tapped) {
            o.tapped = false;
            this.touch();
          }
        }
        // "Players can't untap more than one artifact during their untap steps."
        for (const r of this.playerRules(pid)) {
          if (r.kind !== 'custom' || r.tag !== 'untapLimit') continue;
          const d = (r.data as { count?: number; filter?: import('./types.js').ObjectFilter } | undefined) ?? {};
          const limit = d.count ?? 1;
          const matching = objectsMatching(this, { ...(d.filter ?? {}), zone: 'battlefield', controller: 'you' }, { sourceId: null, controller: pid }).filter((o) => o.memory['__wasTapped']);
          if (matching.length <= limit) continue;
          const resp = yield* this.ask({ type: 'chooseObjects', player: pid, prompt: `Untap up to ${limit}`, candidates: matching.map((o) => o.id), min: 0, max: limit });
          const keep = new Set(resp.type === 'objects' ? resp.ids : matching.slice(0, limit).map((o) => o.id));
          for (const o of matching) if (!keep.has(o.id)) o.tapped = true;
          this.touch();
        }
        // "Untap all creatures you control during each other player's untap step."
        for (const other of this.state.playerOrder) {
          if (other === pid) continue;
          for (const r of this.playerRules(other)) {
            if (r.kind !== 'custom' || r.tag !== 'untapEachUntapStep') continue;
            const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter ?? {};
            for (const o of objectsMatching(this, { ...f, zone: 'battlefield', controller: 'you' }, { sourceId: null, controller: other })) {
              if (o.tapped && !this.characteristics(o.id).rules.some((rr) => rr.kind === 'cantUntap')) {
                o.tapped = false;
                this.touch();
              }
            }
          }
        }
        this.log(`${this.player(pid).name} untaps.`);
        // "Doesn't untap during its controller's next untap step" has now been used up.
        this.state.continuousEffects = this.state.continuousEffects.filter((ce) => {
          if (ce.duration !== 'untilNextUntap') return true;
          if (ce.affected.kind !== 'fixed') return false;
          const remaining = ce.affected.ids.filter((id) => this.state.objects[id] && this.state.objects[id].controller !== pid);
          if (!remaining.length) return false;
          ce.affected = { kind: 'fixed', ids: remaining };
          return true;
        });
        // No priority in untap step.
        return;
      }
      case 'upkeep':
        // Day/night: if it was day and the previous player cast no spells, it becomes night (and vice versa).
        if (this.state.dayNight !== undefined && this.state.turn.number > 1) {
          const prev = this.state.lastTurnStats ?? {};
          const spells = Object.entries(prev).filter(([k]) => k.startsWith('cast:')).reduce((n, [, v]) => n + v, 0);
          if (this.state.dayNight === 'day' && spells === 0) this.setDayNight('night');
          else if (this.state.dayNight === 'night' && spells >= 2) this.setDayNight('day');
        }
        this.emit({ name: 'beginningOfUpkeep', playerId: pid });
        if (this.state.initiative === pid) {
          this.pendingTriggers.push({ sourceId: -1, controller: pid, ability: { kind: 'triggered', text: 'Initiative: venture into Undercity', event: 'beginningOfUpkeep', effects: [{ kind: 'ventureIntoDungeon' }] }, context: { dungeon: 'Undercity' } });
        }
        yield* this.priorityRound();
        return;
      case 'draw':
        if (this.playerRules(pid).some((r) => r.kind === 'custom' && r.tag === 'skipDrawStep')) {
          this.log(`${this.player(pid).name} skips their draw step.`);
          return;
        }
        // Rule 103.8: in a two-player game, the starting player skips their first draw.
        if (!(this.state.turn.number === 1 && this.state.playerOrder.length === 2)) this.drawCards(pid, 1);
        this.emit({ name: 'beginningOfDraw', playerId: pid });
        yield* this.priorityRound();
        return;
      case 'main1':
        this.emit({ name: 'beginningOfPrecombatMain', playerId: pid });
        // Sagas: lore counter at precombat main.
        for (const id of [...this.state.battlefield]) {
          const o = this.obj(id);
          if (o.controller === pid && this.characteristics(id).subtypes.includes('Saga')) this.addCounters(id, 'lore', 1);
        }
        yield* this.priorityRound();
        return;
      case 'main2':
        this.emit({ name: 'beginningOfPostcombatMain', playerId: pid });
        yield* this.priorityRound();
        return;
      case 'beginCombat':
      case 'declareAttackers':
      case 'declareBlockers':
      case 'firstStrikeDamage':
      case 'combatDamage':
      case 'endCombat':
        yield* runCombatStep(this, step);
        return;
      case 'end':
        this.emit({ name: 'beginningOfEndStep', playerId: pid });
        yield* this.priorityRound();
        return;
      case 'cleanup':
        yield* this.cleanup();
        return;
    }
  }

  private *cleanup(): Gen {
    const pid = this.state.turn.activePlayer;
    const p = this.player(pid);
    this.state.preventions = [];
    for (;;) {
      // Discard to hand size
      const rules = this.playerRules(pid);
      const noMax = rules.some((r) => r.kind === 'noMaxHandSize');
      let maxHand = 7;
      for (const r of rules) if (r.kind === 'maxHandSize') maxHand = r.value !== undefined ? r.value : maxHand + (r.delta ?? 0);
      maxHand = Math.max(0, maxHand);
      if (!noMax && p.hand.length > maxHand) {
        const n = p.hand.length - maxHand;
        const resp = yield* this.ask({ type: 'chooseObjects', player: pid, prompt: `Discard ${n} card${n === 1 ? '' : 's'} (hand size)`, candidates: [...p.hand], min: n, max: n, revealToChooser: true });
        if (resp.type === 'objects') {
          for (const id of resp.ids) this.moveObject(id, 'graveyard', { cause: 'discard' });
          if (resp.ids.length) this.emit({ name: 'discardBatch', playerId: pid, amount: resp.ids.length, objectId: resp.ids[0] });
        }
      }
      // Damage wears off, "until end of turn" ends.
      for (const o of Object.values(this.state.objects)) {
        o.damage = 0;
        o.deathtouchDamage = false;
      }
      this.state.damagedBy = {};
      this.state.lastTurnStats = { ...this.state.turnStats };
      for (const o of Object.values(this.state.objects)) if (o.memory['discardedThisTurn']) delete o.memory['discardedThisTurn'];
      this.expireEffects('endOfTurn');
      this.expireEffects('thisTurn');
      this.touch();
      this.emit({ name: 'cleanup', playerId: pid });
      yield* checkStateBasedActions(this);
      if (this.pendingTriggers.length === 0) break;
      // Triggers during cleanup: players get priority, then another cleanup step.
      yield* this.priorityRound();
      if (this.state.over) return;
    }
    this.emit({ name: 'endOfTurn', playerId: pid });
    this.pendingTriggers = []; // endOfTurn is informational
  }

  /**
   * Give players priority in turn order until all pass in succession.
   * Resolves the stack as players pass. Runs SBAs and puts triggers on the
   * stack before each player receives priority (rule 117.5).
   */
  *priorityRound(): Gen {
    let current = this.state.turn.activePlayer;
    let passes = 0;
    let failed: { id: number; error: string } | null = null;
    let askId = -1;
    for (;;) {
      if (this.state.over) return;
      yield* checkStateBasedActions(this);
      if (this.state.over) return;
      if (this.pendingTriggers.length > 0) {
        yield* this.putTriggersOnStack();
        yield* checkStateBasedActions(this);
        passes = 0; // new objects on stack: everyone gets a fresh chance
      }
      const p = this.player(current);
      if (p.lost) {
        current = this.nextPlayerAfter(current);
        continue;
      }
      const decision = buildPriorityDecision(this, current);
      const meaningfulAbilities = decision.activatableAbilities.filter((a) => {
        const o = this.state.objects[a.objectId];
        if (!o) return false;
        const ab = abilitiesOf(this, o).find((x) => x.index === a.abilityIndex);
        return !!ab && !ab.spec.manaAbility;
      });
      const nothingToDo = decision.playableCards.length === 0 && meaningfulAbilities.length === 0 && !decision.canPlayLand;
      let resp: Response;
      if (nothingToDo && this.config.autoPassWhenNothingToDo) {
        resp = { type: 'pass' };
      } else {
        // After a failed action the same player is re-asked under the same decision id, so clients can tell it is a retry.
        askId = failed ? failed.id : this.state.nextDecisionId;
        resp = yield* this.ask(decision, failed ? { reuseId: failed.id, error: failed.error } : {});
        failed = null;
      }
      if (resp.type === 'pass') {
        passes++;
        const alive = this.activePlayers().length;
        if (passes >= alive) {
          if (this.state.stack.length === 0) return; // step ends
          yield* resolveTopOfStack(this);
          passes = 0;
          current = this.state.turn.activePlayer;
        } else {
          current = this.nextPlayerAfter(current);
        }
        continue;
      }
      passes = 0;
      let acted = false;
      if (resp.type === 'playLand') acted = yield* playLand(this, current, resp.objectId);
      else if (resp.type === 'cast') acted = yield* castSpell(this, current, resp.objectId, resp);
      else if (resp.type === 'activate') acted = yield* activateAbility(this, current, resp.objectId, resp.abilityIndex, resp);
      if (!acted) {
        // Action was cancelled or illegal: same player keeps priority.
        const what: string = 'objectId' in resp ? this.nameOf(resp.objectId) : 'that';
        failed = { id: askId, error: `Could not ${resp.type === 'playLand' ? 'play' : resp.type === 'activate' ? 'activate' : 'cast'} ${what}.` };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Manual mode
  // -------------------------------------------------------------------------

  applyManual(player: PlayerId, a: ManualAction) {
    const name = this.player(player).name;
    switch (a.kind) {
      case 'moveObject': {
        const o = this.state.objects[a.objectId];
        if (!o) return;
        const tapped = a.tapped ?? false;
        if (a.toZone === 'library') this.moveObject(a.objectId, 'library', { position: a.position ?? 'top', skipEvents: true });
        else if (a.toZone === 'stack') return;
        else this.moveObject(a.objectId, a.toZone, { tapped, controller: a.toZone === 'battlefield' ? player : undefined, skipEvents: false, cause: 'other' });
        this.log(`${name} moves ${this.nameOf(a.objectId)} to ${a.toZone} (manual).`);
        return;
      }
      case 'tap': {
        const o = this.state.objects[a.objectId];
        if (o) {
          o.tapped = a.tapped;
          this.touch();
        }
        return;
      }
      case 'setLife':
        this.player(a.playerId).life = a.life;
        this.log(`${name} sets ${this.player(a.playerId).name}'s life to ${a.life} (manual).`);
        this.touch();
        return;
      case 'adjustLife':
        this.player(a.playerId).life += a.delta;
        this.log(`${this.player(a.playerId).name}'s life ${a.delta >= 0 ? '+' : ''}${a.delta} → ${this.player(a.playerId).life} (manual).`);
        this.touch();
        return;
      case 'addCounters': {
        const o = this.state.objects[a.objectId];
        if (!o) return;
        o.counters[a.counterType] = Math.max(0, (o.counters[a.counterType] ?? 0) + a.delta);
        if (o.counters[a.counterType] === 0) delete o.counters[a.counterType];
        this.touch();
        return;
      }
      case 'createToken': {
        const count = a.count ?? 1;
        for (let i = 0; i < count; i++) {
          const card: CardData = {
            oracleId: `token:${a.name}`,
            name: a.name,
            manaCost: '',
            typeLine: a.typeLine ?? 'Creature',
            oracleText: a.oracleText ?? '',
            power: a.power,
            toughness: a.toughness,
            colors: a.colors ?? [],
            colorIdentity: a.colors ?? [],
            keywords: this.keywordsFromText(a.oracleText ?? ''),
            layout: 'token',
            cmc: 0,
            isToken: true,
          };
          this.createObject(card, player, 'battlefield', { tapped: a.tapped, skipEvents: true });
        }
        this.log(`${name} creates ${count} ${a.name} token${count === 1 ? '' : 's'} (manual).`);
        return;
      }
      case 'addMana':
        this.player(player).manaPool[a.color] += a.amount;
        this.touch();
        return;
      case 'draw':
        this.drawCards(player, a.count);
        this.pendingTriggers = this.pendingTriggers.filter((t) => t.ability.event !== 'drawCard' || true);
        return;
      case 'mill':
        for (let i = 0; i < a.count; i++) {
          const id = this.player(player).library[0];
          if (id === undefined) break;
          this.moveObject(id, 'graveyard', { cause: 'mill' });
        }
        return;
      case 'shuffle':
        this.shuffleLibrary(player);
        return;
      case 'damage': {
        const o = this.state.objects[a.objectId];
        if (o) {
          o.damage += a.amount;
          this.touch();
        }
        return;
      }
      case 'setControl': {
        const o = this.state.objects[a.objectId];
        if (o) {
          o.controller = a.controller;
          o.controlSinceTurn = this.state.turn.number;
          this.touch();
        }
        return;
      }
      case 'attach': {
        const o = this.state.objects[a.objectId];
        if (!o) return;
        if (o.attachedTo !== null) {
          const host = this.state.objects[o.attachedTo];
          if (host) host.attachments = host.attachments.filter((x) => x !== o.id);
        }
        o.attachedTo = a.to;
        if (a.to !== null) this.state.objects[a.to]?.attachments.push(o.id);
        this.touch();
        return;
      }
      case 'reveal':
        this.log(`${name} reveals ${this.nameOf(a.objectId)}.`, { kind: 'reveal', data: { objectId: a.objectId } });
        return;
      case 'setMemory': {
        const o = this.state.objects[a.objectId];
        if (o) o.memory[a.key] = a.value;
        return;
      }
      case 'transform': {
        const o = this.state.objects[a.objectId];
        if (o && o.card.faces && o.card.faces.length > 1) {
          o.faceIndex = o.faceIndex === 0 ? 1 : 0;
          this.touch();
        }
        return;
      }
      case 'concede':
        this.playerLoses(player, 'conceded');
        return;
      case 'poison':
        this.player(a.playerId).poison = Math.max(0, this.player(a.playerId).poison + a.delta);
        this.touch();
        return;
      case 'commanderDamage': {
        const p = this.player(a.playerId);
        p.commanderDamage[a.commanderId] = Math.max(0, (p.commanderDamage[a.commanderId] ?? 0) + a.delta);
        this.touch();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Utilities for scripts / other modules
  // -------------------------------------------------------------------------

  /** Timestamps of targeted objects, used to detect zone changes before resolution. */
  stampTargets(targets: Target[]): (number | null)[] {
    return targets.map((t) => (t.kind === 'object' ? this.state.objects[t.id]?.timestamp ?? null : null));
  }

  /** Run effects immediately (used by resolution and by manual "resolve now"). */
  *runEffects(effects: Effect[], ctx: EffectContext): Gen {
    yield* executeEffects(this, effects, ctx);
  }

  colorsOfCommander(pid: PlayerId): Color[] {
    const set = new Set<Color>();
    for (const o of Object.values(this.state.objects)) if (o.isCommander && o.owner === pid) o.card.colorIdentity.forEach((c) => set.add(c));
    return [...set];
  }
}

// Lazy require to avoid a circular import at module-eval time.
function require_filters(): typeof import('./filters.js') {
  return filtersModule;
}
import * as filtersModule from './filters.js';
