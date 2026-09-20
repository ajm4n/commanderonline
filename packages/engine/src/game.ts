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
  ManaColor,
} from './types.js';
import { Rng } from './rng.js';
import { type Characteristics, computeCharacteristics } from './characteristics.js';
import type { Amount, CardScript, Condition, Effect, Ref, TriggeredAbilitySpec, TriggerFilter, TargetSpec } from './script.js';
import { matchesFilter, objectsMatching, legalTargets, sameTarget, type FilterContext } from './filters.js';
import { parseTypeLine } from './typeline.js';
import { ENFORCED_KEYWORDS } from './keywords.js';
import { executeEffects, enterBattlefield, type EffectContext } from './effects.js';
import { buildPriorityDecision, castSpell, activateAbility, playLand, abilitiesOf, wardTriggers, manaFromAbility } from './casting.js';
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
  /** Characteristics of permanents that died this turn ("for each Zubera that died this turn"). */
  diedThisTurn?: { controller: PlayerId; name: string; types: string[]; subtypes: string[]; colors: string[] }[];
  /** Characteristics of spells cast this turn ("unless you've cast a creature spell this turn"). */
  castThisTurn?: { controller: PlayerId; name: string; types: string[]; subtypes: string[]; colors: string[] }[];
  /** turnStats of the previous turn ("if a player cast two or more spells last turn"). */
  lastTurnStats: Record<string, number>;
  /** Player rules granted for the rest of the turn ("You may cast spells this turn as though they had flash"). */
  turnRules?: { player: PlayerId; rule: import('./types.js').RuleModification; /** Lasts until this player's next turn begins instead of the end of this turn. */ untilNextTurnOf?: PlayerId }[];
  /** Replacement effects granted for the rest of the turn ("until end of turn, if you would ..."). */
  turnReplacements?: { player: PlayerId; spec: import('./script.js').ReplacementSpec }[];
  /** Day/night cycle: undefined until a card starts it. */
  dayNight?: 'day' | 'night';
  preventions: { effects?: import('./script.js').Effect[]; /** Only damage from these specific sources. */ sourceIds?: ObjectId[]; /** Shield: prevents at most this much, then wears off. */ amount?: number; combat: boolean; source?: import('./types.js').ObjectFilter; to: 'all' | 'you' | 'creaturesYouControl' | 'youAndCreaturesYouControl' | 'youAndPlaneswalkersYouControl' | 'players' | 'creatures' | import('./types.js').ObjectFilter; controller: PlayerId; sourceId: ObjectId | null; once?: boolean; /** Specific recipients ("prevent all damage that would be dealt to target creature this turn by red sources"). */ ids?: ObjectId[]; playerIds?: PlayerId[]; /** The prevented damage is dealt to these instead. */ redirectIds?: ObjectId[]; redirectPlayers?: PlayerId[]; redirectToSourceController?: boolean; /** Not limited to this turn ("prevent the next 3 damage that would be dealt to it"). */ permanent?: boolean }[];
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
  /**
   * Permanents that left the battlefield inside the current simultaneous batch
   * ("destroy all creatures", one state-based-action sweep). Rule 700.4: each of
   * them still sees the others go, so a leave-the-battlefield ability fires once
   * per permanent instead of only for the ones that left before it.
   */
  private leavingTogether: Map<ObjectId, GameObject> | null = null;
  /** Whether the last target choice was declined rather than impossible (for the log). */
  private lastTargetChoiceCancelled = false;
  /** Run `fn` treating every battlefield departure inside it as simultaneous. */
  /** Tokens that left the battlefield during the current batch; they cease to exist once every trigger has seen the batch (CR 603.10a). */
  private pendingCease: ObjectId[] = [];
  /** Identifies the events that happened together, so "whenever one or more …" triggers once for them (rule 603.2c). */
  private batchSeq = 0;
  private currentBatch: number | null = null;
  simultaneousZoneChange<T>(fn: () => T): T {
    if (this.leavingTogether) return fn();
    this.leavingTogether = new Map();
    this.currentBatch = ++this.batchSeq;
    try {
      return fn();
    } finally {
      this.leavingTogether = null;
      this.currentBatch = null;
      if (this.pendingCease.length) {
        for (const id of this.pendingCease.splice(0)) {
          const o = this.state.objects[id];
          if (!o) continue;
          this.removeFromZone(o);
          delete this.state.objects[id];
        }
        this.touch();
      }
    }
  }
  /** Queue a trigger from outside (state-based actions). */
  queueTrigger(t: PendingTrigger): void {
    this.pendingTriggers.push(t);
  }
  /** Objects exiled "until this leaves" whose source has left; returned by SBA. */
  pendingReturns: ObjectId[] = [];
  /** Player who dealt combat damage to the initiative holder this damage step; takes the initiative afterwards. */
  pendingInitiative: PlayerId | null = null;
  private computing = new Set<ObjectId>();
  /** Counts re-entrancy fallbacks, so results that depended on one are not cached. */
  private chFallbacks = 0;
  /** Results computed from a fallback, valid only while the outermost computation runs. */
  private chProvisional = new Map<ObjectId, Characteristics>();
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
          for (let a = 0; a < t[i].length; a++) for (let b = a + 1; b < t[i].length; b++) if (sameTarget(t[i][a], t[i][b])) return `${slot.description}: the same target twice`;
          // "another target creature": a slot marked distinct shares no pick with any other slot.
          if (slot.distinct) for (let j = 0; j < t.length; j++) if (j !== i && t[i].some((tt) => t[j].some((o) => sameTarget(o, tt)))) return `${slot.description} must differ from the other targets`;
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
  /** A creature put onto the battlefield attacking is an attacking creature (CR 508.4): it can be blocked and deals combat damage. */
  markAttacking(obj: GameObject, target: PlayerId | ObjectId) {
    obj.attacking = target;
    if (!this.state.turn.attackers.includes(obj.id)) this.state.turn.attackers.push(obj.id);
  }
  /** Serialise everything a cancelled action must undo (CR 730.1). */
  snapshotState(): string {
    return JSON.stringify({ state: this.state, pending: this.pendingTriggers, returns: this.pendingReturns });
  }
  restoreState(snap: string) {
    const s = JSON.parse(snap) as { state: GameState; pending: PendingTrigger[]; returns: ObjectId[] };
    const v = this.state.version;
    this.state = s.state;
    this.pendingTriggers = s.pending;
    this.pendingReturns = s.returns;
    this.state.version = Math.max(v, this.state.version) + 1;
    this.chCache.clear();
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
      if (ce.modification.layer !== 6) continue;
      const mod = ce.modification;
      if (!mod.addAbilityText?.length && !mod.addActivatedAbilitiesFrom) continue;
      if (ce.affected.kind === 'fixed' ? !ce.affected.ids.includes(obj.id) : !matchesFilter(this, obj, ce.affected.filter, { sourceId: ce.sourceId, controller: ce.controller })) continue;
      if (mod.addAbilityText?.length) granted.push(...mod.addAbilityText);
      if (mod.addActivatedAbilitiesFrom) {
        const from = mod.addActivatedAbilitiesFrom;
        for (const other of objectsMatching(this, { ...from, zone: from.zone ?? 'battlefield' }, { sourceId: ce.sourceId, controller: ce.controller })) {
          if (other.id === obj.id) continue;
          for (const ab of this.scriptFor(other).abilities) if (ab.kind === 'activated') granted.push(ab.text);
        }
      }
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
      // Re-entrancy guard (e.g. P/T defined by counting creatures): return base. Anything computed from this
      // fallback is provisional and must not be cached.
      this.chFallbacks++;
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
        basePower: obj.card.power ? parseInt(obj.card.power, 10) || 0 : null,
        baseToughness: obj.card.toughness ? parseInt(obj.card.toughness, 10) || 0 : null,
        loyalty: null,
        oracleText: obj.card.oracleText,
        rules: [],
        lostAllAbilities: false,
        controller: obj.controller,
      };
    }
    const provisional = this.chProvisional.get(id);
    if (provisional && this.computing.size > 0) return provisional;
    this.computing.add(id);
    const fallbacksBefore = this.chFallbacks;
    try {
      const ch = computeCharacteristics(this, id);
      // A result that depended on a re-entrancy fallback is only kept for the rest of this outermost computation.
      if (this.chFallbacks === fallbacksBefore) this.chCache.set(id, { v: this.state.version, ch });
      else this.chProvisional.set(id, ch);
      return ch;
    } finally {
      this.computing.delete(id);
      if (this.computing.size === 0) this.chProvisional.clear();
    }
  }

  /** Characteristic-defining P/T ("*"). Scripts may define `starPT` via memory; default counts. */
  evaluateStarPT(obj: GameObject): number | null {
    const text = obj.card.oracleText;
    const ctx: FilterContext = { sourceId: obj.id, controller: obj.controller };
    let m: RegExpMatchArray | null;
    if ((m = text.match(/power and toughness are each equal to the number of (\w+?)s? you control/i))) {
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
  /** Turn-scoped replacement effects of a given event granted to a player. */
  turnReplacementsFor<K extends import('./script.js').ReplacementSpec['event']>(p: PlayerId, event: K): Extract<import('./script.js').ReplacementSpec, { event: K }>[] {
    const out: Extract<import('./script.js').ReplacementSpec, { event: K }>[] = [];
    for (const t of this.state.turnReplacements ?? []) {
      if (t.player !== p || t.spec.event !== event) continue;
      out.push(t.spec as Extract<import('./script.js').ReplacementSpec, { event: K }>);
    }
    return out;
  }

  playerRules(p: PlayerId): import('./types.js').RuleModification[] {
    const out: import('./types.js').RuleModification[] = [];
    for (const src of Object.values(this.state.objects)) {
      const onField = src.zone === 'battlefield' || src.zone === 'command';
      // Squee: "You may cast this card from your graveyard": a static that works from another zone.
      if (!onField && src.zone !== 'graveyard' && src.zone !== 'exile') continue;
      const script = this.scriptFor(src);
      for (const ab of script.abilities) {
        if (ab.kind !== 'static' || !ab.rule) continue;
        const zones = ab.zone ? (Array.isArray(ab.zone) ? ab.zone : [ab.zone]) : ['battlefield'];
        if (!zones.includes(src.zone)) continue;
        if (!onField && src.owner !== p) continue;
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
        if ((ab as { instead: string }).instead === 'libraryTop') return this.moveObject(id, 'library', { ...opts, position: 'top' });
        if ((ab as { instead: string }).instead === 'libraryBottom') return this.moveObject(id, 'library', { ...opts, position: 'bottom' });
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
    // Undying and persist ask what it had on it, so keep a copy before clearing.
    if (Object.keys(obj.counters).length) obj.memory['__countersOnLeave'] = { ...obj.counters };
    else delete obj.memory['__countersOnLeave'];
    obj.tapped = opts.tapped ?? false;
    obj.damage = 0;
    obj.deathtouchDamage = false;
    obj.counters = opts.counters ? (toZone === 'battlefield' ? this.enteringCounters(obj, opts.counters, opts.controller ?? obj.controller) : { ...opts.counters }) : {};
    obj.attacking = null;
    obj.blocking = [];
    obj.blockedBy = [];
    obj.wasBlocked = false;
    obj.phasedOut = false;
    obj.faceDown = opts.faceDown ?? false;
    obj.copyOf = undefined;
    obj.attachedTimestamp = undefined;
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
      // 903.9: a commander put into a graveyard, exile, hand or library may go to the command zone instead (offered by the SBA check).
      if (obj.isCommander && (toZone === 'graveyard' || toZone === 'exile' || toZone === 'hand' || toZone === 'library')) obj.memory['commanderZoneOffered'] = false;
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
      if (opts.attackingFor !== undefined) this.markAttacking(obj, opts.attackingFor);
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
      if (fromZone === 'battlefield') this.leavingTogether?.set(id, snapshot);
      if (fromZone === 'battlefield') {
        this.emit({ name: 'leavesBattlefield', ...base, playerId: snapshot.controller });
        if (toZone === 'graveyard') {
          if (lkiCh) (this.state.diedThisTurn ??= []).push({ controller: snapshot.controller, name: lkiCh.name, types: [...lkiCh.types], subtypes: [...lkiCh.subtypes], colors: [...lkiCh.colors] });
          this.emit({ name: 'dies', ...base, playerId: snapshot.controller });
        }
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
      // Remove after triggers were collected (they hold a snapshot). Inside a simultaneous batch the
      // token must still see the other objects leaving with it, so it ceases when the batch ends.
      if (this.leavingTogether) {
        this.pendingCease.push(id);
        return null;
      }
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
    obj.counters = opts.counters ? (zone === 'battlefield' ? this.enteringCounters(obj, opts.counters, obj.controller) : { ...opts.counters }) : {};
    obj.timestamp = this.now();
    obj.enteredThisTurn = zone === 'battlefield';
    obj.controlSinceTurn = this.state.turn.number;
    this.state.objects[id] = obj;
    this.touch();
    if (zone === 'battlefield') {
      this.state.battlefield.push(id);
      if (opts.attacking !== undefined) this.markAttacking(obj, opts.attacking);
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

  /** "Damage can't be prevented": no prevention effect applies while this is in force. */
  preventionOff(): boolean {
    return this.state.playerOrder.some((pl) => this.playerRules(pl).some((r) => r.kind === 'custom' && r.tag === 'noDamagePrevention'));
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
      // Likewise one that has lost all abilities (Humility); a permanent leaving uses its last known characteristics.
      if (obj.zone === 'battlefield' && this.characteristics(obj.id).lostAllAbilities) continue;
      const script = this.scriptFor(obj);
      for (const ab of script.abilities) {
        if (ab.kind !== 'triggered' || ab.event !== event.name) continue;
        if (event.objectId === obj.id && event.fromZone === 'battlefield' && lkiCh?.lostAllAbilities) continue;
        const zones = ab.zone ? (Array.isArray(ab.zone) ? ab.zone : [ab.zone]) : ['battlefield'];
        const isSelfLeaving = event.objectId === obj.id && event.snapshot && event.fromZone === 'battlefield' && (event.name === 'dies' || event.name === 'leavesBattlefield' || event.name === 'exiled' || event.name === 'putIntoGraveyard');
        const isSelfEntering = event.objectId === obj.id && event.name === 'entersBattlefield';
        // Left the battlefield together with the object this event is about: it still sees the event.
        const leaveEvent = event.name === 'dies' || event.name === 'leavesBattlefield' || event.name === 'exiled' || event.name === 'putIntoGraveyard' || event.name === 'sacrifice';
        const together = !isSelfLeaving && leaveEvent && event.objectId !== obj.id && zones.includes('battlefield') ? this.leavingTogether?.get(obj.id) : undefined;
        if (!isSelfLeaving && !together && !zones.includes(obj.zone)) continue;
        // Enter triggers ("When ~ enters") only if ability functions on battlefield.
        if (isSelfEntering && !zones.includes('battlefield')) continue;
        const controller = isSelfLeaving && event.snapshot ? event.snapshot.controller : together ? together.controller : obj.controller;
        const evalObj = isSelfLeaving && event.snapshot ? event.snapshot : together ?? obj;
        if (event.name === 'tappedForMana' && ab.effects.every((e) => e.kind === 'addMana')) continue; // already resolved as a mana ability
        // Elesh Norn, Mother of Machines: permanents entering don't cause abilities of permanents your opponents control to trigger.
        if (event.name === 'entersBattlefield' && event.objectId !== undefined && this.playerRules(controller).some((r) => {
          if (r.kind !== 'custom' || r.tag !== 'noEtbTriggersForYourPermanents') return false;
          const f = ((r.data as { filter?: import('./types.js').ObjectFilter } | undefined) ?? {}).filter;
          const entering = this.state.objects[event.objectId!];
          return !!entering && (!f || matchesFilter(this, entering, { ...f, zone: undefined }, { sourceId: null, controller }));
        })) continue;
        if (!this.triggerMatches(ab.filter, event, evalObj, controller, lkiCh)) continue;
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: obj.id, controller, triggerContext: this.triggerContextFrom(event) })) continue;
        if (ab.oncePerTurn) {
          const k = `once:${obj.id}:${ab.text}`;
          if (this.state.turnStats[k]) continue;
          this.state.turnStats[k] = 1;
        }
        // A permanent that left together with the event's object may already be gone (a token): keep its snapshot as LKI.
        this.pendingTriggers.push({ sourceId: obj.id, controller, ability: ab, context: this.triggerContextFrom(event), snapshot: isSelfLeaving ? event.snapshot : together });
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
          this.pendingTriggers.push({ sourceId: obj.id, controller, ability: ab, context: { ...this.triggerContextFrom(event), batchId: `extra:${++this.batchSeq}` }, snapshot: isSelfLeaving ? event.snapshot : together });
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
      // The firing event fills in what the delayed trigger didn't capture; what it did capture ("that card") wins.
      const fromEvent = Object.fromEntries(Object.entries(this.triggerContextFrom(event)).filter(([, v]) => v !== undefined));
      this.pendingTriggers.push({
        sourceId: dt.sourceId,
        controller: dt.controller,
        ability: { kind: 'triggered', text: dt.text, event: dt.event, effects: dt.effects },
        context: { ...fromEvent, ...dt.context },
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
      batchId: this.currentBatch ?? ++this.batchSeq,
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
      // "Whenever equipped creature dies": the creature has already left and the Equipment was detached as it went,
      // so the creature's last known information decides whether this was attached to it (rule 603.10a).
      const wasAttached = e.objectId !== undefined && (attachedTo === e.objectId || (((e.snapshot as GameObject | undefined)?.attachments ?? []).includes(obj.id) && e.objectId === (e.snapshot as GameObject).id));
      if (!wasAttached) return false;
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
    if (f.minTargets !== undefined || f.maxTargets !== undefined) {
      const item = this.state.stack.find((s) => s.kind === 'spell' && s.sourceId === e.objectId);
      const n = item ? item.targets.length : 0;
      if (f.minTargets !== undefined && n < f.minTargets) return false;
      if (f.maxTargets !== undefined && n > f.maxTargets) return false;
    }
    if (f.custom === 'monarchsStep' && (this.state.monarch === null || e.playerId !== this.state.monarch)) return false;
    if (f.targetsAny) {
      const item = this.state.stack.find((s) => s.kind === 'spell' && s.sourceId === e.objectId);
      if (!item || !item.targets.some((t) => t.kind === 'object' && this.state.objects[t.id] && matchesFilter(this, this.state.objects[t.id], f.targetsAny!, { sourceId: obj.id, controller }))) return false;
    }
    if (f.custom === 'exhaust' && !(e.data as { exhaust?: boolean } | undefined)?.exhaust) return false;
    if (f.custom === 'wonFlip' && !(e.data as { won?: boolean } | undefined)?.won) return false;
    if (f.custom === 'wonClash' && !(e.data as { won?: boolean } | undefined)?.won) return false;
    if (f.custom === 'duringCombat' && !['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'].includes(this.state.turn.step)) return false;
    if (f.custom === 'duringMainPhase' && !['main1', 'main2'].includes(this.state.turn.step)) return false;
    if (f.custom === 'duringDrawStep' && this.state.turn.step !== 'draw') return false;
    if (f.custom === 'attachedToSelf' && e.sourceId !== obj.id) return false;
    if (f.custom === 'declareAttackersStep' && this.state.turn.step !== 'declareAttackers') return false;
    if (f.custom === 'attacksEnchantedPlayer' && (obj.attachedTo === null || e.otherPlayerId === undefined || e.otherPlayerId !== this.state.objects[obj.attachedTo]?.controller)) return false;
    if (f.custom === 'becomesNight' && (e.data as { to?: string } | undefined)?.to !== 'night') return false;
    if (f.custom === 'becomesDay' && (e.data as { to?: string } | undefined)?.to !== 'day') return false;
    if (f.custom?.startsWith('door:') && (e.data as { door?: number } | undefined)?.door !== Number(f.custom.slice(5))) return false;
    if (f.custom === 'lostFlip' && (e.data as { won?: boolean } | undefined)?.won) return false;
    if (f.custom === 'nonManaAbility' && (e.data as { mana?: boolean } | undefined)?.mana) return false;
    if (f.abilityTextPrefix !== undefined) {
      const at = (e.data as { abilityText?: string } | undefined)?.abilityText;
      if (typeof at !== 'string' || !new RegExp(`^${f.abilityTextPrefix}`, 'i').test(at)) return false;
    }
    if (f.custom === 'targetControlsMore' || f.custom === 'targetControlsFewer') {
      const other = e.playerId;
      if (other === undefined) return false;
      const landsOf = (p: PlayerId): number => this.state.battlefield.filter((id) => this.obj(id).controller === p && this.characteristics(id).types.includes('Land')).length;
      const mine = landsOf(controller);
      if (f.custom === 'targetControlsMore' ? !(landsOf(other) > mine) : !(landsOf(other) < mine)) return false;
    }
    if (f.custom === 'blocksTwoOrMore' && (this.state.objects[e.objectId ?? -1]?.blocking.length ?? 0) < 2) return false;
    if (f.custom === 'attacksInitiativeHolder') {
      const atk = e.objectId !== undefined ? this.state.objects[e.objectId] : undefined;
      const def = atk?.attacking ?? null;
      if (typeof def !== 'string' || this.state.initiative !== def) return false;
    }
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
    if (f.nthThisTurnAllPlayers !== undefined) {
      let total = 0;
      for (const p of this.state.playerOrder) total += this.state.turnStats[`${e.name}:${p}`] ?? 0;
      if (total !== f.nthThisTurnAllPlayers) return false;
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
      const batch = this.pendingTriggers.filter((t, i, all) => {
        // "Whenever one or more …" triggers once for everything that happened together (rule 603.2c).
        if (!t.ability.filter?.oncePerBatch) return true;
        // Still once per player: "one or more creatures deal combat damage to a player" fires for each player hit.
        return all.findIndex((u) => u.sourceId === t.sourceId && u.ability.text === t.ability.text && u.controller === t.controller && u.context['batchId'] === t.context['batchId'] && u.context['triggerPlayer'] === t.context['triggerPlayer'] && u.context['triggerOtherPlayer'] === t.context['triggerOtherPlayer']) === i;
      });
      this.pendingTriggers = [];
      for (const pid of this.apnap()) {
        const mine = batch.filter((t) => t.controller === pid);
        if (mine.length === 0) continue;
        let ordered = mine;
        const distinctTexts = new Set(mine.map((t) => t.ability.text)).size;
        if (mine.length > 1 && distinctTexts > 1 && !this.config.autoOrderTriggers) {
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
    let targets: Target[] = (t.context.presetTargets as Target[] | undefined) ?? [];
    let targetSlots: Target[][] | undefined;
    if (!targets.length && t.ability.targets?.length) {
      const chosen = yield* this.chooseTargets(t.controller, t.sourceId, t.ability.targets, t.context, `${this.nameOf(t.sourceId)}: ${t.ability.text}`);
      if (chosen === null) {
        this.log(this.lastTargetChoiceCancelled ? `${this.nameOf(t.sourceId)}'s controller chose no target, so the trigger is removed.` : `${this.nameOf(t.sourceId)}'s trigger has no legal targets and is removed.`);
        return;
      }
      targets = chosen;
      targetSlots = this.lastChosenSlots;
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
      targetSpecs: t.context.presetTargets ? undefined : t.ability.targets,
      triggerContext: { ...t.context, ...(targetSlots ? { targetSlots } : {}), ability: t.ability, snapshot: t.snapshot, isManual },
      timestamp: this.now(),
    };
    this.state.stack.push(item);
    wardTriggers(this, item);
    this.log(`Trigger: ${item.text}`, { kind: 'trigger', data: { sourceId: t.sourceId, controller: t.controller } });
    this.touch();
  }

  /** Ask a player to choose targets for a list of specs. Returns null if a required slot has no legal targets. */
  /** Per-slot targets from the most recent chooseTargets call, so multi-target slots ("up to three target permanents") resolve as a group. */
  lastChosenSlots: Target[][] | undefined;
  *chooseTargets(player: PlayerId, sourceId: ObjectId | null, specs: TargetSpec[], ctx: Record<string, unknown>, prompt: string, x?: number): Gen<Target[] | null> {
    this.lastTargetChoiceCancelled = false;
    const slots = specs.map((spec) => {
      const legal = legalTargets(this, spec, sourceId, player, x, ctx);
      const xn = spec.countX ? (x ?? 0) * (spec.countX.times ?? 1) : null;
      const min = spec.optional || (xn !== null && spec.countX?.upTo) ? 0 : xn ?? spec.min ?? 1;
      const cap = spec.maxAmount !== undefined ? this.resolveAmount(spec.maxAmount, { sourceId, controller: player, targets: [], triggerContext: ctx, memory: {}, x: x ?? 0, modes: [] }) : null;
      const distinct = spec.distinct || /\b(?:another|a second) target\b/i.test(spec.description) || undefined;
      if (spec.countAmount !== undefined) {
        const n = this.resolveAmount(spec.countAmount, { sourceId, controller: player, targets: [], triggerContext: ctx, memory: {}, x: x ?? 0, modes: [] });
        return { description: spec.description, legal, min: Math.min(n, legal.length), max: n, distinct };
      }
      return { description: spec.description, legal, min, max: cap ?? xn ?? spec.max ?? 1, distinct };
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
        if (resp.type === 'cancel') {
          this.lastTargetChoiceCancelled = true;
          return null;
        }
        targets = (resp as { targets: Target[][] }).targets;
      }
    } else {
      const resp = yield* this.ask({ type: 'chooseTargets', player, prompt, sourceId: sourceId ?? undefined, slots });
      if (resp.type === 'cancel') {
          this.lastTargetChoiceCancelled = true;
          return null;
        }
      targets = (resp as { targets: Target[][] }).targets;
    }
    this.lastChosenSlots = targets;
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

  checkCondition(c: Condition, ctx: { sourceId: ObjectId | null; controller: PlayerId; triggerContext?: Record<string, unknown>; targets?: Target[]; targetSlots?: Target[][]; x?: number; modes?: number[]; /** The resolving effect's memory, so "if it is a permanent card" can look at the card just revealed. */ memory?: Record<string, unknown> }): boolean {
    const ectx: EffectContext = { sourceId: ctx.sourceId, controller: ctx.controller, targets: ctx.targets ?? [], targetSlots: ctx.targetSlots, triggerContext: ctx.triggerContext ?? {}, x: ctx.x ?? 0, modes: ctx.modes ?? [], memory: ctx.memory ?? {} };
    const cmp = (a: number, op: string, b: number) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '==' ? a === b : op === '>' ? a > b : op === '<' ? a < b : a !== b);
    switch (c.kind) {
      case 'count': {
        const f = c.filter.zone || c.filter.zoneIn ? c.filter : { ...c.filter, zone: 'battlefield' as const };
        return cmp(objectsMatching(this, this.bindFilter(f, ectx), { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x }).length, c.op, this.resolveAmount(c.value, ectx));
      }
      case 'life': {
        const ps = this.resolvePlayers(c.ref, ectx);
        return ps.every((p) => cmp(this.player(p).life, c.op, this.resolveAmount(c.value, ectx)));
      }
      case 'yourTurn':
        return this.state.turn.activePlayer === ctx.controller;
      case 'mostCommonColor': {
        const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
        for (const id of this.state.battlefield) {
          const o = this.state.objects[id];
          if (!o) continue;
          for (const col of this.characteristics(id).colors) counts[col] = (counts[col] ?? 0) + 1;
        }
        const mine = counts[c.color] ?? 0;
        const best = Math.max(...Object.values(counts));
        return c.orTied ? mine === best && mine > 0 : mine === best && mine > 0 && Object.values(counts).filter((v) => v === best).length === 1;
      }
      case 'enduringStory': {
        const pl = this.player(ctx.controller);
        if (pl.flags['enduringStory']) return true;
        const n = this.state.battlefield.filter((id) => {
          const o = this.state.objects[id];
          if (!o || o.controller !== ctx.controller) return false;
          const ch = this.characteristics(id);
          return ch.types.includes('Artifact') || ch.supertypes.includes('Legendary') || ch.subtypes.includes('Saga');
        }).length;
        if (n >= 3) pl.flags['enduringStory'] = true;
        return n >= 3;
      }
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
      case 'hadCounter':
        return this.resolveObjects(c.ref, ectx).every((o) => {
          const had = (o.memory['__countersOnLeave'] as Record<string, number> | undefined) ?? {};
          return cmp(had[c.counter] ?? 0, c.op ?? '>=', c.value ?? 1);
        });
      case 'statGreater': {
        const [a] = this.resolveObjects(c.a, ectx);
        const [b] = this.resolveObjects(c.b, ectx);
        if (!a || !b) return false;
        const ca = this.characteristics(a.id);
        const cb = this.characteristics(b.id);
        const p = (ca.power ?? 0) > (cb.power ?? 0);
        const t = (ca.toughness ?? 0) > (cb.toughness ?? 0);
        return c.stat === 'power' ? p : c.stat === 'toughness' ? t : p || t;
      }
      case 'isTapped':
        return this.resolveObjects(c.ref, ectx).every((o) => o.tapped);
      case 'isAttacking':
        return this.resolveObjects(c.ref, ectx).every((o) => o.attacking !== null);
      case 'isMonarch': {
        const ps = this.resolvePlayers(c.ref, ectx);
        return ps.length > 0 && ps.every((p) => this.state.monarch === p); // "there is no monarch" = not(isMonarch of the monarch ref)
      }
      case 'castFrom': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return src?.castFromZone === c.zone;
      }
      case 'castNamedThisGame': {
        const name = c.name === '~' ? (ctx.sourceId !== null ? this.state.objects[ctx.sourceId]?.card.name : undefined) ?? c.name : c.name;
        return cmp(this.player(ctx.controller).castCountByName?.[name] ?? 0, c.op, c.value);
      }
      case 'wasKicked': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return !!src?.additionalCostsPaid.includes('kicker');
      }
      case 'altCostPaid': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        if (!src) return false;
        const alt = this.scriptFor(src).alternativeCosts?.find((a) => (a.cost.mana ?? '').replace(/\s/g, '') === c.mana.replace(/\s/g, ''));
        return !!alt && src.additionalCostsPaid.includes(alt.id);
      }
      case 'modeChosen':
        return (ctx.modes ?? []).includes(c.mode);
      case 'amount':
        return cmp(this.resolveAmount(c.a, ectx), c.op, this.resolveAmount(c.b, ectx));
      case 'wasKickedWith': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        const paid = (src?.memory['kickersPaid'] as string[] | undefined) ?? [];
        return paid.includes(c.cost);
      }
      case 'giftPromised': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        return typeof src?.memory['giftPromised'] === 'string';
      }
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
        if (c.filter && (c.event === 'cast' || c.event === 'dies')) {
          const list = c.event === 'cast' ? this.state.castThisTurn ?? [] : this.state.diedThisTurn ?? [];
          const f = c.filter;
          const n = list.filter((d) => {
            if (!who.includes(d.controller)) return false;
            if (f.types && !f.types.every((t) => d.types.includes(t))) return false;
            if (f.subtypes && !f.subtypes.every((t) => d.subtypes.includes(t))) return false;
            if (f.colors && !f.colors.some((col) => d.colors.includes(col))) return false;
            if (f.nameIs && d.name !== f.nameIs) return false;
            return true;
          }).length;
          return cmp(n, c.op ?? '>=', c.value ?? 1);
        }
        const total = who.reduce((n, p) => n + (this.state.turnStats[`${c.event}:${p}`] ?? 0), 0);
        return cmp(total, c.op ?? '>=', c.value ?? 1);
      }
      case 'chosenIs': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        const v = src?.chosen[c.key] ?? src?.memory[c.key];
        return typeof v === 'string' && v.toLowerCase() === c.value.toLowerCase();
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
      case 'sameNameGroup': {
        const groups = new Map<string, number>();
        for (const o of objectsMatching(this, this.bindFilter(c.filter, ectx), { sourceId: ctx.sourceId, controller: ctx.controller, x: ctx.x })) {
          const n = this.characteristics(o.id).name;
          groups.set(n, (groups.get(n) ?? 0) + 1);
        }
        return cmp(Math.max(0, ...groups.values()), c.op, c.value);
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
      case 'controlsMost': {
        const who = c.who ? this.resolvePlayers(c.who, ectx) : [ctx.controller];
        const countFor = (p: PlayerId) => objectsMatching(this, { ...c.filter, controller: 'you', zone: c.filter.zone ?? 'battlefield' }, { sourceId: ctx.sourceId, controller: p }).length;
        const best = Math.max(0, ...this.apnap().map(countFor));
        return best > 0 && who.length > 0 && who.every((p) => countFor(p) >= best);
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
      case 'count': {
        // "the number of artifacts your opponents control": an unzoned count is a battlefield count (rule 109.2).
        const f = a.filter.zone || a.filter.zoneIn ? a.filter : { ...a.filter, zone: 'battlefield' as const };
        return objectsMatching(this, this.bindFilter(f, ctx), fctx).length + (a.plus ?? 0);
      }
      case 'countersOn':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (a.counter === 'any' ? Object.values(o.counters).reduce((t, v) => t + (v ?? 0), 0) : (o.counters[a.counter] ?? 0)), 0);
      case 'power':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (this.characteristics(o.id).power ?? 0), 0);
      case 'toughness':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + (this.characteristics(o.id).toughness ?? 0), 0);
      case 'manaValue':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => s + this.characteristics(o.id).manaValue, 0);
      case 'manaSymbolCount': {
        const sym = a.color ? a.color.toUpperCase() : null;
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => {
          const cost = o.card.faces?.[o.faceIndex]?.manaCost ?? o.card.manaCost ?? '';
          const syms = cost.match(/\{[^}]+\}/g) ?? [];
          return s + syms.filter((t) => (sym ? t.toUpperCase().includes(sym) : /[WUBRG]/i.test(t))).length;
        }, 0);
      }
      case 'creatureTypeCount':
        return this.resolveObjects(a.ref, ctx).reduce((s, o) => {
          const ch = this.characteristics(o.id);
          return s + (ch.types.includes('Creature') ? new Set(ch.subtypes).size : 0);
        }, 0);
      case 'life':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).life, 0);
      case 'handSize':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).hand.length, 0);
      case 'playersBeingAttacked': {
        const defenders = new Set<PlayerId>();
        for (const id of this.state.turn.attackers) {
          const o = this.state.objects[id];
          if (!o || o.attacking === null) continue;
          const d = typeof o.attacking === 'number' ? this.state.objects[o.attacking]?.controller : o.attacking;
          if (d !== undefined) defenders.add(d);
        }
        return defenders.size;
      }
      case 'graveyardSize':
        return this.resolvePlayers(a.ref, ctx).reduce((s, p) => s + this.player(p).graveyard.filter((id) => !a.filter || matchesFilter(this, this.obj(id), { ...a.filter, zone: 'graveyard' }, fctx)).length, 0);
      case 'triggerAmount':
        return (ctx.triggerContext.triggerAmount as number) ?? 0;
      case 'devotion': {
        let cols: string[] = a.colors;
        if (a.chosenKey) {
          const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
          const ch = src?.chosen[a.chosenKey];
          cols = typeof ch === 'string' ? [ch] : Array.isArray(ch) ? (ch as string[]) : [];
        }
        let n = 0;
        for (const id of this.state.battlefield) {
          const o = this.obj(id);
          if (o.controller !== ctx.controller) continue;
          const cost = this.characteristics(id).manaCost;
          for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
            const sym = m[1];
            if (cols.some((c) => sym.includes(c))) n++;
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
      case 'distinctCounterKinds': {
        const o = this.resolveObjects(a.ref, ctx)[0];
        return o ? Object.values(o.counters).filter((v) => (v ?? 0) > 0).length : 0;
      }
      case 'minus':
        return Math.max(0, this.resolveAmount(a.a, ctx) - this.resolveAmount(a.b, ctx));
      case 'opponentsDamagedThisTurn':
        return this.opponentsOf(ctx.controller).filter((pid) => (this.player(pid).turnStats[a.combat ? 'combatDamageTaken' : 'damageTaken'] ?? 0) > 0).length;
      case 'playerStatAmount':
        return this.resolvePlayers(a.ref, ctx).reduce((s2, p) => s2 + (a.stat === 'poison' ? this.player(p).poison : a.stat === 'experience' ? this.player(p).experience : this.player(p).energy), 0);
      case 'divide': {
        const v = this.resolveAmount(a.a, ctx) / a.by;
        return a.round === 'up' ? Math.ceil(v) : Math.floor(v);
      }
      case 'manaPool': {
        const pid = a.who ? this.resolvePlayers(a.who, ctx)[0] : ctx.controller;
        return pid !== undefined ? (this.player(pid).manaPool[a.color] ?? 0) : 0;
      }
      case 'playersLost':
        return this.state.playerOrder.filter((p) => this.player(p).lost).length;
      case 'lowestLife':
        return Math.min(...this.state.playerOrder.map((pl) => this.player(pl).life));
      case 'highestLife':
        return Math.max(...this.state.playerOrder.map((pl) => this.player(pl).life));
      case 'totalPowerRef':
        return this.resolveObjects(a.ref, ctx).reduce((s2, o) => s2 + (this.characteristics(o.id).power ?? 0), 0);
      case 'totalToughnessRef':
        return this.resolveObjects(a.ref, ctx).reduce((s2, o) => s2 + (this.characteristics(o.id).toughness ?? 0), 0);
      case 'totalManaValueRef':
        return this.resolveObjects(a.ref, ctx).reduce((s2, o) => s2 + this.characteristics(o.id).manaValue, 0);
      case 'playersComparingCount': {
        const candsC = a.who === 'opponent' ? this.opponentsOf(ctx.controller) : this.state.playerOrder;
        const countFor = (p: PlayerId): number =>
          this.state.battlefield.filter((id) => this.obj(id).controller === p && matchesFilter(this, this.obj(id), { ...a.filter, zone: 'battlefield' }, { sourceId: ctx.sourceId, controller: p })).length;
        const mine = countFor(ctx.controller);
        return candsC.filter((p) => (a.cmp === 'fewer' ? countFor(p) < mine : countFor(p) > mine)).length;
      }
      case 'playersMatching': {
        const cands = a.who === 'opponent' ? this.opponentsOf(ctx.controller) : this.state.playerOrder;
        return cands.filter((p) => (this.state.players[p]?.turnStats[a.stat] ?? 0) > 0).length;
      }
      case 'graveyardsWithAtLeast':
        return this.state.playerOrder.filter((p) => this.player(p).graveyard.length >= a.count).length;
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
          if (a.stat === 'creatureType') {
            if (ch.types.includes('Creature')) for (const st of ch.subtypes) vals.add(st);
            continue;
          }
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
      case 'difference':
        return Math.abs(this.resolveAmount(a.a, ctx) - this.resolveAmount(a.b, ctx));
      case 'commanderColors':
        return this.resolvePlayers(a.ref, ctx).reduce((n, pid) => n + this.colorsOfCommander(pid).length, 0);
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
        if (a.filter && a.event === 'dies') {
          const f = a.filter;
          return (this.state.diedThisTurn ?? []).filter((d) => {
            if (!players.includes(d.controller)) return false;
            if (f.types && !f.types.every((t) => d.types.includes(t))) return false;
            if (f.subtypes && !f.subtypes.every((t) => d.subtypes.includes(t))) return false;
            if (f.nameIs && d.name !== f.nameIs) return false;
            return true;
          }).length;
        }
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
    // "with the same name as <that creature>": the reference needs this context, which the filter matcher lacks.
    if (filter.sameNameAs) {
      const names = this.resolveRef(filter.sameNameAs, ctx).map((t) => (t.kind === 'object' ? this.characteristics(t.id).name : t.kind === 'stackItem' ? this.state.stack.find((si) => si.id === t.id)?.text ?? '' : '')).filter(Boolean);
      const { sameNameAs: _sn, ...rest } = filter;
      void _sn;
      filter = { ...rest, nameIn: names.length ? names : ['__no such name__'] };
    }
    if (filter.ownerRef) {
      const owners = this.resolvePlayers(filter.ownerRef, ctx);
      const { ownerRef: _or, ...restO } = filter;
      void _or;
      filter = { ...restO, ownerIn: owners.length ? owners : ['__nobody__' as PlayerId] };
    }
    if (!filter.controllerRef) return filter;
    const ps = this.resolvePlayers(filter.controllerRef, ctx);
    const { controllerRef: _cr, ...rest } = filter;
    void _cr;
    // "creatures each player controls": any of the bound players, not just the first.
    if (ps.length > 1) return { ...rest, controllerIn: ps };
    return ps.length ? { ...rest, controller: ps[0] } : { ...rest, controller: '__nobody__' };
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
      case 'playersExcept': {
        const ex = new Set(this.resolvePlayers(ref.except, ctx));
        return plT(this.apnap().filter((p) => !ex.has(p)));
      }
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
      case 'lastDamaged':
        return objT((ctx.memory['lastDamaged'] as ObjectId[]) ?? []);
      case 'lastRevealed':
        return objT((ctx.memory['lastRevealed'] as ObjectId[]) ?? (ctx.memory['lastMoved'] as ObjectId[]) ?? []);
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
      case 'neighbor': {
        // Turn order runs to the left, so "the player to your left" is the next seat.
        const seats = this.activePlayers();
        const i = seats.indexOf(ctx.controller);
        if (i < 0 || seats.length < 2) return [];
        const j = ref.side === 'left' ? (i + 1) % seats.length : (i - 1 + seats.length) % seats.length;
        return plT([seats[j]]);
      }
      case 'playerWithMost': {
        const score = (p: PlayerId): number => {
          if (ref.what === 'life') return this.player(p).life;
          if (ref.what === 'cards') return this.player(p).hand.length;
          return objectsMatching(this, { ...ref.what.filter, zone: ref.what.filter.zone ?? 'battlefield', controller: undefined }, { sourceId: ctx.sourceId, controller: p }).filter((o) => o.controller === p).length;
        };
        const seats = this.activePlayers();
        if (!seats.length) return [];
        const vals = seats.map((p) => ({ p, v: score(p) }));
        const best = vals.reduce((a, b) => (ref.least ? (b.v < a.v ? b : a) : b.v > a.v ? b : a));
        const tied = vals.filter((x) => x.v === best.v);
        return tied.length === 1 ? plT([best.p]) : [];
      }
      case 'activePlayer':
        return plT([this.state.turn.activePlayer]);
      case 'monarch':
        return this.state.monarch ? plT([this.state.monarch]) : plT([]);
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
        if (t) return [t];
        // In a cast trigger "that spell" is the spell that triggered it, still on the stack.
        const tobj = ctx.triggerContext['triggerObject'];
        if (typeof tobj === 'number') {
          const item = this.state.stack.find((s) => s.kind === 'spell' && s.sourceId === tobj);
          if (item) return [{ kind: 'stackItem', id: item.id }];
        }
        return [];
      }
      case 'player':
        return plT([ref.id]);
      case 'controllerOf':
        return plT([...new Set(this.resolveRef(ref.of, ctx).map((t) => (t.kind === 'object' ? this.lastController(this.state.objects[t.id]) : t.kind === 'stackItem' ? this.state.stack.find((s) => s.id === t.id)?.controller ?? this.lastController(this.spellObjectOf(t.id)) : t.kind === 'player' ? t.id : undefined)))]);
      case 'ownerOf':
        return plT([...new Set(this.resolveRef(ref.of, ctx).map((t) => (t.kind === 'object' ? this.state.objects[t.id]?.owner : t.kind === 'player' ? t.id : undefined)))]);
      case 'blockersOf':
        return objT(this.resolveObjects(ref.of, ctx).flatMap((o) => o.blockedBy));
      case 'ringBearer':
        return objT(this.state.battlefield.filter((id) => this.obj(id).controller === ctx.controller && this.characteristics(id).rules.some((r) => r.kind === 'custom' && r.tag === 'ringBearer')));
      case 'giftRecipient': {
        const src = ctx.sourceId !== null ? this.state.objects[ctx.sourceId] : null;
        const to = src?.memory['giftPromised'];
        return typeof to === 'string' ? plT([to]) : [];
      }
    }
  }
  /** Spell cards of stack items that have left the stack, so "that spell's mana value" still resolves after a counter. */
  private stackItemSources = new Map<number, ObjectId>();
  rememberStackItem(item: StackItem) {
    if (item.kind === 'spell' && !item.copiedCard) this.stackItemSources.set(item.id, item.sourceId);
  }
  resolveObjects(ref: Ref, ctx: EffectContext): GameObject[] {
    return this.resolveRef(ref, ctx)
      .map((t) => (t.kind === 'object' ? this.state.objects[t.id] : t.kind === 'stackItem' ? this.spellObjectOf(t.id) : undefined))
      .filter((o): o is GameObject => !!o);
  }
  /**
   * "Its controller creates a token": for a permanent or spell that left the battlefield or stack this turn, the
   * controller it had there (rule 608.2h last known information), not the owner it reverts to in the graveyard.
   */
  /** Whether one of this object's mana abilities could add the given mana ("land that could produce {C}"). */
  couldProduceMana(o: GameObject, color: ManaColor): boolean {
    for (const ab of abilitiesOf(this, o)) {
      if (!ab.spec.manaAbility) continue;
      if (manaFromAbility(this, o, ab.spec).some((alt) => alt.includes(color) || (color !== 'C' && alt.includes('any' as ManaColor)))) return true;
    }
    return false;
  }
  lastController(o: GameObject | undefined): PlayerId | undefined {
    if (!o) return undefined;
    if (o.zone === 'battlefield' || o.zone === 'stack') return o.controller;
    const lki = o.lastKnownInfo as GameObject | undefined;
    if (lki && (lki.zone === 'battlefield' || lki.zone === 'stack') && o.lastZoneChange?.turn === this.state.turn.number) return lki.controller;
    return o.controller;
  }
  private spellObjectOf(stackId: number): GameObject | undefined {
    const item = this.state.stack.find((s) => s.id === stackId);
    const id = item ? (item.kind === 'spell' && !item.copiedCard ? item.sourceId : undefined) : this.stackItemSources.get(stackId);
    return id !== undefined ? this.state.objects[id] : undefined;
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
    // "Each opponent can't draw more than one card each turn."
    for (const r of this.playerRules(pid)) {
      if (r.kind !== 'custom' || r.tag !== 'maxDrawsPerTurn' || typeof r.data !== 'number') continue;
      const already = p.turnStats['drawCard'] ?? 0;
      const room = Math.max(0, r.data - already);
      if (n > room) {
        this.log(`${p.name} cannot draw more than ${r.data} card(s) this turn.`);
        n = room;
      }
    }
    if (n <= 0) return drawn;
    for (let i = 0; i < n; i++) {
      // Draw replacements ("If you would draw a card, draw two cards instead").
      const repl = this.drawReplacementFor(pid);
      if (repl) {
        if (repl.ab.skip) {
          this.state.turnStats[`drawReplaced:${pid}`] = (this.state.turnStats[`drawReplaced:${pid}`] ?? 0) + 1;
          continue;
        }
        if (repl.ab.effects?.length) {
          const owner = repl.sourceId >= 0 ? this.state.objects[repl.sourceId]?.controller ?? pid : pid;
          if (repl.ab.optional) {
            this.pendingTriggers.push({ sourceId: repl.sourceId, controller: owner, ability: { kind: 'triggered', text: repl.ab.text, event: 'drawCard', optional: true, effects: repl.ab.effects }, context: { playerId: pid } });
            this.state.turnStats[`drawReplaced:${pid}`] = (this.state.turnStats[`drawReplaced:${pid}`] ?? 0) + 1;
            continue;
          }
          this.state.turnStats[`drawReplaced:${pid}`] = (this.state.turnStats[`drawReplaced:${pid}`] ?? 0) + 1;
          this.pendingTriggers.push({ sourceId: repl.sourceId, controller: owner, ability: { kind: 'triggered', text: repl.ab.text, event: 'drawCard', effects: repl.ab.effects }, context: { playerId: pid } });
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
      o.memory['drawnTurn'] = this.state.turn.number; // "cards in your hand drawn this turn" (Sylvan Library)
      p.hand.push(id);
      drawn.push(id);
      if (this.state.turn.step === 'draw' && this.state.turn.activePlayer === pid) p.turnStats['drawStepDraws'] = (p.turnStats['drawStepDraws'] ?? 0) + 1;
      this.touch();
      this.emit({ name: 'drawCard', objectId: id, playerId: pid, fromZone: 'library', toZone: 'hand' });
    }
    if (drawn.length) this.log(`${p.name} draws ${drawn.length} card${drawn.length === 1 ? '' : 's'}.`, { kind: 'draw', data: { player: pid, count: drawn.length } });
    return drawn;
  }

  /** The draw replacement that applies to this player's next draw, if any. */
  private drawReplacementFor(pid: PlayerId): { ab: Extract<import('./script.js').ReplacementSpec, { event: 'drawCard' }>; sourceId: ObjectId } | null {
    if (this.state.turnStats[`drawReplacing:${pid}`]) return null; // don't re-replace the replacement draws
    // "The next time you would draw a card this turn, you gain 5 life instead." (a one-shot turn rule)
    for (const t of this.state.turnRules ?? []) {
      if (t.player !== pid) continue;
      const r = t.rule;
      if (r.kind !== 'custom' || r.tag !== 'drawReplacement') continue;
      const d = r.data as { effects?: import('./script.js').Effect[]; once?: boolean; used?: boolean } | undefined;
      if (!d?.effects?.length || d.used) continue;
      if (d.once) d.used = true;
      return { ab: { kind: 'replacement', text: 'Draw replacement', event: 'drawCard', who: 'you', effects: d.effects }, sourceId: -1 };
    }
    for (const ab of this.turnReplacementsFor(pid, 'drawCard')) return { ab, sourceId: -1 };
    for (const id of [...this.state.battlefield, ...this.player(pid).graveyard]) {
      const src = this.state.objects[id];
      if (!src) continue;
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind !== 'replacement' || ab.event !== 'drawCard') continue;
        if ((ab.zone ?? 'battlefield') !== src.zone) continue;
        const applies = ab.who === 'any' || (ab.who === 'you' && src.controller === pid) || (ab.who === 'opponent' && src.controller !== pid);
        if (!applies) continue;
        if (ab.condition && !this.checkCondition(ab.condition, { sourceId: id, controller: pid })) continue;
        if (ab.exceptFirstEachDrawStep && this.state.turn.step === 'draw' && this.state.turn.activePlayer === pid && !(this.player(pid).turnStats['drawStepDraws'] ?? 0)) continue;
        return { ab, sourceId: id };
      }
    }
    return null;
  }

  /** Teferi's Protection: "your life total can't change". */
  lifeLocked(pid: PlayerId): boolean {
    return this.playerRules(pid).some((r) => r.kind === 'custom' && r.tag === 'lifeCantChange');
  }
  /** Teferi's Protection: the player has protection from everything (can't be targeted, all damage to them prevented). */
  playerProtected(pid: PlayerId): boolean {
    return this.playerRules(pid).some((r) => r.kind === 'custom' && r.tag === 'protectionFromEverything');
  }
  gainLife(pid: PlayerId, n: number, sourceId?: ObjectId) {
    if (n <= 0) return;
    const p = this.player(pid);
    if (this.lifeLocked(pid)) return;
    if (this.playerRules(pid).some((r) => r.kind === 'cantGainLife')) return;
    // "If you would gain life, draw that many cards instead." / "… lose that much life instead."
    for (const r of this.playerRules(pid)) {
      if (r.kind !== 'custom') continue;
      if (r.tag === 'lifeGainToDraw') {
        this.drawCards(pid, n);
        return;
      }
      if (r.tag === 'lifeGainToLoss') {
        this.loseLife(pid, n, sourceId);
        return;
      }
    }
    // Lifegain replacement (e.g. doubling) from scripts
    let amount = n;
    for (const src of this.state.battlefield.map((id) => this.obj(id))) {
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind === 'replacement' && ab.event === 'lifeGain') {
          const applies = ab.who === 'any' || (ab.who === 'you' && src.controller === pid) || (ab.who === 'opponent' && src.controller !== pid);
          if (!applies) continue;
          if (ab.insteadLose) {
            this.loseLife(pid, amount, sourceId);
            return;
          }
          if (ab.multiply !== undefined) amount *= ab.multiply;
          if (ab.add) amount += ab.add;
        }
      }
    }
    if (amount <= 0) return;
    for (const ab of this.turnReplacementsFor(pid, 'lifeGain')) {
      if (ab.insteadLose) {
        this.loseLife(pid, amount, sourceId);
        return;
      }
      if (ab.multiply !== undefined) amount *= ab.multiply;
      if (ab.add) amount += ab.add;
    }
    if (amount <= 0) return;
    p.life += amount;
    this.touch();
    this.log(`${p.name} gains ${amount} life (${p.life}).`, { kind: 'life', data: { player: pid, delta: amount, life: p.life } });
    this.state.turnStats[`lifeGainedAmount:${pid}`] = (this.state.turnStats[`lifeGainedAmount:${pid}`] ?? 0) + amount;
    this.player(pid).turnStats['lifeGainedAmount'] = (this.player(pid).turnStats['lifeGainedAmount'] ?? 0) + amount;
    this.emit({ name: 'lifeGained', playerId: pid, amount, sourceId });
  }

  loseLife(pid: PlayerId, n: number, sourceId?: ObjectId, opts: { fromDamage?: boolean } = {}) {
    if (this.lifeLocked(pid)) return;
    if (n <= 0) return;
    const p = this.player(pid);
    // "Damage that would reduce your life total to less than 1 reduces it to 1 instead." (damage only)
    let floor: number | null = null;
    if (opts.fromDamage) for (const r of this.playerRules(pid)) if (r.kind === 'custom' && r.tag === 'lifeFloor' && typeof r.data === 'number') floor = Math.max(floor ?? 0, r.data);
    // "If an opponent would lose life during your turn, they lose twice that much life instead."
    for (const src of this.state.battlefield.map((id) => this.obj(id))) {
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind !== 'replacement' || ab.event !== 'lifeLoss') continue;
        const applies = ab.who === 'any' || (ab.who === 'you' && src.controller === pid) || (ab.who === 'opponent' && src.controller !== pid);
        if (!applies) continue;
        if (ab.yourTurnOnly && this.state.turn.activePlayer !== src.controller) continue;
        if (ab.multiply !== undefined) n *= ab.multiply;
        if (ab.add) n += ab.add;
      }
    }
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
    // "If damage would be dealt to you, prevent that damage and mill twice that many cards."
    if (target.kind === 'player') {
      for (const id of this.state.battlefield) {
        const holder = this.state.objects[id];
        if (!holder || holder.controller !== target.id) continue;
        for (const ab of this.scriptFor(holder).abilities) {
          if (ab.kind !== 'replacement' || ab.event !== 'damage' || ab.to !== 'controller' || ab.prevent !== 'all') continue;
          if (ab.combatOnly && !combat) continue;
          if (ab.condition && !this.checkCondition(ab.condition, { sourceId: holder.id, controller: holder.controller })) continue;
          if (ab.fromFilter && (!src || !matchesFilter(this, src, { ...ab.fromFilter, zone: undefined }, { sourceId: holder.id, controller: holder.controller }))) continue;
          const eff = (ab as { effects?: import('./script.js').Effect[] }).effects;
          if (eff?.length) this.pendingTriggers.push({ sourceId: holder.id, controller: holder.controller, ability: { kind: 'triggered', text: ab.text, event: 'dealtDamage', effects: eff }, context: { triggerAmount: amount, amount, playerId: target.id, sourceId } });
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
    // CR 616.1: every applicable prevention effect gets to apply; shields are consumed in order until the damage is gone.
    let total = 0;
    for (const pv of [...this.state.preventions]) {
      if (amount - total <= 0) break;
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
      const stopped = pv.amount === undefined ? Infinity : Math.min(pv.amount, amount - total);
      if (pv.amount !== undefined) {
        pv.amount -= stopped;
        if (pv.amount <= 0) this.state.preventions = this.state.preventions.filter((x) => x !== pv);
      } else if (pv.once) this.state.preventions = this.state.preventions.filter((x) => x !== pv);
      if (pv.redirectIds?.length || pv.redirectPlayers?.length || pv.redirectToSourceController) {
        const moved = stopped === Infinity ? amount : stopped;
        const dests: Target[] = [
          ...(pv.redirectIds ?? []).filter((x) => this.state.objects[x]?.zone === 'battlefield').map((x) => ({ kind: 'object', id: x }) as Target),
          ...(pv.redirectPlayers ?? []).map((x) => ({ kind: 'player', id: x }) as Target),
        ];
        if (pv.redirectToSourceController && sourceId !== null) {
          const so = this.state.objects[sourceId];
          if (so) dests.push({ kind: 'player', id: so.controller });
        }
        for (const d of dests) this.dealDamage(sourceId, d, moved, combat);
      }
      if (pv.effects?.length) {
        // "…prevent that damage. You gain life equal to the damage prevented this way."
        const prevented = stopped === Infinity ? amount : stopped;
        this.pendingTriggers.push({ sourceId: pv.sourceId ?? -1, controller: pv.controller, ability: { kind: 'triggered', text: 'Prevention follow-up', event: 'dealtDamage', effects: pv.effects }, context: { triggerAmount: prevented, amount: prevented, sourceId: pv.sourceId ?? undefined } });
      }
      if (stopped === Infinity) return Infinity;
      total += stopped;
    }
    return total;
  }

  /** Apply one "would deal damage" modification rule to a damage amount. */
  private applyDamageModify(raw: unknown, dealt: number, sourceId: ObjectId | null, src: GameObject | null, target: Target, combat: boolean, holderController: PlayerId, holderId: ObjectId | null): number {
    const d = raw as {
      filter?: import('./types.js').ObjectFilter;
      selfOnly?: boolean;
      toFilter?: import('./types.js').ObjectFilter;
      toPlayers?: boolean;
      toObjects?: boolean;
      toController?: 'you' | 'opponent';
      combatOnly?: boolean;
      noncombatOnly?: boolean;
      ifAtLeast?: number;
      setTo?: number;
      times?: number;
      plus?: number;
      minus?: number;
      half?: 'up' | 'down';
    } | undefined;
    if (!d) return dealt;
    if (d.combatOnly && !combat) return dealt;
    if (d.noncombatOnly && combat) return dealt;
    if (d.ifAtLeast !== undefined && dealt < d.ifAtLeast) return dealt;
    if (d.selfOnly) {
      if (holderId === null || sourceId !== holderId) return dealt;
    } else if (d.filter && (!src || !matchesFilter(this, src, { ...d.filter, zone: undefined }, { sourceId: holderId, controller: holderController }))) return dealt;
    if (d.toPlayers && target.kind !== 'player') return dealt;
    if (d.toObjects && target.kind !== 'object') return dealt;
    const tc = target.kind === 'player' ? target.id : target.kind === 'object' ? this.state.objects[target.id]?.controller : undefined;
    if (d.toController === 'you' && tc !== holderController) return dealt;
    if (d.toController === 'opponent' && (tc === undefined || tc === holderController)) return dealt;
    if (d.toFilter) {
      if (target.kind !== 'object') return dealt;
      const o = this.state.objects[target.id];
      if (!o || !matchesFilter(this, o, { ...d.toFilter, zone: undefined }, { sourceId: holderId, controller: holderController })) return dealt;
    }
    if (d.setTo !== undefined) dealt = d.setTo;
    if (d.times !== undefined) dealt *= d.times;
    if (d.plus !== undefined) dealt += d.plus;
    if (d.minus !== undefined) dealt -= d.minus;
    if (d.half) dealt = d.half === 'up' ? Math.ceil(dealt / 2) : Math.floor(dealt / 2);
    return dealt < 0 ? 0 : dealt;
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
    // "Prevent all damage that ~ would deal to red creatures."
    if (sourceId !== null) {
      const sobj = this.state.objects[sourceId];
      if (sobj) {
        for (const r of this.characteristics(sourceId).rules) {
          if (r.kind !== 'custom' || r.tag !== 'dealsNoDamageTo') continue;
          const d = r.data as { to?: import('./types.js').ObjectFilter; toPlayers?: boolean; toObjects?: boolean; toController?: 'you' | 'opponent'; combatOnly?: boolean; noncombatOnly?: boolean } | undefined;
          if (!d) continue;
          if (d.combatOnly && !combat) continue;
          if (d.noncombatOnly && combat) continue;
          if (d.toPlayers && target.kind !== 'player') continue;
          if (d.toObjects && target.kind !== 'object') continue;
          const tc = target.kind === 'player' ? target.id : target.kind === 'object' ? this.state.objects[target.id]?.controller : undefined;
          if (d.toController === 'you' && tc !== sobj.controller) continue;
          if (d.toController === 'opponent' && (tc === undefined || tc === sobj.controller)) continue;
          if (d.to) {
            if (target.kind !== 'object') continue;
            const o = this.state.objects[target.id];
            if (!o || !matchesFilter(this, o, { ...d.to, zone: undefined }, { sourceId, controller: sobj.controller })) continue;
          }
          this.log(`Damage from ${this.nameOf(sourceId)} is prevented.`);
          return 0;
        }
      }
    }
    // Teferi's Protection: a player with protection from everything takes no damage.
    if (target.kind === 'player' && this.playerProtected(target.id)) {
      this.log(`Damage to ${this.player(target.id).name} is prevented (protection from everything).`);
      return 0;
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
    // "If a source you control would deal damage this turn, it deals double that damage instead." (granted to a player)
    for (const pl of this.activePlayers()) {
      for (const r of this.playerRules(pl)) {
        if (r.kind !== 'custom' || r.tag !== 'damageModify') continue;
        const hc = (r as { sourceController?: PlayerId }).sourceController ?? pl;
        dealt = this.applyDamageModify(r.data, dealt, sourceId, src, target, combat, hc, null);
      }
    }
    // "If a source you control would deal damage to an opponent, it deals double that damage instead."
    for (const id of this.state.battlefield) {
      const holder = this.state.objects[id];
      if (!holder) continue;
      for (const r of this.characteristics(id).rules) {
        if (r.kind !== 'custom' || r.tag !== 'damageModify') continue;
        dealt = this.applyDamageModify(r.data, dealt, sourceId, src, target, combat, holder.controller, id);
      }
    }
    if (dealt <= 0) return 0;
    if (target.kind === 'player') {
      const p = this.player(target.id);
      // Prevention rules on player
      if (!this.state.turnStats['noPrevention'] && !this.preventionOff()) for (const r of this.playerRules(target.id)) if (r.kind === 'damagePrevention') dealt = r.amount === 'all' ? 0 : Math.max(0, dealt - r.amount);
      if (dealt <= 0) return 0;
      if (sch?.keywords.has('Infect')) {
        p.poison += dealt;
        this.log(`${this.nameOf(sourceId!)} deals ${dealt} damage to ${p.name} as poison counters (${p.poison}).`);
      } else {
        // "Damage doesn't cause you to lose life": the damage is still dealt, but no life is lost.
        const noLifeLoss = this.playerRules(target.id).some((r) => r.kind === 'custom' && r.tag === 'damageNoLifeLoss');
        this.log(`${src ? this.nameOf(src.id) : 'Something'} deals ${dealt} damage to ${p.name}.`, { kind: 'damage', data: { player: target.id, amount: dealt, sourceId } });
        // CR 120.3a: damage dealt to a player causes that player to lose that much life.
        if (!noLifeLoss) this.loseLife(target.id, dealt, sourceId ?? undefined, { fromDamage: true });
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
      if (combat) p.turnStats['combatDamageTaken'] = (p.turnStats['combatDamageTaken'] ?? 0) + dealt;
      if (sourceId !== null && sourceId !== undefined) this.state.turnStats[`damagedPlayer:${sourceId}:${target.id}`] = (this.state.turnStats[`damagedPlayer:${sourceId}:${target.id}`] ?? 0) + dealt;
      if (sourceId !== null && sourceId !== undefined) this.state.turnStats[`damageDealtBy:${sourceId}`] = (this.state.turnStats[`damageDealtBy:${sourceId}`] ?? 0) + dealt;
      if (combat && sourceId !== null && sourceId !== undefined) this.state.turnStats[`combatDamagedPlayer:${sourceId}:${target.id}`] = (this.state.turnStats[`combatDamagedPlayer:${sourceId}:${target.id}`] ?? 0) + dealt;
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
      if (!this.preventionOff()) for (const r of ch.rules) if (r.kind === 'damagePrevention') dealt = r.amount === 'all' ? 0 : Math.max(0, dealt - r.amount);
      if (dealt <= 0) return 0;
      // "If damage would be dealt to ~, put that many +1/+1 counters on it instead."
      {
        const conv = ch.rules.find((r) => r.kind === 'custom' && r.tag === 'damageToCounters');
        if (conv) {
          const counter = (conv as { data?: { counter?: string } }).data?.counter ?? '+1/+1';
          this.addCounters(obj.id, counter, dealt);
          this.log(`${this.nameOf(obj.id)} gets ${dealt} ${counter} counter(s) instead of damage.`);
          return dealt;
        }
      }
      if (ch.types.includes('Planeswalker')) {
        obj.counters['loyalty'] = Math.max(0, (obj.counters['loyalty'] ?? 0) - dealt);
      } else if (ch.types.includes('Battle')) {
        obj.counters['defense'] = Math.max(0, (obj.counters['defense'] ?? 0) - dealt);
      } else if (sch?.keywords.has('Infect') || sch?.keywords.has('Wither')) {
        obj.counters['-1/-1'] = (obj.counters['-1/-1'] ?? 0) + dealt;
        if (sch?.keywords.has('Deathtouch')) obj.deathtouchDamage = true; // CR 702.2b: any damage from a deathtouch source is lethal
      } else {
        obj.damage += dealt;
        if (sch?.keywords.has('Deathtouch')) obj.deathtouchDamage = true;
      }
      if (src) (this.state.damagedBy[obj.id] ??= []).push(src.id);
      this.touch();
      if (sourceId !== null && sourceId !== undefined) this.state.turnStats[`damageDealtBy:${sourceId}`] = (this.state.turnStats[`damageDealtBy:${sourceId}`] ?? 0) + dealt;
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
  /** Counters a player would get (poison, experience, energy) after Vorinclex / Winding Constrictor style replacements. */
  playerCounterAmount(pid: PlayerId, type: string, n: number): number {
    let amount = n;
    for (const src of this.state.battlefield.map((x) => this.obj(x))) {
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind !== 'replacement' || ab.event !== 'counterAdded') continue;
        if (!(ab.forPlayers || (!ab.filter && !ab.counterType))) continue; // "a permanent or player"
        const who = ab.who ?? 'you';
        if (who === 'you' && src.controller !== pid) continue;
        if (who === 'opponent' && src.controller === pid) continue;
        if (ab.counterType && ab.counterType !== type) continue;
        if (ab.multiply) amount *= ab.multiply;
        if (ab.half) amount = ab.half === 'up' ? Math.ceil(amount / 2) : Math.floor(amount / 2);
        amount += ab.extra;
        if (ab.minus) amount -= ab.minus;
        if (amount < 0) amount = 0;
      }
    }
    return amount;
  }
  /**
   * How many counters actually land on `o` when `n` counters of `type` would be put on it (Doubling Season, Hardened
   * Scales, Vorinclex …). Also used for counters a permanent enters the battlefield with (rule 614.1c).
   */
  counterAmountFor(o: GameObject, type: string, n: number, controller: PlayerId = o.controller): number {
    let amount = n;
    for (const r of this.playerRules(controller)) {
      if (r.kind !== 'custom' || r.tag !== 'counterMultiplier' || typeof r.data !== 'number') continue;
      amount = r.data >= 1 ? amount * r.data : Math.floor(amount * r.data);
    }
    for (const src of this.state.battlefield.map((x) => this.obj(x))) {
      for (const ab of this.scriptFor(src).abilities) {
        if (ab.kind === 'replacement' && ab.event === 'counterAdded') {
          if (ab.forPlayers) continue; // "If you would get one or more counters": players only
          const who = ab.who ?? 'you';
          if (who === 'you' && src.controller !== controller) continue;
          if (who === 'opponent' && src.controller === controller) continue;
          if (ab.counterType && ab.counterType !== type) continue;
          if (ab.filter && !matchesFilter(this, o, { ...ab.filter, zone: o.zone === 'battlefield' ? ab.filter.zone : undefined }, { sourceId: src.id, controller: src.controller })) continue;
          if (ab.multiply) amount *= ab.multiply;
          if (ab.half) amount = ab.half === 'up' ? Math.ceil(amount / 2) : Math.floor(amount / 2);
          amount += ab.extra;
          if (ab.minus) amount -= ab.minus;
          if (amount < 0) amount = 0;
        }
      }
    }
    for (const ab of this.turnReplacementsFor(controller, 'counterAdded')) {
      if (ab.counterType && ab.counterType !== type) continue;
      if (ab.filter && !matchesFilter(this, o, { ...ab.filter, zone: o.zone === 'battlefield' ? ab.filter.zone : undefined }, { sourceId: null, controller })) continue;
      if (ab.multiply) amount *= ab.multiply;
      if (ab.half) amount = ab.half === 'up' ? Math.ceil(amount / 2) : Math.floor(amount / 2);
      amount += ab.extra;
      if (ab.minus) amount -= ab.minus;
      if (amount < 0) amount = 0;
    }
    return amount;
  }
  /** Counters a permanent enters with, after replacement effects (Hardened Scales makes Walking Ballista X+1). */
  enteringCounters(o: GameObject, counters: Record<string, number>, controller: PlayerId): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [type, n] of Object.entries(counters)) {
      const amount = n > 0 ? this.counterAmountFor(o, type, n, controller) : n;
      if (amount > 0) out[type] = amount;
    }
    return out;
  }
  addCounters(id: ObjectId, type: string, n: number, sourceId?: ObjectId) {
    const o = this.state.objects[id];
    if (!o || n <= 0) return;
    // "~ can't have counters put on it."
    for (const r of this.characteristics(id).rules) {
      if (r.kind !== 'custom' || r.tag !== 'noCounters') continue;
      const d = (r.data as { counter?: string } | undefined) ?? {};
      if (!d.counter || d.counter === type) return;
    }
    const amount = this.counterAmountFor(o, type, n);
    if (amount <= 0) return;
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
    // "If you would lose the game, instead exile ~ and your life total becomes 1."
    for (const id of this.state.battlefield) {
      const holder = this.state.objects[id];
      if (!holder || holder.controller !== pid || holder.memory['lossReplaced']) continue;
      const ab = this.scriptFor(holder).abilities.find((a) => a.kind === 'replacement' && a.event === 'wouldLoseGame');
      if (!ab || ab.kind !== 'replacement' || ab.event !== 'wouldLoseGame') continue;
      holder.memory['lossReplaced'] = true;
      this.log(`${p.name} would lose the game, but ${this.nameOf(id)} replaces it.`);
      if (p.life <= 0) p.life = 1;
      if (p.poison >= 10) p.poison = 0;
      this.queueTrigger({ sourceId: id, controller: pid, ability: { kind: 'triggered', text: ab.text, event: 'playerLost', effects: ab.instead }, context: { playerId: pid } });
      this.touch();
      return;
    }
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
      let next = this.state.turn.extraTurns.shift();
      // "If a player would begin an extra turn, that player skips that turn instead."
      while (next !== undefined && this.playerRules(next).some((r) => r.kind === 'custom' && r.tag === 'noExtraTurns')) {
        this.log(`${this.player(next).name} skips their extra turn.`);
        next = this.state.turn.extraTurns.shift();
      }
      next ??= first ? this.state.playerOrder[0] : this.nextPlayerAfter(this.state.turn.activePlayer);
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
    this.state.turnReplacements = [];
    this.state.diedThisTurn = [];
    this.state.castThisTurn = [];
    for (const p of Object.values(this.state.players)) p.turnStats = {};
  }

  private *takeTurn(pid: PlayerId): Gen {
    const t = this.state.turn;
    t.number++;
    t.activePlayer = pid;
    t.skipSteps = [];
    t.attackers = [];
    this.player(pid).lastTurnStarted = t.number;
    this.player(pid).turnsStarted = (this.player(pid).turnsStarted ?? 0) + 1;
    // Rules granted "this turn" end; "until your next turn" rules end only when that player's turn begins.
    this.state.turnRules = (this.state.turnRules ?? []).filter((r) => r.untilNextTurnOf !== undefined && r.untilNextTurnOf !== pid);
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
      if (this.player(pid).flags[`skipStep:${step}`]) {
        delete this.player(pid).flags[`skipStep:${step}`];
        continue;
      }
      // "Players skip their upkeep steps."
      if (this.playerRules(pid).some((r) => r.kind === 'custom' && r.tag === 'skipStep' && r.data === step)) continue;
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
        this.state.turn.dealtFirstStrike = [];
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
        // "if it's the first combat phase of the turn" (Karlach, Fury of Avernus)
        this.player(pid).turnStats['combatPhases'] = (this.player(pid).turnStats['combatPhases'] ?? 0) + 1;
        yield* runCombatStep(this, step);
        return;
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
    this.state.preventions = this.state.preventions.filter((pv) => pv.permanent);
    for (;;) {
      // Discard to hand size
      const rules = this.playerRules(pid);
      const noMax = rules.some((r) => r.kind === 'noMaxHandSize');
      let maxHand = 7;
      for (const r of rules) if (r.kind === 'maxHandSize') maxHand = r.amount !== undefined ? this.resolveAmount(r.amount, { sourceId: null, controller: pid, targets: [], triggerContext: {}, memory: {}, x: 0, modes: [] }) : r.value !== undefined ? r.value : maxHand + (r.delta ?? 0);
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
        if (o.zone === 'battlefield' && this.characteristics(o.id).rules.some((r) => r.kind === 'custom' && r.tag === 'damagePersists')) continue;
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
